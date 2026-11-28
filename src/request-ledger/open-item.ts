// 확인할 사항. 요청이나 작업에 달린 미결 사항이고, 비서가 남기고 사용자가 답해 푼다.
import { checkedReason, type WriteScope } from "./changes.ts";
import { LedgerError } from "./errors.ts";
import { type PlaceHoldInput, placeHold, type ReleaseHoldInput, releaseHold } from "./hold.ts";
import { checkedFields, distinctTexts, everyItem, oneOf, requiredText } from "./input.ts";
import {
  existingHold,
  existingOpenItem,
  existingRequest,
  existingTask,
  taskOfRequest,
} from "./lookup.ts";
import {
  type SetOrderInput,
  type SetPriorityInput,
  setOrder,
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
import { type ClearTurnInput, clearTurn, type SetTurnInput, setTurn } from "./turn.ts";
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
 * 그 답이 근거로 붙는다. 요청의 값과 작업의 값, 완료와 취소, 보류 걸고 풀기, 차례 정하고 지우기, 처리 순서다.
 */
export type FollowUpWrite =
  | { readonly action: "updateRequest"; readonly input: Reasoned<UpdateRequestInput> }
  | { readonly action: "setPriority"; readonly input: Reasoned<SetPriorityInput> }
  | { readonly action: "setOrder"; readonly input: Reasoned<SetOrderInput> }
  | { readonly action: "updateTask"; readonly input: Reasoned<UpdateTaskInput> }
  | { readonly action: "completeTask"; readonly input: Reasoned<CompleteTaskInput> }
  | { readonly action: "cancelTask"; readonly input: Reasoned<CancelTaskInput> }
  | { readonly action: "setTurn"; readonly input: Reasoned<SetTurnInput> }
  | { readonly action: "clearTurn"; readonly input: Reasoned<ClearTurnInput> }
  | { readonly action: "placeHold"; readonly input: Reasoned<PlaceHoldInput> }
  | { readonly action: "releaseHold"; readonly input: Reasoned<ReleaseHoldInput> };

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

type FollowUpInput = Record<string, unknown>;

/** 함께 바꾸는 쓰기 하나가 쓰는 대상. 종류와 식별자로 가린다. */
type FollowUpTarget = {
  /** 대상의 종류. 요청과 작업, 보류는 식별자를 따로 쓰므로 식별자 문자열이 같아도 종류가 다르면 다른 대상이다. */
  readonly kind: "request" | "task" | "hold";
  readonly id: string;
};

type FollowUp = {
  readonly write: (scope: WriteScope, input: never) => unknown;
  /**
   * 인자가 가리키는 대상. 한 대상에 같은 쓰기를 두 번 넣었는지 가리는 데 쓴다.
   * 식별자의 형태를 먼저 검사해 문자열로 얻는다. 문자열이 아니거나 빈 식별자는 직접 부를 때처럼 `invalid_argument`다.
   * 대상을 찾기 전에 인자에서 읽는다. 앞선 쓰기가 지운 대상(푼 보류)을 다시 가리켜도 같은 대상으로 본다.
   */
  readonly target: (input: FollowUpInput) => FollowUpTarget;
  /**
   * 대상이 속한 요청들. 모두 그 확인할 사항이 달린 요청이어야 한다. 없는 대상이면 그 대상의 오류를 던진다.
   */
  readonly requestIds: (scope: WriteScope, input: FollowUpInput) => string[];
};

function requestTarget(input: FollowUpInput): FollowUpTarget {
  return { kind: "request", id: requiredText(input.requestId, "requestId") };
}

function taskTarget(input: FollowUpInput): FollowUpTarget {
  return { kind: "task", id: requiredText(input.taskId, "taskId") };
}

function requestOf(scope: WriteScope, input: FollowUpInput): string[] {
  return [String(existingRequest(scope, input.requestId).id)];
}

function requestOfTask(scope: WriteScope, input: FollowUpInput): string[] {
  return [String(existingTask(scope, input.taskId).request_id)];
}

/** 요청의 값을 쓰는 쓰기. 대상은 요청이다. */
function onRequest(write: FollowUp["write"]): FollowUp {
  return { write, target: requestTarget, requestIds: requestOf };
}

/** 작업의 값을 쓰는 쓰기. 대상은 작업이다. */
function onTask(write: FollowUp["write"]): FollowUp {
  return { write, target: taskTarget, requestIds: requestOfTask };
}

const givesTask = (input: FollowUpInput): boolean =>
  input.taskId !== undefined && input.taskId !== null;

const FOLLOW_UPS: Record<FollowUpWrite["action"], FollowUp> = {
  updateRequest: onRequest(updateRequest),
  setPriority: onRequest(setPriority),
  setOrder: onRequest(setOrder),
  updateTask: onTask(updateTask),
  completeTask: onTask(completeTask),
  cancelTask: onTask(cancelTask),
  setTurn: onTask(setTurn),
  clearTurn: onTask(clearTurn),
  // 보류를 거는 대상은 보류할 요청이고, 작업을 보류하면 그 작업이다. 요청과 작업이 모두 그 요청의 것이어야 한다.
  placeHold: {
    write: placeHold,
    target: (input) => (givesTask(input) ? taskTarget(input) : requestTarget(input)),
    requestIds: (scope, input) => [
      ...requestOf(scope, input),
      ...(givesTask(input) ? requestOfTask(scope, input) : []),
    ],
  },
  // 보류를 푸는 대상은 그 보류다. 보류가 속한 요청으로 확인한다.
  releaseHold: {
    write: releaseHold,
    target: (input) => ({ kind: "hold", id: requiredText(input.holdId, "holdId") }),
    requestIds: (scope, input) => [String(existingHold(scope, input.holdId).request_id)],
  },
};

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
    const followUpWrite = FOLLOW_UPS[name];
    // 식별자를 검사해 얻은 뒤에 키를 만든다. 키는 쓰기 이름, 대상의 종류, 식별자다.
    const target = followUpWrite.target(rest);
    const key = JSON.stringify([name, target.kind, target.id]);
    if (written.has(key)) {
      throw new LedgerError(
        "duplicate_change",
        `답하면서 한 대상에 같은 쓰기를 두 번 넣을 수 없다 (${name}, ${target.kind} ${target.id})`,
      );
    }
    written.add(key);
    if (followUpWrite.requestIds(scope, rest).some((id) => id !== requestId)) {
      throw new LedgerError(
        "change_outside_request",
        "답하면서 함께 바꿀 수 있는 것은 그 확인할 사항이 달린 요청과 그 요청의 작업뿐이다",
      );
    }
    // 그 답을 근거로 붙인다. 호출한 쪽이 단 근거는 그대로 둔다. 쓰기마다의 권한과 근거 검사는 그 쓰기가 한다.
    const evidence = [...everyItem(given, "근거(evidence)"), { kind: "answer", openItemId }];
    (followUpWrite.write as (scope: WriteScope, input: unknown) => unknown)(
      scopeFor(scope, name, checkedReason(reason)),
      { ...rest, evidence },
    );
  }
}
