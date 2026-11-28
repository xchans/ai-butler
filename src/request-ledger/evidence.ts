// 쓰기에 단 근거를 확인한다. 원장은 근거가 달렸는지, 근거로 달 수 있는 기록인지, 시각만 본다.
// 그 근거가 실제로 무엇을 뜻하는지는 판단 모듈이 정한다.
import type { WriteScope } from "./changes.ts";
import { LedgerError } from "./errors.ts";
import { checkedFields, everyItem, requiredText } from "./input.ts";
import { latestOf } from "./ordering.ts";
import type { EvidenceRef, JsonValue } from "./types.ts";

/** 직접 맡긴 말의 출처. 이 출처의 기록은 접수 원본으로만 연결하고 어떤 쓰기의 근거로도 달 수 없다. */
export const CONVERSATION_SOURCE = "conversation";

/** 확인을 마친 근거. */
export type CheckedEvidence = {
  /** 변경 이력에 저장할 근거 참조. */
  readonly refs: readonly EvidenceRef[];
  /** 판본 근거마다 판본의 식별자와 원본 시각. 근거를 하나씩 가려 세는 규칙이 쓴다. */
  readonly revisions: readonly { readonly revisionId: string; readonly originalAt: string }[];
  /** 판본 근거들의 원본 시각. 근거의 시각을 따지는 규칙이 쓴다. */
  readonly revisionTimes: readonly string[];
  /** 판본 근거 가운데 가장 늦은 원본 시각. 판본 근거가 없으면 null. */
  readonly latestAt: string | null;
};

export const NO_EVIDENCE: CheckedEvidence = {
  refs: [],
  revisions: [],
  revisionTimes: [],
  latestAt: null,
};

/**
 * 쓰기에 단 근거의 형태와, 근거로 달 수 있는 것인지 확인한다.
 * 비서의 쓰기에는 판본만 달 수 있고, 사용자 확인과 확인할 사항의 답은 사용자의 쓰기에만 붙는다.
 */
export function checkedEvidence(scope: WriteScope, given: unknown): CheckedEvidence {
  if (given === undefined) {
    return NO_EVIDENCE;
  }
  const refs: EvidenceRef[] = [];
  const revisions: { revisionId: string; originalAt: string }[] = [];
  for (const item of everyItem(given, "근거(evidence)")) {
    const kind: unknown = (item as { kind?: unknown } | null)?.kind;
    if (kind === "revision") {
      const { revisionId } = checkedFields(item, "판본 근거", ["kind", "revisionId"]);
      const id = requiredText(revisionId, "근거의 revisionId");
      const revision = scope.get(
        `SELECT revisions.original_at, records.source
           FROM revisions JOIN records ON records.id = revisions.record_id
          WHERE revisions.id = ?`,
        id,
      );
      if (revision === undefined) {
        throw new LedgerError("evidence_not_found", `근거로 단 판본이 없다 (${id})`);
      }
      if (revision.source === CONVERSATION_SOURCE) {
        throw new LedgerError("evidence_not_allowed", "직접 맡긴 말은 근거로 달 수 없다");
      }
      refs.push({ kind, revisionId: id });
      revisions.push({ revisionId: id, originalAt: String(revision.original_at) });
    } else if (kind === "user_confirmation") {
      checkedFields(item, "사용자 확인 근거", ["kind"]);
      if (scope.actor.kind !== "user") {
        throw new LedgerError("evidence_not_allowed", "사용자 확인은 사용자의 쓰기에만 붙는다");
      }
      refs.push({ kind });
    } else if (kind === "answer") {
      const { openItemId } = checkedFields(item, "답 근거", ["kind", "openItemId"]);
      const id = requiredText(openItemId, "근거의 openItemId");
      if (scope.actor.kind !== "user") {
        throw new LedgerError(
          "evidence_not_allowed",
          "확인할 사항의 답은 사용자의 쓰기에만 붙는다",
        );
      }
      const openItem = scope.get("SELECT resolved_at FROM open_items WHERE id = ?", id);
      if (openItem === undefined) {
        throw new LedgerError("evidence_not_found", `근거로 단 확인할 사항이 없다 (${id})`);
      }
      if (openItem.resolved_at === null) {
        throw new LedgerError(
          "evidence_not_allowed",
          "아직 답하지 않은 확인할 사항은 근거가 아니다",
        );
      }
      refs.push({ kind, openItemId: id });
    } else {
      throw new LedgerError(
        "invalid_argument",
        "근거의 종류(kind)는 revision, user_confirmation, answer 가운데 하나다",
      );
    }
  }
  const revisionTimes = revisions.map((revision) => revision.originalAt);
  return { refs, revisions, revisionTimes, latestAt: latestOf(revisionTimes) };
}

/**
 * 작업의 지금 완료나 취소에 단 근거를 찾는 조회. 그 쓰기의 쓰기 순번, 대상인 작업, 쓰기 이름으로 찾는다.
 * 한 쓰기 안에서 대상과 쓰기 이름이 같은 건은 하나뿐이므로, 답하면서 같은 작업을 고치고 완료해도
 * 고칠 때 단 근거가 섞이지 않는다.
 */
export const FINISH_EVIDENCE_SQL = `
  SELECT evidence FROM changes
   WHERE write_seq = ? AND target_kind = 'task' AND target_id = ? AND action = ?
   ORDER BY seq`;

/** 그 상태를 쓴 쓰기의 이름. 완료는 `completeTask`, 취소는 `cancelTask`다. */
export function finishAction(status: unknown): "completeTask" | "cancelTask" {
  return status === "done" ? "completeTask" : "cancelTask";
}

/** 변경 이력에 저장할 형태. */
export function evidenceJson(evidence: CheckedEvidence): JsonValue[] {
  return evidence.refs.map((ref) => ({ ...ref }));
}
