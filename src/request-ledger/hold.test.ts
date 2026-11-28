// 작업 11(보류)의 완료 조건을 확인한다. S3의 보류 부분, S4, S27의 보류 부분, S28 뒷부분, S31의 보류 풀기.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { test } from "node:test";
import type { LockedWrite } from "./concurrency-writer.ts";
import { BUSY_TIMEOUT_MS } from "./db.ts";
import { type Ledger, openLedger } from "./index.ts";
import {
  at,
  makeTempDir,
  minsu,
  openFileLedger,
  openTestLedger,
  rejectsWith,
  startWorker,
  stored,
  type TestClock,
  triage,
  user,
  userViaSkill,
  verifier,
  WORKER_TEST_TIMEOUT_MS,
} from "./test-support.ts";

const connector = { kind: "assistant", module: "channel-connectors" } as const;

/** 요청 하나와 작업 둘, Jira 기록의 판본을 원본 시각만 바꿔 더하는 도우미를 준비한다. */
function setup(t: TestContext): {
  ledger: Ledger;
  clock: TestClock;
  requestId: string;
  investigate: string;
  reply: string;
  /** 그 원본 시각의 판본을 더하고 근거로 달 수 있는 참조를 돌려준다. */
  revisionAt(hhmm: string): { kind: "revision"; revisionId: string };
} {
  const { ledger, clock } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const investigate = ledger.addTask(triage, { requestId, work: "원인 조사", assignee: minsu });
  const reply = ledger.addTask(triage, { requestId, work: "요청자에게 회신" });
  return {
    ledger,
    clock,
    requestId,
    investigate: investigate.id,
    reply: reply.id,
    revisionAt(hhmm) {
      const { revisionId } = ledger.addRevision(connector, {
        source: "jira",
        sourceId: "VOC-201",
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

/** 그 요청의 작업 가운데 보류로 조회되는 작업들. */
function heldTasks(ledger: Ledger, requestId: string): string[] {
  return ledger
    .getRequest(requestId)
    .tasks.filter((task) => task.onHold)
    .map((task) => task.id);
}

function holdIds(ledger: Ledger, requestId: string): string[] {
  return ledger.getRequest(requestId).holds.map((hold) => hold.id);
}

test("S3: 비서는 보류를 걸 수 없다", (t) => {
  const { ledger, requestId, investigate } = setup(t);
  const before = ledger.changesSince(0).length;

  assert.throws(() => ledger.placeHold(triage, { requestId }), rejectsWith("requires_user"));
  assert.throws(
    () =>
      ledger.placeHold(verifier, {
        requestId,
        taskId: investigate,
        resumeCondition: "정산팀의 답이 오면 재개",
      }),
    rejectsWith("requires_user"),
  );

  // 거부된 쓰기는 보류도 변경 이력도 남기지 않는다.
  assert.deepEqual(ledger.getRequest(requestId).holds, []);
  assert.deepEqual(heldTasks(ledger, requestId), []);
  assert.equal(ledger.changesSince(0).length, before);
});

test("S4: 요청 조회에 걸려 있는 보류마다 식별자, 대상, 재개 조건, 건 시각이 나온다", (t) => {
  const { ledger, clock, requestId, investigate } = setup(t);

  clock.set("10:00");
  const onRequest = ledger.placeHold(user, {
    requestId,
    resumeCondition: "정산팀의 답이 오면 재개",
  });
  clock.set("10:30");
  const onTask = ledger.placeHold(userViaSkill, { requestId, taskId: investigate });

  // 대상은 작업의 식별자로 나온다. 비어 있으면 요청에 건 보류다.
  assert.deepEqual(ledger.getRequest(requestId).holds, [
    {
      id: onRequest.id,
      taskId: null,
      resumeCondition: "정산팀의 답이 오면 재개",
      placedAt: stored("10:00"),
    },
    { id: onTask.id, taskId: investigate, resumeCondition: null, placedAt: stored("10:30") },
  ]);
  // 건 것이 변경 이력에 보류를 대상으로 남는다.
  const placed = ledger.getRequest(requestId).changes.slice(-2);
  assert.deepEqual(
    placed.map((change) => [change.action, change.target, change.requestId, change.actor]),
    [
      ["placeHold", { kind: "hold", id: onRequest.id }, requestId, user],
      ["placeHold", { kind: "hold", id: onTask.id }, requestId, userViaSkill],
    ],
  );
  assert.deepEqual(
    placed.map((change) => [change.before, change.after]),
    [
      [
        null,
        {
          requestId,
          taskId: null,
          resumeCondition: "정산팀의 답이 오면 재개",
          placedAt: stored("10:00"),
        },
      ],
      [null, { requestId, taskId: investigate, resumeCondition: null, placedAt: stored("10:30") }],
    ],
  );
});

test("S27: 보류를 걸고 푸는 쓰기의 적용 범위는 밝히지 않으면 이 요청에만 해당하는 것으로 조회된다", (t) => {
  const { ledger, requestId, reply } = setup(t);

  const first = ledger.placeHold(user, { requestId, reason: "예산 확정 전까지 멈춘다" });
  ledger.releaseHold(user, { holdId: first.id });
  // 밝힌 값은 그대로 저장되고, 밝힌 것인지 기본값인지 구분된다.
  const second = ledger.placeHold(user, { requestId, taskId: reply, appliesTo: "similar_future" });
  ledger.releaseHold(user, { holdId: second.id, appliesTo: "this_request" });

  assert.deepEqual(
    ledger
      .getRequest(requestId)
      .changes.slice(-4)
      .map((change) => [change.action, change.appliesTo, change.reason]),
    [
      ["placeHold", { scope: "this_request", stated: false }, "예산 확정 전까지 멈춘다"],
      ["releaseHold", { scope: "this_request", stated: false }, null],
      ["placeHold", { scope: "similar_future", stated: true }, null],
      ["releaseHold", { scope: "this_request", stated: true }, null],
    ],
  );
});

test("S4: 보류된 작업은 비서가 상태를 바꿔도 보류로 조회되고, 사용자가 풀면 보류 중에 바뀐 상태가 그대로 드러난다", (t) => {
  const { ledger, requestId, investigate, reply } = setup(t);
  const hold = ledger.placeHold(user, { requestId, taskId: investigate });
  assert.deepEqual(heldTasks(ledger, requestId), [investigate]);

  // 보류는 상태 위에 얹는 표시다. 보류 중에도 상태는 기록에 따라 바뀐다.
  ledger.updateTask(triage, { taskId: investigate, status: "in_progress" });
  const held = taskOf(ledger, requestId, investigate);
  assert.deepEqual(
    [held.status, held.onHold, held.display, held.turn],
    ["in_progress", true, "on_hold", null],
  );
  // 보류하지 않은 작업은 그대로다.
  assert.deepEqual(
    [taskOf(ledger, requestId, reply).onHold, taskOf(ledger, requestId, reply).display],
    [false, "actionable"],
  );

  ledger.releaseHold(user, { holdId: hold.id });

  const released = taskOf(ledger, requestId, investigate);
  assert.deepEqual(
    [released.status, released.onHold, released.display, released.turn],
    ["in_progress", false, "actionable", minsu],
  );
  assert.deepEqual(ledger.getRequest(requestId).holds, []);
});

test("S4: 비서가 근거 없이 보류를 풀려고 하면 거부되고, 재개 조건의 근거를 달아 풀면 보류 중에 바뀐 상태가 드러난다", (t) => {
  const { ledger, clock, requestId, investigate, revisionAt } = setup(t);
  clock.set("10:00");
  const hold = ledger.placeHold(user, {
    requestId,
    taskId: investigate,
    resumeCondition: "정산팀의 답이 오면 재개",
  });
  ledger.updateTask(triage, { taskId: investigate, status: "in_progress" });
  const before = ledger.changesSince(0).length;

  assert.throws(
    () => ledger.releaseHold(verifier, { holdId: hold.id }),
    rejectsWith("evidence_required"),
  );
  assert.throws(
    () => ledger.releaseHold(verifier, { holdId: hold.id, evidence: [] }),
    rejectsWith("evidence_required"),
  );
  // 비서의 쓰기에는 사용자 확인을 근거로 달 수 없다.
  assert.throws(
    () =>
      ledger.releaseHold(verifier, { holdId: hold.id, evidence: [{ kind: "user_confirmation" }] }),
    rejectsWith("evidence_not_allowed"),
  );
  assert.deepEqual(holdIds(ledger, requestId), [hold.id]);
  assert.equal(ledger.changesSince(0).length, before);

  // 정산팀의 답이 달린 판본이다. 원본 시각이 보류를 건 시각보다 뒤다.
  const answered = revisionAt("11:00");
  clock.set("11:10");
  ledger.releaseHold(verifier, {
    holdId: hold.id,
    evidence: [answered],
    reason: "정산팀이 답했다",
  });

  const task = taskOf(ledger, requestId, investigate);
  assert.deepEqual([task.status, task.onHold, task.display], ["in_progress", false, "actionable"]);
  assert.deepEqual(ledger.getRequest(requestId).holds, []);
  // 푼 보류는 변경 이력에 줄의 내용과 근거와 함께 남는다.
  const released = ledger.getRequest(requestId).changes.at(-1);
  assert.deepEqual(
    [released?.action, released?.target, released?.actor, released?.reason, released?.at],
    ["releaseHold", { kind: "hold", id: hold.id }, verifier, "정산팀이 답했다", stored("11:10")],
  );
  assert.deepEqual(released?.before, {
    requestId,
    taskId: investigate,
    resumeCondition: "정산팀의 답이 오면 재개",
    placedAt: stored("10:00"),
  });
  assert.equal(released?.after, null);
  assert.deepEqual(released?.evidence, [answered]);
  // 근거로 단 판본의 내용이 요청 조회에 함께 나온다.
  assert.deepEqual(
    ledger.getRequest(requestId).evidenceRevisions.map((revision) => revision.id),
    [answered.revisionId],
  );
});

test("S4: 비서가 원본 시각이 보류를 건 시각과 같거나 앞선 판본을 근거로 풀려고 하면 거부된다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  clock.set("10:00");
  const hold = ledger.placeHold(user, { requestId, resumeCondition: "정산팀의 답이 오면 재개" });
  // 판본은 모두 보류를 건 뒤에 읽어 왔다. 따지는 것은 읽어 온 시각이 아니라 원본 시각이다.
  clock.set("12:00");
  const earlier = revisionAt("09:59");
  const sameTime = revisionAt("10:00");
  const later = revisionAt("10:01");

  for (const evidence of [[earlier], [sameTime], [earlier, sameTime]]) {
    assert.throws(
      () => ledger.releaseHold(verifier, { holdId: hold.id, evidence }),
      rejectsWith("evidence_too_early"),
    );
  }
  assert.deepEqual(holdIds(ledger, requestId), [hold.id]);

  // 뒤의 판본이 하나라도 있으면 풀 수 있다.
  ledger.releaseHold(verifier, { holdId: hold.id, evidence: [earlier, later] });
  assert.deepEqual(holdIds(ledger, requestId), []);
});

test("S4: 재개 조건이 없는 보류는 비서가 뒤의 판본을 달아도 풀 수 없고, 사용자는 풀 수 있다", (t) => {
  const { ledger, clock, requestId, investigate, revisionAt } = setup(t);
  clock.set("10:00");
  const hold = ledger.placeHold(user, { requestId, taskId: investigate });
  const later = revisionAt("11:00");
  clock.set("11:10");

  assert.throws(
    () => ledger.releaseHold(verifier, { holdId: hold.id, evidence: [later] }),
    rejectsWith("hold_without_resume_condition"),
  );
  assert.deepEqual(heldTasks(ledger, requestId), [investigate]);

  // 사용자는 근거 없이 푼다. 판본을 함께 달면 변경 이력에 남는다.
  ledger.releaseHold(user, { holdId: hold.id, evidence: [later] });
  assert.deepEqual(heldTasks(ledger, requestId), []);
  assert.deepEqual(ledger.getRequest(requestId).changes.at(-1)?.evidence, [later]);
});

test("S4: 요청과 그 요청의 작업에 보류가 따로 걸려 있으면 하나를 풀어도 작업은 보류로 조회된다", (t) => {
  for (const releasedFirst of ["요청의 보류", "작업의 보류"] as const) {
    const { ledger, requestId, investigate, reply } = setup(t);
    const onRequest = ledger.placeHold(user, { requestId });
    const onTask = ledger.placeHold(user, { requestId, taskId: investigate });
    // 요청을 보류하면 그 요청의 모든 작업이 보류된 것으로 본다.
    assert.deepEqual(heldTasks(ledger, requestId), [investigate, reply], releasedFirst);

    if (releasedFirst === "요청의 보류") {
      ledger.releaseHold(user, { holdId: onRequest.id });
      // 자기에게 걸린 보류가 남은 작업만 보류다.
      assert.deepEqual(heldTasks(ledger, requestId), [investigate], releasedFirst);
      assert.deepEqual(holdIds(ledger, requestId), [onTask.id], releasedFirst);
      ledger.releaseHold(user, { holdId: onTask.id });
    } else {
      ledger.releaseHold(user, { holdId: onTask.id });
      // 요청의 보류가 남아 있어 두 작업 모두 보류다.
      assert.deepEqual(heldTasks(ledger, requestId), [investigate, reply], releasedFirst);
      assert.deepEqual(holdIds(ledger, requestId), [onRequest.id], releasedFirst);
      ledger.releaseHold(user, { holdId: onRequest.id });
    }
    assert.deepEqual(heldTasks(ledger, requestId), [], releasedFirst);
  }
});

test("S4: 요청의 보류를 작업 하나에서만 풀려고 하면 거부된다", (t) => {
  const { ledger, requestId, investigate, reply } = setup(t);
  const onRequest = ledger.placeHold(user, { requestId });
  const onTask = ledger.placeHold(user, { requestId, taskId: investigate });
  const before = ledger.changesSince(0).length;

  // 풀 때 작업을 가리키면 그 작업에 건 보류만 풀 수 있다.
  assert.throws(
    () => ledger.releaseHold(user, { holdId: onRequest.id, taskId: investigate }),
    rejectsWith("hold_not_on_task"),
  );
  // 다른 작업에 건 보류를 가리켜도 거부된다.
  assert.throws(
    () => ledger.releaseHold(user, { holdId: onTask.id, taskId: reply }),
    rejectsWith("hold_not_on_task"),
  );
  assert.deepEqual(holdIds(ledger, requestId), [onRequest.id, onTask.id]);
  assert.deepEqual(heldTasks(ledger, requestId), [investigate, reply]);
  assert.equal(ledger.changesSince(0).length, before);

  // 그 작업에 건 보류는 그 작업을 가리켜 풀 수 있고, 요청의 보류는 작업을 가리키지 않고 푼다.
  ledger.releaseHold(user, { holdId: onTask.id, taskId: investigate });
  assert.deepEqual(heldTasks(ledger, requestId), [investigate, reply]);
  ledger.releaseHold(user, { holdId: onRequest.id });
  assert.deepEqual(heldTasks(ledger, requestId), []);
});

test("S4: 한 작업에 직접 건 보류 둘 가운데 하나만 풀면 작업은 보류로 조회된다", (t) => {
  const { ledger, clock, requestId, investigate, revisionAt } = setup(t);
  clock.set("10:00");
  const untilAnswer = ledger.placeHold(user, {
    requestId,
    taskId: investigate,
    resumeCondition: "정산팀의 답이 오면 재개",
  });
  clock.set("10:20");
  const untilBudget = ledger.placeHold(user, {
    requestId,
    taskId: investigate,
    resumeCondition: "예산이 확정되면 재개",
  });
  assert.deepEqual(holdIds(ledger, requestId), [untilAnswer.id, untilBudget.id]);

  // 비서가 한 보류의 재개 조건만 확인해 풀어도, 다른 보류가 남아 작업은 보류다.
  ledger.releaseHold(verifier, { holdId: untilAnswer.id, evidence: [revisionAt("10:30")] });
  assert.deepEqual(holdIds(ledger, requestId), [untilBudget.id]);
  assert.deepEqual(heldTasks(ledger, requestId), [investigate]);
  assert.equal(taskOf(ledger, requestId, investigate).display, "on_hold");

  ledger.releaseHold(user, { holdId: untilBudget.id });
  assert.deepEqual(heldTasks(ledger, requestId), []);
  assert.equal(taskOf(ledger, requestId, investigate).display, "actionable");
});

test("요청의 보류는 뒤에 더한 작업과 끝난 작업에도 걸리고, 다른 요청으로 번지지 않는다", (t) => {
  const { ledger, requestId, investigate, reply } = setup(t);
  const other = ledger.createRequest(triage, { decided: { title: "다른 요청" } });
  const otherTask = ledger.addTask(triage, { requestId: other.id, work: "다른 요청의 작업" });
  ledger.completeTask(user, { taskId: reply });

  const hold = ledger.placeHold(user, { requestId });
  const added = ledger.addTask(triage, { requestId, work: "보류한 뒤에 더한 작업" });

  assert.deepEqual(heldTasks(ledger, requestId), [investigate, reply, added.id]);
  // 끝난 작업에는 표시가 없다.
  assert.deepEqual(
    [taskOf(ledger, requestId, reply).status, taskOf(ledger, requestId, reply).display],
    ["done", null],
  );
  assert.deepEqual(heldTasks(ledger, other.id), []);
  assert.deepEqual(ledger.getRequest(other.id).holds, []);
  assert.equal(taskOf(ledger, other.id, otherTask.id).onHold, false);
  // 다른 요청의 변경 이력에는 이 보류가 나오지 않는다.
  assert.equal(
    ledger.getRequest(other.id).changes.some((change) => change.target.id === hold.id),
    false,
  );
});

test("보류를 걸면서 단 근거는 변경 이력에 남고, 비서가 풀 수 있는지는 건 시각으로만 가린다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  // 사용자가 보류를 걸게 된 기록이다. 원본 시각은 보류를 건 시각보다 앞선다.
  const asked = revisionAt("09:30");
  clock.set("10:00");
  const hold = ledger.placeHold(user, {
    requestId,
    resumeCondition: "정산팀의 답이 오면 재개",
    evidence: [asked],
  });

  assert.deepEqual(ledger.getRequest(requestId).changes.at(-1)?.evidence, [asked]);
  // 걸 때 단 판본으로는 비서가 풀 수 없다.
  assert.throws(
    () => ledger.releaseHold(verifier, { holdId: hold.id, evidence: [asked] }),
    rejectsWith("evidence_too_early"),
  );
  assert.deepEqual(holdIds(ledger, requestId), [hold.id]);
});

test("S31: 직접 맡긴 말은 보류를 푸는 근거로 달 수 없다", (t) => {
  const { ledger, clock, requestId } = setup(t);
  clock.set("10:00");
  const hold = ledger.placeHold(user, { requestId, resumeCondition: "다시 말하면 재개" });
  // 보류를 건 뒤에 사용자가 직접 한 말이다. 원본 시각이 아무리 늦어도 근거가 되지 않는다.
  const spoken = ledger.addRevision(userViaSkill, {
    source: "conversation",
    sourceId: "skill-session-31/turn-7",
    originalAt: at("23:00"),
    body: "그 일 다시 진행해 줘",
  });
  const said = { kind: "revision", revisionId: spoken.revisionId } as const;

  for (const actor of [verifier, user]) {
    assert.throws(
      () => ledger.releaseHold(actor, { holdId: hold.id, evidence: [said] }),
      rejectsWith("evidence_not_allowed"),
    );
  }
  assert.deepEqual(holdIds(ledger, requestId), [hold.id]);
  // 보류를 거는 쓰기의 근거로도 달 수 없다.
  assert.throws(
    () => ledger.placeHold(userViaSkill, { requestId, evidence: [said] }),
    rejectsWith("evidence_not_allowed"),
  );
  assert.deepEqual(holdIds(ledger, requestId), [hold.id]);

  // 사용자가 말로 한 지시는 기록이 아니라 사용자의 쓰기로 반영한다.
  ledger.releaseHold(userViaSkill, { holdId: hold.id });
  assert.deepEqual(holdIds(ledger, requestId), []);
});

test("없는 보류와 대상, 틀린 인자는 거부되고, 푼 보류는 다시 풀 수 없다", (t) => {
  const { ledger, requestId, investigate } = setup(t);
  const other = ledger.createRequest(triage, { decided: { title: "다른 요청" } });
  const before = ledger.changesSince(0).length;

  assert.throws(
    () => ledger.placeHold(user, { requestId: "request-none" }),
    rejectsWith("request_not_found"),
  );
  assert.throws(
    () => ledger.placeHold(user, { requestId, taskId: "task-none" }),
    rejectsWith("task_not_found"),
  );
  // 보류할 작업은 가리킨 요청의 작업이어야 한다.
  assert.throws(
    () => ledger.placeHold(user, { requestId: other.id, taskId: investigate }),
    rejectsWith("task_not_in_request"),
  );
  assert.throws(
    () => ledger.placeHold(user, { requestId, resumeCondition: "  " }),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.placeHold(user, { requestId, until: "내일" } as never),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.releaseHold(user, { holdId: "hold-none" }),
    rejectsWith("hold_not_found"),
  );
  assert.equal(ledger.changesSince(0).length, before);

  const hold = ledger.placeHold(user, { requestId, taskId: investigate });
  assert.throws(
    () => ledger.releaseHold(user, { holdId: hold.id, taskId: "task-none" }),
    rejectsWith("task_not_found"),
  );
  ledger.releaseHold(user, { holdId: hold.id });
  assert.throws(() => ledger.releaseHold(user, { holdId: hold.id }), rejectsWith("hold_not_found"));
});

test("보류는 하나씩 따로 저장되고, 풀면 줄이 지워져 변경 이력에만 남는다", (t) => {
  const { ledger, clock, row } = openFileLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "원인 조사" });
  clock.set("10:00");
  const first = ledger.placeHold(user, { requestId, taskId, resumeCondition: "답이 오면 재개" });
  const second = ledger.placeHold(user, { requestId });

  assert.deepEqual(row("SELECT * FROM holds WHERE id = ?", first.id), {
    id: first.id,
    request_id: requestId,
    task_id: taskId,
    resume_condition: "답이 오면 재개",
    placed_at: stored("10:00"),
  });
  assert.deepEqual(row("SELECT * FROM holds WHERE id = ?", second.id), {
    id: second.id,
    request_id: requestId,
    task_id: null,
    resume_condition: null,
    placed_at: stored("10:00"),
  });

  ledger.releaseHold(user, { holdId: first.id });

  assert.deepEqual(row("SELECT count(*) AS count FROM holds"), { count: 1 });
  assert.deepEqual(row("SELECT count(*) AS count FROM holds WHERE id = ?", first.id), { count: 0 });
  // 요청 조회의 변경 이력에는 건 것과 푼 것이 모두 남아 있다.
  assert.deepEqual(
    ledger
      .getRequest(requestId)
      .changes.filter((change) => change.target.kind === "hold")
      .map((change) => [change.action, change.target.id]),
    [
      ["placeHold", first.id],
      ["placeHold", second.id],
      ["releaseHold", first.id],
    ],
  );
});

/**
 * 이 프로세스의 원장으로 공개 쓰기를 한 번, 쓰기 잠금을 기다리지 않고 해 본다. 던진 오류를 돌려주고, 쓰였으면 undefined다.
 * 원장이 쓰기 잠금을 잡으려는 바로 그 연결의 대기 시간만 0으로 줄였다가 되돌린다. 다른 프로세스가 쓰기 잠금을
 * 쥐고 있으면 SQLite가 기다리지 않고 바로 SQLITE_BUSY를 돌려준다.
 */
function attemptWithoutWaiting(write: () => unknown): unknown {
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql !== "BEGIN IMMEDIATE") {
      return exec.call(this, sql);
    }
    exec.call(this, "PRAGMA busy_timeout = 0");
    try {
      return exec.call(this, sql);
    } finally {
      exec.call(this, `PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }
  };
  try {
    write();
    return undefined;
  } catch (error) {
    return error;
  } finally {
    DatabaseSync.prototype.exec = exec;
  }
}

function isBusyError(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown } | null | undefined)?.errcode;
  return typeof errcode === "number" && (errcode & 0xff) === 5;
}

test("S28: 한 프로세스가 작업을 보류하는 동안 다른 프로세스가 같은 작업의 상태를 써도 보류가 유지된다", {
  timeout: WORKER_TEST_TIMEOUT_MS,
}, async (t) => {
  // 어느 쪽이 먼저 쓰기 잠금을 쥐든 보류와 상태가 둘 다 남는다.
  for (const lockedFirst of ["placeHold", "updateTask"] as const) {
    const home = makeTempDir(t);
    const ledger = openLedger({ path: join(home, "ledger.sqlite") });
    t.after(() => ledger.close());
    const { id: requestId } = ledger.createRequest(triage, {
      decided: { title: "환불 지연 대응" },
    });
    const { id: taskId } = ledger.addTask(triage, { requestId, work: "원인 조사" });
    const hold = { requestId, taskId, resumeCondition: "정산팀의 답이 오면 재개" };
    const status = { taskId, status: "in_progress" } as const;
    const lingerMs = 100;
    // 이쪽이 하는 공개 쓰기. 상대가 먼저 보류를 걸면 상태를 쓰고, 상대가 먼저 상태를 쓰면 보류를 건다.
    const contend = (): unknown =>
      lockedFirst === "placeHold"
        ? ledger.updateTask(triage, status)
        : ledger.placeHold(user, hold);

    // 다른 프로세스가 쓰기 잠금을 잡고, 값을 쓰기 전에 멈춰 있다.
    const locked: LockedWrite =
      lockedFirst === "placeHold"
        ? { method: "placeHold", actor: user, input: hold, lingerMs }
        : { method: "updateTask", actor: triage, input: status, lingerMs };
    const other = startWorker(["write-once", JSON.stringify(locked)], home);
    t.after(() => other.kill());
    await other.waitForLine("locked");
    // 아직 커밋하지 않았으므로 이쪽에는 보류도 바뀐 상태도 보이지 않는다.
    const before = ledger.getRequest(requestId);
    assert.deepEqual([before.holds, before.tasks[0]?.status], [[], "todo"], lockedFirst);

    // 상대가 잠금을 쥐고 있는 동안 이쪽의 쓰기가 실제로 그 잠금과 부딪친다. 기다리지 않고 한 번 해 보면
    // 잠금 오류로 끝나고 아무것도 쓰이지 않는다. 두 쓰기가 겹쳤다는 것을 여기서 확인한다.
    const collided = attemptWithoutWaiting(contend);
    assert.ok(isBusyError(collided), `${lockedFirst}: ${String(collided)}`);
    assert.deepEqual(ledger.getRequest(requestId), before, lockedFirst);

    // 잠금을 놓게 하고 같은 쓰기를 다시 한다. 이번에는 상대가 커밋할 때까지 기다렸다가 쓴다.
    other.send("release");
    contend();
    const finished = await other.finished();
    assert.equal(finished.code, 0, `${lockedFirst}: ${finished.stderr}`);

    // 먼저 잠금을 쥔 쪽의 쓰기가 앞 순번이고, 뒤의 쓰기가 앞의 쓰기를 지우지 않았다.
    const after = ledger.getRequest(requestId);
    assert.deepEqual(
      after.changes.slice(-2).map((change) => change.action),
      lockedFirst === "placeHold" ? ["placeHold", "updateTask"] : ["updateTask", "placeHold"],
      lockedFirst,
    );
    assert.deepEqual(
      after.holds.map(({ taskId: target, resumeCondition }) => [target, resumeCondition]),
      [[taskId, "정산팀의 답이 오면 재개"]],
      lockedFirst,
    );
    const task = after.tasks[0];
    assert.deepEqual(
      [task?.status, task?.onHold, task?.display],
      ["in_progress", true, "on_hold"],
      lockedFirst,
    );
  }
});
