// 요청의 값(제목, 요청자, 약속한 결과, 기한, 긴급도, 중요도)의 형태와, 값을 쓸 때의 규칙을 둔다.
// 값마다 값, 정한 주체, 사용자 지정이 걸린 시각을 함께 저장한다.
import type { Row } from "./changes.ts";
import { LedgerError } from "./errors.ts";
import type { CheckedEvidence } from "./evidence.ts";
import { checkedFields, everyItem, oneOf, requiredText } from "./input.ts";
import { hasLaterRevision } from "./ordering.ts";
import { checkedParty, partyKey, sameParty } from "./party.ts";
import { externalTime } from "./time.ts";
import type { JsonValue, Party, SetBy } from "./types.ts";

export const REQUEST_VALUE_NAMES = [
  "title",
  "requester",
  "promise",
  "due",
  "urgency",
  "importance",
] as const;

export type RequestValueName = (typeof REQUEST_VALUE_NAMES)[number];

export const PRIORITY_LEVELS = ["high", "medium", "low"] as const;

/** 긴급도와 중요도의 단계. 높음, 보통, 낮음이다. */
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

/** 약속한 결과. 해 주기로 한 일과 결과를 알릴 사람들이다. */
export type PromisedOutcome = {
  readonly work: string;
  readonly notify: readonly Party[];
};

/** 마지막으로 반영된 근거 판본의 시각을 함께 저장하는 값. */
const WITH_EVIDENCE_TIME: readonly RequestValueName[] = ["promise", "due"];

/** 저장된 값 하나의 상태. `value`는 저장한 형태(TEXT)이고 비어 있으면 null이다. */
export type ValueState = {
  readonly value: string | null;
  /** 지금 값을 마지막으로 쓴 쪽. 빈 값에는 없다. */
  readonly setBy: SetBy | null;
  /** 사용자 지정이 걸린 시각. 비어 있으면 사용자 지정이 없는 것이다. */
  readonly userSetAt: string | null;
  /** 그 값에 마지막으로 반영된 근거 판본의 원본 시각. 약속한 결과와 기한에만 있다. */
  readonly evidenceAt: string | null;
};

export const EMPTY_VALUE: ValueState = {
  value: null,
  setBy: null,
  userSetAt: null,
  evidenceAt: null,
};

function checkedPromise(value: unknown): PromisedOutcome {
  const { work, notify } = checkedFields(value, "약속한 결과", ["work", "notify"]);
  const parties = everyItem(notify, "결과를 알릴 사람들(notify)").map((party) =>
    checkedParty(party, "결과를 알릴 사람"),
  );
  if (new Set(parties.map(partyKey)).size !== parties.length) {
    throw new LedgerError("invalid_argument", "결과를 알릴 사람들에 같은 주체가 두 번 있다");
  }
  return { work: requiredText(work, "해 주기로 한 일(work)"), notify: parties };
}

/**
 * 밖에서 받은 값의 형태를 확인하고 저장할 형태로 바꾼다. null은 값을 비우는 것이다.
 * 제목은 비워 둘 수 없다.
 */
export function storedValue(name: RequestValueName, value: unknown): string | null {
  if (name === "title") {
    if (typeof value !== "string" || value.trim() === "") {
      throw new LedgerError("title_required", "요청의 제목은 비워 둘 수 없다");
    }
    return value;
  }
  if (value === null) {
    return null;
  }
  switch (name) {
    case "requester":
      return JSON.stringify(checkedParty(value, "요청자"));
    case "promise":
      return JSON.stringify(checkedPromise(value));
    case "due":
      return externalTime(value, "기한");
    case "urgency":
      return oneOf(value, "긴급도", PRIORITY_LEVELS);
    case "importance":
      return oneOf(value, "중요도", PRIORITY_LEVELS);
  }
}

/** 저장한 값을 조회와 변경 이력에 내보낼 형태로 바꾼다. */
export function parsedValue(name: RequestValueName, stored: string | null): JsonValue {
  if (stored === null) {
    return null;
  }
  return name === "requester" || name === "promise" ? (JSON.parse(stored) as JsonValue) : stored;
}

/** 약속한 결과에서 해 주기로 한 일만 꺼낸다. */
export function promisedWork(stored: string | null): string | null {
  return stored === null ? null : (JSON.parse(stored) as PromisedOutcome).work;
}

export function readValue(row: Row, name: RequestValueName): ValueState {
  return {
    value: (row[name] as string | null) ?? null,
    setBy: (row[`${name}_set_by`] as SetBy | null) ?? null,
    userSetAt: (row[`${name}_user_set_at`] as string | null) ?? null,
    evidenceAt: WITH_EVIDENCE_TIME.includes(name)
      ? ((row[`${name}_evidence_at`] as string | null) ?? null)
      : null,
  };
}

/** 값 하나를 저장하는 컬럼과 값. */
export function valueColumns(name: RequestValueName, state: ValueState): [string, string | null][] {
  const columns: [string, string | null][] = [
    [name, state.value],
    [`${name}_set_by`, state.setBy],
    [`${name}_user_set_at`, state.userSetAt],
  ];
  if (WITH_EVIDENCE_TIME.includes(name)) {
    columns.push([`${name}_evidence_at`, state.evidenceAt]);
  }
  return columns;
}

/** 변경 이력에 적는 값 하나의 모습. 값뿐 아니라 정한 주체와 사용자 지정도 함께 적는다. */
export function valueSnapshot(name: RequestValueName, state: ValueState): JsonValue {
  const snapshot: { [key: string]: JsonValue } = {
    value: parsedValue(name, state.value),
    setBy: state.setBy,
    userSetAt: state.userSetAt,
  };
  if (WITH_EVIDENCE_TIME.includes(name)) {
    snapshot.evidenceAt = state.evidenceAt;
  }
  return snapshot;
}

/**
 * 두 값이 같은 값인지. 주체가 든 값은 JSON 문자열이 아니라 같은 주체인지로 가린다.
 * 같은 주체인데 이름 표기만 다르면 같은 값이다. 약속한 결과는 해 주기로 한 일과 결과를 알릴 사람들을 따로 본다.
 */
export function sameValue(name: RequestValueName, a: string | null, b: string | null): boolean {
  if (a === null || b === null || a === b) {
    return a === b;
  }
  if (name === "requester") {
    return sameParty(JSON.parse(a) as Party, JSON.parse(b) as Party);
  }
  if (name === "promise") {
    const [one, other] = [JSON.parse(a) as PromisedOutcome, JSON.parse(b) as PromisedOutcome];
    const keys = new Set(one.notify.map(partyKey));
    return (
      one.work === other.work &&
      one.notify.length === other.notify.length &&
      other.notify.every((party) => keys.has(partyKey(party)))
    );
  }
  return false;
}

/**
 * 비서가 쓰려는 값을 저장할 형태로 맞춘다. 결과를 알릴 사람들이 지금 값과 같은 사람들이면 지금의 순서를 그대로 둔다.
 * 알릴 사람들은 순서에 뜻이 없으므로, 순서만 다르게 쓴 것이 값을 바꾼 것으로 저장되거나 변경 이력을 남기지 않게 한다.
 * 이름 표기가 달라진 사람은 새 표기로 적는다.
 */
function keepingNotifyOrder(
  name: RequestValueName,
  current: string | null,
  value: string | null,
): string | null {
  if (name !== "promise" || current === null || value === null) {
    return value;
  }
  const [now, next] = [
    JSON.parse(current) as PromisedOutcome,
    JSON.parse(value) as PromisedOutcome,
  ];
  const written = new Map(next.notify.map((party) => [partyKey(party), party]));
  if (
    now.notify.length !== next.notify.length ||
    !now.notify.every((party) => written.has(partyKey(party)))
  ) {
    return value;
  }
  const notify = now.notify.map((party) => written.get(partyKey(party)) as Party);
  return JSON.stringify({ work: next.work, notify } satisfies PromisedOutcome);
}

export function sameValueState(a: ValueState, b: ValueState): boolean {
  return (
    a.value === b.value &&
    a.setBy === b.setBy &&
    a.userSetAt === b.userSetAt &&
    a.evidenceAt === b.evidenceAt
  );
}

/**
 * 이 쓰기 뒤에 그 값에 반영된 근거의 시각. 약속한 결과와 기한에만 있다.
 * 이 쓰기에 판본 근거를 달았으면 그 가운데 가장 늦은 원본 시각이고, 달지 않았으면 그대로다.
 */
export function reflectedEvidenceAt(
  name: RequestValueName,
  current: ValueState,
  evidence: CheckedEvidence,
): string | null {
  return WITH_EVIDENCE_TIME.includes(name) && evidence.latestAt !== null
    ? evidence.latestAt
    : current.evidenceAt;
}

/**
 * 사용자가 값을 썼을 때의 새 상태. 값이 같아도 사용자 지정이 걸리고 걸린 시각이 지금으로 바뀐다.
 * 빈 값에는 정한 주체가 없다.
 */
export function userWrites(
  name: RequestValueName,
  current: ValueState,
  value: string | null,
  at: string,
  evidence: CheckedEvidence,
): ValueState {
  return {
    value,
    setBy: value === null ? null : "user",
    userSetAt: at,
    evidenceAt: reflectedEvidenceAt(name, current, evidence),
  };
}

/** 비서가 값을 쓰려 할 때의 판정. */
export type AssistantWrite =
  /** 받아들인다. */
  | { readonly outcome: "apply"; readonly next: ValueState }
  /** 조건을 채우지 못했지만 지금 값과 같아 사용자의 지시와 어긋나지 않는다. 그 값은 건너뛴다. */
  | { readonly outcome: "skip" }
  /** 사용자 지정이 걸린 값을 조건 없이 다른 값으로 바꾸려 했다. */
  | { readonly outcome: "reject" };

/**
 * 비서가 값을 쓸 때의 규칙.
 * - 사용자 지정이 없으면 조건 없이 쓴다.
 * - 사용자 지정이 걸린 긴급도, 중요도, 요청자는 바꿀 수 없다.
 * - 사용자 지정이 걸린 약속한 결과와 기한은 나중 판본을 근거로 달았을 때만 바꿀 수 있다.
 * - 사용자 지정이 걸린 제목은 제목을 마지막으로 쓴 뒤에 기록이 연결됐거나 작업이 더해졌을 때만 바꿀 수 있다.
 * 조건을 채워 바꾸면 정한 주체는 비서가 되고 사용자 지정과 걸린 시각은 그대로다.
 * 지금 값과 같은 값도 같은 조건을 보고, 조건을 못 채우면 거부하지 않고 건너뛴다.
 * 같은 주체를 이름 표기만 다르게 쓴 것도 같은 값이어서, 건너뛸 때는 표기도 바꾸지 않는다.
 * 결과를 알릴 사람들을 순서만 다르게 쓴 것은 받아들인 뒤에도 바뀐 것이 아니다.
 */
export function assistantWrites(
  name: RequestValueName,
  current: ValueState,
  value: string | null,
  evidence: CheckedEvidence,
  addedAfterTitle: boolean,
): AssistantWrite {
  let allowed = true;
  if (current.userSetAt !== null) {
    if (name === "title") {
      allowed = addedAfterTitle;
    } else if (WITH_EVIDENCE_TIME.includes(name)) {
      allowed = hasLaterRevision(evidence.revisionTimes, current.userSetAt, current.evidenceAt);
    } else {
      allowed = false;
    }
  }
  if (!allowed) {
    return sameValue(name, value, current.value) ? { outcome: "skip" } : { outcome: "reject" };
  }
  return {
    outcome: "apply",
    next: {
      value: keepingNotifyOrder(name, current.value, value),
      setBy: value === null ? null : "assistant",
      userSetAt: current.userSetAt,
      evidenceAt: reflectedEvidenceAt(name, current, evidence),
    },
  };
}
