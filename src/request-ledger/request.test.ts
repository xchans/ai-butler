// 작업 4(요청과 값)의 완료 조건을 확인한다. S2, S15(목록을 뺀 부분), S27.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  at,
  csTeam,
  jiwon,
  minsu,
  openFileLedger,
  openTestLedger,
  rejectsWith,
  stored,
  triage,
  user,
  userViaSkill,
} from "./test-support.ts";

test("S2: 사용자가 정한 긴급도는 비서가 다른 값으로 바꿀 수 없고 값은 그대로다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, {
    decided: { title: "환불 문의 원인 조사", urgency: "low" },
  });
  clock.set("10:00");
  ledger.setPriority(user, { requestId: id, urgency: "high" });
  const seqBefore = ledger.changesSince(0).length;

  clock.set("11:00");
  assert.throws(
    () => ledger.setPriority(triage, { requestId: id, urgency: "medium" }),
    rejectsWith("user_set_protected", ["urgency"]),
  );

  assert.deepEqual(ledger.getRequest(id).urgency, {
    value: "high",
    setBy: "user",
    userSet: true,
    userSetAt: stored("10:00"),
  });
  assert.equal(ledger.changesSince(0).length, seqBefore);
});

test("S2: 사용자 지정을 풀면 값과 정한 주체는 그대로이고, 그 뒤 비서가 쓰면 반영되어 정한 주체가 비서가 된다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, { decided: { title: "배포 일정 확인" } });
  clock.set("10:00");
  ledger.setPriority(user, { requestId: id, urgency: "high" });

  clock.set("11:00");
  ledger.setPriority(user, { requestId: id, clearUserSet: ["urgency"] });
  assert.deepEqual(ledger.getRequest(id).urgency, {
    value: "high",
    setBy: "user",
    userSet: false,
    userSetAt: null,
  });

  clock.set("12:00");
  ledger.setPriority(triage, { requestId: id, urgency: "low" });
  assert.deepEqual(ledger.getRequest(id).urgency, {
    value: "low",
    setBy: "assistant",
    userSet: false,
    userSetAt: null,
  });
});

test("S2: 중요도와 요청자도 사용자 지정이 걸리면 비서가 바꿀 수 없고, 풀면 바꿀 수 있다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, { decided: { title: "VOC 회신" } });
  ledger.setPriority(user, { requestId: id, importance: "high" });
  ledger.updateRequest(user, { requestId: id, requester: jiwon });

  assert.throws(
    () => ledger.setPriority(triage, { requestId: id, importance: "low" }),
    rejectsWith("user_set_protected", ["importance"]),
  );
  assert.throws(
    () => ledger.updateRequest(triage, { requestId: id, requester: minsu }),
    rejectsWith("user_set_protected", ["requester"]),
  );
  // 근거를 달 수 있는 값이 아니므로 사유를 적어도 바뀌지 않는다.
  assert.throws(
    () =>
      ledger.updateRequest(triage, { requestId: id, requester: minsu, reason: "담당이 바뀌었다" }),
    rejectsWith("user_set_protected", ["requester"]),
  );
  assert.equal(ledger.getRequest(id).importance.value, "high");
  assert.deepEqual(ledger.getRequest(id).requester.value, jiwon);

  ledger.setPriority(user, { requestId: id, clearUserSet: ["importance"] });
  ledger.updateRequest(user, { requestId: id, clearUserSet: ["requester"] });
  assert.equal(ledger.getRequest(id).importance.setBy, "user");
  assert.equal(ledger.getRequest(id).requester.setBy, "user");

  ledger.setPriority(triage, { requestId: id, importance: "low" });
  ledger.updateRequest(triage, { requestId: id, requester: minsu });
  const request = ledger.getRequest(id);
  assert.deepEqual(
    [request.importance.value, request.importance.setBy, request.importance.userSet],
    ["low", "assistant", false],
  );
  assert.deepEqual(
    [request.requester.value, request.requester.setBy, request.requester.userSet],
    [minsu, "assistant", false],
  );
});

test("S2: 비서가 여러 값을 한 번에 쓸 때 하나가 사용자 지정이 걸린 긴급도이면 전체가 거부되고 오류에 긴급도가 나온다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, {
    decided: { title: "결제 오류 대응", importance: "low" },
  });
  ledger.setPriority(user, { requestId: id, urgency: "high" });
  const before = ledger.getRequest(id);
  const lastSeq = ledger.changesSince(0).at(-1)?.seq;

  assert.throws(
    () => ledger.setPriority(triage, { requestId: id, urgency: "low", importance: "high" }),
    rejectsWith("user_set_protected", ["urgency"]),
  );

  // 다른 값(중요도)과 변경 이력의 순번이 그대로다.
  assert.deepEqual(ledger.getRequest(id), before);
  assert.equal(ledger.changesSince(0).at(-1)?.seq, lastSeq);
  // 거부된 쓰기가 순번을 쓰지 않아 다음 쓰기의 순번이 바로 이어진다.
  ledger.setPriority(triage, { requestId: id, importance: "high" });
  assert.equal(ledger.changesSince(0).at(-1)?.seq, (lastSeq ?? 0) + 1);
});

test("S2: updateRequest로 여러 값을 쓸 때도 어긋난 값이 하나라도 있으면 전체가 거부되고 어긋난 값이 모두 나온다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id } = ledger.createRequest(user, {
    stated: { title: "사용자가 정한 제목", requester: jiwon },
  });
  const before = ledger.getRequest(id);

  assert.throws(
    () =>
      ledger.updateRequest(triage, {
        requestId: id,
        title: "비서가 고친 제목",
        requester: minsu,
        due: at("18:00"),
      }),
    rejectsWith("user_set_protected", ["title", "requester"]),
  );

  assert.deepEqual(ledger.getRequest(id), before);
});

test("S2: 비서가 사용자 지정이 걸린 값과 같은 값을 쓰면 거부하지 않고 그 값만 건너뛴다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, { decided: { title: "정산 자료 준비" } });
  clock.set("10:00");
  ledger.setPriority(user, { requestId: id, urgency: "high" });
  const seqBefore = ledger.changesSince(0).length;

  // 같은 값만 쓴 쓰기는 아무것도 바꾸지 않고 변경 이력도 없다.
  clock.set("11:00");
  ledger.setPriority(triage, { requestId: id, urgency: "high" });
  assert.equal(ledger.changesSince(0).length, seqBefore);
  assert.deepEqual(ledger.getRequest(id).urgency, {
    value: "high",
    setBy: "user",
    userSet: true,
    userSetAt: stored("10:00"),
  });

  // 여러 값을 한 번에 쓰는 쓰기가 이 때문에 통째로 거부되지 않는다. 다른 값은 반영된다.
  ledger.setPriority(triage, { requestId: id, urgency: "high", importance: "medium" });
  const request = ledger.getRequest(id);
  assert.deepEqual([request.urgency.setBy, request.importance.value], ["user", "medium"]);
  const last = ledger.changesSince(0).at(-1);
  assert.deepEqual(Object.keys(last?.after as object), ["importance"]);
});

test("S15: 제목 없이 등록하면 거부된다", (t) => {
  const { ledger } = openTestLedger(t);

  const withoutTitle: unknown[] = [
    {},
    { stated: {} },
    { decided: { urgency: "high" } },
    { stated: { title: "" } },
    { stated: { title: "   " } },
    { decided: { title: null } },
    { decided: { title: 3 } },
  ];
  for (const input of withoutTitle) {
    assert.throws(
      () => ledger.createRequest(user, input as never),
      rejectsWith("title_required"),
      JSON.stringify(input),
    );
  }
  assert.deepEqual(ledger.changesSince(0), []);

  const { id } = ledger.createRequest(user, { stated: { title: "제목이 있는 요청" } });
  assert.throws(
    () => ledger.updateRequest(user, { requestId: id, title: "  " }),
    rejectsWith("title_required"),
  );
  assert.throws(
    () => ledger.updateRequest(user, { requestId: id, title: null as never }),
    rejectsWith("title_required"),
  );
  assert.equal(ledger.getRequest(id).title.value, "제목이 있는 요청");
});

test("S15: 미정으로 등록한 요청은 값이 비어 있는 요청자와 약속한 결과를 나중에 채울 수 있다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, {
    decided: { title: "요청인지 아직 모르는 메시지" },
    undecided: true,
  });
  const empty = { value: null, setBy: null, userSet: false, userSetAt: null };
  let request = ledger.getRequest(id);
  assert.equal(request.undecided, true);
  assert.deepEqual(
    [request.requester, request.promise, request.due, request.urgency, request.importance],
    [empty, empty, empty, empty, empty],
  );

  ledger.updateRequest(triage, {
    requestId: id,
    requester: jiwon,
    promise: { work: "환불 지연 원인을 찾아 회신한다", notify: [jiwon, csTeam] },
  });

  request = ledger.getRequest(id);
  assert.deepEqual(request.requester.value, jiwon);
  assert.deepEqual(request.promise.value, {
    work: "환불 지연 원인을 찾아 회신한다",
    notify: [jiwon, csTeam],
  });
  assert.equal(request.promise.setBy, "assistant");
  // 값을 채워도 미정은 풀 때까지 남는다.
  assert.equal(request.undecided, true);
});

test("S15: 미정은 사용자나 비서가 풀 수 있고, 푼 뒤에는 다시 붙일 수 없다", (t) => {
  const { ledger } = openTestLedger(t);
  const byUser = ledger.createRequest(triage, { decided: { title: "미정 하나" }, undecided: true });
  const byAssistant = ledger.createRequest(triage, {
    decided: { title: "미정 둘" },
    undecided: true,
  });
  const decidedFromStart = ledger.createRequest(triage, { decided: { title: "처음부터 요청" } });

  ledger.updateRequest(user, { requestId: byUser.id, undecided: false });
  ledger.updateRequest(triage, { requestId: byAssistant.id, undecided: false });

  assert.equal(ledger.getRequest(byUser.id).undecided, false);
  assert.equal(ledger.getRequest(byAssistant.id).undecided, false);
  assert.deepEqual(
    ledger
      .getRequest(byUser.id)
      .changes.map((change) => [change.before, change.after])
      .at(-1),
    [{ undecided: true }, { undecided: false }],
  );
  // 미정은 등록할 때만 붙일 수 있다.
  for (const { id } of [byUser, byAssistant, decidedFromStart]) {
    for (const actor of [user, triage]) {
      assert.throws(
        () => ledger.updateRequest(actor, { requestId: id, undecided: true as never }),
        rejectsWith("undecided_only_at_creation"),
      );
    }
    assert.equal(ledger.getRequest(id).undecided, false);
  }
  // 이미 푼 미정을 다시 풀어도 아무것도 바뀌지 않고 변경 이력도 없다.
  const count = ledger.changesSince(0).length;
  ledger.updateRequest(user, { requestId: byUser.id, undecided: false });
  assert.equal(ledger.changesSince(0).length, count);
});

test("등록할 때 사용자가 명시한 값에만 사용자 지정이 걸리고, 비서가 정한 값은 정한 주체가 비서다", (t) => {
  const { ledger } = openTestLedger(t, "09:30");
  const { id, createdAt } = ledger.createRequest(userViaSkill, {
    stated: { requester: { kind: "user" }, due: "2026-03-06T18:00:00+09:00" },
    decided: { title: "분기 정산 자료 정리", urgency: "medium" },
  });

  const request = ledger.getRequest(id);
  assert.equal(createdAt, stored("09:30"));
  assert.equal(request.createdAt, stored("09:30"));
  assert.deepEqual(request.title, {
    value: "분기 정산 자료 정리",
    setBy: "assistant",
    userSet: false,
    userSetAt: null,
  });
  assert.deepEqual(request.requester, {
    value: { kind: "user" },
    setBy: "user",
    userSet: true,
    userSetAt: stored("09:30"),
  });
  assert.deepEqual(request.due, {
    value: "2026-03-06T09:00:00.000000Z",
    setBy: "user",
    userSet: true,
    userSetAt: stored("09:30"),
  });
  assert.deepEqual(request.urgency, {
    value: "medium",
    setBy: "assistant",
    userSet: false,
    userSetAt: null,
  });
});

test("비서의 쓰기는 사용자가 명시한 값을 넘길 수 없고, 같은 값이 양쪽에 있으면 거부된다", (t) => {
  const { ledger } = openTestLedger(t);

  assert.throws(
    () => ledger.createRequest(triage, { stated: { title: "비서가 사용자인 척 정한 제목" } }),
    rejectsWith("requires_user"),
  );
  assert.throws(
    () => ledger.createRequest(triage, { stated: {}, decided: { title: "비서가 정한 제목" } }),
    rejectsWith("requires_user"),
  );
  assert.throws(
    () =>
      ledger.createRequest(user, {
        stated: { title: "양쪽에 있는 제목" },
        decided: { title: "양쪽에 있는 제목" },
      }),
    rejectsWith("invalid_argument"),
  );
  assert.deepEqual(ledger.changesSince(0), []);
});

test("값을 비우면 정한 주체가 없어지고, 사용자가 비운 값에는 사용자 지정이 걸린다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, {
    decided: { title: "기한이 잘못 잡힌 요청", due: at("18:00"), urgency: "high" },
  });

  // 사용자 지정이 없는 값은 비서가 비울 수 있다.
  ledger.setPriority(triage, { requestId: id, urgency: null });
  assert.deepEqual(ledger.getRequest(id).urgency, {
    value: null,
    setBy: null,
    userSet: false,
    userSetAt: null,
  });

  clock.set("10:00");
  ledger.updateRequest(user, { requestId: id, due: null });
  assert.deepEqual(ledger.getRequest(id).due, {
    value: null,
    setBy: null,
    userSet: true,
    userSetAt: stored("10:00"),
  });
  // 사용자가 비운 값을 비서가 근거 없이 다시 채울 수 없다.
  assert.throws(
    () => ledger.updateRequest(triage, { requestId: id, due: at("20:00") }),
    rejectsWith("user_set_protected", ["due"]),
  );
  // 사용자 지정이 걸린 값을 비서가 조건 없이 비울 수도 없다.
  ledger.setPriority(user, { requestId: id, importance: "high" });
  assert.throws(
    () => ledger.setPriority(triage, { requestId: id, importance: null }),
    rejectsWith("user_set_protected", ["importance"]),
  );
  // 등록할 때 사용자가 비워 둔다고 명시한 값도 사용자 지정이 걸린다.
  const other = ledger.createRequest(user, { stated: { title: "기한 없는 요청", due: null } });
  assert.deepEqual(ledger.getRequest(other.id).due, {
    value: null,
    setBy: null,
    userSet: true,
    userSetAt: stored("10:00"),
  });
});

test("S27: 값, 정한 주체, 사용자 지정이 모두 그대로인 쓰기는 변경 이력을 남기지 않는다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, {
    decided: { title: "주간 보고 초안", urgency: "medium", requester: minsu },
  });
  const count = ledger.changesSince(0).length;

  // 비서가 자기가 정한 값과 같은 값을 다시 쓴다.
  ledger.setPriority(triage, { requestId: id, urgency: "medium" });
  ledger.updateRequest(triage, { requestId: id, title: "주간 보고 초안", requester: minsu });
  // 걸려 있지 않은 사용자 지정을 푼다.
  ledger.setPriority(user, { requestId: id, clearUserSet: ["urgency", "importance"] });
  ledger.updateRequest(user, { requestId: id, clearUserSet: ["title"] });
  // 아무 값도 쓰지 않는다.
  ledger.updateRequest(triage, { requestId: id });

  assert.equal(ledger.changesSince(0).length, count);
});

test("S27: 비서가 정한 값과 같은 값을 사용자가 쓰거나 사용자 지정만 풀어도 한 건이 남는다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, {
    decided: { title: "주간 보고 초안", urgency: "medium" },
  });

  clock.set("10:00");
  ledger.setPriority(user, { requestId: id, urgency: "medium" });
  clock.set("11:00");
  ledger.setPriority(user, { requestId: id, clearUserSet: ["urgency"] });

  const [, sameValue, cleared] = ledger.changesSince(0);
  assert.deepEqual(
    [sameValue?.before, sameValue?.after],
    [
      { urgency: { value: "medium", setBy: "assistant", userSetAt: null } },
      { urgency: { value: "medium", setBy: "user", userSetAt: stored("10:00") } },
    ],
  );
  assert.deepEqual(
    [cleared?.before, cleared?.after],
    [
      { urgency: { value: "medium", setBy: "user", userSetAt: stored("10:00") } },
      { urgency: { value: "medium", setBy: "user", userSetAt: null } },
    ],
  );
  assert.equal(ledger.changesSince(0).length, 3);
});

test("S27: 사용자가 자기가 정한 값과 같은 값을 다시 써도 걸린 시각이 그때로 바뀌고 한 건이 남는다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, { decided: { title: "계약서 검토" } });
  clock.set("10:00");
  ledger.updateRequest(user, { requestId: id, due: at("18:00") });

  clock.set("12:00");
  ledger.updateRequest(user, { requestId: id, due: at("18:00") });

  assert.deepEqual(ledger.getRequest(id).due, {
    value: stored("18:00"),
    setBy: "user",
    userSet: true,
    userSetAt: stored("12:00"),
  });
  const last = ledger.changesSince(0).at(-1);
  assert.deepEqual(
    [last?.before, last?.after],
    [
      {
        due: {
          value: stored("18:00"),
          setBy: "user",
          userSetAt: stored("10:00"),
          evidenceAt: null,
        },
      },
      {
        due: {
          value: stored("18:00"),
          setBy: "user",
          userSetAt: stored("12:00"),
          evidenceAt: null,
        },
      },
    ],
  );
});

test("S27: 사용자가 밝힌 적용 범위가 변경 이력에서 조회되고, 밝히지 않은 긴급도 정정은 다음 유사 업무에도 적용할 것으로 나온다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, {
    decided: { title: "장애 보고서", urgency: "low", importance: "low" },
  });

  ledger.setPriority(user, { requestId: id, urgency: "high" });
  ledger.setPriority(user, { requestId: id, importance: "high", appliesTo: "this_request" });
  ledger.setPriority(user, { requestId: id, urgency: "medium", appliesTo: "similar_future" });

  assert.deepEqual(
    ledger.changesSince(0).map((change) => [change.action, change.actor.kind, change.appliesTo]),
    [
      // 비서의 쓰기에는 적용 범위가 없다.
      ["createRequest", "assistant", null],
      // 밝히지 않으면 기본값이고, 기본값임이 구분된다.
      ["setPriority", "user", { scope: "similar_future", stated: false }],
      ["setPriority", "user", { scope: "this_request", stated: true }],
      ["setPriority", "user", { scope: "similar_future", stated: true }],
    ],
  );
  // 비서의 쓰기에는 적용 범위를 밝힐 수 없다.
  assert.throws(
    () =>
      ledger.setPriority(triage, {
        requestId: id,
        importance: "medium",
        appliesTo: "this_request",
      }),
    rejectsWith("requires_user"),
  );
  assert.throws(
    () => ledger.setPriority(user, { requestId: id, urgency: "low", appliesTo: "all" as never }),
    rejectsWith("invalid_argument"),
  );
});

test("S27: 요청의 값을 쓰면 주체와 창구나 모듈, 이전 값과 새 값, 사유, 시각이 변경 이력에 남는다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, {
    decided: { title: "VOC 정리", requester: minsu, urgency: "low" },
  });

  clock.set("10:00");
  ledger.updateRequest(userViaSkill, {
    requestId: id,
    title: "3월 VOC 정리",
    requester: jiwon,
    reason: "요청한 사람이 다르다",
  });

  // 값 둘을 바꾼 쓰기는 한 건이고, 바뀐 항목만 들어간다.
  assert.deepEqual(ledger.changesSince(1), [
    {
      seq: 2,
      writeSeq: 2,
      at: stored("10:00"),
      actor: { kind: "user", via: "skill" },
      action: "updateRequest",
      target: { kind: "request", id },
      requestId: id,
      before: {
        title: { value: "VOC 정리", setBy: "assistant", userSetAt: null },
        requester: { value: minsu, setBy: "assistant", userSetAt: null },
      },
      after: {
        title: { value: "3월 VOC 정리", setBy: "user", userSetAt: stored("10:00") },
        requester: { value: jiwon, setBy: "user", userSetAt: stored("10:00") },
      },
      evidence: [],
      reason: "요청한 사람이 다르다",
      appliesTo: { scope: "similar_future", stated: false },
    },
  ]);
});

test("기한은 시간대가 붙은 시각만 받고 마이크로초 여섯 자리로 저장한다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, { decided: { title: "기한 형식 확인" } });

  for (const due of ["2026-03-06T18:00:00", "2026-03-06", "2026-03-06T18:00:00.1234567Z", 0]) {
    assert.throws(
      () => ledger.updateRequest(triage, { requestId: id, due: due as never }),
      rejectsWith("invalid_time"),
      String(due),
    );
  }
  assert.equal(ledger.getRequest(id).due.value, null);

  ledger.updateRequest(triage, { requestId: id, due: "2026-03-06T18:00:00.123456+09:00" });
  assert.equal(ledger.getRequest(id).due.value, "2026-03-06T09:00:00.123456Z");
  ledger.updateRequest(triage, { requestId: id, due: new Date("2026-03-07T00:00:00.500Z") });
  assert.equal(ledger.getRequest(id).due.value, "2026-03-07T00:00:00.500000Z");
});

test("형태가 틀린 값과 모르는 항목, 없는 요청은 거부되고 아무것도 남지 않는다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, { decided: { title: "형식 확인" } });
  const count = ledger.changesSince(0).length;

  assert.throws(
    () => ledger.setPriority(triage, { requestId: id, urgency: "urgent" as never }),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.updateRequest(triage, { requestId: id, requester: { kind: "person" } as never }),
    rejectsWith("invalid_party"),
  );
  assert.throws(
    () =>
      ledger.updateRequest(triage, {
        requestId: id,
        promise: {
          work: "회신한다",
          // 이름이 달라도 출처와 식별자가 같으면 같은 주체다.
          notify: [
            jiwon,
            { kind: "person", name: "지원", source: "slack", externalId: "U0000001" },
          ],
        },
      }),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.updateRequest(triage, { requestId: id, promise: { work: " " } }),
    rejectsWith("invalid_argument"),
  );
  // 긴급도와 중요도는 setPriority로만 쓴다. 모르는 항목은 조용히 버리지 않는다.
  assert.throws(
    () => ledger.updateRequest(triage, { requestId: id, urgency: "high" } as never),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.createRequest(triage, { decided: { title: "오타", priority: "high" } } as never),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.updateRequest(triage, { requestId: "req-none", title: "없는 요청" }),
    rejectsWith("request_not_found"),
  );
  assert.throws(() => ledger.getRequest("req-none"), rejectsWith("request_not_found"));
  // 사용자 지정은 사용자만 풀고, 값을 쓰면서 그 값의 사용자 지정을 풀 수는 없다.
  assert.throws(
    () => ledger.setPriority(triage, { requestId: id, clearUserSet: ["urgency"] }),
    rejectsWith("requires_user"),
  );
  assert.throws(
    () => ledger.setPriority(user, { requestId: id, urgency: "high", clearUserSet: ["urgency"] }),
    rejectsWith("invalid_argument"),
  );

  assert.equal(ledger.changesSince(0).length, count);
});

test("S2: 비서가 사용자 지정이 걸린 요청자와 같은 주체를 이름 표기만 다르게 쓰면 건너뛰고 표기도 바꾸지 않는다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  clock.set("10:00");
  ledger.updateRequest(user, { requestId: id, requester: jiwon });
  const renamed = { ...jiwon, name: "Jiwon Kim" };

  // 바꿀 수 있는 제목과 함께 써도 쓰기 전체가 거부되지 않는다. 제목만 반영된다.
  clock.set("11:00");
  ledger.updateRequest(triage, { requestId: id, requester: renamed, title: "3월 환불 지연 대응" });

  const request = ledger.getRequest(id);
  assert.equal(request.title.value, "3월 환불 지연 대응");
  assert.deepEqual(request.requester, {
    value: jiwon,
    setBy: "user",
    userSet: true,
    userSetAt: stored("10:00"),
  });
  assert.deepEqual(Object.keys(request.changes.at(-1)?.after as object), ["title"]);
  // 이름이 같아도 식별자가 없으면 다른 주체다. 다른 값을 쓰는 것이므로 거부된다.
  assert.throws(
    () =>
      ledger.updateRequest(triage, {
        requestId: id,
        requester: { kind: "person", name: "김지원" },
      }),
    rejectsWith("user_set_protected", ["requester"]),
  );

  // 사용자 지정을 풀면 표기가 바뀐 것을 변경으로 반영한다.
  ledger.updateRequest(user, { requestId: id, clearUserSet: ["requester"] });
  ledger.updateRequest(triage, { requestId: id, requester: renamed });
  assert.deepEqual(
    [ledger.getRequest(id).requester.value, ledger.getRequest(id).requester.setBy],
    [renamed, "assistant"],
  );
});

test("S8: 결과를 알릴 사람들도 같은 주체인지로 가리고, 해 주기로 한 일은 따로 비교한다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  clock.set("10:00");
  ledger.updateRequest(user, {
    requestId: id,
    promise: { work: "원인을 찾아 회신한다", notify: [jiwon, csTeam] },
  });
  const renamed = { ...jiwon, name: "Jiwon Kim" };
  const count = ledger.changesSince(0).length;

  // 같은 사람들을 표기와 순서만 다르게 쓴 것은 같은 값이다. 건너뛰고 아무것도 바꾸지 않는다.
  ledger.updateRequest(triage, {
    requestId: id,
    promise: { work: "원인을 찾아 회신한다", notify: [csTeam, renamed] },
  });
  assert.equal(ledger.changesSince(0).length, count);
  assert.deepEqual(ledger.getRequest(id).promise.value, {
    work: "원인을 찾아 회신한다",
    notify: [jiwon, csTeam],
  });

  // 해 주기로 한 일이 다르거나 알릴 사람이 다르면 다른 값이다.
  for (const promise of [
    { work: "원인을 찾아 회신하고 재처리한다", notify: [jiwon, csTeam] },
    { work: "원인을 찾아 회신한다", notify: [jiwon] },
    { work: "원인을 찾아 회신한다", notify: [jiwon, minsu] },
    { work: "원인을 찾아 회신한다", notify: [jiwon, csTeam, minsu] },
  ]) {
    assert.throws(
      () => ledger.updateRequest(triage, { requestId: id, promise }),
      rejectsWith("user_set_protected", ["promise"]),
      JSON.stringify(promise),
    );
  }
});

test("S27: 비서가 결과를 알릴 사람들을 순서만 바꿔 다시 쓰면 저장하지 않고 변경 이력도 남기지 않는다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  // 사용자 지정이 없는 값이다. 비서는 조건 없이 쓸 수 있다.
  const { id } = ledger.createRequest(triage, {
    decided: {
      title: "환불 지연 대응",
      promise: { work: "원인을 찾아 회신한다", notify: [jiwon, csTeam, minsu] },
    },
  });
  const count = ledger.changesSince(0).length;
  const notify = () => ledger.getRequest(id).promise.value?.notify;

  // 사람들이 같고 순서만 다르다. 해 주기로 한 일, 정한 주체, 근거 시각도 그대로다.
  ledger.updateRequest(triage, {
    requestId: id,
    promise: { work: "원인을 찾아 회신한다", notify: [minsu, jiwon, csTeam] },
  });
  assert.equal(ledger.changesSince(0).length, count);
  assert.deepEqual(notify(), [jiwon, csTeam, minsu]);

  // 순서와 함께 이름 표기가 바뀌면 표기만 반영된다. 순서는 그대로다.
  const renamed = { ...jiwon, name: "Jiwon Kim" };
  clock.set("10:00");
  ledger.updateRequest(triage, {
    requestId: id,
    promise: { work: "원인을 찾아 회신한다", notify: [csTeam, minsu, renamed] },
  });
  assert.deepEqual(notify(), [renamed, csTeam, minsu]);
  assert.equal(ledger.changesSince(0).length, count + 1);

  // 순서와 함께 해 주기로 한 일이 바뀌면 일만 반영된다.
  ledger.updateRequest(triage, {
    requestId: id,
    promise: { work: "원인을 찾아 회신하고 재처리한다", notify: [minsu, csTeam, renamed] },
  });
  assert.deepEqual(ledger.getRequest(id).promise.value, {
    work: "원인을 찾아 회신하고 재처리한다",
    notify: [renamed, csTeam, minsu],
  });
  assert.equal(ledger.changesSince(0).length, count + 2);

  // 사람이 달라지면 쓴 순서대로 저장한다.
  ledger.updateRequest(triage, {
    requestId: id,
    promise: { work: "원인을 찾아 회신하고 재처리한다", notify: [minsu, csTeam] },
  });
  assert.deepEqual(notify(), [minsu, csTeam]);
  assert.equal(ledger.changesSince(0).length, count + 3);
});

test("S27: 사용자가 알릴 사람들을 다시 쓰면 순서만 달라도 다시 정한 것이고, 그 뒤 비서의 순서만 바꾼 쓰기는 건너뛴다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, {
    decided: { title: "환불 지연 대응", promise: { work: "회신한다", notify: [jiwon, csTeam] } },
  });
  const jira = (hhmm: string) => ({
    kind: "revision" as const,
    revisionId: ledger.addRevision(triage, {
      source: "jira",
      sourceId: "VOC-9",
      originalAt: at(hhmm),
      body: `${hhmm}의 티켓`,
    }).revisionId,
  });

  // 사용자의 다시 쓰기는 지금 규칙대로다. 사용자가 쓴 순서로 저장되고 사용자 지정이 걸린다.
  clock.set("10:00");
  ledger.updateRequest(user, {
    requestId: id,
    promise: { work: "회신한다", notify: [csTeam, jiwon] },
  });
  assert.deepEqual(ledger.getRequest(id).promise, {
    value: { work: "회신한다", notify: [csTeam, jiwon] },
    setBy: "user",
    userSet: true,
    userSetAt: stored("10:00"),
  });
  const count = ledger.changesSince(0).length;

  // 조건을 채우지 못한 비서의 순서만 바꾼 쓰기는 건너뛴다.
  ledger.updateRequest(triage, {
    requestId: id,
    promise: { work: "회신한다", notify: [jiwon, csTeam] },
  });
  assert.equal(ledger.changesSince(0).length, count);

  // 나중 판본을 달아 조건을 채우면 정한 주체와 근거 시각은 고쳐지지만, 순서는 바꾸지 않는다.
  clock.set("12:00");
  const later = jira("11:00");
  ledger.updateRequest(triage, {
    requestId: id,
    promise: { work: "회신한다", notify: [jiwon, csTeam] },
    evidence: [later],
  });
  const change = ledger.changesSince(0).at(-1);
  assert.deepEqual(
    [change?.before, change?.after],
    [
      {
        promise: {
          value: { work: "회신한다", notify: [csTeam, jiwon] },
          setBy: "user",
          userSetAt: stored("10:00"),
          evidenceAt: null,
        },
      },
      {
        promise: {
          value: { work: "회신한다", notify: [csTeam, jiwon] },
          setBy: "assistant",
          userSetAt: stored("10:00"),
          evidenceAt: stored("11:00"),
        },
      },
    ],
  );
  // 같은 근거로 순서만 바꿔 한 번 더 쓰면 모두 그대로다.
  const after = ledger.changesSince(0).length;
  ledger.updateRequest(triage, {
    requestId: id,
    promise: { work: "회신한다", notify: [csTeam, jiwon] },
    evidence: [later],
  });
  ledger.updateRequest(triage, {
    requestId: id,
    promise: { work: "회신한다", notify: [jiwon, csTeam] },
    evidence: [later],
  });
  assert.equal(ledger.changesSince(0).length, after);
});

test("빈 자리가 있는 배열은 모든 자리를 검사해 거부한다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const task = ledger.addTask(triage, { requestId: id, work: "조사" });
  const count = ledger.changesSince(0).length;
  // 길이는 1이지만 값이 없는 배열. map은 이 자리를 건너뛴다.
  const sparse = new Array(1) as never;
  const withGap = [jiwon, undefined, csTeam] as never;

  assert.throws(
    () =>
      ledger.createRequest(triage, {
        decided: { title: "W", promise: { work: "W", notify: sparse } },
      }),
    rejectsWith("invalid_party"),
  );
  assert.throws(
    () => ledger.updateRequest(triage, { requestId: id, promise: { work: "W", notify: withGap } }),
    rejectsWith("invalid_party"),
  );
  assert.throws(
    () => ledger.createRequest(triage, { decided: { title: "W" }, intake: sparse }),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.updateRequest(user, { requestId: id, clearUserSet: sparse }),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.updateRequest(triage, { requestId: id, title: "W", evidence: sparse }),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.updateTask(triage, { taskId: task.id, dependsOn: sparse }),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () =>
      ledger.raiseOpenItem(triage, {
        requestId: id,
        kind: "question",
        content: "Q",
        options: sparse,
      }),
    rejectsWith("invalid_argument"),
  );

  assert.equal(ledger.changesSince(0).length, count);
  assert.deepEqual(ledger.getRequest(id).promise.value, null);
});

test("해 주기로 한 일이 바뀐 쓰기 순번은 처음 정할 때, 바꿀 때, 비웠다가 다시 정할 때 그 쓰기의 순번이 된다", (t) => {
  const { ledger, row } = openFileLedger(t);
  const workSeq = (requestId: string) =>
    row("SELECT promise_work_seq FROM requests WHERE id = ?", requestId).promise_work_seq;
  const lastWriteSeq = () => ledger.changesSince(0).at(-1)?.writeSeq;

  // 약속한 결과 없이 등록하면 비어 있다.
  const { id } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  assert.equal(workSeq(id), null);
  // 등록할 때 정하면 등록한 쓰기 순번이다.
  const withPromise = ledger.createRequest(triage, {
    decided: { title: "정산", promise: { work: "정산 자료를 정리한다" } },
  });
  assert.equal(workSeq(withPromise.id), 2);
  assert.equal(lastWriteSeq(), 2);

  // 처음 정할 때.
  ledger.updateRequest(triage, { requestId: id, promise: { work: "원인을 찾는다" } });
  assert.deepEqual([workSeq(id), lastWriteSeq()], [3, 3]);
  // 알릴 사람만 바뀌면 그대로다. 변경 이력은 남는다.
  ledger.updateRequest(triage, {
    requestId: id,
    promise: { work: "원인을 찾는다", notify: [jiwon] },
  });
  assert.deepEqual([workSeq(id), lastWriteSeq()], [3, 4]);
  // 다른 값을 쓰거나 같은 값을 다시 써도 그대로다.
  ledger.updateRequest(triage, { requestId: id, title: "환불 지연" });
  ledger.updateRequest(user, {
    requestId: id,
    promise: { work: "원인을 찾는다", notify: [jiwon] },
  });
  assert.deepEqual([workSeq(id), lastWriteSeq()], [3, 6]);
  // 해 주기로 한 일을 바꿀 때.
  ledger.updateRequest(user, { requestId: id, promise: { work: "원인을 찾아 회신한다" } });
  assert.deepEqual([workSeq(id), lastWriteSeq()], [7, 7]);
  // 비울 때와 다시 정할 때. 같은 일로 다시 정해도 바뀐 것이다.
  ledger.updateRequest(user, { requestId: id, promise: null });
  assert.deepEqual([workSeq(id), lastWriteSeq()], [8, 8]);
  ledger.updateRequest(user, { requestId: id, promise: { work: "원인을 찾아 회신한다" } });
  assert.deepEqual([workSeq(id), lastWriteSeq()], [9, 9]);

  // 답하면서 바꾸면 답과 같은 쓰기 순번이다. 그 쓰기의 첫 건은 답이다.
  const item = ledger.raiseOpenItem(triage, {
    requestId: id,
    kind: "question",
    content: "범위는?",
  });
  ledger.resolveOpenItem(user, {
    openItemId: item.id,
    answer: "재처리까지",
    changes: [
      { action: "setPriority", input: { requestId: id, urgency: "high" } },
      { action: "updateRequest", input: { requestId: id, promise: { work: "재처리까지 한다" } } },
    ],
  });
  const answered = ledger.changesSince(10);
  assert.deepEqual(
    answered.map((change) => [change.seq, change.writeSeq, change.action]),
    [
      [11, 11, "resolveOpenItem"],
      [12, 11, "setPriority"],
      [13, 11, "updateRequest"],
    ],
  );
  assert.equal(workSeq(id), 11);
  // 다른 요청의 순번은 건드리지 않는다.
  assert.equal(workSeq(withPromise.id), 2);
});

test("S27: 사유는 어느 쓰기에나 적을 수 있고 변경 이력에 남는다. 공백뿐인 사유는 없는 것이다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, {
    decided: { title: "환불 지연 대응" },
    reason: "슬랙 문의에서 접수",
  });
  const jira = ledger.addRevision(triage, {
    source: "jira",
    sourceId: "VOC-9",
    originalAt: at("08:00"),
    body: "티켓",
    reason: "사용자가 짚어 준 티켓",
  });
  ledger.linkRecord(triage, {
    recordId: jira.recordId,
    requestId: id,
    role: "progress",
    reason: "같은 문의의 티켓",
  });
  const item = ledger.raiseOpenItem(triage, {
    requestId: id,
    kind: "question",
    content: "급한가요?",
    reason: "기한이 적혀 있지 않다",
  });
  ledger.resolveOpenItem(user, {
    openItemId: item.id,
    answer: "급하다",
    reason: "오늘 보고가 있다",
  });
  const notice = ledger.addNotice(triage, {
    requestId: id,
    kind: "my_turn",
    content: "확인해 주세요",
    reason: "질문에 답이 필요하다",
  });
  ledger.markNoticeSeen(user, { noticeId: notice.id, reason: "   " });
  const material = ledger.attachMaterial(triage, {
    requestId: id,
    title: "정책",
    content: "7일",
    reason: "회신에 필요하다",
  });
  ledger.replaceMaterial(triage, { materialId: material.id, content: "14일", reason: "개정됐다" });
  ledger.setProgress(triage, {
    requestId: id,
    progress: "조사 중",
    reason: "티켓이 진행 중으로 바뀌었다",
  });
  ledger.setPriority(user, { requestId: id, urgency: "high", reason: "" });

  assert.deepEqual(
    ledger.changesSince(0).map((change) => [change.action, change.reason]),
    [
      ["createRequest", "슬랙 문의에서 접수"],
      ["addRevision", "사용자가 짚어 준 티켓"],
      ["linkRecord", "같은 문의의 티켓"],
      ["raiseOpenItem", "기한이 적혀 있지 않다"],
      ["resolveOpenItem", "오늘 보고가 있다"],
      ["addNotice", "질문에 답이 필요하다"],
      // 공백뿐인 사유는 없는 것으로 본다.
      ["markNoticeSeen", null],
      ["attachMaterial", "회신에 필요하다"],
      ["replaceMaterial", "개정됐다"],
      ["setProgress", "티켓이 진행 중으로 바뀌었다"],
      ["setPriority", null],
    ],
  );
  assert.throws(
    () => ledger.setProgress(triage, { requestId: id, progress: "회신 중", reason: 3 as never }),
    rejectsWith("invalid_argument"),
  );
});

test("근거는 값을 정하는 쓰기에만 단다. 기록 연결, 확인할 사항, 알릴 일, 준비 자료, 진척은 근거를 받지 않는다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const jira = ledger.addRevision(triage, {
    source: "jira",
    sourceId: "VOC-9",
    originalAt: at("08:00"),
    body: "티켓",
  });
  const evidence = [{ kind: "revision", revisionId: jira.revisionId }] as const;
  const item = ledger.raiseOpenItem(triage, { requestId: id, kind: "question", content: "질문" });
  const material = ledger.attachMaterial(triage, { requestId: id, title: "정책", content: "7일" });
  const count = ledger.changesSince(0).length;

  const withoutEvidence: (() => unknown)[] = [
    () =>
      ledger.linkRecord(triage, {
        recordId: jira.recordId,
        requestId: id,
        role: "progress",
        evidence,
      } as never),
    () =>
      ledger.raiseOpenItem(triage, {
        requestId: id,
        kind: "question",
        content: "Q",
        evidence,
      } as never),
    () => ledger.resolveOpenItem(user, { openItemId: item.id, answer: "답", evidence } as never),
    () =>
      ledger.addNotice(triage, {
        requestId: id,
        kind: "my_turn",
        content: "알림",
        evidence,
      } as never),
    () =>
      ledger.attachMaterial(triage, { requestId: id, title: "T", content: "C", evidence } as never),
    () =>
      ledger.replaceMaterial(triage, { materialId: material.id, content: "C", evidence } as never),
    () => ledger.setProgress(triage, { requestId: id, progress: "조사 중", evidence } as never),
  ];
  for (const write of withoutEvidence) {
    assert.throws(write, rejectsWith("invalid_argument"));
  }
  assert.equal(ledger.changesSince(0).length, count);

  // 값을 정하는 쓰기는 근거를 받는다.
  const created = ledger.createRequest(triage, { decided: { title: "정산" }, evidence });
  ledger.updateRequest(triage, { requestId: id, title: "환불 지연", evidence });
  ledger.setPriority(triage, { requestId: id, urgency: "high", evidence });
  const task = ledger.addTask(triage, { requestId: id, work: "조사", evidence });
  ledger.updateTask(triage, { taskId: task.id, status: "in_progress", evidence });
  ledger.completeTask(triage, { taskId: task.id, evidence });
  const other = ledger.addTask(triage, { requestId: created.id, work: "정리" });
  ledger.cancelTask(triage, { taskId: other.id, evidence, reason: "하지 않기로 했다" });
  assert.deepEqual(
    ledger
      .changesSince(count)
      .filter((change) => change.evidence.length > 0)
      .map((change) => change.action),
    [
      "createRequest",
      "updateRequest",
      "setPriority",
      "addTask",
      "updateTask",
      "completeTask",
      "cancelTask",
    ],
  );
});
