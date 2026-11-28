// 테스트에서만 쓰는 도우미다. 모듈의 공개 계약이 아니다.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
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
