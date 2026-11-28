import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import { inWriteTransaction, type LedgerDb, type SyncResult } from "./db.ts";
import { LedgerError } from "./errors.ts";
import { clockTime } from "./time.ts";
import type {
  Actor,
  AppliesTo,
  Change,
  ChangeTarget,
  Clock,
  JsonValue,
  NewId,
  WriteAction,
} from "./types.ts";

/** 쓰기 하나가 대상 하나에 남기는 변경 한 건. 순번, 쓰기 순번, 시각, 주체, 적용 범위는 쓰기의 틀이 채운다. */
export type ChangeEntry = {
  readonly target: ChangeTarget;
  /** 쓸 때 대상이 속해 있던 요청. 요청에 속하지 않는 대상(기록과 판본)은 null */
  readonly requestId: string | null;
  /** 바뀐 항목의 이전 값. 새로 만든 것이면 null */
  readonly before: JsonValue;
  /** 바뀐 항목의 새 값. 지운 것이면 null */
  readonly after: JsonValue;
  readonly evidence?: readonly JsonValue[];
  /** 이 건의 사유. 없으면(undefined) 이 쓰기의 사유다. 답하면서 값을 바꾸는 쓰기에서 값 변경마다 사유를 따로 적을 때 쓴다. */
  readonly reason?: string | null;
  /** 이 건을 만든 쓰기. 없으면 이 쓰기의 이름이다. 답하면서 값을 바꾸는 쓰기에서 값 변경의 이름을 따로 적을 때 쓴다. */
  readonly action?: WriteAction;
};

export type Row = Record<string, SQLOutputValue>;

/** 쓰기에 필요한 것. 원장을 열 때 정한다. */
export type WriteEnv = {
  readonly db: LedgerDb;
  readonly clock: Clock;
  readonly newId: NewId;
};

/** 어느 쓰기인지와, 사용자가 밝힌 정정의 적용 범위. */
export type WriteSpec = {
  readonly action: WriteAction;
  /** 사용자가 밝힌 적용 범위. 밝히지 않았으면 비운다. 비서의 쓰기에는 붙일 수 없다. */
  readonly appliesTo?: unknown;
  /** 이 쓰기의 사유. 어느 쓰기에나 적을 수 있다. */
  readonly reason?: unknown;
};

/**
 * 진행 중인 쓰기 하나. 그 쓰기의 트랜잭션 안에서 읽고 쓰는 길이다.
 * 쓰기가 끝나면(커밋했든 거부됐든) 어느 함수도 쓸 수 없고 `write_ended` 오류를 낸다.
 * 한 쓰기에서 여러 값을 바꿀 때는 이 scope를 넘겨 같은 트랜잭션에서 하게 한다.
 */
export type WriteScope = {
  /** 형태를 확인한 쓰기의 주체. */
  readonly actor: Actor;
  /** 이 쓰기의 이름. */
  readonly action: WriteAction;
  /** 이 쓰기에 적은 사유. 적지 않았거나 공백뿐이면 null. */
  readonly reason: string | null;
  /**
   * 이 쓰기의 시각. 쓰기 잠금을 잡은 뒤에 읽은 시각이다.
   * 시계가 조정되거나 거꾸로 가면 앞선 쓰기보다 이를 수 있으므로, 쓰기의 앞뒤는 시각이 아니라 순번으로 가린다.
   */
  readonly at: string;
  /**
   * 이 쓰기의 쓰기 순번. 쓰기 잠금을 잡은 뒤 변경 이력의 다음 순번을 읽어 정한다.
   * 이 쓰기가 남기는 첫 건이 이 순번으로 저장되므로, 변경 이력을 남기기 전에도 상태 컬럼에 쓸 수 있다.
   * 아무것도 바꾸지 않은 쓰기는 변경 이력을 남기지 않으므로 이 순번을 쓰지 않는다.
   */
  readonly seq: number;
  /** 새 식별자를 만든다. */
  newId(): string;
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

/** 사용자가 밝힌 적용 범위의 형태를 확인한다. 사용자의 쓰기에만 붙는다. */
function checkedAppliesTo(actor: Actor, appliesTo: unknown): AppliesTo | null {
  if (appliesTo === undefined) {
    return null;
  }
  if (appliesTo !== "this_request" && appliesTo !== "similar_future") {
    throw new LedgerError(
      "invalid_argument",
      "정정의 적용 범위(appliesTo)는 this_request나 similar_future다",
    );
  }
  if (actor.kind !== "user") {
    throw new LedgerError("requires_user", "정정의 적용 범위는 사용자의 쓰기에만 밝힐 수 있다");
  }
  return appliesTo;
}

/** 사유의 형태를 확인한다. 공백뿐인 사유는 없는 것으로 본다. */
export function checkedReason(reason: unknown): string | null {
  if (reason === undefined || reason === null) {
    return null;
  }
  if (typeof reason !== "string") {
    throw new LedgerError("invalid_argument", "사유(reason)는 문자열이어야 한다");
  }
  return reason.trim() === "" ? null : reason;
}

/**
 * 쓰기 하나의 틀. 규칙 검사, 값 저장, 변경 이력을 한 쓰기 트랜잭션으로 묶는다.
 * body가 오류를 던지면 값도 변경 이력도 남지 않는다.
 *
 * body는 동기로 끝나야 한다. Promise를 돌려주면 커밋하지 않고 `async_write` 오류를 낸다.
 * 값과 변경 이력은 scope로만 쓴다. 쓰기가 끝난 뒤에는 scope로 아무것도 쓸 수 없다.
 */
export function write<T>(
  env: WriteEnv,
  actor: Actor,
  spec: WriteSpec,
  body: (scope: WriteScope) => SyncResult<T>,
): T {
  const { db } = env;
  const checked = checkedActor(actor);
  const actorJson = JSON.stringify(checked);
  const appliesTo = checkedAppliesTo(checked, spec.appliesTo);
  const reason = checkedReason(spec.reason);
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
      const at = clockTime(env.clock());
      // 쓰기 잠금을 잡은 뒤에 읽으므로 다른 쓰기가 이 순번을 먼저 쓸 수 없다.
      const seq = Number(
        db
          .prepare(
            `SELECT max(
                      coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'changes'), 0),
                      coalesce((SELECT max(seq) FROM changes), 0)
                    ) + 1 AS next`,
          )
          .get()?.next,
      );
      const insertChange = db.prepare(
        `INSERT INTO changes
           (seq, at, actor, target_kind, target_id, before_value, after_value, evidence, reason,
            write_seq, action, request_id, applies_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let recorded = 0;
      return body({
        actor: checked,
        action: spec.action,
        reason,
        at,
        seq,
        newId() {
          assertOpen();
          return env.newId();
        },
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
            // 첫 건은 쓰기 순번으로 저장하고, 다음 건은 이어지는 순번을 받는다.
            recorded === 0 ? seq : null,
            at,
            actorJson,
            entry.target.kind,
            entry.target.id,
            JSON.stringify(entry.before),
            JSON.stringify(entry.after),
            JSON.stringify(entry.evidence ?? []),
            entry.reason === undefined ? reason : entry.reason,
            seq,
            entry.action ?? spec.action,
            entry.requestId,
            appliesTo,
          );
          recorded += 1;
          return Number(result.lastInsertRowid);
        },
      });
    });
  } finally {
    open = false;
  }
}

/**
 * 그 요청에 준 지시이거나, 비서의 판단을 바로잡은 것이 아니라 일어난 일을 사용자가 알린 쓰기.
 * 사용자가 적용 범위를 밝히지 않으면 이 요청에만 해당하는 것으로 본다. 나머지는 다음 유사 업무에도 적용한다.
 */
const THIS_REQUEST_BY_DEFAULT: ReadonlySet<WriteAction> = new Set<WriteAction>([
  // 그 요청에 준 지시
  "placeHold",
  "releaseHold",
  "setOrder",
  "setContinue",
  "setDelegation",
  "clearDelegation",
  // 일어난 일을 사용자가 알린 것
  "completeTask",
  "cancelTask",
  "closeRequest",
  "setEnding",
  "confirmClosure",
  "clearEnding",
  "reopenRequest",
  "resolveOpenItem",
  "markNoticeSeen",
]);

/** 사용자가 적용 범위를 밝히지 않은 쓰기의 기본값. */
export function defaultAppliesTo(action: WriteAction): AppliesTo {
  return THIS_REQUEST_BY_DEFAULT.has(action) ? "this_request" : "similar_future";
}

type ChangeRow = {
  seq: number;
  write_seq: number;
  at: string;
  actor: string;
  action: string;
  target_kind: string;
  target_id: string;
  request_id: string | null;
  before_value: string;
  after_value: string;
  evidence: string;
  reason: string | null;
  applies_to: string | null;
};

function toChange(row: ChangeRow): Change {
  const actor = JSON.parse(row.actor) as Actor;
  const action = row.action as WriteAction;
  return {
    seq: row.seq,
    writeSeq: row.write_seq,
    at: row.at,
    actor,
    action,
    target: { kind: row.target_kind, id: row.target_id } as ChangeTarget,
    requestId: row.request_id,
    before: JSON.parse(row.before_value) as JsonValue,
    after: JSON.parse(row.after_value) as JsonValue,
    evidence: JSON.parse(row.evidence) as JsonValue[],
    reason: row.reason,
    appliesTo:
      actor.kind !== "user"
        ? null
        : row.applies_to !== null
          ? { scope: row.applies_to as AppliesTo, stated: true }
          : { scope: defaultAppliesTo(action), stated: false },
  };
}

/** 조건에 맞는 변경 이력을 순번 순서로 읽는다. `where`는 changes의 컬럼만 쓰는 SQL 조건이다. */
export function readChanges(db: LedgerDb, where: string, ...params: SQLInputValue[]): Change[] {
  const rows = db
    .prepare(
      `SELECT seq, write_seq, at, actor, action, target_kind, target_id, request_id,
              before_value, after_value, evidence, reason, applies_to
         FROM changes
        WHERE ${where}
        ORDER BY seq`,
    )
    .all(...params) as ChangeRow[];
  return rows.map(toChange);
}

/** 주어진 순번 뒤의 변경 이력을 순번 순서로 돌려준다. 처음부터 읽으려면 0을 준다. */
export function changesSince(db: LedgerDb, seq: number): Change[] {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new LedgerError("invalid_argument", "순번은 0 이상의 정수여야 한다");
  }
  return readChanges(db, "seq > ?", seq);
}
