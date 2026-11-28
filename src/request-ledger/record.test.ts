// 작업 6(주체, 기록, 판본, 연결)의 완료 조건을 확인한다. S10(완료 근거를 뺀 부분), S31(닫힘, 보류 풀기, 다시 열기를 뺀 부분).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  at,
  jiwon,
  openTestLedger,
  rejectsWith,
  stored,
  triage,
  user,
  userViaSkill,
} from "./test-support.ts";

const connector = { kind: "assistant", module: "channel-connectors" } as const;

test("S10: 원본 시각이 같은 판본을 두 번 넣으면 판본은 하나이고, 본문이 다르면 거부된다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const revision = {
    source: "jira",
    sourceId: "VOC-101",
    originalAt: at("09:10"),
    body: "환불이 사흘째 처리되지 않는다는 문의",
    url: "https://jira.example.test/browse/VOC-101",
    author: jiwon,
  };

  const first = ledger.addRevision(connector, revision);
  const count = ledger.changesSince(0).length;
  clock.set("10:00");
  const again = ledger.addRevision(connector, revision);

  assert.equal(first.added, true);
  // 있던 판본을 그대로 돌려주고 아무것도 바꾸지 않는다.
  assert.deepEqual(again, { ...first, added: false });
  assert.equal(ledger.changesSince(0).length, count);

  assert.throws(
    () => ledger.addRevision(connector, { ...revision, body: "같은 시각인데 본문이 다르다" }),
    rejectsWith("revision_conflict"),
  );
  assert.equal(ledger.changesSince(0).length, count);

  const { id } = ledger.createRequest(triage, {
    decided: { title: "환불 지연 문의" },
    intake: [first.recordId],
  });
  const [record] = ledger.getRequest(id).records;
  assert.equal(record?.revisions.length, 1);
  // 다시 읽어 와도 처음 읽어 온 시각이 남는다.
  assert.equal(record?.revisions[0]?.fetchedAt, stored("09:00"));
});

test("S10: 본문이 A, B, 다시 A로 바뀌면 판본은 셋이고, 요청 조회에 판본들이 본문과 함께 나온다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const add = (hhmm: string, body: string) =>
    ledger.addRevision(connector, {
      source: "slack",
      sourceId: "C01/1700000000.000100",
      originalAt: at(hhmm),
      body,
      url: "https://slack.example.test/archives/C01/p1700000000000100",
      author: jiwon,
      fetchedAt: at("12:00"),
    });

  clock.set("12:05");
  const a = add("09:00", "A안으로 진행해 주세요");
  const b = add("10:00", "B안으로 바꿔 주세요");
  // 원본 시각이 다르면 본문이 같아도 새 판본이다.
  const backToA = add("11:00", "A안으로 진행해 주세요");
  const { id } = ledger.createRequest(triage, {
    decided: { title: "진행안 확정" },
    intake: [a.recordId],
  });

  assert.equal(new Set([a.recordId, b.recordId, backToA.recordId]).size, 1);
  assert.deepEqual([a.added, b.added, backToA.added], [true, true, true]);
  const request = ledger.getRequest(id);
  assert.deepEqual(request.records, [
    {
      id: a.recordId,
      source: "slack",
      sourceId: "C01/1700000000.000100",
      revisions: [
        [a.revisionId, "09:00", "A안으로 진행해 주세요"],
        [b.revisionId, "10:00", "B안으로 바꿔 주세요"],
        [backToA.revisionId, "11:00", "A안으로 진행해 주세요"],
      ].map(([revisionId, hhmm, body]) => ({
        id: revisionId,
        recordId: a.recordId,
        originalAt: stored(hhmm as string),
        body,
        url: "https://slack.example.test/archives/C01/p1700000000000100",
        author: jiwon,
        fetchedAt: stored("12:00"),
      })),
    },
  ]);
});

test("S10: 판본은 늦게 읽어 와도 원본 시각 순서로 나오고, 출처와 출처 안의 id가 같으면 같은 기록이다", (t) => {
  const { ledger } = openTestLedger(t);
  const later = ledger.addRevision(connector, {
    source: "jira",
    sourceId: "VOC-7",
    originalAt: at("11:00"),
    body: "나중 내용",
  });
  const earlier = ledger.addRevision(connector, {
    source: "jira",
    sourceId: "VOC-7",
    originalAt: at("10:00"),
    body: "먼저 내용",
  });
  const otherSource = ledger.addRevision(connector, {
    source: "slack",
    sourceId: "VOC-7",
    originalAt: at("10:00"),
    body: "출처가 다른 기록",
  });
  const { id } = ledger.createRequest(triage, {
    decided: { title: "VOC-7" },
    intake: [later.recordId, otherSource.recordId],
  });

  assert.equal(earlier.recordId, later.recordId);
  assert.notEqual(otherSource.recordId, later.recordId);
  const [jira, slack] = ledger.getRequest(id).records;
  assert.deepEqual(
    jira?.revisions.map((revision) => revision.body),
    ["먼저 내용", "나중 내용"],
  );
  assert.deepEqual(
    slack?.revisions.map((revision) => [revision.body, revision.url, revision.author]),
    [["출처가 다른 기록", null, null]],
  );
});

test("판본을 더하면 변경 이력에 기록과 판본의 식별자가 남고 본문은 옮겨 적지 않는다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const first = ledger.addRevision(connector, {
    source: "jira",
    sourceId: "VOC-9",
    originalAt: at("08:00"),
    body: "처음 본문",
  });
  clock.set("10:00");
  const second = ledger.addRevision(connector, {
    source: "jira",
    sourceId: "VOC-9",
    originalAt: at("09:30"),
    body: "바뀐 본문",
  });

  const changes = ledger.changesSince(0);
  assert.deepEqual(
    changes.map(({ action, target, requestId, before, after }) => ({
      action,
      target,
      requestId,
      before,
      after,
    })),
    [
      {
        action: "addRevision",
        target: { kind: "record", id: first.recordId },
        // 기록은 요청에 속하지 않는다.
        requestId: null,
        before: null,
        after: {
          source: "jira",
          sourceId: "VOC-9",
          revision: {
            id: first.revisionId,
            originalAt: stored("08:00"),
            fetchedAt: stored("09:00"),
          },
        },
      },
      {
        action: "addRevision",
        target: { kind: "record", id: first.recordId },
        requestId: null,
        before: { revision: null },
        after: {
          revision: {
            id: second.revisionId,
            originalAt: stored("09:30"),
            fetchedAt: stored("10:00"),
          },
        },
      },
    ],
  );
  assert.doesNotMatch(JSON.stringify(changes), /본문/);
});

test("판본의 시각과 형태가 틀리면 거부된다", (t) => {
  const { ledger } = openTestLedger(t);
  const valid = { source: "jira", sourceId: "VOC-1", originalAt: at("09:00"), body: "본문" };

  assert.throws(
    () => ledger.addRevision(connector, { ...valid, originalAt: "2026-03-02T09:00:00" }),
    rejectsWith("invalid_time"),
  );
  assert.throws(
    () => ledger.addRevision(connector, { ...valid, originalAt: "2026-03-02T09:00:00.0000001Z" }),
    rejectsWith("invalid_time"),
  );
  assert.throws(
    () => ledger.addRevision(connector, { ...valid, fetchedAt: "어제" }),
    rejectsWith("invalid_time"),
  );
  assert.throws(
    () => ledger.addRevision(connector, { ...valid, source: "" }),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.addRevision(connector, { ...valid, body: undefined as never }),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.addRevision(connector, { ...valid, author: { kind: "person" } as never }),
    rejectsWith("invalid_party"),
  );
  assert.deepEqual(ledger.changesSince(0), []);
});

test("S31: 직접 맡긴 요청을 등록하면 맡기면서 한 말이 접수 원본으로 조회된다", (t) => {
  const { ledger, clock } = openTestLedger(t, "14:05");
  const said = {
    source: "conversation",
    sourceId: "skill-session-12/turn-3",
    originalAt: at("14:00"),
    body: "금요일 6시까지 분기 정산 자료 좀 정리해 줘",
  };

  const spoken = ledger.addRevision(userViaSkill, said);
  const { id } = ledger.createRequest(userViaSkill, {
    stated: { requester: { kind: "user" }, due: "2026-03-06T18:00:00+09:00" },
    decided: { title: "분기 정산 자료 정리" },
    intake: [spoken.recordId],
  });
  // 같은 id로 다시 접수해도 기록은 하나다.
  clock.set("14:30");
  const again = ledger.addRevision(userViaSkill, said);

  assert.deepEqual(again, { ...spoken, added: false });
  const request = ledger.getRequest(id);
  assert.deepEqual(request.links, [
    {
      id: request.links[0]?.id,
      recordId: spoken.recordId,
      taskId: null,
      role: "intake",
      userSet: true,
    },
  ]);
  // 본문, 출처 conversation, 작성자, 말한 시각이 그대로 나오고 주소는 없다.
  assert.deepEqual(request.records, [
    {
      id: spoken.recordId,
      source: "conversation",
      sourceId: "skill-session-12/turn-3",
      revisions: [
        {
          id: spoken.revisionId,
          recordId: spoken.recordId,
          originalAt: stored("14:00"),
          body: "금요일 6시까지 분기 정산 자료 좀 정리해 줘",
          url: null,
          author: { kind: "user" },
          fetchedAt: stored("14:05"),
        },
      ],
    },
  ]);
  // 제목은 정한 주체가 비서이고 사용자 지정이 없으며, 요청자(사용자)와 명시한 기한은 사용자 지정이 걸려 있다.
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
    userSetAt: stored("14:05"),
  });
  assert.deepEqual(request.due, {
    value: "2026-03-06T09:00:00.000000Z",
    setBy: "user",
    userSet: true,
    userSetAt: stored("14:05"),
  });
});

test("S31: 제목 없이 직접 맡긴 요청을 등록하면 거부되고 연결도 남지 않는다", (t) => {
  const { ledger } = openTestLedger(t);
  const spoken = ledger.addRevision(userViaSkill, {
    source: "conversation",
    sourceId: "turn-1",
    originalAt: at("09:00"),
    body: "이것 좀 봐 줘",
  });
  const count = ledger.changesSince(0).length;

  assert.throws(
    () =>
      ledger.createRequest(userViaSkill, {
        stated: { requester: { kind: "user" } },
        intake: [spoken.recordId],
      }),
    rejectsWith("title_required"),
  );
  assert.throws(
    () =>
      ledger.createRequest(userViaSkill, {
        decided: { title: "없는 기록을 접수 원본으로 든 요청" },
        intake: ["record-none"],
      }),
    rejectsWith("record_not_found"),
  );

  assert.equal(ledger.changesSince(0).length, count);
});

test("S31: 직접 맡긴 말의 작성자는 사용자이고 주소가 없다", (t) => {
  const { ledger } = openTestLedger(t);
  const said = {
    source: "conversation",
    sourceId: "turn-2",
    originalAt: at("09:00"),
    body: "배포 일정 확인해 줘",
  };

  assert.throws(
    () => ledger.addRevision(userViaSkill, { ...said, url: "https://example.test/turn-2" }),
    rejectsWith("invalid_argument"),
  );
  assert.throws(
    () => ledger.addRevision(userViaSkill, { ...said, author: jiwon }),
    rejectsWith("invalid_argument"),
  );
  assert.deepEqual(ledger.changesSince(0), []);
});

test("S31: 직접 맡긴 말은 접수 원본으로만 연결하고, 이미 있는 요청에 일을 더 맡긴 말도 접수 원본으로 연결한다", (t) => {
  const { ledger } = openTestLedger(t);
  const speak = (sourceId: string, body: string) =>
    ledger.addRevision(userViaSkill, {
      source: "conversation",
      sourceId,
      originalAt: at("09:00"),
      body,
    });
  const first = speak("turn-1", "배포 일정 확인해 줘");
  const { id } = ledger.createRequest(userViaSkill, {
    decided: { title: "배포 일정 확인" },
    intake: [first.recordId],
  });
  const more = speak("turn-7", "담당자한테 공유까지 해 줘");

  for (const role of ["progress", "completion_evidence", "delivery"] as const) {
    assert.throws(
      () => ledger.linkRecord(userViaSkill, { recordId: more.recordId, requestId: id, role }),
      rejectsWith("conversation_record_intake_only"),
      role,
    );
  }
  ledger.linkRecord(userViaSkill, { recordId: more.recordId, requestId: id, role: "intake" });

  const request = ledger.getRequest(id);
  assert.deepEqual(
    request.links.map((link) => [link.recordId, link.role]),
    [
      [first.recordId, "intake"],
      [more.recordId, "intake"],
    ],
  );
  assert.deepEqual(
    request.records.map((record) => record.revisions[0]?.body),
    ["배포 일정 확인해 줘", "담당자한테 공유까지 해 줘"],
  );
});

test("S31: 직접 맡긴 말을 값 변경의 근거로 달면 원본 시각이 아무리 늦어도 거부된다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, {
    decided: { title: "계약서 검토", due: at("18:00") },
  });
  clock.set("10:00");
  ledger.updateRequest(user, { requestId: id, due: at("20:00") });
  const spoken = ledger.addRevision(userViaSkill, {
    source: "conversation",
    sourceId: "turn-9",
    originalAt: "2026-03-03T09:00:00Z",
    body: "기한은 수요일로 미뤄도 돼",
  });
  const evidence = [{ kind: "revision", revisionId: spoken.revisionId }] as const;
  const count = ledger.changesSince(0).length;

  for (const actor of [triage, user]) {
    assert.throws(
      () => ledger.updateRequest(actor, { requestId: id, due: at("22:00"), evidence }),
      rejectsWith("evidence_not_allowed"),
    );
    assert.throws(
      () => ledger.setPriority(actor, { requestId: id, urgency: "high", evidence }),
      rejectsWith("evidence_not_allowed"),
    );
  }
  assert.throws(
    () =>
      ledger.updateRequest(triage, {
        requestId: id,
        due: at("22:00"),
        evidence: [{ kind: "revision", revisionId: "revision-none" }],
      }),
    rejectsWith("evidence_not_found"),
  );

  assert.equal(ledger.getRequest(id).due.value, stored("20:00"));
  assert.equal(ledger.changesSince(0).length, count);
});

test("등록하면서 함께 연결한 접수 원본은 같은 쓰기이고, 요청의 변경 이력에 함께 나온다", (t) => {
  const { ledger } = openTestLedger(t);
  const slack = ledger.addRevision(connector, {
    source: "slack",
    sourceId: "C01/1",
    originalAt: at("08:00"),
    body: "환불이 안 됩니다",
  });
  const jira = ledger.addRevision(connector, {
    source: "jira",
    sourceId: "VOC-55",
    originalAt: at("08:30"),
    body: "환불 지연",
  });

  const { id } = ledger.createRequest(triage, {
    decided: { title: "환불 지연 대응" },
    intake: [slack.recordId, jira.recordId],
  });

  const request = ledger.getRequest(id);
  // 비서가 만든 연결은 사용자가 정한 연결이 아니다.
  assert.deepEqual(
    request.links.map((link) => [link.recordId, link.role, link.userSet]),
    [
      [slack.recordId, "intake", false],
      [jira.recordId, "intake", false],
    ],
  );
  // 쓰기 하나가 대상마다 한 건을 남기고, 쓰기 순번이 같다.
  assert.deepEqual(
    request.changes.map((change) => [
      change.seq,
      change.writeSeq,
      change.action,
      change.target.kind,
    ]),
    [
      [3, 3, "createRequest", "request"],
      [4, 3, "createRequest", "link"],
      [5, 3, "createRequest", "link"],
    ],
  );
  assert.deepEqual(request.changes[1]?.after, {
    recordId: slack.recordId,
    requestId: id,
    taskId: null,
    role: "intake",
    userSet: false,
  });
  assert.throws(
    () =>
      ledger.createRequest(triage, {
        decided: { title: "같은 기록을 두 번 든 요청" },
        intake: [slack.recordId, slack.recordId],
      }),
    rejectsWith("invalid_argument"),
  );
});

test("기록을 요청에 역할과 함께 연결하고, 사용자가 만든 연결은 사용자가 정한 것으로 표시한다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const other = ledger.createRequest(triage, { decided: { title: "다른 요청" } });
  const jira = ledger.addRevision(connector, {
    source: "jira",
    sourceId: "VOC-55",
    originalAt: at("08:30"),
    body: "환불 지연",
  });

  const byAssistant = ledger.linkRecord(triage, {
    recordId: jira.recordId,
    requestId: id,
    role: "progress",
  });
  const byUser = ledger.linkRecord(user, {
    recordId: jira.recordId,
    requestId: id,
    role: "delivery",
  });
  // 한 기록이 여러 요청에 연결될 수 있다.
  ledger.linkRecord(triage, { recordId: jira.recordId, requestId: other.id, role: "intake" });

  assert.deepEqual([byAssistant.added, byUser.added], [true, true]);
  assert.deepEqual(ledger.getRequest(id).links, [
    { id: byAssistant.id, recordId: jira.recordId, taskId: null, role: "progress", userSet: false },
    { id: byUser.id, recordId: jira.recordId, taskId: null, role: "delivery", userSet: true },
  ]);
  // 같은 기록이 두 역할로 연결돼 있어도 기록은 한 번 나온다.
  assert.equal(ledger.getRequest(id).records.length, 1);
  assert.equal(ledger.getRequest(other.id).links.length, 1);

  assert.throws(
    () => ledger.linkRecord(triage, { recordId: "record-none", requestId: id, role: "intake" }),
    rejectsWith("record_not_found"),
  );
  assert.throws(
    () => ledger.linkRecord(triage, { recordId: jira.recordId, requestId: "none", role: "intake" }),
    rejectsWith("request_not_found"),
  );
  assert.throws(
    () =>
      ledger.linkRecord(triage, { recordId: jira.recordId, requestId: id, role: "reply" as never }),
    rejectsWith("invalid_argument"),
  );
});

test("같은 연결을 다시 만들면 있던 연결을 돌려준다. 사용자가 다시 연결하면 사용자가 정한 연결이 된다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, { decided: { title: "환불 지연 대응" } });
  const jira = ledger.addRevision(connector, {
    source: "jira",
    sourceId: "VOC-55",
    originalAt: at("08:30"),
    body: "환불 지연",
  });
  const link = { recordId: jira.recordId, requestId: id, role: "progress" } as const;
  const first = ledger.linkRecord(triage, link);
  const count = ledger.changesSince(0).length;

  // 비서가 다시 연결하면 아무것도 바꾸지 않는다.
  assert.deepEqual(ledger.linkRecord(triage, link), { id: first.id, added: false });
  assert.equal(ledger.changesSince(0).length, count);

  // 사용자가 다시 연결하면 사용자가 정한 연결로 바뀌고 한 건이 남는다.
  assert.deepEqual(ledger.linkRecord(user, link), { id: first.id, added: false });
  assert.deepEqual(ledger.getRequest(id).links, [
    { id: first.id, recordId: jira.recordId, taskId: null, role: "progress", userSet: true },
  ]);
  const last = ledger.changesSince(0).at(-1);
  assert.deepEqual(
    [last?.target, last?.before, last?.after],
    [{ kind: "link", id: first.id }, { userSet: false }, { userSet: true }],
  );
  assert.equal(ledger.changesSince(0).length, count + 1);

  // 이미 사용자가 정한 연결이면 더 남기지 않는다. 비서가 다시 연결해도 표시는 그대로다.
  ledger.linkRecord(user, link);
  ledger.linkRecord(triage, link);
  assert.equal(ledger.changesSince(0).length, count + 1);
  assert.equal(ledger.getRequest(id).links[0]?.userSet, true);
});
