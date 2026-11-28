// 사용자가 정한 차례. 담당과 상태를 그대로 둔 채 작업의 차례만 사용자가 직접 정한 값이다.
// 조회할 때 표시에 따라 계산한 차례 대신 이 값을 쓴다. 비서는 직접 쓸 수 없다.
import type { Row, WriteScope } from "./changes.ts";
import { LedgerError } from "./errors.ts";
import { type CheckedEvidence, checkedEvidence, evidenceJson } from "./evidence.ts";
import { checkedFields } from "./input.ts";
import { existingTask } from "./lookup.ts";
import { isAfter, isLaterRevision } from "./ordering.ts";
import { checkedParty, storedParty } from "./party.ts";
import type { WriteGrounds } from "./request.ts";
import type { JsonValue, Party } from "./types.ts";

export type SetTurnInput = WriteGrounds & {
  readonly taskId: string;
  /** 지금 행동해야 하는 주체. */
  readonly turn: Party;
};

export type ClearTurnInput = WriteGrounds & { readonly taskId: string };

/** 사용자가 정한 차례와 정한 시각. */
export type UserTurn = { readonly party: Party; readonly setAt: string };

/** 작업에 저장된, 사용자가 정한 차례. 정하지 않았으면 null. */
export function readUserTurn(row: Row): UserTurn | null {
  const party = storedParty(row.turn);
  return party === null ? null : { party, setAt: String(row.turn_set_at) };
}

/** 변경 이력에 적는 모습. */
export function userTurnSnapshot(turn: UserTurn | null): JsonValue {
  return turn === null ? null : { party: { ...turn.party }, setAt: turn.setAt };
}

/** 비서의 쓰기로 값이 실제로 바뀐 것(상태, 담당, 대기 대상 가운데 하나)의, 쓰기 전의 시각들. */
export type ChangedValue = {
  /** 사용자가 그 값을 마지막으로 바로잡은 시각. 바로잡은 적 없으면 null. */
  readonly correctedAt: string | null;
  /** 쓰기 전에 그 값에 마지막으로 반영된 근거의 시각. 없으면 null. */
  readonly reflectedAt: string | null;
};

/**
 * 비서의 쓰기로 풀리는, 사용자가 정한 차례. 풀리지 않으면 null이다.
 * 비서가 나중 판본을 근거로 그 작업의 상태, 담당, 대기 대상을 바꿀 때, 그 판본의 원본 시각이 차례를 정한 시각보다 뒤이면 풀린다.
 * 그래서 단 판본 가운데 하나가, 그 쓰기로 실제로 바뀐 값 하나의 나중 판본이면서 차례를 정한 시각보다도 뒤여야 한다.
 * 차례를 정한 시각보다 뒤여도 그 값에 이미 반영된 근거보다 앞선 판본이면, 늦게 도착한 예전 판본이므로 차례는 남는다.
 * `changed`에는 값이 바뀐 것만 넣는다. 반영된 근거의 시각이나 이름 표기만 바뀐 것은 넣지 않는다.
 */
export function turnReleasedByRevision(
  turn: UserTurn | null,
  changed: readonly ChangedValue[],
  evidence: CheckedEvidence,
): UserTurn | null {
  if (turn === null) {
    return null;
  }
  const released = changed.some((value) =>
    evidence.revisionTimes.some(
      (revisionAt) =>
        isAfter(revisionAt, turn.setAt) &&
        isLaterRevision(revisionAt, value.correctedAt, value.reflectedAt),
    ),
  );
  return released ? turn : null;
}

function saveTurn(
  scope: WriteScope,
  row: Row,
  before: UserTurn | null,
  after: UserTurn | null,
  evidence: CheckedEvidence,
): void {
  const taskId = String(row.id);
  scope.run(
    "UPDATE tasks SET turn = ?, turn_set_at = ? WHERE id = ?",
    after === null ? null : JSON.stringify(after.party),
    after?.setAt ?? null,
    taskId,
  );
  scope.record({
    target: { kind: "task", id: taskId },
    requestId: String(row.request_id),
    before: { turn: userTurnSnapshot(before) },
    after: { turn: userTurnSnapshot(after) },
    evidence: evidenceJson(evidence),
  });
}

function requireUser(scope: WriteScope): void {
  if (scope.actor.kind !== "user") {
    throw new LedgerError("requires_user", "작업의 차례는 사용자만 정하고 지울 수 있다");
  }
}

/**
 * 작업의 차례를 정한다. 사용자만 정한다. 담당과 상태는 바꾸지 않는다.
 * 같은 차례를 다시 정해도 정한 시각이 지금으로 바뀐다. 그 시각까지의 기록을 보고 정한 것이기 때문이다.
 * 끝난 작업에는 차례가 없으므로 정할 수 없다.
 */
export function setTurn(scope: WriteScope, input: SetTurnInput): void {
  const fields = checkedFields(input, "setTurn의 인자", ["taskId", "turn", "evidence"]);
  requireUser(scope);
  const row = existingTask(scope, fields.taskId);
  if (row.status === "done" || row.status === "cancelled") {
    throw new LedgerError(
      "task_already_finished",
      "이미 완료했거나 취소한 작업에는 차례를 정할 수 없다. updateTask로 되돌린 뒤에 정한다",
    );
  }
  const party = checkedParty(fields.turn, "차례(turn)");
  const evidence = checkedEvidence(scope, fields.evidence);
  saveTurn(scope, row, readUserTurn(row), { party, setAt: scope.at }, evidence);
}

/** 사용자가 정한 차례를 지운다. 사용자만 지운다. 지우면 계산한 차례로 돌아간다. */
export function clearTurn(scope: WriteScope, input: ClearTurnInput): void {
  const fields = checkedFields(input, "clearTurn의 인자", ["taskId", "evidence"]);
  requireUser(scope);
  const row = existingTask(scope, fields.taskId);
  const evidence = checkedEvidence(scope, fields.evidence);
  const before = readUserTurn(row);
  if (before === null) {
    return;
  }
  saveTurn(scope, row, before, null, evidence);
}
