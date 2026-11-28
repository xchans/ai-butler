// 작업 7(작업, 선후 관계, 완료 표시)의 완료 조건을 확인한다. S5, S10, S12와 S13의 쓰기 부분.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { type Ledger, openLedger } from "./index.ts";
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
  verifier,
} from "./test-support.ts";

const connector = { kind: "assistant", module: "channel-connectors" } as const;

/** 요청 하나와, Jira 기록의 판본을 원본 시각만 바꿔 더하는 도우미를 준비한다. */
function setup(t: TestContext): {
  ledger: Ledger;
  clock: TestClock;
  requestId: string;
  /** 그 원본 시각의 판본을 더하고 근거로 달 수 있는 참조를 돌려준다. */
  revisionAt(hhmm: string, body?: string): { kind: "revision"; revisionId: string };
} {
  const { ledger, clock } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  return {
    ledger,
    clock,
    requestId,
    revisionAt(hhmm, body = `${hhmm}의 티켓 내용`) {
      const { revisionId } = ledger.addRevision(connector, {
        source: "jira",
        sourceId: "VOC-101",
        originalAt: at(hhmm),
        body,
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

test("작업을 더하면 할 일, 담당, 상태, 대기 대상, 선후 관계가 요청 조회에 더한 순서대로 나온다", (t) => {
  const { ledger, clock, requestId } = setup(t);
  clock.set("09:10");
  const investigate = ledger.addTask(triage, { requestId, work: "원인 조사", assignee: minsu });
  const change = ledger.addTask(triage, {
    requestId,
    work: "데이터 변경",
    status: "waiting",
    waitingFor: { party: csTeam, what: "변경 대상 목록" },
    dependsOn: [investigate.id],
  });
  const reply = ledger.addTask(triage, {
    requestId,
    work: "요청자에게 회신",
    assignee: me,
    dependsOn: [investigate.id, change.id],
  });

  assert.deepEqual(ledger.getRequest(requestId).tasks, [
    {
      id: investigate.id,
      createdAt: stored("09:10"),
      work: "원인 조사",
      status: "todo",
      assignee: minsu,
      waitingFor: null,
      dependsOn: [],
      completion: null,
      cancellation: null,
      onHold: false,
      display: "actionable",
      turn: minsu,
      userTurn: null,
    },
    {
      id: change.id,
      createdAt: stored("09:10"),
      work: "데이터 변경",
      status: "waiting",
      assignee: null,
      waitingFor: { party: csTeam, what: "변경 대상 목록" },
      dependsOn: [investigate.id],
      completion: null,
      cancellation: null,
      // 선행 작업이 끝나지 않아 대기보다 위의 줄로 표시된다.
      onHold: false,
      display: "predecessor_pending",
      turn: null,
      userTurn: null,
    },
    {
      id: reply.id,
      createdAt: stored("09:10"),
      work: "요청자에게 회신",
      status: "todo",
      assignee: me,
      waitingFor: null,
      dependsOn: [investigate.id, change.id],
      completion: null,
      cancellation: null,
      onHold: false,
      display: "predecessor_pending",
      turn: null,
      userTurn: null,
    },
  ]);
  // 작업을 더한 것이 요청의 변경 이력에 작업을 대상으로 남는다.
  const added = ledger.getRequest(requestId).changes.at(-1);
  assert.deepEqual(
    [added?.action, added?.target, added?.requestId, added?.before],
    ["addTask", { kind: "task", id: reply.id }, requestId, null],
  );
  assert.deepEqual(added?.after, {
    requestId,
    work: "요청자에게 회신",
    status: { value: "todo", correctedAt: null, evidenceAt: null },
    assignee: { value: me, correctedAt: null, evidenceAt: null },
    waitingFor: { value: null, correctedAt: null, evidenceAt: null },
    dependsOn: [investigate.id, change.id],
  });
});

test("S5: 비서는 근거 없이 작업을 완료로 쓸 수 없다", (t) => {
  const { ledger, requestId } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "원인 조사" });
  const count = ledger.changesSince(0).length;

  assert.throws(() => ledger.completeTask(verifier, { taskId }), rejectsWith("evidence_required"));
  assert.throws(
    () => ledger.completeTask(verifier, { taskId, evidence: [] }),
    rejectsWith("evidence_required"),
  );
  // 사유를 적어도 근거가 되지 않는다.
  assert.throws(
    () => ledger.completeTask(verifier, { taskId, reason: "끝난 것 같다" }),
    rejectsWith("evidence_required"),
  );

  assert.equal(taskOf(ledger, requestId, taskId).status, "todo");
  assert.equal(ledger.changesSince(0).length, count);
});

test("S5: 사용자는 근거 없이 완료로 표시할 수 있고, 조회 결과에서 두 완료가 구분된다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const byUser = ledger.addTask(triage, { requestId, work: "요청자에게 회신" });
  const byAssistant = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  const done = revisionAt("10:00", "데이터 변경 완료");

  clock.set("11:00");
  ledger.completeTask(user, { taskId: byUser.id });
  clock.set("11:30");
  ledger.completeTask(verifier, { taskId: byAssistant.id, evidence: [done] });

  // 사용자가 표시한 완료와 기록에서 확인한 완료가 구분된다.
  const marked = taskOf(ledger, requestId, byUser.id);
  assert.equal(marked.status, "done");
  assert.deepEqual(marked.completion, {
    by: "user",
    at: stored("11:00"),
    evidence: [],
    confirmed: "user_marked",
  });
  const confirmed = taskOf(ledger, requestId, byAssistant.id);
  assert.equal(confirmed.status, "done");
  assert.equal(confirmed.completion?.confirmed, "from_record");
  assert.equal(confirmed.completion?.by, "assistant");
  assert.equal(confirmed.completion?.at, stored("11:30"));
  // 완료 표시는 일어난 일을 사용자가 알린 것이므로, 밝히지 않으면 이 요청에만 해당한다.
  const changes = ledger.getRequest(requestId).changes;
  assert.deepEqual(
    changes.slice(-2).map((change) => [change.action, change.target.id, change.appliesTo]),
    [
      ["completeTask", byUser.id, { scope: "this_request", stated: false }],
      ["completeTask", byAssistant.id, null],
    ],
  );
  assert.deepEqual(changes.at(-1)?.evidence, [done]);
});

test("S5: 사용자가 표시한 완료는 비서가 되돌리거나 다시 시작할 수 없다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "요청자에게 회신" });
  clock.set("10:00");
  ledger.completeTask(user, { taskId });
  const later = revisionAt("12:00", "아직 회신이 없다는 댓글");
  const before = taskOf(ledger, requestId, taskId);

  for (const status of ["todo", "in_progress"] as const) {
    assert.throws(
      () => ledger.updateTask(verifier, { taskId, status, evidence: [later] }),
      rejectsWith("user_finished_protected"),
    );
  }
  assert.throws(
    () =>
      ledger.updateTask(verifier, {
        taskId,
        status: "waiting",
        waitingFor: { party: jiwon },
        evidence: [later],
      }),
    rejectsWith("user_finished_protected"),
  );
  // 이미 끝난 작업을 다시 완료나 취소로 쓸 수도 없다.
  assert.throws(
    () => ledger.completeTask(verifier, { taskId, evidence: [later] }),
    rejectsWith("task_already_finished"),
  );
  assert.throws(
    () => ledger.cancelTask(verifier, { taskId, reason: "필요 없어졌다", evidence: [later] }),
    rejectsWith("task_already_finished"),
  );

  assert.deepEqual(taskOf(ledger, requestId, taskId), before);
});

test("S5: 사용자는 완료나 취소인 작업을 할 일, 진행 중, 대기로 되돌릴 수 있다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const add = (work: string) => ledger.addTask(triage, { requestId, work }).id;
  const [doneByUser, doneByAssistant, cancelled] = [add("회신"), add("조사"), add("변경")] as [
    string,
    string,
    string,
  ];
  ledger.completeTask(user, { taskId: doneByUser });
  ledger.completeTask(verifier, { taskId: doneByAssistant, evidence: [revisionAt("09:30")] });
  ledger.cancelTask(user, { taskId: cancelled, reason: "하지 않기로 했다" });

  clock.set("12:00");
  ledger.updateTask(user, { taskId: doneByUser, status: "todo" });
  ledger.updateTask(user, { taskId: doneByAssistant, status: "in_progress" });
  ledger.updateTask(user, {
    taskId: cancelled,
    status: "waiting",
    waitingFor: { party: jiwon, what: "변경해도 되는지 확인" },
  });

  const tasks = ledger.getRequest(requestId).tasks;
  assert.deepEqual(
    tasks.map((task) => [task.status, task.completion, task.cancellation]),
    [
      ["todo", null, null],
      ["in_progress", null, null],
      ["waiting", null, null],
    ],
  );
  assert.deepEqual(tasks[2]?.waitingFor, { party: jiwon, what: "변경해도 되는지 확인" });
  // 되돌린 내역과 그때 지운 완료 표시가 변경 이력에 남는다.
  const reverted = ledger
    .getRequest(requestId)
    .changes.find((change) => change.action === "updateTask" && change.target.id === doneByUser);
  assert.deepEqual(reverted?.before, {
    status: { value: "done", correctedAt: stored("09:00"), evidenceAt: null },
    finished: { by: "user", at: stored("09:00"), evidenceAt: null, reason: null },
  });
  assert.deepEqual(reverted?.after, {
    status: { value: "todo", correctedAt: stored("12:00"), evidenceAt: null },
    finished: null,
  });
});

test("S5: 완료나 취소는 updateTask로 쓸 수 없고, 이미 끝난 작업에 다시 쓸 수도 없다", (t) => {
  const { ledger, requestId, revisionAt } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "원인 조사" });
  const evidence = [revisionAt("09:30")];

  for (const actor of [user, verifier]) {
    for (const status of ["done", "cancelled"] as const) {
      assert.throws(
        () => ledger.updateTask(actor, { taskId, status: status as never, evidence }),
        rejectsWith("finish_with_dedicated_write"),
      );
    }
  }
  assert.throws(
    () =>
      ledger.addTask(triage, { requestId, work: "끝난 채로 더하는 작업", status: "done" as never }),
    rejectsWith("finish_with_dedicated_write"),
  );
  assert.equal(taskOf(ledger, requestId, taskId).status, "todo");

  ledger.cancelTask(user, { taskId });
  // 사용자도 취소한 작업을 바로 완료로 바꾸지 않는다. 되돌린 뒤에 다시 쓴다.
  for (const actor of [user, verifier]) {
    assert.throws(
      () => ledger.completeTask(actor, { taskId, evidence }),
      rejectsWith("task_already_finished"),
    );
    assert.throws(
      () => ledger.cancelTask(actor, { taskId, reason: "다시 취소" }),
      rejectsWith("task_already_finished"),
    );
  }
  ledger.updateTask(user, { taskId, status: "todo" });
  ledger.completeTask(user, { taskId });
  assert.equal(taskOf(ledger, requestId, taskId).completion?.confirmed, "user_marked");
});

test("S5: 사용자가 취소한 작업은 비서가 되돌릴 수 없다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  clock.set("10:00");
  ledger.cancelTask(user, { taskId, reason: "요청자가 필요 없다고 했다" });
  const later = revisionAt("12:00", "다시 필요하다는 댓글");

  assert.throws(
    () => ledger.updateTask(verifier, { taskId, status: "todo", evidence: [later] }),
    rejectsWith("user_finished_protected"),
  );

  const task = taskOf(ledger, requestId, taskId);
  assert.equal(task.status, "cancelled");
  assert.deepEqual(task.cancellation, {
    by: "user",
    at: stored("10:00"),
    evidence: [],
    reason: "요청자가 필요 없다고 했다",
  });
});

test("S5: 비서는 자기가 쓴 완료를 그 완료에 달았던 판본보다 뒤의 판본으로만 되돌린다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  const earlier = revisionAt("09:30", "변경 시작");
  const done = revisionAt("10:00", "변경 완료");
  clock.set("10:30");
  ledger.completeTask(verifier, { taskId, evidence: [earlier, done] });

  clock.set("13:00");
  // 근거 없이는 되돌릴 수 없다.
  assert.throws(
    () => ledger.updateTask(verifier, { taskId, status: "in_progress" }),
    rejectsWith("evidence_required"),
  );
  // 완료에 달았던 판본과 원본 시각이 같은 판본으로는 되돌릴 수 없다. 앞선 판본도 같다.
  assert.throws(
    () => ledger.updateTask(verifier, { taskId, status: "in_progress", evidence: [done] }),
    rejectsWith("evidence_too_early"),
  );
  assert.throws(
    () => ledger.updateTask(verifier, { taskId, status: "in_progress", evidence: [earlier] }),
    rejectsWith("evidence_too_early"),
  );
  assert.equal(taskOf(ledger, requestId, taskId).status, "done");

  // 그보다 뒤의 판본으로는 되돌릴 수 있다.
  const reopened = revisionAt("10:01", "변경이 일부 빠졌다는 댓글");
  ledger.updateTask(verifier, { taskId, status: "in_progress", evidence: [reopened] });
  const task = taskOf(ledger, requestId, taskId);
  assert.deepEqual([task.status, task.completion], ["in_progress", null]);
});

test("S5: 비서가 근거 없이 쓴 취소는 취소한 시각보다 뒤의 판본으로 되돌릴 수 있다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  const beforeCancel = revisionAt("09:30");
  clock.set("10:00");
  ledger.cancelTask(triage, { taskId, reason: "조사 결과 변경할 것이 없다" });
  assert.deepEqual(taskOf(ledger, requestId, taskId).cancellation, {
    by: "assistant",
    at: stored("10:00"),
    evidence: [],
    reason: "조사 결과 변경할 것이 없다",
  });

  clock.set("12:00");
  assert.throws(
    () => ledger.updateTask(triage, { taskId, status: "todo", evidence: [beforeCancel] }),
    rejectsWith("evidence_too_early"),
  );
  // 취소한 시각과 같은 시각의 판본도 뒤가 아니다.
  assert.throws(
    () => ledger.updateTask(triage, { taskId, status: "todo", evidence: [revisionAt("10:00")] }),
    rejectsWith("evidence_too_early"),
  );
  ledger.updateTask(triage, { taskId, status: "todo", evidence: [revisionAt("11:00")] });

  const task = taskOf(ledger, requestId, taskId);
  assert.deepEqual([task.status, task.cancellation], ["todo", null]);
});

test("S5: 비서가 근거를 달아 쓴 취소는 그 근거보다 뒤의 판본으로 되돌린다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  clock.set("10:00");
  const withdrawn = revisionAt("11:00", "변경하지 않기로 했다는 댓글");
  ledger.cancelTask(triage, { taskId, reason: "하지 않기로 했다", evidence: [withdrawn] });

  // 취소한 시각(10시)보다는 뒤지만 달았던 근거(11시)보다 앞선 판본이다.
  assert.throws(
    () => ledger.updateTask(triage, { taskId, status: "todo", evidence: [revisionAt("10:30")] }),
    rejectsWith("evidence_too_early"),
  );
  ledger.updateTask(triage, { taskId, status: "todo", evidence: [revisionAt("11:30")] });
  assert.equal(taskOf(ledger, requestId, taskId).status, "todo");
});

test("비서가 작업을 취소할 때는 사유를 꼭 적고, 사용자의 취소는 사유가 없어도 받는다", (t) => {
  const { ledger, requestId } = setup(t);
  const byAssistant = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  const byUser = ledger.addTask(triage, { requestId, work: "회신" });
  const byUserBlank = ledger.addTask(triage, { requestId, work: "공유" });

  // 공백뿐인 사유는 없는 것으로 본다.
  for (const reason of [undefined, null, "", "   "]) {
    assert.throws(
      () =>
        ledger.cancelTask(triage, {
          taskId: byAssistant.id,
          ...(reason === undefined ? {} : { reason }),
        }),
      rejectsWith("reason_required"),
    );
  }
  assert.equal(taskOf(ledger, requestId, byAssistant.id).status, "todo");

  ledger.cancelTask(triage, { taskId: byAssistant.id, reason: "요청 범위에서 빠졌다" });
  ledger.cancelTask(user, { taskId: byUser.id });
  ledger.cancelTask(user, { taskId: byUserBlank.id, reason: "  " });

  assert.deepEqual(
    ledger
      .getRequest(requestId)
      .tasks.map((task) => [task.status, task.cancellation?.by, task.cancellation?.reason]),
    [
      ["cancelled", "assistant", "요청 범위에서 빠졌다"],
      ["cancelled", "user", null],
      ["cancelled", "user", null],
    ],
  );
  // 사유는 변경 이력에도 남는다.
  assert.deepEqual(
    ledger
      .getRequest(requestId)
      .changes.filter((change) => change.action === "cancelTask")
      .map((change) => [change.reason, change.appliesTo?.scope ?? null]),
    [
      ["요청 범위에서 빠졌다", null],
      [null, "this_request"],
      [null, "this_request"],
    ],
  );
});

test("S10: 완료 근거로 단 판본은 원본의 새 판본이 들어와도 바뀌지 않고, 판단할 때 본 내용으로 나온다", (t) => {
  const { ledger, clock, requestId } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  const ticket = (hhmm: string, body: string) =>
    ledger.addRevision(connector, {
      source: "jira",
      sourceId: "VOC-101",
      originalAt: at(hhmm),
      body,
      url: "https://jira.example.test/browse/VOC-101",
      author: minsu,
    });
  const seen = ticket("10:00", "상태: 완료. 환불 12건 재처리함");
  ledger.linkRecord(triage, {
    recordId: seen.recordId,
    requestId,
    taskId,
    role: "completion_evidence",
  });
  clock.set("10:30");
  ledger.completeTask(verifier, {
    taskId,
    evidence: [{ kind: "revision", revisionId: seen.revisionId }],
  });

  // 완료한 뒤에 원본이 바뀌어 새 판본이 들어온다.
  clock.set("15:00");
  const changed = ticket("14:00", "상태: 다시 열림. 2건 누락");

  const request = ledger.getRequest(requestId);
  const task = request.tasks[0];
  assert.deepEqual(task?.completion, {
    by: "assistant",
    at: stored("10:30"),
    confirmed: "from_record",
    evidence: [
      {
        kind: "revision",
        revision: {
          id: seen.revisionId,
          recordId: seen.recordId,
          originalAt: stored("10:00"),
          body: "상태: 완료. 환불 12건 재처리함",
          url: "https://jira.example.test/browse/VOC-101",
          author: minsu,
          fetchedAt: stored("09:00"),
        },
      },
    ],
  });
  // 연결된 기록에는 두 판본이 모두 나온다. 근거는 기록이 아니라 판본을 가리킨다.
  assert.deepEqual(
    request.records[0]?.revisions.map((revision) => revision.id),
    [seen.revisionId, changed.revisionId],
  );
  assert.deepEqual(request.links, [
    {
      id: request.links[0]?.id,
      recordId: seen.recordId,
      taskId,
      role: "completion_evidence",
      userSet: false,
    },
  ]);
});

test("S12: 대기 대상 없이 상태를 대기로 쓰면 거부된다", (t) => {
  const { ledger, requestId } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  const count = ledger.changesSince(0).length;

  for (const actor of [user, triage]) {
    assert.throws(
      () => ledger.updateTask(actor, { taskId, status: "waiting" }),
      rejectsWith("waiting_target_mismatch"),
    );
    assert.throws(
      () => ledger.updateTask(actor, { taskId, status: "waiting", waitingFor: null }),
      rejectsWith("waiting_target_mismatch"),
    );
    assert.throws(
      () => ledger.addTask(actor, { requestId, work: "대기 대상이 없는 대기", status: "waiting" }),
      rejectsWith("waiting_target_mismatch"),
    );
  }
  assert.equal(ledger.changesSince(0).length, count);

  ledger.updateTask(triage, { taskId, status: "waiting", waitingFor: { party: me } });
  assert.deepEqual(taskOf(ledger, requestId, taskId).waitingFor, { party: me, what: null });
  // 대기 중인 작업의 대기 대상을 비울 수 없다.
  assert.throws(
    () => ledger.updateTask(triage, { taskId, waitingFor: null }),
    rejectsWith("waiting_target_mismatch"),
  );
});

test("대기 대상은 상태가 대기일 때만 있다. 대기에서 벗어나면 함께 비워진다", (t) => {
  const { ledger, requestId, revisionAt } = setup(t);
  const add = () =>
    ledger.addTask(triage, {
      requestId,
      work: "데이터 변경",
      status: "waiting",
      waitingFor: { party: csTeam, what: "변경 대상 목록" },
    }).id;
  const [moved, completed, cancelled] = [add(), add(), add()] as [string, string, string];

  // 대기가 아닌 작업에 대기 대상을 적으려 하면 거부된다.
  assert.throws(
    () =>
      ledger.updateTask(triage, {
        taskId: moved,
        status: "in_progress",
        waitingFor: { party: jiwon },
      }),
    rejectsWith("waiting_target_mismatch"),
  );
  assert.throws(
    () =>
      ledger.addTask(triage, {
        requestId,
        work: "할 일인데 대기 대상",
        waitingFor: { party: jiwon },
      }),
    rejectsWith("waiting_target_mismatch"),
  );

  ledger.updateTask(triage, { taskId: moved, status: "in_progress" });
  ledger.completeTask(verifier, { taskId: completed, evidence: [revisionAt("09:30")] });
  ledger.cancelTask(user, { taskId: cancelled });

  assert.deepEqual(
    ledger.getRequest(requestId).tasks.map((task) => [task.status, task.waitingFor]),
    [
      ["in_progress", null],
      ["done", null],
      ["cancelled", null],
    ],
  );
  // 함께 비워진 대기 대상도 같은 변경 이력 한 건에 남는다.
  const change = ledger
    .getRequest(requestId)
    .changes.find((candidate) => candidate.action === "updateTask");
  assert.deepEqual(Object.keys(change?.after as object).sort(), ["status", "waitingFor"]);
});

test("S13: 작업이 자기 자신을 기다리거나 선후 관계를 따라가면 자기에게 돌아오게 되는 쓰기는 거부된다", (t) => {
  const { ledger, requestId } = setup(t);
  const c = ledger.addTask(triage, { requestId, work: "C" });
  const b = ledger.addTask(triage, { requestId, work: "B", dependsOn: [c.id] });
  const a = ledger.addTask(triage, { requestId, work: "A", dependsOn: [b.id] });
  const count = ledger.changesSince(0).length;

  // A가 B를, B가 C를 기다릴 때 C가 A를 기다리게 할 수 없다.
  assert.throws(
    () => ledger.updateTask(triage, { taskId: c.id, dependsOn: [a.id] }),
    rejectsWith("invalid_dependency"),
  );
  assert.throws(
    () => ledger.updateTask(user, { taskId: c.id, dependsOn: [b.id] }),
    rejectsWith("invalid_dependency"),
  );
  // 작업이 자기 자신을 기다릴 수 없다.
  assert.throws(
    () => ledger.updateTask(triage, { taskId: a.id, dependsOn: [a.id] }),
    rejectsWith("invalid_dependency"),
  );
  assert.equal(ledger.changesSince(0).length, count);
  assert.deepEqual(
    ledger.getRequest(requestId).tasks.map((task) => task.dependsOn),
    [[], [c.id], [b.id]],
  );

  // 돌아오지 않는 선후 관계는 바꿀 수 있고, 지울 수도 있다.
  ledger.updateTask(triage, { taskId: a.id, dependsOn: [b.id, c.id] });
  ledger.updateTask(triage, { taskId: b.id, dependsOn: [] });
  assert.deepEqual(
    ledger.getRequest(requestId).tasks.map((task) => task.dependsOn),
    [[], [], [b.id, c.id]],
  );
  // 같은 목록으로 다시 쓰면 아무것도 바뀌지 않는다.
  const after = ledger.changesSince(0).length;
  ledger.updateTask(triage, { taskId: a.id, dependsOn: [c.id, b.id] });
  assert.equal(ledger.changesSince(0).length, after);
  // 지운 뒤에는 반대 방향으로 정할 수 있다.
  ledger.updateTask(triage, { taskId: c.id, dependsOn: [b.id] });
  assert.deepEqual(taskOf(ledger, requestId, c.id).dependsOn, [b.id]);
});

test("S13: 먼저 끝나야 하는 작업은 같은 요청 안에서만 정한다", (t) => {
  const { ledger, requestId } = setup(t);
  const other = ledger.createRequest(triage, { decided: { title: "다른 요청" } });
  const elsewhere = ledger.addTask(triage, { requestId: other.id, work: "다른 요청의 작업" });
  const here = ledger.addTask(triage, { requestId, work: "이 요청의 작업" });

  assert.throws(
    () => ledger.addTask(triage, { requestId, work: "새 작업", dependsOn: [elsewhere.id] }),
    rejectsWith("invalid_dependency"),
  );
  assert.throws(
    () => ledger.updateTask(triage, { taskId: here.id, dependsOn: [elsewhere.id] }),
    rejectsWith("invalid_dependency"),
  );
  assert.throws(
    () => ledger.updateTask(triage, { taskId: here.id, dependsOn: ["task-none"] }),
    rejectsWith("task_not_found"),
  );
  assert.throws(
    () => ledger.updateTask(triage, { taskId: here.id, dependsOn: [here.id, here.id] }),
    rejectsWith("invalid_argument"),
  );
  assert.equal(ledger.getRequest(requestId).tasks.length, 1);
});

test("연결과 작업은 같은 요청에 속해야 하고, 없는 작업과 틀린 인자는 거부된다", (t) => {
  const { ledger, requestId, revisionAt } = setup(t);
  const other = ledger.createRequest(triage, { decided: { title: "다른 요청" } });
  const elsewhere = ledger.addTask(triage, { requestId: other.id, work: "다른 요청의 작업" });
  revisionAt("09:30");
  const recordId = ledger.addRevision(connector, {
    source: "jira",
    sourceId: "VOC-101",
    originalAt: at("09:30"),
    body: "09:30의 티켓 내용",
  }).recordId;

  assert.throws(
    () =>
      ledger.linkRecord(triage, { recordId, requestId, taskId: elsewhere.id, role: "progress" }),
    rejectsWith("task_not_in_request"),
  );
  assert.throws(
    () => ledger.updateTask(triage, { taskId: "task-none", work: "없는 작업" }),
    rejectsWith("task_not_found"),
  );
  assert.throws(
    () => ledger.completeTask(user, { taskId: "task-none" }),
    rejectsWith("task_not_found"),
  );
  assert.throws(
    () => ledger.addTask(triage, { requestId: "request-none", work: "없는 요청의 작업" }),
    rejectsWith("request_not_found"),
  );
  assert.throws(
    () => ledger.addTask(triage, { requestId, work: "  " }),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.addTask(triage, { requestId, work: "작업", assignee: { kind: "robot" } as never }),
    rejectsWith("invalid_party"),
  );
  assert.throws(
    () => ledger.addTask(triage, { requestId, work: "작업", owner: minsu } as never),
    rejectsWith("invalid_argument"),
  );
  assert.equal(ledger.getRequest(requestId).tasks.length, 0);
});

test("할 일과 담당을 바꾸면 바뀐 항목만 변경 이력에 남고, 그대로인 쓰기는 남지 않는다", (t) => {
  const { ledger, requestId } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "원인 조사", assignee: minsu });
  const count = ledger.changesSince(0).length;

  ledger.updateTask(triage, { taskId, work: "원인 조사", assignee: minsu, status: "todo" });
  ledger.updateTask(triage, { taskId });
  assert.equal(ledger.changesSince(0).length, count);

  ledger.updateTask(triage, { taskId, work: "환불 지연 원인 조사", assignee: null });
  const task = taskOf(ledger, requestId, taskId);
  assert.deepEqual([task.work, task.assignee], ["환불 지연 원인 조사", null]);
  const last = ledger.changesSince(0).at(-1);
  assert.deepEqual(
    [last?.before, last?.after],
    [
      {
        assignee: { value: minsu, correctedAt: null, evidenceAt: null },
        work: "원인 조사",
      },
      {
        assignee: { value: null, correctedAt: null, evidenceAt: null },
        work: "환불 지연 원인 조사",
      },
    ],
  );
});

test("S13: 선후 관계는 식별자를 하나씩 비교한다. 식별자에 줄바꿈이 있어도 다른 관계로 바뀐다", (t) => {
  // 식별자는 원장을 열 때 받은 newId가 만든다. 문자에 제한이 없다.
  const ids = ["request", "a", "b", "a\nb", "target"];
  const ledger = openLedger({ path: ":memory:", newId: () => ids.shift() ?? "" });
  t.after(() => ledger.close());
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "선후 관계" } });
  const [a, b, both, target] = ["A", "B", "A와 B", "기다리는 작업"].map(
    (work) => ledger.addTask(triage, { requestId, work }).id,
  ) as [string, string, string, string];
  assert.deepEqual([a, b, both, target], ["a", "b", "a\nb", "target"]);
  ledger.updateTask(user, { taskId: target, dependsOn: [both] });
  const count = ledger.changesSince(0).length;

  // 한 작업을 기다리던 것을 다른 두 작업을 기다리게 바꾼다.
  ledger.updateTask(user, { taskId: target, dependsOn: [a, b] });

  assert.deepEqual(ledger.getRequest(requestId).tasks.at(-1)?.dependsOn, [a, b]);
  const last = ledger.changesSince(count);
  assert.deepEqual(
    last.map((change) => [change.before, change.after]),
    [[{ dependsOn: [both] }, { dependsOn: [a, b] }]],
  );
});

test("할 일이 바뀐 쓰기 순번은 더할 때와 할 일을 바꿀 때 그 쓰기의 순번이 된다", (t) => {
  const { ledger, row } = openFileLedger(t);
  const seqs = (taskId: string) => {
    const task = row("SELECT added_seq, work_seq FROM tasks WHERE id = ?", taskId);
    return [task.added_seq, task.work_seq];
  };
  const lastWriteSeq = () => ledger.changesSince(0).at(-1)?.writeSeq;
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });

  // 더할 때는 더한 쓰기 순번이다.
  const first = ledger.addTask(triage, { requestId, work: "조사" });
  const second = ledger.addTask(triage, { requestId, work: "회신" });
  assert.deepEqual(
    [seqs(first.id), seqs(second.id)],
    [
      [2, 2],
      [3, 3],
    ],
  );
  // 할 일이 아닌 값을 바꾸거나 같은 할 일을 다시 써도 그대로다.
  ledger.updateTask(triage, { taskId: first.id, status: "in_progress", assignee: minsu });
  ledger.updateTask(triage, { taskId: first.id, work: "조사", status: "todo" });
  assert.deepEqual([seqs(first.id), lastWriteSeq()], [[2, 2], 5]);
  // 할 일을 바꾸면 그 쓰기의 순번이 된다. 더한 쓰기 순번은 바뀌지 않는다.
  ledger.updateTask(user, { taskId: first.id, work: "원인 조사" });
  assert.deepEqual([seqs(first.id), lastWriteSeq()], [[2, 6], 6]);
  // 완료하거나 되돌려도 그대로다.
  ledger.completeTask(user, { taskId: first.id });
  ledger.updateTask(user, { taskId: first.id, status: "todo" });
  assert.deepEqual(seqs(first.id), [2, 6]);

  // 답하면서 바꾸면 답과 같은 쓰기 순번이다.
  const item = ledger.raiseOpenItem(triage, { requestId, kind: "question", content: "범위는?" });
  ledger.resolveOpenItem(user, {
    openItemId: item.id,
    answer: "재처리까지",
    changes: [
      { action: "completeTask", input: { taskId: second.id } },
      { action: "updateTask", input: { taskId: first.id, work: "원인 조사와 재처리" } },
    ],
  });
  const answered = ledger.changesSince(9);
  assert.deepEqual(
    answered.map((change) => [change.seq, change.writeSeq, change.action]),
    [
      [10, 10, "resolveOpenItem"],
      [11, 10, "completeTask"],
      [12, 10, "updateTask"],
    ],
  );
  assert.deepEqual(
    [seqs(first.id), seqs(second.id)],
    [
      [2, 10],
      [3, 3],
    ],
  );
  // 완료를 쓴 쓰기 순번도 답과 같다.
  assert.equal(row("SELECT finished_seq FROM tasks WHERE id = ?", second.id).finished_seq, 10);
});
