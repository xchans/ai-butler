// 작업 5(요청 조회의 틀)의 완료 조건을 확인한다. S2의 조회 부분, S27.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openLedger } from "./index.ts";
import {
  at,
  jiwon,
  makeTempDir,
  openTestLedger,
  stored,
  triage,
  user,
  verifier,
} from "./test-support.ts";

const connector = { kind: "assistant", module: "channel-connectors" } as const;

test("S2: 요청 조회에 값마다 정한 주체, 사용자 지정이 걸려 있는지와 걸린 시각이 나온다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, {
    decided: {
      title: "환불 지연 문의 대응",
      requester: jiwon,
      promise: { work: "원인을 찾아 회신한다", notify: [jiwon] },
      urgency: "medium",
    },
  });
  clock.set("10:00");
  ledger.setPriority(user, { requestId: id, urgency: "high" });
  clock.set("11:00");
  ledger.updateRequest(user, { requestId: id, due: at("18:00") });

  const request = ledger.getRequest(id);

  assert.equal(request.id, id);
  assert.equal(request.createdAt, stored("09:00"));
  assert.equal(request.undecided, false);
  assert.equal(request.progress, null);
  assert.equal(request.order, null);
  const byAssistant = { setBy: "assistant", userSet: false, userSetAt: null };
  assert.deepEqual(request.title, { value: "환불 지연 문의 대응", ...byAssistant });
  assert.deepEqual(request.requester, { value: jiwon, ...byAssistant });
  assert.deepEqual(request.promise, {
    value: { work: "원인을 찾아 회신한다", notify: [jiwon] },
    ...byAssistant,
  });
  assert.deepEqual(request.urgency, {
    value: "high",
    setBy: "user",
    userSet: true,
    userSetAt: stored("10:00"),
  });
  assert.deepEqual(request.due, {
    value: stored("18:00"),
    setBy: "user",
    userSet: true,
    userSetAt: stored("11:00"),
  });
  // 정해지지 않은 값은 비어 있고 정한 주체가 없다.
  assert.deepEqual(request.importance, {
    value: null,
    setBy: null,
    userSet: false,
    userSetAt: null,
  });
  // 아직 딸린 것이 없는 요청이다.
  assert.deepEqual(
    [
      request.tasks,
      request.links,
      request.records,
      request.openItems,
      request.materials,
      request.evidenceRevisions,
      request.holds,
      request.turn,
    ],
    [[], [], [], [], [], [], [], []],
  );
  // 작업이 없는 열린 요청은 접수이고 다음 작업 미정이다.
  assert.deepEqual(
    [request.state, request.myTurn, request.nextTaskUndecided],
    ["open", false, true],
  );
});

test("S27: 비서가 정한 값을 사용자가 고치면 비서가 정했던 값과 사용자가 고친 값이 변경 이력 한 건에 함께 나온다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, {
    decided: { title: "환불 지연 문의 대응", urgency: "low" },
  });
  const other = ledger.createRequest(triage, { decided: { title: "다른 요청" } });
  clock.set("10:00");
  ledger.setPriority(user, { requestId: other.id, urgency: "low" });

  clock.set("11:00");
  ledger.setPriority(user, { requestId: id, urgency: "high" });

  // 요청 조회의 변경 이력에는 그 요청의 것만 순번 순서로 나온다.
  const { changes } = ledger.getRequest(id);
  assert.deepEqual(
    changes.map((change) => [change.seq, change.action, change.requestId]),
    [
      [1, "createRequest", id],
      [4, "setPriority", id],
    ],
  );
  const corrected = changes.at(-1);
  assert.deepEqual(corrected?.actor, { kind: "user", via: "web" });
  assert.deepEqual(corrected?.before, {
    urgency: { value: "low", setBy: "assistant", userSetAt: null },
  });
  assert.deepEqual(corrected?.after, {
    urgency: { value: "high", setBy: "user", userSetAt: stored("11:00") },
  });
  assert.deepEqual(corrected?.appliesTo, { scope: "similar_future", stated: false });
});

test("요청에 연결하지 않은 기록의 판본을 근거로 달았어도 요청 조회에 그 판본의 내용이 나온다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, {
    decided: { title: "환불 지연 문의 대응", due: at("18:00") },
  });
  const { id: taskId } = ledger.addTask(triage, { requestId: id, work: "원인 조사" });
  const thread = ledger.addRevision(connector, {
    source: "slack",
    sourceId: "C01/1700000000.000200",
    originalAt: at("09:30"),
    body: "내일 오전까지로 미뤄도 됩니다",
    url: "https://slack.example.test/archives/C01/p1700000000000200",
    author: jiwon,
  });
  const ticket = ledger.addRevision(connector, {
    source: "jira",
    sourceId: "VOC-301",
    originalAt: at("09:40"),
    body: "원인: 정산 배치 지연",
  });
  const threadRef = { kind: "revision", revisionId: thread.revisionId } as const;
  const ticketRef = { kind: "revision", revisionId: ticket.revisionId } as const;

  // 두 기록 모두 요청에 연결하지 않고 근거로만 단다.
  clock.set("10:00");
  ledger.updateRequest(triage, { requestId: id, due: at("23:00"), evidence: [threadRef] });
  ledger.completeTask(verifier, { taskId, evidence: [ticketRef, threadRef] });

  const request = ledger.getRequest(id);
  assert.deepEqual([request.links, request.records], [[], []]);
  // 변경 이력의 근거는 식별자 그대로다.
  assert.deepEqual(
    request.changes.slice(-2).map((change) => change.evidence),
    [[threadRef], [ticketRef, threadRef]],
  );
  // 그 식별자의 판본이 내용과 함께, 처음 근거로 달린 순서로 한 번씩 나온다.
  assert.deepEqual(request.evidenceRevisions, [
    {
      id: thread.revisionId,
      recordId: thread.recordId,
      source: "slack",
      sourceId: "C01/1700000000.000200",
      originalAt: stored("09:30"),
      body: "내일 오전까지로 미뤄도 됩니다",
      url: "https://slack.example.test/archives/C01/p1700000000000200",
      author: jiwon,
      fetchedAt: stored("09:00"),
    },
    {
      id: ticket.revisionId,
      recordId: ticket.recordId,
      source: "jira",
      sourceId: "VOC-301",
      originalAt: stored("09:40"),
      body: "원인: 정산 배치 지연",
      url: null,
      author: null,
      fetchedAt: stored("09:00"),
    },
  ]);
  // 다른 요청의 조회에는 나오지 않는다.
  const other = ledger.createRequest(triage, { decided: { title: "다른 요청" } });
  assert.deepEqual(ledger.getRequest(other.id).evidenceRevisions, []);
});

test("요청 조회 한 번은 한 시점의 값과 변경 이력을 돌려준다. 조회하는 사이에 다른 연결이 커밋해도 섞이지 않는다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const reader = openLedger({ path });
  const writer = openLedger({ path });
  t.after(() => {
    reader.close();
    writer.close();
  });
  const { id } = reader.createRequest(triage, { decided: { title: "조회하기 전의 제목" } });
  reader.addTask(triage, { requestId: id, work: "조회하기 전의 작업" });

  // 요청의 값을 읽은 뒤 연결을 읽으려는 순간에, 다른 연결이 제목을 바꾸고 작업을 더해 커밋한다.
  const prepare = DatabaseSync.prototype.prepare;
  let interleaved = 0;
  t.after(() => {
    DatabaseSync.prototype.prepare = prepare;
  });
  DatabaseSync.prototype.prepare = function (sql, ...rest) {
    if (interleaved === 0 && sql.includes("FROM links WHERE request_id")) {
      interleaved += 1;
      writer.updateRequest(user, { requestId: id, title: "조회하는 사이에 바뀐 제목" });
      writer.addTask(triage, { requestId: id, work: "조회하는 사이에 더한 작업" });
    }
    return prepare.call(this, sql, ...rest);
  };
  const during = reader.getRequest(id);
  DatabaseSync.prototype.prepare = prepare;

  // 조회하는 사이에 실제로 다른 연결의 커밋이 끼어들었다.
  assert.equal(interleaved, 1);
  assert.equal(writer.changesSince(0).length, 4);
  // 값, 작업, 변경 이력이 모두 조회를 시작한 시점의 것이다.
  assert.equal(during.title.value, "조회하기 전의 제목");
  assert.deepEqual(
    during.tasks.map((task) => task.work),
    ["조회하기 전의 작업"],
  );
  assert.deepEqual(
    during.changes.map((change) => [change.seq, change.action]),
    [
      [1, "createRequest"],
      [2, "addTask"],
    ],
  );

  // 다음 조회에는 바뀐 값과 그 변경 이력이 함께 나온다.
  const after = reader.getRequest(id);
  assert.equal(after.title.value, "조회하는 사이에 바뀐 제목");
  assert.deepEqual(
    after.tasks.map((task) => task.work),
    ["조회하기 전의 작업", "조회하는 사이에 더한 작업"],
  );
  assert.deepEqual(
    after.changes.map((change) => change.seq),
    [1, 2, 3, 4],
  );
});

test("요청 조회가 오류로 끝나도 읽기 트랜잭션이 남지 않아 이어서 쓸 수 있다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, { decided: { title: "조회 뒤에 쓰는 요청" } });

  assert.throws(() => ledger.getRequest("request-none"));
  ledger.getRequest(id);
  ledger.updateRequest(triage, { requestId: id, title: "조회 뒤에 고친 제목" });

  assert.equal(ledger.getRequest(id).title.value, "조회 뒤에 고친 제목");
});
