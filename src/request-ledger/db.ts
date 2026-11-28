import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LedgerError } from "./errors.ts";
import {
  assertVersionSupported,
  MIGRATIONS,
  type Migration,
  migrate,
  schemaVersion,
} from "./migrations.ts";

/** 원장 파일에 대한 연결 하나. 프로세스마다 따로 연다. */
export type LedgerDb = DatabaseSync;

/** 파일 대신 메모리에 여는 경로. 테스트에서 쓴다. */
export const MEMORY_PATH = ":memory:";

/** 다른 프로세스가 쓰는 동안 잠금을 기다리는 시간. 이 시간을 넘기면 SQLite가 잠금 오류를 낸다. */
export const BUSY_TIMEOUT_MS = 5_000;

const LEDGER_FILE_NAME = "ledger.sqlite";

export type OpenDbOptions = {
  /** 적용할 마이그레이션 목록. 없으면 `MIGRATIONS`. 테스트에서 버전을 올리는 경로를 확인할 때 바꾼다. */
  readonly migrations?: readonly Migration[];
  /** 잠금을 기다리는 시간. 없으면 `BUSY_TIMEOUT_MS`. 테스트에서 줄여 쓴다. */
  readonly busyTimeoutMs?: number;
  /**
   * WAL로 바꾸는 한도를 재는 시계와 대기. 없으면 실제 단조 시계와 실제 대기를 쓴다.
   * 테스트가 시계와 대기를 제어할 때만 바꾸는 내부 옵션이다. 원장의 공개 계약(`openLedger`)에는 내보내지 않는다.
   */
  readonly walTiming?: WalTiming;
};

/** WAL로 바꾸는 한도를 재는 데 쓰는 시계와, 다시 시도하기 전에 쉬는 대기. */
export type WalTiming = {
  /** 단조 시계의 지금 시각(밀리초). 시스템 시각이 바뀌어도 한도가 늘거나 줄지 않게 단조 시계로 잰다. */
  readonly now: () => number;
  /** 그 시간만큼 쉰다. */
  readonly sleep: (ms: number) => void;
};

/** 원장 파일의 기본 위치. AI_BUTLER_HOME이 있으면 그 폴더, 없으면 사용자 폴더의 Application Support 아래다. */
export function resolveLedgerPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  const base = env.AI_BUTLER_HOME || join(home, "Library", "Application Support", "ai-butler");
  return join(base, LEDGER_FILE_NAME);
}

/** 폴더는 0700, 파일은 0600으로 만든다. 이미 있는 것의 권한은 바꾸지 않는다. */
function createPrivateFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    // wx: 없을 때만 만든다. SQLite가 만들게 두면 umask대로 0644가 된다.
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

/** SQLite의 기본 결과 코드 SQLITE_BUSY. 확장 코드는 아래 8비트가 같다. */
const SQLITE_BUSY = 5;

/** WAL 모드로 바꾸려다 잠금에 걸렸을 때 다시 시도하기 전에 쉬는 시간. */
const WAL_RETRY_INTERVAL_MS = 10;

function isBusyError(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  return typeof errcode === "number" && (errcode & 0xff) === SQLITE_BUSY;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function setBusyTimeout(db: LedgerDb, ms: number): void {
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(ms))}`);
}

function journalModeOf(db: LedgerDb): string {
  return String(db.prepare("PRAGMA journal_mode").get()?.journal_mode);
}

const REAL_WAL_TIMING: WalTiming = { now: () => performance.now(), sleep: sleepSync };

/** 잠금 오류로 끝나면 한도까지 잠깐씩 쉬며 다시 시도한다. 한도가 지났어도 한 번은 시도한다. */
function retryWhileBusy(timing: WalTiming, deadline: number, attempt: () => void): void {
  for (;;) {
    try {
      attempt();
      return;
    } catch (error) {
      const remainingMs = deadline - timing.now();
      if (!isBusyError(error) || remainingMs <= 0) {
        throw error;
      }
      timing.sleep(Math.min(WAL_RETRY_INTERVAL_MS, remainingMs));
    }
  }
}

/**
 * 최신 버전인데 WAL 모드가 아닌 파일을 WAL 모드로 바꾼다. 바꿨으면 true를 돌려준다.
 *
 * 버전을 확인하는 것과 저널 모드를 바꾸는 것 사이에 다른 프로그램이 끼어들지 못하게, 쓰기 잠금을 잡고 버전을
 * 다시 읽은 뒤 그 잠금을 놓지 않은 채로 바꾼다. SQLite는 트랜잭션 안에서 WAL로 바꾸지 못하므로, 배타 잠금
 * 모드로 커밋해 커밋 뒤에도 잠금이 남게 한다. 그래서 저널 모드를 바꾸는 시점의 버전은 방금 확인한 그 버전이다.
 *
 * 잠금을 잡고 보니 더 높은 버전이면(기다리는 사이에 다른 프로그램이 올렸다) 그 자리에서 아무것도 바꾸지 않고
 * `schema_version_too_new`로 거부한다. 버전이 낮아졌거나 이미 WAL이면 아무것도 바꾸지 않고 false를 돌려주고,
 * 부른 쪽이 처음부터 다시 판정한다.
 *
 * `deadline`은 이 열기가 WAL로 바꾸는 데 쓸 수 있는 시간의 끝이다. 쓰기 잠금을 기다리는 시간과, 읽는 연결
 * 때문에 다시 시도하는 시간이 모두 그 안이어야 한다. 한 번 여는 동안 여러 번 불려도 같은 `deadline`을 받는다.
 * 잠금 상태에 따라 SQLite가 기다리지 않고 바로 잠금 오류로 끝내기도 하므로, 다시 시도하는 시간은 여기서 잰다.
 *
 * 바꾼 뒤의 연결은 배타 잠금 모드의 WAL이라 다른 연결과 함께 쓸 수 없다. 부른 쪽이 닫고 다시 연다.
 * false를 돌려줄 때는 연결의 busy timeout을 `busyTimeoutMs`로 되돌려 놓는다.
 */
function convertToWal(
  db: LedgerDb,
  migrations: readonly Migration[],
  deadline: number,
  busyTimeoutMs: number,
  timing: WalTiming,
): boolean {
  // 쓰기 잠금을 기다리는 시간도 남은 한도 안으로 제한한다. 한도가 지났으면 기다리지 않고 한 번만 시도한다.
  setBusyTimeout(db, deadline - timing.now());
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = schemaVersion(db);
    // 더 높은 버전임을 잠금 안에서 읽었다. 다음 판정으로 넘기지 않고 여기서 거부한다.
    assertVersionSupported(version, migrations);
    if (version !== migrations.length || journalModeOf(db) === "wal") {
      db.exec("ROLLBACK");
      setBusyTimeout(db, busyTimeoutMs);
      return false;
    }
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    setBusyTimeout(db, 0);
    // 쓴 것이 없는 커밋이지만, 배타 잠금 모드라 여기서 읽는 연결이 모두 빠지기를 기다리고 잠금을 쥔 채 끝난다.
    retryWhileBusy(timing, deadline, () => db.exec("COMMIT"));
    retryWhileBusy(timing, deadline, () => {
      const mode = db.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode;
      if (mode !== "wal") {
        throw new Error(`원장 파일을 WAL 모드로 바꾸지 못했다 (지금 모드: ${String(mode)})`);
      }
    });
    return true;
  } catch (error) {
    // 저널 모드를 바꾸기 전에 끝난 것이다. 부른 쪽이 연결을 닫으면 잠금이 풀리고 파일은 그대로다.
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
    throw error;
  }
}

/**
 * 연결마다, 그 연결을 열 때 쓴 마이그레이션 목록의 버전. 이 프로그램이 읽고 쓸 줄 아는 버전이다.
 * 쓰기마다 파일의 버전이 이 값인지 확인하는 데 쓴다.
 */
const openedAtVersion = new WeakMap<LedgerDb, number>();

/**
 * 버전과 저널 모드를 다시 판정하는 횟수의 한도. 다른 프로그램이 끼어들지 않으면 두 번 안에 끝난다.
 * 다른 프로그램이 저널 모드를 계속 되돌려도 여는 호출이 끝나게 한다.
 */
const OPEN_ROUNDS = 8;

/**
 * 원장 파일을 열고 스키마를 올린 뒤 WAL 모드로 바꾼다.
 * 지원하지 않는 버전의 파일이나 새 형태로 옮길 수 없는 데이터가 있는 파일이면 아무것도 바꾸지 않고 오류를 낸다.
 *
 * 돌려주는 연결은 WAL 모드이고, 돌려주기 직전에 읽은 버전이 이 프로그램의 버전이다. 여는 동안 다른 프로그램이
 * 파일을 더 높은 버전으로 올렸으면 저널 모드를 건드리지 않고 `schema_version_too_new`로 거부한다.
 */
export function openDb(path: string, options: OpenDbOptions = {}): LedgerDb {
  const migrations = options.migrations ?? MIGRATIONS;
  const busyTimeoutMs = options.busyTimeoutMs ?? BUSY_TIMEOUT_MS;
  const timing = options.walTiming ?? REAL_WAL_TIMING;
  const inMemory = path === MEMORY_PATH;
  const file = inMemory ? path : resolve(path);
  if (!inMemory) {
    createPrivateFile(file);
  }
  const connect = (): LedgerDb => {
    const connection = new DatabaseSync(file, { timeout: busyTimeoutMs });
    try {
      // 연결을 열 때마다 켠다. 트랜잭션 안에서는 바뀌지 않으므로 마이그레이션보다 먼저다.
      connection.exec("PRAGMA foreign_keys = ON");
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  };
  let db = connect();
  // 이 열기가 WAL로 바꾸는 데 쓸 수 있는 시간의 끝. 처음 바꾸려 할 때 정하고, 다시 바꾸게 돼도 새로 잡지 않는다.
  let walDeadline: number | undefined;
  try {
    for (let round = 0; round < OPEN_ROUNDS; round += 1) {
      // 올리는 일은 파일의 지금 저널 모드 그대로 한다. 버전이 맞지 않거나 옮길 수 없는 데이터가 있는 파일은
      // 여기서 거부되어 저널 모드도 바뀌지 않는다. WAL로 바꾸는 것은 올리기가 성공한 뒤다.
      migrate(db, migrations);
      if (inMemory) {
        openedAtVersion.set(db, migrations.length);
        return db;
      }
      if (journalModeOf(db) !== "wal") {
        walDeadline ??= timing.now() + busyTimeoutMs;
        if (convertToWal(db, migrations, walDeadline, busyTimeoutMs, timing)) {
          db.close();
          db = connect();
        }
        // 바꿨든 바꾸지 않았든 처음부터 다시 판정한다.
        continue;
      }
      // WAL 모드임을 본 뒤에 버전을 마지막으로 한 번 더 읽고 돌려준다.
      const version = schemaVersion(db);
      if (version === migrations.length) {
        openedAtVersion.set(db, migrations.length);
        return db;
      }
      // 그사이에 더 높은 버전이 됐으면 방금 읽은 값으로 여기서 거부한다. 낮아졌으면 올리기부터 다시 한다.
      assertVersionSupported(version, migrations);
    }
    throw new LedgerError(
      "journal_mode_unstable",
      `여는 동안 원장 파일의 저널 모드가 계속 바뀌어 ${OPEN_ROUNDS}번 안에 WAL 모드로 열지 못했다`,
    );
  } catch (error) {
    if (db.isOpen) {
      db.close();
    }
    throw error;
  }
}

/**
 * 읽기 트랜잭션 하나 안에서 body를 실행한다. body의 여러 조회가 같은 시점의 내용을 본다.
 * 조회하는 사이에 다른 연결이 커밋해도 한 결과에 서로 다른 시점의 값과 변경 이력이 섞이지 않는다.
 * 이미 트랜잭션 안이면 그 트랜잭션의 시점으로 읽는다.
 */
export function inReadTransaction<T>(db: LedgerDb, body: () => T): T {
  if (db.isTransaction) {
    return body();
  }
  db.exec("BEGIN");
  try {
    return body();
  } finally {
    // 읽기만 했으므로 남길 것이 없다. 오류가 났어도 트랜잭션은 닫는다.
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
  }
}

/** 쓰기 콜백이 돌려줄 수 있는 값. Promise처럼 `then`이 있는 값은 돌려줄 수 없다. */
export type SyncResult<T> = T extends PromiseLike<unknown> ? never : T;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * 쓰기 트랜잭션 하나 안에서 body를 실행한다. body가 오류를 던지면 아무것도 저장하지 않는다.
 * BEGIN IMMEDIATE로 쓰기 잠금을 먼저 잡아, 규칙을 검사한 뒤 저장하기 전에 다른 프로세스의 쓰기가 끼어들지 못하게 한다.
 *
 * 쓰기 잠금을 잡은 뒤 파일의 스키마 버전을 읽어, 이 연결을 열 때의 버전과 다르면 `schema_version_too_new`로
 * 거부하고 아무것도 쓰지 않는다. 원장을 연 뒤에 다른 프로그램이 파일을 더 높은 버전으로 올렸을 때,
 * 이미 연 원장이 모르는 스키마에 쓰지 않게 한다. 읽기는 막지 않는다.
 *
 * body는 동기로 끝나야 한다. Promise를 돌려주면 그 뒤에 이어질 쓰기가 트랜잭션 밖으로 빠져나가므로,
 * 커밋하지 않고 롤백한 뒤 `async_write` 오류를 낸다.
 */
export function inWriteTransaction<T>(db: LedgerDb, body: () => SyncResult<T>): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    // 잠금을 잡은 뒤에 읽으므로, 이 쓰기가 끝날 때까지 다른 프로그램이 버전을 바꿀 수 없다.
    const opened = openedAtVersion.get(db);
    const version = opened === undefined ? undefined : schemaVersion(db);
    if (version !== opened) {
      throw new LedgerError(
        "schema_version_too_new",
        `원장을 연 뒤에 파일의 스키마 버전이 바뀌어(${opened} → ${version}) 쓰지 않는다. 이 프로그램이 아는 버전은 ${opened}이다`,
      );
    }
    const result: unknown = body();
    if (isThenable(result)) {
      // 버려지는 값이 나중에 거부되거나 오류를 내도 프로세스를 죽이지 않게 한다. `then`을 직접 부르지 않고
      // 표준 Promise에 맡긴다. 성공 함수를 부르는 객체든 `then`에서 오류를 던지는 객체든 여기서 삼켜진다.
      Promise.resolve(result).catch(() => {});
      throw new LedgerError(
        "async_write",
        "쓰기 콜백은 동기로 끝나야 한다. Promise를 돌려주는 콜백은 받지 않는다",
      );
    }
    db.exec("COMMIT");
    return result as T;
  } catch (error) {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
    throw error;
  }
}
