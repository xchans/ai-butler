// 알릴 일. 사용자에게 전할 일이고, 전하는 일은 화면이 한다.

import type { Row, WriteScope } from "./changes.ts";
import type { LedgerDb } from "./db.ts";
import { LedgerError } from "./errors.ts";
import { checkedFields, oneOf, optionalText, requiredText } from "./input.ts";
import { existingOpenItem, existingRequest, taskOfRequest } from "./lookup.ts";

export const NOTICE_KINDS = [
  "new_request",
  "my_turn",
  "open_item",
  "verified_result",
  "closed",
] as const;

/** 알릴 일의 종류. 새 요청, 내 차례, 확인할 사항, 확인된 결과, 닫힘이다. */
export type NoticeKind = (typeof NOTICE_KINDS)[number];

export const NOTICE_STATES = ["undelivered", "unseen", "seen"] as const;

/** 알릴 일이 어디까지 갔는지. 전하지 않은 것, 전했지만 사용자가 보지 않은 것, 사용자가 본 것이다. */
export type NoticeState = (typeof NOTICE_STATES)[number];

export type AddNoticeInput = {
  /** 어느 요청에 대한 것인지. */
  readonly requestId: string;
  /** 작업에 대한 것이면 그 작업. */
  readonly taskId?: string | null;
  /** 확인할 사항에 대한 것이면 그 확인할 사항. */
  readonly openItemId?: string | null;
  readonly kind: NoticeKind;
  /** 전할 내용. */
  readonly content: string;
};

export type AddNoticeResult = { readonly id: string };

export type MarkNoticeInput = { readonly noticeId: string };

export type ListNoticesFilter = {
  /** 이 상태인 것만. */
  readonly state?: NoticeState;
  /** 이 요청에 대한 것만. */
  readonly requestId?: string;
};

/** 알릴 일 하나. 대상과 내용이 함께 나온다. */
export type Notice = {
  readonly id: string;
  readonly requestId: string;
  readonly taskId: string | null;
  readonly openItemId: string | null;
  readonly kind: NoticeKind;
  readonly content: string;
  /** 만든 시각. */
  readonly createdAt: string;
  /** 전한 시각. 아직 전하지 않았으면 null. */
  readonly deliveredAt: string | null;
  /** 사용자가 본 시각. 아직 보지 않았으면 null. */
  readonly seenAt: string | null;
  readonly state: NoticeState;
};

/** 알릴 일을 남긴다. */
export function addNotice(scope: WriteScope, input: AddNoticeInput): AddNoticeResult {
  const fields = checkedFields(input, "addNotice의 인자", [
    "requestId",
    "taskId",
    "openItemId",
    "kind",
    "content",
  ]);
  const requestId = String(existingRequest(scope, fields.requestId).id);
  const taskId = taskOfRequest(scope, requestId, fields.taskId);
  let openItemId: string | null = null;
  if (fields.openItemId !== undefined && fields.openItemId !== null) {
    const openItem = existingOpenItem(scope, fields.openItemId);
    openItemId = String(openItem.id);
    if (openItem.request_id !== requestId) {
      throw new LedgerError(
        "invalid_argument",
        `확인할 사항(${openItemId})이 그 요청(${requestId})에 속하지 않는다`,
      );
    }
    // 작업과 확인할 사항을 둘 다 가리키면 그 확인할 사항은 그 작업에 달린 것이어야 한다.
    if (taskId !== null && openItem.task_id !== taskId) {
      throw new LedgerError(
        "open_item_not_on_task",
        `확인할 사항(${openItemId})이 그 작업(${taskId})에 달린 것이 아니다`,
      );
    }
  }
  const kind = oneOf(fields.kind, "알릴 일의 종류(kind)", NOTICE_KINDS);
  const content = requiredText(fields.content, "전할 내용(content)");
  const id = scope.newId();
  scope.run(
    `INSERT INTO notices (id, request_id, task_id, open_item_id, kind, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    requestId,
    taskId,
    openItemId,
    kind,
    content,
    scope.at,
  );
  scope.record({
    target: { kind: "notice", id },
    requestId,
    before: null,
    after: { requestId, taskId, openItemId, kind, content, createdAt: scope.at },
  });
  return { id };
}

function existingNotice(scope: WriteScope, noticeId: unknown): Row {
  const id = requiredText(noticeId, "noticeId");
  const row = scope.get("SELECT * FROM notices WHERE id = ?", id);
  if (row === undefined) {
    throw new LedgerError("notice_not_found", `알릴 일이 없다 (${id})`);
  }
  return row;
}

/** 알릴 일을 전했다고 표시한다. 이미 전한 것이면 아무것도 바꾸지 않는다. */
export function markNoticeDelivered(scope: WriteScope, input: MarkNoticeInput): void {
  const fields = checkedFields(input, "markNoticeDelivered의 인자", ["noticeId"]);
  const row = existingNotice(scope, fields.noticeId);
  if (row.delivered_at !== null) {
    return;
  }
  const id = String(row.id);
  scope.run("UPDATE notices SET delivered_at = ? WHERE id = ?", scope.at, id);
  scope.record({
    target: { kind: "notice", id },
    requestId: String(row.request_id),
    before: { deliveredAt: null },
    after: { deliveredAt: scope.at },
  });
}

/**
 * 사용자가 알릴 일을 봤다고 표시한다. 사용자만 쓴다. 이미 본 것이면 아무것도 바꾸지 않는다.
 * 화면에서 먼저 봐서 아직 전하지 않은 것이면 전한 시각도 같은 시각으로 채운다.
 */
export function markNoticeSeen(scope: WriteScope, input: MarkNoticeInput): void {
  const fields = checkedFields(input, "markNoticeSeen의 인자", ["noticeId"]);
  if (scope.actor.kind !== "user") {
    throw new LedgerError("requires_user", "알릴 일을 봤다는 표시는 사용자만 한다");
  }
  const row = existingNotice(scope, fields.noticeId);
  if (row.seen_at !== null) {
    return;
  }
  const undelivered = row.delivered_at === null;
  scope.run(
    "UPDATE notices SET seen_at = ?, delivered_at = coalesce(delivered_at, ?) WHERE id = ?",
    scope.at,
    scope.at,
    String(row.id),
  );
  scope.record({
    target: { kind: "notice", id: String(row.id) },
    requestId: String(row.request_id),
    before: { seenAt: null, ...(undelivered ? { deliveredAt: null } : {}) },
    after: { seenAt: scope.at, ...(undelivered ? { deliveredAt: scope.at } : {}) },
  });
}

const STATE_CONDITIONS: Record<NoticeState, string> = {
  undelivered: "delivered_at IS NULL",
  unseen: "delivered_at IS NOT NULL AND seen_at IS NULL",
  seen: "seen_at IS NOT NULL",
};

/** 알릴 일을 만든 순서대로 돌려준다. 전하지 않은 것, 전했지만 보지 않은 것, 본 것을 따로 조회할 수 있다. */
export function listNotices(db: LedgerDb, filter: ListNoticesFilter = {}): Notice[] {
  const fields = checkedFields(filter, "listNotices의 인자", ["state", "requestId"]);
  const conditions: string[] = [];
  const params: string[] = [];
  if (fields.state !== undefined) {
    conditions.push(STATE_CONDITIONS[oneOf(fields.state, "state", NOTICE_STATES)]);
  }
  const requestId = optionalText(fields.requestId, "requestId");
  if (requestId !== null) {
    conditions.push("request_id = ?");
    params.push(requestId);
  }
  const rows = db
    .prepare(
      `SELECT id, request_id, task_id, open_item_id, kind, content, created_at, delivered_at, seen_at
         FROM notices
        ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
        ORDER BY rowid`,
    )
    .all(...params);
  return rows.map((row) => ({
    id: String(row.id),
    requestId: String(row.request_id),
    taskId: (row.task_id as string | null) ?? null,
    openItemId: (row.open_item_id as string | null) ?? null,
    kind: row.kind as NoticeKind,
    content: String(row.content),
    createdAt: String(row.created_at),
    deliveredAt: (row.delivered_at as string | null) ?? null,
    seenAt: (row.seen_at as string | null) ?? null,
    state: row.seen_at !== null ? "seen" : row.delivered_at !== null ? "unseen" : "undelivered",
  }));
}
