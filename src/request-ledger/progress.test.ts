// 작업 10 가운데 진척의 완료 조건을 확인한다. S41(목록을 뺀 부분).
import assert from "node:assert/strict";
import { test } from "node:test";
import { openTestLedger, rejectsWith, stored, triage, user, userViaSkill } from "./test-support.ts";

const coordination = { kind: "assistant", module: "coordination" } as const;

test("S41: 진척은 비서가 쓰고 요청 조회에 나오며, 바뀐 내역이 변경 이력에 남는다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  assert.equal(ledger.getRequest(requestId).progress, null);

  clock.set("10:00");
  ledger.setProgress(coordination, { requestId, progress: "원인 조사 중" });
  clock.set("11:00");
  ledger.setProgress(coordination, { requestId, progress: "원인 확인, 재처리 대기" });

  assert.equal(ledger.getRequest(requestId).progress, "원인 확인, 재처리 대기");
  assert.deepEqual(
    ledger
      .getRequest(requestId)
      .changes.filter((change) => change.action === "setProgress")
      .map(({ at, actor, target, before, after, appliesTo }) => ({
        at,
        actor,
        target,
        before,
        after,
        appliesTo,
      })),
    [
      {
        at: stored("10:00"),
        actor: coordination,
        target: { kind: "request", id: requestId },
        before: { progress: null },
        after: { progress: "원인 조사 중" },
        appliesTo: null,
      },
      {
        at: stored("11:00"),
        actor: coordination,
        target: { kind: "request", id: requestId },
        before: { progress: "원인 조사 중" },
        after: { progress: "원인 확인, 재처리 대기" },
        appliesTo: null,
      },
    ],
  );
});

test("S41: 사용자가 진척을 쓰려 하면 거부된다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  ledger.setProgress(coordination, { requestId, progress: "원인 조사 중" });
  const count = ledger.changesSince(0).length;

  for (const actor of [user, userViaSkill]) {
    assert.throws(
      () => ledger.setProgress(actor, { requestId, progress: "사용자가 쓴 진척" }),
      rejectsWith("requires_assistant"),
    );
  }

  assert.equal(ledger.getRequest(requestId).progress, "원인 조사 중");
  assert.equal(ledger.changesSince(0).length, count);
});

test("진척이 그대로이면 변경 이력을 남기지 않고, null로 비울 수 있다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  ledger.setProgress(coordination, { requestId, progress: "원인 조사 중" });
  const count = ledger.changesSince(0).length;

  ledger.setProgress(coordination, { requestId, progress: "원인 조사 중" });
  assert.equal(ledger.changesSince(0).length, count);

  ledger.setProgress(coordination, { requestId, progress: null });
  assert.equal(ledger.getRequest(requestId).progress, null);
  assert.equal(ledger.changesSince(0).length, count + 1);

  assert.throws(
    () => ledger.setProgress(coordination, { requestId, progress: " " }),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.setProgress(coordination, { requestId } as never),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.setProgress(coordination, { requestId: "request-none", progress: "진척" }),
    rejectsWith("request_not_found"),
  );
  // 진척에는 사용자 지정을 두지 않는다. 비서가 언제든 다시 쓴다.
  ledger.setProgress(triage, { requestId, progress: "다른 모듈이 쓴 진척" });
  assert.equal(ledger.getRequest(requestId).progress, "다른 모듈이 쓴 진척");
});
