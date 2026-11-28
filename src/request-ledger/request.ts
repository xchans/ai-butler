// 요청을 등록하고 요청의 값을 쓴다. 값마다 정한 주체와 사용자 지정을 함께 저장한다.
import type { WriteScope } from "./changes.ts";
import { LedgerError } from "./errors.ts";
import { type CheckedEvidence, checkedEvidence, evidenceJson } from "./evidence.ts";
import { checkedFields, distinctOneOf, distinctTexts, type Fields } from "./input.ts";
import { connectRecord } from "./link.ts";
import { existingRecord, existingRequest } from "./lookup.ts";
import { wroteAfter } from "./ordering.ts";
import type { EvidenceRef, JsonValue, Party, TimeInput } from "./types.ts";
import {
  assistantWrites,
  EMPTY_VALUE,
  type PriorityLevel,
  promisedWork,
  REQUEST_VALUE_NAMES,
  type RequestValueName,
  readValue,
  reflectedEvidenceAt,
  sameValueState,
  storedValue,
  userWrites,
  type ValueState,
  valueColumns,
  valueSnapshot,
} from "./value.ts";

/** 약속한 결과를 쓸 때 받는 형태. 결과를 알릴 사람들은 없으면 빈 목록이다. */
export type PromisedOutcomeInput = {
  readonly work: string;
  readonly notify?: readonly Party[];
};

/** 요청의 값. 제목을 뺀 값은 null로 비울 수 있다. */
export type RequestValuesInput = {
  readonly title?: string;
  readonly requester?: Party | null;
  readonly promise?: PromisedOutcomeInput | null;
  readonly due?: TimeInput | null;
  readonly urgency?: PriorityLevel | null;
  readonly importance?: PriorityLevel | null;
};

export type CreateRequestInput = WriteGrounds & {
  /** 사용자가 명시한 값. 정한 주체가 사용자이고 사용자 지정이 걸린다. 사용자의 쓰기에만 넘길 수 있다. */
  readonly stated?: RequestValuesInput;
  /** 비서가 정한 값. 정한 주체가 비서이고 사용자 지정이 없다. 주체가 사용자인 쓰기에도 넘길 수 있다. */
  readonly decided?: RequestValuesInput;
  /** 처리할 요청인지 아직 정해지지 않았으면 true. 미정은 등록할 때만 붙일 수 있다. */
  readonly undecided?: boolean;
  /** 접수 원본으로 연결할 기록들. 이미 저장된 기록의 식별자다. 같은 쓰기에서 연결한다. */
  readonly intake?: readonly string[];
};

export type CreateRequestResult = {
  readonly id: string;
  /** 접수 시각. 요청을 등록한 시각이다. */
  readonly createdAt: string;
};

/**
 * 값을 정하는 쓰기에 함께 다는 근거. 요청을 등록하거나 작업을 더하면서 처음 정하는 값에도 달 수 있고,
 * 그때 단 근거가 그 값에 반영된 근거가 된다.
 */
export type WriteGrounds = {
  readonly evidence?: readonly EvidenceRef[];
};

export type UpdateRequestInput = WriteGrounds & {
  readonly requestId: string;
  readonly title?: string;
  readonly requester?: Party | null;
  readonly promise?: PromisedOutcomeInput | null;
  readonly due?: TimeInput | null;
  /** 미정을 푼다. false만 받는다. 한 번 풀면 다시 붙일 수 없다. */
  readonly undecided?: false;
  /** 사용자 지정을 풀 값. 사용자만 푼다. 값과 정한 주체는 그대로 남는다. */
  readonly clearUserSet?: readonly ("title" | "requester" | "promise" | "due")[];
};

export type SetPriorityInput = WriteGrounds & {
  readonly requestId: string;
  readonly urgency?: PriorityLevel | null;
  readonly importance?: PriorityLevel | null;
  /** 사용자 지정을 풀 값. 사용자만 푼다. */
  readonly clearUserSet?: readonly ("urgency" | "importance")[];
};

const NAMES_IN_KOREAN: Record<RequestValueName, string> = {
  title: "제목",
  requester: "요청자",
  promise: "약속한 결과",
  due: "기한",
  urgency: "긴급도",
  importance: "중요도",
};

/**
 * 요청을 등록한다. 사용자가 명시한 값과 비서가 정한 값을 함께 받아, 사용자가 명시한 값에만 사용자 지정을 건다.
 * 제목은 비워 둘 수 없고, 나머지 값은 정해지지 않았으면 비워 둘 수 있다.
 */
export function createRequest(scope: WriteScope, input: CreateRequestInput): CreateRequestResult {
  const fields = checkedFields(input, "createRequest의 인자", [
    "stated",
    "decided",
    "undecided",
    "intake",
    "evidence",
  ]);
  const evidence = checkedEvidence(scope, fields.evidence);
  if (fields.stated !== undefined && scope.actor.kind !== "user") {
    throw new LedgerError(
      "requires_user",
      "사용자가 명시한 값(stated)은 사용자의 쓰기에만 넘길 수 있다. 사용자 지정은 사용자의 쓰기로만 걸린다",
    );
  }
  const stated = checkedFields(fields.stated ?? {}, "stated", REQUEST_VALUE_NAMES);
  const decided = checkedFields(fields.decided ?? {}, "decided", REQUEST_VALUE_NAMES);
  const both = REQUEST_VALUE_NAMES.filter(
    (name) => stated[name] !== undefined && decided[name] !== undefined,
  );
  if (both.length > 0) {
    throw new LedgerError(
      "invalid_argument",
      `같은 값이 stated와 decided에 함께 있다 (${both.join(", ")})`,
    );
  }
  if (fields.undecided !== undefined && typeof fields.undecided !== "boolean") {
    throw new LedgerError("invalid_argument", "미정(undecided)은 true나 false다");
  }
  const undecided = fields.undecided === true;
  if (stated.title === undefined && decided.title === undefined) {
    throw new LedgerError("title_required", "요청의 제목은 비워 둘 수 없다");
  }

  const states = new Map<RequestValueName, ValueState>();
  for (const name of REQUEST_VALUE_NAMES) {
    if (stated[name] !== undefined) {
      states.set(
        name,
        userWrites(name, EMPTY_VALUE, storedValue(name, stated[name]), scope.at, evidence),
      );
    } else if (decided[name] !== undefined) {
      const value = storedValue(name, decided[name]);
      // 처음 정하는 값에 단 근거가 그 값에 반영된 근거가 된다. null로 명시해 비운 값도 정한 값이다.
      states.set(name, {
        value,
        setBy: value === null ? null : "assistant",
        userSetAt: null,
        evidenceAt: reflectedEvidenceAt(name, EMPTY_VALUE, evidence),
      });
    } else {
      states.set(name, EMPTY_VALUE);
    }
  }
  const intake = distinctTexts(fields.intake, "접수 원본(intake)").map((recordId) =>
    existingRecord(scope, recordId),
  );

  const id = scope.newId();
  const columns: [string, string | number | null][] = [
    ["id", id],
    ["created_at", scope.at],
    ["created_seq", scope.seq],
    ["undecided", undecided ? 1 : 0],
    // 함께 들어온 접수 원본은 제목과 같은 쓰기이므로 두 순번이 같아, 제목을 쓴 뒤에 더해진 것으로 세지 않는다.
    ["added_seq", scope.seq],
    ["title_written_seq", scope.seq],
    ["promise_work_seq", states.get("promise")?.value == null ? null : scope.seq],
  ];
  const after: { [key: string]: JsonValue } = { undecided };
  for (const [name, state] of states) {
    columns.push(...valueColumns(name, state));
    if (!sameValueState(state, EMPTY_VALUE)) {
      after[name] = valueSnapshot(name, state);
    }
  }
  scope.run(
    `INSERT INTO requests (${columns.map(([column]) => column).join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
    ...columns.map(([, value]) => value),
  );
  scope.record({
    target: { kind: "request", id },
    requestId: id,
    before: null,
    after,
    evidence: evidenceJson(evidence),
  });
  for (const record of intake) {
    connectRecord(scope, record, id, null, "intake");
  }
  return { id, createdAt: scope.at };
}

/** 요청의 값을 쓰는 쓰기 하나가 받은 것. */
type ValueWrites = {
  readonly requestId: unknown;
  /** 쓸 값. 이름과 밖에서 받은 그대로의 값이다. */
  readonly values: readonly (readonly [RequestValueName, unknown])[];
  /** 사용자 지정을 풀 값. */
  readonly clearUserSet: readonly RequestValueName[];
  /** 미정을 푼다. */
  readonly decide: boolean;
  readonly evidence: CheckedEvidence;
};

/**
 * 요청의 값을 쓴다. 한 쓰기에 든 값 가운데 하나라도 규칙에 어긋나면 전체를 거부하고 오류에 그 값을 밝힌다.
 * 아무것도 바뀌지 않으면 변경 이력을 남기지 않는다.
 */
function writeRequestValues(scope: WriteScope, writes: ValueWrites): void {
  const row = existingRequest(scope, writes.requestId);
  const requestId = String(row.id);
  const byUser = scope.actor.kind === "user";
  if (writes.clearUserSet.length > 0 && !byUser) {
    throw new LedgerError("requires_user", "사용자 지정은 사용자만 풀 수 있다");
  }
  const written = writes.values.map(([name]) => name);
  const conflicting = writes.clearUserSet.filter((name) => written.includes(name));
  if (conflicting.length > 0) {
    throw new LedgerError(
      "invalid_argument",
      `값을 쓰면서 그 값의 사용자 지정을 풀 수는 없다 (${conflicting.join(", ")})`,
    );
  }
  // 제목을 마지막으로 쓴 뒤에 그 요청에 기록이 연결됐거나 작업이 더해졌는지. 순번으로 가린다.
  const addedAfterTitle = wroteAfter(Number(row.added_seq), Number(row.title_written_seq));

  const changed = new Map<RequestValueName, { before: ValueState; after: ValueState }>();
  const rejected: RequestValueName[] = [];
  let titleWritten = false;
  for (const [name, given] of writes.values) {
    const value = storedValue(name, given);
    const current = readValue(row, name);
    if (byUser) {
      // 사용자가 값을 쓰면 값이 같아도 사용자 지정이 걸린 시각이 지금으로 바뀌고 변경 이력이 남는다.
      changed.set(name, {
        before: current,
        after: userWrites(name, current, value, scope.at, writes.evidence),
      });
      titleWritten ||= name === "title";
      continue;
    }
    const decision = assistantWrites(name, current, value, writes.evidence, addedAfterTitle);
    if (decision.outcome === "reject") {
      rejected.push(name);
    } else if (decision.outcome === "apply" && !sameValueState(current, decision.next)) {
      changed.set(name, { before: current, after: decision.next });
      titleWritten ||= name === "title" && decision.next.value !== current.value;
    }
  }
  if (rejected.length > 0) {
    throw new LedgerError(
      "user_set_protected",
      `사용자 지정이 걸린 값은 비서가 조건 없이 바꿀 수 없다 (${rejected
        .map((name) => NAMES_IN_KOREAN[name])
        .join(", ")})`,
      rejected,
    );
  }
  for (const name of writes.clearUserSet) {
    const current = readValue(row, name);
    if (current.userSetAt !== null) {
      // 사용자 지정을 풀면 값과 정한 주체는 그대로 남는다.
      changed.set(name, { before: current, after: { ...current, userSetAt: null } });
    }
  }
  const decided = writes.decide && row.undecided === 1;
  if (changed.size === 0 && !decided) {
    return;
  }

  const columns: [string, string | number | null][] = [];
  const before: { [key: string]: JsonValue } = {};
  const after: { [key: string]: JsonValue } = {};
  for (const [name, change] of changed) {
    columns.push(...valueColumns(name, change.after));
    before[name] = valueSnapshot(name, change.before);
    after[name] = valueSnapshot(name, change.after);
  }
  if (titleWritten) {
    columns.push(["title_written_seq", scope.seq]);
  }
  const promise = changed.get("promise");
  if (promise && promisedWork(promise.before.value) !== promisedWork(promise.after.value)) {
    columns.push(["promise_work_seq", scope.seq]);
  }
  if (decided) {
    columns.push(["undecided", 0]);
    before.undecided = true;
    after.undecided = false;
  }
  scope.run(
    `UPDATE requests SET ${columns.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`,
    ...columns.map(([, value]) => value),
    requestId,
  );
  scope.record({
    target: { kind: "request", id: requestId },
    requestId,
    before,
    after,
    evidence: evidenceJson(writes.evidence),
  });
}

function givenValues(
  fields: Fields,
  names: readonly RequestValueName[],
): (readonly [RequestValueName, unknown])[] {
  return names.filter((name) => fields[name] !== undefined).map((name) => [name, fields[name]]);
}

const UPDATE_VALUES = ["title", "requester", "promise", "due"] as const;
const PRIORITY_VALUES = ["urgency", "importance"] as const;

/** 제목, 요청자, 약속한 결과, 기한을 쓰고, 미정을 풀고, 사용자 지정을 푼다. */
export function updateRequest(scope: WriteScope, input: UpdateRequestInput): void {
  const fields = checkedFields(input, "updateRequest의 인자", [
    "requestId",
    ...UPDATE_VALUES,
    "undecided",
    "clearUserSet",
    "evidence",
  ]);
  if (fields.undecided !== undefined && fields.undecided !== false) {
    throw new LedgerError(
      "undecided_only_at_creation",
      "미정은 등록할 때만 붙일 수 있다. updateRequest로는 풀 수만 있다",
    );
  }
  writeRequestValues(scope, {
    requestId: fields.requestId,
    values: givenValues(fields, UPDATE_VALUES),
    clearUserSet: distinctOneOf(fields.clearUserSet, "clearUserSet", UPDATE_VALUES),
    decide: fields.undecided === false,
    evidence: checkedEvidence(scope, fields.evidence),
  });
}

/** 긴급도와 중요도를 쓰고, 그 사용자 지정을 푼다. */
export function setPriority(scope: WriteScope, input: SetPriorityInput): void {
  const fields = checkedFields(input, "setPriority의 인자", [
    "requestId",
    ...PRIORITY_VALUES,
    "clearUserSet",
    "evidence",
  ]);
  writeRequestValues(scope, {
    requestId: fields.requestId,
    values: givenValues(fields, PRIORITY_VALUES),
    clearUserSet: distinctOneOf(fields.clearUserSet, "clearUserSet", PRIORITY_VALUES),
    decide: false,
    evidence: checkedEvidence(scope, fields.evidence),
  });
}
