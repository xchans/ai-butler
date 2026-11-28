// 요청의 상태와 차례, 다음 작업 미정. 저장하지 않고 조회할 때 계산한다.
// 요청 조회와 목록 조회가 여기 한 곳의 계산을 함께 쓴다.
import type { Row } from "./changes.ts";
import type { LedgerDb } from "./db.ts";
import {
  isFinishedStatus,
  requestTurn,
  type TaskFacts,
  type TaskStanding,
  taskStanding,
} from "./display.ts";
import { storedParty } from "./party.ts";
import type { TaskStatus } from "./task.ts";
import type { Party } from "./types.ts";

/**
 * 요청의 상태. 접수(`open`), 진행 중(`in_progress`), 닫힘(`done`)이다.
 * 접수와 진행 중은 작업에서 계산한다. 닫힘은 저장하는 값이고, 닫기를 만드는 단계부터 나온다.
 */
export type RequestState = "open" | "in_progress" | "done";

/** 요청 하나를 계산하는 데 쓰는 값. 모두 저장된 값이다. */
export type RequestFacts = {
  /** 요청에 건 보류가 남아 있는지. */
  readonly held: boolean;
  /** 풀리지 않은 질문이나 승인이 있는지. 미확인과 어긋남은 세지 않는다. */
  readonly awaitingUser: boolean;
  /** 요청의 작업들. 더한 순서다. */
  readonly tasks: readonly TaskFacts[];
};

/** 계산한 요청 하나의 모습. */
export type RequestStanding = {
  readonly state: RequestState;
  /** 요청의 차례. 끝나지 않은 작업들의 차례를 모은 것이다. */
  readonly turn: readonly Party[];
  /** 내 차례인 요청인지. 요청의 차례에 사용자가 들어 있다. */
  readonly myTurn: boolean;
  /** 다음 작업 미정. 열린 요청인데 끝나지 않은 작업이 없다. */
  readonly nextTaskUndecided: boolean;
  readonly taskCount: number;
  /** 끝난 작업의 수. 완료와 취소를 센다. */
  readonly finishedTaskCount: number;
  /** 작업마다 계산한 모습. 작업의 순서다. */
  readonly tasks: ReadonlyMap<string, TaskStanding>;
};

/** 계산한 요청에서 작업 하나의 모습을 꺼낸다. 그 요청의 작업이어야 한다. */
export function taskStandingIn(standing: RequestStanding, taskId: string): TaskStanding {
  const task = standing.tasks.get(taskId);
  if (task === undefined) {
    throw new Error(`계산한 요청에 없는 작업이다 (${taskId})`);
  }
  return task;
}

/** 시작한 작업의 상태. 이런 작업이 하나라도 있으면 요청은 진행 중이다. */
const STARTED: readonly TaskStatus[] = ["in_progress", "waiting", "done"];

/**
 * 요청의 상태, 차례, 다음 작업 미정과 작업마다의 표시와 차례를 계산한다.
 * 닫힌 요청과 끝내기로 정한 요청의 계산은 닫기와 끝내기로 한 사유를 만드는 단계에서 여기에 더한다.
 */
export function requestStanding(facts: RequestFacts): RequestStanding {
  const statuses = new Map(facts.tasks.map((task) => [task.id, task.status]));
  const context = {
    requestHeld: facts.held,
    statusOf: (taskId: string) => statuses.get(taskId),
  };
  const tasks = new Map(facts.tasks.map((task) => [task.id, taskStanding(task, context)]));
  const turn = requestTurn(
    [...tasks.values()].map((task) => task.turn),
    facts.awaitingUser,
  );
  const finishedTaskCount = facts.tasks.filter((task) => isFinishedStatus(task.status)).length;
  return {
    state: facts.tasks.some((task) => STARTED.includes(task.status)) ? "in_progress" : "open",
    turn,
    // 내 차례인지는 종류가 사용자인지로만 정한다.
    myTurn: turn.some((party) => party.kind === "user"),
    // 취소된 작업은 끝난 작업으로 센다.
    nextTaskUndecided: finishedTaskCount === facts.tasks.length,
    taskCount: facts.tasks.length,
    finishedTaskCount,
    tasks,
  };
}

/** 요청 하나를 계산하고 조회하는 데 쓰는 줄들. */
export type RequestRows = {
  /** 작업들. 더한 순서다. */
  readonly tasks: readonly Row[];
  /** 작업마다 먼저 끝나야 하는 작업들. */
  readonly dependsOn: ReadonlyMap<string, readonly string[]>;
  /** 걸려 있는 보류들. 요청에 건 것과 작업에 건 것이 함께 있다. */
  readonly holds: readonly Row[];
  /** 확인할 사항들. 푼 것도 있다. */
  readonly openItems: readonly Row[];
};

/** 요청 하나를 계산하는 데 쓰는 줄들을 읽는다. 여러 번 읽으므로 부르는 쪽이 읽기 트랜잭션 안에서 부른다. */
export function readRequestRows(db: LedgerDb, requestId: string): RequestRows {
  const all = (sql: string): Row[] => db.prepare(sql).all(requestId);
  const dependsOn = new Map<string, string[]>();
  const dependencies = all(
    `SELECT task_dependencies.task_id, task_dependencies.depends_on
       FROM task_dependencies JOIN tasks ON tasks.id = task_dependencies.task_id
      WHERE tasks.request_id = ?
      ORDER BY task_dependencies.rowid`,
  );
  for (const dependency of dependencies) {
    const taskId = String(dependency.task_id);
    let predecessors = dependsOn.get(taskId);
    if (predecessors === undefined) {
      predecessors = [];
      dependsOn.set(taskId, predecessors);
    }
    predecessors.push(String(dependency.depends_on));
  }
  return {
    tasks: all("SELECT * FROM tasks WHERE request_id = ? ORDER BY added_seq, rowid"),
    dependsOn,
    holds: all("SELECT * FROM holds WHERE request_id = ? ORDER BY rowid"),
    openItems: all("SELECT * FROM open_items WHERE request_id = ? ORDER BY rowid"),
  };
}

/** 사용자의 답을 기다리는 확인할 사항인지. 풀리지 않은 질문과 승인이다. */
function awaitsUser(openItem: Row): boolean {
  return (
    openItem.resolved_at === null && (openItem.kind === "question" || openItem.kind === "approval")
  );
}

/** 읽은 줄들로 요청 하나를 계산한다. */
export function standingOf(rows: RequestRows): RequestStanding {
  const heldTasks = new Set(rows.holds.map((hold) => hold.task_id));
  return requestStanding({
    // 작업을 가리키지 않는 보류가 요청에 건 보류다.
    held: heldTasks.has(null),
    awaitingUser: rows.openItems.some(awaitsUser),
    tasks: rows.tasks.map((task) => {
      const id = String(task.id);
      return {
        id,
        status: task.status as TaskStatus,
        assignee: storedParty(task.assignee),
        waitingFor: storedParty(task.waiting_for),
        dependsOn: rows.dependsOn.get(id) ?? [],
        userTurn: storedParty(task.turn),
        held: heldTasks.has(id),
      };
    }),
  });
}
