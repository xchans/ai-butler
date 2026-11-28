// 작업 12와 13 가운데 목록 조회를 확인한다. S14의 거르기, S15, S16, S41의 목록 부분, S12와 S39의 내 차례인 요청.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { type Ledger, openLedger } from "./index.ts";
import {
  at,
  csTeam,
  jiwon,
  makeTempDir,
  me,
  minsu,
  openFileLedger,
  openTestLedger,
  rejectsWith,
  stored,
  triage,
  user,
} from "./test-support.ts";

function titles(ledger: Ledger, filter?: Parameters<Ledger["listRequests"]>[0]): unknown[] {
  return ledger.listRequests(filter).map((request) => request.title.value);
}

test("목록은 요청마다 상태, 차례, 작업별 표시, 작업 수와 끝난 수, 보류, 미정, 다음 작업 미정, 풀리지 않은 확인할 사항, 진척을 돌려준다", (t) => {
  const { ledger, clock } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, {
    decided: {
      title: "환불 지연 문의 대응",
      requester: jiwon,
      promise: { work: "원인을 찾아 회신한다", notify: [jiwon] },
      urgency: "medium",
    },
  });
  clock.set("09:10");
  const investigate = ledger.addTask(triage, { requestId: id, work: "원인 조사", assignee: minsu });
  ledger.completeTask(user, { taskId: investigate.id });
  const change = ledger.addTask(triage, {
    requestId: id,
    work: "데이터 변경",
    status: "waiting",
    waitingFor: { party: csTeam, what: "변경 대상 목록" },
  });
  const reply = ledger.addTask(triage, {
    requestId: id,
    work: "요청자에게 회신",
    assignee: me,
    dependsOn: [change.id],
  });
  const approve = ledger.addTask(triage, { requestId: id, work: "보상안 승인", assignee: me });
  clock.set("09:20");
  const hold = ledger.placeHold(user, {
    requestId: id,
    taskId: approve.id,
    resumeCondition: "예산이 확정되면 재개",
  });
  const question = ledger.raiseOpenItem(triage, {
    requestId: id,
    taskId: change.id,
    kind: "question",
    content: "지난달 결제도 변경 대상인가요?",
    options: ["넣는다", "넣지 않는다"],
  });
  const answered = ledger.raiseOpenItem(triage, {
    requestId: id,
    kind: "approval",
    content: "운영 DB를 조회해도 될까요?",
  });
  ledger.resolveOpenItem(user, { openItemId: answered.id, answer: "조회해도 됩니다" });
  const mismatch = ledger.raiseOpenItem(triage, {
    requestId: id,
    kind: "mismatch",
    content: "완료로 표시됐지만 티켓은 열려 있다",
  });
  clock.set("09:30");
  ledger.setPriority(user, { requestId: id, importance: "high" });
  ledger.setProgress(triage, { requestId: id, progress: "원인 확인, 변경 대상 목록 대기 중" });

  const byAssistant = { setBy: "assistant", userSet: false, userSetAt: null };
  const empty = { value: null, setBy: null, userSet: false, userSetAt: null };
  assert.deepEqual(ledger.listRequests(), [
    {
      id,
      createdAt: stored("09:00"),
      undecided: false,
      title: { value: "환불 지연 문의 대응", ...byAssistant },
      requester: { value: jiwon, ...byAssistant },
      promise: { value: { work: "원인을 찾아 회신한다", notify: [jiwon] }, ...byAssistant },
      due: empty,
      urgency: { value: "medium", ...byAssistant },
      importance: { value: "high", setBy: "user", userSet: true, userSetAt: stored("09:30") },
      order: null,
      progress: "원인 확인, 변경 대상 목록 대기 중",
      state: "in_progress",
      // 끝나지 않은 작업들의 차례에, 풀리지 않은 질문 때문에 사용자가 더해졌다.
      turn: [csTeam, me],
      myTurn: true,
      nextTaskUndecided: false,
      taskCount: 4,
      finishedTaskCount: 1,
      tasks: [
        {
          id: investigate.id,
          work: "원인 조사",
          status: "done",
          onHold: false,
          display: null,
          turn: null,
        },
        {
          id: change.id,
          work: "데이터 변경",
          status: "waiting",
          onHold: false,
          display: "waiting",
          turn: csTeam,
        },
        {
          id: reply.id,
          work: "요청자에게 회신",
          status: "todo",
          onHold: false,
          display: "predecessor_pending",
          turn: null,
        },
        {
          id: approve.id,
          work: "보상안 승인",
          status: "todo",
          onHold: true,
          display: "on_hold",
          turn: null,
        },
      ],
      holds: [
        {
          id: hold.id,
          taskId: approve.id,
          resumeCondition: "예산이 확정되면 재개",
          placedAt: stored("09:20"),
        },
      ],
      // 푼 것은 빠지고, 미확인과 어긋남도 풀리지 않았으면 나온다.
      unresolvedOpenItems: [
        {
          id: question.id,
          taskId: change.id,
          kind: "question",
          content: "지난달 결제도 변경 대상인가요?",
          options: ["넣는다", "넣지 않는다"],
          raisedAt: stored("09:20"),
          resolved: false,
          answer: null,
          resolvedAt: null,
        },
        {
          id: mismatch.id,
          taskId: null,
          kind: "mismatch",
          content: "완료로 표시됐지만 티켓은 열려 있다",
          options: null,
          raisedAt: stored("09:20"),
          resolved: false,
          answer: null,
          resolvedAt: null,
        },
      ],
    },
  ]);
});

test("목록과 요청 조회는 같은 계산을 쓴다. 상태, 차례, 표시, 보류가 같은 값으로 나온다", (t) => {
  const { ledger } = openTestLedger(t);
  const first = ledger.createRequest(triage, { decided: { title: "작업이 없는 요청" } });
  const second = ledger.createRequest(triage, { decided: { title: "보류한 요청" } });
  ledger.addTask(triage, { requestId: second.id, work: "원인 조사", assignee: me });
  ledger.placeHold(user, { requestId: second.id });
  const third = ledger.createRequest(triage, { decided: { title: "내 차례인 요청" } });
  const blocker = ledger.addTask(triage, { requestId: third.id, work: "원인 조사" });
  ledger.cancelTask(user, { taskId: blocker.id });
  ledger.addTask(triage, { requestId: third.id, work: "데이터 변경", dependsOn: [blocker.id] });
  ledger.addTask(triage, {
    requestId: third.id,
    work: "승인",
    status: "waiting",
    waitingFor: { party: me },
  });

  const listed = ledger.listRequests();
  assert.deepEqual(
    listed.map((request) => request.id),
    [first.id, second.id, third.id],
  );
  for (const summary of listed) {
    const request = ledger.getRequest(summary.id);
    const label = String(summary.title.value);
    assert.deepEqual(
      [summary.state, summary.turn, summary.myTurn, summary.nextTaskUndecided, summary.holds],
      [request.state, request.turn, request.myTurn, request.nextTaskUndecided, request.holds],
      label,
    );
    assert.deepEqual(
      summary.tasks,
      request.tasks.map(({ id, work, status, onHold, display, turn }) => ({
        id,
        work,
        status,
        onHold,
        display,
        turn,
      })),
      label,
    );
    assert.equal(summary.taskCount, request.tasks.length, label);
  }
  assert.deepEqual(
    listed.map((request) => [request.state, request.myTurn, request.nextTaskUndecided]),
    [
      ["open", false, true],
      ["open", false, false],
      ["in_progress", true, false],
    ],
  );
  assert.deepEqual(
    listed[2]?.tasks.map((task) => task.display),
    [null, "predecessor_cancelled", "waiting"],
  );
});

test("S15: 미정으로 등록한 요청이 목록에 나오고, 비어 있던 요청자와 약속한 결과를 나중에 채울 수 있다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, {
    decided: { title: "처리할지 정해지지 않은 문의" },
    undecided: true,
  });
  ledger.createRequest(triage, { decided: { title: "처리하기로 한 요청" } });

  let listed = ledger.listRequests();
  assert.deepEqual(
    listed.map((request) => [request.title.value, request.undecided]),
    [
      ["처리할지 정해지지 않은 문의", true],
      ["처리하기로 한 요청", false],
    ],
  );
  // 미정인 요청도 다른 요청과 같은 값이 나온다. 정해지지 않은 값은 비어 있다.
  assert.deepEqual(
    [listed[0]?.requester.value, listed[0]?.promise.value, listed[0]?.state],
    [null, null, "open"],
  );

  // 미정은 비서가 풀 수 있고, 푼 뒤에는 다시 붙일 수 없다.
  ledger.updateRequest(triage, {
    requestId: id,
    requester: jiwon,
    promise: { work: "원인을 찾아 회신한다" },
    undecided: false,
  });
  listed = ledger.listRequests();
  assert.deepEqual(
    [listed[0]?.undecided, listed[0]?.requester.value, listed[0]?.promise.value],
    [false, jiwon, { work: "원인을 찾아 회신한다", notify: [] }],
  );
  assert.throws(
    () => ledger.updateRequest(user, { requestId: id, undecided: true as never }),
    rejectsWith("undecided_only_at_creation"),
  );
  assert.equal(ledger.listRequests()[0]?.undecided, false);
});

test("S15: 미정은 사용자도 풀 수 있다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, {
    decided: { title: "처리할지 정해지지 않은 문의" },
    undecided: true,
  });

  ledger.updateRequest(user, { requestId: id, undecided: false });

  assert.deepEqual(
    ledger.listRequests().map((request) => request.undecided),
    [false],
  );
});

test("S41: 진척은 비서가 쓰고 목록에 나온다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, { decided: { title: "환불 지연 문의 대응" } });
  ledger.createRequest(triage, { decided: { title: "진척을 쓰지 않은 요청" } });
  assert.deepEqual(
    ledger.listRequests().map((request) => request.progress),
    [null, null],
  );

  ledger.setProgress(triage, { requestId: id, progress: "원인 조사 중" });
  assert.throws(
    () => ledger.setProgress(user, { requestId: id, progress: "사용자가 쓴 진척" } as never),
    rejectsWith("requires_assistant"),
  );

  assert.deepEqual(
    ledger.listRequests().map((request) => request.progress),
    ["원인 조사 중", null],
  );
  ledger.setProgress(triage, { requestId: id, progress: "원인 확인, 회신 준비 중" });
  assert.equal(ledger.listRequests()[0]?.progress, "원인 확인, 회신 준비 중");
});

test("S14: 목록을 상태별로 거를 수 있다", (t) => {
  const { ledger } = openTestLedger(t);
  ledger.createRequest(triage, { decided: { title: "작업이 없는 요청" } });
  const todo = ledger.createRequest(triage, { decided: { title: "할 일만 있는 요청" } });
  ledger.addTask(triage, { requestId: todo.id, work: "원인 조사" });
  const started = ledger.createRequest(triage, { decided: { title: "시작한 요청" } });
  const task = ledger.addTask(triage, {
    requestId: started.id,
    work: "원인 조사",
    status: "in_progress",
  });
  const finished = ledger.createRequest(triage, { decided: { title: "작업이 끝난 요청" } });
  ledger.completeTask(user, {
    taskId: ledger.addTask(triage, { requestId: finished.id, work: "원인 조사" }).id,
  });

  assert.deepEqual(titles(ledger, { state: "open" }), ["작업이 없는 요청", "할 일만 있는 요청"]);
  assert.deepEqual(titles(ledger, { state: "in_progress" }), ["시작한 요청", "작업이 끝난 요청"]);
  assert.equal(titles(ledger).length, 4);
  assert.equal(titles(ledger, {}).length, 4);

  // 상태는 계산한 값이어서, 작업이 바뀌면 거른 결과도 바뀐다.
  ledger.cancelTask(user, { taskId: task.id });
  assert.deepEqual(titles(ledger, { state: "open" }), [
    "작업이 없는 요청",
    "할 일만 있는 요청",
    "시작한 요청",
  ]);
});

test("S12, S39: 목록을 내 차례인 요청만으로 거를 수 있다", (t) => {
  const { ledger } = openTestLedger(t);
  const mine = ledger.createRequest(triage, { decided: { title: "담당이 사용자인 요청" } });
  ledger.addTask(triage, { requestId: mine.id, work: "요청자에게 회신", assignee: me });
  const others = ledger.createRequest(triage, { decided: { title: "담당이 다른 사람인 요청" } });
  ledger.addTask(triage, { requestId: others.id, work: "원인 조사", assignee: minsu });
  const held = ledger.createRequest(triage, {
    decided: { title: "담당이 사용자지만 보류한 요청" },
  });
  ledger.addTask(triage, { requestId: held.id, work: "승인", assignee: me });
  const hold = ledger.placeHold(user, { requestId: held.id });
  const asked = ledger.createRequest(triage, { decided: { title: "질문이 달린 요청" } });
  const question = ledger.raiseOpenItem(triage, {
    requestId: asked.id,
    kind: "question",
    content: "처리할 요청인가요?",
  });
  const unverified = ledger.createRequest(triage, { decided: { title: "미확인만 달린 요청" } });
  ledger.raiseOpenItem(triage, {
    requestId: unverified.id,
    kind: "unverified",
    content: "티켓에 접근할 수 없다",
  });

  assert.deepEqual(titles(ledger, { myTurn: true }), ["담당이 사용자인 요청", "질문이 달린 요청"]);
  assert.deepEqual(
    ledger.listRequests().map((request) => request.myTurn),
    [true, false, false, true, false],
  );
  // 상태와 함께 거를 수 있다.
  assert.deepEqual(titles(ledger, { myTurn: true, state: "in_progress" }), []);
  assert.deepEqual(titles(ledger, { myTurn: true, state: "open" }), [
    "담당이 사용자인 요청",
    "질문이 달린 요청",
  ]);

  // 보류를 풀고 질문에 답하면 내 차례인 요청이 바뀐다.
  ledger.releaseHold(user, { holdId: hold.id });
  ledger.resolveOpenItem(user, { openItemId: question.id, answer: "처리한다" });
  assert.deepEqual(titles(ledger, { myTurn: true }), [
    "담당이 사용자인 요청",
    "담당이 사용자지만 보류한 요청",
  ]);
});

test("목록의 거르는 조건이 틀리면 거부된다", (t) => {
  const { ledger } = openTestLedger(t);
  ledger.createRequest(triage, { decided: { title: "환불 지연 문의 대응" } });

  for (const filter of [
    { state: "done" },
    { state: "waiting" },
    { myTurn: false },
    { myTurn: "yes" },
    { closed: true },
    "open",
  ]) {
    assert.throws(
      () => ledger.listRequests(filter as never),
      rejectsWith("invalid_argument"),
      JSON.stringify(filter),
    );
  }
});

test("S16: 목록은 사용자가 정한 처리 순서, 긴급도, 중요도, 기한, 접수 시각 순으로 나온다", (t) => {
  const { ledger } = openTestLedger(t);
  type Level = "high" | "medium" | "low";
  type Listed = {
    title: string;
    order?: number;
    urgency?: Level;
    importance?: Level;
    due?: string;
  };
  // 목록에 나와야 하는 순서다.
  const expected: Listed[] = [
    // 사용자가 처리 순서를 정한 요청은 긴급도가 낮아도 맨 앞에 온다.
    { title: "처리 순서 1, 긴급도 낮음", order: 1, urgency: "low" },
    // 처리 순서가 같은 두 요청은 긴급도로 갈린다.
    { title: "처리 순서 2, 긴급도 높음", order: 2, urgency: "high" },
    { title: "처리 순서 2, 긴급도 보통", order: 2, urgency: "medium" },
    { title: "처리 순서 3, 긴급도 없음", order: 3 },
    // 나머지는 긴급도, 중요도, 기한 순이다. 기한이 이른 요청이 앞이다.
    {
      title: "긴급도 높음, 중요도 높음, 기한 18시",
      urgency: "high",
      importance: "high",
      due: "18:00",
    },
    {
      title: "긴급도 높음, 중요도 높음, 기한 20시",
      urgency: "high",
      importance: "high",
      due: "20:00",
    },
    // 기한이 없는 요청은 같은 긴급도와 중요도의 기한 있는 요청 뒤에 온다.
    { title: "긴급도 높음, 중요도 높음, 기한 없음", urgency: "high", importance: "high" },
    { title: "긴급도 높음, 중요도 보통", urgency: "high", importance: "medium" },
    // 긴급도가 높고 중요도가 낮은 요청이 긴급도가 보통이고 중요도가 높은 요청보다 앞에 온다.
    { title: "긴급도 높음, 중요도 낮음", urgency: "high", importance: "low" },
    // 값이 없는 중요도는 낮음 뒤에 온다. 기한이 일러도 그렇다.
    { title: "긴급도 높음, 중요도 없음, 기한 10시", urgency: "high", due: "10:00" },
    { title: "긴급도 보통, 중요도 높음", urgency: "medium", importance: "high" },
    { title: "긴급도 낮음, 중요도 낮음", urgency: "low", importance: "low" },
    // 긴급도가 없는 요청은 낮음 뒤에 온다. 중요도가 높고 기한이 일러도 그렇다.
    { title: "긴급도 없음, 중요도 높음, 기한 10시", importance: "high", due: "10:00" },
    { title: "긴급도 없음, 중요도 없음, 기한 10시", due: "10:00" },
    { title: "긴급도 없음, 중요도 없음, 기한 없음" },
  ];

  // 나와야 하는 순서와 거꾸로 등록한다. 시계는 멈춰 있어 접수 시각이 모두 같다.
  // 앞의 값이 다르면 등록한 순서는 순서를 정하지 않는다.
  for (const { title, order, urgency, importance, due } of expected.toReversed()) {
    const { id } = ledger.createRequest(triage, {
      decided: {
        title,
        ...(urgency ? { urgency } : {}),
        ...(importance ? { importance } : {}),
        ...(due ? { due: at(due) } : {}),
      },
    });
    if (order !== undefined) {
      ledger.setOrder(user, { requestId: id, order });
    }
  }

  assert.deepEqual(
    titles(ledger),
    expected.map(({ title }) => title),
  );
  assert.deepEqual(
    ledger.listRequests().map((request) => request.order),
    expected.map(({ order }) => order ?? null),
  );
});

test("S16: 모든 값이 같으면 접수 시각이 이른 요청이 앞에 오고, 접수 시각도 같으면 먼저 등록한 요청이 앞에 온다", (t) => {
  const { ledger, clock } = openTestLedger(t, "10:00");
  const values = { urgency: "high", importance: "low", due: at("18:00") } as const;
  ledger.createRequest(triage, { decided: { title: "10시에 먼저 등록", ...values } });
  ledger.createRequest(triage, { decided: { title: "10시에 나중에 등록", ...values } });
  // 시계가 뒤로 조정돼 나중에 등록한 요청의 접수 시각이 더 이르다.
  clock.set("09:00");
  ledger.createRequest(triage, { decided: { title: "9시에 등록", ...values } });
  clock.set("11:00");
  ledger.createRequest(triage, { decided: { title: "11시에 등록", ...values } });

  assert.deepEqual(titles(ledger), [
    "9시에 등록",
    "10시에 먼저 등록",
    "10시에 나중에 등록",
    "11시에 등록",
  ]);

  // 처리 순서가 같은 요청끼리도 그렇다.
  for (const request of ledger.listRequests()) {
    ledger.setOrder(user, { requestId: request.id, order: 7 });
  }
  assert.deepEqual(titles(ledger), [
    "9시에 등록",
    "10시에 먼저 등록",
    "10시에 나중에 등록",
    "11시에 등록",
  ]);
});

test("S16: 접수 시각이 같은 요청은 파일에 놓인 순서가 달라도 먼저 등록한 요청이 앞에 온다", (t) => {
  const { ledger, path, row } = openFileLedger(t);
  // 시계가 멈춰 있어 세 요청의 접수 시각이 같다.
  const first = ledger.createRequest(triage, { decided: { title: "첫째로 등록" } });
  const second = ledger.createRequest(triage, { decided: { title: "둘째로 등록" } });
  const third = ledger.createRequest(triage, { decided: { title: "셋째로 등록" } });
  assert.deepEqual(titles(ledger), ["첫째로 등록", "둘째로 등록", "셋째로 등록"]);

  // 원장을 거치지 않고, 요청의 줄이 파일에 놓인 순서만 등록한 순서와 다르게 바꾼다.
  // 첫째 요청을 맨 뒤로, 셋째 요청을 맨 앞으로 옮긴다. 저장된 값은 그대로다.
  const raw = new DatabaseSync(path);
  try {
    raw.prepare("UPDATE requests SET rowid = 99 WHERE id = ?").run(first.id);
    raw.prepare("UPDATE requests SET rowid = -1 WHERE id = ?").run(third.id);
  } finally {
    raw.close();
  }
  const saved = (id: string) =>
    row("SELECT rowid AS position, created_at, created_seq FROM requests WHERE id = ?", id);
  assert.deepEqual(
    [saved(first.id), saved(second.id), saved(third.id)],
    [
      { position: 99, created_at: first.createdAt, created_seq: 1 },
      { position: 2, created_at: first.createdAt, created_seq: 2 },
      { position: -1, created_at: first.createdAt, created_seq: 3 },
    ],
  );

  // 목록은 줄이 놓인 순서가 아니라 등록한 순서를 따른다.
  assert.deepEqual(titles(ledger), ["첫째로 등록", "둘째로 등록", "셋째로 등록"]);
});

test("S16: 처리 순서를 정하면 맨 앞으로 오고, 지우면 긴급도로 정한 자리로 돌아간다", (t) => {
  const { ledger } = openTestLedger(t);
  ledger.createRequest(triage, { decided: { title: "긴급도 높음", urgency: "high" } });
  ledger.createRequest(triage, { decided: { title: "긴급도 보통", urgency: "medium" } });
  const low = ledger.createRequest(triage, { decided: { title: "긴급도 낮음", urgency: "low" } });
  assert.deepEqual(titles(ledger), ["긴급도 높음", "긴급도 보통", "긴급도 낮음"]);

  ledger.setOrder(user, { requestId: low.id, order: 5 });
  assert.deepEqual(titles(ledger), ["긴급도 낮음", "긴급도 높음", "긴급도 보통"]);
  // 긴급도가 바뀌어도 처리 순서를 정한 요청이 먼저다.
  ledger.setPriority(user, { requestId: low.id, urgency: null });
  assert.deepEqual(titles(ledger), ["긴급도 낮음", "긴급도 높음", "긴급도 보통"]);

  ledger.setOrder(user, { requestId: low.id, order: null });
  assert.deepEqual(titles(ledger), ["긴급도 높음", "긴급도 보통", "긴급도 낮음"]);
  assert.equal(ledger.listRequests().at(-1)?.order, null);
});

test("S16: 거른 목록도 같은 순서다", (t) => {
  const { ledger } = openTestLedger(t);
  for (const urgency of ["low", "high", "medium"] as const) {
    const { id } = ledger.createRequest(triage, {
      decided: { title: `긴급도 ${urgency}`, urgency },
    });
    ledger.addTask(triage, { requestId: id, work: "승인", assignee: me, status: "in_progress" });
  }
  ledger.createRequest(triage, { decided: { title: "작업이 없는 요청", urgency: "high" } });

  const expected = ["긴급도 high", "긴급도 medium", "긴급도 low"];
  assert.deepEqual(titles(ledger, { state: "in_progress" }), expected);
  assert.deepEqual(titles(ledger, { myTurn: true }), expected);
});

test("목록 조회 한 번은 한 시점의 값을 돌려준다. 조회하는 사이에 다른 연결이 커밋해도 섞이지 않는다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const reader = openLedger({ path });
  const writer = openLedger({ path });
  t.after(() => {
    reader.close();
    writer.close();
  });
  const first = reader.createRequest(triage, { decided: { title: "첫째 요청" } });
  const firstTask = reader.addTask(triage, { requestId: first.id, work: "첫째 요청의 작업" });
  const second = reader.createRequest(triage, { decided: { title: "둘째 요청" } });
  reader.addTask(triage, { requestId: second.id, work: "둘째 요청의 작업", assignee: minsu });

  // 요청들을 읽은 뒤 첫째 요청의 작업을 읽으려는 순간에, 다른 연결이 두 요청을 모두 바꾸고 요청을 하나 더 등록한다.
  const prepare = DatabaseSync.prototype.prepare;
  let interleaved = 0;
  t.after(() => {
    DatabaseSync.prototype.prepare = prepare;
  });
  DatabaseSync.prototype.prepare = function (sql, ...rest) {
    if (interleaved === 0 && sql.includes("FROM tasks WHERE request_id")) {
      interleaved += 1;
      writer.updateTask(triage, { taskId: firstTask.id, status: "in_progress" });
      writer.placeHold(user, { requestId: second.id });
      writer.raiseOpenItem(triage, {
        requestId: second.id,
        kind: "question",
        content: "급한가요?",
      });
      writer.createRequest(triage, { decided: { title: "조회하는 사이에 등록한 요청" } });
    }
    return prepare.call(this, sql, ...rest);
  };
  const during = reader.listRequests();
  DatabaseSync.prototype.prepare = prepare;

  // 조회하는 사이에 실제로 다른 연결의 커밋이 끼어들었다.
  assert.equal(interleaved, 1);
  assert.equal(writer.changesSince(0).length, 8);
  // 모든 요청이 조회를 시작한 시점의 값이다.
  const seen = (requests: ReturnType<Ledger["listRequests"]>) =>
    requests.map((request) => [
      request.title.value,
      request.state,
      request.holds.length,
      request.myTurn,
      request.tasks.map((task) => task.display),
    ]);
  assert.deepEqual(seen(during), [
    ["첫째 요청", "open", 0, false, ["actionable"]],
    ["둘째 요청", "open", 0, false, ["actionable"]],
  ]);

  // 다음 조회에는 바뀐 값이 함께 나온다.
  assert.deepEqual(seen(reader.listRequests()), [
    ["첫째 요청", "in_progress", 0, false, ["actionable"]],
    ["둘째 요청", "open", 1, true, ["on_hold"]],
    ["조회하는 사이에 등록한 요청", "open", 0, false, []],
  ]);
});

test("목록 조회가 줄을 읽는 도중에 오류로 끝나도 읽기 트랜잭션이 남지 않아, 같은 원장으로 이어서 쓰고 읽을 수 있다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, { decided: { title: "조회 뒤에 쓰는 요청" } });
  ledger.addTask(triage, { requestId: id, work: "조회하기 전의 작업" });

  // 읽기 트랜잭션 안에서 요청들을 읽은 뒤, 첫 요청의 작업을 읽으려는 순간에 오류가 난다.
  const prepare = DatabaseSync.prototype.prepare;
  let failed = 0;
  t.after(() => {
    DatabaseSync.prototype.prepare = prepare;
  });
  DatabaseSync.prototype.prepare = function (sql, ...rest) {
    if (failed === 0 && sql.includes("FROM tasks WHERE request_id")) {
      failed += 1;
      throw new Error("목록을 읽는 도중에 난 오류");
    }
    return prepare.call(this, sql, ...rest);
  };
  assert.throws(() => ledger.listRequests(), /목록을 읽는 도중에 난 오류/);
  DatabaseSync.prototype.prepare = prepare;
  assert.equal(failed, 1);

  // 같은 원장으로 이어서 쓴다. 읽기 트랜잭션이 남아 있었다면 쓰기 트랜잭션을 시작하지 못한다.
  ledger.updateRequest(triage, { requestId: id, title: "조회 뒤에 고친 제목" });
  const added = ledger.addTask(triage, { requestId: id, work: "조회 뒤에 더한 작업" });
  // 이어서 읽으면 방금 쓴 것이 나온다.
  const listed = ledger.listRequests();
  assert.deepEqual(
    listed.map((request) => [request.title.value, request.tasks.map((task) => task.work)]),
    [["조회 뒤에 고친 제목", ["조회하기 전의 작업", "조회 뒤에 더한 작업"]]],
  );
  assert.equal(ledger.getRequest(id).tasks.at(-1)?.id, added.id);
});

test("목록의 거르는 조건이 틀려 거부된 뒤에도 이어서 읽고 쓸 수 있다", (t) => {
  const { ledger } = openTestLedger(t);
  const { id } = ledger.createRequest(triage, { decided: { title: "조회 뒤에 쓰는 요청" } });

  assert.throws(() => ledger.listRequests({ state: "none" } as never));
  ledger.listRequests();
  ledger.updateRequest(triage, { requestId: id, title: "조회 뒤에 고친 제목" });

  assert.deepEqual(titles(ledger), ["조회 뒤에 고친 제목"]);
});
