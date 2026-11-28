// 작업 13(사용자가 정한 차례와 처리 순서)의 완료 조건을 확인한다. S11, S3의 처리 순서와 차례 부분, S13의 차례 부분.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { test } from "node:test";
import type { Ledger } from "./index.ts";
import {
  at,
  csTeam,
  jiwon,
  me,
  minsu,
  openFileLedger,
  openTestLedger,
  rejectsWith,
  stored,
  type TestClock,
  triage,
  user,
  userViaSkill,
  verifier,
} from "./test-support.ts";
import type { Party } from "./types.ts";

const connector = { kind: "assistant", module: "channel-connectors" } as const;

/** 요청 하나와 담당이 정해진 작업 하나, Jira 기록의 판본을 원본 시각만 바꿔 더하는 도우미를 준비한다. */
function setup(t: TestContext): {
  ledger: Ledger;
  clock: TestClock;
  requestId: string;
  taskId: string;
  /** 그 원본 시각의 판본을 더하고 근거로 달 수 있는 참조를 돌려준다. */
  revisionAt(hhmm: string): { kind: "revision"; revisionId: string };
} {
  const { ledger, clock } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "원인 조사", assignee: minsu });
  return {
    ledger,
    clock,
    requestId,
    taskId,
    revisionAt(hhmm) {
      const { revisionId } = ledger.addRevision(connector, {
        source: "jira",
        sourceId: "VOC-301",
        originalAt: at(hhmm),
        body: `${hhmm}의 티켓 내용`,
      });
      return { kind: "revision", revisionId };
    },
  };
}

function taskOf(ledger: Ledger, requestId: string, taskId: string) {
  const task = ledger.getRequest(requestId).tasks.find((candidate) => candidate.id === taskId);
  assert.ok(task, `작업 ${taskId}가 조회되지 않는다`);
  return task;
}

/** 요청의 마지막 변경 이력에 적힌, 사용자가 정한 차례의 이전 값과 새 값. 적히지 않았으면 undefined다. */
function lastTurnChange(ledger: Ledger, requestId: string): [unknown, unknown] {
  const change = ledger.getRequest(requestId).changes.at(-1);
  assert.ok(change);
  return [
    (change.before as { turn?: unknown } | null)?.turn,
    (change.after as { turn?: unknown } | null)?.turn,
  ];
}

/** 작업의 조회되는 차례와, 사용자가 정한 차례. */
function turns(ledger: Ledger, requestId: string, taskId: string): [Party | null, Party | null] {
  const task = taskOf(ledger, requestId, taskId);
  return [task.turn, task.userTurn?.party ?? null];
}

test("S11: 사용자가 작업의 차례를 정하면 담당과 상태는 그대로이고 조회되는 차례만 바뀐다", (t) => {
  const { ledger, clock, requestId, taskId } = setup(t);
  ledger.updateTask(triage, { taskId, status: "in_progress" });
  const before = taskOf(ledger, requestId, taskId);
  assert.deepEqual([before.turn, before.userTurn], [minsu, null]);

  clock.set("12:00");
  ledger.setTurn(user, { taskId, turn: csTeam });

  const after = taskOf(ledger, requestId, taskId);
  assert.deepEqual(
    [after.assignee, after.status, after.waitingFor, after.display],
    [minsu, "in_progress", null, "actionable"],
  );
  assert.deepEqual(after.turn, csTeam);
  assert.deepEqual(after.userTurn, { party: csTeam, setAt: stored("12:00") });
  // 요청의 차례도 사용자가 정한 차례로 모인다.
  assert.deepEqual(ledger.getRequest(requestId).turn, [csTeam]);
  // 바뀐 것은 차례뿐이고, 변경 이력에 작업을 대상으로 남는다.
  const change = ledger.getRequest(requestId).changes.at(-1);
  assert.deepEqual(
    [change?.action, change?.target, change?.requestId, change?.actor],
    ["setTurn", { kind: "task", id: taskId }, requestId, user],
  );
  assert.deepEqual(
    [change?.before, change?.after],
    [{ turn: null }, { turn: { party: csTeam, setAt: stored("12:00") } }],
  );
  // 차례를 바로잡은 것은 비서의 판단을 바로잡은 것이어서, 밝히지 않으면 다음 유사 업무에도 적용한다.
  assert.deepEqual(change?.appliesTo, { scope: "similar_future", stated: false });
});

test("S11: 사용자가 정한 차례로 내 차례인 요청이 되고, clearTurn으로 지우면 계산한 차례로 돌아간다", (t) => {
  const { ledger, clock, requestId, taskId } = setup(t);
  assert.equal(ledger.getRequest(requestId).myTurn, false);

  clock.set("12:00");
  ledger.setTurn(user, { taskId, turn: me });
  assert.deepEqual(turns(ledger, requestId, taskId), [me, me]);
  assert.deepEqual(
    [ledger.getRequest(requestId).turn, ledger.getRequest(requestId).myTurn],
    [[me], true],
  );
  assert.deepEqual(
    ledger.listRequests({ myTurn: true }).map((request) => request.id),
    [requestId],
  );

  clock.set("12:30");
  ledger.clearTurn(userViaSkill, { taskId });

  assert.deepEqual(turns(ledger, requestId, taskId), [minsu, null]);
  assert.equal(ledger.getRequest(requestId).myTurn, false);
  const change = ledger.getRequest(requestId).changes.at(-1);
  assert.deepEqual(
    [change?.action, change?.target, change?.before, change?.after],
    [
      "clearTurn",
      { kind: "task", id: taskId },
      { turn: { party: me, setAt: stored("12:00") } },
      { turn: null },
    ],
  );
  // 지울 차례가 없으면 아무것도 바꾸지 않고 변경 이력도 남기지 않는다.
  const count = ledger.changesSince(0).length;
  ledger.clearTurn(user, { taskId });
  assert.equal(ledger.changesSince(0).length, count);
});

test("S11: 비서가 원본 시각이 차례를 정한 시각보다 뒤인 나중 판본을 근거로 상태, 담당, 대기 대상을 바꾸면 사용자가 정한 차례가 풀린다", (t) => {
  const writes = {
    상태: { status: "in_progress" },
    담당: { assignee: jiwon },
    "대기 대상": { status: "waiting", waitingFor: { party: csTeam, what: "변경 대상 목록" } },
  } as const;

  for (const [name, values] of Object.entries(writes)) {
    const { ledger, clock, requestId, taskId, revisionAt } = setup(t);
    clock.set("12:00");
    ledger.setTurn(user, { taskId, turn: me });
    clock.set("14:00");

    ledger.updateTask(verifier, { taskId, ...values, evidence: [revisionAt("12:01")] });

    const task = taskOf(ledger, requestId, taskId);
    assert.equal(task.userTurn, null, name);
    // 풀린 뒤에는 계산한 차례가 나온다.
    assert.deepEqual(
      task.turn,
      name === "담당" ? jiwon : name === "대기 대상" ? csTeam : minsu,
      name,
    );
    // 풀린 것이 그 쓰기의 변경 이력에 함께 남는다.
    const change = ledger.getRequest(requestId).changes.at(-1);
    assert.equal(change?.action, "updateTask", name);
    assert.deepEqual(
      lastTurnChange(ledger, requestId),
      [{ party: me, setAt: stored("12:00") }, null],
      name,
    );
  }
});

test("S11: 원본 시각이 차례를 정한 시각과 같은 판본으로는 상태가 바뀌어도 차례가 남고, 그 판본을 뒤의 판본과 함께 달면 풀린다", (t) => {
  const { ledger, clock, requestId, taskId, revisionAt } = setup(t);
  clock.set("12:00");
  ledger.setTurn(user, { taskId, turn: me });
  clock.set("14:00");
  const sameTime = revisionAt("12:00");

  ledger.updateTask(verifier, { taskId, status: "in_progress", evidence: [sameTime] });
  assert.equal(taskOf(ledger, requestId, taskId).status, "in_progress");
  assert.deepEqual(turns(ledger, requestId, taskId), [me, me]);

  // 단 판본 가운데 하나라도 차례를 정한 시각보다 뒤이면 풀린다.
  ledger.updateTask(verifier, {
    taskId,
    status: "todo",
    evidence: [sameTime, revisionAt("12:01")],
  });
  assert.deepEqual(turns(ledger, requestId, taskId), [minsu, null]);
});

test("S11: 이미 대기인 작업의 상태는 그대로 두고 뒤의 판본으로 대기 대상만 바꿔도 사용자가 정한 차례가 풀린다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const { id: taskId } = ledger.addTask(triage, {
    requestId,
    work: "변경 대상 확인",
    assignee: minsu,
    status: "waiting",
    waitingFor: { party: csTeam, what: "변경 대상 목록" },
  });
  clock.set("12:00");
  ledger.setTurn(user, { taskId, turn: me });
  clock.set("14:00");

  // 요청한 내용만 달라져도 대기 대상이 바뀐 것이다. 차례를 정한 시각보다 앞선 판본이면 차례는 남는다.
  ledger.updateTask(verifier, {
    taskId,
    waitingFor: { party: csTeam, what: "변경 대상 목록과 건수" },
    evidence: [revisionAt("11:00")],
  });
  assert.deepEqual(turns(ledger, requestId, taskId), [me, me]);

  ledger.updateTask(verifier, {
    taskId,
    waitingFor: { party: jiwon, what: "변경 대상 목록" },
    evidence: [revisionAt("12:30")],
  });

  const task = taskOf(ledger, requestId, taskId);
  // 상태와 담당은 그대로이고 대기 대상만 바뀌었다.
  assert.deepEqual([task.status, task.assignee, task.waitingFor?.party], ["waiting", minsu, jiwon]);
  assert.deepEqual([task.userTurn, task.turn], [null, jiwon]);
  const change = ledger.getRequest(requestId).changes.at(-1);
  assert.deepEqual(Object.keys(change?.after ?? {}).sort(), ["turn", "waitingFor"]);
  assert.deepEqual(lastTurnChange(ledger, requestId), [
    { party: me, setAt: stored("12:00") },
    null,
  ]);
});

test("S11: 차례를 정한 시각보다 뒤여도 그 값에 이미 반영된 근거보다 앞선 판본으로 값을 바꾸면 차례는 남는다", (t) => {
  const { ledger, clock, requestId, taskId, revisionAt } = setup(t);
  clock.set("12:00");
  ledger.setTurn(user, { taskId, turn: me });
  // 비서가 14시의 판본으로 같은 상태를 써서, 상태에 반영된 근거의 시각만 14시가 됐다.
  clock.set("14:01");
  ledger.updateTask(verifier, { taskId, status: "todo", evidence: [revisionAt("14:00")] });
  assert.deepEqual(turns(ledger, requestId, taskId), [me, me]);

  // 늦게 도착한 13시의 판본이다. 차례를 정한 12시보다 뒤지만 상태에 반영된 14시보다 앞서 나중 판본이 아니다.
  clock.set("15:00");
  const late = revisionAt("13:00");
  ledger.updateTask(verifier, { taskId, status: "in_progress", evidence: [late] });

  // 사용자가 바로잡은 적 없는 상태여서 값은 바뀌지만, 사용자가 정한 차례는 남는다.
  assert.equal(taskOf(ledger, requestId, taskId).status, "in_progress");
  assert.deepEqual(turns(ledger, requestId, taskId), [me, me]);
  assert.deepEqual(lastTurnChange(ledger, requestId), [undefined, undefined]);

  // 같은 판본이라도 그 판본이 나중 판본인 값(반영된 근거가 없는 담당)을 바꾸면 풀린다.
  ledger.updateTask(verifier, { taskId, assignee: jiwon, evidence: [late] });
  assert.deepEqual(turns(ledger, requestId, taskId), [jiwon, null]);
});

test("S11: 상태에 반영된 근거와 원본 시각이 같거나 그보다 뒤인 판본으로 상태를 바꾸면 차례가 풀린다", (t) => {
  for (const hhmm of ["14:00", "14:30"]) {
    const { ledger, clock, requestId, taskId, revisionAt } = setup(t);
    clock.set("12:00");
    ledger.setTurn(user, { taskId, turn: me });
    clock.set("14:01");
    ledger.updateTask(verifier, { taskId, status: "todo", evidence: [revisionAt("14:00")] });
    clock.set("15:00");

    ledger.updateTask(verifier, { taskId, status: "in_progress", evidence: [revisionAt(hhmm)] });

    assert.deepEqual(turns(ledger, requestId, taskId), [minsu, null], hhmm);
  }
});

test("S11: 사용자가 차례를 정한 뒤에 바로잡은 값은, 그 정정보다 뒤의 판본으로 바꿀 때만 차례가 풀린다", (t) => {
  const { ledger, clock, requestId, taskId, revisionAt } = setup(t);
  clock.set("12:00");
  ledger.setTurn(user, { taskId, turn: me });
  // 차례를 정한 뒤 13시에 사용자가 상태를 바로잡았다.
  clock.set("13:00");
  ledger.updateTask(user, { taskId, status: "in_progress" });
  clock.set("15:00");

  // 12시 30분의 판본은 차례를 정한 시각보다 뒤지만 상태의 정정보다 앞선다. 상태는 같은 값이라 건너뛰고,
  // 함께 쓴 할 일만 바뀐다. 차례는 남는다.
  ledger.updateTask(verifier, {
    taskId,
    status: "in_progress",
    work: "원인 재조사",
    evidence: [revisionAt("12:30")],
  });
  assert.equal(taskOf(ledger, requestId, taskId).work, "원인 재조사");
  assert.deepEqual(turns(ledger, requestId, taskId), [me, me]);

  ledger.updateTask(verifier, { taskId, status: "todo", evidence: [revisionAt("13:30")] });
  assert.deepEqual(turns(ledger, requestId, taskId), [minsu, null]);
});

test("S11: 사용자가 9시에 상태를 바로잡고 12시에 차례를 정한 작업에 비서가 원본 시각 10시인 판본을 근거로 상태를 쓰면, 상태는 바뀌고 차례는 남는다", (t) => {
  const { ledger, clock, requestId, taskId, revisionAt } = setup(t);
  clock.set("09:00");
  ledger.updateTask(user, { taskId, status: "in_progress" });
  clock.set("12:00");
  ledger.setTurn(user, { taskId, turn: me });
  clock.set("13:00");

  // 정정(9시)보다 뒤이므로 나중 판본이지만, 차례를 정한 시각(12시)보다는 앞선다.
  ledger.updateTask(verifier, {
    taskId,
    status: "waiting",
    waitingFor: { party: csTeam },
    evidence: [revisionAt("10:00")],
  });

  const task = taskOf(ledger, requestId, taskId);
  assert.equal(task.status, "waiting");
  assert.deepEqual(task.userTurn, { party: me, setAt: stored("12:00") });
  // 대기 대상의 주체 대신 사용자가 정한 차례가 나온다.
  assert.deepEqual([task.display, task.turn], ["waiting", me]);
  // 그 쓰기의 변경 이력에 차례는 적히지 않는다.
  assert.deepEqual(lastTurnChange(ledger, requestId), [undefined, undefined]);

  // 차례를 정한 시각보다 뒤의 판본으로 상태를 바꾸면 풀린다.
  ledger.updateTask(verifier, { taskId, status: "in_progress", evidence: [revisionAt("12:30")] });
  assert.deepEqual(turns(ledger, requestId, taskId), [minsu, null]);
});

test("S11: 비서가 근거 없이 값을 바꾸거나, 뒤의 판본을 달았어도 값이 그대로이면 사용자가 정한 차례는 남는다", (t) => {
  const { ledger, clock, requestId, taskId, revisionAt } = setup(t);
  clock.set("12:00");
  ledger.setTurn(user, { taskId, turn: me });
  clock.set("14:00");
  const later = revisionAt("13:00");

  // 사용자가 바로잡지 않은 상태는 비서가 근거 없이 바꿀 수 있다. 근거가 없으므로 차례는 남는다.
  ledger.updateTask(triage, { taskId, status: "in_progress" });
  assert.deepEqual(turns(ledger, requestId, taskId), [me, me]);
  // 뒤의 판본을 달았어도 상태, 담당, 대기 대상이 그대로이면 차례는 남는다.
  ledger.updateTask(verifier, {
    taskId,
    status: "in_progress",
    assignee: minsu,
    work: "원인 재조사",
    evidence: [later],
  });
  assert.equal(taskOf(ledger, requestId, taskId).work, "원인 재조사");
  assert.deepEqual(turns(ledger, requestId, taskId), [me, me]);
  // 같은 주체를 이름 표기만 다르게 쓴 담당도 같은 값이다. 표기는 바뀌어도 차례는 남는다.
  const other = ledger.addTask(triage, { requestId, work: "데이터 변경", assignee: jiwon });
  ledger.setTurn(user, { taskId: other.id, turn: me });
  const respelled = { ...jiwon, name: "지원 (CS)" } as Party;
  ledger.updateTask(verifier, {
    taskId: other.id,
    assignee: respelled,
    evidence: [revisionAt("15:00")],
  });
  assert.deepEqual(taskOf(ledger, requestId, other.id).assignee, respelled);
  assert.deepEqual(turns(ledger, requestId, other.id), [me, me]);

  // 사용자가 직접 상태와 담당을 바꿔도 차례는 사용자가 지울 때까지 남는다.
  clock.set("15:00");
  ledger.updateTask(user, { taskId, status: "todo", assignee: jiwon, evidence: [later] });
  assert.deepEqual(turns(ledger, requestId, taskId), [me, me]);
});

test("S11: 작업이 끝나면 사용자가 정한 차례가 풀리고, 되돌려도 돌아오지 않는다", (t) => {
  type Finish = (
    ledger: Ledger,
    taskId: string,
    evidence: { kind: "revision"; revisionId: string },
  ) => void;
  const finishes: Record<string, Finish> = {
    "사용자가 완료로 표시": (ledger, taskId) => ledger.completeTask(user, { taskId }),
    "사용자가 취소": (ledger, taskId) => ledger.cancelTask(user, { taskId }),
    // 차례를 정한 시각보다 앞선 판본을 근거로 끝내도 풀린다.
    "비서가 근거를 달아 완료": (ledger, taskId, evidence) =>
      ledger.completeTask(verifier, { taskId, evidence: [evidence] }),
    "비서가 사유를 적어 취소": (ledger, taskId) =>
      ledger.cancelTask(triage, { taskId, reason: "요청자가 필요 없다고 했다" }),
  };

  for (const [name, finish] of Object.entries(finishes)) {
    const { ledger, clock, requestId, taskId, revisionAt } = setup(t);
    const early = revisionAt("08:00");
    clock.set("12:00");
    ledger.setTurn(user, { taskId, turn: me });
    clock.set("13:00");

    finish(ledger, taskId, early);

    const finished = taskOf(ledger, requestId, taskId);
    assert.deepEqual(
      [finished.userTurn, finished.turn, finished.display],
      [null, null, null],
      name,
    );
    assert.deepEqual(
      lastTurnChange(ledger, requestId),
      [{ party: me, setAt: stored("12:00") }, null],
      name,
    );

    // 되돌린 작업에는 계산한 차례가 나온다.
    ledger.updateTask(user, { taskId, status: "todo" });
    assert.deepEqual(turns(ledger, requestId, taskId), [minsu, null], name);
  }
});

test("S11: 보류된 작업은 사용자가 정한 차례가 있어도 차례가 없고, 보류를 풀면 그 차례가 나온다", (t) => {
  const { ledger, requestId, taskId } = setup(t);
  ledger.setTurn(user, { taskId, turn: me });
  const onTask = ledger.placeHold(user, { requestId, taskId });

  let task = taskOf(ledger, requestId, taskId);
  assert.deepEqual([task.display, task.turn, task.userTurn?.party], ["on_hold", null, me]);
  assert.equal(ledger.getRequest(requestId).myTurn, false);

  // 요청에 건 보류도 같다. 보류된 작업에도 차례를 정해 둘 수는 있다.
  ledger.releaseHold(user, { holdId: onTask.id });
  const onRequest = ledger.placeHold(user, { requestId });
  ledger.setTurn(user, { taskId, turn: csTeam });
  task = taskOf(ledger, requestId, taskId);
  assert.deepEqual([task.display, task.turn, task.userTurn?.party], ["on_hold", null, csTeam]);

  ledger.releaseHold(user, { holdId: onRequest.id });
  task = taskOf(ledger, requestId, taskId);
  assert.deepEqual([task.display, task.turn], ["actionable", csTeam]);
});

test("S13: 사용자가 정한 차례는 선행 작업 취소됨, 선행 작업 대기, 대기, 진행할 수 있음에서 계산한 차례 대신 나온다", (t) => {
  const { ledger, requestId } = setup(t);
  const cancelled = ledger.addTask(triage, { requestId, work: "하지 않기로 한 조사" });
  ledger.cancelTask(user, { taskId: cancelled.id });
  const pending = ledger.addTask(triage, { requestId, work: "아직 끝나지 않은 조사" });
  const rows = {
    predecessor_cancelled: ledger.addTask(triage, {
      requestId,
      work: "데이터 변경",
      assignee: minsu,
      dependsOn: [cancelled.id],
    }).id,
    predecessor_pending: ledger.addTask(triage, {
      requestId,
      work: "요청자에게 회신",
      assignee: minsu,
      dependsOn: [pending.id],
    }).id,
    waiting: ledger.addTask(triage, {
      requestId,
      work: "변경 대상 확인",
      assignee: minsu,
      status: "waiting",
      waitingFor: { party: csTeam },
    }).id,
    actionable: ledger.addTask(triage, { requestId, work: "보상안 검토" }).id,
  };

  for (const [display, taskId] of Object.entries(rows)) {
    ledger.setTurn(user, { taskId, turn: jiwon });
    const task = taskOf(ledger, requestId, taskId);
    assert.deepEqual([task.display, task.turn], [display, jiwon], display);
  }
  // 계산한 차례가 없는 줄에서도 사용자가 정한 차례가 요청의 차례에 든다.
  assert.deepEqual(ledger.getRequest(requestId).turn, [minsu, jiwon]);
});

test("S3: 비서는 차례와 처리 순서를 쓸 수 없다", (t) => {
  const { ledger, requestId, taskId } = setup(t);
  ledger.setTurn(user, { taskId, turn: me });
  ledger.setOrder(user, { requestId, order: 1 });
  const before = ledger.changesSince(0).length;

  for (const assistant of [triage, verifier]) {
    assert.throws(
      () => ledger.setTurn(assistant, { taskId, turn: minsu }),
      rejectsWith("requires_user"),
    );
    assert.throws(() => ledger.clearTurn(assistant, { taskId }), rejectsWith("requires_user"));
    assert.throws(
      () => ledger.setOrder(assistant, { requestId, order: 2 }),
      rejectsWith("requires_user"),
    );
    assert.throws(
      () => ledger.setOrder(assistant, { requestId, order: null }),
      rejectsWith("requires_user"),
    );
  }

  assert.deepEqual(turns(ledger, requestId, taskId), [me, me]);
  assert.equal(ledger.getRequest(requestId).order, 1);
  assert.equal(ledger.changesSince(0).length, before);
});

test("S27: 사용자가 같은 차례를 다시 정하면 변경 이력이 한 건 남고, 정한 시각이 그때로 바뀌어 그 사이의 판본으로는 풀리지 않는다", (t) => {
  const { ledger, clock, requestId, taskId, revisionAt } = setup(t);
  clock.set("12:00");
  ledger.setTurn(user, { taskId, turn: me });
  clock.set("14:00");
  ledger.setTurn(user, { taskId, turn: me });

  assert.deepEqual(taskOf(ledger, requestId, taskId).userTurn, {
    party: me,
    setAt: stored("14:00"),
  });
  assert.deepEqual(
    ledger
      .getRequest(requestId)
      .changes.slice(-2)
      .map((change) => change.action),
    ["setTurn", "setTurn"],
  );

  ledger.updateTask(verifier, { taskId, status: "in_progress", evidence: [revisionAt("13:00")] });
  assert.deepEqual(turns(ledger, requestId, taskId), [me, me]);
  ledger.updateTask(verifier, { taskId, status: "todo", evidence: [revisionAt("14:30")] });
  assert.deepEqual(turns(ledger, requestId, taskId), [minsu, null]);
});

test("차례와 처리 순서를 쓰면서 단 근거는 변경 이력에 남고, 직접 맡긴 말은 근거로 달 수 없다", (t) => {
  const { ledger, clock, requestId, taskId, revisionAt } = setup(t);
  const thread = revisionAt("11:00");
  const spoken = ledger.addRevision(userViaSkill, {
    source: "conversation",
    sourceId: "skill-session-13/turn-2",
    originalAt: at("11:30"),
    body: "이 일은 CS팀 차례야. 그리고 제일 먼저 봐 줘",
  });
  const said = { kind: "revision", revisionId: spoken.revisionId } as const;
  clock.set("12:00");

  ledger.setTurn(user, { taskId, turn: csTeam, evidence: [thread] });
  ledger.setOrder(user, { requestId, order: 1, evidence: [thread] });
  ledger.clearTurn(user, { taskId, evidence: [thread] });

  assert.deepEqual(
    ledger
      .getRequest(requestId)
      .changes.slice(-3)
      .map((change) => [change.action, change.evidence]),
    [
      ["setTurn", [thread]],
      ["setOrder", [thread]],
      ["clearTurn", [thread]],
    ],
  );
  // 차례를 정한 시각은 근거의 원본 시각이 아니라 쓴 시각이다.
  ledger.setTurn(user, { taskId, turn: csTeam, evidence: [thread] });
  assert.deepEqual(taskOf(ledger, requestId, taskId).userTurn, {
    party: csTeam,
    setAt: stored("12:00"),
  });

  const before = ledger.changesSince(0).length;
  assert.throws(
    () => ledger.setTurn(userViaSkill, { taskId, turn: me, evidence: [said] }),
    rejectsWith("evidence_not_allowed"),
  );
  assert.throws(
    () => ledger.clearTurn(userViaSkill, { taskId, evidence: [said] }),
    rejectsWith("evidence_not_allowed"),
  );
  assert.throws(
    () => ledger.setOrder(userViaSkill, { requestId, order: 2, evidence: [said] }),
    rejectsWith("evidence_not_allowed"),
  );
  assert.equal(ledger.changesSince(0).length, before);
});

test("S11: 완료한 작업과 취소한 작업에는 차례를 정할 수 없고, 되돌린 뒤에도 차례가 살아나지 않는다", (t) => {
  type Finish = (ledger: Ledger, taskId: string) => void;
  const finishes: Record<string, Finish> = {
    "사용자가 완료한 작업": (ledger, taskId) => ledger.completeTask(user, { taskId }),
    "사용자가 취소한 작업": (ledger, taskId) => ledger.cancelTask(user, { taskId }),
    "비서가 취소한 작업": (ledger, taskId) =>
      ledger.cancelTask(triage, { taskId, reason: "요청자가 필요 없다고 했다" }),
  };

  for (const [name, finish] of Object.entries(finishes)) {
    const { ledger, requestId, taskId } = setup(t);
    finish(ledger, taskId);
    const before = ledger.getRequest(requestId);

    assert.throws(
      () => ledger.setTurn(user, { taskId, turn: me }),
      rejectsWith("task_already_finished"),
      name,
    );
    assert.throws(
      () => ledger.setTurn(userViaSkill, { taskId, turn: csTeam, reason: "끝났지만 정해 둔다" }),
      rejectsWith("task_already_finished"),
      name,
    );

    // 거부된 쓰기는 차례도 변경 이력도 남기지 않는다.
    assert.deepEqual(ledger.getRequest(requestId), before, name);
    assert.equal(taskOf(ledger, requestId, taskId).userTurn, null, name);
    // 되돌린 작업에는 계산한 차례가 나온다.
    ledger.updateTask(user, { taskId, status: "todo" });
    assert.deepEqual(turns(ledger, requestId, taskId), [minsu, null], name);
  }
});

test("없는 작업과 틀린 인자로는 차례를 쓸 수 없다", (t) => {
  const { ledger, requestId, taskId } = setup(t);
  const done = ledger.addTask(triage, { requestId, work: "끝난 조사" });
  ledger.completeTask(user, { taskId: done.id });
  const before = ledger.changesSince(0).length;

  assert.throws(
    () => ledger.setTurn(user, { taskId: "task-none", turn: me }),
    rejectsWith("task_not_found"),
  );
  assert.throws(
    () => ledger.clearTurn(user, { taskId: "task-none" }),
    rejectsWith("task_not_found"),
  );
  assert.throws(
    () => ledger.setTurn(user, { taskId, turn: { kind: "person" } as never }),
    rejectsWith("invalid_party"),
  );
  // 차례를 지우는 쓰기는 따로 있다.
  assert.throws(
    () => ledger.setTurn(user, { taskId, turn: null as never }),
    rejectsWith("invalid_party"),
  );
  assert.throws(
    () => ledger.setTurn(user, { taskId, turn: me, status: "waiting" } as never),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.clearTurn(user, { taskId, turn: me } as never),
    rejectsWith("invalid_argument"),
  );
  // 끝난 작업의 차례를 지우는 쓰기는 지울 것이 없어 아무것도 바꾸지 않는다.
  ledger.clearTurn(user, { taskId: done.id });

  assert.equal(ledger.changesSince(0).length, before);
  assert.deepEqual(turns(ledger, requestId, taskId), [minsu, null]);
});

test("사용자가 정한 차례는 작업의 turn과 turn_set_at에 저장되고, 풀리면 둘 다 비워진다", (t) => {
  const { ledger, clock, row } = openFileLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "원인 조사" });
  const saved = () =>
    row("SELECT turn, turn_set_at, status, assignee FROM tasks WHERE id = ?", taskId);

  clock.set("12:00");
  ledger.setTurn(user, { taskId, turn: jiwon });
  assert.deepEqual(saved(), {
    turn: JSON.stringify(jiwon),
    turn_set_at: stored("12:00"),
    status: "todo",
    assignee: null,
  });

  ledger.completeTask(user, { taskId });
  assert.deepEqual(saved(), { turn: null, turn_set_at: null, status: "done", assignee: null });
});

test("S3, S16, S27: 처리 순서는 사용자가 정하고 지우며, 같은 순서를 다시 쓰면 변경 이력이 남지 않는다", (t) => {
  const { ledger, clock, requestId } = setup(t);
  assert.equal(ledger.getRequest(requestId).order, null);

  clock.set("10:00");
  ledger.setOrder(user, { requestId, order: 3 });
  assert.equal(ledger.getRequest(requestId).order, 3);
  ledger.setOrder(userViaSkill, { requestId, order: 1, reason: "이번 주에 먼저 본다" });
  assert.equal(ledger.getRequest(requestId).order, 1);
  // 같은 순서를 다시 쓰면 바뀌는 것이 없어 변경 이력을 남기지 않는다.
  ledger.setOrder(user, { requestId, order: 1 });
  ledger.setOrder(user, { requestId, order: null, appliesTo: "similar_future" });
  assert.equal(ledger.getRequest(requestId).order, null);
  ledger.setOrder(user, { requestId, order: null });

  assert.deepEqual(
    ledger
      .getRequest(requestId)
      .changes.filter((change) => change.action === "setOrder")
      .map((change) => [
        change.target,
        change.before,
        change.after,
        change.reason,
        change.appliesTo,
      ]),
    [
      [
        { kind: "request", id: requestId },
        { order: null },
        { order: 3 },
        null,
        // 처리 순서는 그 요청에 준 지시여서, 밝히지 않으면 이 요청에만 해당한다.
        { scope: "this_request", stated: false },
      ],
      [
        { kind: "request", id: requestId },
        { order: 3 },
        { order: 1 },
        "이번 주에 먼저 본다",
        { scope: "this_request", stated: false },
      ],
      [
        { kind: "request", id: requestId },
        { order: 1 },
        { order: null },
        null,
        { scope: "similar_future", stated: true },
      ],
    ],
  );
});

test("처리 순서는 정수이거나 null이어야 하고, 없는 요청은 거부된다", (t) => {
  const { ledger, requestId } = setup(t);
  const before = ledger.changesSince(0).length;

  for (const order of [1.5, "1", Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, undefined]) {
    assert.throws(
      () => ledger.setOrder(user, { requestId, order: order as never }),
      rejectsWith("invalid_argument"),
      String(order),
    );
  }
  assert.throws(
    () => ledger.setOrder(user, { requestId: "request-none", order: 1 }),
    rejectsWith("request_not_found"),
  );
  assert.throws(
    () => ledger.setOrder(user, { requestId, order: 1, urgency: "high" } as never),
    rejectsWith("invalid_argument"),
  );

  assert.equal(ledger.getRequest(requestId).order, null);
  assert.equal(ledger.changesSince(0).length, before);
  // 0과 음수도 정수다. 작은 값이 앞이다.
  ledger.setOrder(user, { requestId, order: -1 });
  assert.equal(ledger.getRequest(requestId).order, -1);
});
