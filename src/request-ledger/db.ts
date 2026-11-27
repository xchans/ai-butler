import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LedgerError } from "./errors.ts";
import { assertSupportedVersion, MIGRATIONS, type Migration, migrate } from "./migrations.ts";

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

/** WAL 모드로 바꾸다 잠금에 걸렸을 때 다시 시도하기 전에 쉬는 시간. */
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

/**
 * WAL 모드로 바꾼다. 이미 WAL이면 아무것도 바뀌지 않는다.
 *
 * 이 전환은 잠금 상태에 따라 busy timeout을 기다리지 않고 바로 잠금 오류로 끝나기도 하고(파일이 없을 때
 * 여러 프로세스가 동시에 처음 여는 경우가 그렇다), busy timeout만큼 기다리기도 한다. 그래서 전환하는
 * 동안에는 SQLite가 스스로 기다리지 않게 하고, 다시 시도하는 시간을 여기서 재어 모두 합쳐 budgetMs를
 * 넘지 않게 한다. 끝나면 일반 쓰기에 쓰는 busy timeout으로 되돌린다.
 */
function enableWal(db: LedgerDb, budgetMs: number): void {
  // 시스템 시각이 바뀌어도 한도가 늘거나 줄지 않게 단조 시계로 잰다.
  const deadline = performance.now() + budgetMs;
  setBusyTimeout(db, 0);
  try {
    for (;;) {
      try {
        const mode = db.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode;
        if (mode !== "wal") {
          throw new Error(`원장 파일을 WAL 모드로 바꾸지 못했다 (지금 모드: ${String(mode)})`);
        }
        return;
      } catch (error) {
        const remainingMs = deadline - performance.now();
        if (!isBusyError(error) || remainingMs <= 0) {
          throw error;
        }
        sleepSync(Math.min(WAL_RETRY_INTERVAL_MS, remainingMs));
      }
    }
  } finally {
    setBusyTimeout(db, budgetMs);
  }
}

/** 원장 파일을 열고 스키마를 올린다. 지원하지 않는 버전의 파일이면 아무것도 바꾸지 않고 오류를 낸다. */
export function openDb(path: string, options: OpenDbOptions = {}): LedgerDb {
  const migrations = options.migrations ?? MIGRATIONS;
  const busyTimeoutMs = options.busyTimeoutMs ?? BUSY_TIMEOUT_MS;
  const inMemory = path === MEMORY_PATH;
  const file = inMemory ? path : resolve(path);
  if (!inMemory) {
    createPrivateFile(file);
  }
  const db = new DatabaseSync(file, { timeout: busyTimeoutMs });
  try {
    assertSupportedVersion(db, migrations);
    if (!inMemory) {
      enableWal(db, busyTimeoutMs);
    }
    migrate(db, migrations);
    return db;
  } catch (error) {
    db.close();
    throw error;
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
 * body는 동기로 끝나야 한다. Promise를 돌려주면 그 뒤에 이어질 쓰기가 트랜잭션 밖으로 빠져나가므로,
 * 커밋하지 않고 롤백한 뒤 `async_write` 오류를 낸다.
 */
export function inWriteTransaction<T>(db: LedgerDb, body: () => SyncResult<T>): T {
  db.exec("BEGIN IMMEDIATE");
  try {
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
