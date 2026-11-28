// 기록과 요청의 연결. 기록이 어느 요청(필요하면 어느 작업)에 속하는지와 그 역할을 저장한다.
import type { Row, WriteScope } from "./changes.ts";
import { LedgerError } from "./errors.ts";
import { CONVERSATION_SOURCE } from "./evidence.ts";
import { checkedFields, oneOf } from "./input.ts";
import { existingRecord, existingRequest, taskOfRequest } from "./lookup.ts";

export const LINK_ROLES = ["intake", "progress", "completion_evidence", "delivery"] as const;

/** 연결의 역할. 접수 원본, 진행 기록, 완료 근거, 결과 전달이다. */
export type LinkRole = (typeof LINK_ROLES)[number];

export type LinkRecordInput = {
  readonly recordId: string;
  readonly requestId: string;
  /** 작업 하나에 속하면 그 작업. 그 요청의 작업이어야 한다. */
  readonly taskId?: string | null;
  readonly role: LinkRole;
};

export type LinkRecordResult = {
  readonly id: string;
  /** 연결을 새로 만들었으면 true. 같은 연결이 이미 있어 그대로 돌려줬으면 false. */
  readonly added: boolean;
};

/**
 * 기록 하나를 요청(과 작업)에 한 역할로 연결한다. 받는 쪽은 대상이 있는지 이미 확인했다.
 * 같은 연결이 이미 있으면 그 연결을 돌려준다. 비서가 다시 연결하면 아무것도 바꾸지 않고,
 * 사용자가 다시 연결하면 사용자가 정한 연결로 표시한다.
 */
export function connectRecord(
  scope: WriteScope,
  record: Row,
  requestId: string,
  taskId: string | null,
  role: LinkRole,
): LinkRecordResult {
  const recordId = String(record.id);
  if (record.source === CONVERSATION_SOURCE && role !== "intake") {
    throw new LedgerError(
      "conversation_record_intake_only",
      "직접 맡긴 말은 접수 원본으로만 연결한다",
    );
  }
  const byUser = scope.actor.kind === "user";
  const existing = scope.get(
    `SELECT id, user_set FROM links
      WHERE record_id = ? AND request_id = ? AND role = ? AND task_id IS ?`,
    recordId,
    requestId,
    role,
    taskId,
  );
  if (existing !== undefined) {
    const id = String(existing.id);
    if (byUser && existing.user_set === 0) {
      scope.run("UPDATE links SET user_set = 1 WHERE id = ?", id);
      scope.record({
        target: { kind: "link", id },
        requestId,
        before: { userSet: false },
        after: { userSet: true },
      });
    }
    return { id, added: false };
  }
  const id = scope.newId();
  scope.run(
    `INSERT INTO links (id, record_id, request_id, task_id, role, user_set)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    recordId,
    requestId,
    taskId,
    role,
    byUser ? 1 : 0,
  );
  // 제목을 마지막으로 쓴 뒤에 기록이 연결됐는지 가리는 데 쓴다.
  scope.run("UPDATE requests SET added_seq = ? WHERE id = ?", scope.seq, requestId);
  scope.record({
    target: { kind: "link", id },
    requestId,
    before: null,
    after: { recordId, requestId, taskId, role, userSet: byUser },
  });
  return { id, added: true };
}

/** 기록을 요청(필요하면 그 요청의 작업)에 연결한다. 사용자가 만든 연결은 사용자가 정한 것으로 표시한다. */
export function linkRecord(scope: WriteScope, input: LinkRecordInput): LinkRecordResult {
  const fields = checkedFields(input, "linkRecord의 인자", [
    "recordId",
    "requestId",
    "taskId",
    "role",
  ]);
  const role = oneOf(fields.role, "연결의 역할(role)", LINK_ROLES);
  const record = existingRecord(scope, fields.recordId);
  const requestId = String(existingRequest(scope, fields.requestId).id);
  const taskId = taskOfRequest(scope, requestId, fields.taskId);
  return connectRecord(scope, record, requestId, taskId, role);
}
