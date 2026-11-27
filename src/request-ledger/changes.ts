import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import { inWriteTransaction, type LedgerDb, type SyncResult } from "./db.ts";
import { LedgerError } from "./errors.ts";
import type { Actor, Change, ChangeTarget, Clock, JsonValue } from "./types.ts";

/** 쓰기 하나가 남기는 변경 한 건. 순번, 시각, 주체는 쓰기의 틀이 채운다. */
export type ChangeEntry = {
  readonly target: ChangeTarget;
  /** 이전 값. 새로 만든 것이면 null */
  readonly before: JsonValue;
  readonly after: JsonValue;
  readonly evidence?: readonly JsonValue[];
  readonly reason?: string;
};

type Row = Record<string, SQLOutputValue>;

/**
 * 진행 중인 쓰기 하나. 그 쓰기의 트랜잭션 안에서 읽고 쓰는 길이다.
 * 쓰기가 끝나면(커밋했든 거부됐든) 어느 함수도 쓸 수 없고 `write_ended` 오류를 낸다.
 * 한 쓰기에서 여러 값을 바꿀 때는 이 scope를 넘겨 같은 트랜잭션에서 하게 한다.
 */
export type WriteScope = {
  /**
   * 이 쓰기의 시각. 쓰기 잠금을 잡은 뒤에 읽은 시각이다.
   * 시계가 조정되거나 거꾸로 가면 앞선 쓰기보다 이를 수 있으므로, 쓰기의 앞뒤는 시각이 아니라 순번으로 가린다.
   */
  readonly at: string;
  /** 값을 쓴다. */
  run(sql: string, ...params: SQLInputValue[]): void;
  /** 한 줄을 읽는다. 이 쓰기가 아직 커밋하지 않은 값도 보인다. */
  get(sql: string, ...params: SQLInputValue[]): Row | undefined;
  /** 여러 줄을 읽는다. */
  all(sql: string, ...params: SQLInputValue[]): Row[];
  /** 변경 이력을 한 건 남기고 그 순번을 돌려준다. */
  record(entry: ChangeEntry): number;
};

/** 주체를 밝혔는지 확인하고, 저장할 형태로 돌려준다. */
function checkedActor(actor: Actor): Actor {
  const given: unknown = actor;
  if (typeof given === "object" && given !== null) {
    const { kind, via, module } = given as Record<string, unknown>;
    if (kind === "user" && (via === "web" || via === "skill")) {
      return { kind, via };
    }
    // 공백뿐인 이름은 어느 모듈이 썼는지 알 수 없으므로 빈 이름과 같이 본다.
    if (kind === "assistant" && typeof module === "string" && module.trim() !== "") {
      return { kind, module };
    }
  }
  throw new LedgerError(
    "invalid_actor",
    "쓰기는 주체를 밝혀야 한다. 사용자는 창구(web, skill)를, 비서는 모듈 이름을 적는다",
  );
}

/**
 * 쓰기 하나의 틀. 규칙 검사, 값 저장, 변경 이력을 한 쓰기 트랜잭션으로 묶는다.
 * body가 오류를 던지면 값도 변경 이력도 남지 않는다.
 *
 * body는 동기로 끝나야 한다. Promise를 돌려주면 커밋하지 않고 `async_write` 오류를 낸다.
 * 값과 변경 이력은 scope로만 쓴다. 쓰기가 끝난 뒤에는 scope로 아무것도 쓸 수 없다.
 */
export function write<T>(
  db: LedgerDb,
  actor: Actor,
  clock: Clock,
  body: (scope: WriteScope) => SyncResult<T>,
): T {
  const actorJson = JSON.stringify(checkedActor(actor));
  let open = true;
  const assertOpen = (): void => {
    if (!open) {
      throw new LedgerError(
        "write_ended",
        "끝난 쓰기로는 값도 변경 이력도 쓸 수 없다. 쓰기 콜백은 동기로 끝나야 한다",
      );
    }
  };
  try {
    return inWriteTransaction<T>(db, () => {
      const at = clock().toISOString();
      const insertChange = db.prepare(
        `INSERT INTO changes
           (at, actor, target_kind, target_id, before_value, after_value, evidence, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      return body({
        at,
        run(sql, ...params) {
          assertOpen();
          db.prepare(sql).run(...params);
        },
        get(sql, ...params) {
          assertOpen();
          return db.prepare(sql).get(...params);
        },
        all(sql, ...params) {
          assertOpen();
          return db.prepare(sql).all(...params);
        },
        record(entry) {
          assertOpen();
          const result = insertChange.run(
            at,
            actorJson,
            entry.target.kind,
            entry.target.id,
            JSON.stringify(entry.before),
            JSON.stringify(entry.after),
            JSON.stringify(entry.evidence ?? []),
            entry.reason ?? null,
          );
          return Number(result.lastInsertRowid);
        },
      });
    });
  } finally {
    open = false;
  }
}

type ChangeRow = {
  seq: number;
  at: string;
  actor: string;
  target_kind: string;
  target_id: string;
  before_value: string;
  after_value: string;
  evidence: string;
  reason: string | null;
};

/** 주어진 순번 뒤의 변경 이력을 순번 순서로 돌려준다. 처음부터 읽으려면 0을 준다. */
export function changesSince(db: LedgerDb, seq: number): Change[] {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new LedgerError("invalid_argument", "순번은 0 이상의 정수여야 한다");
  }
  const rows = db
    .prepare(
      `SELECT seq, at, actor, target_kind, target_id, before_value, after_value, evidence, reason
         FROM changes
        WHERE seq > ?
        ORDER BY seq`,
    )
    .all(seq) as ChangeRow[];
  return rows.map((row) => ({
    seq: row.seq,
    at: row.at,
    actor: JSON.parse(row.actor) as Actor,
    target: { kind: row.target_kind, id: row.target_id } as ChangeTarget,
    before: JSON.parse(row.before_value) as JsonValue,
    after: JSON.parse(row.after_value) as JsonValue,
    evidence: JSON.parse(row.evidence) as JsonValue[],
    reason: row.reason,
  }));
}
