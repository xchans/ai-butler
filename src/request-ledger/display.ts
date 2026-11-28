// 작업의 표시와 차례. 저장하지 않고 조회할 때 계산한다.
// 끝나지 않은 작업은 스펙의 "조회할 때 계산하는 값" 표에서 먼저 맞는 줄 하나로 표시한다.
import { partyKey } from "./party.ts";
import type { TaskStatus } from "./task.ts";
import type { Party } from "./types.ts";

/** 표시의 코드. 표의 순서대로다. */
export const TASK_DISPLAYS = [
  "closed_remaining",
  "must_stop",
  "on_hold",
  "predecessor_cancelled",
  "predecessor_pending",
  "waiting",
  "actionable",
] as const;

/**
 * 끝나지 않은 작업의 표시. 닫힌 요청의 남은 작업, 멈춰야 함, 보류, 선행 작업 취소됨, 선행 작업 대기, 대기,
 * 진행할 수 있음이다.
 */
export type TaskDisplay = (typeof TASK_DISPLAYS)[number];

/** 표시와 차례를 계산하는 데 쓰는 작업 하나의 값. 모두 저장된 값이다. */
export type TaskFacts = {
  readonly id: string;
  readonly status: TaskStatus;
  readonly assignee: Party | null;
  /** 대기 대상의 주체. */
  readonly waitingFor: Party | null;
  /** 먼저 끝나야 하는 작업들. */
  readonly dependsOn: readonly string[];
  /** 사용자가 정한 차례. */
  readonly userTurn: Party | null;
  /** 이 작업에 건 보류가 남아 있는지. 요청에 건 보류는 세지 않는다. */
  readonly held: boolean;
};

/** 표의 줄을 가리는 데 쓰는, 작업이 속한 요청의 값. */
export type DisplayContext = {
  /** 요청에 건 보류가 남아 있는지. 요청을 보류하면 그 요청의 모든 작업이 보류된 것으로 본다. */
  readonly requestHeld: boolean;
  /** 같은 요청의 작업의 상태. 선행 작업의 상태를 보는 데 쓴다. */
  readonly statusOf: (taskId: string) => TaskStatus | undefined;
};

/** 계산한 작업 하나의 모습. */
export type TaskStanding = {
  /** 자기에게 걸린 보류나 속한 요청에 걸린 보류가 하나라도 남아 있는지. 끝난 작업에도 나온다. */
  readonly onHold: boolean;
  /** 표시. 끝난 작업에는 없다. */
  readonly display: TaskDisplay | null;
  /** 차례. 지금 행동해야 하는 주체다. 없으면 null. */
  readonly turn: Party | null;
};

/** 표의 한 줄. */
export type DisplayRule = {
  readonly display: TaskDisplay;
  /** 작업이 이 줄에 해당하는지. */
  readonly applies: (task: TaskFacts, context: DisplayContext) => boolean;
  /**
   * 이 줄의 차례. 차례가 없는 줄이면 null을 돌려준다.
   * `honorsUserTurn`이 true인 줄은 사용자가 정한 차례가 있으면 이 값 대신 그 값을 쓴다.
   */
  readonly turn: (task: TaskFacts) => Party | null;
  /** 사용자가 정한 차례를 쓰는 줄인지. 표의 1~3번 줄은 사용자가 정한 차례가 있어도 차례가 없다. */
  readonly honorsUserTurn: boolean;
};

export function isFinishedStatus(status: TaskStatus | undefined): boolean {
  return status === "done" || status === "cancelled";
}

const noTurn = (): null => null;

/**
 * 표의 줄들. 위에서부터 보고 먼저 맞는 줄로 표시한다.
 * 1번(닫힌 요청의 남은 작업)과 2번(멈춰야 함)은 닫기와 끝내기로 한 사유를 만드는 단계에서 이 목록의 맨 앞에
 * 표의 순서대로 더한다. 그 두 줄도 사용자가 정한 차례를 쓰지 않는 줄이다.
 */
export const DISPLAY_RULES: readonly DisplayRule[] = [
  {
    // 3. 작업이나 요청이 보류됐다
    display: "on_hold",
    applies: (task, context) => task.held || context.requestHeld,
    turn: noTurn,
    honorsUserTurn: false,
  },
  {
    // 4. 먼저 끝나야 하는 작업이 취소됐다. 선행 작업이 여럿이면 하나라도 취소됐을 때다
    display: "predecessor_cancelled",
    applies: (task, context) =>
      task.dependsOn.some((predecessor) => context.statusOf(predecessor) === "cancelled"),
    turn: noTurn,
    honorsUserTurn: true,
  },
  {
    // 5. 먼저 끝나야 하는 작업이 끝나지 않았다. 취소된 것이 없고 하나라도 끝나지 않았을 때다
    display: "predecessor_pending",
    applies: (task, context) =>
      task.dependsOn.some((predecessor) => !isFinishedStatus(context.statusOf(predecessor))),
    turn: noTurn,
    honorsUserTurn: true,
  },
  {
    // 6. 상태가 대기다. 차례는 대기 대상의 주체다
    display: "waiting",
    applies: (task) => task.status === "waiting",
    turn: (task) => task.waitingFor,
    honorsUserTurn: true,
  },
  {
    // 7. 상태가 할 일이나 진행 중이다. 차례는 담당이고, 담당이 비어 있으면 차례가 없다
    display: "actionable",
    applies: (task) => task.status === "todo" || task.status === "in_progress",
    turn: (task) => task.assignee,
    honorsUserTurn: true,
  },
];

/** 작업 하나의 표시와 차례를 계산한다. */
export function taskStanding(task: TaskFacts, context: DisplayContext): TaskStanding {
  const onHold = task.held || context.requestHeld;
  if (isFinishedStatus(task.status)) {
    return { onHold, display: null, turn: null };
  }
  const rule = DISPLAY_RULES.find((candidate) => candidate.applies(task, context));
  if (rule === undefined) {
    // 끝나지 않은 작업은 마지막 두 줄 가운데 하나에는 해당한다.
    throw new Error(`표시를 정할 수 없는 작업이다 (${task.id}, ${task.status})`);
  }
  return {
    onHold,
    display: rule.display,
    turn: rule.honorsUserTurn && task.userTurn !== null ? task.userTurn : rule.turn(task),
  };
}

/**
 * 요청의 차례. 끝나지 않은 작업들의 차례를 작업의 순서대로 모은 것이다. 같은 주체는 한 번만 넣는다.
 * 풀리지 않은 질문이나 승인이 달린 열린 요청이면(`awaitingUser`) 사용자를 더한다.
 */
export function requestTurn(taskTurns: readonly (Party | null)[], awaitingUser: boolean): Party[] {
  const turn = new Map<string, Party>();
  const user: Party = { kind: "user" };
  for (const party of awaitingUser ? [...taskTurns, user] : taskTurns) {
    if (party !== null && !turn.has(partyKey(party))) {
      turn.set(partyKey(party), party);
    }
  }
  return [...turn.values()];
}
