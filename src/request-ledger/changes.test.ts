// 작업 2 가운데 변경 이력의 틀(S27의 틀)을 확인한다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import {
  changesSince,
  defaultAppliesTo,
  type WriteEnv,
  type WriteScope,
  write,
} from "./changes.ts";
import { inWriteTransaction, type LedgerDb, openDb } from "./db.ts";
import { LedgerError, type LedgerErrorCode } from "./errors.ts";
import { openLedger } from "./index.ts";
import { makeTempDir } from "./test-support.ts";
import type { Actor } from "./types.ts";

const user: Actor = { kind: "user", via: "web" };
const assistant: Actor = { kind: "assistant", module: "intake-triage" };

/** 부를 때마다 1분씩 가는 시계. */
function tickingClock(start: string): () => Date {
  let next = new Date(start).getTime();
  return () => {
    const now = new Date(next);
    next += 60_000;
    return now;
  };
}

/** req-1, req-2, ... 를 차례로 돌려준다. */
function sequentialIds(prefix: string): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `${prefix}-${count}`;
  };
}

function rejectsWith(code: LedgerErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof LedgerError && error.code === code;
}

const INSERT_REQUEST = "INSERT INTO requests (id, title, created_at) VALUES (?, ?, ?)";

/** 쓰기의 틀만 확인하는 테스트에서 쓰는 쓰기 이름. */
const CREATE = { action: "createRequest" } as const;

/** 쓰기의 틀에 넘길 것. 시계는 부를 때마다 1분씩 간다. */
function env(db: LedgerDb, start = "2026-03-02T09:00:00.000Z"): WriteEnv {
  return { db, clock: tickingClock(start), newId: sequentialIds("id") };
}

/** 다음 매크로태스크까지 기다려, 빠져나간 비동기 작업이 돌 틈을 준다. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function countRequests(path: string): unknown {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    return raw.prepare("SELECT count(*) AS count FROM requests").get()?.count;
  } finally {
    raw.close();
  }
}

test("S27: 쓰기가 변경 이력에 주체, 대상, 이전 값과 새 값, 시각과 함께 남는다", (t) => {
  const ledger = openLedger({
    path: join(makeTempDir(t), "ledger.sqlite"),
    clock: tickingClock("2026-03-02T09:00:00.000Z"),
    newId: sequentialIds("req"),
  });
  t.after(() => ledger.close());

  const first = ledger.createRequest(user, { stated: { title: "환불 문의 원인 조사" } });
  const second = ledger.createRequest(assistant, { decided: { title: "배포 일정 확인" } });

  assert.deepEqual(first, { id: "req-1", createdAt: "2026-03-02T09:00:00.000000Z" });
  assert.equal(second.id, "req-2");
  assert.deepEqual(ledger.changesSince(0), [
    {
      seq: 1,
      writeSeq: 1,
      at: "2026-03-02T09:00:00.000000Z",
      actor: { kind: "user", via: "web" },
      action: "createRequest",
      target: { kind: "request", id: "req-1" },
      requestId: "req-1",
      before: null,
      after: {
        undecided: false,
        title: {
          value: "환불 문의 원인 조사",
          setBy: "user",
          userSetAt: "2026-03-02T09:00:00.000000Z",
        },
      },
      evidence: [],
      reason: null,
      appliesTo: { scope: "similar_future", stated: false },
    },
    {
      seq: 2,
      writeSeq: 2,
      at: "2026-03-02T09:01:00.000000Z",
      actor: { kind: "assistant", module: "intake-triage" },
      action: "createRequest",
      target: { kind: "request", id: "req-2" },
      requestId: "req-2",
      before: null,
      after: {
        undecided: false,
        title: { value: "배포 일정 확인", setBy: "assistant", userSetAt: null },
      },
      evidence: [],
      reason: null,
      appliesTo: null,
    },
  ]);
});

test("S27: 시각은 시계의 시간대와 상관없이 UTC로, 마이크로초 여섯 자리로 남는다", (t) => {
  const ledger = openLedger({
    path: join(makeTempDir(t), "ledger.sqlite"),
    clock: () => new Date("2026-03-02T18:30:00+09:00"),
  });
  t.after(() => ledger.close());

  const created = ledger.createRequest(user, { stated: { title: "시각 확인" } });

  assert.equal(created.createdAt, "2026-03-02T09:30:00.000000Z");
  assert.equal(ledger.changesSince(0)[0]?.at, "2026-03-02T09:30:00.000000Z");
});

test("S27: 거부된 쓰기는 값도 변경 이력도 남기지 않는다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const ledger = openLedger({ path });
  t.after(() => ledger.close());
  ledger.createRequest(user, { stated: { title: "먼저 등록한 요청" } });

  assert.throws(
    () => ledger.createRequest(user, { stated: { title: "" } }),
    rejectsWith("title_required"),
  );
  assert.throws(
    () => ledger.createRequest(user, { stated: { title: "   " } }),
    rejectsWith("title_required"),
  );

  assert.equal(countRequests(path), 1);
  assert.deepEqual(
    ledger.changesSince(0).map((change) => change.seq),
    [1],
  );
  // 거부된 쓰기가 순번을 쓰지 않아, 다음 쓰기의 순번이 바로 이어진다.
  ledger.createRequest(user, { stated: { title: "나중에 등록한 요청" } });
  assert.deepEqual(
    ledger.changesSince(0).map((change) => change.seq),
    [1, 2],
  );
});

test("S27: 주체를 밝히지 않았거나 형태가 틀린 쓰기는 거부된다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const ledger = openLedger({ path });
  t.after(() => ledger.close());

  const invalidActors: unknown[] = [
    undefined,
    null,
    "user",
    {},
    { kind: "user" },
    { kind: "user", via: "email" },
    { kind: "assistant" },
    { kind: "assistant", module: "" },
    { kind: "assistant", module: "   " },
    { kind: "assistant", module: "\t\n" },
    { kind: "agent", module: "coordination" },
  ];
  for (const actor of invalidActors) {
    assert.throws(
      () => ledger.createRequest(actor as Actor, { stated: { title: "주체가 틀린 요청" } }),
      rejectsWith("invalid_actor"),
      JSON.stringify(actor),
    );
  }

  assert.equal(countRequests(path), 0);
  assert.deepEqual(ledger.changesSince(0), []);
});

test("S27: changesSince가 순번 뒤의 변경만 순번 순서로 돌려준다", (t) => {
  const ledger = openLedger({ path: join(makeTempDir(t), "ledger.sqlite") });
  t.after(() => ledger.close());
  for (const title of ["하나", "둘", "셋", "넷"]) {
    ledger.createRequest(user, { stated: { title } });
  }
  const seqsSince = (seq: number) => ledger.changesSince(seq).map((change) => change.seq);

  assert.deepEqual(seqsSince(0), [1, 2, 3, 4]);
  assert.deepEqual(seqsSince(2), [3, 4]);
  assert.deepEqual(seqsSince(4), []);
  assert.deepEqual(seqsSince(100), []);
  for (const invalid of [-1, 1.5, Number.NaN, "2" as unknown as number]) {
    assert.throws(() => ledger.changesSince(invalid), rejectsWith("invalid_argument"));
  }
});

test("같은 파일을 연 다른 원장이 쓴 변경을 changesSince로 알아챈다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const screen = openLedger({ path });
  const writer = openLedger({ path });
  t.after(() => {
    screen.close();
    writer.close();
  });
  writer.createRequest(user, { stated: { title: "화면이 이미 본 요청" } });
  const seen = screen.changesSince(0).at(-1)?.seq ?? 0;

  writer.createRequest(assistant, { decided: { title: "화면이 아직 못 본 요청" } });

  assert.deepEqual(
    screen.changesSince(seen).map((change) => change.after),
    [
      {
        undecided: false,
        title: { value: "화면이 아직 못 본 요청", setBy: "assistant", userSetAt: null },
      },
    ],
  );
});

test("쓰기 하나의 값과 변경 이력은 한 트랜잭션이다. 도중에 실패하면 둘 다 남지 않는다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const db = openDb(path);
  t.after(() => db.close());
  const insertRequest = (scope: WriteScope, id: string) =>
    scope.run(INSERT_REQUEST, id, `${id}의 제목`, scope.at);

  assert.throws(
    () =>
      write(env(db), user, CREATE, (scope) => {
        insertRequest(scope, "req-rejected");
        scope.record({
          target: { kind: "request", id: "req-rejected" },
          requestId: "req-rejected",
          before: null,
          after: { title: "req-rejected의 제목" },
        });
        // 값과 변경 이력을 쓴 뒤에 규칙에 걸린 경우
        throw new LedgerError("invalid_argument", "뒤늦게 어긋난 쓰기");
      }),
    rejectsWith("invalid_argument"),
  );

  assert.equal(db.isTransaction, false);
  assert.equal(countRequests(path), 0);
  assert.deepEqual(changesSince(db, 0), []);

  // 받아들여진 쓰기는 여러 변경을 같은 시각, 이어지는 순번으로 남긴다.
  const seqs = write(env(db, "2026-03-02T10:00:00.000Z"), assistant, CREATE, (scope) => {
    insertRequest(scope, "req-a");
    insertRequest(scope, "req-b");
    return ["req-a", "req-b"].map((id) =>
      scope.record({
        target: { kind: "request", id },
        requestId: id,
        before: null,
        after: { title: `${id}의 제목` },
      }),
    );
  });

  assert.deepEqual(seqs, [1, 2]);
  assert.equal(countRequests(path), 2);
  assert.deepEqual(
    changesSince(db, 0).map((change) => [change.seq, change.at, change.target.id]),
    [
      [1, "2026-03-02T10:00:00.000000Z", "req-a"],
      [2, "2026-03-02T10:00:00.000000Z", "req-b"],
    ],
  );
});

test("한 쓰기가 남긴 변경 이력은 쓰기 순번이 같고, 쓰기 순번은 변경 이력을 남기기 전에도 알 수 있다", (t) => {
  const db = openDb(join(makeTempDir(t), "ledger.sqlite"));
  t.after(() => db.close());
  const record = (scope: WriteScope, id: string) =>
    scope.record({ target: { kind: "request", id }, requestId: id, before: null, after: {} });

  // 거부된 쓰기와 아무것도 남기지 않은 쓰기는 순번을 쓰지 않는다.
  assert.throws(() =>
    write(env(db), user, CREATE, (scope) => {
      record(scope, "req-rejected");
      throw new LedgerError("invalid_argument", "거부된 쓰기");
    }),
  );
  assert.equal(
    write(env(db), user, CREATE, (scope) => scope.seq),
    1,
  );

  const first = write(env(db), user, CREATE, (scope) => {
    // 변경 이력을 남기기 전에 읽은 쓰기 순번이 첫 건의 순번이 된다.
    const known = scope.seq;
    return {
      known,
      seqs: [record(scope, "req-a"), record(scope, "req-b"), record(scope, "req-c")],
    };
  });
  const second = write(env(db), assistant, { action: "updateRequest" }, (scope) => ({
    known: scope.seq,
    seqs: [record(scope, "req-a")],
  }));

  assert.deepEqual(first, { known: 1, seqs: [1, 2, 3] });
  assert.deepEqual(second, { known: 4, seqs: [4] });
  assert.deepEqual(
    changesSince(db, 0).map((change) => [change.seq, change.writeSeq, change.action]),
    [
      [1, 1, "createRequest"],
      [2, 1, "createRequest"],
      [3, 1, "createRequest"],
      [4, 4, "updateRequest"],
    ],
  );
});

test("한 쓰기 안에서 변경마다 쓰기 이름을 따로 적을 수 있다", (t) => {
  const db = openDb(join(makeTempDir(t), "ledger.sqlite"));
  t.after(() => db.close());

  write(env(db), user, { action: "resolveOpenItem" }, (scope) => {
    const entry = { requestId: "req-1", before: null, after: {} };
    scope.record({ ...entry, target: { kind: "open_item", id: "item-1" } });
    scope.record({ ...entry, target: { kind: "request", id: "req-1" }, action: "updateRequest" });
  });

  assert.deepEqual(
    changesSince(db, 0).map((change) => [change.writeSeq, change.action, change.appliesTo]),
    [
      // 답과 값 변경은 적용 범위의 기본값을 따로 본다.
      [1, "resolveOpenItem", { scope: "this_request", stated: false }],
      [1, "updateRequest", { scope: "similar_future", stated: false }],
    ],
  );
});

test("S27: 밝히지 않은 적용 범위의 기본값은 쓰기에 따라 정해진다. 보류는 이 요청에만 해당한다", () => {
  // 그 요청에 준 지시와, 일어난 일을 사용자가 알린 쓰기는 이 요청에만 해당한다.
  const thisRequest = [
    "placeHold",
    "releaseHold",
    "setOrder",
    "setContinue",
    "setDelegation",
    "clearDelegation",
    "completeTask",
    "cancelTask",
    "closeRequest",
    "setEnding",
    "confirmClosure",
    "clearEnding",
    "reopenRequest",
    "resolveOpenItem",
    "markNoticeSeen",
  ] as const;
  for (const action of thisRequest) {
    assert.equal(defaultAppliesTo(action), "this_request", action);
  }
  // 비서의 판단을 바로잡은 쓰기는 다음 유사 업무에도 적용한다.
  const similarFuture = [
    "createRequest",
    "updateRequest",
    "setPriority",
    "updateTask",
    "addTask",
    "linkRecord",
    "setTurn",
    "clearTurn",
    "mergeRequests",
    "splitRequest",
    "moveTask",
    "moveRecord",
    "unlinkRecord",
  ] as const;
  for (const action of similarFuture) {
    assert.equal(defaultAppliesTo(action), "similar_future", action);
  }
});

test("사용자가 밝힌 적용 범위는 그 쓰기가 남긴 모든 건에 남고, 비서의 쓰기에는 붙일 수 없다", (t) => {
  const db = openDb(join(makeTempDir(t), "ledger.sqlite"));
  t.after(() => db.close());
  const body = (scope: WriteScope): void => {
    for (const id of ["req-1", "req-2"]) {
      scope.record({ target: { kind: "request", id }, requestId: id, before: null, after: {} });
    }
  };

  write(env(db), user, { action: "updateRequest", appliesTo: "this_request" }, body);
  assert.throws(
    () => write(env(db), assistant, { action: "updateRequest", appliesTo: "this_request" }, body),
    rejectsWith("requires_user"),
  );
  assert.throws(
    () => write(env(db), user, { action: "updateRequest", appliesTo: "everything" }, body),
    rejectsWith("invalid_argument"),
  );

  assert.deepEqual(
    changesSince(db, 0).map((change) => change.appliesTo),
    [
      { scope: "this_request", stated: true },
      { scope: "this_request", stated: true },
    ],
  );
});

test("변경 이력에 근거와 사유를 함께 남길 수 있다", (t) => {
  const db = openDb(join(makeTempDir(t), "ledger.sqlite"));
  t.after(() => db.close());

  write(env(db), assistant, CREATE, (scope) => {
    scope.record({
      target: { kind: "request", id: "req-1" },
      requestId: "req-1",
      before: { title: "예전 제목" },
      after: { title: "새 제목" },
      evidence: [{ kind: "revision", id: "rev-1" }],
      reason: "원본의 제목이 바뀌었다",
    });
  });

  assert.deepEqual(changesSince(db, 0), [
    {
      seq: 1,
      writeSeq: 1,
      at: "2026-03-02T09:00:00.000000Z",
      actor: assistant,
      action: "createRequest",
      target: { kind: "request", id: "req-1" },
      requestId: "req-1",
      before: { title: "예전 제목" },
      after: { title: "새 제목" },
      evidence: [{ kind: "revision", id: "rev-1" }],
      reason: "원본의 제목이 바뀌었다",
      appliesTo: null,
    },
  ]);
});

test("쓰기 안에서 읽으면 그 쓰기가 아직 커밋하지 않은 값이 보인다", (t) => {
  const db = openDb(join(makeTempDir(t), "ledger.sqlite"));
  t.after(() => db.close());

  const seen = write(env(db), user, CREATE, (scope) => {
    scope.run(INSERT_REQUEST, "req-1", "첫째", scope.at);
    scope.run(INSERT_REQUEST, "req-2", "둘째", scope.at);
    return {
      one: scope.get("SELECT title FROM requests WHERE id = ?", "req-2")?.title,
      missing: scope.get("SELECT title FROM requests WHERE id = ?", "req-none"),
      all: scope.all("SELECT id FROM requests ORDER BY id").map((row) => row.id),
    };
  });

  assert.deepEqual(seen, { one: "둘째", missing: undefined, all: ["req-1", "req-2"] });
});

test("쓰기 콜백이 Promise를 돌려주면 커밋하지 않고 거부한다. 요청도 변경 이력도 남지 않는다", async (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const db = openDb(path);
  t.after(() => db.close());
  let lateError: unknown;

  assert.throws(
    () =>
      write(
        env(db),
        user,
        CREATE,
        // @ts-expect-error 쓰기 콜백은 동기여야 한다. Promise를 돌려주는 콜백은 타입에서 막는다.
        async (scope) => {
          scope.run(INSERT_REQUEST, "req-async", "기다리기 전에 쓴 요청", scope.at);
          await Promise.resolve();
          try {
            scope.run(INSERT_REQUEST, "req-late", "기다린 뒤에 쓴 요청", scope.at);
          } catch (error) {
            lateError = error;
          }
          scope.record({
            target: { kind: "request", id: "req-async" },
            requestId: "req-async",
            before: null,
            after: { title: "기다리기 전에 쓴 요청" },
          });
        },
      ),
    rejectsWith("async_write"),
  );

  // 기다리기 전에 쓴 값은 커밋되지 않았다.
  assert.equal(db.isTransaction, false);
  assert.equal(countRequests(path), 0);
  assert.deepEqual(changesSince(db, 0), []);

  // 콜백 밖으로 빠져나간 작업은 끝난 쓰기로 값도 변경 이력도 쓸 수 없다.
  await nextTick();
  assert.ok(rejectsWith("write_ended")(lateError), String(lateError));
  assert.equal(countRequests(path), 0);
  assert.deepEqual(changesSince(db, 0), []);

  // 거부한 뒤에도 다음 쓰기는 정상이고 순번은 1부터다.
  write(env(db), user, CREATE, (scope) => {
    scope.run(INSERT_REQUEST, "req-sync", "동기로 쓴 요청", scope.at);
    scope.record({
      target: { kind: "request", id: "req-sync" },
      requestId: "req-sync",
      before: null,
      after: {},
    });
  });
  assert.equal(countRequests(path), 1);
  assert.deepEqual(
    changesSince(db, 0).map((change) => change.seq),
    [1],
  );
});

test("끝난 쓰기의 scope로는 값도 변경 이력도 쓸 수 없다", (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const db = openDb(path);
  t.after(() => db.close());
  let leaked: WriteScope | undefined;
  write(env(db), user, CREATE, (scope) => {
    leaked = scope;
  });
  const scope = leaked as WriteScope;

  assert.throws(
    () => scope.run(INSERT_REQUEST, "req-1", "늦은 요청", scope.at),
    rejectsWith("write_ended"),
  );
  assert.throws(() => scope.get("SELECT 1"), rejectsWith("write_ended"));
  assert.throws(() => scope.all("SELECT 1"), rejectsWith("write_ended"));
  assert.throws(
    () =>
      scope.record({
        target: { kind: "request", id: "req-1" },
        requestId: "req-1",
        before: null,
        after: {},
      }),
    rejectsWith("write_ended"),
  );
  assert.equal(countRequests(path), 0);
  assert.deepEqual(changesSince(db, 0), []);
});

test("쓰기 트랜잭션에 넘긴 콜백이 Promise를 돌려주면 롤백하고 거부한다", async (t) => {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const db = openDb(path);
  t.after(() => db.close());

  assert.throws(
    () =>
      // @ts-expect-error 트랜잭션 콜백은 동기여야 한다.
      inWriteTransaction(db, async () => {
        db.prepare(INSERT_REQUEST).run(
          "req-async",
          "비동기 콜백이 쓴 요청",
          "2026-03-02T09:00:00.000Z",
        );
        throw new Error("나중에 거부되는 Promise");
      }),
    rejectsWith("async_write"),
  );

  // 돌려준 Promise가 거부돼도 처리되지 않은 거부로 번지지 않는다.
  await nextTick();
  assert.equal(db.isTransaction, false);
  assert.equal(countRequests(path), 0);

  // 타입으로는 걸러지지 않는, then만 가진 객체도 실행 중에 Promise로 보고 거부한다.
  // biome-ignore lint/suspicious/noThenProperty: then을 가진 값을 거부하는지 확인하려고 일부러 만든다.
  const thenable = { then: () => undefined };
  assert.throws(() => inWriteTransaction(db, () => thenable), rejectsWith("async_write"));
  assert.equal(db.isTransaction, false);
});

type Done = (value: number) => void;

/** 성공 함수를 부르는 Promise 비슷한 객체를 쓰기 콜백이 돌려줬을 때를 확인한다. */
async function assertThenableRejected(t: TestContext, thenable: { then: (done: Done) => void }) {
  const path = join(makeTempDir(t), "ledger.sqlite");
  const db = openDb(path);
  t.after(() => db.close());
  // 뒤늦게 터지는 오류는 테스트 러너가 경고로만 남기므로, 여기서 직접 모아 확인한다.
  const escaped: unknown[] = [];
  const collect = (error: unknown): void => {
    escaped.push(error);
  };
  process.on("uncaughtException", collect);
  process.on("unhandledRejection", collect);
  t.after(() => {
    process.off("uncaughtException", collect);
    process.off("unhandledRejection", collect);
  });

  assert.throws(
    () =>
      write(env(db), user, CREATE, (scope) => {
        scope.run(INSERT_REQUEST, "req-thenable", "돌려주기 전에 쓴 요청", scope.at);
        scope.record({
          target: { kind: "request", id: "req-thenable" },
          requestId: "req-thenable",
          before: null,
          after: { title: "돌려주기 전에 쓴 요청" },
        });
        return thenable;
      }),
    rejectsWith("async_write"),
  );
  assert.throws(() => inWriteTransaction(db, () => thenable), rejectsWith("async_write"));

  // 다음 이벤트 루프까지 가도 처리되지 않은 오류나 거부가 없고, 요청과 변경 이력은 0건이다.
  await nextTick();
  await nextTick();
  assert.deepEqual(escaped, []);
  assert.equal(db.isTransaction, false);
  assert.equal(countRequests(path), 0);
  assert.deepEqual(changesSince(db, 0), []);
}

test("성공 함수를 바로 부르는 Promise 비슷한 객체를 돌려줘도 async_write로 거부한다", async (t) => {
  // biome-ignore lint/suspicious/noThenProperty: 성공 함수를 바로 부르는 thenable을 일부러 만든다.
  await assertThenableRejected(t, { then: (done) => done(123) });
});

test("성공 함수를 나중에 부르는 Promise 비슷한 객체를 돌려줘도 async_write로 거부하고 뒤늦은 오류가 없다", async (t) => {
  // biome-ignore lint/suspicious/noThenProperty: 성공 함수를 나중에 부르는 thenable을 일부러 만든다.
  await assertThenableRejected(t, { then: (done) => queueMicrotask(() => done(123)) });
});

test("Promise 비슷한 객체를 거부한 프로세스는 다음 이벤트 루프까지 살아 있고 정상으로 끝난다", () => {
  // 처리되지 않은 오류는 프로세스를 죽이므로, 따로 띄운 프로세스의 종료 코드로 확인한다.
  const dbModule = JSON.stringify(new URL("./db.ts", import.meta.url).href);
  const script = [
    'import { DatabaseSync } from "node:sqlite";',
    `import { inWriteTransaction } from ${dbModule};`,
    'const db = new DatabaseSync(":memory:");',
    'db.exec("CREATE TABLE requests (id TEXT)");',
    "const thenables = [",
    "  { then: (done) => done(123) },",
    "  { then: (done) => queueMicrotask(() => done(123)) },",
    "];",
    "for (const thenable of thenables) {",
    "  try {",
    "    inWriteTransaction(db, () => {",
    "      db.exec(\"INSERT INTO requests (id) VALUES ('req-thenable')\");",
    "      return thenable;",
    "    });",
    '    console.log("no error");',
    "  } catch (error) {",
    "    console.log(String(error.code));",
    "  }",
    "}",
    "setImmediate(() => {",
    '  const row = db.prepare("SELECT count(*) AS count FROM requests").get();',
    '  console.log("rows " + row.count);',
    '  console.log("alive");',
    "});",
  ].join("\n");

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "async_write",
    "async_write",
    "rows 0",
    "alive",
  ]);
});
