// 요청 하나를 조회한다. 요청의 값과 거기 딸린 것, 변경 이력을 함께 돌려준다.
// 쓰기를 더하는 작업이 자기가 더한 것을 여기에 함께 더한다.
import { type Row, readChanges } from "./changes.ts";
import { inReadTransaction, type LedgerDb } from "./db.ts";
import { LedgerError } from "./errors.ts";
import { FINISH_EVIDENCE_SQL, finishAction } from "./evidence.ts";
import { requiredText } from "./input.ts";
import type { LinkRole } from "./link.ts";
import type { OpenItemKind } from "./open-item.ts";
import { storedParty } from "./party.ts";
import type { TaskStatus } from "./task.ts";
import type { Change, EvidenceRef, Party, SetBy } from "./types.ts";
import {
  type PriorityLevel,
  type PromisedOutcome,
  parsedValue,
  type RequestValueName,
  readValue,
} from "./value.ts";

/** 요청의 값 하나. 값과 함께 정한 주체와 사용자 지정이 나온다. */
export type ValueView<T> = {
  /** 비어 있으면 null. */
  readonly value: T | null;
  /** 지금 값을 마지막으로 쓴 쪽. 빈 값에는 없다. */
  readonly setBy: SetBy | null;
  /** 사용자 지정이 걸려 있는지. 걸려 있으면 비서는 조건을 채워야만 값을 바꿀 수 있다. */
  readonly userSet: boolean;
  /** 사용자 지정이 걸린 시각. */
  readonly userSetAt: string | null;
};

/** 판본. 원본을 읽은 내용이다. */
export type RevisionView = {
  readonly id: string;
  readonly recordId: string;
  /** 원본 시각. 원본에서 생기거나 바뀐 시각이다. */
  readonly originalAt: string;
  /** 원본 그대로의 본문. */
  readonly body: string;
  readonly url: string | null;
  readonly author: Party | null;
  /** 읽어 온 시각. */
  readonly fetchedAt: string;
};

/**
 * 근거로 달린 판본. 판단할 때 본 내용이고, 어느 기록의 판본인지 출처와 함께 나온다.
 * 요청에 연결하지 않은 기록의 판본이어도 나온다.
 */
export type CitedRevisionView = RevisionView & {
  readonly source: string;
  readonly sourceId: string;
};

/** 요청에 연결된 기록 하나와 그 판본들. 판본은 원본 시각 순서다. */
export type RecordView = {
  readonly id: string;
  readonly source: string;
  readonly sourceId: string;
  readonly revisions: readonly RevisionView[];
};

/** 기록과 요청의 연결. */
export type LinkView = {
  readonly id: string;
  readonly recordId: string;
  /** 작업 하나에 속하면 그 작업. */
  readonly taskId: string | null;
  readonly role: LinkRole;
  /** 사용자가 만든 연결인지. */
  readonly userSet: boolean;
};

/** 쓰기에 달았던 근거. 종류와 함께 나오고, 판본 근거는 판단할 때 본 판본으로 나온다. */
export type EvidenceView =
  | { readonly kind: "revision"; readonly revision: RevisionView }
  | { readonly kind: "user_confirmation" }
  | { readonly kind: "answer"; readonly openItemId: string; readonly answer: string | null };

/** 완료나 취소를 쓴 내용. */
export type FinishView = {
  /** 쓴 쪽. */
  readonly by: SetBy;
  readonly at: string;
  /** 그 쓰기에 단 근거. */
  readonly evidence: readonly EvidenceView[];
};

export type TaskView = {
  readonly id: string;
  /** 더한 시각. */
  readonly createdAt: string;
  /** 할 일. */
  readonly work: string;
  readonly status: TaskStatus;
  readonly assignee: Party | null;
  /** 대기 대상. 상태가 대기일 때만 있다. */
  readonly waitingFor: { readonly party: Party; readonly what: string | null } | null;
  /** 먼저 끝나야 하는 작업들. */
  readonly dependsOn: readonly string[];
  /**
   * 완료를 확인한 방식과 근거. 완료가 아니면 null.
   * `confirmed`가 `user_marked`이면 사용자가 표시한 완료, `from_record`이면 비서가 기록에서 확인한 완료다.
   */
  readonly completion: (FinishView & { readonly confirmed: "user_marked" | "from_record" }) | null;
  /** 취소한 쪽과 사유. 취소가 아니면 null. */
  readonly cancellation: (FinishView & { readonly reason: string | null }) | null;
};

export type OpenItemView = {
  readonly id: string;
  /** 작업에 달렸으면 그 작업. */
  readonly taskId: string | null;
  readonly kind: OpenItemKind;
  readonly content: string;
  /** 선택지. */
  readonly options: readonly string[] | null;
  /** 남긴 시각. */
  readonly raisedAt: string;
  /** 풀렸는지. */
  readonly resolved: boolean;
  /** 사용자의 답. */
  readonly answer: string | null;
  /** 푼 시각. */
  readonly resolvedAt: string | null;
};

export type MaterialView = {
  readonly id: string;
  /** 작업에 붙였으면 그 작업. */
  readonly taskId: string | null;
  readonly title: string;
  readonly content: string;
  readonly source: string | null;
  /** 마지막으로 확인한 시각. */
  readonly checkedAt: string;
};

/** 요청 하나. */
export type RequestView = {
  readonly id: string;
  /** 접수 시각. */
  readonly createdAt: string;
  /** 처리할 요청인지 아직 정해지지 않았는지. */
  readonly undecided: boolean;
  readonly title: ValueView<string>;
  readonly requester: ValueView<Party>;
  readonly promise: ValueView<PromisedOutcome>;
  readonly due: ValueView<string>;
  readonly urgency: ValueView<PriorityLevel>;
  readonly importance: ValueView<PriorityLevel>;
  /** 진척. 지금 어디까지 왔는지. */
  readonly progress: string | null;
  /** 작업들. 더한 순서다. */
  readonly tasks: readonly TaskView[];
  /** 기록과의 연결들. */
  readonly links: readonly LinkView[];
  /** 연결된 기록들과 그 판본들. */
  readonly records: readonly RecordView[];
  readonly openItems: readonly OpenItemView[];
  readonly materials: readonly MaterialView[];
  /** 이 요청의 변경 이력. 순번 순서다. */
  readonly changes: readonly Change[];
  /**
   * 이 요청의 변경 이력에 근거로 달린 판본들. 변경 이력의 근거는 판본의 식별자만 담으므로, 그 내용을 여기서 찾는다.
   * 처음 근거로 달린 순서다.
   */
  readonly evidenceRevisions: readonly CitedRevisionView[];
};

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function valueView<T>(row: Row, name: RequestValueName): ValueView<T> {
  const state = readValue(row, name);
  return {
    value: parsedValue(name, state.value) as T | null,
    setBy: state.setBy,
    userSet: state.userSetAt !== null,
    userSetAt: state.userSetAt,
  };
}

function revisionView(row: Row): RevisionView {
  return {
    id: String(row.id),
    recordId: String(row.record_id),
    originalAt: String(row.original_at),
    body: String(row.body),
    url: nullableText(row.url),
    author: storedParty(row.author),
    fetchedAt: String(row.fetched_at),
  };
}

/** 그 작업의 지금 완료나 취소를 쓴 변경 이력에서 근거를 읽어, 판단할 때 본 내용으로 돌려준다. */
function finishEvidence(db: LedgerDb, task: Row): EvidenceView[] {
  const refs = db
    .prepare(FINISH_EVIDENCE_SQL)
    .all(Number(task.finished_seq), String(task.id), finishAction(task.status))
    .flatMap((row) => JSON.parse(String(row.evidence)) as EvidenceRef[]);
  return refs.map((ref): EvidenceView => {
    if (ref.kind === "revision") {
      // 판본은 고치거나 지우지 않으므로, 원본의 새 판본이 들어와도 이 내용은 바뀌지 않는다.
      const revision = db.prepare("SELECT * FROM revisions WHERE id = ?").get(ref.revisionId);
      return { kind: "revision", revision: revisionView(revision as Row) };
    }
    if (ref.kind === "answer") {
      const openItem = db.prepare("SELECT answer FROM open_items WHERE id = ?").get(ref.openItemId);
      return { kind: "answer", openItemId: ref.openItemId, answer: nullableText(openItem?.answer) };
    }
    return { kind: "user_confirmation" };
  });
}

function taskView(db: LedgerDb, row: Row): TaskView {
  const id = String(row.id);
  const finish = (): FinishView => ({
    by: row.finished_by as SetBy,
    at: String(row.finished_at),
    evidence: finishEvidence(db, row),
  });
  return {
    id,
    createdAt: String(row.created_at),
    work: String(row.work),
    status: row.status as TaskStatus,
    assignee: storedParty(row.assignee),
    waitingFor:
      typeof row.waiting_for === "string"
        ? { party: storedParty(row.waiting_for) as Party, what: nullableText(row.waiting_what) }
        : null,
    dependsOn: db
      .prepare("SELECT depends_on FROM task_dependencies WHERE task_id = ? ORDER BY rowid")
      .all(id)
      .map((dependency) => String(dependency.depends_on)),
    // 사용자의 완료는 언제나 사용자가 표시한 완료이고, 비서의 완료는 언제나 근거가 있는 완료다.
    completion:
      row.status === "done"
        ? { ...finish(), confirmed: row.finished_by === "user" ? "user_marked" : "from_record" }
        : null,
    cancellation:
      row.status === "cancelled" ? { ...finish(), reason: nullableText(row.cancel_reason) } : null,
  };
}

/**
 * 요청의 변경 이력을 고르는 조건. 그 요청에 속해 있을 때 남은 건과,
 * 지금 그 요청에 있는 것(작업, 연결, 확인할 사항, 알릴 일, 준비 자료)을 대상으로 한 건이다.
 */
const REQUEST_CHANGES = `
  request_id = ?1
  OR (target_kind = 'task' AND target_id IN (SELECT id FROM tasks WHERE request_id = ?1))
  OR (target_kind = 'link' AND target_id IN (SELECT id FROM links WHERE request_id = ?1))
  OR (target_kind = 'open_item' AND target_id IN (SELECT id FROM open_items WHERE request_id = ?1))
  OR (target_kind = 'notice' AND target_id IN (SELECT id FROM notices WHERE request_id = ?1))
  OR (target_kind = 'material' AND target_id IN (SELECT id FROM materials WHERE request_id = ?1))
`;

/** 변경 이력에 근거로 달린 판본들을 처음 달린 순서로 찾아 내용과 함께 돌려준다. */
function citedRevisions(db: LedgerDb, changes: readonly Change[]): CitedRevisionView[] {
  const ids = new Set<string>();
  for (const change of changes) {
    for (const ref of change.evidence as readonly Partial<EvidenceRef>[]) {
      if (ref?.kind === "revision" && typeof ref.revisionId === "string") {
        ids.add(ref.revisionId);
      }
    }
  }
  const find = db.prepare(
    `SELECT revisions.*, records.source, records.source_id
       FROM revisions JOIN records ON records.id = revisions.record_id
      WHERE revisions.id = ?`,
  );
  return [...ids].flatMap((revisionId) => {
    const row = find.get(revisionId);
    return row === undefined
      ? []
      : [{ ...revisionView(row), source: String(row.source), sourceId: String(row.source_id) }];
  });
}

/**
 * 요청 하나를 돌려준다. 없는 요청이면 `request_not_found` 오류다.
 * 조회 한 번은 한 시점의 값과 변경 이력을 돌려준다. 조회하는 사이에 다른 프로세스가 쓴 것이 섞이지 않는다.
 */
export function getRequest(db: LedgerDb, requestId: string): RequestView {
  return inReadTransaction(db, () => readRequest(db, requestId));
}

function readRequest(db: LedgerDb, requestId: string): RequestView {
  const id = requiredText(requestId, "requestId");
  const row = db.prepare("SELECT * FROM requests WHERE id = ?").get(id);
  if (row === undefined) {
    throw new LedgerError("request_not_found", `요청이 없다 (${id})`);
  }
  const all = (sql: string): Row[] => db.prepare(sql).all(id);
  const links = all("SELECT * FROM links WHERE request_id = ? ORDER BY rowid");
  const recordIds = [...new Set(links.map((link) => String(link.record_id)))];
  const changes = readChanges(db, REQUEST_CHANGES, id);
  return {
    id,
    createdAt: String(row.created_at),
    undecided: row.undecided === 1,
    title: valueView(row, "title"),
    requester: valueView(row, "requester"),
    promise: valueView(row, "promise"),
    due: valueView(row, "due"),
    urgency: valueView(row, "urgency"),
    importance: valueView(row, "importance"),
    progress: nullableText(row.progress),
    tasks: all("SELECT * FROM tasks WHERE request_id = ? ORDER BY added_seq, rowid").map((task) =>
      taskView(db, task),
    ),
    links: links.map((link) => ({
      id: String(link.id),
      recordId: String(link.record_id),
      taskId: nullableText(link.task_id),
      role: link.role as LinkRole,
      userSet: link.user_set === 1,
    })),
    records: recordIds.map((recordId) => {
      const record = db.prepare("SELECT * FROM records WHERE id = ?").get(recordId) as Row;
      return {
        id: recordId,
        source: String(record.source),
        sourceId: String(record.source_id),
        revisions: db
          .prepare("SELECT * FROM revisions WHERE record_id = ? ORDER BY original_at")
          .all(recordId)
          .map(revisionView),
      };
    }),
    openItems: all("SELECT * FROM open_items WHERE request_id = ? ORDER BY rowid").map((item) => ({
      id: String(item.id),
      taskId: nullableText(item.task_id),
      kind: item.kind as OpenItemKind,
      content: String(item.content),
      options: typeof item.options === "string" ? (JSON.parse(item.options) as string[]) : null,
      raisedAt: String(item.raised_at),
      resolved: item.resolved_at !== null,
      answer: nullableText(item.answer),
      resolvedAt: nullableText(item.resolved_at),
    })),
    materials: all("SELECT * FROM materials WHERE request_id = ? ORDER BY rowid").map(
      (material) => ({
        id: String(material.id),
        taskId: nullableText(material.task_id),
        title: String(material.title),
        content: String(material.content),
        source: nullableText(material.source),
        checkedAt: String(material.checked_at),
      }),
    ),
    changes,
    evidenceRevisions: citedRevisions(db, changes),
  };
}
