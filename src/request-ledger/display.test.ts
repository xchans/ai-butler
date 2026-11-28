// 작업 12 가운데 표시와 차례, 요청의 상태 계산을 확인한다.
// S12, S13(끝내기로 정한 요청과 닫힌 요청을 뺀 부분), S14(끝내기로 정한 요청을 뺀 부분), S39의 차례 부분.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { DISPLAY_RULES, TASK_DISPLAYS, type TaskDisplay } from "./display.ts";
import type { Ledger } from "./index.ts";
import { requestStanding } from "./status.ts";
import {
  csTeam,
  jiwon,
  me,
  minsu,
  openTestLedger,
  rejectsWith,
  triage,
  user,
} from "./test-support.ts";
import type { Party } from "./types.ts";

function setup(t: TestContext): { ledger: Ledger; requestId: string } {
  const { ledger } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  return { ledger, requestId };
}

/** 작업 하나의 표시와 차례. */
function shown(
  ledger: Ledger,
  requestId: string,
  taskId: string,
): [TaskDisplay | null, Party | null] {
  const task = ledger.getRequest(requestId).tasks.find((candidate) => candidate.id === taskId);
  assert.ok(task, `작업 ${taskId}가 조회되지 않는다`);
  return [task.display, task.turn];
}

/** 한 사례가 만든 작업. 표의 한 줄에 해당하는 작업 하나를 만들고 그 식별자를 돌려준다. */
type Arrange = (ledger: Ledger, requestId: string) => string;

/** 취소한 작업 하나를 더한다. */
function cancelledTask(ledger: Ledger, requestId: string): string {
  const { id } = ledger.addTask(triage, { requestId, work: "하지 않기로 한 조사" });
  ledger.cancelTask(user, { taskId: id });
  return id;
}

/** 끝나지 않은 작업 하나를 더한다. */
function pendingTask(ledger: Ledger, requestId: string): string {
  return ledger.addTask(triage, { requestId, work: "아직 끝나지 않은 조사", assignee: jiwon }).id;
}

test("S13: 표시 표의 줄마다 표시와 차례가 표대로 나온다. 표시는 코드로 조회된다", (t) => {
  // 표의 순서와 코드. 닫힌 요청의 남은 작업과 멈춰야 함은 닫기를 만드는 단계에서 확인한다.
  assert.deepEqual(TASK_DISPLAYS, [
    "closed_remaining",
    "must_stop",
    "on_hold",
    "predecessor_cancelled",
    "predecessor_pending",
    "waiting",
    "actionable",
  ]);
  const rows: { row: string; arrange: Arrange; display: TaskDisplay; turn: Party | null }[] = [
    {
      row: "3. 작업이 보류됐다",
      arrange: (ledger, requestId) => {
        const { id } = ledger.addTask(triage, { requestId, work: "원인 조사", assignee: minsu });
        ledger.placeHold(user, { requestId, taskId: id });
        return id;
      },
      display: "on_hold",
      turn: null,
    },
    {
      row: "3. 요청이 보류됐다",
      arrange: (ledger, requestId) => {
        const { id } = ledger.addTask(triage, { requestId, work: "원인 조사", assignee: minsu });
        ledger.placeHold(user, { requestId });
        return id;
      },
      display: "on_hold",
      turn: null,
    },
    {
      row: "4. 먼저 끝나야 하는 작업이 취소됐다",
      arrange: (ledger, requestId) =>
        ledger.addTask(triage, {
          requestId,
          work: "데이터 변경",
          assignee: minsu,
          dependsOn: [cancelledTask(ledger, requestId)],
        }).id,
      display: "predecessor_cancelled",
      turn: null,
    },
    {
      row: "5. 먼저 끝나야 하는 작업이 끝나지 않았다",
      arrange: (ledger, requestId) =>
        ledger.addTask(triage, {
          requestId,
          work: "데이터 변경",
          assignee: minsu,
          dependsOn: [pendingTask(ledger, requestId)],
        }).id,
      display: "predecessor_pending",
      turn: null,
    },
    {
      row: "6. 상태가 대기다",
      arrange: (ledger, requestId) =>
        ledger.addTask(triage, {
          requestId,
          work: "변경 대상 확인",
          assignee: minsu,
          status: "waiting",
          waitingFor: { party: csTeam, what: "변경 대상 목록" },
        }).id,
      display: "waiting",
      // 대기 대상의 주체다. 담당이 아니다.
      turn: csTeam,
    },
    {
      row: "7. 상태가 할 일이다",
      arrange: (ledger, requestId) =>
        ledger.addTask(triage, { requestId, work: "원인 조사", assignee: minsu }).id,
      display: "actionable",
      turn: minsu,
    },
    {
      row: "7. 상태가 진행 중이다",
      arrange: (ledger, requestId) =>
        ledger.addTask(triage, {
          requestId,
          work: "원인 조사",
          assignee: jiwon,
          status: "in_progress",
        }).id,
      display: "actionable",
      turn: jiwon,
    },
  ];

  for (const { row, arrange, display, turn } of rows) {
    const { ledger, requestId } = setup(t);
    const taskId = arrange(ledger, requestId);
    assert.deepEqual(shown(ledger, requestId, taskId), [display, turn], row);
  }
});

test("S13: 두 줄에 함께 해당하면 위의 줄이 나온다", (t) => {
  /** 대기인 작업에 넣을 값. */
  const waiting = { status: "waiting", waitingFor: { party: csTeam } } as const;
  const cases: { rows: string; arrange: Arrange; display: TaskDisplay }[] = [
    {
      rows: "3과 4: 보류됐고 선행 작업이 취소됐다",
      arrange: (ledger, requestId) => {
        const dependsOn = [cancelledTask(ledger, requestId)];
        const { id } = ledger.addTask(triage, { requestId, work: "데이터 변경", dependsOn });
        ledger.placeHold(user, { requestId, taskId: id });
        return id;
      },
      display: "on_hold",
    },
    {
      rows: "3과 5: 보류된 요청의 선행 작업 대기인 작업",
      arrange: (ledger, requestId) => {
        const dependsOn = [pendingTask(ledger, requestId)];
        const { id } = ledger.addTask(triage, { requestId, work: "데이터 변경", dependsOn });
        ledger.placeHold(user, { requestId });
        return id;
      },
      display: "on_hold",
    },
    {
      rows: "3과 6: 보류된 대기 작업",
      arrange: (ledger, requestId) => {
        const { id } = ledger.addTask(triage, { requestId, work: "변경 대상 확인", ...waiting });
        ledger.placeHold(user, { requestId, taskId: id });
        return id;
      },
      display: "on_hold",
    },
    {
      rows: "3과 7: 보류된 할 일",
      arrange: (ledger, requestId) => {
        const { id } = ledger.addTask(triage, { requestId, work: "원인 조사", assignee: me });
        ledger.placeHold(user, { requestId, taskId: id });
        return id;
      },
      display: "on_hold",
    },
    {
      rows: "4와 5: 선행 작업 둘 가운데 하나가 취소되고 하나가 끝나지 않았다",
      arrange: (ledger, requestId) =>
        ledger.addTask(triage, {
          requestId,
          work: "데이터 변경",
          dependsOn: [pendingTask(ledger, requestId), cancelledTask(ledger, requestId)],
        }).id,
      display: "predecessor_cancelled",
    },
    {
      rows: "4와 6: 대기인데 선행 작업이 취소됐다",
      arrange: (ledger, requestId) =>
        ledger.addTask(triage, {
          requestId,
          work: "변경 대상 확인",
          ...waiting,
          dependsOn: [cancelledTask(ledger, requestId)],
        }).id,
      display: "predecessor_cancelled",
    },
    {
      rows: "4와 7: 선행 작업이 취소된 작업은 진행할 수 있음으로 나오지 않는다",
      arrange: (ledger, requestId) =>
        ledger.addTask(triage, {
          requestId,
          work: "데이터 변경",
          assignee: me,
          status: "in_progress",
          dependsOn: [cancelledTask(ledger, requestId)],
        }).id,
      display: "predecessor_cancelled",
    },
    {
      rows: "5와 6: 대기인데 선행 작업이 끝나지 않았다",
      arrange: (ledger, requestId) =>
        ledger.addTask(triage, {
          requestId,
          work: "변경 대상 확인",
          ...waiting,
          dependsOn: [pendingTask(ledger, requestId)],
        }).id,
      display: "predecessor_pending",
    },
    {
      rows: "5와 7: 진행 중인데 선행 작업이 끝나지 않았다",
      arrange: (ledger, requestId) =>
        ledger.addTask(triage, {
          requestId,
          work: "데이터 변경",
          assignee: me,
          status: "in_progress",
          dependsOn: [pendingTask(ledger, requestId)],
        }).id,
      display: "predecessor_pending",
    },
  ];

  for (const { rows, arrange, display } of cases) {
    const { ledger, requestId } = setup(t);
    const taskId = arrange(ledger, requestId);
    // 위의 줄들은 모두 차례가 없다. 보류된 대기 작업도 차례 없이 나온다.
    assert.deepEqual(shown(ledger, requestId, taskId), [display, null], rows);
  }
});

test("S13: 표시를 가리는 규칙은 표의 순서대로 놓여 있다", () => {
  // 닫힌 요청의 남은 작업과 멈춰야 함은 닫기를 만드는 단계에서 이 목록의 맨 앞에 표의 순서대로 더한다.
  const codes = DISPLAY_RULES.map((rule) => rule.display);
  assert.deepEqual(
    codes,
    TASK_DISPLAYS.filter((code) => codes.includes(code)),
  );
  assert.deepEqual(codes.slice(-5), [
    "on_hold",
    "predecessor_cancelled",
    "predecessor_pending",
    "waiting",
    "actionable",
  ]);
});

test("S13: 선행 작업이 모두 끝나면 원래 표시로 돌아오고, 취소된 선행 작업은 의존을 지워야 풀린다", (t) => {
  const { ledger, requestId } = setup(t);
  const first = pendingTask(ledger, requestId);
  const second = pendingTask(ledger, requestId);
  const { id } = ledger.addTask(triage, {
    requestId,
    work: "데이터 변경",
    assignee: minsu,
    dependsOn: [first, second],
  });
  assert.deepEqual(shown(ledger, requestId, id), ["predecessor_pending", null]);

  // 하나만 끝나면 아직 기다린다.
  ledger.completeTask(user, { taskId: first });
  assert.deepEqual(shown(ledger, requestId, id), ["predecessor_pending", null]);
  ledger.completeTask(user, { taskId: second });
  assert.deepEqual(shown(ledger, requestId, id), ["actionable", minsu]);

  // 끝났던 선행 작업을 되돌리면 다시 기다린다.
  ledger.updateTask(user, { taskId: second, status: "in_progress" });
  assert.deepEqual(shown(ledger, requestId, id), ["predecessor_pending", null]);

  // 선행 작업이 취소되면 저절로 풀리지 않는다. 다른 선행 작업이 끝나 있어도 그렇다.
  ledger.cancelTask(user, { taskId: second });
  assert.deepEqual(shown(ledger, requestId, id), ["predecessor_cancelled", null]);
  ledger.updateTask(triage, { taskId: id, dependsOn: [first] });
  assert.deepEqual(shown(ledger, requestId, id), ["actionable", minsu]);
});

test("S13: 끝난 작업에는 표시도 차례도 없다", (t) => {
  const { ledger, requestId } = setup(t);
  const done = ledger.addTask(triage, { requestId, work: "원인 조사", assignee: me });
  const cancelled = ledger.addTask(triage, { requestId, work: "데이터 변경", assignee: me });
  ledger.completeTask(user, { taskId: done.id });
  ledger.cancelTask(user, { taskId: cancelled.id });

  assert.deepEqual(shown(ledger, requestId, done.id), [null, null]);
  assert.deepEqual(shown(ledger, requestId, cancelled.id), [null, null]);
  // 끝난 작업의 담당은 요청의 차례에 들지 않는다.
  const request = ledger.getRequest(requestId);
  assert.deepEqual([request.turn, request.myTurn], [[], false]);
});

test("S12: 한 요청에서 작업 하나가 대기이고 다른 하나가 보류여도, 무관한 작업은 진행할 수 있음으로 조회되고 요청의 차례에 그 담당이 들어 있다", (t) => {
  const { ledger, requestId } = setup(t);
  const waiting = ledger.addTask(triage, {
    requestId,
    work: "변경 대상 확인",
    assignee: jiwon,
    status: "waiting",
    waitingFor: { party: csTeam, what: "변경 대상 목록" },
  });
  const held = ledger.addTask(triage, { requestId, work: "데이터 변경", assignee: jiwon });
  ledger.placeHold(user, { requestId, taskId: held.id });
  const independent = ledger.addTask(triage, { requestId, work: "원인 조사", assignee: minsu });

  assert.deepEqual(shown(ledger, requestId, waiting.id), ["waiting", csTeam]);
  assert.deepEqual(shown(ledger, requestId, held.id), ["on_hold", null]);
  assert.deepEqual(shown(ledger, requestId, independent.id), ["actionable", minsu]);
  // 요청의 차례는 끝나지 않은 작업들의 차례를 작업 순서대로 모은 것이다. 보류된 작업의 담당은 들지 않는다.
  const request = ledger.getRequest(requestId);
  assert.deepEqual(request.turn, [csTeam, minsu]);
  assert.equal(request.myTurn, false);
});

test("S12: 담당이 사용자이고 진행할 수 있음인 작업이 있으면 내 차례인 요청이고, 이름이 사용자와 같아도 종류가 사람인 담당은 내 차례가 아니다", (t) => {
  const { ledger, requestId } = setup(t);
  // 이름이 사용자를 가리키는 말이어도 종류가 사람이면 사용자가 아니다.
  const namedLikeUser: Party = { kind: "person", name: "user" };
  ledger.addTask(triage, { requestId, work: "원인 조사", assignee: namedLikeUser });
  let request = ledger.getRequest(requestId);
  assert.deepEqual([request.turn, request.myTurn], [[namedLikeUser], false]);

  const mine = ledger.addTask(triage, { requestId, work: "요청자에게 회신", assignee: me });
  request = ledger.getRequest(requestId);
  assert.deepEqual(shown(ledger, requestId, mine.id), ["actionable", me]);
  assert.deepEqual([request.turn, request.myTurn], [[namedLikeUser, me], true]);
});

test("S12: 담당이 사용자여도 보류됐거나 선행 작업을 기다리는 작업뿐이면 내 차례가 아니다", (t) => {
  const { ledger, requestId } = setup(t);
  const investigate = ledger.addTask(triage, { requestId, work: "원인 조사", assignee: minsu });
  const held = ledger.addTask(triage, { requestId, work: "데이터 변경 승인", assignee: me });
  const hold = ledger.placeHold(user, { requestId, taskId: held.id });
  const blocked = ledger.addTask(triage, {
    requestId,
    work: "요청자에게 회신",
    assignee: me,
    dependsOn: [investigate.id],
  });

  assert.deepEqual(shown(ledger, requestId, held.id), ["on_hold", null]);
  assert.deepEqual(shown(ledger, requestId, blocked.id), ["predecessor_pending", null]);
  let request = ledger.getRequest(requestId);
  assert.deepEqual([request.turn, request.myTurn], [[minsu], false]);

  // 보류가 풀리면 내 차례가 된다.
  ledger.releaseHold(user, { holdId: hold.id });
  request = ledger.getRequest(requestId);
  assert.deepEqual([request.turn, request.myTurn], [[minsu, me], true]);
});

test("S12: 대기 대상의 주체가 사용자인 대기 작업이 있으면 내 차례이고, 차례에는 요청한 내용 없이 주체만 나온다", (t) => {
  const { ledger, requestId } = setup(t);
  const { id } = ledger.addTask(triage, {
    requestId,
    work: "데이터 변경",
    assignee: minsu,
    status: "waiting",
    waitingFor: { party: me, what: "변경해도 되는지 승인" },
  });

  const request = ledger.getRequest(requestId);
  // 작업에는 요청한 내용이 함께 나오지만, 차례는 주체뿐이다.
  assert.deepEqual(request.tasks[0]?.waitingFor, { party: me, what: "변경해도 되는지 승인" });
  assert.deepEqual(shown(ledger, requestId, id), ["waiting", { kind: "user" }]);
  assert.deepEqual([request.turn, request.myTurn], [[{ kind: "user" }], true]);
});

test("S12: 식별자가 있는 주체와 이름만 같고 식별자가 없는 주체는 요청의 차례에 따로 나오고, 같은 주체는 한 번만 나온다", (t) => {
  const { ledger, requestId } = setup(t);
  const jiwonByName: Party = { kind: "person", name: "김지원" };
  const jiwonRespelled: Party = { ...jiwon, name: "지원 (CS)" } as Party;
  ledger.addTask(triage, { requestId, work: "원인 조사", assignee: jiwon });
  ledger.addTask(triage, { requestId, work: "데이터 변경", assignee: jiwonByName });
  // 식별자가 같으면 이름 표기가 달라도 같은 주체다.
  ledger.addTask(triage, { requestId, work: "요청자에게 회신", assignee: jiwonRespelled });
  ledger.addTask(triage, {
    requestId,
    work: "변경 대상 확인",
    status: "waiting",
    waitingFor: { party: jiwonByName },
  });

  assert.deepEqual(ledger.getRequest(requestId).turn, [jiwon, jiwonByName]);
});

test("S12: 담당이 빈 작업은 진행할 수 있음으로 나오되 차례가 없다", (t) => {
  const { ledger, requestId } = setup(t);
  const { id } = ledger.addTask(triage, { requestId, work: "원인 조사" });

  assert.deepEqual(shown(ledger, requestId, id), ["actionable", null]);
  const request = ledger.getRequest(requestId);
  assert.deepEqual([request.turn, request.myTurn], [[], false]);
  // 끝나지 않은 작업이 있으므로 다음 작업 미정은 아니다.
  assert.equal(request.nextTaskUndecided, false);
});

test("S12: 대기 대상 없이 대기로 쓰면 거부된다", (t) => {
  const { ledger, requestId } = setup(t);
  assert.throws(
    () => ledger.addTask(triage, { requestId, work: "변경 대상 확인", status: "waiting" }),
    rejectsWith("waiting_target_mismatch"),
  );
  assert.deepEqual(ledger.getRequest(requestId).tasks, []);
});

test("S14: 작업이 없거나 할 일과 취소만 있으면 접수, 진행 중·대기·완료인 작업이 하나라도 있으면 진행 중이다", (t) => {
  type Step = (ledger: Ledger, requestId: string) => void;
  const todo: Step = (ledger, requestId) => {
    ledger.addTask(triage, { requestId, work: "할 일" });
  };
  const inProgress: Step = (ledger, requestId) => {
    ledger.addTask(triage, { requestId, work: "진행 중인 일", status: "in_progress" });
  };
  const waiting: Step = (ledger, requestId) => {
    ledger.addTask(triage, {
      requestId,
      work: "기다리는 일",
      status: "waiting",
      waitingFor: { party: csTeam },
    });
  };
  const done: Step = (ledger, requestId) => {
    ledger.completeTask(user, {
      taskId: ledger.addTask(triage, { requestId, work: "끝난 일" }).id,
    });
  };
  const cancelled: Step = (ledger, requestId) => {
    cancelledTask(ledger, requestId);
  };
  const cases: { name: string; tasks: Step[]; state: string }[] = [
    { name: "작업이 없다", tasks: [], state: "open" },
    { name: "모두 할 일", tasks: [todo, todo], state: "open" },
    { name: "취소만", tasks: [cancelled], state: "open" },
    { name: "할 일과 취소", tasks: [todo, cancelled], state: "open" },
    { name: "진행 중이 하나", tasks: [todo, inProgress], state: "in_progress" },
    { name: "대기가 하나", tasks: [todo, waiting], state: "in_progress" },
    { name: "완료가 하나", tasks: [todo, done], state: "in_progress" },
    { name: "완료만", tasks: [done], state: "in_progress" },
    { name: "완료와 취소", tasks: [done, cancelled], state: "in_progress" },
  ];

  for (const { name, tasks, state } of cases) {
    const { ledger, requestId } = setup(t);
    for (const add of tasks) {
      add(ledger, requestId);
    }
    assert.equal(ledger.getRequest(requestId).state, state, name);
  }
});

test("S14: 보류는 요청의 상태를 바꾸지 않는다", (t) => {
  const { ledger, requestId } = setup(t);
  ledger.addTask(triage, { requestId, work: "원인 조사" });
  ledger.placeHold(user, { requestId });
  assert.equal(ledger.getRequest(requestId).state, "open");

  ledger.addTask(triage, { requestId, work: "데이터 변경", status: "in_progress" });
  assert.equal(ledger.getRequest(requestId).state, "in_progress");
});

test("S14: 진행 중이던 유일한 작업을 취소해 할 일과 취소인 작업만 남은 요청은 접수로 조회된다", (t) => {
  const { ledger, requestId } = setup(t);
  ledger.addTask(triage, { requestId, work: "요청자에게 회신" });
  const { id } = ledger.addTask(triage, { requestId, work: "원인 조사", status: "in_progress" });
  assert.equal(ledger.getRequest(requestId).state, "in_progress");

  ledger.cancelTask(user, { taskId: id });

  const request = ledger.getRequest(requestId);
  assert.deepEqual(
    request.tasks.map((task) => task.status),
    ["todo", "cancelled"],
  );
  assert.equal(request.state, "open");
});

test("S14: 열린 요청에 끝나지 않은 작업이 없으면 다음 작업 미정으로 조회된다. 취소된 작업은 끝난 작업으로 센다", (t) => {
  const { ledger, requestId } = setup(t);
  // 작업이 하나도 없는 요청이다.
  assert.equal(ledger.getRequest(requestId).nextTaskUndecided, true);

  const first = ledger.addTask(triage, { requestId, work: "원인 조사" });
  const second = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  assert.equal(ledger.getRequest(requestId).nextTaskUndecided, false);

  ledger.completeTask(user, { taskId: first.id });
  assert.equal(ledger.getRequest(requestId).nextTaskUndecided, false);
  ledger.cancelTask(user, { taskId: second.id });
  assert.equal(ledger.getRequest(requestId).nextTaskUndecided, true);

  // 끝난 작업을 되돌리면 다음 작업이 다시 생긴다.
  ledger.updateTask(user, { taskId: second.id, status: "todo" });
  assert.equal(ledger.getRequest(requestId).nextTaskUndecided, false);
});

test("S14: 남은 작업이 모두 취소된 요청도 다음 작업 미정으로 나온다", (t) => {
  const { ledger, requestId } = setup(t);
  cancelledTask(ledger, requestId);
  cancelledTask(ledger, requestId);

  const request = ledger.getRequest(requestId);
  assert.deepEqual([request.state, request.nextTaskUndecided], ["open", true]);
});

test("S39: 풀리지 않은 질문이나 승인이 있는 열린 요청은 사용자 차례인 작업이 없어도 내 차례이고, 하나만 풀면 남으며 둘 다 풀면 빠진다", (t) => {
  for (const kinds of [
    ["question", "question"],
    ["approval", "question"],
    ["approval", "approval"],
  ] as const) {
    const label = kinds.join(", ");
    const { ledger, requestId } = setup(t);
    const { id: taskId } = ledger.addTask(triage, {
      requestId,
      work: "원인 조사",
      assignee: minsu,
    });
    assert.deepEqual(ledger.getRequest(requestId).turn, [minsu], label);

    // 하나는 요청에, 하나는 작업에 단다.
    const first = ledger.raiseOpenItem(triage, {
      requestId,
      kind: kinds[0],
      content: "환불 대상에 지난달 결제도 넣을까요?",
    });
    const second = ledger.raiseOpenItem(triage, {
      requestId,
      taskId,
      kind: kinds[1],
      content: "운영 DB를 조회해도 될까요?",
    });
    let request = ledger.getRequest(requestId);
    // 사용자 차례인 작업은 없다. 작업의 차례는 그대로이고 요청의 차례에 사용자가 더해진다.
    assert.deepEqual(shown(ledger, requestId, taskId), ["actionable", minsu], label);
    assert.deepEqual([request.turn, request.myTurn], [[minsu, me], true], label);

    ledger.resolveOpenItem(user, { openItemId: first.id, answer: "넣어 주세요" });
    request = ledger.getRequest(requestId);
    assert.deepEqual([request.turn, request.myTurn], [[minsu, me], true], label);

    ledger.resolveOpenItem(user, { openItemId: second.id, answer: "조회해도 됩니다" });
    request = ledger.getRequest(requestId);
    assert.deepEqual([request.turn, request.myTurn], [[minsu], false], label);
  }
});

test("S39: 미확인과 어긋남만 있는 요청은 그것만으로 내 차례가 되지 않는다", (t) => {
  const { ledger, requestId } = setup(t);
  ledger.addTask(triage, { requestId, work: "원인 조사", assignee: minsu });
  ledger.raiseOpenItem(triage, {
    requestId,
    kind: "unverified",
    content: "Jira 티켓에 접근할 수 없어 확인하지 못했다",
  });
  ledger.raiseOpenItem(triage, {
    requestId,
    kind: "mismatch",
    content: "완료로 표시됐지만 티켓은 열려 있다",
  });

  const request = ledger.getRequest(requestId);
  assert.equal(request.openItems.filter((item) => !item.resolved).length, 2);
  assert.deepEqual([request.turn, request.myTurn], [[minsu], false]);
});

test("S39: 사용자 차례인 작업이 이미 있으면 질문이 있어도 요청의 차례에 사용자는 한 번만 나오고, 질문을 풀어도 내 차례다", (t) => {
  const { ledger, requestId } = setup(t);
  ledger.addTask(triage, { requestId, work: "요청자에게 회신", assignee: me });
  const question = ledger.raiseOpenItem(triage, {
    requestId,
    kind: "question",
    content: "회신에 보상안을 넣을까요?",
  });
  assert.deepEqual(ledger.getRequest(requestId).turn, [me]);

  ledger.resolveOpenItem(user, { openItemId: question.id, answer: "넣지 않는다" });
  const request = ledger.getRequest(requestId);
  assert.deepEqual([request.turn, request.myTurn], [[me], true]);
});

test("S39: 작업이 없어 다음 작업 미정인 요청도 풀리지 않은 질문이 있으면 내 차례다", (t) => {
  const { ledger, requestId } = setup(t);
  ledger.raiseOpenItem(triage, { requestId, kind: "question", content: "처리할 요청인가요?" });

  const request = ledger.getRequest(requestId);
  assert.deepEqual(
    [request.state, request.nextTaskUndecided, request.turn, request.myTurn],
    ["open", true, [me], true],
  );
});

test("계산은 저장된 값만으로 한다: 작업의 순서대로 차례를 모으고, 작업 수와 끝난 수를 센다", () => {
  const facts = (
    status: "todo" | "in_progress" | "waiting" | "done" | "cancelled",
    id: string,
  ) => ({
    id,
    status,
    assignee: minsu,
    waitingFor: status === "waiting" ? csTeam : null,
    dependsOn: [],
    userTurn: null,
    held: false,
  });

  const standing = requestStanding({
    held: false,
    awaitingUser: true,
    tasks: [
      facts("waiting", "t1"),
      facts("todo", "t2"),
      facts("done", "t3"),
      facts("cancelled", "t4"),
    ],
  });

  assert.deepEqual(
    {
      state: standing.state,
      turn: standing.turn,
      myTurn: standing.myTurn,
      nextTaskUndecided: standing.nextTaskUndecided,
      taskCount: standing.taskCount,
      finishedTaskCount: standing.finishedTaskCount,
    },
    {
      state: "in_progress",
      turn: [csTeam, minsu, me],
      myTurn: true,
      nextTaskUndecided: false,
      taskCount: 4,
      finishedTaskCount: 2,
    },
  );
  assert.deepEqual(
    [...standing.tasks].map(([id, task]) => [id, task.display, task.onHold]),
    [
      ["t1", "waiting", false],
      ["t2", "actionable", false],
      ["t3", null, false],
      ["t4", null, false],
    ],
  );
});
