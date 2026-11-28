// 테스트에서만 쓰는 도우미다. 모듈의 공개 계약이 아니다.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { LedgerError, type LedgerErrorCode } from "./errors.ts";
import { type Ledger, openLedger } from "./index.ts";
import { MIGRATIONS } from "./migrations.ts";
import type { Actor, Clock, Party } from "./types.ts";

/** 저장소 밖에 임시 폴더를 만들고, 테스트가 끝나면 지운다. */
export function makeTempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-butler-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 최신 버전의 스키마를 가진, WAL 모드가 아닌 원장 파일을 만든다. 원장을 SQLite로 백업한 복사본이 이런 파일이다.
 * 올릴 것이 없어, 열면 WAL로 바꾸는 일만 남는다.
 */
export function createCurrentFileWithoutWal(path: string): void {
  const raw = new DatabaseSync(path);
  raw.exec(MIGRATIONS.map((migration) => migration.sql).join("\n"));
  raw.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
  raw.close();
}

/** 파일이나 폴더의 권한 비트만 돌려준다. */
export function permissionBits(mode: number): number {
  return mode & 0o777;
}

/** concurrency-writer.ts의 hold 모드가 쓰는 요청의 id. 테스트가 이 행이 보이는지를 확인한다. */
export const HELD_REQUEST_ID = "req-held";

/** 테스트가 직접 움직이는 시계. 원장은 쓰기마다 이 시각을 읽는다. */
export type TestClock = {
  readonly now: Clock;
  /** 시각을 옮긴다. `2026-03-02`의 `HH:MM`이다. */
  set(hhmm: string): void;
};

/** 테스트에서 쓰는 날짜의 `HH:MM`을 시간대가 붙은 시각으로 적는다. 밖에서 넘기는 시각에 쓴다. */
export function at(hhmm: string): string {
  return `2026-03-02T${hhmm}:00Z`;
}

/** 같은 시각이 원장에 저장되는 형태. */
export function stored(hhmm: string): string {
  return `2026-03-02T${hhmm}:00.000000Z`;
}

export function testClock(start = "09:00"): TestClock {
  let current = new Date(at(start));
  return {
    now: () => current,
    set(hhmm) {
      current = new Date(at(hhmm));
    },
  };
}

/** 메모리에 원장을 열고, 테스트가 끝나면 닫는다. 식별자는 id-1, id-2, ... 순서로 나온다. */
export function openTestLedger(
  t: TestContext,
  start = "09:00",
): { ledger: Ledger; clock: TestClock } {
  const clock = testClock(start);
  let count = 0;
  const ledger = openLedger({
    path: ":memory:",
    clock: clock.now,
    newId: () => {
      count += 1;
      return `id-${count}`;
    },
  });
  t.after(() => ledger.close());
  return { ledger, clock };
}

/**
 * 임시 폴더의 파일에 원장을 열고, 테스트가 끝나면 닫는다.
 * 조회로 나오지 않는 저장된 값(쓰기 순번 등)을 `stored`로 직접 읽어 확인할 때 쓴다.
 */
export function openFileLedger(
  t: TestContext,
  start = "09:00",
): {
  ledger: Ledger;
  clock: TestClock;
  path: string;
  /** 원장을 거치지 않고 파일에서 한 줄을 읽는다. */
  row(sql: string, ...params: string[]): Record<string, unknown>;
} {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const clock = testClock(start);
  let count = 0;
  const ledger = openLedger({
    path,
    clock: clock.now,
    newId: () => {
      count += 1;
      return `id-${count}`;
    },
  });
  t.after(() => ledger.close());
  return {
    ledger,
    clock,
    path,
    row(sql, ...params) {
      const raw = new DatabaseSync(path, { readOnly: true });
      try {
        return { ...raw.prepare(sql).get(...params) };
      } finally {
        raw.close();
      }
    },
  };
}

/** 그 코드의 오류로 거부됐는지 본다. `fields`를 주면 오류가 밝힌 값도 같아야 한다. */
export function rejectsWith(
  code: LedgerErrorCode,
  fields?: readonly string[],
): (error: unknown) => boolean {
  return (error) => {
    if (!(error instanceof LedgerError) || error.code !== code) {
      return false;
    }
    if (fields !== undefined) {
      assert.deepEqual([...error.fields].sort(), [...fields].sort());
    }
    return true;
  };
}

export const user: Actor = { kind: "user", via: "web" };
export const userViaSkill: Actor = { kind: "user", via: "skill" };
export const triage: Actor = { kind: "assistant", module: "intake-triage" };
export const verifier: Actor = { kind: "assistant", module: "progress-verification" };

/** 지어낸 주체들. */
export const jiwon: Party = {
  kind: "person",
  name: "김지원",
  source: "slack",
  externalId: "U0000001",
};
export const minsu: Party = { kind: "person", name: "박민수" };
export const csTeam: Party = { kind: "team", name: "CS팀" };
export const me: Party = { kind: "user" };

const writerScript = fileURLToPath(new URL("./concurrency-writer.ts", import.meta.url));

/** 자식 프로세스가 신호를 보내지 않고 멈추면 끝없이 기다리게 되므로, 테스트마다 시간 제한을 둔다. */
export const WORKER_TEST_TIMEOUT_MS = 30_000;

export type FinishedWorker = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

export type Worker = {
  /** 표준 입력으로 신호 한 줄을 보낸다. */
  send(line: string): void;
  /** 표준 출력에 그 줄이 나올 때까지 기다린다. 그 전에 프로세스가 끝나면 바로 실패한다. */
  waitForLine(line: string): Promise<void>;
  /** 표준 출력에 그렇게 시작하는 줄이 나올 때까지 기다려 그 줄을 돌려준다. */
  waitForLineStartingWith(prefix: string): Promise<string>;
  /** 끝날 때까지 기다려 종료 코드, 신호, 출력을 돌려준다. */
  finished(): Promise<FinishedWorker>;
  kill(signal?: NodeJS.Signals): void;
};

/** concurrency-writer.ts를 별도 프로세스로 띄운다. `home`이 그 프로세스의 AI_BUTLER_HOME이다. */
export function startWorker(args: readonly string[], home: string): Worker {
  const child = spawn(process.execPath, [writerScript, ...args], {
    env: { ...process.env, AI_BUTLER_HOME: home },
  });
  let stdout = "";
  let stderr = "";
  let exit: Pick<FinishedWorker, "code" | "signal"> | undefined;
  // 출력이 더 왔거나 프로세스가 끝났을 때 깨울 것들.
  const waiters = new Set<() => void>();
  const wake = (): void => {
    for (const waiter of [...waiters]) {
      waiter();
    }
  };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    wake();
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  // 이미 끝난 프로세스에 신호를 보내도 테스트가 죽지 않게 한다. 끝난 것은 waitForLine과 finished가 알린다.
  child.stdin.on("error", () => {});
  // close는 출력이 모두 도착한 뒤에 온다. 정상 종료든 신호로 죽었든 한 번 온다.
  const closed = new Promise<void>((resolve) => {
    child.once("close", (code, signal) => {
      exit = { code, signal };
      wake();
      resolve();
    });
  });
  /** 조건에 맞는 줄이 나올 때까지 기다린다. 줄 수신과 프로세스 종료를 함께 기다린다. */
  const waitForLineWhere = async (
    matches: (line: string) => boolean,
    wanted: string,
  ): Promise<string> => {
    for (;;) {
      const found = stdout.split("\n").slice(0, -1).find(matches);
      if (found !== undefined) {
        return found;
      }
      if (exit !== undefined) {
        throw new Error(
          `${wanted}을 찍기 전에 프로세스가 끝났다 (code ${exit.code}, signal ${exit.signal}): ${stderr}`,
        );
      }
      await new Promise<void>((resolve) => {
        const waiter = (): void => {
          waiters.delete(waiter);
          resolve();
        };
        waiters.add(waiter);
      });
    }
  };

  return {
    send(line) {
      child.stdin.write(`${line}\n`);
    },
    async waitForLine(line) {
      await waitForLineWhere((candidate) => candidate === line, `"${line}"`);
    },
    waitForLineStartingWith(prefix) {
      return waitForLineWhere((candidate) => candidate.startsWith(prefix), `"${prefix}…"`);
    },
    async finished() {
      await closed;
      return { code: exit?.code ?? null, signal: exit?.signal ?? null, stdout, stderr };
    },
    kill(signal) {
      child.kill(signal);
    },
  };
}
