// 보류. 요청이나 작업에 사용자가 건 멈춤과 재개 조건이다. 상태가 아니라 상태 위에 얹는 표시다.
// 보류 하나하나를 따로 저장하고, 한 대상에 여럿 걸릴 수 있다. 풀면 줄을 지우고 변경 이력에만 남긴다.
import type { Row, WriteScope } from "./changes.ts";
import { LedgerError } from "./errors.ts";
import { checkedEvidence, evidenceJson } from "./evidence.ts";
import { checkedFields, optionalText } from "./input.ts";
import { existingHold, existingRequest, existingTask, taskOfRequest } from "./lookup.ts";
import { anyAfter } from "./ordering.ts";
import type { WriteGrounds } from "./request.ts";
import type { JsonValue } from "./types.ts";

export type PlaceHoldInput = WriteGrounds & {
  /** 보류할 요청. 작업을 보류할 때는 그 작업이 속한 요청이다. */
  readonly requestId: string;
  /** 작업 하나를 보류하면 그 작업. 없으면 요청에 건다. 요청을 보류하면 그 요청의 모든 작업이 보류된 것으로 본다. */
  readonly taskId?: string | null;
  /** 사용자가 미리 정한 재개 조건. 없으면 사용자가 직접 풀 때까지 둔다. */
  readonly resumeCondition?: string | null;
};

export type PlaceHoldResult = { readonly id: string };

export type ReleaseHoldInput = WriteGrounds & {
  /** 풀 보류. 어느 보류인지 식별자로 가리킨다. */
  readonly holdId: string;
  /**
   * 작업 하나에서 푸는 것이면 그 작업. 그 작업에 건 보류여야 한다.
   * 요청에 건 보류는 작업 하나에서만 풀 수 없으므로, 요청의 보류를 가리키면서 작업을 적으면 거부한다.
   */
  readonly taskId?: string | null;
};

/** 변경 이력에 적는 보류 한 줄의 내용. */
function holdSnapshot(row: Row): JsonValue {
  return {
    requestId: String(row.request_id),
    taskId: (row.task_id as string | null) ?? null,
    resumeCondition: (row.resume_condition as string | null) ?? null,
    placedAt: String(row.placed_at),
  };
}

/** 보류를 건다. 보류는 사용자의 지시다. 비서는 걸 수 없다. */
export function placeHold(scope: WriteScope, input: PlaceHoldInput): PlaceHoldResult {
  const fields = checkedFields(input, "placeHold의 인자", [
    "requestId",
    "taskId",
    "resumeCondition",
    "evidence",
  ]);
  if (scope.actor.kind !== "user") {
    throw new LedgerError("requires_user", "보류는 사용자만 걸 수 있다");
  }
  const requestId = String(existingRequest(scope, fields.requestId).id);
  const taskId = taskOfRequest(scope, requestId, fields.taskId);
  const resumeCondition = optionalText(fields.resumeCondition, "재개 조건(resumeCondition)");
  const evidence = checkedEvidence(scope, fields.evidence);
  const id = scope.newId();
  scope.run(
    `INSERT INTO holds (id, request_id, task_id, resume_condition, placed_at)
     VALUES (?, ?, ?, ?, ?)`,
    id,
    requestId,
    taskId,
    resumeCondition,
    scope.at,
  );
  scope.record({
    target: { kind: "hold", id },
    requestId,
    before: null,
    after: { requestId, taskId, resumeCondition, placedAt: scope.at },
    evidence: evidenceJson(evidence),
  });
  return { id };
}

/**
 * 보류를 푼다. 사용자는 언제든 푼다. 비서는 재개 조건이 있는 보류만, 재개 조건이 이루어졌음을 보여 주는 근거로
 * 원본 시각이 그 보류를 건 시각보다 뒤인 판본을 달았을 때 푼다. 재개 조건이 없는 보류는 비서가 풀 수 없다.
 * 요청에 건 보류를 작업 하나에서만 풀 수는 없다.
 */
export function releaseHold(scope: WriteScope, input: ReleaseHoldInput): void {
  const fields = checkedFields(input, "releaseHold의 인자", ["holdId", "taskId", "evidence"]);
  const row = existingHold(scope, fields.holdId);
  const holdId = String(row.id);
  if (fields.taskId !== undefined && fields.taskId !== null) {
    const taskId = String(existingTask(scope, fields.taskId).id);
    if (row.task_id !== taskId) {
      throw new LedgerError(
        "hold_not_on_task",
        row.task_id === null
          ? "요청에 건 보류는 작업 하나에서만 풀 수 없다. 작업을 가리키지 않고 요청의 보류를 푼다"
          : `보류(${holdId})가 그 작업(${taskId})에 건 것이 아니다`,
      );
    }
  }
  const evidence = checkedEvidence(scope, fields.evidence);
  if (scope.actor.kind !== "user") {
    if (row.resume_condition === null) {
      throw new LedgerError(
        "hold_without_resume_condition",
        "재개 조건이 없는 보류는 사용자만 풀 수 있다",
      );
    }
    if (evidence.revisionTimes.length === 0) {
      throw new LedgerError(
        "evidence_required",
        "비서가 보류를 풀려면 재개 조건이 이루어졌음을 보여 주는 판본을 근거로 달아야 한다",
      );
    }
    // 물려받은 보류도 원래 건 시각을 그대로 저장하므로 이 시각과 비교한다.
    if (!anyAfter(evidence.revisionTimes, String(row.placed_at))) {
      throw new LedgerError(
        "evidence_too_early",
        "보류를 푸는 근거는 원본 시각이 그 보류를 건 시각보다 뒤인 판본이어야 한다",
      );
    }
  }
  scope.run("DELETE FROM holds WHERE id = ?", holdId);
  scope.record({
    target: { kind: "hold", id: holdId },
    requestId: String(row.request_id),
    before: holdSnapshot(row),
    after: null,
    evidence: evidenceJson(evidence),
  });
}
