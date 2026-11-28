// 쓰기 안에서 대상을 찾는 도우미다. 없는 대상을 가리킨 쓰기는 오류로 거부한다.
import type { Row, WriteScope } from "./changes.ts";
import { LedgerError } from "./errors.ts";
import { requiredText } from "./input.ts";

export function existingRequest(scope: WriteScope, requestId: unknown): Row {
  const id = requiredText(requestId, "requestId");
  const row = scope.get("SELECT * FROM requests WHERE id = ?", id);
  if (row === undefined) {
    throw new LedgerError("request_not_found", `요청이 없다 (${id})`);
  }
  return row;
}

export function existingTask(scope: WriteScope, taskId: unknown): Row {
  const id = requiredText(taskId, "taskId");
  const row = scope.get("SELECT * FROM tasks WHERE id = ?", id);
  if (row === undefined) {
    throw new LedgerError("task_not_found", `작업이 없다 (${id})`);
  }
  return row;
}

/**
 * 요청에 딸린 것(연결, 확인할 사항, 알릴 일, 준비 자료)이 작업 하나를 가리킬 때 그 작업을 확인한다.
 * 작업을 가리키면 그 작업은 같은 요청에 속해야 한다. 가리키지 않으면 null.
 */
export function taskOfRequest(
  scope: WriteScope,
  requestId: string,
  taskId: unknown,
): string | null {
  if (taskId === undefined || taskId === null) {
    return null;
  }
  const task = existingTask(scope, taskId);
  if (task.request_id !== requestId) {
    throw new LedgerError(
      "task_not_in_request",
      `작업(${String(task.id)})이 그 요청(${requestId})에 속하지 않는다`,
    );
  }
  return String(task.id);
}

export function existingRecord(scope: WriteScope, recordId: unknown): Row {
  const id = requiredText(recordId, "recordId");
  const row = scope.get("SELECT * FROM records WHERE id = ?", id);
  if (row === undefined) {
    throw new LedgerError("record_not_found", `기록이 없다 (${id})`);
  }
  return row;
}

export function existingOpenItem(scope: WriteScope, openItemId: unknown): Row {
  const id = requiredText(openItemId, "openItemId");
  const row = scope.get("SELECT * FROM open_items WHERE id = ?", id);
  if (row === undefined) {
    throw new LedgerError("open_item_not_found", `확인할 사항이 없다 (${id})`);
  }
  return row;
}

/** 걸려 있는 보류를 찾는다. 푼 보류는 줄을 지우므로 없는 보류다. */
export function existingHold(scope: WriteScope, holdId: unknown): Row {
  const id = requiredText(holdId, "holdId");
  const row = scope.get("SELECT * FROM holds WHERE id = ?", id);
  if (row === undefined) {
    throw new LedgerError("hold_not_found", `보류가 없다 (${id}). 이미 푼 보류일 수 있다`);
  }
  return row;
}
