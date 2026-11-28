import type { DatabaseSync } from "node:sqlite";
import { LedgerError } from "./errors.ts";
import { externalTime } from "./time.ts";

/** 스키마를 한 버전 올리는 SQL. 목록의 n번째가 버전 n을 만든다. */
export type Migration = {
  readonly name: string;
  readonly sql: string;
  /**
   * 있던 데이터를 새 형태로 옮길 수 있는지 읽기만으로 확인한다. 옮길 수 없으면 `LedgerError`를 던진다.
   * 올리는 쓰기 잠금 안에서, 밀린 마이그레이션을 하나도 적용하기 전에 부른다. 던지면 아무것도 쓰지 않은 채 끝난다.
   * 앞선 마이그레이션이 아직 적용되지 않았으므로, 아직 없는 테이블은 건너뛰게 쓴다.
   */
  readonly check?: (db: DatabaseSync) => void;
};

/** 버전 2까지의 쓰기가 저장하던 시각의 형태. UTC, 네 자리 연도, 밀리초 세 자리다. */
const MILLISECOND_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * 버전 2까지의 파일에 저장된 시각을 마이크로초 형태로 옮길 수 있는지.
 * 형태가 밀리초 형태이고, 달력에 있는 시각이며, 옮긴 값이 같은 시각이어야 한다.
 * 2월 31일처럼 자릿수는 맞지만 시각으로 읽을 수 없는 값은 옮길 수 없다.
 */
function canMoveTime(value: unknown): boolean {
  if (typeof value !== "string" || !MILLISECOND_TIME.test(value)) {
    return false;
  }
  try {
    // 마이그레이션의 SQL이 옮기는 방식과 같다. 밖에서 받는 시각을 읽는 한 곳의 규칙으로 같은 시각인지 본다.
    return externalTime(value, "저장된 시각") === `${value.slice(0, 23)}000Z`;
  } catch {
    return false;
  }
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

/**
 * 버전 2까지의 파일에 있는 시각을 모두 마이크로초 형태로 옮길 수 있는지 확인한다.
 * 예전 시계는 `Date.toISOString()`을 그대로 저장했으므로, 연도가 네 자리를 벗어난 시각은 `+010000-…`처럼 적혀 있다.
 * 그런 값은 길이와 형태가 같은 한 가지 형태로 옮길 수 없어 문자열 비교가 시각 비교라는 전제를 깬다.
 */
function assertTimesCanMove(db: DatabaseSync): void {
  const columns = [
    ["changes", "at"],
    ["requests", "created_at"],
  ] as const;
  for (const [table, column] of columns) {
    if (!tableExists(db, table)) {
      continue;
    }
    const values = db.prepare(`SELECT DISTINCT ${column} AS value FROM ${table}`).all();
    const stuck = values.find((row) => !canMoveTime(row.value));
    if (stuck !== undefined) {
      throw new LedgerError(
        "unmigratable_time",
        `원장 파일의 ${table}.${column}에 새 형태로 옮길 수 없는 시각이 있어 스키마를 올리지 않는다 (${String(stuck.value)}). 시각은 연도 0000~9999의, 달력에 있는 UTC 시각이어야 한다`,
      );
    }
  }
}

/**
 * 스키마는 이 목록으로만 만든다. 이미 내보낸 항목은 고치지 않고, 바꿀 것은 뒤에 더한다.
 * 저장된 데이터를 옮겨야 하는 변경은 더하기 전에 먼저 묻는다.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    name: "변경 이력",
    sql: `
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
    `,
  },
  {
    name: "요청",
    sql: `
      CREATE TABLE requests (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    // 데이터 모델의 "변경 이력"과 "요청". 버전 2까지의 파일에 있던 줄은 여기서 채운다.
    name: "변경 이력의 쓰기 순번과 요청의 값",
    check: assertTimesCanMove,
    sql: `
      ALTER TABLE changes ADD COLUMN write_seq INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE changes ADD COLUMN action TEXT NOT NULL DEFAULT 'createRequest';
      ALTER TABLE changes ADD COLUMN request_id TEXT;
      ALTER TABLE changes ADD COLUMN applies_to TEXT
        CHECK (applies_to IN ('this_request', 'similar_future'));

      -- 밀리초 형태의 시각을 마이크로초 여섯 자리로 바꾼다. 뜻은 바뀌지 않는다.
      -- 옮길 수 없는 시각이 없다는 것은 적용하기 전에 확인했다.
      UPDATE changes
         SET at = substr(at, 1, 23) || '000Z',
             write_seq = seq,
             request_id = CASE WHEN target_kind = 'request' THEN target_id END;

      CREATE INDEX changes_by_request ON changes (request_id, seq);
      CREATE INDEX changes_by_target ON changes (target_kind, target_id, seq);

      ALTER TABLE requests ADD COLUMN created_seq INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE requests ADD COLUMN undecided INTEGER NOT NULL DEFAULT 0
        CHECK (undecided IN (0, 1));
      ALTER TABLE requests ADD COLUMN user_order INTEGER;
      ALTER TABLE requests ADD COLUMN progress TEXT;
      ALTER TABLE requests ADD COLUMN added_seq INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE requests ADD COLUMN title_set_by TEXT NOT NULL DEFAULT 'assistant'
        CHECK (title_set_by IN ('user', 'assistant'));
      ALTER TABLE requests ADD COLUMN title_user_set_at TEXT;
      ALTER TABLE requests ADD COLUMN title_written_seq INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE requests ADD COLUMN requester TEXT;
      ALTER TABLE requests ADD COLUMN requester_set_by TEXT
        CHECK (requester_set_by IN ('user', 'assistant'));
      ALTER TABLE requests ADD COLUMN requester_user_set_at TEXT;

      ALTER TABLE requests ADD COLUMN promise TEXT;
      ALTER TABLE requests ADD COLUMN promise_set_by TEXT
        CHECK (promise_set_by IN ('user', 'assistant'));
      ALTER TABLE requests ADD COLUMN promise_user_set_at TEXT;
      ALTER TABLE requests ADD COLUMN promise_evidence_at TEXT;
      ALTER TABLE requests ADD COLUMN promise_work_seq INTEGER;

      ALTER TABLE requests ADD COLUMN due TEXT;
      ALTER TABLE requests ADD COLUMN due_set_by TEXT
        CHECK (due_set_by IN ('user', 'assistant'));
      ALTER TABLE requests ADD COLUMN due_user_set_at TEXT;
      ALTER TABLE requests ADD COLUMN due_evidence_at TEXT;

      ALTER TABLE requests ADD COLUMN urgency TEXT
        CHECK (urgency IN ('high', 'medium', 'low'));
      ALTER TABLE requests ADD COLUMN urgency_set_by TEXT
        CHECK (urgency_set_by IN ('user', 'assistant'));
      ALTER TABLE requests ADD COLUMN urgency_user_set_at TEXT;

      ALTER TABLE requests ADD COLUMN importance TEXT
        CHECK (importance IN ('high', 'medium', 'low'));
      ALTER TABLE requests ADD COLUMN importance_set_by TEXT
        CHECK (importance_set_by IN ('user', 'assistant'));
      ALTER TABLE requests ADD COLUMN importance_user_set_at TEXT;

      ALTER TABLE requests ADD COLUMN closed_reason TEXT
        CHECK (closed_reason IN
          ('completed', 'withdrawn', 'transferred', 'declined', 'not_a_request'));
      ALTER TABLE requests ADD COLUMN closed_at TEXT;
      ALTER TABLE requests ADD COLUMN closed_transferee TEXT;
      ALTER TABLE requests ADD COLUMN user_reverted_at TEXT;
      ALTER TABLE requests ADD COLUMN overruled_evidence TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE requests ADD COLUMN merged_into TEXT REFERENCES requests (id);
      ALTER TABLE requests ADD COLUMN user_merged INTEGER NOT NULL DEFAULT 0
        CHECK (user_merged IN (0, 1));

      UPDATE requests SET created_at = substr(created_at, 1, 23) || '000Z';

      -- 있던 요청은 그 요청을 등록한 변경 이력(그 요청을 대상으로 한 첫 건)에서 채운다.
      -- 사용자가 등록한 요청이면 제목에 사용자 지정을 걸고, 걸린 시각은 접수 시각이다.
      UPDATE requests
         SET created_seq = registered.seq,
             title_written_seq = registered.seq,
             added_seq = registered.seq,
             title_set_by = registered.actor_kind,
             title_user_set_at =
               CASE WHEN registered.actor_kind = 'user' THEN requests.created_at END
        FROM (
               SELECT target_id, min(seq) AS seq, json_extract(actor, '$.kind') AS actor_kind
                 FROM changes
                WHERE target_kind = 'request'
                GROUP BY target_id
             ) AS registered
       WHERE registered.target_id = requests.id;
    `,
  },
  {
    // 데이터 모델의 "기록과 연결". 연결이 작업을 가리키므로 작업 테이블도 여기서 만든다.
    name: "기록, 판본, 작업, 연결",
    sql: `
      CREATE TABLE records (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        UNIQUE (source, source_id)
      ) STRICT;

      CREATE TABLE revisions (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES records (id),
        original_at TEXT NOT NULL,
        body TEXT NOT NULL,
        url TEXT,
        author TEXT,
        fetched_at TEXT NOT NULL,
        UNIQUE (record_id, original_at)
      ) STRICT;

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES requests (id),
        created_at TEXT NOT NULL,
        added_seq INTEGER NOT NULL,
        work TEXT NOT NULL,
        work_seq INTEGER NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('todo', 'in_progress', 'waiting', 'done', 'cancelled')),
        assignee TEXT,
        waiting_for TEXT,
        waiting_what TEXT,
        status_corrected_at TEXT,
        status_evidence_at TEXT,
        assignee_corrected_at TEXT,
        assignee_evidence_at TEXT,
        waiting_corrected_at TEXT,
        waiting_evidence_at TEXT,
        finished_by TEXT CHECK (finished_by IN ('user', 'assistant')),
        finished_at TEXT,
        finished_evidence_at TEXT,
        finished_seq INTEGER,
        cancel_reason TEXT,
        overruled_evidence TEXT NOT NULL DEFAULT '[]',
        turn TEXT,
        turn_set_at TEXT,
        keep_going INTEGER NOT NULL DEFAULT 0 CHECK (keep_going IN (0, 1)),
        user_placed INTEGER NOT NULL DEFAULT 0 CHECK (user_placed IN (0, 1))
      ) STRICT;
      CREATE INDEX tasks_by_request ON tasks (request_id);

      CREATE TABLE links (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES records (id),
        request_id TEXT NOT NULL REFERENCES requests (id),
        task_id TEXT REFERENCES tasks (id),
        role TEXT NOT NULL
          CHECK (role IN ('intake', 'progress', 'completion_evidence', 'delivery')),
        user_set INTEGER NOT NULL CHECK (user_set IN (0, 1))
      ) STRICT;
      CREATE UNIQUE INDEX links_once_per_request ON links (record_id, request_id, role)
        WHERE task_id IS NULL;
      CREATE UNIQUE INDEX links_once_per_task ON links (record_id, request_id, role, task_id)
        WHERE task_id IS NOT NULL;
      CREATE INDEX links_by_request ON links (request_id);
    `,
  },
  {
    name: "먼저 끝나야 하는 작업",
    sql: `
      CREATE TABLE task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks (id),
        depends_on TEXT NOT NULL REFERENCES tasks (id),
        PRIMARY KEY (task_id, depends_on)
      ) STRICT;
    `,
  },
  {
    name: "확인할 사항",
    sql: `
      CREATE TABLE open_items (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES requests (id),
        task_id TEXT REFERENCES tasks (id),
        kind TEXT NOT NULL CHECK (kind IN ('question', 'approval', 'unverified', 'mismatch')),
        content TEXT NOT NULL,
        options TEXT,
        raised_at TEXT NOT NULL,
        answer TEXT,
        resolved_at TEXT
      ) STRICT;
      CREATE INDEX open_items_by_request ON open_items (request_id);
    `,
  },
  {
    name: "알릴 일과 준비 자료",
    sql: `
      CREATE TABLE notices (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES requests (id),
        task_id TEXT REFERENCES tasks (id),
        open_item_id TEXT REFERENCES open_items (id),
        kind TEXT NOT NULL
          CHECK (kind IN ('new_request', 'my_turn', 'open_item', 'verified_result', 'closed')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        seen_at TEXT
      ) STRICT;
      CREATE INDEX notices_by_request ON notices (request_id);

      CREATE TABLE materials (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES requests (id),
        task_id TEXT REFERENCES tasks (id),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT,
        checked_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX materials_by_request ON materials (request_id);
    `,
  },
];

export function schemaVersion(db: DatabaseSync): number {
  return Number(db.prepare("PRAGMA user_version").get()?.user_version);
}

/**
 * 읽은 버전이 이 코드가 올릴 수 없는 버전이면 오류를 낸다.
 * 높은 버전은 더 새 프로그램이 만든 파일이고, 음수는 이 프로그램이 만든 적 없는 값이다.
 */
export function assertVersionSupported(version: number, migrations: readonly Migration[]): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new LedgerError(
      "schema_version_invalid",
      `원장 파일의 스키마 버전(${version})이 올바르지 않다. 0 이상이어야 한다`,
    );
  }
  if (version > migrations.length) {
    throw new LedgerError(
      "schema_version_too_new",
      `원장 파일의 스키마 버전(${version})이 이 프로그램이 아는 버전(${migrations.length})보다 높다`,
    );
  }
}

/** 이 코드가 올릴 수 없는 버전의 파일이면 오류를 낸다. 파일은 건드리지 않는다. */
export function assertSupportedVersion(db: DatabaseSync, migrations: readonly Migration[]): void {
  assertVersionSupported(schemaVersion(db), migrations);
}

/**
 * 낮은 버전이면 밀린 마이그레이션을 순서대로 적용한다. 파일의 지금 저널 모드 그대로 한다.
 *
 * 예전 버전인지의 판정, 옮길 수 있는지의 확인, 마이그레이션을 쓰기 잠금 하나 안에서 같은 시점의 값으로 한다.
 * 잠금 없이 읽은 버전은 올릴 일이 있는지 가리는 데만 쓴다. 잠금을 잡은 뒤 버전을 다시 읽어, 그사이에
 * 다른 프로세스가 이미 올렸으면 아무것도 하지 않고 끝낸다.
 *
 * 옮길 수 있는지는 무엇이든 쓰기 전에 모두 확인한다. 옮길 수 없는 데이터가 있으면 아무것도 쓰지 않고 거부하므로
 * 파일의 저널 모드, 버전, 스키마, 줄이 그대로 남는다. 적용하다 실패해도 한 트랜잭션이라 버전과 스키마가 그대로다.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[]): void {
  assertSupportedVersion(db, migrations);
  if (schemaVersion(db) === migrations.length) {
    // 이미 최신 버전인 파일은 쓰기 잠금을 잡지 않는다.
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    assertSupportedVersion(db, migrations);
    const from = schemaVersion(db);
    const pending = migrations.slice(from);
    for (const migration of pending) {
      migration.check?.(db);
    }
    pending.forEach((migration, index) => {
      const version = from + index + 1;
      try {
        db.exec(migration.sql);
      } catch (error) {
        throw new Error(
          `원장의 스키마를 버전 ${version}(${migration.name})로 올리지 못했다: ${String((error as Error)?.message ?? error)}`,
          { cause: error },
        );
      }
    });
    if (pending.length > 0) {
      db.exec(`PRAGMA user_version = ${migrations.length}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
    throw error;
  }
}
