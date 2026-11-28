// 목록 조회. 열린 요청을 계산한 상태, 차례, 표시와 함께 정해진 순서로 돌려준다.
// 웹 화면과 스킬이 같은 순서를 보도록 순서는 원장이 정한다.
import type { Row } from "./changes.ts";
import { inReadTransaction, type LedgerDb } from "./db.ts";
import type { TaskDisplay } from "./display.ts";
import { LedgerError } from "./errors.ts";
import {
  type HoldView,
  holdView,
  nullableText,
  type OpenItemView,
  openItemView,
  type ValueView,
  valueView,
} from "./get-request.ts";
import { checkedFields, oneOf } from "./input.ts";
import { type RequestState, readRequestRows, standingOf, taskStandingIn } from "./status.ts";
import type { TaskStatus } from "./task.ts";
import type { Party } from "./types.ts";
import type { PriorityLevel, PromisedOutcome } from "./value.ts";

/** 목록을 거를 수 있는 요청의 상태. 열린 요청의 상태인 접수와 진행 중이다. */
const LISTED_STATES = ["open", "in_progress"] as const satisfies readonly RequestState[];

export type ListRequestsFilter = {
  /** 내 차례인 요청만. true만 받는다. 없으면 차례로 거르지 않는다. */
  readonly myTurn?: true;
  /** 이 상태인 요청만. */
  readonly state?: (typeof LISTED_STATES)[number];
};

/** 목록에 나오는 작업 하나. 작업별 표시다. */
export type TaskSummary = {
  readonly id: string;
  /** 할 일. */
  readonly work: string;
  readonly status: TaskStatus;
  /** 보류로 조회되는지. */
  readonly onHold: boolean;
  /** 표시. 끝난 작업에는 없다. */
  readonly display: TaskDisplay | null;
  /** 차례. 없으면 null. */
  readonly turn: Party | null;
};

/** 목록에 나오는 요청 하나. 계산한 값은 요청 조회와 같은 계산으로 구한다. */
export type RequestSummary = {
  readonly id: string;
  /** 접수 시각. */
  readonly createdAt: string;
  /** 미정. 처리할 요청인지 아직 정해지지 않았다. */
  readonly undecided: boolean;
  readonly title: ValueView<string>;
  readonly requester: ValueView<Party>;
  readonly promise: ValueView<PromisedOutcome>;
  readonly due: ValueView<string>;
  readonly urgency: ValueView<PriorityLevel>;
  readonly importance: ValueView<PriorityLevel>;
  /** 사용자가 정한 처리 순서. 정하지 않았으면 null. */
  readonly order: number | null;
  /** 진척. */
  readonly progress: string | null;
  /** 요청의 상태. */
  readonly state: RequestState;
  /** 요청의 차례. */
  readonly turn: readonly Party[];
  /** 내 차례인 요청인지. */
  readonly myTurn: boolean;
  /** 다음 작업 미정. */
  readonly nextTaskUndecided: boolean;
  /** 작업 수. */
  readonly taskCount: number;
  /** 끝난 작업의 수. 완료와 취소를 센다. */
  readonly finishedTaskCount: number;
  /** 작업별 표시. 더한 순서다. */
  readonly tasks: readonly TaskSummary[];
  /** 걸려 있는 보류들. */
  readonly holds: readonly HoldView[];
  /** 풀리지 않은 확인할 사항들. */
  readonly unresolvedOpenItems: readonly OpenItemView[];
};

/** 긴급도와 중요도의 순서. 높음, 보통, 낮음 순이고 값이 없으면 가장 낮은 값 뒤다. */
function levelRank(column: string): string {
  return `CASE ${column} WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END`;
}

/**
 * 목록의 순서. 사용자가 처리 순서를 정한 요청이 그 순서대로 먼저 오고, 나머지는 긴급도, 중요도, 기한, 접수 시각 순이다.
 * 기한이 없는 요청은 기한이 있는 요청 뒤에 온다. 처리 순서가 같은 요청끼리도 뒤의 값들로 가른다.
 * 접수 시각도 같으면 등록한 순서다. 시각은 한 가지 형태로 저장하므로 문자열 순서가 곧 시각 순서다.
 */
const LIST_ORDER = `
  user_order IS NULL, user_order,
  ${levelRank("urgency")},
  ${levelRank("importance")},
  due IS NULL, due,
  created_at, created_seq`;

function summary(db: LedgerDb, row: Row): RequestSummary {
  const id = String(row.id);
  // 상태, 차례, 표시는 저장하지 않는다. 요청 조회와 같은 계산으로 구한다.
  const rows = readRequestRows(db, id);
  const standing = standingOf(rows);
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
    order: typeof row.user_order === "number" ? row.user_order : null,
    progress: nullableText(row.progress),
    state: standing.state,
    turn: standing.turn,
    myTurn: standing.myTurn,
    nextTaskUndecided: standing.nextTaskUndecided,
    taskCount: standing.taskCount,
    finishedTaskCount: standing.finishedTaskCount,
    tasks: rows.tasks.map((task) => {
      const taskId = String(task.id);
      return {
        id: taskId,
        work: String(task.work),
        status: task.status as TaskStatus,
        ...taskStandingIn(standing, taskId),
      };
    }),
    holds: rows.holds.map(holdView),
    unresolvedOpenItems: rows.openItems
      .filter((openItem) => openItem.resolved_at === null)
      .map(openItemView),
  };
}

/**
 * 요청의 목록을 정해진 순서로 돌려준다. 내 차례인 것만, 상태별로 거를 수 있다.
 * 조회 한 번은 한 시점의 값을 돌려준다. 조회하는 사이에 다른 프로세스가 쓴 것이 섞이지 않는다.
 * 닫힌 요청의 목록과 닫힌 이유로 거르기는 닫기를 만드는 단계에서 더한다.
 */
export function listRequests(db: LedgerDb, filter: ListRequestsFilter = {}): RequestSummary[] {
  const fields = checkedFields(filter, "listRequests의 인자", ["myTurn", "state"]);
  if (fields.myTurn !== undefined && fields.myTurn !== true) {
    throw new LedgerError(
      "invalid_argument",
      "myTurn은 true만 받는다. 내 차례로 거르지 않으려면 적지 않는다",
    );
  }
  const state =
    fields.state === undefined ? undefined : oneOf(fields.state, "state", LISTED_STATES);
  return inReadTransaction(db, () =>
    db
      .prepare(`SELECT * FROM requests ORDER BY ${LIST_ORDER}`)
      .all()
      .map((row) => summary(db, row))
      .filter(
        (request) =>
          (fields.myTurn === undefined || request.myTurn) &&
          (state === undefined || request.state === state),
      ),
  );
}
