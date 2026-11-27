// 테스트용 쓰기 스크립트다. concurrency.test.ts가 별도 프로세스로 띄운다. 모듈의 공개 계약이 아니다.
// 부모와는 표준 입출력의 줄로 신호를 주고받는다. 트랜잭션 안에서도 신호를 주고받아야 해서 입출력은 모두 동기다.
//
//   holder <이름> <횟수>
//     AI_BUTLER_HOME의 원장을 연 뒤 "ready"를 찍고 "go"를 기다린다. 받으면 요청을 <횟수>번 등록한다.
//     첫 쓰기에서 쓰기 잠금을 잡으면 "holding"을 찍고 "release"를 받을 때까지 잠금을 쥔 채 기다린다.
//     첫 요청을 커밋하면 "first committed"를 찍고, "continue"를 받을 때까지 두 번째 요청을 쓰지 않는다.
//     다 쓰면 결과를 JSON 한 줄로 찍는다.
//   contender <이름> <횟수>
//     원장을 연 뒤 "ready"를 찍고 "go"를 기다린다. 받으면 대기 시간 0으로 쓰기 잠금을 시도해 보고
//     "probe busy"나 "probe acquired"를 찍는다. 이 시도는 아무것도 쓰지 않는다. 이어서 요청을 <횟수>번
//     등록한다. 첫 요청을 커밋하면 "first committed"를 찍고 멈추지 않고 이어 쓴다. 다 쓰면 결과를 찍는다.
//   race <이름> <횟수>
//     "ready"를 찍고 "go"를 기다린다. 받은 뒤에 원장을 열어 <횟수>번 등록하고 결과를 찍는다.
//     원장 파일이 없을 때 여러 프로세스가 동시에 처음 여는 경우를 만든다.
//   hold <파일> <밀리초>
//     요청과 변경 이력을 쓰고 커밋하지 않은 채 "locked"를 찍는다. <밀리초> 동안 쥐고 있다가 커밋한다.
//   reserve <파일> <밀리초>
//     WAL로 바꾸지 않고 파일을 열어 쓰기를 예약하고 "locked"를 찍는다. <밀리초> 뒤에 예약을 푼다.
import { readSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { write } from "./changes.ts";
import { openDb, resolveLedgerPath } from "./db.ts";
import { type Ledger, openLedger } from "./index.ts";
import { HELD_REQUEST_ID } from "./test-support.ts";

export type WriteResult = {
  readonly written: number;
  /** 실패한 쓰기의 오류 메시지. 잠금 오류도 여기에 담긴다. */
  readonly failures: readonly string[];
};

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 표준 입출력이 논블로킹으로 열려 있어도 동기로 읽고 쓰게, 준비되지 않았으면 잠깐 쉬고 다시 한다. */
function retryWhenNotReady<T>(io: () => T): T {
  for (;;) {
    try {
      return io();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") {
        throw error;
      }
      sleepSync(1);
    }
  }
}

function say(line: string): void {
  retryWhenNotReady(() => writeSync(1, `${line}\n`));
}

function waitFor(expected: string): void {
  const byte = Buffer.alloc(1);
  let line = "";
  for (;;) {
    if (retryWhenNotReady(() => readSync(0, byte, 0, 1, null)) === 0) {
      throw new Error(`"${expected}"을 받기 전에 표준 입력이 닫혔다`);
    }
    if (byte[0] !== 0x0a) {
      line += byte.toString("latin1");
    } else if (line === expected) {
      return;
    } else {
      line = "";
    }
  }
}

/** 요청을 count번 등록한다. 첫 요청이 커밋되면 두 번째를 쓰기 전에 afterFirstCommitted를 부른다. */
function writeRequests(
  ledger: Ledger,
  name: string,
  count: number,
  afterFirstCommitted: () => void = () => {},
): WriteResult {
  const failures: string[] = [];
  let written = 0;
  for (let index = 1; index <= count; index += 1) {
    try {
      ledger.createRequest({ kind: "assistant", module: name }, { title: `${name}-${index}` });
      written += 1;
    } catch (error) {
      failures.push(String(error));
      continue;
    }
    if (index === 1) {
      afterFirstCommitted();
    }
  }
  return { written, failures };
}

/**
 * 대기 시간 0으로 원장 파일의 쓰기 잠금을 시도해 본다. 다른 프로세스가 쥐고 있으면 SQLite가 기다리지 않고
 * 바로 SQLITE_BUSY를 돌려준다. 잠금을 얻어도 아무것도 쓰지 않고 놓으므로 요청과 변경 이력은 늘지 않는다.
 */
function probeWriteLock(): "busy" | "acquired" {
  const probe = new DatabaseSync(resolveLedgerPath(), { timeout: 0 });
  try {
    probe.exec("BEGIN IMMEDIATE");
    probe.exec("ROLLBACK");
    return "acquired";
  } catch (error) {
    const errcode = (error as { errcode?: unknown }).errcode;
    if (typeof errcode === "number" && (errcode & 0xff) === 5) {
      return "busy";
    }
    throw error;
  } finally {
    probe.close();
  }
}

/**
 * 먼저 쓰기 잠금을 쥐는 쪽. 첫 쓰기에서 잠금을 쥔 채로 멈춰 있다가 "release"를 받으면 커밋한다.
 * 첫 요청을 커밋한 뒤에는 "continue"를 받을 때까지 두 번째 요청을 쓰지 않아, 상대의 첫 요청이
 * 이쪽의 두 번째 요청보다 먼저 커밋되게 한다.
 */
function runHolder(name: string, count: number): void {
  let first = true;
  const ledger = openLedger({
    // 원장은 쓰기 잠금을 잡은 뒤에 시계를 읽는다. 첫 쓰기에서 그 순간을 빌려 잠금을 쥔 채로 멈춘다.
    clock: () => {
      if (first) {
        first = false;
        say("holding");
        waitFor("release");
      }
      return new Date();
    },
  });
  say("ready");
  waitFor("go");
  const result = writeRequests(ledger, name, count, () => {
    say("first committed");
    waitFor("continue");
  });
  ledger.close();
  say(JSON.stringify(result));
}

/**
 * 잠금을 쥔 쪽과 겨루는 쪽. 쓰기 전에 잠금이 실제로 잡혀 있는지를 대기 시간 0으로 확인해 알리고,
 * 원장의 정상 쓰기를 시작한다. 첫 요청을 커밋하면 알리고, 멈추지 않고 나머지를 쓴다.
 */
function runContender(name: string, count: number): void {
  const ledger = openLedger();
  say("ready");
  waitFor("go");
  say(`probe ${probeWriteLock()}`);
  const result = writeRequests(ledger, name, count, () => say("first committed"));
  ledger.close();
  say(JSON.stringify(result));
}

function runRace(name: string, count: number): void {
  say("ready");
  waitFor("go");
  const ledger = openLedger();
  const result = writeRequests(ledger, name, count);
  ledger.close();
  say(JSON.stringify(result));
}

function runHold(path: string, holdMs: number): void {
  const db = openDb(path);
  write(
    db,
    { kind: "assistant", module: "holder" },
    () => new Date(),
    (scope) => {
      const title = "잠금을 쥔 프로세스의 요청";
      scope.run(
        "INSERT INTO requests (id, title, created_at) VALUES (?, ?, ?)",
        HELD_REQUEST_ID,
        title,
        scope.at,
      );
      scope.record({
        target: { kind: "request", id: HELD_REQUEST_ID },
        before: null,
        after: { title },
      });
      // 값과 변경 이력을 쓴 뒤, 커밋하기 전이다.
      say("locked");
      sleepSync(holdMs);
    },
  );
  db.close();
}

function runReserve(path: string, holdMs: number): void {
  const db = new DatabaseSync(path);
  db.exec("BEGIN IMMEDIATE");
  say("locked");
  sleepSync(holdMs);
  db.exec("ROLLBACK");
  db.close();
}

const [mode, first = "", second = ""] = process.argv.slice(2);
if (mode === "holder") {
  runHolder(first, Number(second));
} else if (mode === "contender") {
  runContender(first, Number(second));
} else if (mode === "race") {
  runRace(first, Number(second));
} else if (mode === "hold") {
  runHold(first, Number(second));
} else if (mode === "reserve") {
  runReserve(first, Number(second));
} else {
  throw new Error(`알 수 없는 모드: ${String(mode)}`);
}
