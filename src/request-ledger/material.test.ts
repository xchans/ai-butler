// 작업 10 가운데 준비 자료의 완료 조건을 확인한다. S26.
import assert from "node:assert/strict";
import { test } from "node:test";
import { at, openTestLedger, rejectsWith, stored, triage, user } from "./test-support.ts";

const prep = { kind: "assistant", module: "preparation" } as const;

test("S26: 준비 자료를 바꾸면 요청 조회에 새 내용과 확인한 시각이 나오고, 이전 내용은 변경 이력에 남는다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const task = ledger.addTask(triage, { requestId, work: "원인 조사" });

  clock.set("10:00");
  const material = ledger.attachMaterial(prep, {
    requestId,
    taskId: task.id,
    title: "정산 배치 현황",
    content: "3월 1일 배치가 실패했다",
    source: "운영 대시보드",
  });
  assert.deepEqual(ledger.getRequest(requestId).materials, [
    {
      id: material.id,
      taskId: task.id,
      title: "정산 배치 현황",
      content: "3월 1일 배치가 실패했다",
      source: "운영 대시보드",
      checkedAt: stored("10:00"),
    },
  ]);

  clock.set("14:00");
  ledger.replaceMaterial(prep, {
    materialId: material.id,
    content: "3월 1일과 2일 배치가 실패했고 3일에 복구됐다",
  });

  // 새 내용과 확인한 시각이 나온다. 적지 않은 제목과 출처는 그대로다.
  assert.deepEqual(ledger.getRequest(requestId).materials, [
    {
      id: material.id,
      taskId: task.id,
      title: "정산 배치 현황",
      content: "3월 1일과 2일 배치가 실패했고 3일에 복구됐다",
      source: "운영 대시보드",
      checkedAt: stored("14:00"),
    },
  ]);
  // 이전 내용은 변경 이력에 그대로 남는다. 바뀐 항목만 적고, 그대로인 제목과 출처는 적지 않는다.
  const replaced = ledger.getRequest(requestId).changes.at(-1);
  assert.deepEqual(
    [replaced?.action, replaced?.target, replaced?.requestId],
    ["replaceMaterial", { kind: "material", id: material.id }, requestId],
  );
  assert.deepEqual(replaced?.before, {
    content: "3월 1일 배치가 실패했다",
    checkedAt: stored("10:00"),
  });
  assert.deepEqual(replaced?.after, {
    content: "3월 1일과 2일 배치가 실패했고 3일에 복구됐다",
    checkedAt: stored("14:00"),
  });
});

test("S26: 준비 자료의 변경 이력에는 바뀐 항목만 이전 값과 새 값으로 남는다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const material = ledger.attachMaterial(prep, {
    requestId,
    title: "환불 정책",
    content: "결제 후 7일 안에는 전액 환불",
    source: "사내 위키",
    checkedAt: at("08:00"),
  });
  const last = () => {
    const change = ledger.getRequest(requestId).changes.at(-1);
    return [change?.before, change?.after];
  };

  // 내용만 바뀐 경우. 확인한 시각은 같은 값을 넘겼다.
  ledger.replaceMaterial(prep, {
    materialId: material.id,
    content: "결제 후 14일 안에는 전액 환불",
    checkedAt: at("08:00"),
  });
  assert.deepEqual(last(), [
    { content: "결제 후 7일 안에는 전액 환불" },
    { content: "결제 후 14일 안에는 전액 환불" },
  ]);

  // 확인한 시각만 바뀐 경우. 내용은 같다.
  clock.set("15:00");
  ledger.replaceMaterial(prep, {
    materialId: material.id,
    content: "결제 후 14일 안에는 전액 환불",
  });
  assert.deepEqual(last(), [{ checkedAt: stored("08:00") }, { checkedAt: stored("15:00") }]);

  // 제목과 출처만 바뀐 경우.
  ledger.replaceMaterial(prep, {
    materialId: material.id,
    title: "환불 정책 (3월 개정)",
    content: "결제 후 14일 안에는 전액 환불",
    source: null,
    checkedAt: at("15:00"),
  });
  assert.deepEqual(last(), [
    { title: "환불 정책", source: "사내 위키" },
    { title: "환불 정책 (3월 개정)", source: null },
  ]);
  // 조회에는 바뀌지 않은 항목도 그대로 나온다.
  assert.deepEqual(ledger.getRequest(requestId).materials[0], {
    id: material.id,
    taskId: null,
    title: "환불 정책 (3월 개정)",
    content: "결제 후 14일 안에는 전액 환불",
    source: null,
    checkedAt: stored("15:00"),
  });
});

test("S26: 내용이 같아도 다시 확인했으면 확인한 시각이 바뀌고, 확인한 시각을 따로 넘길 수 있다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const material = ledger.attachMaterial(user, {
    requestId,
    title: "환불 정책",
    content: "결제 후 7일 안에는 전액 환불",
    checkedAt: at("08:00"),
  });
  assert.deepEqual(ledger.getRequest(requestId).materials[0], {
    id: material.id,
    taskId: null,
    title: "환불 정책",
    content: "결제 후 7일 안에는 전액 환불",
    source: null,
    checkedAt: stored("08:00"),
  });

  clock.set("15:00");
  ledger.replaceMaterial(prep, {
    materialId: material.id,
    content: "결제 후 7일 안에는 전액 환불",
  });
  assert.equal(ledger.getRequest(requestId).materials[0]?.checkedAt, stored("15:00"));

  ledger.replaceMaterial(prep, {
    materialId: material.id,
    title: "환불 정책 (3월 개정)",
    content: "결제 후 14일 안에는 전액 환불",
    source: "사내 위키",
    checkedAt: "2026-03-02T23:30:00+09:00",
  });
  assert.deepEqual(ledger.getRequest(requestId).materials[0], {
    id: material.id,
    taskId: null,
    title: "환불 정책 (3월 개정)",
    content: "결제 후 14일 안에는 전액 환불",
    source: "사내 위키",
    checkedAt: stored("14:30"),
  });

  // 모두 그대로이면 변경 이력을 남기지 않는다.
  const count = ledger.changesSince(0).length;
  ledger.replaceMaterial(prep, {
    materialId: material.id,
    content: "결제 후 14일 안에는 전액 환불",
    checkedAt: at("14:30"),
  });
  assert.equal(ledger.changesSince(0).length, count);
  // 출처는 null로 비울 수 있다.
  ledger.replaceMaterial(prep, {
    materialId: material.id,
    content: "결제 후 14일 안에는 전액 환불",
    source: null,
    checkedAt: at("14:30"),
  });
  assert.equal(ledger.getRequest(requestId).materials[0]?.source, null);
});

test("준비 자료의 대상은 그 요청에 속해야 하고, 형태가 틀리면 거부된다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id: requestId } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const other = ledger.createRequest(triage, { decided: { title: "다른 요청" } });
  const elsewhere = ledger.addTask(triage, { requestId: other.id, work: "다른 요청의 작업" });
  const valid = { requestId, title: "자료", content: "내용" };

  assert.throws(
    () => ledger.attachMaterial(prep, { ...valid, taskId: elsewhere.id }),
    rejectsWith("task_not_in_request"),
  );
  assert.throws(
    () => ledger.attachMaterial(prep, { ...valid, requestId: "request-none" }),
    rejectsWith("request_not_found"),
  );
  assert.throws(
    () => ledger.attachMaterial(prep, { ...valid, title: "" }),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.attachMaterial(prep, { ...valid, content: undefined as never }),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.attachMaterial(prep, { ...valid, checkedAt: "2026-03-02T10:00:00" }),
    rejectsWith("invalid_time"),
  );
  assert.throws(
    () => ledger.replaceMaterial(prep, { materialId: "material-none", content: "내용" }),
    rejectsWith("material_not_found"),
  );
  assert.deepEqual(ledger.getRequest(requestId).materials, []);

  const material = ledger.attachMaterial(prep, valid);
  assert.throws(
    () => ledger.replaceMaterial(prep, { materialId: material.id, content: "" }),
    rejectsWith("invalid_argument"),
  );
  assert.equal(ledger.getRequest(requestId).materials[0]?.content, "내용");
});
