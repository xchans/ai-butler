// 작업 9(사실 정정과 나중 판본)의 완료 조건을 확인한다. S7, S8, S9, S32(합치기와 옮기기를 뺀 부분), S37의 판본 부분.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { test } from "node:test";
import type { Ledger } from "./index.ts";
import { anyAfter, hasLaterRevision, isAfter, latestOf, wroteAfter } from "./ordering.ts";
import {
  at,
  csTeam,
  jiwon,
  minsu,
  openTestLedger,
  rejectsWith,
  stored,
  type TestClock,
  triage,
  user,
  verifier,
} from "./test-support.ts";

const connector = { kind: "assistant", module: "channel-connectors" } as const;

type RevisionRef = { kind: "revision"; revisionId: string };

function setup(t: TestContext): {
  ledger: Ledger;
  clock: TestClock;
  requestId: string;
  /** Jira 티켓의 그 원본 시각 판본을 더하고 근거 참조를 돌려준다. */
  revisionAt(hhmm: string, body?: string): RevisionRef;
} {
  const { ledger, clock } = openTestLedger(t, "08:00");
  const { id: requestId } = ledger.createRequest(triage, {
    decided: { title: "환불 지연 대응" },
  });
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

/** 변경 이력의 이전 값이나 새 값에서 항목 하나를 꺼낸다. */
function part(value: unknown, key: string): unknown {
  return (value as Record<string, unknown> | null | undefined)?.[key];
}

function onlyTask(ledger: Ledger, requestId: string) {
  const [task] = ledger.getRequest(requestId).tasks;
  assert.ok(task);
  return task;
}

test("앞뒤를 가리는 비교: 근거의 시각은 같으면 뒤가 아니고, 순번은 시각이 같아도 뒤면 뒤다", () => {
  assert.equal(isAfter(stored("10:01"), stored("10:00")), true);
  assert.equal(isAfter(stored("10:00"), stored("10:00")), false);
  assert.equal(isAfter(stored("09:59"), stored("10:00")), false);
  // 마이크로초까지 비교한다.
  assert.equal(isAfter("2026-03-02T10:00:00.000001Z", stored("10:00")), true);
  assert.equal(anyAfter([stored("09:00"), stored("11:00")], stored("10:00")), true);
  assert.equal(anyAfter([], stored("10:00")), false);
  assert.equal(latestOf([stored("09:00"), stored("11:00"), stored("10:00")]), stored("11:00"));
  assert.equal(latestOf([]), null);

  // 나중 판본: 정정보다 뒤이고, 마지막으로 반영된 근거 판본보다 앞서지 않는다.
  assert.equal(hasLaterRevision([stored("11:00")], stored("10:00"), null), true);
  assert.equal(hasLaterRevision([stored("10:00")], stored("10:00"), null), false);
  assert.equal(hasLaterRevision([stored("11:00")], stored("10:00"), stored("11:30")), false);
  assert.equal(hasLaterRevision([stored("11:30")], stored("10:00"), stored("11:30")), true);
  assert.equal(hasLaterRevision([], stored("10:00"), null), false);

  assert.equal(wroteAfter(8, 7), true);
  assert.equal(wroteAfter(7, 7), false);
  assert.equal(wroteAfter(6, 7), false);
});

test("S7: 사용자가 작업의 상태를 바로잡은 뒤에는 비서가 나중 판본을 근거로 달아야 바꿀 수 있다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  const beforeCorrection = revisionAt("09:00", "작업 시작");
  clock.set("10:00");
  ledger.updateTask(user, { taskId, status: "in_progress" });
  const taskChanges = () =>
    ledger.changesSince(0).filter((change) => change.target.kind === "task").length;
  const count = taskChanges();

  clock.set("12:00");
  // 근거가 없으면 거부된다.
  assert.throws(
    () => ledger.updateTask(verifier, { taskId, status: "todo" }),
    rejectsWith("user_corrected_protected", ["status"]),
  );
  // 정정보다 먼저인 판본이면 거부된다. 정정과 같은 시각의 판본도 뒤가 아니다.
  assert.throws(
    () => ledger.updateTask(verifier, { taskId, status: "todo", evidence: [beforeCorrection] }),
    rejectsWith("user_corrected_protected", ["status"]),
  );
  assert.throws(
    () => ledger.updateTask(verifier, { taskId, status: "todo", evidence: [revisionAt("10:00")] }),
    rejectsWith("user_corrected_protected", ["status"]),
  );
  assert.equal(onlyTask(ledger, requestId).status, "in_progress");
  // 거부된 쓰기는 작업의 변경 이력을 남기지 않는다.
  assert.equal(taskChanges(), count);

  // 나중 판본을 근거로 쓰면 반영된다.
  const later = revisionAt("11:00", "담당자 답을 기다리는 중");
  ledger.updateTask(verifier, {
    taskId,
    status: "waiting",
    waitingFor: { party: csTeam, what: "대상 목록" },
    evidence: [later],
  });
  const task = onlyTask(ledger, requestId);
  assert.deepEqual([task.status, task.waitingFor?.party], ["waiting", csTeam]);
  const change = ledger.getRequest(requestId).changes.at(-1);
  assert.deepEqual(change?.evidence, [later]);
  assert.deepEqual(change?.after, {
    // 바로잡은 시각은 남고, 반영된 근거의 시각이 적힌다.
    status: { value: "waiting", correctedAt: stored("10:00"), evidenceAt: stored("11:00") },
    waitingFor: {
      value: { party: csTeam, what: "대상 목록" },
      correctedAt: null,
      evidenceAt: stored("11:00"),
    },
  });
});

test("S7: 사용자가 바로잡지 않은 작업의 값은 비서가 근거 없이 바꿀 수 있다", (t) => {
  const { ledger, requestId } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "데이터 변경" });

  ledger.updateTask(verifier, { taskId, status: "in_progress", assignee: minsu });

  const task = onlyTask(ledger, requestId);
  assert.deepEqual([task.status, task.assignee], ["in_progress", minsu]);
});

test("S7: 담당과 대기 대상도 사용자가 바로잡으면 나중 판본이 있어야 바뀌고, 어긋난 값이 오류에 모두 나온다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  clock.set("10:00");
  ledger.updateTask(user, {
    taskId,
    status: "waiting",
    assignee: minsu,
    waitingFor: { party: jiwon, what: "변경 승인" },
  });
  const before = onlyTask(ledger, requestId);

  clock.set("12:00");
  assert.throws(
    () => ledger.updateTask(verifier, { taskId, assignee: jiwon }),
    rejectsWith("user_corrected_protected", ["assignee"]),
  );
  assert.throws(
    () => ledger.updateTask(verifier, { taskId, waitingFor: { party: csTeam } }),
    rejectsWith("user_corrected_protected", ["waitingFor"]),
  );
  // 상태를 대기에서 옮기면 대기 대상도 비게 되므로 대기 대상의 조건도 함께 본다.
  assert.throws(
    () =>
      ledger.updateTask(verifier, {
        taskId,
        status: "in_progress",
        assignee: null,
        evidence: [revisionAt("09:00")],
      }),
    rejectsWith("user_corrected_protected", ["status", "assignee", "waitingFor"]),
  );
  assert.throws(
    () => ledger.cancelTask(verifier, { taskId, reason: "필요 없어 보인다" }),
    rejectsWith("user_corrected_protected", ["status", "waitingFor"]),
  );
  assert.deepEqual(onlyTask(ledger, requestId), before);

  const later = revisionAt("11:00", "승인 받음. 민수가 아니라 지원이 진행");
  ledger.updateTask(verifier, {
    taskId,
    status: "in_progress",
    assignee: jiwon,
    evidence: [later],
  });
  const task = onlyTask(ledger, requestId);
  assert.deepEqual([task.status, task.assignee, task.waitingFor], ["in_progress", jiwon, null]);
});

test("S7: 사용자가 작업을 더하면서 명시한 담당과 상태는 사용자가 바로잡은 값이다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  clock.set("10:00");
  const { id: taskId } = ledger.addTask(user, {
    requestId,
    work: "요청자에게 회신",
    assignee: minsu,
  });

  clock.set("12:00");
  assert.throws(
    () => ledger.updateTask(verifier, { taskId, assignee: jiwon }),
    rejectsWith("user_corrected_protected", ["assignee"]),
  );
  // 적지 않아 기본값이 된 상태는 바로잡은 값이 아니다.
  ledger.updateTask(verifier, { taskId, status: "in_progress" });
  ledger.updateTask(verifier, { taskId, assignee: jiwon, evidence: [revisionAt("11:00")] });

  const task = onlyTask(ledger, requestId);
  assert.deepEqual([task.status, task.assignee], ["in_progress", jiwon]);

  const stated = ledger.addTask(user, { requestId, work: "공유", status: "todo" });
  assert.throws(
    () => ledger.updateTask(verifier, { taskId: stated.id, status: "in_progress" }),
    rejectsWith("user_corrected_protected", ["status"]),
  );
});

test("S7: 비서가 사용자가 바로잡은 값과 같은 값을 쓰면 거부하지 않고 그 값만 건너뛴다", (t) => {
  const { ledger, clock, requestId } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  clock.set("10:00");
  ledger.updateTask(user, { taskId, status: "in_progress" });
  const count = ledger.changesSince(0).length;

  clock.set("11:00");
  ledger.updateTask(verifier, { taskId, status: "in_progress" });
  assert.equal(ledger.changesSince(0).length, count);

  // 같은 값은 건너뛰고 다른 값은 반영한다.
  ledger.updateTask(verifier, { taskId, status: "in_progress", assignee: minsu });
  const last = ledger.changesSince(0).at(-1);
  assert.deepEqual(Object.keys(last?.after as object), ["assignee"]);
  assert.equal(onlyTask(ledger, requestId).assignee?.kind, "person");
});

test("S7: 사용자가 같은 상태를 다시 써도 바로잡은 시각이 그때로 바뀌어, 그 사이의 판본으로는 바꿀 수 없다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  clock.set("10:00");
  ledger.updateTask(user, { taskId, status: "in_progress" });
  const between = revisionAt("11:00", "완료했다는 댓글");

  clock.set("12:00");
  ledger.updateTask(user, { taskId, status: "in_progress" });

  const last = ledger.changesSince(0).at(-1);
  assert.deepEqual(
    [last?.before, last?.after],
    [
      { status: { value: "in_progress", correctedAt: stored("10:00"), evidenceAt: null } },
      { status: { value: "in_progress", correctedAt: stored("12:00"), evidenceAt: null } },
    ],
  );
  assert.throws(
    () => ledger.updateTask(verifier, { taskId, status: "todo", evidence: [between] }),
    rejectsWith("user_corrected_protected", ["status"]),
  );
  assert.throws(
    () => ledger.completeTask(verifier, { taskId, evidence: [between] }),
    rejectsWith("evidence_too_early"),
  );
});

test("S7: 대기 대상을 사용자가 바로잡은 작업은 대기 대상의 나중 판본이 있어야 비서가 완료로 쓸 수 있다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const { id: taskId } = ledger.addTask(triage, {
    requestId,
    work: "데이터 변경",
    status: "waiting",
    waitingFor: { party: csTeam },
  });
  // 사용자가 11시에 대기 대상만 바로잡는다. 그때까지 대기 중이었다는 뜻이다.
  clock.set("11:00");
  ledger.updateTask(user, { taskId, waitingFor: { party: jiwon, what: "변경 승인" } });

  // 상태는 바로잡지 않았으므로 완료의 상태 검사는 통과하지만, 대기 대상을 지우는 검사에 걸린다.
  clock.set("13:00");
  assert.throws(
    () => ledger.completeTask(verifier, { taskId, evidence: [revisionAt("10:30", "완료")] }),
    rejectsWith("user_corrected_protected", ["waitingFor"]),
  );
  assert.equal(onlyTask(ledger, requestId).status, "waiting");

  ledger.completeTask(verifier, { taskId, evidence: [revisionAt("12:00", "승인 받고 완료")] });
  const task = onlyTask(ledger, requestId);
  assert.deepEqual([task.status, task.waitingFor], ["done", null]);
});

test("S7: 사용자의 정정과 완료 사이에 비서가 대기 대상을 바꿨으면, 그때 반영한 판본보다 앞선 판본으로는 완료하면서 지울 수 없다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  // 9시에 사용자가 대기 대상을 A로 정한다.
  clock.set("09:00");
  ledger.updateTask(user, {
    taskId,
    status: "waiting",
    waitingFor: { party: { kind: "team", name: "A팀" } },
  });
  // 비서가 12시 판본으로 대기 대상을 B로 바꾼다.
  clock.set("12:30");
  ledger.updateTask(verifier, {
    taskId,
    waitingFor: { party: { kind: "team", name: "B팀" } },
    evidence: [revisionAt("12:00", "B팀 답을 기다린다")],
  });
  const waitingBefore = onlyTask(ledger, requestId).waitingFor;
  const count = ledger.changesSince(0).length;

  // 10시 판본은 사용자의 정정(9시)보다는 뒤지만, 대기 대상에 이미 반영한 12시 판본보다 앞선다.
  const older = revisionAt("10:00", "완료했다는 댓글");
  assert.throws(
    () => ledger.completeTask(verifier, { taskId, evidence: [older] }),
    rejectsWith("user_corrected_protected", ["waitingFor"]),
  );
  assert.throws(
    () => ledger.cancelTask(verifier, { taskId, evidence: [older], reason: "필요 없어 보인다" }),
    // 상태에는 10시 판본이 나중 판본이다. 대기 대상에서만 걸린다.
    rejectsWith("user_corrected_protected", ["waitingFor"]),
  );
  const task = onlyTask(ledger, requestId);
  assert.deepEqual([task.status, task.waitingFor], ["waiting", waitingBefore]);
  // 판본을 더한 한 건 말고는 변경 이력이 늘지 않았다.
  assert.equal(ledger.changesSince(0).length, count + 1);

  // 반영한 판본보다 앞서지 않는 판본으로는 완료할 수 있고, 반영된 근거의 시각이 뒤로 돌아가지 않는다.
  ledger.completeTask(verifier, { taskId, evidence: [older, revisionAt("12:10", "완료")] });
  const last = ledger.getRequest(requestId).changes.at(-1);
  assert.deepEqual(
    [part(part(last?.before, "waitingFor"), "evidenceAt"), part(last?.after, "waitingFor")],
    [stored("12:00"), { value: null, correctedAt: stored("09:00"), evidenceAt: stored("12:10") }],
  );
});

test("S9: 대기 대상도 늦게 도착한 앞선 판본으로 되돌아가지 않는다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  clock.set("09:00");
  ledger.updateTask(user, {
    taskId,
    status: "waiting",
    waitingFor: { party: { kind: "team", name: "A팀" } },
  });
  clock.set("12:30");
  ledger.updateTask(verifier, {
    taskId,
    waitingFor: { party: { kind: "team", name: "B팀" }, what: "대상 목록" },
    evidence: [revisionAt("12:00")],
  });

  // 10시 판본이 늦게 도착한다. 정정(9시)보다는 뒤지만 이미 반영한 12시 판본보다 앞선다.
  clock.set("13:00");
  assert.throws(
    () =>
      ledger.updateTask(verifier, {
        taskId,
        waitingFor: { party: { kind: "team", name: "C팀" } },
        evidence: [revisionAt("10:00")],
      }),
    rejectsWith("user_corrected_protected", ["waitingFor"]),
  );
  // 요청한 내용만 바꾸는 것도 대기 대상을 바꾸는 것이다.
  assert.throws(
    () =>
      ledger.updateTask(verifier, {
        taskId,
        waitingFor: { party: { kind: "team", name: "B팀" }, what: "다른 내용" },
        evidence: [revisionAt("11:00")],
      }),
    rejectsWith("user_corrected_protected", ["waitingFor"]),
  );
  assert.deepEqual(onlyTask(ledger, requestId).waitingFor, {
    party: { kind: "team", name: "B팀" },
    what: "대상 목록",
  });

  ledger.updateTask(verifier, {
    taskId,
    waitingFor: { party: { kind: "team", name: "C팀" } },
    evidence: [revisionAt("12:00")],
  });
  assert.deepEqual(onlyTask(ledger, requestId).waitingFor?.party, { kind: "team", name: "C팀" });
});

test("S9: 정정보다 먼저 만들어진 티켓이 정정 뒤에 바뀌어 생긴 새 판본은 나중 판본으로 받아들여진다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  // 티켓은 정정보다 먼저 만들어졌다.
  const created = revisionAt("09:00", "티켓 생성");
  clock.set("10:00");
  ledger.updateTask(user, { taskId, status: "todo" });

  // 정정 뒤에 티켓이 바뀌어 같은 기록에 새 판본이 생긴다.
  clock.set("13:00");
  const updated = revisionAt("12:00", "진행 중으로 바뀜");
  assert.throws(
    () => ledger.updateTask(verifier, { taskId, status: "in_progress", evidence: [created] }),
    rejectsWith("user_corrected_protected", ["status"]),
  );
  ledger.updateTask(verifier, { taskId, status: "in_progress", evidence: [updated] });

  assert.equal(onlyTask(ledger, requestId).status, "in_progress");
});

test("S9: 정정 뒤의 판본 둘이 늦은 것부터 도착하면, 앞선 판본을 근거로 한 쓰기는 거부되어 값이 되돌아가지 않는다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  clock.set("10:00");
  ledger.updateTask(user, { taskId, status: "todo", assignee: minsu });

  // 12시 판본이 먼저 도착해 반영된다.
  clock.set("13:00");
  const newer = revisionAt("12:00", "지원이 맡아 진행 중");
  ledger.updateTask(verifier, {
    taskId,
    status: "in_progress",
    assignee: jiwon,
    evidence: [newer],
  });
  // 11시 판본이 늦게 도착한다. 정정보다는 뒤지만 이미 반영한 판본보다 앞선다.
  clock.set("14:00");
  const older = revisionAt("11:00", "아직 시작 전, 담당 미정");
  assert.throws(
    () =>
      ledger.updateTask(verifier, { taskId, status: "todo", assignee: null, evidence: [older] }),
    rejectsWith("user_corrected_protected", ["status", "assignee"]),
  );

  const task = onlyTask(ledger, requestId);
  assert.deepEqual([task.status, task.assignee], ["in_progress", jiwon]);
  // 반영한 판본과 원본 시각이 같거나 더 늦은 판본은 받아들여진다.
  ledger.updateTask(verifier, { taskId, status: "todo", evidence: [newer] });
  assert.equal(onlyTask(ledger, requestId).status, "todo");
});

test("S37: 사용자가 완료를 되돌린 작업을 비서가 예전 판본으로 다시 완료로 쓰면 거부된다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  const done = revisionAt("09:00", "상태: 완료");
  clock.set("09:30");
  ledger.completeTask(verifier, { taskId, evidence: [done] });
  // 사용자가 완료를 되돌린다. 실제로는 끝나지 않았다.
  clock.set("10:00");
  ledger.updateTask(user, { taskId, status: "in_progress" });

  clock.set("11:00");
  assert.throws(
    () => ledger.completeTask(verifier, { taskId, evidence: [done] }),
    rejectsWith("evidence_too_early"),
  );
  assert.equal(onlyTask(ledger, requestId).status, "in_progress");

  // 단 근거 가운데 적어도 하나가 사용자가 되돌린 뒤의 것이면 완료로 쓸 수 있다.
  const redone = revisionAt("10:30", "누락분까지 처리 완료");
  ledger.completeTask(verifier, { taskId, evidence: [done, redone] });
  const task = onlyTask(ledger, requestId);
  assert.equal(task.completion?.confirmed, "from_record");
  assert.deepEqual(
    task.completion?.evidence.map((evidence) =>
      evidence.kind === "revision" ? evidence.revision.body : evidence.kind,
    ),
    ["상태: 완료", "누락분까지 처리 완료"],
  );
});

test("S37: 사용자가 되돌린 완료에 달았던 판본은 원본 시각이 정정보다 뒤로 적혀 있어도 다시 완료하는 근거로 세지 않는다", (t) => {
  const { ledger, clock, requestId } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  // 원장의 시계는 밀리초까지, 원본 시각은 마이크로초까지다. 같은 밀리초 안에서 원본 시각이 1마이크로초 뒤인 판본이다.
  const justAfter = "2026-03-02T12:00:00.000001Z";
  const ticket = (sourceId: string, body: string) => ({
    kind: "revision" as const,
    revisionId: ledger.addRevision(connector, {
      source: "jira",
      sourceId,
      originalAt: justAfter,
      body,
    }).revisionId,
  });
  const done = ticket("VOC-201", "상태: 완료");
  clock.set("12:00");
  ledger.completeTask(verifier, { taskId, evidence: [done] });
  // 같은 밀리초에 사용자가 완료를 되돌린다. 바로잡은 시각은 12:00:00.000000이다.
  ledger.updateTask(user, { taskId, status: "in_progress" });

  // 같은 판본만 다시 내면 거부된다. 원본 시각만 보면 정정보다 뒤다.
  assert.throws(
    () => ledger.completeTask(verifier, { taskId, evidence: [done] }),
    rejectsWith("evidence_overruled"),
  );
  assert.equal(onlyTask(ledger, requestId).status, "in_progress");
  // 되돌린 완료에 달았던 근거가 변경 이력에 남는다.
  const reverted = ledger.getRequest(requestId).changes.at(-1);
  assert.deepEqual(
    [part(reverted?.before, "overruledEvidence"), part(reverted?.after, "overruledEvidence")],
    [[], [done]],
  );

  // 원본 시각이 같은 다른 판본은 막지 않는다. 예전 판본을 함께 내도 된다.
  const other = ticket("VOC-202", "누락분까지 처리 완료");
  ledger.completeTask(verifier, { taskId, evidence: [done, other] });
  assert.equal(onlyTask(ledger, requestId).completion?.confirmed, "from_record");

  // 다시 되돌리면 두 번째 완료에 달았던 근거도 더해진다. 둘 다 세지 않는다.
  ledger.updateTask(user, { taskId, status: "in_progress" });
  for (const evidence of [[done], [other], [done, other]]) {
    assert.throws(
      () => ledger.completeTask(verifier, { taskId, evidence }),
      rejectsWith("evidence_overruled"),
    );
  }
  const again = ledger.getRequest(requestId).changes.at(-1);
  assert.deepEqual(part(again?.after, "overruledEvidence"), [done, other]);
});

test("S37: 정정 뒤이지만 사용자가 되돌린 판본과, 되돌린 적 없지만 정정보다 앞선 판본을 함께 내도 완료로 쓸 수 없다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  // A: 원본 시각이 정정(12시)보다 1마이크로초 뒤이지만, 사용자가 되돌린 완료에 달았던 판본이다.
  const overruled = {
    kind: "revision" as const,
    revisionId: ledger.addRevision(connector, {
      source: "jira",
      sourceId: "VOC-401",
      originalAt: "2026-03-02T12:00:00.000001Z",
      body: "상태: 완료",
    }).revisionId,
  };
  // B: 되돌린 적 없는 별개의 판본이지만 원본 시각이 정정보다 앞선다.
  const earlier = revisionAt("11:00", "곧 끝난다는 댓글");
  clock.set("12:00");
  ledger.completeTask(verifier, { taskId, evidence: [overruled] });
  ledger.updateTask(user, { taskId, status: "todo" });
  const before = ledger.getRequest(requestId);

  // 한 판본이 두 조건을 함께 채워야 한다. A는 시각만, B는 되돌린 적 없다는 것만 채운다.
  for (const evidence of [
    [overruled, earlier],
    [earlier, overruled],
  ]) {
    assert.throws(
      () => ledger.completeTask(verifier, { taskId, evidence }),
      rejectsWith("evidence_overruled"),
    );
  }
  assert.throws(
    () => ledger.completeTask(verifier, { taskId, evidence: [earlier] }),
    rejectsWith("evidence_too_early"),
  );

  // 상태와 변경 이력이 그대로다.
  const after = ledger.getRequest(requestId);
  assert.equal(after.tasks[0]?.status, "todo");
  assert.deepEqual(after, before);

  // 정정 뒤이고 되돌린 적도 없는 판본이 하나 있으면, 나머지를 함께 내도 완료로 쓸 수 있다.
  const fresh = revisionAt("12:30", "누락분까지 완료");
  ledger.completeTask(verifier, { taskId, evidence: [overruled, earlier, fresh] });
  assert.equal(ledger.getRequest(requestId).tasks[0]?.status, "done");
});

test("S37: 사용자가 되돌린 취소와 사용자가 직접 표시했다 되돌린 완료에 달았던 판본도 세지 않는다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const cancelled = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  const marked = ledger.addTask(triage, { requestId, work: "회신" });
  const later = "2026-03-02T10:00:00.000500Z";
  const withdrawn = {
    kind: "revision" as const,
    revisionId: ledger.addRevision(connector, {
      source: "slack",
      sourceId: "C01/77",
      originalAt: later,
      body: "안 해도 된다는 말",
    }).revisionId,
  };
  clock.set("10:00");
  ledger.cancelTask(verifier, { taskId: cancelled.id, evidence: [withdrawn], reason: "철회" });
  ledger.completeTask(user, { taskId: marked.id, evidence: [withdrawn] });
  ledger.updateTask(user, { taskId: cancelled.id, status: "todo" });
  ledger.updateTask(user, { taskId: marked.id, status: "todo" });

  for (const taskId of [cancelled.id, marked.id]) {
    assert.throws(
      () => ledger.completeTask(verifier, { taskId, evidence: [withdrawn] }),
      rejectsWith("evidence_overruled"),
    );
    // 사용자의 정정보다 앞선 판본뿐이면 시각이 이르다는 오류다.
    assert.throws(
      () => ledger.completeTask(verifier, { taskId, evidence: [revisionAt("09:00")] }),
      rejectsWith("evidence_too_early"),
    );
  }
  // 비서가 자기 완료를 되돌린 것은 사용자가 되돌린 것이 아니다. 근거를 적어 두지 않는다.
  const own = ledger.addTask(triage, { requestId, work: "조사" });
  const first = revisionAt("10:30");
  ledger.completeTask(verifier, { taskId: own.id, evidence: [first] });
  ledger.updateTask(verifier, { taskId: own.id, status: "todo", evidence: [revisionAt("10:40")] });
  ledger.completeTask(verifier, { taskId: own.id, evidence: [first] });
  assert.equal(ledger.getRequest(requestId).tasks[2]?.status, "done");
});

test("처음 정하는 값에 단 근거가 그 값에 반영된 근거가 된다", (t) => {
  const { ledger, clock, revisionAt } = setup(t);
  const noon = revisionAt("12:00", "금요일까지 재처리까지 부탁드립니다");
  // 저장된 판본을 근거로 달아 기한과 약속한 결과를 정해 등록한다.
  const { id: requestId } = ledger.createRequest(triage, {
    decided: {
      title: "환불 재처리",
      due: at("18:00"),
      promise: { work: "재처리한다", notify: [jiwon] },
      urgency: "high",
    },
    evidence: [noon],
    reason: "티켓의 요청 내용",
  });
  const registered = ledger.getRequest(requestId).changes[0];
  assert.deepEqual(registered?.evidence, [noon]);
  assert.equal(registered?.reason, "티켓의 요청 내용");
  const after = registered?.after as Record<string, { evidenceAt?: string | null }>;
  assert.deepEqual(
    [after.due?.evidenceAt, after.promise?.evidenceAt],
    [stored("12:00"), stored("12:00")],
  );
  // 근거의 시각을 두지 않는 값에는 적지 않는다.
  assert.equal("evidenceAt" in (after.urgency ?? {}), false);

  // 사용자가 10시에 기한을 정한다. 그 뒤의 판본이어도 등록할 때 반영한 12시 판본보다 앞서면 값이 되돌아가지 않는다.
  clock.set("10:00");
  ledger.updateRequest(user, { requestId, due: at("19:00") });
  assert.throws(
    () =>
      ledger.updateRequest(triage, {
        requestId,
        due: at("20:00"),
        evidence: [revisionAt("11:00")],
      }),
    rejectsWith("user_set_protected", ["due"]),
  );
  ledger.updateRequest(triage, { requestId, due: at("20:00"), evidence: [revisionAt("12:30")] });
  assert.equal(ledger.getRequest(requestId).due.value, stored("20:00"));

  // 작업도 같다. 근거를 달아 더한 작업의 상태와 담당에 그 근거가 반영된다.
  const { id: taskId } = ledger.addTask(triage, {
    requestId,
    work: "재처리",
    status: "in_progress",
    assignee: minsu,
    evidence: [noon],
    reason: "티켓의 담당자",
  });
  const added = ledger.getRequest(requestId).changes.at(-1);
  assert.deepEqual([added?.evidence, added?.reason], [[noon], "티켓의 담당자"]);
  assert.deepEqual(added?.after, {
    requestId,
    work: "재처리",
    status: { value: "in_progress", correctedAt: null, evidenceAt: stored("12:00") },
    assignee: { value: minsu, correctedAt: null, evidenceAt: stored("12:00") },
    // 정하지 않은 값에는 반영된 근거가 없다.
    waitingFor: { value: null, correctedAt: null, evidenceAt: null },
    dependsOn: [],
  });
  ledger.updateTask(user, { taskId, status: "in_progress", assignee: minsu });
  assert.throws(
    () =>
      ledger.updateTask(verifier, {
        taskId,
        status: "todo",
        assignee: jiwon,
        evidence: [revisionAt("11:30")],
      }),
    rejectsWith("user_corrected_protected", ["status", "assignee"]),
  );
  ledger.updateTask(verifier, { taskId, assignee: jiwon, evidence: [revisionAt("12:40")] });
  assert.deepEqual(ledger.getRequest(requestId).tasks[0]?.assignee, jiwon);
});

test("작업을 더하면서 명시적으로 비운 담당과 대기 대상에도 그 결정의 근거 시각이 남는다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const noon = revisionAt("12:00", "담당은 아직 없다고 한다");
  clock.set("09:00");
  // 사용자가 12시 판본을 달아 담당이 없다고 명시해 작업을 더한다.
  const { id: taskId } = ledger.addTask(user, {
    requestId,
    work: "재처리",
    assignee: null,
    waitingFor: null,
    evidence: [noon],
  });
  assert.deepEqual(ledger.getRequest(requestId).changes.at(-1)?.after, {
    requestId,
    work: "재처리",
    status: { value: "todo", correctedAt: null, evidenceAt: stored("12:00") },
    // 비워 둔다고 명시한 값이다. 바로잡은 시각과 반영된 근거의 시각이 함께 남는다.
    assignee: { value: null, correctedAt: stored("09:00"), evidenceAt: stored("12:00") },
    waitingFor: { value: null, correctedAt: stored("09:00"), evidenceAt: stored("12:00") },
    dependsOn: [],
  });

  // 정정(9시)보다는 뒤지만 그 결정에 반영한 12시 판본보다 앞선 판본으로는 담당을 정할 수 없다.
  clock.set("13:00");
  const eleven = revisionAt("11:00", "민수가 맡는다");
  assert.throws(
    () => ledger.updateTask(verifier, { taskId, assignee: minsu, evidence: [eleven] }),
    rejectsWith("user_corrected_protected", ["assignee"]),
  );
  assert.throws(
    () =>
      ledger.updateTask(verifier, {
        taskId,
        status: "waiting",
        waitingFor: { party: csTeam },
        evidence: [eleven],
      }),
    rejectsWith("user_corrected_protected", ["waitingFor"]),
  );
  assert.deepEqual(
    [onlyTask(ledger, requestId).assignee, onlyTask(ledger, requestId).waitingFor],
    [null, null],
  );
  ledger.updateTask(verifier, { taskId, assignee: minsu, evidence: [revisionAt("12:30")] });
  assert.deepEqual(onlyTask(ledger, requestId).assignee, minsu);

  // 같은 결정을 updateTask로 쓴 것과 결과가 같다.
  const viaUpdate = ledger.addTask(triage, { requestId, work: "회신" });
  clock.set("09:00");
  ledger.updateTask(user, { taskId: viaUpdate.id, assignee: null, evidence: [noon] });
  assert.deepEqual(part(ledger.getRequest(requestId).changes.at(-1)?.after, "assignee"), {
    value: null,
    correctedAt: stored("09:00"),
    evidenceAt: stored("12:00"),
  });
  assert.throws(
    () =>
      ledger.updateTask(verifier, { taskId: viaUpdate.id, assignee: minsu, evidence: [eleven] }),
    rejectsWith("user_corrected_protected", ["assignee"]),
  );
});

test("작업을 더하면서 적지 않은 담당과 대기 대상에는 근거를 붙이지 않는다. 비서가 명시해 비운 값에는 붙인다", (t) => {
  const { ledger, requestId, revisionAt } = setup(t);
  const noon = revisionAt("12:00");
  const snapshot = (key: string) => part(ledger.getRequest(requestId).changes.at(-1)?.after, key);
  const none = { value: null, correctedAt: null, evidenceAt: null };

  ledger.addTask(user, { requestId, work: "적지 않은 작업", evidence: [noon] });
  assert.deepEqual([snapshot("assignee"), snapshot("waitingFor")], [none, none]);
  // 적지 않아도 할 일로 정해진 상태에는 근거가 반영된다.
  assert.deepEqual(snapshot("status"), {
    value: "todo",
    correctedAt: null,
    evidenceAt: stored("12:00"),
  });

  // 비서가 비워 둔다고 명시한 값은 사용자가 바로잡은 값이 아니지만, 그 결정에 반영한 근거는 남는다.
  ledger.addTask(triage, { requestId, work: "비서가 비운 작업", assignee: null, evidence: [noon] });
  assert.deepEqual(
    [snapshot("assignee"), snapshot("waitingFor")],
    [{ value: null, correctedAt: null, evidenceAt: stored("12:00") }, none],
  );
});

test("요청을 등록하면서 명시적으로 비운 값에도 그 결정의 근거 시각이 남는다", (t) => {
  const { ledger, clock, revisionAt } = setup(t);
  const noon = revisionAt("12:00", "기한은 정하지 않기로 했다");
  clock.set("09:00");
  const byUser = ledger.createRequest(user, {
    stated: { title: "기한 없는 요청", due: null },
    evidence: [noon],
  });
  const byAssistant = ledger.createRequest(triage, {
    decided: { title: "비서가 기한을 비운 요청", due: null },
    evidence: [noon],
  });
  const omitted = ledger.createRequest(triage, {
    decided: { title: "기한을 적지 않은 요청" },
    evidence: [noon],
  });
  const due = (id: string) => part(ledger.getRequest(id).changes[0]?.after, "due");

  assert.deepEqual(due(byUser.id), {
    value: null,
    setBy: null,
    userSetAt: stored("09:00"),
    evidenceAt: stored("12:00"),
  });
  assert.deepEqual(due(byAssistant.id), {
    value: null,
    setBy: null,
    userSetAt: null,
    evidenceAt: stored("12:00"),
  });
  // 적지 않은 값은 정한 값이 아니다. 변경 이력에 나오지 않는다.
  assert.equal(due(omitted.id), undefined);

  // 사용자가 비운 기한은 그 결정에 반영한 판본보다 앞선 판본으로 다시 채울 수 없다.
  clock.set("13:00");
  assert.throws(
    () =>
      ledger.updateRequest(triage, {
        requestId: byUser.id,
        due: at("18:00"),
        evidence: [revisionAt("11:00")],
      }),
    rejectsWith("user_set_protected", ["due"]),
  );
  ledger.updateRequest(triage, {
    requestId: byUser.id,
    due: at("18:00"),
    evidence: [revisionAt("12:30")],
  });
  assert.equal(ledger.getRequest(byUser.id).due.value, stored("18:00"));
});

test("처음 정하는 값의 근거도 근거로 달 수 있는 것이어야 한다", (t) => {
  const { ledger, requestId } = setup(t);
  const spoken = ledger.addRevision(user, {
    source: "conversation",
    sourceId: "turn-1",
    originalAt: at("09:00"),
    body: "금요일까지 해 줘",
  });
  const said = [{ kind: "revision", revisionId: spoken.revisionId }] as const;
  const count = ledger.changesSince(0).length;

  // 직접 맡긴 말은 접수 원본으로 연결하고, 근거로는 달 수 없다.
  assert.throws(
    () => ledger.createRequest(user, { stated: { title: "정산" }, evidence: said }),
    rejectsWith("evidence_not_allowed"),
  );
  assert.throws(
    () => ledger.addTask(triage, { requestId, work: "정산", evidence: said }),
    rejectsWith("evidence_not_allowed"),
  );
  assert.throws(
    () =>
      ledger.createRequest(triage, {
        decided: { title: "정산" },
        evidence: [{ kind: "user_confirmation" }],
      }),
    rejectsWith("evidence_not_allowed"),
  );
  assert.throws(
    () =>
      ledger.addTask(triage, {
        requestId,
        work: "정산",
        evidence: [{ kind: "revision", revisionId: "revision-none" }],
      }),
    rejectsWith("evidence_not_found"),
  );
  assert.equal(ledger.changesSince(0).length, count);
});

test("S27: 비서가 같은 값에 더 나중 근거를 달아 반영된 근거의 시각만 바뀐 쓰기도 변경 이력을 남긴다", (t) => {
  const { ledger, requestId, revisionAt } = setup(t);
  ledger.updateRequest(triage, { requestId, due: at("18:00") });
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "재처리", assignee: minsu });
  const noon = revisionAt("12:00");
  const count = ledger.changesSince(0).length;

  // 값과 정한 주체는 그대로이고 반영된 근거의 시각만 바뀐다.
  ledger.updateRequest(triage, { requestId, due: at("18:00"), evidence: [noon] });
  ledger.updateTask(triage, { taskId, status: "todo", assignee: minsu, evidence: [noon] });

  const [request, task] = ledger.changesSince(count);
  assert.deepEqual(
    [request?.before, request?.after, request?.evidence],
    [
      { due: { value: stored("18:00"), setBy: "assistant", userSetAt: null, evidenceAt: null } },
      {
        due: {
          value: stored("18:00"),
          setBy: "assistant",
          userSetAt: null,
          evidenceAt: stored("12:00"),
        },
      },
      [noon],
    ],
  );
  assert.deepEqual(
    [task?.before, task?.after],
    [
      {
        status: { value: "todo", correctedAt: null, evidenceAt: null },
        assignee: { value: minsu, correctedAt: null, evidenceAt: null },
      },
      {
        status: { value: "todo", correctedAt: null, evidenceAt: stored("12:00") },
        assignee: { value: minsu, correctedAt: null, evidenceAt: stored("12:00") },
      },
    ],
  );
  // 같은 근거로 한 번 더 쓰면 모두 그대로이므로 남지 않는다. 근거를 두지 않는 긴급도도 같다.
  ledger.updateRequest(triage, { requestId, due: at("18:00"), evidence: [noon] });
  ledger.updateTask(triage, { taskId, status: "todo", assignee: minsu, evidence: [noon] });
  ledger.setPriority(triage, { requestId, urgency: "high" });
  ledger.setPriority(triage, { requestId, urgency: "high", evidence: [noon] });
  assert.equal(ledger.changesSince(count).length, 3);
});

test("같은 주체를 이름 표기만 다르게 쓴 담당과 대기 대상은 같은 값이다", (t) => {
  const { ledger, clock, requestId } = setup(t);
  const { id: taskId } = ledger.addTask(triage, { requestId, work: "재처리" });
  const other = ledger.addTask(triage, { requestId, work: "조사", assignee: jiwon });
  clock.set("10:00");
  ledger.updateTask(user, {
    taskId,
    status: "waiting",
    assignee: jiwon,
    waitingFor: { party: jiwon, what: "승인" },
  });
  const renamed = { ...jiwon, name: "Jiwon Kim" };
  const count = ledger.changesSince(0).length;

  // 사용자가 바로잡은 값이면 건너뛰고 표기도 바꾸지 않는다. 함께 쓴 다른 값은 반영된다.
  clock.set("11:00");
  ledger.updateTask(verifier, {
    taskId,
    assignee: renamed,
    waitingFor: { party: renamed, what: "승인" },
    work: "누락분 재처리",
  });
  const task = onlyTask(ledger, requestId);
  assert.deepEqual(
    [task.assignee, task.waitingFor, task.work],
    [jiwon, { party: jiwon, what: "승인" }, "누락분 재처리"],
  );
  assert.deepEqual(Object.keys(ledger.changesSince(count)[0]?.after as object), ["work"]);
  // 같은 주체여도 요청한 내용이 다르면 대기 대상을 바꾸는 것이다. 다른 주체도 그렇다.
  assert.throws(
    () => ledger.updateTask(verifier, { taskId, waitingFor: { party: renamed, what: "검토" } }),
    rejectsWith("user_corrected_protected", ["waitingFor"]),
  );
  assert.throws(
    () => ledger.updateTask(verifier, { taskId, assignee: { kind: "person", name: "김지원" } }),
    rejectsWith("user_corrected_protected", ["assignee"]),
  );

  // 사용자가 바로잡지 않은 값은 표기가 바뀐 것을 변경으로 반영한다.
  ledger.updateTask(verifier, { taskId: other.id, assignee: renamed });
  assert.deepEqual(ledger.getRequest(requestId).tasks[1]?.assignee, renamed);
});

test("S8: 사용자가 약속한 결과를 바로잡은 뒤에는 나중 판본을 근거로 달아야 바뀌고, 사용자 지정은 남는다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const before = revisionAt("09:00", "환불 지연 원인을 알려 주세요");
  clock.set("10:00");
  ledger.updateRequest(user, {
    requestId,
    promise: { work: "원인만 조사해 알려 준다", notify: [jiwon] },
  });

  clock.set("12:00");
  // 근거 없이 다른 값을 쓰면 거부된다.
  assert.throws(
    () => ledger.updateRequest(triage, { requestId, promise: { work: "원인 조사와 재처리" } }),
    rejectsWith("user_set_protected", ["promise"]),
  );
  // 사용자 지정보다 먼저인 판본도 거부된다.
  assert.throws(
    () =>
      ledger.updateRequest(triage, {
        requestId,
        promise: { work: "원인 조사와 재처리" },
        evidence: [before],
      }),
    rejectsWith("user_set_protected", ["promise"]),
  );
  assert.deepEqual(ledger.getRequest(requestId).promise.value, {
    work: "원인만 조사해 알려 준다",
    notify: [jiwon],
  });

  // 요청자가 요청을 바꾼 나중 판본을 근거로 달면 값이 바뀌고, 정한 주체는 비서이며 사용자 지정은 걸린 채다.
  const changed = revisionAt("11:00", "재처리까지 부탁드립니다");
  ledger.updateRequest(triage, {
    requestId,
    promise: { work: "원인 조사와 재처리", notify: [jiwon] },
    evidence: [changed],
  });
  assert.deepEqual(ledger.getRequest(requestId).promise, {
    value: { work: "원인 조사와 재처리", notify: [jiwon] },
    setBy: "assistant",
    userSet: true,
    userSetAt: stored("10:00"),
  });
  assert.deepEqual(ledger.getRequest(requestId).changes.at(-1)?.evidence, [changed]);

  // 그 뒤에 비서가 근거 없이 또 다른 값을 쓰면 거부된다.
  assert.throws(
    () => ledger.updateRequest(triage, { requestId, promise: { work: "재처리만" } }),
    rejectsWith("user_set_protected", ["promise"]),
  );
  // 이미 반영한 판본보다 앞선 판본으로도 되돌아가지 않는다.
  const late = revisionAt("10:30", "원인만 알려 주셔도 됩니다");
  assert.throws(
    () =>
      ledger.updateRequest(triage, {
        requestId,
        promise: { work: "원인만 조사" },
        evidence: [late],
      }),
    rejectsWith("user_set_protected", ["promise"]),
  );

  // 사용자 지정을 풀면 비서가 근거 없이 쓸 수 있고, 예전 판본을 근거로 달아도 그 때문에 거부되지 않는다.
  ledger.updateRequest(user, { requestId, clearUserSet: ["promise"] });
  ledger.updateRequest(triage, { requestId, promise: { work: "재처리만" } });
  ledger.updateRequest(triage, {
    requestId,
    promise: { work: "원인만 조사" },
    evidence: [before],
  });
  assert.deepEqual(ledger.getRequest(requestId).promise, {
    value: { work: "원인만 조사", notify: [] },
    setBy: "assistant",
    userSet: false,
    userSetAt: null,
  });
});

test("S8: 기한도 사용자 지정이 걸리면 나중 판본으로만 바뀌고 사용자 지정은 남는다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  const before = revisionAt("09:00");
  clock.set("10:00");
  ledger.updateRequest(user, { requestId, due: at("18:00") });

  clock.set("12:00");
  assert.throws(
    () => ledger.updateRequest(triage, { requestId, due: at("20:00") }),
    rejectsWith("user_set_protected", ["due"]),
  );
  assert.throws(
    () => ledger.updateRequest(triage, { requestId, due: at("20:00"), evidence: [before] }),
    rejectsWith("user_set_protected", ["due"]),
  );
  // 사용자 지정이 걸린 시각과 원본 시각이 같은 판본은 뒤가 아니다.
  assert.throws(
    () =>
      ledger.updateRequest(triage, {
        requestId,
        due: at("20:00"),
        evidence: [revisionAt("10:00")],
      }),
    rejectsWith("user_set_protected", ["due"]),
  );

  ledger.updateRequest(triage, { requestId, due: at("20:00"), evidence: [revisionAt("11:00")] });
  assert.deepEqual(ledger.getRequest(requestId).due, {
    value: stored("20:00"),
    setBy: "assistant",
    userSet: true,
    userSetAt: stored("10:00"),
  });
  assert.throws(
    () => ledger.updateRequest(triage, { requestId, due: at("21:00") }),
    rejectsWith("user_set_protected", ["due"]),
  );
  assert.throws(
    () =>
      ledger.updateRequest(triage, {
        requestId,
        due: at("21:00"),
        evidence: [revisionAt("10:30")],
      }),
    rejectsWith("user_set_protected", ["due"]),
  );

  ledger.updateRequest(user, { requestId, clearUserSet: ["due"] });
  ledger.updateRequest(triage, { requestId, due: at("21:00") });
  ledger.updateRequest(triage, { requestId, due: at("22:00"), evidence: [before] });
  assert.deepEqual(ledger.getRequest(requestId).due, {
    value: stored("22:00"),
    setBy: "assistant",
    userSet: false,
    userSetAt: null,
  });
});

test("S8: 비서가 사용자 지정이 걸린 기한과 같은 값을 나중 판본으로 쓰면 정한 주체와 근거 시각이 고쳐진다", (t) => {
  const { ledger, clock, requestId, revisionAt } = setup(t);
  clock.set("10:00");
  ledger.updateRequest(user, { requestId, due: at("18:00") });
  const count = ledger.changesSince(0).length;

  // 조건을 채우지 못한 같은 값은 건너뛴다.
  clock.set("12:00");
  ledger.updateRequest(triage, { requestId, due: at("18:00") });
  assert.equal(ledger.changesSince(0).length, count);
  assert.equal(ledger.getRequest(requestId).due.setBy, "user");

  // 조건을 채운 같은 값은 받아들인다. 그 판본보다 앞선 판본으로는 값이 되돌아가지 않는다.
  ledger.updateRequest(triage, { requestId, due: at("18:00"), evidence: [revisionAt("11:30")] });
  assert.deepEqual(ledger.getRequest(requestId).due, {
    value: stored("18:00"),
    setBy: "assistant",
    userSet: true,
    userSetAt: stored("10:00"),
  });
  assert.throws(
    () =>
      ledger.updateRequest(triage, {
        requestId,
        due: at("15:00"),
        evidence: [revisionAt("11:00")],
      }),
    rejectsWith("user_set_protected", ["due"]),
  );
});

test("S32: 사용자가 제목을 고친 직후에는 비서가 바꿀 수 없고, 그 뒤 기록이 연결되거나 작업이 더해지면 바꿀 수 있다", (t) => {
  const { ledger, clock, requestId } = setup(t);
  clock.set("10:00");
  ledger.updateRequest(user, { requestId, title: "3월 환불 지연 건" });

  clock.set("11:00");
  assert.throws(
    () => ledger.updateRequest(triage, { requestId, title: "환불 지연과 재처리" }),
    rejectsWith("user_set_protected", ["title"]),
  );

  // 작업이 더해지면 비서가 근거 없이 제목을 바꿀 수 있다. 정한 주체는 비서이고 사용자 지정은 걸린 채다.
  ledger.addTask(triage, { requestId, work: "재처리" });
  ledger.updateRequest(triage, { requestId, title: "환불 지연과 재처리" });
  assert.deepEqual(ledger.getRequest(requestId).title, {
    value: "환불 지연과 재처리",
    setBy: "assistant",
    userSet: true,
    userSetAt: stored("10:00"),
  });

  // 더해진 것 없이 비서가 또 바꾸면 거부된다.
  assert.throws(
    () => ledger.updateRequest(triage, { requestId, title: "환불 건" }),
    rejectsWith("user_set_protected", ["title"]),
  );

  // 기록이 연결돼도 바꿀 수 있다. 직접 더 맡긴 말의 접수 원본도 센다.
  const more = ledger.addRevision(user, {
    source: "conversation",
    sourceId: "turn-4",
    originalAt: at("11:00"),
    body: "재발 방지 방안도 정리해 줘",
  });
  // 판본을 더한 것만으로는 그 요청에 더해진 것이 아니다.
  assert.throws(
    () => ledger.updateRequest(triage, { requestId, title: "환불 건" }),
    rejectsWith("user_set_protected", ["title"]),
  );
  ledger.linkRecord(user, { recordId: more.recordId, requestId, role: "intake" });
  ledger.updateRequest(triage, { requestId, title: "환불 지연, 재처리, 재발 방지" });
  assert.equal(ledger.getRequest(requestId).title.value, "환불 지연, 재처리, 재발 방지");

  // 사용자 지정을 풀면 조건 없이 바꿀 수 있다.
  ledger.updateRequest(user, { requestId, clearUserSet: ["title"] });
  ledger.updateRequest(triage, { requestId, title: "환불 건" });
  ledger.updateRequest(triage, { requestId, title: "환불 지연 대응" });
  assert.deepEqual(ledger.getRequest(requestId).title, {
    value: "환불 지연 대응",
    setBy: "assistant",
    userSet: false,
    userSetAt: null,
  });
});

test("S32: 시계가 멈춰 시각이 같아도 제목을 쓴 뒤의 쓰기면 세고, 제목을 쓰기 전에 더해진 것은 세지 않는다", (t) => {
  // 시계를 움직이지 않는다. 모든 쓰기의 시각이 같다.
  const { ledger, requestId } = setup(t);
  ledger.addTask(triage, { requestId, work: "제목을 고치기 전에 더한 작업" });
  ledger.updateRequest(user, { requestId, title: "사용자가 고친 제목" });

  assert.throws(
    () => ledger.updateRequest(triage, { requestId, title: "비서의 제목" }),
    rejectsWith("user_set_protected", ["title"]),
  );

  ledger.addTask(triage, { requestId, work: "제목을 고친 뒤에 더한 작업" });
  ledger.updateRequest(triage, { requestId, title: "비서의 제목" });

  const changes = ledger.getRequest(requestId).changes;
  assert.equal(new Set(changes.map((change) => change.at)).size, 1);
  assert.equal(ledger.getRequest(requestId).title.value, "비서의 제목");
});

test("S32: 등록할 때 함께 연결한 접수 원본은 제목과 같은 쓰기이므로 세지 않는다", (t) => {
  const { ledger } = setup(t);
  const slack = ledger.addRevision(connector, {
    source: "slack",
    sourceId: "C01/9",
    originalAt: at("07:00"),
    body: "계약서 좀 봐 주세요",
  });
  const { id } = ledger.createRequest(user, {
    stated: { title: "A사 계약서 검토" },
    intake: [slack.recordId],
  });

  assert.throws(
    () => ledger.updateRequest(triage, { requestId: id, title: "계약서 검토" }),
    rejectsWith("user_set_protected", ["title"]),
  );

  // 이미 있는 요청에 접수 원본을 더하면 센다.
  const jira = ledger.addRevision(connector, {
    source: "jira",
    sourceId: "LEGAL-3",
    originalAt: at("07:30"),
    body: "검토 요청 티켓",
  });
  ledger.linkRecord(triage, { recordId: jira.recordId, requestId: id, role: "intake" });
  ledger.updateRequest(triage, { requestId: id, title: "계약서 검토" });
  assert.equal(ledger.getRequest(id).title.setBy, "assistant");
});

test("S32: 사용자가 같은 제목을 다시 쓰면 그때를 제목을 마지막으로 쓴 때로 본다", (t) => {
  const { ledger, requestId } = setup(t);
  ledger.updateRequest(user, { requestId, title: "사용자가 고친 제목" });
  ledger.addTask(triage, { requestId, work: "더해진 작업" });
  // 작업이 더해진 뒤에 사용자가 제목을 그대로 두겠다고 다시 쓴다.
  ledger.updateRequest(user, { requestId, title: "사용자가 고친 제목" });

  assert.throws(
    () => ledger.updateRequest(triage, { requestId, title: "비서의 제목" }),
    rejectsWith("user_set_protected", ["title"]),
  );
  // 같은 연결을 다시 만드는 것은 더해진 것이 아니다.
  const slack = ledger.addRevision(connector, {
    source: "slack",
    sourceId: "C01/3",
    originalAt: at("07:00"),
    body: "문의",
  });
  ledger.linkRecord(triage, { recordId: slack.recordId, requestId, role: "progress" });
  ledger.updateRequest(triage, { requestId, title: "비서의 제목" });
  ledger.linkRecord(triage, { recordId: slack.recordId, requestId, role: "progress" });
  assert.throws(
    () => ledger.updateRequest(triage, { requestId, title: "비서가 또 고친 제목" }),
    rejectsWith("user_set_protected", ["title"]),
  );
});
