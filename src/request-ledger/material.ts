// 준비 자료. 요청이나 작업에 붙인 자료다.
import type { WriteScope } from "./changes.ts";
import { LedgerError } from "./errors.ts";
import { checkedFields, optionalText, requiredText } from "./input.ts";
import { existingRequest, taskOfRequest } from "./lookup.ts";
import { externalTime } from "./time.ts";
import type { TimeInput } from "./types.ts";

export type AttachMaterialInput = {
  readonly requestId: string;
  /** 작업에 붙이면 그 작업. 그 요청의 작업이어야 한다. */
  readonly taskId?: string | null;
  readonly title: string;
  readonly content: string;
  /** 출처. */
  readonly source?: string | null;
  /** 마지막으로 확인한 시각. 없으면 이 쓰기의 시각이다. */
  readonly checkedAt?: TimeInput;
};

export type AttachMaterialResult = { readonly id: string };

export type ReplaceMaterialInput = {
  readonly materialId: string;
  /** 새 내용. */
  readonly content: string;
  /** 없으면 제목은 그대로다. */
  readonly title?: string;
  /** 없으면 출처는 그대로다. null이면 비운다. */
  readonly source?: string | null;
  /** 마지막으로 확인한 시각. 없으면 이 쓰기의 시각이다. */
  readonly checkedAt?: TimeInput;
};

function checkedAt(scope: WriteScope, given: unknown): string {
  return given === undefined ? scope.at : externalTime(given, "확인한 시각(checkedAt)");
}

/** 요청이나 작업에 준비 자료를 붙인다. */
export function attachMaterial(
  scope: WriteScope,
  input: AttachMaterialInput,
): AttachMaterialResult {
  const fields = checkedFields(input, "attachMaterial의 인자", [
    "requestId",
    "taskId",
    "title",
    "content",
    "source",
    "checkedAt",
  ]);
  const requestId = String(existingRequest(scope, fields.requestId).id);
  const taskId = taskOfRequest(scope, requestId, fields.taskId);
  const material = {
    title: requiredText(fields.title, "준비 자료의 제목(title)"),
    content: requiredText(fields.content, "준비 자료의 내용(content)"),
    source: optionalText(fields.source, "준비 자료의 출처(source)"),
    checkedAt: checkedAt(scope, fields.checkedAt),
  };
  const id = scope.newId();
  scope.run(
    `INSERT INTO materials (id, request_id, task_id, title, content, source, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    requestId,
    taskId,
    material.title,
    material.content,
    material.source,
    material.checkedAt,
  );
  scope.record({
    target: { kind: "material", id },
    requestId,
    before: null,
    after: { requestId, taskId, ...material },
  });
  return { id };
}

/** 준비 자료를 새 내용으로 바꾼다. 바뀐 항목의 이전 값과 새 값이 변경 이력에 남는다. */
export function replaceMaterial(scope: WriteScope, input: ReplaceMaterialInput): void {
  const fields = checkedFields(input, "replaceMaterial의 인자", [
    "materialId",
    "content",
    "title",
    "source",
    "checkedAt",
  ]);
  const id = requiredText(fields.materialId, "materialId");
  const row = scope.get("SELECT * FROM materials WHERE id = ?", id);
  if (row === undefined) {
    throw new LedgerError("material_not_found", `준비 자료가 없다 (${id})`);
  }
  const before = {
    title: String(row.title),
    content: String(row.content),
    source: (row.source as string | null) ?? null,
    checkedAt: String(row.checked_at),
  };
  const after = {
    title:
      fields.title === undefined
        ? before.title
        : requiredText(fields.title, "준비 자료의 제목(title)"),
    content: requiredText(fields.content, "준비 자료의 내용(content)"),
    source:
      fields.source === undefined
        ? before.source
        : optionalText(fields.source, "준비 자료의 출처(source)"),
    checkedAt: checkedAt(scope, fields.checkedAt),
  };
  // 바뀐 항목만 적는다. 바꾸면 사라지는 이전 내용은 변경 이력에 그대로 남는다.
  const changed = (Object.keys(after) as (keyof typeof after)[]).filter(
    (key) => before[key] !== after[key],
  );
  if (changed.length === 0) {
    return;
  }
  scope.run(
    "UPDATE materials SET title = ?, content = ?, source = ?, checked_at = ? WHERE id = ?",
    after.title,
    after.content,
    after.source,
    after.checkedAt,
    id,
  );
  scope.record({
    target: { kind: "material", id },
    requestId: String(row.request_id),
    before: Object.fromEntries(changed.map((key) => [key, before[key]])),
    after: Object.fromEntries(changed.map((key) => [key, after[key]])),
  });
}
