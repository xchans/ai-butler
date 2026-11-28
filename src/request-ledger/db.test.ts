// 작업 2 가운데 원장 열기와 마이그레이션(S29)을 확인한다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { changesSince, write } from "./changes.ts";
import { BUSY_TIMEOUT_MS, openDb, resolveLedgerPath } from "./db.ts";
import { LedgerError } from "./errors.ts";
import { openLedger } from "./index.ts";
import { MIGRATIONS, type Migration } from "./migrations.ts";
import { createCurrentFileWithoutWal, makeTempDir, permissionBits } from "./test-support.ts";
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
  ledger.createRequest(user, { stated: { title: "지어낸 요청" } });

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

test("연결을 열 때 외래 키 검사를 켜고, 테이블은 데이터 모델이 이번 단계까지로 적은 것만 있다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const db = openDb(path);
  t.after(() => db.close());

  assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
  // 없는 요청을 가리키는 작업은 저장되지 않는다.
  assert.throws(() =>
    db.exec(
      `INSERT INTO tasks (id, request_id, created_at, added_seq, work, work_seq, status)
       VALUES ('task-1', 'request-none', '2026-03-02T09:00:00.000000Z', 1, '작업', 1, 'todo')`,
    ),
  );
  // 보류, 닫기, 묶음, 맡긴 일의 테이블은 그 작업에서 만든다.
  assert.deepEqual(
    tableNames(path).filter((name) => name !== "sqlite_sequence"),
    [
      "changes",
      "links",
      "materials",
      "notices",
      "open_items",
      "records",
      "requests",
      "revisions",
      "task_dependencies",
      "tasks",
    ],
  );
});

test("S29: 닫았다 다시 열어도 데이터가 그대로다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const first = openLedger({ path, clock: fixedClock });
  const created = [
    first.createRequest(user, {
      stated: { title: "첫째 요청", due: "2026-03-09T18:00:00+09:00" },
      decided: { urgency: "high" },
    }),
    first.createRequest(
      { kind: "assistant", module: "intake-triage" },
      { decided: { title: "둘째 요청" }, undecided: true },
    ),
  ];
  const changesBefore = first.changesSince(0);
  const requestsBefore = created.map(({ id }) => first.getRequest(id));
  first.close();

  const second = openLedger({ path, clock: fixedClock });
  t.after(() => second.close());

  assert.equal(changesBefore.length, 2);
  assert.deepEqual(second.changesSince(0), changesBefore);
  assert.deepEqual(
    created.map(({ id }) => second.getRequest(id)),
    requestsBefore,
  );
  assert.equal(requestsBefore[0]?.due.value, "2026-03-09T09:00:00.000000Z");
  assert.equal(requestsBefore[1]?.undecided, true);
});

// 예전 버전의 파일은 그 버전의 형태로 고정한 SQL로 준비한다. 지금의 쓰기 함수는 지금의 스키마로만 쓰므로
// 예전 파일을 만드는 데 쓰면 예전 형태가 아니게 된다.
const VERSION_1_SCHEMA = `
  CREATE TABLE changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    before_value TEXT NOT NULL,
    after_value TEXT NOT NULL,
    evidence TEXT NOT NULL,
    reason TEXT
  ) STRICT;
`;

const VERSION_2_SCHEMA = `
  ${VERSION_1_SCHEMA}
  CREATE TABLE requests (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
`;

/** 버전 2까지의 쓰기가 남기던 변경 이력 한 건. 시각은 밀리초 형태였다. */
function oldChangeSql(at: string, actor: Actor, requestId: string, title: string): string {
  const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return `INSERT INTO changes
            (at, actor, target_kind, target_id, before_value, after_value, evidence, reason)
          VALUES (${quoted(at)}, ${quoted(JSON.stringify(actor))}, 'request', ${quoted(requestId)},
                  'null', ${quoted(JSON.stringify({ title }))}, '[]', NULL);`;
}

/** 예전 버전의 파일을 직접 쓴 SQL로 만든다. */
function writeOldFile(
  path: string,
  version: number,
  sql: string,
  { wal = true }: { wal?: boolean } = {},
): void {
  const raw = new DatabaseSync(path);
  // 예전 버전의 원장도 파일을 WAL 모드로 열었다. WAL이 아닌 파일은 그 파일을 백업한 복사본에 해당한다.
  raw.exec(`${wal ? "PRAGMA journal_mode = WAL;" : ""} ${sql} PRAGMA user_version = ${version};`);
  raw.close();
}

const whitespace = /\s+/g;

test("S29: 마이그레이션 1과 2는 내보낸 그대로다", () => {
  // 예전 파일을 만드는 데 쓰는 고정한 스키마가 실제로 내보냈던 것과 같은지 본다.
  const shipped = MIGRATIONS.slice(0, 2)
    .map((migration) => migration.sql)
    .join("");
  assert.equal(
    shipped.replace(whitespace, " ").trim(),
    VERSION_2_SCHEMA.replace(whitespace, " ").trim(),
  );
});

test("S29: 버전 1의 파일은 데이터를 잃지 않고 올라간다. 요청 줄이 없는 변경 이력도 그대로 남는다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  writeOldFile(
    path,
    1,
    VERSION_1_SCHEMA +
      oldChangeSql("2026-03-02T09:00:00.123Z", user, "req-old-1", "버전 1에서 사용자가 남긴 변경") +
      oldChangeSql(
        "2026-03-02T09:05:00.000Z",
        { kind: "assistant", module: "intake-triage" },
        "req-old-2",
        "버전 1에서 비서가 남긴 변경",
      ),
  );
  assert.equal(userVersion(path), 1);

  const ledger = openLedger({ path, clock: fixedClock, newId: () => "req-new" });
  t.after(() => ledger.close());

  assert.equal(userVersion(path), MIGRATIONS.length);
  // 순번, 주체, 대상, 값은 그대로이고, 시각은 뜻이 같은 마이크로초 형태로 바뀐다.
  // 쓰기 순번은 순번, 쓰기 이름은 createRequest, 요청은 대상의 식별자로 채워진다.
  assert.deepEqual(ledger.changesSince(0), [
    {
      seq: 1,
      writeSeq: 1,
      at: "2026-03-02T09:00:00.123000Z",
      actor: user,
      action: "createRequest",
      target: { kind: "request", id: "req-old-1" },
      requestId: "req-old-1",
      before: null,
      after: { title: "버전 1에서 사용자가 남긴 변경" },
      evidence: [],
      reason: null,
      appliesTo: { scope: "similar_future", stated: false },
    },
    {
      seq: 2,
      writeSeq: 2,
      at: "2026-03-02T09:05:00.000000Z",
      actor: { kind: "assistant", module: "intake-triage" },
      action: "createRequest",
      target: { kind: "request", id: "req-old-2" },
      requestId: "req-old-2",
      before: null,
      after: { title: "버전 1에서 비서가 남긴 변경" },
      evidence: [],
      reason: null,
      appliesTo: null,
    },
  ]);
  // 버전 1에는 요청 테이블이 없었다. 요청 줄은 생기지 않는다.
  assert.equal(
    inspect(path, (raw) => raw.prepare("SELECT count(*) AS count FROM requests").get()?.count),
    0,
  );
  // 올라간 스키마로 쓸 수 있고, 순번이 이어진다.
  ledger.createRequest(user, { stated: { title: "올린 뒤의 요청" } });
  assert.deepEqual(
    ledger.changesSince(0).map((change) => [change.seq, change.writeSeq]),
    [
      [1, 1],
      [2, 2],
      [3, 3],
    ],
  );
  assert.equal(ledger.getRequest("req-new").title.value, "올린 뒤의 요청");
});

test("S29: 버전 2의 파일을 올리면 요청과 변경 이력이 데이터 모델대로 채워진다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const triage: Actor = { kind: "assistant", module: "intake-triage" };
  writeOldFile(
    path,
    2,
    `${VERSION_2_SCHEMA}
     INSERT INTO requests (id, title, created_at) VALUES
       ('req-by-user', '사용자가 등록한 요청', '2026-03-02T09:00:00.123Z'),
       ('req-by-assistant', '비서가 등록한 요청', '2026-03-02T09:05:00.000Z');
     ${oldChangeSql("2026-03-02T09:00:00.123Z", user, "req-by-user", "사용자가 등록한 요청")}
     ${oldChangeSql("2026-03-02T09:05:00.000Z", triage, "req-by-assistant", "비서가 등록한 요청")}`,
  );

  const ledger = openLedger({ path, clock: fixedClock, newId: () => "new-id" });
  t.after(() => ledger.close());
  assert.equal(userVersion(path), MIGRATIONS.length);

  // 있던 변경 이력에 쓰기 순번, 쓰기 이름, 요청이 채워지고 시각이 마이크로초 형태가 된다.
  assert.deepEqual(
    ledger
      .changesSince(0)
      .map(({ seq, writeSeq, at, action, requestId, after }) => [
        seq,
        writeSeq,
        at,
        action,
        requestId,
        after,
      ]),
    [
      [
        1,
        1,
        "2026-03-02T09:00:00.123000Z",
        "createRequest",
        "req-by-user",
        { title: "사용자가 등록한 요청" },
      ],
      [
        2,
        2,
        "2026-03-02T09:05:00.000000Z",
        "createRequest",
        "req-by-assistant",
        { title: "비서가 등록한 요청" },
      ],
    ],
  );

  // 사용자가 등록한 요청은 제목에 사용자 지정이 걸리고, 걸린 시각은 접수 시각이다.
  const byUser = ledger.getRequest("req-by-user");
  assert.equal(byUser.createdAt, "2026-03-02T09:00:00.123000Z");
  assert.deepEqual(byUser.title, {
    value: "사용자가 등록한 요청",
    setBy: "user",
    userSet: true,
    userSetAt: "2026-03-02T09:00:00.123000Z",
  });
  assert.deepEqual(
    byUser.changes.map((change) => change.seq),
    [1],
  );
  // 비서가 등록한 요청은 정한 주체가 비서이고 사용자 지정이 없다.
  const byAssistant = ledger.getRequest("req-by-assistant");
  assert.equal(byAssistant.createdAt, "2026-03-02T09:05:00.000000Z");
  assert.deepEqual(byAssistant.title, {
    value: "비서가 등록한 요청",
    setBy: "assistant",
    userSet: false,
    userSetAt: null,
  });
  // 나머지 값은 비어 있고 미정이 아니다.
  for (const request of [byUser, byAssistant]) {
    assert.equal(request.undecided, false);
    for (const value of [request.requester, request.promise, request.due, request.urgency]) {
      assert.deepEqual(value, { value: null, setBy: null, userSet: false, userSetAt: null });
    }
  }
  // 등록한 쓰기 순번, 제목을 쓴 순번, 더해진 순번은 그 요청을 등록한 변경 이력의 순번이다.
  assert.deepEqual(
    inspect(path, (raw) =>
      raw
        .prepare(
          "SELECT id, created_seq, title_written_seq, added_seq FROM requests ORDER BY created_seq",
        )
        .all(),
    ).map((row) => ({ ...row })),
    [
      { id: "req-by-user", created_seq: 1, title_written_seq: 1, added_seq: 1 },
      { id: "req-by-assistant", created_seq: 2, title_written_seq: 2, added_seq: 2 },
    ],
  );

  // 채워진 값으로 규칙이 그대로 동작한다. 사용자 지정이 걸린 제목은 비서가 바로 바꿀 수 없고,
  // 비서가 등록한 요청의 제목은 바꿀 수 있다. 순번도 이어진다.
  assert.throws(
    () => ledger.updateRequest(triage, { requestId: "req-by-user", title: "비서가 고친 제목" }),
    (error) => error instanceof LedgerError && error.code === "user_set_protected",
  );
  ledger.updateRequest(triage, { requestId: "req-by-assistant", title: "비서가 고친 제목" });
  assert.equal(ledger.getRequest("req-by-assistant").title.value, "비서가 고친 제목");
  assert.deepEqual(
    ledger.changesSince(2).map((change) => [change.seq, change.writeSeq, change.requestId]),
    [[3, 3, "req-by-assistant"]],
  );
});

/** 파일의 저널 모드, 버전, 스키마, 모든 줄. 거부한 파일이 그대로인지 비교하는 데 쓴다. */
function fileState(path: string): unknown {
  return inspect(path, (raw) => {
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row.name));
    return {
      journalMode: raw.prepare("PRAGMA journal_mode").get()?.journal_mode,
      version: raw.prepare("PRAGMA user_version").get()?.user_version,
      schema: raw
        .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name")
        .all()
        .map((row) => ({ ...row })),
      rows: Object.fromEntries(
        tables.map((table) => [
          table,
          raw
            .prepare(`SELECT * FROM "${table}" ORDER BY rowid`)
            .all()
            .map((row) => ({ ...row })),
        ]),
      ),
    };
  });
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 같은 내용의 파일을 두 가지로 준비한다. 하나는 예전 원장이 열어 둔 WAL 모드의 파일이고,
 * 다른 하나는 그것을 SQLite로 백업한 복사본(`VACUUM INTO`)이다. 복사본은 WAL 모드가 아니다.
 */
function oldFileAndBackup(t: TestContext, version: number, sql: string): [string, string][] {
  const dir = makeTempDir(t);
  const original = join(dir, "ledger.sqlite");
  const backup = join(dir, "backup.sqlite");
  writeOldFile(original, version, sql);
  const raw = new DatabaseSync(original);
  raw.exec(`VACUUM INTO '${backup}'`);
  raw.close();
  assert.equal(journalMode(original), "wal");
  assert.equal(journalMode(backup), "delete");
  return [
    ["WAL 모드의 파일", original],
    ["백업한 복사본", backup],
  ];
}

/** 열기를 거부하고, 파일의 저널 모드, 버전, 스키마, 줄이 그대로인지 확인한다. */
function assertRejectedUntouched(path: string, code: LedgerError["code"], label: string): void {
  const before = fileState(path);
  const hashBefore = sha256(path);

  assert.throws(
    () => openLedger({ path }),
    (error) => error instanceof LedgerError && error.code === code,
    label,
  );

  assert.deepEqual(fileState(path), before, label);
  // 읽기만 했으므로 파일의 바이트도 그대로다.
  assert.equal(sha256(path), hashBefore, label);
}

test("S29: 버전 2의 파일에 새 형태로 옮길 수 없는 시각이 있으면 올리지 않고 오류를 내며 파일은 그대로다", (t) => {
  // 예전 시계는 Date.toISOString()을 그대로 저장했다. 연도가 네 자리를 벗어난 유효한 Date는 이렇게 적힌다.
  const farFuture = new Date(Date.UTC(10_000, 0, 1)).toISOString();
  assert.equal(farFuture, "+010000-01-01T00:00:00.000Z");
  const triage: Actor = { kind: "assistant", module: "intake-triage" };
  const files: Record<string, string> = {
    "요청의 접수 시각": `${VERSION_2_SCHEMA}
      INSERT INTO requests (id, title, created_at) VALUES
        ('req-ok', '보통 요청', '2026-03-02T09:00:00.123Z'),
        ('req-far', '먼 미래의 요청', '${farFuture}');
      ${oldChangeSql("2026-03-02T09:00:00.123Z", user, "req-ok", "보통 요청")}
      ${oldChangeSql("2026-03-02T09:00:01.000Z", user, "req-far", "먼 미래의 요청")}`,
    "변경 이력의 시각": `${VERSION_2_SCHEMA}
      INSERT INTO requests (id, title, created_at) VALUES
        ('req-ok', '보통 요청', '2026-03-02T09:00:00.123Z');
      ${oldChangeSql("2026-03-02T09:00:00.123Z", user, "req-ok", "보통 요청")}
      ${oldChangeSql(farFuture, triage, "req-gone", "요청 줄이 없는 변경")}`,
    "밀리초가 없는 시각": `${VERSION_2_SCHEMA}
      INSERT INTO requests (id, title, created_at) VALUES
        ('req-odd', '형태가 다른 시각', '2026-03-02T09:00:00Z');
      ${oldChangeSql("2026-03-02T09:00:00.123Z", user, "req-odd", "형태가 다른 시각")}`,
  };

  for (const [where, sql] of Object.entries(files)) {
    // 저널 모드도 바꾸지 않는다. WAL 모드의 파일과 WAL이 아닌 백업 복사본 둘 다 그대로다.
    for (const [kind, path] of oldFileAndBackup(t, 2, sql)) {
      assertRejectedUntouched(path, "unmigratable_time", `${where}, ${kind}`);
      assert.equal(userVersion(path), 2);
    }
  }
});

test("S29: 자릿수는 맞지만 달력에 없는 시각이 있는 파일도 올리지 않는다", (t) => {
  // 자릿수만 보면 밀리초 형태다. 시각으로 읽을 수 없거나, 읽으면 다른 날이 되는 값이다.
  const notOnCalendar = [
    "2026-02-31T10:00:00.000Z",
    "2026-02-29T10:00:00.000Z",
    "2026-04-31T00:00:00.000Z",
    "2026-13-01T00:00:00.000Z",
    "2026-00-10T00:00:00.000Z",
    "2026-03-00T00:00:00.000Z",
    "2026-03-02T24:00:00.000Z",
    "2026-03-02T09:60:00.000Z",
    "2026-03-02T09:00:60.000Z",
  ];
  for (const at of notOnCalendar) {
    for (const column of ["requests.created_at", "changes.at"]) {
      const inRequest = column === "requests.created_at";
      const sql = `${VERSION_2_SCHEMA}
        INSERT INTO requests (id, title, created_at) VALUES
          ('req-1', '달력에 없는 시각', '${inRequest ? at : "2026-03-02T09:00:00.000Z"}');
        ${oldChangeSql(inRequest ? "2026-03-02T09:00:00.000Z" : at, user, "req-1", "달력에 없는 시각")}`;
      for (const [kind, path] of oldFileAndBackup(t, 2, sql)) {
        assertRejectedUntouched(path, "unmigratable_time", `${at}, ${column}, ${kind}`);
      }
    }
  }
});

test("S29: 달력에 있는 시각은 경계에 있어도 같은 시각으로 옮겨진다", (t) => {
  const onCalendar = [
    "0000-01-01T00:00:00.000Z",
    "2028-02-29T23:59:59.999Z",
    "2026-12-31T23:59:59.999Z",
    "9999-12-31T23:59:59.999Z",
  ];
  const path = join(makeTempDir(t), "ledger.sqlite");
  writeOldFile(
    path,
    2,
    `${VERSION_2_SCHEMA}
     ${onCalendar
       .map(
         (at, index) => `INSERT INTO requests (id, title, created_at)
                           VALUES ('req-${index}', '경계의 시각', '${at}');
                         ${oldChangeSql(at, user, `req-${index}`, "경계의 시각")}`,
       )
       .join("\n")}`,
  );

  const ledger = openLedger({ path });
  t.after(() => ledger.close());

  const moved = onCalendar.map((at) => `${at.slice(0, 23)}000Z`);
  assert.deepEqual(
    ledger.changesSince(0).map((change) => change.at),
    moved,
  );
  assert.deepEqual(
    onCalendar.map((_, index) => ledger.getRequest(`req-${index}`).createdAt),
    moved,
  );
});

test("S29: 버전이 너무 높거나 올바르지 않은 파일도 저널 모드를 포함해 아무것도 바꾸지 않고 거부한다", (t) => {
  const content = `${VERSION_2_SCHEMA}
    INSERT INTO requests (id, title, created_at) VALUES
      ('req-1', '다른 프로그램이 쓴 요청', '2026-03-02T09:00:00.123Z');
    ${oldChangeSql("2026-03-02T09:00:00.123Z", user, "req-1", "다른 프로그램이 쓴 요청")}`;

  for (const [kind, path] of oldFileAndBackup(t, MIGRATIONS.length + 1, content)) {
    assertRejectedUntouched(path, "schema_version_too_new", kind);
  }
  for (const [kind, path] of oldFileAndBackup(t, -1, content)) {
    assertRejectedUntouched(path, "schema_version_invalid", kind);
  }
});

test("마이그레이션의 사전 확인은 쓰기 잠금 안에서, 밀린 것을 하나도 적용하기 전에 한 번 한다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  openLedger({ path }).close();
  const calls: { inTransaction: boolean; earlierApplied: boolean }[] = [];
  const earlier: Migration = {
    name: "probe_earlier",
    sql: "CREATE TABLE probe_earlier (id TEXT) STRICT;",
  };
  const checked: Migration = {
    name: "probe_checked",
    sql: "CREATE TABLE probe_checked (id TEXT) STRICT;",
    check: (db) => {
      calls.push({
        inTransaction: db.isTransaction,
        earlierApplied:
          db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'probe_earlier'").get() !==
          undefined,
      });
    },
  };

  openDb(path, { migrations: [...MIGRATIONS, earlier, checked] }).close();

  // 잠금 없이 미리 확인하지 않는다. 쓰기 잠금 안에서 한 번, 앞선 마이그레이션도 적용하기 전이다.
  assert.deepEqual(calls, [{ inTransaction: true, earlierApplied: false }]);
  assert.equal(userVersion(path), MIGRATIONS.length + 2);
  // 이미 올라간 파일을 다시 열면 확인하지 않는다.
  openDb(path, { migrations: [...MIGRATIONS, earlier, checked] }).close();
  assert.equal(calls.length, 1);
});

test("S29: 사전 확인에 걸리면 앞선 마이그레이션도 적용하지 않아, WAL이 아닌 파일도 저널 모드와 바이트까지 그대로다", (t) => {
  const refusing: Migration[] = [
    { name: "probe_earlier", sql: "CREATE TABLE probe_earlier (id TEXT) STRICT;" },
    {
      name: "probe_refusing",
      sql: "CREATE TABLE probe_refusing (id TEXT) STRICT;",
      check: () => {
        throw new LedgerError("unmigratable_time", "옮길 수 없는 데이터가 있다");
      },
    },
  ];
  const dir = makeTempDir(t);
  const inWal = join(dir, "wal.sqlite");
  openLedger({ path: inWal }).close();
  const withoutWal = join(dir, "backup.sqlite");
  createCurrentFileWithoutWal(withoutWal);

  for (const [path, mode] of [
    [inWal, "wal"],
    [withoutWal, "delete"],
  ] as const) {
    const before = fileState(path);
    const hashBefore = sha256(path);
    assert.equal(journalMode(path), mode);

    assert.throws(
      () => openDb(path, { migrations: [...MIGRATIONS, ...refusing] }),
      (error) => error instanceof LedgerError && error.code === "unmigratable_time",
    );

    assert.deepEqual(fileState(path), before, mode);
    assert.equal(sha256(path), hashBefore, mode);
  }
});

/** 테스트가 바꾸기 전의 SQLite 함수. 바꾼 테스트는 끝날 때 이 함수로 되돌려 놓아야 한다. */
const ORIGINAL_EXEC = DatabaseSync.prototype.exec;
const ORIGINAL_PREPARE = DatabaseSync.prototype.prepare;

/** 테스트가 끝난 뒤 SQLite 함수가 원래 함수로 돌아와 있는지 확인한다. */
function assertSqliteRestoredAfter(t: TestContext): void {
  t.after(() => {
    assert.equal(DatabaseSync.prototype.exec, ORIGINAL_EXEC);
    assert.equal(DatabaseSync.prototype.prepare, ORIGINAL_PREPARE);
  });
}

/**
 * `body`를 실행하는 동안, 원장이 `nth`번째로 쓰기 잠금을 잡으려는 순간에 `meanwhile`을 한 번 끼워 넣는다.
 * `body`가 끝나면(오류로 끝나도) 바로 원래 함수로 되돌린다. 끼워 넣은 횟수를 돌려준다.
 */
function racingBeforeWriteLock(meanwhile: () => void, body: () => void, nth = 1): number {
  let attempts = 0;
  let raced = 0;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql === "BEGIN IMMEDIATE") {
      attempts += 1;
      if (attempts === nth) {
        raced += 1;
        meanwhile();
      }
    }
    return ORIGINAL_EXEC.call(this, sql);
  };
  try {
    body();
  } finally {
    DatabaseSync.prototype.exec = ORIGINAL_EXEC;
  }
  return raced;
}

/** 다른 프로세스에서 스크립트를 실행하고 표준 출력을 돌려준다. */
function runInAnotherProcess(lines: readonly string[]): string {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", lines.join("\n")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** 다른 프로세스에서 원장을 열었다 닫는다. 예전 버전이면 그 프로세스가 올리기를 끝낸다. */
function openInAnotherProcess(path: string): void {
  runInAnotherProcess([
    `import { openLedger } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};`,
    `openLedger({ path: ${JSON.stringify(path)} }).close();`,
  ]);
}

test("S29: 정상인 예전 파일을 두 프로세스가 열 때 한쪽이 먼저 올리기를 끝내도 둘 다 성공한다", (t) => {
  assertSqliteRestoredAfter(t);
  const triage: Actor = { kind: "assistant", module: "intake-triage" };
  const changes =
    oldChangeSql("2026-03-02T09:00:00.123Z", user, "req-by-user", "사용자가 등록한 요청") +
    oldChangeSql("2026-03-02T09:05:00.000Z", triage, "req-by-assistant", "비서가 등록한 요청");
  const files: Record<number, string> = {
    1: VERSION_1_SCHEMA + changes,
    2: `${VERSION_2_SCHEMA}
        INSERT INTO requests (id, title, created_at) VALUES
          ('req-by-user', '사용자가 등록한 요청', '2026-03-02T09:00:00.123Z'),
          ('req-by-assistant', '비서가 등록한 요청', '2026-03-02T09:05:00.000Z');
        ${changes}`,
  };

  for (const version of [1, 2]) {
    for (const [kind, path] of oldFileAndBackup(t, version, files[version] as string)) {
      const label = `버전 ${version}, ${kind}`;
      // 이쪽이 예전 버전임을 읽고 쓰기 잠금을 잡으려는 순간, 다른 프로세스가 같은 파일을 열어 올리기를 끝낸다.
      let opened: ReturnType<typeof openLedger> | undefined;
      const raced = racingBeforeWriteLock(
        () => {
          assert.equal(userVersion(path), version, label);
          openInAnotherProcess(path);
          assert.equal(userVersion(path), MIGRATIONS.length, label);
        },
        () => {
          opened = openLedger({ path, clock: fixedClock, newId: () => `new-${version}-${kind}` });
        },
      );
      const ledger = opened as ReturnType<typeof openLedger>;
      t.after(() => ledger.close());

      // 다른 프로세스가 먼저 끝냈고, 이쪽도 거부되지 않고 열렸다.
      assert.equal(raced, 1, label);
      assert.equal(userVersion(path), MIGRATIONS.length, label);
      assert.equal(journalMode(path), "wal", label);
      // 한 번만 올라갔다. 이미 옮겨진 시각을 다시 옮기거나 예전 형태가 아니라고 거부하지 않는다.
      assert.deepEqual(
        ledger.changesSince(0).map((change) => [change.seq, change.writeSeq, change.at]),
        [
          [1, 1, "2026-03-02T09:00:00.123000Z"],
          [2, 2, "2026-03-02T09:05:00.000000Z"],
        ],
        label,
      );
      if (version === 2) {
        const byUser = ledger.getRequest("req-by-user");
        assert.equal(byUser.createdAt, "2026-03-02T09:00:00.123000Z", label);
        assert.deepEqual(
          [byUser.title.setBy, byUser.title.userSetAt],
          ["user", "2026-03-02T09:00:00.123000Z"],
          label,
        );
      }
      // 올라간 파일에 이어서 쓸 수 있다.
      ledger.createRequest(user, { stated: { title: "함께 연 뒤의 요청" } });
      assert.equal(ledger.changesSince(0).at(-1)?.seq, 3, label);
    }
  }
});

test("S29: 예전 파일을 여는 사이에 다른 프로세스가 옮길 수 없는 시각을 써 넣으면, 잠금 안의 확인에서 거부하고 그 파일을 그대로 둔다", (t) => {
  assertSqliteRestoredAfter(t);
  const valid = `${VERSION_2_SCHEMA}
    INSERT INTO requests (id, title, created_at) VALUES
      ('req-1', '보통 요청', '2026-03-02T09:00:00.123Z');
    ${oldChangeSql("2026-03-02T09:00:00.123Z", user, "req-1", "보통 요청")}`;

  for (const [kind, path] of oldFileAndBackup(t, 2, valid)) {
    const modeBefore = journalMode(path);
    let afterOther: { state: unknown; hash: string } | undefined;
    // 이쪽이 잠금을 잡기 직전에, 다른 SQLite 프로세스가 지금 저널 모드 그대로 시각 하나를 바꿔 커밋한다.
    const raced = racingBeforeWriteLock(
      () => {
        const script = [
          'import { DatabaseSync } from "node:sqlite";',
          `const db = new DatabaseSync(${JSON.stringify(path)});`,
          "db.exec(\"UPDATE requests SET created_at = '+010000-01-01T00:00:00.000Z'\");",
          "db.close();",
        ].join("\n");
        const other = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
          encoding: "utf8",
        });
        assert.equal(other.status, 0, other.stderr);
        // 비교의 기준은 다른 프로세스가 쓴 뒤의 파일이다.
        afterOther = { state: fileState(path), hash: sha256(path) };
      },
      () => {
        assert.throws(
          () => openLedger({ path }),
          (error) => error instanceof LedgerError && error.code === "unmigratable_time",
          kind,
        );
      },
    );

    assert.equal(raced, 1, kind);
    // 저널 모드, 버전, 스키마, 줄이 모두 다른 프로세스가 남긴 그대로다.
    assert.equal(journalMode(path), modeBefore, kind);
    assert.equal(userVersion(path), 2, kind);
    assert.deepEqual(fileState(path), afterOther?.state, kind);
    if (modeBefore === "delete") {
      // WAL이 아닌 파일은 바이트도 그대로다. WAL 모드의 파일은 다른 프로세스가 커밋한 내용이
      // 마지막 연결이 닫힐 때 본 파일로 옮겨지므로(체크포인트) 바이트로는 비교하지 않는다.
      assert.equal(sha256(path), afterOther?.hash, kind);
    }
  }
});

/** 요청 하나가 든 최신 버전의 원장을 SQLite로 백업한 복사본을 만든다. WAL 모드가 아니다. */
function currentBackupWithOneRequest(t: TestContext): string {
  const dir = makeTempDir(t);
  const original = join(dir, "ledger.sqlite");
  const ledger = openLedger({ path: original, clock: fixedClock, newId: () => "req-existing" });
  ledger.createRequest(user, { stated: { title: "먼저 있던 요청" } });
  ledger.close();
  const backup = join(dir, "backup.sqlite");
  const raw = new DatabaseSync(original);
  raw.exec(`VACUUM INTO '${backup}'`);
  raw.close();
  assert.deepEqual([journalMode(backup), userVersion(backup)], ["delete", MIGRATIONS.length]);
  return backup;
}

/** 시험용으로 마이그레이션 하나를 더한 다음 버전의 프로그램. 이 프로그램보다 한 버전 높다. */
const NEXT_VERSION_SQL =
  "CREATE TABLE next_version (note TEXT) STRICT; INSERT INTO next_version VALUES ('다음 버전이 쓴 줄');";

/** 다른 프로세스에서 다음 버전의 프로그램이 파일을 열어 올린다. `leaveWithoutWal`이면 WAL로 바꾸지 않고 남긴다. */
function upgradeInAnotherProcess(path: string, leaveWithoutWal: boolean): void {
  const next = MIGRATIONS.length + 1;
  if (leaveWithoutWal) {
    // 올리기만 하고 저널 모드는 건드리지 않는 프로그램이다.
    runInAnotherProcess([
      'import { DatabaseSync } from "node:sqlite";',
      `const db = new DatabaseSync(${JSON.stringify(path)});`,
      `db.exec(${JSON.stringify(`BEGIN IMMEDIATE; ${NEXT_VERSION_SQL} PRAGMA user_version = ${next}; COMMIT;`)});`,
      "db.close();",
    ]);
  } else {
    // 원장의 여는 순서 그대로, 올린 뒤 WAL로 바꾸는 프로그램이다.
    runInAnotherProcess([
      `import { openDb } from ${JSON.stringify(new URL("./db.ts", import.meta.url).href)};`,
      `import { MIGRATIONS } from ${JSON.stringify(new URL("./migrations.ts", import.meta.url).href)};`,
      `const next = { name: "다음 버전", sql: ${JSON.stringify(NEXT_VERSION_SQL)} };`,
      `openDb(${JSON.stringify(path)}, { migrations: [...MIGRATIONS, next] }).close();`,
    ]);
  }
}

function requestCount(path: string): unknown {
  return inspect(path, (raw) => raw.prepare("SELECT count(*) AS count FROM requests").get()?.count);
}

function isTooNew(error: unknown): boolean {
  return error instanceof LedgerError && error.code === "schema_version_too_new";
}

test("S29: WAL로 바꾸기를 기다리는 사이에 다른 프로그램이 더 높은 버전으로 올리면 열지 않고, 저널 모드도 쓰기도 건드리지 않는다", (t) => {
  assertSqliteRestoredAfter(t);
  for (const leaveWithoutWal of [false, true]) {
    const label = leaveWithoutWal ? "상대가 WAL이 아닌 채로 남김" : "상대가 WAL까지 바꿈";
    const path = currentBackupWithOneRequest(t);
    let afterOther: { state: unknown; hash: string } | undefined;

    // 이쪽은 최신 버전임을 읽었고 WAL로 바꾸려고 쓰기 잠금을 잡으려 한다.
    // 그 순간 다음 버전의 프로그램이 같은 파일을 올리고 끝낸다.
    const raced = racingBeforeWriteLock(
      () => {
        upgradeInAnotherProcess(path, leaveWithoutWal);
        afterOther = { state: fileState(path), hash: sha256(path) };
      },
      () => {
        assert.throws(() => openLedger({ path }), isTooNew, label);
      },
    );

    assert.equal(raced, 1, label);
    // 쓸 수 있는 원장을 받지 못했고, 요청이 늘지 않았다.
    assert.equal(requestCount(path), 1, label);
    assert.equal(userVersion(path), MIGRATIONS.length + 1, label);
    // 상대가 남긴 저널 모드 그대로다.
    assert.equal(journalMode(path), leaveWithoutWal ? "delete" : "wal", label);
    assert.deepEqual(fileState(path), afterOther?.state, label);
    if (leaveWithoutWal) {
      // WAL이 아닌 파일은 바이트도 상대가 남긴 그대로다.
      assert.equal(sha256(path), afterOther?.hash, label);
    }
    // 다시 열어도 거부한다.
    assert.throws(() => openLedger({ path }), isTooNew, label);
    assert.equal(journalMode(path), leaveWithoutWal ? "delete" : "wal", label);
  }
});

test("S29: 버전을 확인하고 WAL로 바꾸는 사이에는 다른 프로그램이 쓰기 잠금을 잡을 수 없어 버전을 올리지 못한다", (t) => {
  assertSqliteRestoredAfter(t);
  const path = currentBackupWithOneRequest(t);
  const attempts: string[] = [];
  // 이쪽이 저널 모드를 바꾸려는 바로 그 순간에, 다른 프로세스가 기다리지 않고 쓰기 잠금을 잡아 본다.
  DatabaseSync.prototype.prepare = function (sql, ...rest) {
    if (sql === "PRAGMA journal_mode = WAL") {
      attempts.push(
        runInAnotherProcess([
          'import { DatabaseSync } from "node:sqlite";',
          `const db = new DatabaseSync(${JSON.stringify(path)}, { timeout: 0 });`,
          "try {",
          `  db.exec("BEGIN IMMEDIATE; PRAGMA user_version = ${MIGRATIONS.length + 1}; COMMIT;");`,
          '  console.log("upgraded");',
          "} catch (error) {",
          '  console.log((error.errcode & 0xff) === 5 ? "busy" : String(error));',
          "}",
          "db.close();",
        ]),
      );
    }
    return ORIGINAL_PREPARE.call(this, sql, ...rest);
  };
  let db: DatabaseSync;
  try {
    db = openDb(path);
  } finally {
    DatabaseSync.prototype.prepare = ORIGINAL_PREPARE;
  }
  t.after(() => db.close());

  // 저널 모드를 바꾸는 시점의 버전은 잠금 안에서 확인한 그 버전이다.
  assert.deepEqual(attempts, ["busy"]);
  assert.deepEqual([userVersion(path), journalMode(path)], [MIGRATIONS.length, "wal"]);
  assert.equal(changesSince(db, 0).length, 1);
});

test("S29: WAL로 바꾼 직후에 다른 프로그램이 더 높은 버전으로 올려도 쓸 수 있는 원장을 돌려주지 않는다", (t) => {
  assertSqliteRestoredAfter(t);
  const path = currentBackupWithOneRequest(t);
  let converted = false;
  let raced = 0;
  // 이쪽이 최신 버전임을 잠금 안에서 확인하고 WAL로 바꾼 뒤, 다시 열어 버전을 읽으려는 순간에 상대가 올린다.
  DatabaseSync.prototype.prepare = function (sql, ...rest) {
    if (sql === "PRAGMA journal_mode = WAL") {
      converted = true;
    } else if (converted && raced === 0 && sql === "PRAGMA user_version") {
      raced += 1;
      upgradeInAnotherProcess(path, false);
    }
    return ORIGINAL_PREPARE.call(this, sql, ...rest);
  };
  try {
    assert.throws(() => openLedger({ path }), isTooNew);
  } finally {
    DatabaseSync.prototype.prepare = ORIGINAL_PREPARE;
  }

  assert.equal(raced, 1);
  assert.equal(requestCount(path), 1);
  // WAL로 바꾼 것은 파일이 이 프로그램의 버전일 때였다. 그 뒤로는 아무것도 건드리지 않았다.
  assert.deepEqual([userVersion(path), journalMode(path)], [MIGRATIONS.length + 1, "wal"]);
});

test("S29: 이미 WAL인 최신 파일도 돌려주기 직전에 버전을 다시 읽어, 그사이에 올라갔으면 열지 않는다", (t) => {
  assertSqliteRestoredAfter(t);
  const path = join(makeTempDir(t), "ledger.sqlite");
  const first = openLedger({ path, clock: fixedClock });
  first.createRequest(user, { stated: { title: "먼저 있던 요청" } });
  first.close();
  let raced = 0;
  // 이쪽이 최신 버전임을 읽고 저널 모드를 확인하려는 순간에 다음 버전의 프로그램이 올린다.
  DatabaseSync.prototype.prepare = function (sql, ...rest) {
    if (raced === 0 && sql === "PRAGMA journal_mode") {
      raced += 1;
      upgradeInAnotherProcess(path, false);
    }
    return ORIGINAL_PREPARE.call(this, sql, ...rest);
  };
  try {
    assert.throws(() => openLedger({ path }), isTooNew);
  } finally {
    DatabaseSync.prototype.prepare = ORIGINAL_PREPARE;
  }

  assert.equal(raced, 1);
  assert.equal(requestCount(path), 1);
  assert.deepEqual([userVersion(path), journalMode(path)], [MIGRATIONS.length + 1, "wal"]);
});

test("S29: 원장을 연 뒤에 다른 프로그램이 파일을 더 높은 버전으로 올리면, 이미 연 원장의 쓰기는 거부되고 아무것도 쓰지 않는다. 읽기는 된다", (t) => {
  const triage: Actor = { kind: "assistant", module: "intake-triage" };
  for (const leaveWithoutWal of [false, true]) {
    const label = leaveWithoutWal ? "상대가 올리기만 함" : "상대가 원장의 여는 순서대로 올림";
    const path = join(makeTempDir(t), "ledger.sqlite");
    let count = 0;
    const ledger = openLedger({
      path,
      clock: fixedClock,
      newId: () => {
        count += 1;
        return `id-${count}`;
      },
    });
    t.after(() => ledger.close());

    // 올리기 전의 쓰기는 정상이다.
    const { id: requestId } = ledger.createRequest(triage, {
      decided: { title: "올리기 전에 등록한 요청", urgency: "low" },
    });
    const { id: taskId } = ledger.addTask(triage, { requestId, work: "올리기 전에 더한 작업" });
    const item = ledger.raiseOpenItem(triage, {
      requestId,
      kind: "question",
      content: "급한가요?",
    });
    const revision = ledger.addRevision(triage, {
      source: "jira",
      sourceId: "VOC-1",
      originalAt: "2026-03-02T08:00:00Z",
      body: "티켓",
    });
    const notice = ledger.addNotice(triage, {
      requestId,
      kind: "my_turn",
      content: "확인해 주세요",
    });
    const material = ledger.attachMaterial(triage, {
      requestId,
      title: "올리기 전에 붙인 자료",
      content: "올리기 전의 내용",
    });
    const before = {
      request: ledger.getRequest(requestId),
      changes: ledger.changesSince(0),
      notices: ledger.listNotices(),
      rows: fileState(path),
    };
    assert.equal(before.changes.length, 6, label);

    // 원장을 열어 둔 채로 다음 버전의 프로그램이 같은 파일을 올린다.
    upgradeInAnotherProcess(path, leaveWithoutWal);
    assert.equal(userVersion(path), MIGRATIONS.length + 1, label);
    const afterUpgrade = fileState(path);

    // 이미 연 원장의 쓰기는 모두 거부된다.
    const writes: [string, () => unknown][] = [
      ["createRequest", () => ledger.createRequest(user, { stated: { title: "올린 뒤의 요청" } })],
      ["updateRequest", () => ledger.updateRequest(user, { requestId, title: "올린 뒤의 제목" })],
      ["setPriority", () => ledger.setPriority(user, { requestId, urgency: "high" })],
      ["addTask", () => ledger.addTask(triage, { requestId, work: "올린 뒤의 작업" })],
      ["updateTask", () => ledger.updateTask(user, { taskId, status: "in_progress" })],
      ["completeTask", () => ledger.completeTask(user, { taskId })],
      ["cancelTask", () => ledger.cancelTask(user, { taskId })],
      [
        "addRevision",
        () =>
          ledger.addRevision(triage, {
            source: "jira",
            sourceId: "VOC-1",
            originalAt: "2026-03-02T08:30:00Z",
            body: "바뀐 티켓",
          }),
      ],
      [
        "linkRecord",
        () => ledger.linkRecord(triage, { recordId: revision.recordId, requestId, role: "intake" }),
      ],
      [
        "raiseOpenItem",
        () =>
          ledger.raiseOpenItem(triage, { requestId, kind: "approval", content: "해도 될까요?" }),
      ],
      [
        // 답하면서 값을 바꾸는 쓰기처럼 여러 건을 남기는 쓰기도 통째로 거부된다.
        "resolveOpenItem",
        () =>
          ledger.resolveOpenItem(user, {
            openItemId: item.id,
            answer: "급하다",
            changes: [
              { action: "setPriority", input: { requestId, urgency: "high" } },
              { action: "completeTask", input: { taskId } },
            ],
          }),
      ],
      ["addNotice", () => ledger.addNotice(triage, { requestId, kind: "closed", content: "닫힘" })],
      ["markNoticeDelivered", () => ledger.markNoticeDelivered(triage, { noticeId: notice.id })],
      ["markNoticeSeen", () => ledger.markNoticeSeen(user, { noticeId: notice.id })],
      [
        "attachMaterial",
        () => ledger.attachMaterial(triage, { requestId, title: "자료", content: "내용" }),
      ],
      [
        "replaceMaterial",
        () =>
          ledger.replaceMaterial(triage, { materialId: material.id, content: "올린 뒤의 내용" }),
      ],
      ["setProgress", () => ledger.setProgress(triage, { requestId, progress: "조사 중" })],
    ];
    // 이 표는 원장의 공개 쓰기를 빠짐없이 담는다. 쓰기가 늘면 여기서 드러난다.
    const reads = ["getRequest", "changesSince", "listNotices", "close"];
    assert.deepEqual(
      writes.map(([name]) => name).toSorted(),
      Object.keys(ledger)
        .filter((name) => !reads.includes(name))
        .toSorted(),
      label,
    );
    for (const [name, attempt] of writes) {
      assert.throws(attempt, isTooNew, `${label}, ${name}`);
    }

    // 요청과 변경 이력이 늘지 않았고, 파일은 상대가 올린 뒤 그대로다.
    assert.equal(requestCount(path), 1, label);
    assert.deepEqual(fileState(path), afterUpgrade, label);
    // 읽기는 된다. 올리기 전에 쓴 것이 그대로 나온다.
    assert.deepEqual(ledger.changesSince(0), before.changes, label);
    assert.deepEqual(ledger.getRequest(requestId), before.request, label);
    assert.deepEqual(ledger.listNotices(), before.notices, label);
    assert.equal(ledger.getRequest(requestId).openItems[0]?.resolved, false, label);
    // 쓰기 트랜잭션이 남아 있지 않아, 다음 버전의 프로그램은 이어서 쓸 수 있다.
    const next = new DatabaseSync(path);
    next.exec("INSERT INTO next_version VALUES ('거부된 뒤에 다음 버전이 쓴 줄')");
    next.close();
  }
});

test("S29: 이미 연 원장의 쓰기가 쓰기 잠금을 잡으려는 사이에 다른 프로그램이 올리기를 커밋하면, 그 쓰기는 거부되고 아무것도 쓰지 않는다", (t) => {
  assertSqliteRestoredAfter(t);
  for (const leaveWithoutWal of [false, true]) {
    const label = leaveWithoutWal ? "상대가 올리기만 함" : "상대가 원장의 여는 순서대로 올림";
    const path = join(makeTempDir(t), "ledger.sqlite");
    const ledger = openLedger({ path, clock: fixedClock });
    t.after(() => ledger.close());
    const { id } = ledger.createRequest(user, { stated: { title: "올리기 전에 등록한 요청" } });
    const changeCount = () =>
      inspect(path, (raw) => raw.prepare("SELECT count(*) AS count FROM changes").get()?.count);

    // 쓰기를 시작할 때 파일은 아직 이 프로그램의 버전이다. 쓰기 잠금을 잡으려는 순간에 상대가 올리기를 커밋한다.
    // 버전을 쓰기 잠금 안에서 읽어야 이 순서에서 거부된다.
    const raced = racingBeforeWriteLock(
      () => {
        assert.equal(userVersion(path), MIGRATIONS.length, label);
        upgradeInAnotherProcess(path, leaveWithoutWal);
        assert.equal(userVersion(path), MIGRATIONS.length + 1, label);
      },
      () => {
        assert.throws(
          () => ledger.createRequest(user, { stated: { title: "잠금을 기다리다 쓴 요청" } }),
          isTooNew,
          label,
        );
      },
    );

    assert.equal(raced, 1, label);
    // 요청과 변경 이력이 늘지 않았다.
    assert.equal(requestCount(path), 1, label);
    assert.equal(changeCount(), 1, label);
    assert.equal(userVersion(path), MIGRATIONS.length + 1, label);
    // 읽기는 된다.
    assert.equal(ledger.getRequest(id).title.value, "올리기 전에 등록한 요청", label);
    assert.equal(ledger.changesSince(0).length, 1, label);
  }
});

/** 원장이 닫은 직후의 파일을 다른 SQLite 연결이 롤백 저널 모드로 되돌린다. */
function revertToRollbackJournal(path: string): void {
  const raw = new DatabaseSync(path);
  try {
    ORIGINAL_EXEC.call(raw, "PRAGMA journal_mode = DELETE");
  } finally {
    raw.close();
  }
}

test("WAL로 바꾸는 일을 처음부터 다시 하게 돼도 한 번 여는 동안의 대기 한도는 새로 잡지 않는다", (t) => {
  assertSqliteRestoredAfter(t);
  const budgetMs = 800;
  // 한 회차에서 읽는 연결이 빠지기까지의 커밋 시도 횟수. 실패한 시도마다 10ms를 쉬므로 한 회차에 440ms 넘게 걸린다.
  // 한 회차는 한도 안이지만 두 회차를 합치면 한도를 넘는다.
  const attemptsUntilReaderLeaves = 45;

  for (const secondRound of ["읽는 연결 때문에 다시 시도", "쓰기 잠금을 기다림"] as const) {
    const path = join(makeTempDir(t), "ledger.sqlite");
    createCurrentFileWithoutWal(path);
    const reader = new DatabaseSync(path);
    const blocker = new DatabaseSync(path);
    t.after(() => {
      reader.close();
      blocker.close();
    });
    let round = 0;
    let commitAttempts = 0;
    let connections = 0;
    let readerHolds = false;
    const releaseReader = () => {
      if (readerHolds) {
        readerHolds = false;
        ORIGINAL_EXEC.call(reader, "ROLLBACK");
      }
    };
    DatabaseSync.prototype.exec = function (sql) {
      if (sql === "PRAGMA foreign_keys = ON") {
        connections += 1;
        if (connections === 2) {
          // 첫 전환에 성공해 연결을 닫고 다시 여는 사이에, 다른 프로그램이 저널 모드를 되돌린다.
          revertToRollbackJournal(path);
          if (secondRound === "쓰기 잠금을 기다림") {
            ORIGINAL_EXEC.call(blocker, "BEGIN IMMEDIATE");
          }
        }
      } else if (sql === "BEGIN IMMEDIATE") {
        round += 1;
        commitAttempts = 0;
        if (round === 1 || secondRound === "읽는 연결 때문에 다시 시도") {
          // 이 회차가 쓰기 잠금을 잡기 직전에 다른 연결이 읽기 시작한다.
          ORIGINAL_EXEC.call(reader, "BEGIN; SELECT count(*) FROM requests;");
          readerHolds = true;
        }
      } else if (sql === "COMMIT") {
        commitAttempts += 1;
        if (commitAttempts === attemptsUntilReaderLeaves) {
          releaseReader();
        }
      }
      return ORIGINAL_EXEC.call(this, sql);
    };
    let elapsedMs = 0;
    try {
      const startedAt = performance.now();
      assert.throws(
        () => openDb(path, { busyTimeoutMs: budgetMs }),
        (error) => (error as { errcode?: number }).errcode === 5,
        secondRound,
      );
      elapsedMs = performance.now() - startedAt;
    } finally {
      DatabaseSync.prototype.exec = ORIGINAL_EXEC;
    }

    // 첫 회차는 한도 안에 끝나 WAL로 바꿨고, 두 번째 회차에서 남은 한도가 다해 잠금 오류로 끝났다.
    assert.equal(round, 2, secondRound);
    assert.equal(connections, 2, secondRound);
    // 두 회차가 기다린 시간을 합쳐 한도를 넘지 않는다. 회차마다 한도를 새로 잡았다면 두 번째 회차도 끝까지 기다린다.
    assert.ok(elapsedMs >= budgetMs - 20, `${secondRound}: ${elapsedMs.toFixed(0)}ms 만에 끝났다`);
    assert.ok(elapsedMs < budgetMs + 250, `${secondRound}: ${elapsedMs.toFixed(0)}ms가 걸렸다`);
    releaseReader();
    if (blocker.isTransaction) {
      ORIGINAL_EXEC.call(blocker, "ROLLBACK");
    }
    // 파일은 상대가 되돌린 저널 모드 그대로이고, 잠금이 풀린 뒤에는 열린다.
    assert.deepEqual([userVersion(path), journalMode(path)], [MIGRATIONS.length, "delete"]);
    assert.equal(existsSync(`${path}-journal`), false, secondRound);
    openDb(path).close();
    assert.equal(journalMode(path), "wal", secondRound);
  }
});

test("S29: 다른 프로그램이 저널 모드만 계속 되돌려 끝낼 수 없는 것과, 마지막 회차에 더 높은 버전을 읽은 것은 오류 코드가 다르다", (t) => {
  assertSqliteRestoredAfter(t);
  const rounds = 8;
  const cases = [
    "저널 모드만 계속 바뀜",
    "마지막 회차의 쓰기 잠금 안에서 더 높은 버전을 읽음",
    "마지막 회차의 돌려주기 직전에 더 높은 버전을 읽음",
  ] as const;

  for (const label of cases) {
    const path = currentBackupWithOneRequest(t);
    let connections = 0;
    let lockAttempts = 0;
    let reverted = 0;
    let upgradeBeforeFinalRead = false;
    DatabaseSync.prototype.exec = function (sql) {
      if (sql === "PRAGMA foreign_keys = ON") {
        connections += 1;
        if (label === cases[2] && connections === rounds) {
          // 일곱 번째로 WAL로 바꾼 뒤에는 되돌리지 않는다. 마지막 회차는 WAL임을 보고 버전을 마지막으로 읽는다.
          upgradeBeforeFinalRead = true;
        } else if (connections > 1) {
          // 원장이 WAL로 바꾸고 연결을 닫은 직후마다 다른 프로그램이 저널 모드를 되돌린다.
          revertToRollbackJournal(path);
          reverted += 1;
        }
      } else if (sql === "BEGIN IMMEDIATE") {
        lockAttempts += 1;
        if (label === cases[1] && lockAttempts === rounds) {
          // 마지막 회차가 쓰기 잠금을 잡기 직전에 다음 버전의 프로그램이 올리고, WAL이 아닌 채로 남긴다.
          upgradeInAnotherProcess(path, true);
        }
      }
      return ORIGINAL_EXEC.call(this, sql);
    };
    DatabaseSync.prototype.prepare = function (sql, ...rest) {
      if (upgradeBeforeFinalRead && sql === "PRAGMA journal_mode") {
        // 마지막 회차가 저널 모드를 확인하려는 순간에 다음 버전의 프로그램이 올린다.
        upgradeBeforeFinalRead = false;
        upgradeInAnotherProcess(path, false);
      }
      return ORIGINAL_PREPARE.call(this, sql, ...rest);
    };
    let thrown: unknown;
    try {
      openLedger({ path });
    } catch (error) {
      thrown = error;
    } finally {
      DatabaseSync.prototype.exec = ORIGINAL_EXEC;
      DatabaseSync.prototype.prepare = ORIGINAL_PREPARE;
    }

    // 모두 코드가 있는 LedgerError이고, 코드로 구별된다.
    assert.ok(thrown instanceof LedgerError, `${label}: ${String(thrown)}`);
    if (label === cases[0]) {
      assert.equal(thrown.code, "journal_mode_unstable", label);
      assert.deepEqual([lockAttempts, reverted], [rounds, rounds], label);
      assert.deepEqual([userVersion(path), journalMode(path)], [MIGRATIONS.length, "delete"]);
    } else if (label === cases[1]) {
      // 더 높은 버전임을 잠금 안에서 읽은 그 자리에서 버전 오류로 거부한다.
      assert.equal(thrown.code, "schema_version_too_new", label);
      assert.deepEqual([lockAttempts, reverted], [rounds, rounds - 1], label);
      assert.deepEqual([userVersion(path), journalMode(path)], [MIGRATIONS.length + 1, "delete"]);
    } else {
      // 여덟 번째 판정에서 WAL임을 보고 읽은 버전이 더 높았다. 다음 판정이 없어도 버전 오류다.
      assert.equal(thrown.code, "schema_version_too_new", label);
      assert.deepEqual(
        [connections, lockAttempts, reverted],
        [rounds, rounds - 1, rounds - 2],
        label,
      );
      assert.deepEqual([userVersion(path), journalMode(path)], [MIGRATIONS.length + 1, "wal"]);
    }
    // 요청은 그대로이고, 잠금이나 롤백 저널 파일이 남지 않았다.
    assert.equal(requestCount(path), 1, label);
    assert.equal(existsSync(`${path}-journal`), false, label);
    const raw = new DatabaseSync(path, { timeout: 0 });
    raw.exec("BEGIN EXCLUSIVE; ROLLBACK;");
    raw.close();
    if (label === cases[0]) {
      // 되돌리는 프로그램이 멈추면 정상으로 열린다.
      openLedger({ path }).close();
      assert.equal(journalMode(path), "wal", label);
    }
  }
});

test("쓰기 때의 버전 확인은 그 연결을 열 때 쓴 마이그레이션 목록의 버전을 기준으로 한다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const extra: Migration = { name: "시험용", sql: "CREATE TABLE probe (id TEXT) STRICT;" };
  const record = (db: DatabaseSync, id: string) =>
    write({ db, clock: fixedClock, newId: () => id }, user, { action: "createRequest" }, (scope) =>
      scope.record({
        target: { kind: "request", id },
        requestId: id,
        before: null,
        after: {},
      }),
    );

  // 기본 목록으로 연 연결은 기본 목록의 버전에서 쓴다.
  const base = openDb(path);
  t.after(() => base.close());
  assert.equal(record(base, "req-1"), 1);

  // 마이그레이션을 하나 더한 목록으로 열면 올라가고, 그 연결은 올라간 버전에서 쓴다.
  const extended = openDb(path, { migrations: [...MIGRATIONS, extra] });
  t.after(() => extended.close());
  assert.equal(userVersion(path), MIGRATIONS.length + 1);
  assert.equal(record(extended, "req-2"), 2);
  extended.prepare("INSERT INTO probe (id) VALUES (?)").run("p1");

  // 먼저 열어 둔 기본 목록의 연결은 이제 쓰지 않는다. 읽기는 된다.
  assert.throws(() => record(base, "req-3"), isTooNew);
  assert.equal(base.isTransaction, false);
  assert.deepEqual(
    changesSince(base, 0).map((change) => change.target.id),
    ["req-1", "req-2"],
  );
  // 올라간 버전의 연결은 계속 쓴다.
  assert.equal(record(extended, "req-4"), 3);

  // 메모리에 연 연결도 연 목록의 버전에서 쓴다.
  const inMemory = openDb(":memory:", { migrations: [...MIGRATIONS, extra] });
  t.after(() => inMemory.close());
  assert.equal(record(inMemory, "req-1"), 1);
});

test("WAL이 아닌 최신 파일을 열면 WAL로 바뀌고, 돌려준 연결은 다른 연결과 함께 읽고 쓴다", (t) => {
  const path = currentBackupWithOneRequest(t);

  const db = openDb(path);
  t.after(() => db.close());

  assert.equal(journalMode(path), "wal");
  // 잠금을 쥐려고 쓴 배타 잠금 모드와 줄여 둔 대기 시간이 돌려준 연결에 남아 있지 않다.
  assert.equal(db.prepare("PRAGMA locking_mode").get()?.locking_mode, "normal");
  assert.equal(db.prepare("PRAGMA busy_timeout").get()?.timeout, BUSY_TIMEOUT_MS);
  assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
  // 저널 모드를 바꾸느라 생긴 롤백 저널 파일이 남지 않는다.
  assert.equal(existsSync(`${path}-journal`), false);
  // 다른 연결이 함께 열고 쓸 수 있고, 서로의 쓰기가 보인다.
  const other = openLedger({ path, clock: fixedClock, newId: () => "req-by-other" });
  t.after(() => other.close());
  other.createRequest(user, { stated: { title: "함께 연 원장이 쓴 요청" } });
  assert.equal(changesSince(db, 0).length, 2);
  assert.equal(requestCount(path), 2);
});

test("S29: 올리기는 끝났는데 WAL로 바꾸는 일만 잠금 때문에 한도 안에 끝나지 않으면, 잠금 오류로 끝나고 파일은 올라간 버전으로 남으며 다음에 열 때 WAL로 바뀐다", (t) => {
  assertSqliteRestoredAfter(t);
  const path = join(makeTempDir(t), "ledger.sqlite");
  // 올려야 하는 WAL이 아닌 예전 파일이다.
  writeOldFile(
    path,
    2,
    `${VERSION_2_SCHEMA}
     INSERT INTO requests (id, title, created_at) VALUES
       ('req-1', '예전 요청', '2026-03-02T09:00:00.123Z');
     ${oldChangeSql("2026-03-02T09:00:00.123Z", user, "req-1", "예전 요청")}`,
    { wal: false },
  );
  const reader = new DatabaseSync(path);
  t.after(() => reader.close());
  const budgetMs = 300;
  let elapsedMs = 0;

  // 올리기를 커밋한 뒤 WAL로 바꾸려고 두 번째로 쓰기 잠금을 잡으려는 순간에, 다른 연결이 읽기 시작해 놓지 않는다.
  const raced = racingBeforeWriteLock(
    () => {
      assert.equal(userVersion(path), MIGRATIONS.length);
      reader.exec("BEGIN; SELECT count(*) FROM requests;");
    },
    () => {
      const startedAt = performance.now();
      assert.throws(
        () => openDb(path, { busyTimeoutMs: budgetMs }),
        (error) => (error as { errcode?: number }).errcode === 5,
      );
      elapsedMs = performance.now() - startedAt;
    },
    2,
  );

  assert.equal(raced, 1);
  // 읽는 연결이 빠지기를 한도까지 기다리고 끝냈다.
  assert.ok(elapsedMs >= budgetMs - 20, `${elapsedMs.toFixed(0)}ms 만에 끝났다`);
  assert.ok(elapsedMs < budgetMs + 250, `${elapsedMs.toFixed(0)}ms가 걸렸다`);
  // 파일은 올라간 버전으로 남고 저널 모드는 그대로다. 옮긴 시각도 그대로 있다.
  const upgraded = () =>
    inspect(path, (raw) => ({
      version: raw.prepare("PRAGMA user_version").get()?.user_version,
      createdAt: raw.prepare("SELECT created_at FROM requests").get()?.created_at,
      at: raw.prepare("SELECT at FROM changes").get()?.at,
    }));
  const afterFailure = upgraded();
  assert.deepEqual(afterFailure, {
    version: MIGRATIONS.length,
    createdAt: "2026-03-02T09:00:00.123000Z",
    at: "2026-03-02T09:00:00.123000Z",
  });
  reader.exec("ROLLBACK");
  assert.equal(journalMode(path), "delete");

  // 잠금이 풀린 뒤 다시 열면 WAL로 바뀐다. 내용은 그대로다.
  openDb(path).close();
  assert.equal(journalMode(path), "wal");
  assert.deepEqual(upgraded(), afterFailure);
});

test("이미 최신 버전인 파일은 쓰기 잠금을 잡지 않고 열린다", (t) => {
  assertSqliteRestoredAfter(t);
  const path = join(makeTempDir(t), "ledger.sqlite");
  const first = openLedger({ path });
  first.createRequest(user, { stated: { title: "먼저 있던 요청" } });
  first.close();
  // 다른 연결이 쓰기 잠금을 쥐고 놓지 않는다.
  const writer = new DatabaseSync(path);
  t.after(() => writer.close());
  writer.exec("BEGIN IMMEDIATE");
  const executed: string[] = [];
  DatabaseSync.prototype.exec = function (sql) {
    executed.push(sql);
    return ORIGINAL_EXEC.call(this, sql);
  };

  // 잠금을 기다려야 했다면 이 시간 안에 열리지 않고 잠금 오류가 난다.
  let db: DatabaseSync;
  try {
    db = openDb(path, { busyTimeoutMs: 50 });
  } finally {
    DatabaseSync.prototype.exec = ORIGINAL_EXEC;
  }
  t.after(() => db.close());

  assert.equal(executed.includes("BEGIN IMMEDIATE"), false, executed.join(" | "));
  assert.equal(changesSince(db, 0).length, 1);
  writer.exec("ROLLBACK");
});

test("S29: 버전 1의 파일도 옮길 수 없는 시각이 있으면 올리지 않는다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  writeOldFile(
    path,
    1,
    VERSION_1_SCHEMA +
      oldChangeSql("-000001-12-31T23:59:59.999Z", user, "req-old", "기원전의 변경"),
  );

  assert.throws(
    () => openLedger({ path }),
    (error) =>
      error instanceof LedgerError &&
      error.code === "unmigratable_time" &&
      /changes\.at/.test(error.message) &&
      /-000001-12-31T23:59:59\.999Z/.test(error.message),
  );

  assert.equal(userVersion(path), 1);
  // 올리다 만 테이블이 남지 않는다.
  assert.deepEqual(
    tableNames(path).filter((name) => name !== "sqlite_sequence"),
    ["changes"],
  );
  assert.equal(
    inspect(path, (raw) => raw.prepare("SELECT at FROM changes").get()?.at),
    "-000001-12-31T23:59:59.999Z",
  );
});

test("S29: 여러 버전이 밀려 있으면 순서대로 올린다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const ledger = openLedger({ path, clock: fixedClock });
  ledger.createRequest(user, { stated: { title: "남아 있어야 하는 요청" } });
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
  // 올릴 것이 없는 최신 버전의 파일이라, 여는 쪽은 WAL로 바꾸는 일만 한다.
  // WAL이 아닌 파일에 읽는 연결과 쓰기를 예약한 연결이 붙어 있다.
  createCurrentFileWithoutWal(path);
  const reader = new DatabaseSync(path);
  const reserved = new DatabaseSync(path);
  t.after(() => {
    reader.close();
    reserved.close();
  });
  reader.exec("BEGIN; SELECT count(*) FROM requests;");
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

test("올리려는 파일의 쓰기 잠금을 다른 연결이 놓지 않으면 busy timeout에서 잠금 오류로 끝내고 파일은 그대로다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  // 올려야 하는 WAL이 아닌 파일에 쓰기를 예약한 연결이 붙어 있다.
  writeOldFile(
    path,
    2,
    VERSION_2_SCHEMA + oldChangeSql("2026-03-02T09:00:00.123Z", user, "req-1", "예전 요청"),
    { wal: false },
  );
  const reserved = new DatabaseSync(path);
  t.after(() => reserved.close());
  reserved.exec("BEGIN IMMEDIATE");
  const before = fileState(path);
  const hashBefore = sha256(path);
  const budgetMs = 300;

  const startedAt = performance.now();
  assert.throws(
    () => openDb(path, { busyTimeoutMs: budgetMs }),
    (error) => (error as { errcode?: number }).errcode === 5,
  );
  const elapsedMs = performance.now() - startedAt;

  // 올리는 쓰기 잠금을 busy timeout만큼 기다리고 끝낸다. WAL로 바꾸는 데까지 가지 않는다.
  assert.ok(elapsedMs >= budgetMs - 20, `${elapsedMs.toFixed(0)}ms 만에 끝났다`);
  assert.ok(elapsedMs < budgetMs + 200, `${elapsedMs.toFixed(0)}ms가 걸렸다`);
  reserved.exec("ROLLBACK");
  assert.deepEqual(fileState(path), before);
  assert.equal(sha256(path), hashBefore);
  assert.equal(journalMode(path), "delete");
  // 잠금이 풀리면 올라가고 WAL로 바뀐다.
  openDb(path).close();
  assert.deepEqual([userVersion(path), journalMode(path)], [MIGRATIONS.length, "wal"]);
});

test("닫은 원장을 부르면 오류를 낸다. 두 번 닫아도 된다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const ledger = openLedger({ path });
  ledger.close();
  ledger.close();

  const isClosedError = (error: unknown) =>
    error instanceof LedgerError && error.code === "ledger_closed";
  assert.throws(
    () => ledger.createRequest(user, { stated: { title: "닫은 뒤의 요청" } }),
    isClosedError,
  );
  assert.throws(() => ledger.changesSince(0), isClosedError);
});

test("메모리 DB로 열 수 있다", (t) => {
  const ledger = openLedger({ path: ":memory:", clock: fixedClock });
  t.after(() => ledger.close());

  ledger.createRequest(user, { stated: { title: "메모리에만 있는 요청" } });

  assert.equal(ledger.changesSince(0).length, 1);
});

test("SQLite 함수를 바꿔 쓴 테스트들이 끝나면 원래 함수로 돌아와 있다", () => {
  // 이 파일의 테스트는 위에서부터 차례로 돈다. 앞의 테스트가 되돌리지 못했으면 여기서 드러난다.
  assert.equal(DatabaseSync.prototype.exec, ORIGINAL_EXEC);
  assert.equal(DatabaseSync.prototype.prepare, ORIGINAL_PREPARE);
});
