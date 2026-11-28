// 작업 10 가운데 알릴 일의 완료 조건을 확인한다. S25, S41의 알릴 일 부분.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openTestLedger, rejectsWith, stored, triage, user, verifier } from "./test-support.ts";

const screen = { kind: "assistant", module: "worklist-ui" } as const;

test("S25: 알릴 일은 전하지 않은 것, 전했지만 보지 않은 것, 본 것으로 구분해 조회되고 대상과 내용이 나온다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const task = ledger.addTask(triage, { requestId, work: "요청자에게 회신" });
  const question = ledger.raiseOpenItem(triage, {
    requestId,
    taskId: task.id,
    kind: "question",
    content: "회신에 보상 안내를 넣을까요?",
  });

  clock.set("10:00");
  const fresh = ledger.addNotice(triage, {
    requestId,
    kind: "new_request",
    content: "새 요청: 환불 지연 대응",
  });
  const turn = ledger.addNotice(triage, {
    requestId,
    taskId: task.id,
    kind: "my_turn",
    content: "회신할 차례입니다",
  });
  const ask = ledger.addNotice(triage, {
    requestId,
    taskId: task.id,
    openItemId: question.id,
    kind: "open_item",
    content: "확인이 필요합니다: 보상 안내",
  });
  clock.set("10:05");
  ledger.markNoticeDelivered(screen, { noticeId: turn.id });
  ledger.markNoticeDelivered(screen, { noticeId: ask.id });
  clock.set("10:20");
  ledger.markNoticeSeen(user, { noticeId: ask.id });

  const expected = [
    {
      id: fresh.id,
      requestId,
      taskId: null,
      openItemId: null,
      kind: "new_request",
      content: "새 요청: 환불 지연 대응",
      createdAt: stored("10:00"),
      deliveredAt: null,
      seenAt: null,
      state: "undelivered",
    },
    {
      id: turn.id,
      requestId,
      taskId: task.id,
      openItemId: null,
      kind: "my_turn",
      content: "회신할 차례입니다",
      createdAt: stored("10:00"),
      deliveredAt: stored("10:05"),
      seenAt: null,
      state: "unseen",
    },
    {
      id: ask.id,
      requestId,
      taskId: task.id,
      openItemId: question.id,
      kind: "open_item",
      content: "확인이 필요합니다: 보상 안내",
      createdAt: stored("10:00"),
      deliveredAt: stored("10:05"),
      seenAt: stored("10:20"),
      state: "seen",
    },
  ];
  assert.deepEqual(ledger.listNotices(), expected);
  // 아직 전하지 않은 것과, 전했지만 사용자가 보지 않은 것을 따로 조회할 수 있다.
  assert.deepEqual(ledger.listNotices({ state: "undelivered" }), [expected[0]]);
  assert.deepEqual(ledger.listNotices({ state: "unseen" }), [expected[1]]);
  assert.deepEqual(ledger.listNotices({ state: "seen" }), [expected[2]]);
});

test("S25: 알릴 일마다 어느 요청에 대한 것인지 조회되고, 요청으로 거를 수 있다", (t) => {
  const { ledger } = openTestLedger(t);
  const first = ledger.createRequest(triage, { decided: { title: "첫째 요청" } });
  const second = ledger.createRequest(triage, { decided: { title: "둘째 요청" } });
  ledger.addNotice(triage, { requestId: first.id, kind: "new_request", content: "첫째" });
  ledger.addNotice(triage, { requestId: second.id, kind: "new_request", content: "둘째" });
  ledger.addNotice(triage, { requestId: first.id, kind: "closed", content: "첫째가 닫혔습니다" });

  assert.deepEqual(
    ledger.listNotices().map((notice) => [notice.requestId, notice.content]),
    [
      [first.id, "첫째"],
      [second.id, "둘째"],
      [first.id, "첫째가 닫혔습니다"],
    ],
  );
  assert.deepEqual(
    ledger.listNotices({ requestId: first.id }).map((notice) => notice.content),
    ["첫째", "첫째가 닫혔습니다"],
  );
  assert.deepEqual(ledger.listNotices({ requestId: second.id, state: "seen" }), []);
  assert.throws(
    () => ledger.listNotices({ state: "read" as never }),
    rejectsWith("invalid_argument"),
  );
});

test("S41: 알릴 일의 종류로 확인된 결과를 남기고 조회할 수 있다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const task = ledger.addTask(triage, { requestId, work: "원인 조사" });

  const result = ledger.addNotice(verifier, {
    requestId,
    taskId: task.id,
    kind: "verified_result",
    content: "원인 조사가 끝났습니다. 정산 배치가 사흘 밀렸습니다",
  });

  assert.deepEqual(
    ledger.listNotices().map((notice) => [notice.id, notice.kind, notice.taskId, notice.content]),
    [
      [
        result.id,
        "verified_result",
        task.id,
        "원인 조사가 끝났습니다. 정산 배치가 사흘 밀렸습니다",
      ],
    ],
  );
  // 다섯 종류를 모두 남길 수 있고, 그 밖의 종류는 거부된다.
  for (const kind of [
    "new_request",
    "my_turn",
    "open_item",
    "verified_result",
    "closed",
  ] as const) {
    ledger.addNotice(triage, { requestId, kind, content: `${kind} 알림` });
  }
  assert.throws(
    () => ledger.addNotice(triage, { requestId, kind: "reminder" as never, content: "알림" }),
    rejectsWith("invalid_argument"),
  );
  assert.equal(ledger.listNotices().length, 6);
});

test("알릴 일을 봤다는 표시는 사용자만 하고, 전하지 않은 것을 보면 전한 시각도 같은 시각으로 채워진다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const notice = ledger.addNotice(triage, { requestId, kind: "my_turn", content: "차례입니다" });

  assert.throws(
    () => ledger.markNoticeSeen(screen as never, { noticeId: notice.id }),
    rejectsWith("requires_user"),
  );
  assert.equal(ledger.listNotices()[0]?.state, "undelivered");

  // 사용자가 화면에서 먼저 본 경우다.
  clock.set("10:30");
  ledger.markNoticeSeen(user, { noticeId: notice.id });

  const [seen] = ledger.listNotices();
  assert.deepEqual(
    [seen?.state, seen?.deliveredAt, seen?.seenAt],
    ["seen", stored("10:30"), stored("10:30")],
  );
  assert.deepEqual(ledger.listNotices({ state: "undelivered" }), []);
  const last = ledger.changesSince(0).at(-1);
  assert.deepEqual(
    [last?.action, last?.target, last?.requestId, last?.before, last?.after, last?.appliesTo],
    [
      "markNoticeSeen",
      { kind: "notice", id: notice.id },
      requestId,
      { seenAt: null, deliveredAt: null },
      { seenAt: stored("10:30"), deliveredAt: stored("10:30") },
      // 봤다는 표시는 일어난 일을 알린 것이므로, 밝히지 않으면 이 요청에만 해당한다.
      { scope: "this_request", stated: false },
    ],
  );
});

test("이미 전했거나 본 것에 다시 표시하면 아무것도 바꾸지 않고 처음 시각이 남는다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const notice = ledger.addNotice(triage, { requestId, kind: "my_turn", content: "차례입니다" });
  clock.set("10:00");
  ledger.markNoticeDelivered(screen, { noticeId: notice.id });
  clock.set("10:10");
  ledger.markNoticeSeen(user, { noticeId: notice.id });
  const count = ledger.changesSince(0).length;

  clock.set("11:00");
  ledger.markNoticeDelivered(screen, { noticeId: notice.id });
  ledger.markNoticeDelivered(user, { noticeId: notice.id });
  ledger.markNoticeSeen(user, { noticeId: notice.id });

  const [marked] = ledger.listNotices();
  assert.deepEqual([marked?.deliveredAt, marked?.seenAt], [stored("10:00"), stored("10:10")]);
  assert.equal(ledger.changesSince(0).length, count);
});

test("알릴 일의 대상은 그 요청에 속해야 하고, 작업과 확인할 사항을 둘 다 가리키면 그 작업에 달린 것이어야 한다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const other = ledger.createRequest(triage, { decided: { title: "다른 요청" } });
  const task = ledger.addTask(triage, { requestId, work: "회신" });
  const otherTask = ledger.addTask(triage, { requestId, work: "조사" });
  const elsewhere = ledger.addTask(triage, { requestId: other.id, work: "다른 요청의 작업" });
  const onTask = ledger.raiseOpenItem(triage, {
    requestId,
    taskId: task.id,
    kind: "question",
    content: "회신 작업에 달린 질문",
  });
  const onRequest = ledger.raiseOpenItem(triage, {
    requestId,
    kind: "question",
    content: "요청에 달린 질문",
  });
  const otherItem = ledger.raiseOpenItem(triage, {
    requestId: other.id,
    kind: "question",
    content: "다른 요청의 질문",
  });
  const notice = { requestId, kind: "open_item", content: "확인이 필요합니다" } as const;

  assert.throws(
    () => ledger.addNotice(triage, { ...notice, taskId: elsewhere.id }),
    rejectsWith("task_not_in_request"),
  );
  assert.throws(
    () => ledger.addNotice(triage, { ...notice, openItemId: otherItem.id }),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.addNotice(triage, { ...notice, taskId: otherTask.id, openItemId: onTask.id }),
    rejectsWith("open_item_not_on_task"),
  );
  assert.throws(
    () => ledger.addNotice(triage, { ...notice, taskId: task.id, openItemId: onRequest.id }),
    rejectsWith("open_item_not_on_task"),
  );
  assert.throws(
    () => ledger.addNotice(triage, { ...notice, openItemId: "item-none" }),
    rejectsWith("open_item_not_found"),
  );
  assert.throws(
    () => ledger.addNotice(triage, { ...notice, requestId: "request-none" }),
    rejectsWith("request_not_found"),
  );
  assert.throws(
    () => ledger.addNotice(triage, { ...notice, content: " " }),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.markNoticeDelivered(screen, { noticeId: "notice-none" }),
    rejectsWith("notice_not_found"),
  );
  assert.deepEqual(ledger.listNotices(), []);

  // 확인할 사항만 가리키거나, 그 확인할 사항이 달린 작업과 함께 가리킬 수 있다.
  ledger.addNotice(triage, { ...notice, openItemId: onTask.id });
  ledger.addNotice(triage, { ...notice, taskId: task.id, openItemId: onTask.id });
  ledger.addNotice(triage, { ...notice, openItemId: onRequest.id });
  assert.equal(ledger.listNotices().length, 3);
  // 알릴 일을 남긴 것은 요청의 변경 이력에 나온다.
  const added = ledger.getRequest(requestId).changes.at(-1);
  assert.deepEqual([added?.action, added?.target.kind], ["addNotice", "notice"]);
});
