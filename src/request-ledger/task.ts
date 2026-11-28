// 작업을 더하고, 작업의 값(할 일, 상태, 담당, 대기 대상, 선후 관계)을 쓰고, 완료와 취소를 표시한다.
import type { Row, WriteScope } from "./changes.ts";
import { assertDependencies, dependenciesOf, replaceDependencies } from "./dependency.ts";
import { LedgerError } from "./errors.ts";
import {
  type CheckedEvidence,
  checkedEvidence,
  evidenceJson,
  FINISH_EVIDENCE_SQL,
  finishAction,
} from "./evidence.ts";
import { checkedFields, distinctTexts, oneOf, optionalText, requiredText } from "./input.ts";
import { existingRequest, existingTask } from "./lookup.ts";
import { anyAfter, hasLaterRevision, isAfter } from "./ordering.ts";
import { checkedParty, sameParty } from "./party.ts";
import type { WriteGrounds } from "./request.ts";
import { readUserTurn, turnReleasedByRevision, type UserTurn, userTurnSnapshot } from "./turn.ts";
import type { EvidenceRef, JsonValue, Party, SetBy } from "./types.ts";

export const TASK_STATUSES = ["todo", "in_progress", "waiting", "done", "cancelled"] as const;

/** 작업의 상태. 할 일, 진행 중, 대기, 완료, 취소다. */
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 끝나지 않은 작업의 상태. `addTask`와 `updateTask`로는 이 셋만 쓴다. */
export type UnfinishedStatus = "todo" | "in_progress" | "waiting";

/** 대기 대상. 기다리는 주체와 요청한 내용이다. */
export type WaitingForInput = {
  readonly party: Party;
  readonly what?: string | null;
};

export type AddTaskInput = WriteGrounds & {
  readonly requestId: string;
  /** 할 일. */
  readonly work: string;
  /** 없으면 할 일(`todo`)이다. */
  readonly status?: UnfinishedStatus;
  readonly assignee?: Party | null;
  /** 상태가 대기이면 있어야 하고, 대기가 아니면 적을 수 없다. */
  readonly waitingFor?: WaitingForInput | null;
  /** 먼저 끝나야 하는 작업들. 같은 요청의 작업이어야 한다. */
  readonly dependsOn?: readonly string[];
};

export type AddTaskResult = { readonly id: string };

export type UpdateTaskInput = WriteGrounds & {
  readonly taskId: string;
  readonly work?: string;
  /** 완료나 취소인 작업을 되돌릴 때도 이 값으로 옮긴다. 완료와 취소로는 옮길 수 없다. */
  readonly status?: UnfinishedStatus;
  /** null이면 담당을 비운다. */
  readonly assignee?: Party | null;
  readonly waitingFor?: WaitingForInput | null;
  /** 먼저 끝나야 하는 작업들을 이 목록으로 바꾼다. */
  readonly dependsOn?: readonly string[];
};

export type CompleteTaskInput = WriteGrounds & { readonly taskId: string };

/** 비서가 취소할 때는 쓰기에 사유(`reason`)를 꼭 적는다. */
export type CancelTaskInput = WriteGrounds & { readonly taskId: string };

/** 사용자가 바로잡을 수 있는 작업의 값. 상태, 담당, 대기 대상이다. */
type FactName = "status" | "assignee" | "waitingFor";

const FACT_COLUMNS: Record<FactName, string> = {
  status: "status",
  assignee: "assignee",
  waitingFor: "waiting",
};

const FACTS_IN_KOREAN: Record<FactName, string> = {
  status: "상태",
  assignee: "담당",
  waitingFor: "대기 대상",
};

/**
 * 작업의 값 하나의 상태. `value`는 비교할 수 있게 한 줄로 적은 값이다.
 * 대기 대상은 주체와 요청한 내용을 함께 적은 JSON이다.
 */
type FactState = {
  readonly value: string | null;
  /** 사용자가 그 값을 마지막으로 바로잡은 시각. */
  readonly correctedAt: string | null;
  /** 그 값에 마지막으로 반영된 근거의 시각. */
  readonly evidenceAt: string | null;
};

type FinishState = {
  readonly by: SetBy;
  readonly at: string;
  /** 그 쓰기에 단 근거 가운데 가장 늦은 시각. 근거 없이 썼으면 null. */
  readonly evidenceAt: string | null;
  readonly reason: string | null;
};

function isFinished(status: unknown): boolean {
  return status === "done" || status === "cancelled";
}

function waitingValue(waitingFor: unknown, waitingWhat: unknown): string | null {
  return typeof waitingFor === "string"
    ? JSON.stringify({ party: JSON.parse(waitingFor) as JsonValue, what: waitingWhat ?? null })
    : null;
}

function readFact(row: Row, name: FactName): FactState {
  const column = FACT_COLUMNS[name];
  return {
    value:
      name === "waitingFor"
        ? waitingValue(row.waiting_for, row.waiting_what)
        : ((row[column] as string | null) ?? null),
    correctedAt: (row[`${column}_corrected_at`] as string | null) ?? null,
    evidenceAt: (row[`${column}_evidence_at`] as string | null) ?? null,
  };
}

function factColumns(name: FactName, state: FactState): [string, string | null][] {
  const column = FACT_COLUMNS[name];
  const times: [string, string | null][] = [
    [`${column}_corrected_at`, state.correctedAt],
    [`${column}_evidence_at`, state.evidenceAt],
  ];
  if (name !== "waitingFor") {
    return [[column, state.value], ...times];
  }
  const waiting =
    state.value === null
      ? null
      : (JSON.parse(state.value) as { party: Party; what: string | null });
  return [
    ["waiting_for", waiting === null ? null : JSON.stringify(waiting.party)],
    ["waiting_what", waiting?.what ?? null],
    ...times,
  ];
}

function factSnapshot(name: FactName, state: FactState): JsonValue {
  return {
    value: name === "status" || state.value === null ? state.value : JSON.parse(state.value),
    correctedAt: state.correctedAt,
    evidenceAt: state.evidenceAt,
  };
}

/**
 * 두 값이 같은 값인지. 담당과 대기 대상의 주체는 JSON 문자열이 아니라 같은 주체인지로 가린다.
 * 같은 주체인데 이름 표기만 다르면 같은 값이다. 대기 대상에게 요청한 내용은 따로 비교한다.
 */
function sameFactValue(name: FactName, a: string | null, b: string | null): boolean {
  if (a === null || b === null || a === b) {
    return a === b;
  }
  if (name === "assignee") {
    return sameParty(JSON.parse(a) as Party, JSON.parse(b) as Party);
  }
  if (name === "waitingFor") {
    type Waiting = { party: Party; what: string | null };
    const [one, other] = [JSON.parse(a) as Waiting, JSON.parse(b) as Waiting];
    return sameParty(one.party, other.party) && one.what === other.what;
  }
  return false;
}

function sameFact(a: FactState, b: FactState): boolean {
  return a.value === b.value && a.correctedAt === b.correctedAt && a.evidenceAt === b.evidenceAt;
}

/** 사용자가 값을 쓰면 그 시점의 값으로 바로 반영하고, 값이 같아도 바로잡은 시각이 지금으로 바뀐다. */
function userCorrects(
  current: FactState,
  value: string | null,
  at: string,
  evidence: CheckedEvidence,
): FactState {
  return { value, correctedAt: at, evidenceAt: evidence.latestAt ?? current.evidenceAt };
}

/**
 * 비서가 값을 쓸 때의 규칙. 사용자가 바로잡은 값은 나중 판본을 근거로 달았을 때만 바꿀 수 있다.
 * 지금 값과 같은 값도 같은 조건을 보고, 조건을 못 채우면 거부하지 않고 건너뛴다(undefined).
 * 같은 주체를 이름 표기만 다르게 쓴 것도 같은 값이어서, 건너뛸 때는 표기도 바꾸지 않는다.
 */
function assistantWrites(
  name: FactName,
  current: FactState,
  value: string | null,
  evidence: CheckedEvidence,
  rejected: FactName[],
): FactState | undefined {
  const allowed =
    current.correctedAt === null ||
    hasLaterRevision(evidence.revisionTimes, current.correctedAt, current.evidenceAt);
  if (!allowed) {
    if (!sameFactValue(name, value, current.value)) {
      rejected.push(name);
    }
    return undefined;
  }
  return {
    value,
    correctedAt: current.correctedAt,
    evidenceAt: evidence.latestAt ?? current.evidenceAt,
  };
}

function rejectCorrected(rejected: readonly FactName[]): void {
  if (rejected.length > 0) {
    throw new LedgerError(
      "user_corrected_protected",
      `사용자가 바로잡은 값은 나중 판본을 근거로 달았을 때만 비서가 바꿀 수 있다 (${rejected
        .map((name) => FACTS_IN_KOREAN[name])
        .join(", ")})`,
      rejected,
    );
  }
}

function checkedAssignee(value: unknown): string | null {
  return value === null ? null : JSON.stringify(checkedParty(value, "담당"));
}

function checkedWaitingFor(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  const { party, what } = checkedFields(value, "대기 대상(waitingFor)", ["party", "what"]);
  return JSON.stringify({
    party: checkedParty(party, "대기 대상의 주체"),
    what: optionalText(what, "대기 대상에게 요청한 내용(what)"),
  });
}

/** `addTask`와 `updateTask`로 쓸 수 있는 상태인지 확인한다. 완료와 취소는 따로 쓴다. */
function checkedUnfinishedStatus(value: unknown): UnfinishedStatus {
  const status = oneOf(value, "작업의 상태(status)", TASK_STATUSES);
  if (status === "done" || status === "cancelled") {
    throw new LedgerError(
      "finish_with_dedicated_write",
      "완료와 취소는 completeTask와 cancelTask로 쓴다",
    );
  }
  return status;
}

/**
 * 상태와 대기 대상이 맞는지 확인하고, 그 상태에서의 대기 대상을 돌려준다.
 * 대기 대상은 상태가 대기일 때만 있다. `given`이 undefined이면 대기 대상을 따로 적지 않은 것이다.
 */
function waitingForStatus(
  status: TaskStatus,
  given: string | null | undefined,
  current: string | null,
): string | null {
  if (status !== "waiting") {
    if (given !== undefined && given !== null) {
      throw new LedgerError("waiting_target_mismatch", "대기 대상은 상태가 대기인 작업에만 적는다");
    }
    return null;
  }
  const waitingFor = given === undefined ? current : given;
  if (waitingFor === null) {
    throw new LedgerError("waiting_target_mismatch", "대기 대상 없이 상태를 대기로 쓸 수 없다");
  }
  return waitingFor;
}

/**
 * 요청에 작업을 더한다. 사용자가 명시한 상태, 담당, 대기 대상은 사용자가 바로잡은 값으로 적는다.
 * 근거를 달았으면 처음 정하는 값에 반영된 근거가 된다.
 */
export function addTask(scope: WriteScope, input: AddTaskInput): AddTaskResult {
  const fields = checkedFields(input, "addTask의 인자", [
    "requestId",
    "work",
    "status",
    "assignee",
    "waitingFor",
    "dependsOn",
    "evidence",
  ]);
  const requestId = String(existingRequest(scope, fields.requestId).id);
  const evidence = checkedEvidence(scope, fields.evidence);
  const work = requiredText(fields.work, "할 일(work)");
  const status = fields.status === undefined ? "todo" : checkedUnfinishedStatus(fields.status);
  const assignee = fields.assignee === undefined ? null : checkedAssignee(fields.assignee);
  const givenWaiting =
    fields.waitingFor === undefined ? undefined : checkedWaitingFor(fields.waitingFor);
  const waitingFor = waitingForStatus(status, givenWaiting, null);
  const dependsOn = distinctTexts(fields.dependsOn, "먼저 끝나야 하는 작업(dependsOn)");
  assertDependencies(scope, requestId, null, dependsOn);

  /**
   * 처음 정하는 값의 상태. 적지 않은 값에는 바로잡은 시각도 반영된 근거도 없다.
   * null로 명시해 비운 값은 정한 값이다. 적지 않은 것과 구별해, 그 결정의 근거 시각을 적는다.
   * 상태는 적지 않아도 할 일로 정해지므로 언제나 정한 값이다.
   */
  const first = (value: string | null, given: unknown, decided: boolean): FactState => ({
    value,
    correctedAt: scope.actor.kind === "user" && given !== undefined ? scope.at : null,
    evidenceAt: decided ? evidence.latestAt : null,
  });
  const facts: Record<FactName, FactState> = {
    status: first(status, fields.status, true),
    assignee: first(assignee, fields.assignee, fields.assignee !== undefined),
    waitingFor: first(waitingFor, fields.waitingFor, fields.waitingFor !== undefined),
  };
  const id = scope.newId();
  const columns: [string, string | number | null][] = [
    ["id", id],
    ["request_id", requestId],
    ["created_at", scope.at],
    ["added_seq", scope.seq],
    ["work", work],
    ["work_seq", scope.seq],
    ...factColumns("status", facts.status),
    ...factColumns("assignee", facts.assignee),
    ...factColumns("waitingFor", facts.waitingFor),
  ];
  scope.run(
    `INSERT INTO tasks (${columns.map(([column]) => column).join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
    ...columns.map(([, value]) => value),
  );
  replaceDependencies(scope, id, dependsOn);
  // 제목을 마지막으로 쓴 뒤에 작업이 더해졌는지 가리는 데 쓴다.
  scope.run("UPDATE requests SET added_seq = ? WHERE id = ?", scope.seq, requestId);
  scope.record({
    target: { kind: "task", id },
    requestId,
    before: null,
    after: {
      requestId,
      work,
      status: factSnapshot("status", facts.status),
      assignee: factSnapshot("assignee", facts.assignee),
      waitingFor: factSnapshot("waitingFor", facts.waitingFor),
      dependsOn,
    },
    evidence: evidenceJson(evidence),
  });
  return { id };
}

function readFinish(row: Row): FinishState | null {
  return isFinished(row.status)
    ? {
        by: row.finished_by as SetBy,
        at: String(row.finished_at),
        evidenceAt: (row.finished_evidence_at as string | null) ?? null,
        reason: (row.cancel_reason as string | null) ?? null,
      }
    : null;
}

function finishSnapshot(finish: FinishState | null): JsonValue {
  return finish === null ? null : { ...finish };
}

/** 사용자가 되돌린 완료나 취소에 달았던 근거 참조들. */
function overruledEvidence(row: Row): EvidenceRef[] {
  return JSON.parse(String(row.overruled_evidence)) as EvidenceRef[];
}

/** 그 작업의 지금 완료나 취소에 달았던 근거 참조들. */
function finishEvidence(scope: WriteScope, row: Row): EvidenceRef[] {
  return scope
    .all(FINISH_EVIDENCE_SQL, Number(row.finished_seq), String(row.id), finishAction(row.status))
    .flatMap((change) => JSON.parse(String(change.evidence)) as EvidenceRef[]);
}

/** 두 목록이 순서와 상관없이 같은 항목들인지. 항목은 서로 다르다. */
function sameItems(a: readonly string[], b: readonly string[]): boolean {
  const items = new Set(a);
  return a.length === b.length && b.every((item) => items.has(item));
}

/** 한 쓰기에서 바뀐 작업의 값들을 저장하고 변경 이력을 한 건 남긴다. */
function saveTask(
  scope: WriteScope,
  row: Row,
  changes: {
    readonly facts: ReadonlyMap<FactName, { before: FactState; after: FactState }>;
    readonly work?: string;
    readonly dependsOn?: { before: readonly string[]; after: readonly string[] };
    /** 완료나 취소를 새로 썼으면 그 내용, 되돌렸으면 null. 그대로면 undefined. */
    readonly finish?: FinishState | null;
    /** 사용자가 완료나 취소를 되돌리면서 더한, 그 완료나 취소에 달았던 근거. */
    readonly overruled?: { before: readonly EvidenceRef[]; after: readonly EvidenceRef[] };
    /** 이 쓰기로 풀리는, 사용자가 정한 차례. 풀리는 것이 없으면 null. */
    readonly releasedTurn?: UserTurn | null;
  },
  evidence: CheckedEvidence,
): void {
  const taskId = String(row.id);
  const columns: [string, string | number | null][] = [];
  const before: { [key: string]: JsonValue } = {};
  const after: { [key: string]: JsonValue } = {};
  for (const [name, change] of changes.facts) {
    columns.push(...factColumns(name, change.after));
    before[name] = factSnapshot(name, change.before);
    after[name] = factSnapshot(name, change.after);
  }
  if (changes.work !== undefined) {
    columns.push(["work", changes.work], ["work_seq", scope.seq]);
    before.work = String(row.work);
    after.work = changes.work;
  }
  if (changes.dependsOn !== undefined) {
    replaceDependencies(scope, taskId, changes.dependsOn.after);
    before.dependsOn = changes.dependsOn.before;
    after.dependsOn = changes.dependsOn.after;
  }
  if (changes.finish !== undefined) {
    const finish = changes.finish;
    columns.push(
      ["finished_by", finish?.by ?? null],
      ["finished_at", finish?.at ?? null],
      ["finished_evidence_at", finish?.evidenceAt ?? null],
      ["finished_seq", finish === null ? null : scope.seq],
      ["cancel_reason", finish?.reason ?? null],
    );
    before.finished = finishSnapshot(readFinish(row));
    after.finished = finishSnapshot(finish);
  }
  if (changes.overruled !== undefined) {
    columns.push(["overruled_evidence", JSON.stringify(changes.overruled.after)]);
    before.overruledEvidence = changes.overruled.before.map((ref) => ({ ...ref }));
    after.overruledEvidence = changes.overruled.after.map((ref) => ({ ...ref }));
  }
  if (changes.releasedTurn !== undefined && changes.releasedTurn !== null) {
    columns.push(["turn", null], ["turn_set_at", null]);
    before.turn = userTurnSnapshot(changes.releasedTurn);
    after.turn = null;
  }
  if (columns.length > 0) {
    scope.run(
      `UPDATE tasks SET ${columns.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`,
      ...columns.map(([, value]) => value),
      taskId,
    );
  }
  scope.record({
    target: { kind: "task", id: taskId },
    requestId: String(row.request_id),
    before,
    after,
    evidence: evidenceJson(evidence),
  });
}

/**
 * 작업의 할 일, 상태, 담당, 대기 대상, 선후 관계를 쓴다. 완료나 취소인 작업을 할 일, 진행 중, 대기로 되돌릴 때도 쓴다.
 * 사용자의 값은 그 시점의 값으로 바로 반영한다. 비서는 사용자가 바로잡은 값을 나중 판본을 근거로 달았을 때만 바꾸고,
 * 자기가 쓴 완료와 취소만 그 뒤의 판본으로 되돌린다.
 */
export function updateTask(scope: WriteScope, input: UpdateTaskInput): void {
  const fields = checkedFields(input, "updateTask의 인자", [
    "taskId",
    "work",
    "status",
    "assignee",
    "waitingFor",
    "dependsOn",
    "evidence",
  ]);
  const row = existingTask(scope, fields.taskId);
  const taskId = String(row.id);
  const byUser = scope.actor.kind === "user";
  const evidence = checkedEvidence(scope, fields.evidence);
  const current: Record<FactName, FactState> = {
    status: readFact(row, "status"),
    assignee: readFact(row, "assignee"),
    waitingFor: readFact(row, "waitingFor"),
  };
  const finished = isFinished(row.status);
  const status =
    fields.status === undefined
      ? (row.status as TaskStatus)
      : checkedUnfinishedStatus(fields.status);
  const givenWaiting =
    fields.waitingFor === undefined ? undefined : checkedWaitingFor(fields.waitingFor);
  const waitingFor = waitingForStatus(status, givenWaiting, current.waitingFor.value);

  // 이 쓰기가 쓰는 값들. 상태가 대기에서 벗어나 대기 대상이 비게 되는 것도 대기 대상을 쓰는 것이다.
  const written: [FactName, string | null][] = [];
  if (fields.status !== undefined) {
    written.push(["status", status]);
  }
  if (fields.assignee !== undefined) {
    written.push(["assignee", checkedAssignee(fields.assignee)]);
  }
  if (fields.waitingFor !== undefined || waitingFor !== current.waitingFor.value) {
    written.push(["waitingFor", waitingFor]);
  }

  const reverting = finished && fields.status !== undefined;
  if (reverting && !byUser) {
    if (row.finished_by === "user") {
      throw new LedgerError(
        "user_finished_protected",
        "사용자가 표시한 완료와 사용자가 취소한 작업은 비서가 되돌리거나 다시 시작할 수 없다",
      );
    }
    // 단 판본 가운데 적어도 하나는 그 완료나 취소에 달았던 근거 가운데 가장 늦은 시각보다,
    // 근거 없이 쓴 취소였으면 취소한 시각보다 뒤여야 한다.
    const finishedAt = String(row.finished_evidence_at ?? row.finished_at);
    if (evidence.revisionTimes.length === 0) {
      throw new LedgerError(
        "evidence_required",
        "비서가 완료나 취소를 되돌리려면 그 뒤의 판본을 근거로 달아야 한다",
      );
    }
    if (!anyAfter(evidence.revisionTimes, finishedAt)) {
      throw new LedgerError(
        "evidence_too_early",
        "완료나 취소를 되돌리는 근거는 그 완료나 취소에 달았던 근거보다 뒤의 판본이어야 한다",
      );
    }
  }

  const facts = new Map<FactName, { before: FactState; after: FactState }>();
  const rejected: FactName[] = [];
  for (const [name, value] of written) {
    const before = current[name];
    if (byUser) {
      facts.set(name, { before, after: userCorrects(before, value, scope.at, evidence) });
      continue;
    }
    const after = assistantWrites(name, before, value, evidence, rejected);
    if (after !== undefined && !sameFact(before, after)) {
      facts.set(name, { before, after });
    }
  }
  rejectCorrected(rejected);

  const work = fields.work === undefined ? undefined : requiredText(fields.work, "할 일(work)");
  let dependsOn: { before: string[]; after: string[] } | undefined;
  if (fields.dependsOn !== undefined) {
    const after = distinctTexts(fields.dependsOn, "먼저 끝나야 하는 작업(dependsOn)");
    assertDependencies(scope, String(row.request_id), taskId, after);
    const before = dependenciesOf(scope, taskId);
    if (!sameItems(before, after)) {
      dependsOn = { before, after };
    }
  }
  const workChanged = work !== undefined && work !== row.work;
  const reverted = reverting && facts.has("status");
  // 비서가 나중 판본을 근거로 상태, 담당, 대기 대상을 바꾸고 그 판본이 사용자가 차례를 정한 시각보다 뒤이면
  // 그 차례가 풀린다. 값마다 쓰기 전의 정정 시각과 반영된 근거의 시각으로 나중 판본인지 가린다.
  // 반영된 근거의 시각만 바뀌었거나 같은 주체의 이름 표기만 바뀐 것은 값을 바꾼 것이 아니다.
  const changedValues = [...facts]
    .filter(([name, change]) => !sameFactValue(name, change.before.value, change.after.value))
    .map(([, change]) => ({
      correctedAt: change.before.correctedAt,
      reflectedAt: change.before.evidenceAt,
    }));
  const releasedTurn = byUser
    ? null
    : turnReleasedByRevision(readUserTurn(row), changedValues, evidence);
  if (facts.size === 0 && !workChanged && dependsOn === undefined) {
    return;
  }
  // 사용자가 완료나 취소를 되돌리면 거기에 달았던 근거를 적어 둔다.
  // 비서가 같은 근거만 다시 내어 완료로 쓰지 못하게 하려는 것이다.
  let overruled: { before: EvidenceRef[]; after: EvidenceRef[] } | undefined;
  if (reverted && byUser) {
    const before = overruledEvidence(row);
    const known = new Set(before.map((ref) => JSON.stringify(ref)));
    const added: EvidenceRef[] = [];
    for (const ref of finishEvidence(scope, row)) {
      const key = JSON.stringify(ref);
      if (!known.has(key)) {
        known.add(key);
        added.push(ref);
      }
    }
    if (added.length > 0) {
      overruled = { before, after: [...before, ...added] };
    }
  }
  saveTask(
    scope,
    row,
    {
      facts,
      ...(workChanged ? { work } : {}),
      ...(dependsOn ? { dependsOn } : {}),
      // 완료나 취소를 되돌리면 그때 적어 둔 것을 비운다.
      ...(reverted ? { finish: null } : {}),
      ...(overruled ? { overruled } : {}),
      releasedTurn,
    },
    evidence,
  );
}

/**
 * 완료와 취소에 공통인 부분. 끝난 작업에는 대기 대상이 없으므로 함께 비운다.
 * 작업이 끝나면 사용자가 정한 차례도 풀린다. 누가 어떤 근거로 끝냈든 그렇다.
 */
function finishTask(
  scope: WriteScope,
  row: Row,
  status: "done" | "cancelled",
  evidence: CheckedEvidence,
): void {
  const byUser = scope.actor.kind === "user";
  const facts = new Map<FactName, { before: FactState; after: FactState }>();
  const finishes = (name: FactName, value: string | null): void => {
    const before = readFact(row, name);
    facts.set(name, {
      before,
      after: byUser
        ? userCorrects(before, value, scope.at, evidence)
        : { ...before, value, evidenceAt: evidence.latestAt ?? before.evidenceAt },
    });
  };
  finishes("status", status);
  if (row.waiting_for !== null) {
    finishes("waitingFor", null);
  }
  saveTask(
    scope,
    row,
    {
      facts,
      finish: {
        by: scope.actor.kind,
        at: scope.at,
        evidenceAt: evidence.latestAt,
        // 취소한 사유다. 완료에는 적지 않는다.
        reason: status === "cancelled" ? scope.reason : null,
      },
      releasedTurn: readUserTurn(row),
    },
    evidence,
  );
}

function unfinishedTask(scope: WriteScope, taskId: unknown): Row {
  const row = existingTask(scope, taskId);
  if (isFinished(row.status)) {
    throw new LedgerError(
      "task_already_finished",
      "이미 완료했거나 취소한 작업이다. updateTask로 되돌린 뒤에 다시 쓴다",
    );
  }
  return row;
}

/**
 * 비서가 대기인 작업을 끝낼 때 대기 대상을 지워도 되는지 확인한다. 대기 대상에는 그 값의 조건을 그대로 쓴다.
 * 사용자가 바로잡은 대기 대상은 나중 판본(바로잡은 시각보다 뒤이고, 마지막으로 반영된 근거보다 앞서지 않는 판본)이
 * 있어야 지울 수 있다. 어긋난 값은 `rejected`에 담는다.
 */
function assistantClearsWaiting(row: Row, evidence: CheckedEvidence, rejected: FactName[]): void {
  if (row.waiting_for !== null) {
    assistantWrites("waitingFor", readFact(row, "waitingFor"), null, evidence, rejected);
  }
}

/**
 * 작업을 완료로 표시한다. 사용자는 근거 없이 표시할 수 있고, 사용자가 표시한 완료로 저장한다.
 * 비서는 근거를 달아야 하고, 사용자가 그 작업의 상태를 바로잡았으면 단 근거 가운데 적어도 하나는 시각이 그 뒤여야 한다.
 * 사용자가 되돌린 완료나 취소에 달았던 근거는 시각이 어떻게 적혀 있든 이 하나로 세지 않는다.
 */
export function completeTask(scope: WriteScope, input: CompleteTaskInput): void {
  const fields = checkedFields(input, "completeTask의 인자", ["taskId", "evidence"]);
  const row = unfinishedTask(scope, fields.taskId);
  const evidence = checkedEvidence(scope, fields.evidence);
  if (scope.actor.kind !== "user") {
    if (evidence.refs.length === 0) {
      throw new LedgerError("evidence_required", "비서는 근거 없이 작업을 완료로 쓸 수 없다");
    }
    // 완료의 상태 검사. 그 값에 마지막으로 반영된 근거와는 비교하지 않는다.
    const correctedAt = readFact(row, "status").correctedAt;
    if (correctedAt !== null) {
      const later = evidence.revisions.filter((revision) =>
        isAfter(revision.originalAt, correctedAt),
      );
      const overruled = new Set(
        overruledEvidence(row).flatMap((ref) => (ref.kind === "revision" ? [ref.revisionId] : [])),
      );
      if (later.length === 0) {
        throw new LedgerError(
          "evidence_too_early",
          "사용자가 그 작업의 상태를 바로잡았으면 완료의 근거 가운데 적어도 하나는 시각이 그 뒤여야 한다",
        );
      }
      if (later.every((revision) => overruled.has(revision.revisionId))) {
        throw new LedgerError(
          "evidence_overruled",
          "사용자가 되돌린 완료나 취소에 달았던 근거만으로는 다시 완료로 쓸 수 없다",
        );
      }
    }
    // 대기 대상을 지우는 검사는 따로 한다.
    const rejected: FactName[] = [];
    assistantClearsWaiting(row, evidence, rejected);
    rejectCorrected(rejected);
  }
  finishTask(scope, row, "done", evidence);
}

/**
 * 작업을 취소로 표시한다. 비서는 사유를 꼭 적고, 사용자가 바로잡은 상태는 나중 판본을 근거로 달았을 때만 취소로 바꾼다.
 * 사용자의 취소는 사유가 없어도 받는다.
 */
export function cancelTask(scope: WriteScope, input: CancelTaskInput): void {
  const fields = checkedFields(input, "cancelTask의 인자", ["taskId", "evidence"]);
  const row = unfinishedTask(scope, fields.taskId);
  const evidence = checkedEvidence(scope, fields.evidence);
  if (scope.actor.kind !== "user") {
    if (scope.reason === null) {
      throw new LedgerError("reason_required", "비서가 작업을 취소할 때는 사유를 적어야 한다");
    }
    const rejected: FactName[] = [];
    assistantWrites("status", readFact(row, "status"), "cancelled", evidence, rejected);
    assistantClearsWaiting(row, evidence, rejected);
    rejectCorrected(rejected);
  }
  finishTask(scope, row, "cancelled", evidence);
}
