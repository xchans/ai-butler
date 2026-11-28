// 확인할 사항. 요청이나 작업에 달린 미결 사항이고, 비서가 남기고 사용자가 답해 푼다.
import { checkedReason, type WriteScope } from "./changes.ts";
import { LedgerError } from "./errors.ts";
import { checkedFields, distinctTexts, everyItem, oneOf, requiredText } from "./input.ts";
import { existingOpenItem, existingRequest, existingTask, taskOfRequest } from "./lookup.ts";
import {
  type SetPriorityInput,
  setPriority,
  type UpdateRequestInput,
  updateRequest,
} from "./request.ts";
import {
  type CancelTaskInput,
  type CompleteTaskInput,
  cancelTask,
  completeTask,
  type UpdateTaskInput,
  updateTask,
} from "./task.ts";
import type { Reasoned } from "./types.ts";

export const OPEN_ITEM_KINDS = ["question", "approval", "unverified", "mismatch"] as const;

/**
 * 확인할 사항의 종류. 질문(판단할 수 없어 사용자에게 묻는 것), 승인(사용자의 승인이나 추가 권한이 있어야 이어 갈 수 있는 것),
 * 미확인(기록이 어긋나거나 접근할 수 없어 확인하지 못한 것), 어긋남(사용자의 표시와 기록이 다른 것)이다.
 */
export type OpenItemKind = (typeof OPEN_ITEM_KINDS)[number];

export type RaiseOpenItemInput = {
  readonly requestId: string;
  /** 작업에 달린 것이면 그 작업. 그 요청의 작업이어야 한다. */
  readonly taskId?: string | null;
  readonly kind: OpenItemKind;
  readonly content: string;
  /** 선택지. */
  readonly options?: readonly string[];
};

export type RaiseOpenItemResult = { readonly id: string };

/**
 * 답에 따라 함께 바꾸는 값. 답과 한 트랜잭션으로 저장하고, 변경 이력에는 그 값을 쓰는 함수의 이름으로 남으며
 * 그 답이 근거로 붙는다.
 */
export type FollowUpWrite =
  | { readonly action: "updateRequest"; readonly input: Reasoned<UpdateRequestInput> }
  | { readonly action: "setPriority"; readonly input: Reasoned<SetPriorityInput> }
  | { readonly action: "updateTask"; readonly input: Reasoned<UpdateTaskInput> }
  | { readonly action: "completeTask"; readonly input: Reasoned<CompleteTaskInput> }
  | { readonly action: "cancelTask"; readonly input: Reasoned<CancelTaskInput> };

export type ResolveOpenItemInput = {
  readonly openItemId: string;
  /** 사용자의 답. */
  readonly answer: string;
  /**
   * 답하면서 함께 바꾸는 값들. 하나라도 거부되면 답도 저장되지 않는다.
   * 그 확인할 사항이 달린 요청과 그 요청의 작업만 바꿀 수 있고, 한 대상에 같은 쓰기를 두 번 넣을 수 없다.
   */
  readonly changes?: readonly FollowUpWrite[];
};

/** 확인할 사항을 남긴다. 비서만 남긴다. */
export function raiseOpenItem(scope: WriteScope, input: RaiseOpenItemInput): RaiseOpenItemResult {
  const fields = checkedFields(input, "raiseOpenItem의 인자", [
    "requestId",
    "taskId",
    "kind",
    "content",
    "options",
  ]);
  if (scope.actor.kind !== "assistant") {
    throw new LedgerError("requires_assistant", "확인할 사항은 비서만 남긴다");
  }
  const requestId = String(existingRequest(scope, fields.requestId).id);
  const taskId = taskOfRequest(scope, requestId, fields.taskId);
  const kind = oneOf(fields.kind, "확인할 사항의 종류(kind)", OPEN_ITEM_KINDS);
  const content = requiredText(fields.content, "확인할 사항의 내용(content)");
  const options = fields.options === undefined ? null : distinctTexts(fields.options, "선택지");
  const id = scope.newId();
  scope.run(
    `INSERT INTO open_items (id, request_id, task_id, kind, content, options, raised_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    requestId,
    taskId,
    kind,
    content,
    options === null ? null : JSON.stringify(options),
    scope.at,
  );
  scope.record({
    target: { kind: "open_item", id },
    requestId,
    before: null,
    after: { requestId, taskId, kind, content, options, raisedAt: scope.at },
  });
  return { id };
}

/**
 * 값 변경을 그 값을 쓰는 함수의 이름과 그 값 변경의 사유로 남기는 scope.
 * 쓰기 순번은 같아 한 쓰기임을 알 수 있다.
 */
function scopeFor(
  scope: WriteScope,
  action: FollowUpWrite["action"],
  reason: string | null,
): WriteScope {
  return {
    ...scope,
    action,
    reason,
    record: (entry) =>
      scope.record({
        ...entry,
        action,
        reason: entry.reason === undefined ? reason : entry.reason,
      }),
  };
}

const FOLLOW_UPS = {
  updateRequest,
  setPriority,
  updateTask,
  completeTask,
  cancelTask,
} as const;

/** 요청의 값을 쓰는 쓰기. 나머지는 작업의 값을 쓴다. */
const ON_REQUEST: readonly FollowUpWrite["action"][] = ["updateRequest", "setPriority"];

/**
 * 확인할 사항에 답해 푼다. 사용자만 답하고, 이미 푼 것에 다시 답하면 거부한다.
 * 답에 따라 값을 바꿀 때는 답과 값 변경을 한 트랜잭션으로 저장하고, 값 변경의 변경 이력에 그 답을 근거로 남긴다.
 * 함께 바꿀 수 있는 것은 그 확인할 사항이 달린 요청과 그 요청의 작업이고, 한 대상에 같은 쓰기를 두 번 넣을 수 없다.
 */
export function resolveOpenItem(scope: WriteScope, input: ResolveOpenItemInput): void {
  const fields = checkedFields(input, "resolveOpenItem의 인자", [
    "openItemId",
    "answer",
    "changes",
  ]);
  if (scope.actor.kind !== "user") {
    throw new LedgerError("requires_user", "확인할 사항은 사용자만 답해 푼다");
  }
  const row = existingOpenItem(scope, fields.openItemId);
  const openItemId = String(row.id);
  const requestId = String(row.request_id);
  if (row.resolved_at !== null) {
    throw new LedgerError(
      "open_item_already_resolved",
      "이미 푼 확인할 사항에는 다시 답할 수 없다",
    );
  }
  const answer = requiredText(fields.answer, "답(answer)");
  const followUps = everyItem(fields.changes, "함께 바꾸는 값(changes)");
  scope.run(
    "UPDATE open_items SET answer = ?, resolved_at = ? WHERE id = ?",
    answer,
    scope.at,
    openItemId,
  );
  scope.record({
    target: { kind: "open_item", id: openItemId },
    requestId,
    before: { answer: null, resolvedAt: null },
    after: { answer, resolvedAt: scope.at },
  });
  // 한 쓰기 안에서 대상과 쓰기 이름이 같은 변경 이력은 하나뿐이어야, 어느 쓰기에 단 근거인지 가릴 수 있다.
  const written = new Set<string>();
  for (const followUp of followUps) {
    const { action, input: followUpInput } = checkedFields(followUp, "함께 바꾸는 값", [
      "action",
      "input",
    ]);
    const name = oneOf(
      action,
      "함께 바꾸는 값의 쓰기(action)",
      Object.keys(FOLLOW_UPS) as FollowUpWrite["action"][],
    );
    if (
      typeof followUpInput !== "object" ||
      followUpInput === null ||
      Array.isArray(followUpInput)
    ) {
      throw new LedgerError("invalid_argument", "함께 바꾸는 값의 인자(input)는 객체여야 한다");
    }
    const { reason, evidence: given, ...rest } = followUpInput as Record<string, unknown>;
    const onRequest = ON_REQUEST.includes(name);
    const target = onRequest
      ? existingRequest(scope, rest.requestId)
      : existingTask(scope, rest.taskId);
    if ((onRequest ? target.id : target.request_id) !== requestId) {
      throw new LedgerError(
        "change_outside_request",
        "답하면서 함께 바꿀 수 있는 것은 그 확인할 사항이 달린 요청과 그 요청의 작업뿐이다",
      );
    }
    const key = JSON.stringify([name, target.id]);
    if (written.has(key)) {
      throw new LedgerError(
        "duplicate_change",
        `답하면서 한 대상에 같은 쓰기를 두 번 넣을 수 없다 (${name}, ${String(target.id)})`,
      );
    }
    written.add(key);
    // 그 답을 근거로 붙인다. 호출한 쪽이 단 근거는 그대로 둔다.
    const evidence = [...everyItem(given, "근거(evidence)"), { kind: "answer", openItemId }];
    (FOLLOW_UPS[name] as (scope: WriteScope, input: unknown) => void)(
      scopeFor(scope, name, checkedReason(reason)),
      { ...rest, evidence },
    );
  }
}
