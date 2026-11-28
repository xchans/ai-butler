// 진척. 요청마다 한 줄이고, 지금 어디까지 왔는지를 비서가 쓴다.
import type { WriteScope } from "./changes.ts";
import { LedgerError } from "./errors.ts";
import { checkedFields, optionalText } from "./input.ts";
import { existingRequest } from "./lookup.ts";

export type SetProgressInput = {
  readonly requestId: string;
  /** 지금 어디까지 왔는지. null이면 비운다. */
  readonly progress: string | null;
};

/** 요청의 진척을 쓴다. 비서만 쓰고 사용자 지정을 두지 않는다. 바뀐 내역은 변경 이력에 남는다. */
export function setProgress(scope: WriteScope, input: SetProgressInput): void {
  const fields = checkedFields(input, "setProgress의 인자", ["requestId", "progress"]);
  if (scope.actor.kind !== "assistant") {
    throw new LedgerError("requires_assistant", "진척은 비서만 쓴다");
  }
  if (fields.progress === undefined) {
    throw new LedgerError("invalid_argument", "진척(progress)을 적어야 한다. 비우려면 null을 준다");
  }
  const row = existingRequest(scope, fields.requestId);
  const requestId = String(row.id);
  const before = (row.progress as string | null) ?? null;
  const after = optionalText(fields.progress, "진척(progress)");
  if (before === after) {
    return;
  }
  scope.run("UPDATE requests SET progress = ? WHERE id = ?", after, requestId);
  scope.record({
    target: { kind: "request", id: requestId },
    requestId,
    before: { progress: before },
    after: { progress: after },
  });
}
