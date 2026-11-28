// 작업 8(확인할 사항)의 완료 조건을 확인한다. S39의 쓰기 부분, S24(닫힘을 뺀 부분), S5의 어긋남.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  at,
  jiwon,
  minsu,
  openTestLedger,
  rejectsWith,
  stored,
  triage,
  user,
  userViaSkill,
  verifier,
} from "./test-support.ts";

const connector = { kind: "assistant", module: "channel-connectors" } as const;

test("S39: 확인할 사항은 비서만 남기고, 요청 조회에 종류, 내용, 선택지와 함께 나온다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const task = ledger.addTask(triage, { requestId, work: "데이터 변경" });

  clock.set("10:00");
  const question = ledger.raiseOpenItem(triage, {
    requestId,
    kind: "question",
    content: "환불 대상에 2월 결제분도 넣을까요?",
    options: ["넣는다", "3월분만"],
  });
  // 승인은 확인할 사항의 한 종류다.
  const approval = ledger.raiseOpenItem(verifier, {
    requestId,
    taskId: task.id,
    kind: "approval",
    content: "운영 DB의 환불 상태를 바꿔도 될까요?",
  });

  assert.deepEqual(ledger.getRequest(requestId).openItems, [
    {
      id: question.id,
      taskId: null,
      kind: "question",
      content: "환불 대상에 2월 결제분도 넣을까요?",
      options: ["넣는다", "3월분만"],
      raisedAt: stored("10:00"),
      resolved: false,
      answer: null,
      resolvedAt: null,
    },
    {
      id: approval.id,
      taskId: task.id,
      kind: "approval",
      content: "운영 DB의 환불 상태를 바꿔도 될까요?",
      options: null,
      raisedAt: stored("10:00"),
      resolved: false,
      answer: null,
      resolvedAt: null,
    },
  ]);
  // 남긴 모듈은 변경 이력의 주체에 있다.
  const raised = ledger.getRequest(requestId).changes.at(-1);
  assert.deepEqual(
    [raised?.action, raised?.actor, raised?.target],
    ["raiseOpenItem", verifier, { kind: "open_item", id: approval.id }],
  );

  // 사용자가 남기려 하면 거부된다.
  for (const actor of [user, userViaSkill]) {
    assert.throws(
      () => ledger.raiseOpenItem(actor, { requestId, kind: "question", content: "사용자의 질문" }),
      rejectsWith("requires_assistant"),
    );
  }
  assert.equal(ledger.getRequest(requestId).openItems.length, 2);
});

test("S39: 확인할 사항은 네 종류 모두 사용자만 답해 풀고, 이미 푼 것에 다시 답하면 거부된다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const kinds = ["question", "approval", "unverified", "mismatch"] as const;
  const items = kinds.map((kind) =>
    ledger.raiseOpenItem(triage, { requestId, kind, content: `${kind} 확인할 사항` }),
  );
  const count = ledger.changesSince(0).length;

  // 비서가 답하려 하면 거부된다.
  for (const { id } of items) {
    assert.throws(
      () => ledger.resolveOpenItem(triage as never, { openItemId: id, answer: "비서의 답" }),
      rejectsWith("requires_user"),
    );
  }
  assert.equal(ledger.changesSince(0).length, count);

  clock.set("11:00");
  for (const { id } of items) {
    ledger.resolveOpenItem(user, { openItemId: id, answer: "확인했다" });
  }

  assert.deepEqual(
    ledger
      .getRequest(requestId)
      .openItems.map((item) => [item.kind, item.resolved, item.answer, item.resolvedAt]),
    kinds.map((kind) => [kind, true, "확인했다", stored("11:00")]),
  );
  // 이미 푼 것에 다시 답하면 거부되고 처음 답이 남는다.
  clock.set("12:00");
  assert.throws(
    () => ledger.resolveOpenItem(user, { openItemId: items[0]?.id ?? "", answer: "다른 답" }),
    rejectsWith("open_item_already_resolved"),
  );
  assert.equal(ledger.getRequest(requestId).openItems[0]?.answer, "확인했다");
  // 답은 일어난 일을 사용자가 알린 것이므로, 밝히지 않으면 이 요청에만 해당한다.
  const resolved = ledger.getRequest(requestId).changes.at(-1);
  assert.deepEqual(
    [resolved?.action, resolved?.before, resolved?.after, resolved?.appliesTo],
    [
      "resolveOpenItem",
      { answer: null, resolvedAt: null },
      { answer: "확인했다", resolvedAt: stored("11:00") },
      { scope: "this_request", stated: false },
    ],
  );
});

test("S39: 답이 비어 있거나 없는 확인할 사항이면 거부된다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const other = ledger.createRequest(triage, { decided: { title: "다른 요청" } });
  const elsewhere = ledger.addTask(triage, { requestId: other.id, work: "다른 요청의 작업" });
  const item = ledger.raiseOpenItem(triage, { requestId, kind: "question", content: "질문" });

  assert.throws(
    () => ledger.resolveOpenItem(user, { openItemId: item.id, answer: "  " }),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.resolveOpenItem(user, { openItemId: "item-none", answer: "답" }),
    rejectsWith("open_item_not_found"),
  );
  assert.throws(
    () =>
      ledger.raiseOpenItem(triage, { requestId, kind: "todo" as never, content: "종류가 틀림" }),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.raiseOpenItem(triage, { requestId, kind: "question", content: "" }),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () =>
      ledger.raiseOpenItem(triage, {
        requestId,
        taskId: elsewhere.id,
        kind: "question",
        content: "다른 요청의 작업에 단 질문",
      }),
    rejectsWith("task_not_in_request"),
  );
  assert.equal(ledger.getRequest(requestId).openItems[0]?.resolved, false);
  assert.equal(ledger.getRequest(requestId).openItems.length, 1);
});

test("S24: 확인할 사항에 답하면서 값을 바꾸면 둘이 함께 저장되고 변경 이력에 그 답이 근거로 남는다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, {
    decided: { title: "환불 지연 대응", urgency: "low", requester: minsu },
  });
  const task = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  const item = ledger.raiseOpenItem(triage, {
    requestId,
    kind: "question",
    content: "요청자가 누구인가요? 급한 건인가요?",
  });
  const seqBefore = ledger.changesSince(0).at(-1)?.seq ?? 0;

  clock.set("11:00");
  ledger.resolveOpenItem(user, {
    openItemId: item.id,
    answer: "요청자는 김지원이고 오늘 안에 끝내야 한다. 데이터 변경은 내가 이미 했다",
    changes: [
      { action: "updateRequest", input: { requestId, requester: jiwon } },
      { action: "setPriority", input: { requestId, urgency: "high" } },
      { action: "completeTask", input: { taskId: task.id } },
    ],
  });

  const request = ledger.getRequest(requestId);
  assert.equal(request.openItems[0]?.resolved, true);
  assert.deepEqual(request.requester.value, jiwon);
  assert.deepEqual(
    [request.urgency.value, request.urgency.setBy, request.urgency.userSetAt],
    ["high", "user", stored("11:00")],
  );
  assert.equal(request.tasks[0]?.status, "done");

  // 답은 resolveOpenItem으로, 값 변경은 그 값을 쓰는 함수의 이름으로 남고 쓰기 순번이 같다.
  const answerEvidence = [{ kind: "answer", openItemId: item.id }];
  assert.deepEqual(
    ledger
      .changesSince(seqBefore)
      .map((change) => [
        change.seq - seqBefore,
        change.writeSeq - seqBefore,
        change.action,
        change.target.kind,
        change.evidence,
      ]),
    [
      [1, 1, "resolveOpenItem", "open_item", []],
      [2, 1, "updateRequest", "request", answerEvidence],
      [3, 1, "setPriority", "request", answerEvidence],
      [4, 1, "completeTask", "task", answerEvidence],
    ],
  );
  // 답과 값 변경은 적용 범위를 따로 본다. 값을 바로잡은 것은 다음 유사 업무에도 적용한다.
  assert.deepEqual(
    ledger.changesSince(seqBefore).map((change) => change.appliesTo),
    [
      { scope: "this_request", stated: false },
      { scope: "similar_future", stated: false },
      { scope: "similar_future", stated: false },
      { scope: "this_request", stated: false },
    ],
  );
  // 그 근거는 종류가 답으로 조회된다.
  assert.deepEqual(request.tasks[0]?.completion, {
    by: "user",
    at: stored("11:00"),
    confirmed: "user_marked",
    evidence: [
      {
        kind: "answer",
        openItemId: item.id,
        answer: "요청자는 김지원이고 오늘 안에 끝내야 한다. 데이터 변경은 내가 이미 했다",
      },
    ],
  });
});

test("S24: 사용자가 밝힌 적용 범위는 답과 값 변경에 모두 남는다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const item = ledger.raiseOpenItem(triage, { requestId, kind: "question", content: "급한가요?" });

  ledger.resolveOpenItem(user, {
    openItemId: item.id,
    answer: "이번만 급하다",
    changes: [{ action: "setPriority", input: { requestId, urgency: "high" } }],
    appliesTo: "this_request",
  });

  assert.deepEqual(
    ledger.changesSince(2).map((change) => [change.action, change.appliesTo]),
    [
      ["resolveOpenItem", { scope: "this_request", stated: true }],
      ["setPriority", { scope: "this_request", stated: true }],
    ],
  );
});

test("S24: 값 변경이 거부되면 답도 저장되지 않는다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const task = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  const item = ledger.raiseOpenItem(triage, { requestId, kind: "question", content: "질문" });
  const before = ledger.getRequest(requestId);

  const rejected: [unknown, Parameters<typeof rejectsWith>[0]][] = [
    // 둘째 값 변경이 규칙에 어긋난다. 첫째 값 변경과 답도 함께 저장되지 않는다.
    [
      [
        { action: "setPriority", input: { requestId, urgency: "high" } },
        { action: "updateTask", input: { taskId: task.id, status: "waiting" } },
      ],
      "waiting_target_mismatch",
    ],
    [[{ action: "updateRequest", input: { requestId, title: " " } }], "title_required"],
    [[{ action: "completeTask", input: { taskId: "task-none" } }], "task_not_found"],
    // 빈 자리가 있는 배열도 모든 자리를 검사해 거부한다.
    [new Array(1), "invalid_argument"],
    [
      [{ action: "setPriority", input: { requestId, urgency: "high", evidence: new Array(1) } }],
      "invalid_argument",
    ],
    // 함께 바꿀 수 있는 쓰기가 아니다.
    [[{ action: "raiseOpenItem", input: { requestId } }], "invalid_argument"],
    [[{ action: "setPriority" }], "invalid_argument"],
    ["setPriority", "invalid_argument"],
  ];
  for (const [changes, code] of rejected) {
    assert.throws(
      () =>
        ledger.resolveOpenItem(user, {
          openItemId: item.id,
          answer: "답",
          changes: changes as never,
        }),
      rejectsWith(code),
      JSON.stringify(changes),
    );
  }

  assert.deepEqual(ledger.getRequest(requestId), before);
  // 거부된 뒤에도 다시 답할 수 있다.
  ledger.resolveOpenItem(user, { openItemId: item.id, answer: "답" });
  assert.equal(ledger.getRequest(requestId).openItems[0]?.answer, "답");
});

test("S24: 비서가 사용자 확인이나 답을 근거로 달면 거부된다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, {
    decided: { title: "환불 지연 대응", urgency: "low" },
  });
  const task = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  const item = ledger.raiseOpenItem(triage, { requestId, kind: "question", content: "질문" });
  ledger.resolveOpenItem(user, { openItemId: item.id, answer: "끝났다고 들었다" });
  const before = ledger.getRequest(requestId);

  for (const evidence of [
    [{ kind: "user_confirmation" }],
    [{ kind: "answer", openItemId: item.id }],
  ] as const) {
    assert.throws(
      () => ledger.completeTask(verifier, { taskId: task.id, evidence }),
      rejectsWith("evidence_not_allowed"),
    );
    assert.throws(
      () => ledger.setPriority(triage, { requestId, urgency: "high", evidence }),
      rejectsWith("evidence_not_allowed"),
    );
    assert.throws(
      () => ledger.updateTask(triage, { taskId: task.id, status: "in_progress", evidence }),
      rejectsWith("evidence_not_allowed"),
    );
  }
  assert.deepEqual(ledger.getRequest(requestId), before);

  // 사용자의 쓰기에는 붙는다. 변경 이력과 조회에서 근거의 종류가 구분된다.
  ledger.completeTask(user, {
    taskId: task.id,
    evidence: [{ kind: "user_confirmation" }, { kind: "answer", openItemId: item.id }],
  });
  assert.deepEqual(ledger.getRequest(requestId).tasks[0]?.completion?.evidence, [
    { kind: "user_confirmation" },
    { kind: "answer", openItemId: item.id, answer: "끝났다고 들었다" },
  ]);
});

test("S24: 아직 답하지 않았거나 없는 확인할 사항은 근거로 달 수 없다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const item = ledger.raiseOpenItem(triage, { requestId, kind: "question", content: "질문" });

  assert.throws(
    () =>
      ledger.setPriority(user, {
        requestId,
        urgency: "high",
        evidence: [{ kind: "answer", openItemId: item.id }],
      }),
    rejectsWith("evidence_not_allowed"),
  );
  assert.throws(
    () =>
      ledger.setPriority(user, {
        requestId,
        urgency: "high",
        evidence: [{ kind: "answer", openItemId: "item-none" }],
      }),
    rejectsWith("evidence_not_found"),
  );
  assert.throws(
    () =>
      ledger.setPriority(user, {
        requestId,
        urgency: "high",
        evidence: [{ kind: "artifact", artifactId: "artifact-1" } as never],
      }),
    rejectsWith("invalid_argument"),
  );
  assert.equal(ledger.getRequest(requestId).urgency.value, null);
});

test("S5: 비서가 어긋남을 확인할 사항으로 남기면 요청 조회에 나온다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const task = ledger.addTask(triage, { requestId, work: "요청자에게 회신" });
  clock.set("10:00");
  ledger.completeTask(user, { taskId: task.id });
  // 사용자가 완료로 표시했는데 기록은 아직 회신이 없다고 한다. 비서는 완료를 되돌리지 못하고 어긋남을 남긴다.
  const thread = ledger.addRevision(connector, {
    source: "slack",
    sourceId: "C01/1",
    originalAt: at("11:00"),
    body: "아직 답을 못 받았어요",
  });
  assert.throws(
    () =>
      ledger.updateTask(verifier, {
        taskId: task.id,
        status: "todo",
        evidence: [{ kind: "revision", revisionId: thread.revisionId }],
      }),
    rejectsWith("user_finished_protected"),
  );

  clock.set("11:30");
  const mismatch = ledger.raiseOpenItem(verifier, {
    requestId,
    taskId: task.id,
    kind: "mismatch",
    content: "완료로 표시됐지만 요청자는 아직 답을 못 받았다고 한다",
  });

  const request = ledger.getRequest(requestId);
  assert.equal(request.tasks[0]?.completion?.confirmed, "user_marked");
  assert.deepEqual(request.openItems, [
    {
      id: mismatch.id,
      taskId: task.id,
      kind: "mismatch",
      content: "완료로 표시됐지만 요청자는 아직 답을 못 받았다고 한다",
      options: null,
      raisedAt: stored("11:30"),
      resolved: false,
      answer: null,
      resolvedAt: null,
    },
  ]);
});

test("S24: 답 한 번에 같은 작업을 고치고 완료해도, 완료의 근거에는 완료에 단 것만 나온다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const task = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  const item = ledger.raiseOpenItem(triage, { requestId, kind: "question", content: "끝났나요?" });
  const revision = (sourceId: string, body: string) => ({
    kind: "revision" as const,
    revisionId: ledger.addRevision(connector, {
      source: "jira",
      sourceId,
      originalAt: at("09:30"),
      body,
    }).revisionId,
  });
  const forWork = revision("VOC-1", "할 일을 고친 근거");
  const forDone = revision("VOC-2", "완료의 근거");
  const seqBefore = ledger.changesSince(0).at(-1)?.seq ?? 0;

  clock.set("11:00");
  ledger.resolveOpenItem(user, {
    openItemId: item.id,
    answer: "누락분까지 끝났다",
    changes: [
      {
        action: "updateTask",
        input: { taskId: task.id, work: "누락분까지 데이터 변경", evidence: [forWork] },
      },
      { action: "completeTask", input: { taskId: task.id, evidence: [forDone] } },
    ],
  });

  const answerRef = { kind: "answer", openItemId: item.id };
  // 한 쓰기 안에서 같은 작업에 쓰기 이름마다 한 건씩 남는다.
  assert.deepEqual(
    ledger
      .changesSince(seqBefore)
      .map((change) => [
        change.writeSeq - seqBefore,
        change.action,
        change.target.id,
        change.evidence,
      ]),
    [
      [1, "resolveOpenItem", item.id, []],
      [1, "updateTask", task.id, [forWork, answerRef]],
      [1, "completeTask", task.id, [forDone, answerRef]],
    ],
  );
  // 완료의 근거는 완료에 단 판본과 답이다. 할 일을 고칠 때 단 판본은 섞이지 않는다.
  assert.deepEqual(
    ledger
      .getRequest(requestId)
      .tasks[0]?.completion?.evidence.map((evidence) =>
        evidence.kind === "revision" ? evidence.revision.body : evidence.kind,
      ),
    ["완료의 근거", "answer"],
  );
});

test("S24: 답 한 번에 취소했다 되돌리고 완료해도 지금의 완료에 단 근거만 나온다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const task = ledger.addTask(triage, { requestId, work: "데이터 변경" });
  const item = ledger.raiseOpenItem(triage, { requestId, kind: "question", content: "끝났나요?" });
  const forCancel = {
    kind: "revision" as const,
    revisionId: ledger.addRevision(connector, {
      source: "jira",
      sourceId: "VOC-3",
      originalAt: at("09:30"),
      body: "취소의 근거",
    }).revisionId,
  };

  ledger.resolveOpenItem(user, {
    openItemId: item.id,
    answer: "취소한 줄 알았는데 끝났다",
    changes: [
      { action: "cancelTask", input: { taskId: task.id, evidence: [forCancel], reason: "착오" } },
      { action: "updateTask", input: { taskId: task.id, status: "todo" } },
      { action: "completeTask", input: { taskId: task.id } },
    ],
  });

  const done = ledger.getRequest(requestId).tasks[0];
  assert.equal(done?.status, "done");
  assert.deepEqual(
    done?.completion?.evidence.map((evidence) => evidence.kind),
    ["answer"],
  );
  // 값 변경마다 적은 사유는 그 값 변경의 변경 이력에만 남는다.
  assert.deepEqual(
    ledger
      .getRequest(requestId)
      .changes.slice(-4)
      .map((change) => [change.action, change.reason]),
    [
      ["resolveOpenItem", null],
      ["cancelTask", "착오"],
      ["updateTask", null],
      ["completeTask", null],
    ],
  );
});

test("S24: 답하면서 한 대상에 같은 쓰기를 두 번 넣으면 거부되고, 서로 다른 쓰기는 받는다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const first = ledger.addTask(triage, { requestId, work: "조사" });
  const second = ledger.addTask(triage, { requestId, work: "회신" });
  const item = ledger.raiseOpenItem(triage, { requestId, kind: "question", content: "질문" });
  const before = ledger.getRequest(requestId);

  const repeated: unknown[] = [
    [
      { action: "updateRequest", input: { requestId, title: "첫째 제목" } },
      { action: "updateRequest", input: { requestId, title: "둘째 제목" } },
    ],
    [
      { action: "setPriority", input: { requestId, urgency: "high" } },
      { action: "updateRequest", input: { requestId, title: "제목" } },
      { action: "setPriority", input: { requestId, importance: "high" } },
    ],
    [
      { action: "updateTask", input: { taskId: first.id, work: "조사 1" } },
      { action: "updateTask", input: { taskId: first.id, status: "in_progress" } },
    ],
    [
      { action: "completeTask", input: { taskId: first.id } },
      { action: "updateTask", input: { taskId: first.id, status: "todo" } },
      { action: "completeTask", input: { taskId: first.id } },
    ],
  ];
  for (const changes of repeated) {
    assert.throws(
      () =>
        ledger.resolveOpenItem(user, {
          openItemId: item.id,
          answer: "답",
          changes: changes as never,
        }),
      rejectsWith("duplicate_change"),
      JSON.stringify(changes),
    );
  }
  assert.deepEqual(ledger.getRequest(requestId), before);

  // 같은 요청에 서로 다른 쓰기, 서로 다른 작업에 같은 쓰기는 함께 저장된다.
  ledger.resolveOpenItem(user, {
    openItemId: item.id,
    answer: "답",
    changes: [
      { action: "updateRequest", input: { requestId, title: "고친 제목" } },
      { action: "setPriority", input: { requestId, urgency: "high" } },
      { action: "updateTask", input: { taskId: first.id, status: "in_progress" } },
      { action: "updateTask", input: { taskId: second.id, status: "in_progress" } },
      { action: "completeTask", input: { taskId: first.id } },
    ],
  });
  const request = ledger.getRequest(requestId);
  assert.deepEqual(
    [request.title.value, request.urgency.value, request.tasks.map((task) => task.status)],
    ["고친 제목", "high", ["done", "in_progress"]],
  );
  // 한 쓰기 안에서 대상과 쓰기 이름이 같은 변경 이력은 하나뿐이다.
  const written = request.changes.filter(
    (change) => change.writeSeq === request.changes.at(-1)?.writeSeq,
  );
  assert.equal(
    new Set(written.map((change) => `${change.action} ${change.target.id}`)).size,
    written.length,
  );
  assert.equal(written.length, 6);
});

test("S24: 답하면서 함께 바꿀 수 있는 것은 그 확인할 사항이 달린 요청과 그 요청의 작업뿐이다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const other = ledger.createRequest(triage, { decided: { title: "다른 요청" } });
  const elsewhere = ledger.addTask(triage, { requestId: other.id, work: "다른 요청의 작업" });
  const item = ledger.raiseOpenItem(triage, { requestId, kind: "question", content: "질문" });
  const before = [ledger.getRequest(requestId), ledger.getRequest(other.id)];

  const outside: unknown[] = [
    { action: "updateRequest", input: { requestId: other.id, title: "다른 요청의 제목" } },
    { action: "setPriority", input: { requestId: other.id, urgency: "high" } },
    { action: "updateTask", input: { taskId: elsewhere.id, status: "in_progress" } },
    { action: "completeTask", input: { taskId: elsewhere.id } },
    { action: "cancelTask", input: { taskId: elsewhere.id } },
  ];
  for (const change of outside) {
    assert.throws(
      () =>
        ledger.resolveOpenItem(user, {
          openItemId: item.id,
          answer: "답",
          // 이 요청의 값 변경과 함께 넣어도 전체가 거부된다.
          changes: [
            { action: "setPriority", input: { requestId, urgency: "low" } },
            change,
          ] as never,
        }),
      rejectsWith("change_outside_request"),
      JSON.stringify(change),
    );
  }
  assert.deepEqual([ledger.getRequest(requestId), ledger.getRequest(other.id)], before);
});
