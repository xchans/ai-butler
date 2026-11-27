// 작업 2 가운데 원장 열기와 마이그레이션(S29)을 확인한다.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { changesSince, write } from "./changes.ts";
import { BUSY_TIMEOUT_MS, openDb, resolveLedgerPath } from "./db.ts";
import { LedgerError } from "./errors.ts";
import { openLedger } from "./index.ts";
import { MIGRATIONS, type Migration } from "./migrations.ts";
import { makeTempDir, permissionBits } from "./test-support.ts";
import type { Actor } from "./types.ts";

const user: Actor = { kind: "user", via: "web" };
const fixedClock = () => new Date("2026-03-02T09:00:00.000Z");

/** 이 테스트 동안만 AI_BUTLER_HOME을 임시 폴더로 바꾼다. */
function useHome(t: TestContext, home: string): void {
  const previous = process.env.AI_BUTLER_HOME;
  process.env.AI_BUTLER_HOME = home;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.AI_BUTLER_HOME;
    } else {
      process.env.AI_BUTLER_HOME = previous;
    }
  });
}

/** 원장을 거치지 않고 파일의 상태만 읽는다. */
function inspect<T>(path: string, read: (raw: DatabaseSync) => T): T {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    return read(raw);
  } finally {
    raw.close();
  }
}

function userVersion(path: string): unknown {
  return inspect(path, (raw) => raw.prepare("PRAGMA user_version").get()?.user_version);
}

function journalMode(path: string): unknown {
  return inspect(path, (raw) => raw.prepare("PRAGMA journal_mode").get()?.journal_mode);
}

function tableNames(path: string): unknown[] {
  return inspect(path, (raw) =>
    raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name),
  );
}

test("새로 만드는 폴더는 0700, 파일은 0600이고 WAL 모드다", (t) => {
  const home = join(makeTempDir(t), "data", "ai-butler");
  useHome(t, home);

  const ledger = openLedger();
  t.after(() => ledger.close());
  ledger.createRequest(user, { title: "지어낸 요청" });

  const path = join(home, "ledger.sqlite");
  assert.equal(permissionBits(statSync(home).mode), 0o700);
  assert.equal(permissionBits(statSync(join(home, "..")).mode), 0o700);
  assert.equal(permissionBits(statSync(path).mode), 0o600);
  assert.equal(journalMode(path), "wal");
  // WAL 모드가 만드는 보조 파일도 같은 권한이다.
  assert.equal(permissionBits(statSync(`${path}-wal`).mode), 0o600);
  assert.equal(permissionBits(statSync(`${path}-shm`).mode), 0o600);
});

test("이미 있는 폴더와 파일의 권한은 바꾸지 않는다", (t) => {
  const home = join(makeTempDir(t), "shared");
  mkdirSync(home, { mode: 0o755 });
  chmodSync(home, 0o755);
  const path = join(home, "ledger.sqlite");
  new DatabaseSync(path).close();
  chmodSync(path, 0o640);

  openLedger({ path }).close();

  assert.equal(permissionBits(statSync(home).mode), 0o755);
  assert.equal(permissionBits(statSync(path).mode), 0o640);
});

test("path를 주지 않으면 AI_BUTLER_HOME의 ledger.sqlite를 열고, 주면 그 파일을 연다", (t) => {
  const dir = makeTempDir(t);
  const home = join(dir, "home");
  useHome(t, home);

  openLedger().close();
  assert.equal(existsSync(join(home, "ledger.sqlite")), true);

  const elsewhere = join(dir, "elsewhere", "custom.sqlite");
  openLedger({ path: elsewhere }).close();
  assert.equal(existsSync(elsewhere), true);
});

test("저장 위치는 AI_BUTLER_HOME이고, 없으면 사용자 폴더의 Application Support 아래다", () => {
  assert.equal(
    resolveLedgerPath({ AI_BUTLER_HOME: "/tmp/butler-home" }, "/Users/tester"),
    "/tmp/butler-home/ledger.sqlite",
  );
  assert.equal(
    resolveLedgerPath({}, "/Users/tester"),
    "/Users/tester/Library/Application Support/ai-butler/ledger.sqlite",
  );
  assert.equal(
    resolveLedgerPath({ AI_BUTLER_HOME: "" }, "/Users/tester"),
    "/Users/tester/Library/Application Support/ai-butler/ledger.sqlite",
  );
});

test("S29: 닫았다 다시 열어도 데이터가 그대로다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const first = openLedger({ path, clock: fixedClock });
  const created = [
    first.createRequest(user, { title: "첫째 요청" }),
    first.createRequest({ kind: "assistant", module: "intake-triage" }, { title: "둘째 요청" }),
  ];
  const before = first.changesSince(0);
  first.close();

  const second = openLedger({ path, clock: fixedClock });
  t.after(() => second.close());

  assert.equal(before.length, 2);
  assert.deepEqual(second.changesSince(0), before);
  assert.deepEqual(
    inspect(path, (raw) =>
      raw.prepare("SELECT id, title, created_at FROM requests ORDER BY rowid").all(),
    ).map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at })),
    created,
  );
});

test("S29: 낮은 버전의 파일은 데이터를 잃지 않고 올라간다", (t) => {
  assert.ok(MIGRATIONS.length >= 2, "버전을 올리는 경로를 실제 마이그레이션으로 확인한다");
  const path = join(makeTempDir(t), "ledger.sqlite");

  // 첫 마이그레이션만 적용된 예전 파일을 만들고 변경 이력을 하나 남긴다.
  const old = openDb(path, { migrations: MIGRATIONS.slice(0, 1) });
  write(old, user, fixedClock, (scope) => {
    scope.record({
      target: { kind: "request", id: "req-old" },
      before: null,
      after: { title: "버전 1에서 남긴 변경" },
    });
  });
  const before = changesSince(old, 0);
  old.close();
  assert.equal(userVersion(path), 1);

  const ledger = openLedger({ path, clock: fixedClock });
  t.after(() => ledger.close());

  assert.equal(userVersion(path), MIGRATIONS.length);
  assert.equal(before.length, 1);
  assert.deepEqual(ledger.changesSince(0), before);
  // 올라간 스키마로 쓸 수 있고, 순번이 이어진다.
  ledger.createRequest(user, { title: "올린 뒤의 요청" });
  assert.deepEqual(
    ledger.changesSince(0).map((change) => change.seq),
    [1, 2],
  );
});

test("S29: 여러 버전이 밀려 있으면 순서대로 올린다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const ledger = openLedger({ path, clock: fixedClock });
  ledger.createRequest(user, { title: "남아 있어야 하는 요청" });
  const before = ledger.changesSince(0);
  ledger.close();

  // 둘째는 첫째가 만든 테이블을 고친다. 순서가 바뀌면 실패한다.
  const later: Migration[] = [
    { name: "테스트용 테이블", sql: "CREATE TABLE probe (id TEXT PRIMARY KEY) STRICT;" },
    { name: "테스트용 열", sql: "ALTER TABLE probe ADD COLUMN note TEXT;" },
  ];
  const upgraded = openDb(path, { migrations: [...MIGRATIONS, ...later] });
  t.after(() => upgraded.close());

  assert.equal(userVersion(path), MIGRATIONS.length + 2);
  assert.deepEqual(changesSince(upgraded, 0), before);
  upgraded.prepare("INSERT INTO probe (id, note) VALUES (?, ?)").run("p1", "둘 다 적용됐다");
});

test("S29: 높은 버전의 파일은 열지 않고 오류를 내며 파일을 바꾸지 않는다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const future = new DatabaseSync(path);
  future.exec(
    `CREATE TABLE from_the_future (id TEXT); PRAGMA user_version = ${MIGRATIONS.length + 1};`,
  );
  future.close();

  assert.throws(
    () => openLedger({ path }),
    (error) => error instanceof LedgerError && error.code === "schema_version_too_new",
  );

  assert.equal(userVersion(path), MIGRATIONS.length + 1);
  assert.equal(journalMode(path), "delete");
  assert.deepEqual(tableNames(path), ["from_the_future"]);
});

test("마이그레이션이 실패하면 버전과 스키마가 그대로다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  openLedger({ path }).close();
  const tablesBefore = tableNames(path);

  const broken: Migration = {
    name: "실패하는 마이그레이션",
    sql: "CREATE TABLE half_done (id TEXT) STRICT; INSERT INTO no_such_table VALUES (1);",
  };
  const neverReached: Migration = {
    name: "실패한 것 뒤의 마이그레이션",
    sql: "CREATE TABLE never_reached (id TEXT) STRICT;",
  };
  assert.throws(
    () => openDb(path, { migrations: [...MIGRATIONS, broken, neverReached] }),
    (error) => {
      assert.ok(error instanceof Error);
      // 어느 버전의 어떤 마이그레이션이 왜 실패했는지 알 수 있다.
      assert.match(error.message, new RegExp(`버전 ${MIGRATIONS.length + 1}`));
      assert.match(error.message, /실패하는 마이그레이션/);
      assert.match(error.message, /no_such_table/);
      assert.match(String((error.cause as Error | undefined)?.message), /no_such_table/);
      return true;
    },
  );

  assert.equal(userVersion(path), MIGRATIONS.length);
  assert.deepEqual(tableNames(path), tablesBefore);
  // 실패한 뒤에도 원래 버전으로 열 수 있다.
  openLedger({ path }).close();
});

test("음수 스키마 버전의 파일은 열지 않고 오류를 내며 버전과 스키마를 그대로 둔다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const odd = new DatabaseSync(path);
  odd.exec("CREATE TABLE unrelated (id TEXT); PRAGMA user_version = -1;");
  odd.close();

  assert.throws(
    () => openLedger({ path }),
    (error) => error instanceof LedgerError && error.code === "schema_version_invalid",
  );

  assert.equal(userVersion(path), -1);
  assert.equal(journalMode(path), "delete");
  assert.deepEqual(tableNames(path), ["unrelated"]);
});

test("연 뒤의 busy timeout은 정한 값이다", (t) => {
  const dir = makeTempDir(t);
  const byDefault = openDb(join(dir, "default.sqlite"));
  const shortened = openDb(join(dir, "short.sqlite"), { busyTimeoutMs: 1234 });
  t.after(() => {
    byDefault.close();
    shortened.close();
  });
  const busyTimeout = (db: DatabaseSync) => db.prepare("PRAGMA busy_timeout").get()?.timeout;

  // WAL로 바꾸는 동안 줄여 둔 대기 시간이 일반 쓰기용으로 되돌아와 있다.
  assert.equal(busyTimeout(byDefault), BUSY_TIMEOUT_MS);
  assert.equal(busyTimeout(shortened), 1234);
});

test("WAL로 바꾸지 못하게 막는 잠금이 풀리지 않으면 busy timeout 한도에서 잠금 오류로 끝낸다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  // WAL이 아닌 파일에 읽는 연결과 쓰기를 예약한 연결이 붙어 있다.
  const reader = new DatabaseSync(path);
  reader.exec("CREATE TABLE unrelated (id TEXT);");
  const reserved = new DatabaseSync(path);
  t.after(() => {
    reader.close();
    reserved.close();
  });
  reader.exec("BEGIN; SELECT count(*) FROM unrelated;");
  reserved.exec("BEGIN IMMEDIATE");
  const budgetMs = 300;

  const startedAt = performance.now();
  assert.throws(
    () => openDb(path, { busyTimeoutMs: budgetMs }),
    (error) => (error as { errcode?: number }).errcode === 5,
  );
  const elapsedMs = performance.now() - startedAt;

  // 한도까지는 다시 시도하고, 한도를 크게 넘기지 않는다.
  assert.ok(elapsedMs >= budgetMs - 20, `${elapsedMs.toFixed(0)}ms 만에 끝났다`);
  assert.ok(elapsedMs < budgetMs + 200, `${elapsedMs.toFixed(0)}ms가 걸렸다`);
  reserved.exec("ROLLBACK");
  reader.exec("ROLLBACK");
  assert.equal(journalMode(path), "delete");
});

test("닫은 원장을 부르면 오류를 낸다. 두 번 닫아도 된다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const ledger = openLedger({ path });
  ledger.close();
  ledger.close();

  const isClosedError = (error: unknown) =>
    error instanceof LedgerError && error.code === "ledger_closed";
  assert.throws(() => ledger.createRequest(user, { title: "닫은 뒤의 요청" }), isClosedError);
  assert.throws(() => ledger.changesSince(0), isClosedError);
});

test("메모리 DB로 열 수 있다", (t) => {
  const ledger = openLedger({ path: ":memory:", clock: fixedClock });
  t.after(() => ledger.close());

  ledger.createRequest(user, { title: "메모리에만 있는 요청" });

  assert.equal(ledger.changesSince(0).length, 1);
});
