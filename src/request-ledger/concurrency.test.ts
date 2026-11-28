// 작업 3(여러 프로세스의 동시 쓰기, S28 앞부분)을 확인한다.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { WriteResult } from "./concurrency-writer.ts";
import { BUSY_TIMEOUT_MS, openDb } from "./db.ts";
import { openLedger } from "./index.ts";
import { MIGRATIONS } from "./migrations.ts";
import {
  createCurrentFileWithoutWal,
  type FinishedWorker,
  HELD_REQUEST_ID,
  makeTempDir,
  startWorker,
  WORKER_TEST_TIMEOUT_MS,
} from "./test-support.ts";
import type { JsonValue } from "./types.ts";

/** 끝난 쓰기 프로세스가 마지막 줄에 찍은 결과를 읽고, 잠금 때문에 실패한 쓰기가 없는지 본다. */
function assertAllWritten(result: FinishedWorker, count: number, label = ""): WriteResult {
  assert.equal(
    result.code,
    0,
    `${label}code ${result.code}, signal ${result.signal}: ${result.stderr}`,
  );
  assert.equal(result.stderr, "", label);
  const summary = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as WriteResult;
  assert.deepEqual(summary.failures, [], label);
  assert.equal(summary.written, count, label);
  return summary;
}

function titleOf(after: JsonValue): string {
  const title = (after as { title?: { value?: unknown } } | null)?.title?.value;
  assert.equal(typeof title, "string");
  return title as string;
}

/** 원장을 거치지 않고, 커밋된 요청의 id를 저장된 순서로 읽는다. */
function committedRequestIds(path: string): string[] {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    return raw
      .prepare("SELECT id FROM requests ORDER BY rowid")
      .all()
      .map((row) => String(row.id));
  } finally {
    raw.close();
  }
}

function isBusyError(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  return typeof errcode === "number" && (errcode & 0xff) === 5;
}

/** 대기 시간 0으로 쓰기 잠금을 시도해 본다. 얻어도 아무것도 쓰지 않고 놓는다. */
function probeWriteLock(path: string): "busy" | "acquired" {
  const probe = new DatabaseSync(path, { timeout: 0 });
  try {
    probe.exec("BEGIN IMMEDIATE");
    probe.exec("ROLLBACK");
    return "acquired";
  } catch (error) {
    if (isBusyError(error)) {
      return "busy";
    }
    throw error;
  } finally {
    probe.close();
  }
}

test("S28: 두 프로세스가 각각 200번씩 쓰면 400건이 모두 저장되고 순번이 빠지거나 겹치지 않는다", {
  timeout: WORKER_TEST_TIMEOUT_MS,
}, async (t) => {
  const home = makeTempDir(t);
  const path = join(home, "ledger.sqlite");
  const names = ["writer-a", "writer-b"] as const;
  const count = 200;
  openLedger({ path }).close();

  // 두 프로세스가 모두 원장을 연 뒤에 시작한다. 첫째가 먼저 쓰기 잠금을 쥐는 쪽, 둘째가 겨루는 쪽이다.
  const [holderName, contenderName] = names;
  const holder = startWorker(["holder", holderName, String(count)], home);
  const contender = startWorker(["contender", contenderName, String(count)], home);
  t.after(() => {
    holder.kill();
    contender.kill();
  });
  await Promise.all([holder.waitForLine("ready"), contender.waitForLine("ready")]);

  // 먼저 쓰는 쪽이 첫 쓰기에서 쓰기 잠금을 쥔 채 멈춘다.
  holder.send("go");
  await holder.waitForLine("holding");

  // 그동안 겨루는 쪽이 같은 파일의 쓰기 잠금을 대기 시간 0으로 시도해, 실제로 SQLITE_BUSY를 받는다.
  // 이 시도는 아무것도 쓰지 않으므로 아래에서 세는 400건에 들지 않는다.
  contender.send("go");
  assert.equal(await contender.waitForLineStartingWith("probe "), "probe busy");

  // 잠금을 놓으면 먼저 쓰는 쪽은 첫 요청을 커밋하고, 두 번째 요청을 쓰지 않은 채 멈춰 기다린다.
  // 겨루는 쪽이 첫 요청을 커밋했다는 신호가 온 뒤에야 다시 움직이게 한다. 그래서 한쪽이 200건을
  // 다 쓸 때까지 다른 쪽이 쓰지 못한 실행은 여기를 지나갈 수 없다. 시간을 재서 판정하는 것은 없다.
  holder.send("release");
  await Promise.all([
    holder.waitForLine("first committed"),
    contender.waitForLine("first committed"),
  ]);
  holder.send("continue");
  const results = await Promise.all([holder.finished(), contender.finished()]);

  // 잠금 때문에 실패한 쓰기가 없다.
  assertAllWritten(results[0], count, "먼저 쓰는 쪽: ");
  assertAllWritten(results[1], count, "겨루는 쪽: ");

  const ledger = openLedger({ path });
  t.after(() => ledger.close());
  const changes = ledger.changesSince(0);

  // 400건이 모두 변경 이력에 있고, 순번은 1부터 400까지 하나씩이다.
  assert.equal(changes.length, names.length * count);
  assert.deepEqual(
    changes.map((change) => change.seq),
    Array.from({ length: names.length * count }, (_, index) => index + 1),
  );
  // 두 프로세스의 쓰기가 맞물렸다. 먼저 잠금을 쥔 쪽의 첫 요청이 첫 순번이고,
  // 겨루는 쪽의 첫 요청이 먼저 쓰는 쪽의 두 번째 요청보다 앞선 순번이다.
  const seqOf = (title: string): number => {
    const change = changes.find((candidate) => titleOf(candidate.after) === title);
    assert.ok(change, `${title}의 변경 이력이 없다`);
    return change.seq;
  };
  assert.equal(seqOf(`${holderName}-1`), 1);
  assert.ok(
    seqOf(`${contenderName}-1`) < seqOf(`${holderName}-2`),
    `겨루는 쪽의 첫 순번 ${seqOf(`${contenderName}-1`)}, 먼저 쓰는 쪽의 두 번째 순번 ${seqOf(`${holderName}-2`)}`,
  );

  // 프로세스마다 200건이 쓴 순서대로 빠짐없이 한 번씩 있다.
  for (const name of names) {
    const titles = changes
      .filter((change) => change.actor.kind === "assistant" && change.actor.module === name)
      .map((change) => titleOf(change.after));
    assert.deepEqual(
      titles,
      Array.from({ length: count }, (_, index) => `${name}-${index + 1}`),
    );
  }

  // 값도 400건이 저장됐고, 변경 이력의 대상과 하나씩 맞는다.
  const requestIds = committedRequestIds(path);
  assert.equal(requestIds.length, names.length * count);
  assert.deepEqual(requestIds.toSorted(), changes.map((change) => change.target.id).toSorted());
});

test("원장 파일이 없을 때 여러 프로세스가 동시에 처음 열어도 모두 열리고 쓴다", {
  timeout: WORKER_TEST_TIMEOUT_MS,
}, async (t) => {
  // WAL 모드로 바꾸는 순간이 겹쳐야 드러나는 문제라, 새 파일로 여러 번 되풀이한다.
  const rounds = 8;
  const names = ["opener-a", "opener-b", "opener-c", "opener-d"] as const;
  const count = 5;

  for (let round = 1; round <= rounds; round += 1) {
    const home = makeTempDir(t);
    const workers = names.map((name) => startWorker(["race", name, String(count)], home));
    t.after(() => {
      for (const worker of workers) {
        worker.kill();
      }
    });
    await Promise.all(workers.map((worker) => worker.waitForLine("ready")));
    for (const worker of workers) {
      worker.send("go");
    }
    const results = await Promise.all(workers.map((worker) => worker.finished()));

    for (const result of results) {
      assertAllWritten(result, count, `${round}번째: `);
    }
    const ledger = openLedger({ path: join(home, "ledger.sqlite") });
    const seqs = ledger.changesSince(0).map((change) => change.seq);
    ledger.close();
    assert.deepEqual(
      seqs,
      Array.from({ length: names.length * count }, (_, index) => index + 1),
      `${round}번째`,
    );
  }
});

test("S28: 다른 프로세스가 쓰기 잠금을 잡고 있으면 실패하지 않고 기다렸다가 쓴다", {
  timeout: WORKER_TEST_TIMEOUT_MS,
}, async (t) => {
  const home = makeTempDir(t);
  const path = join(home, "ledger.sqlite");
  const lingerMs = 300;
  assert.ok(lingerMs < BUSY_TIMEOUT_MS);
  openLedger({ path }).close();

  // 잠금을 쥔 프로세스는 요청과 그 변경 이력을 쓰고, 커밋하지 않은 채 "release"를 기다린다.
  // 이쪽이 조회를 마쳤다고 알리기 전에는 잠금이 풀리지 않으므로, 여는 일과 조회가 느려도 결과가 같다.
  const holder = startWorker(["hold", path, String(lingerMs)], home);
  t.after(() => holder.kill());
  await holder.waitForLine("locked");

  // 잠금이 잡혀 있는 동안에도 열고 읽을 수 있다. 커밋되지 않은 요청과 변경 이력은 보이지 않는다.
  const ledger = openLedger({ path });
  t.after(() => ledger.close());
  assert.deepEqual(ledger.changesSince(0), []);
  assert.deepEqual(committedRequestIds(path), []);
  // 쓰기 직전에도 잠금이 실제로 잡혀 있다. 대기 시간 0으로 시도하면 바로 SQLITE_BUSY다.
  assert.equal(probeWriteLock(path), "busy");

  // 조회를 마쳤다고 알리고 바로 쓴다. 잠금을 쥔 쪽은 신호를 받은 뒤에도 잠깐 더 쥐고 있다가 커밋한다.
  holder.send("release");
  const startedAt = performance.now();
  const created = ledger.createRequest(
    { kind: "user", via: "skill" },
    { stated: { title: "기다렸다 쓴 요청" } },
  );
  // 기다린 시간은 진단에만 쓴다. 느린 환경에서 정상 쓰기를 실패시키지 않도록 이 값으로 판정하지 않는다.
  t.diagnostic(`쓰기 잠금을 기다린 시간 ${(performance.now() - startedAt).toFixed(0)}ms`);

  // 잠금 오류 없이 썼고, 잠금을 쥐었던 쪽이 쓴 바로 그 요청과 변경 이력이 앞 순번으로 보인다.
  assert.deepEqual(
    ledger.changesSince(0).map((change) => [change.seq, change.target.id]),
    [
      [1, HELD_REQUEST_ID],
      [2, created.id],
    ],
  );
  assert.deepEqual(committedRequestIds(path), [HELD_REQUEST_ID, created.id]);
  const held = await holder.finished();
  assert.equal(held.code, 0, held.stderr);
});

test("WAL로 바꾸려고 다시 시도하는 시간은 잠금이 도중에 바뀌어도 모두 합쳐 busy timeout을 넘지 않는다", {
  timeout: WORKER_TEST_TIMEOUT_MS,
}, async (t) => {
  const home = makeTempDir(t);
  const path = join(home, "ledger.sqlite");
  const budgetMs = 1000;
  const reservedMs = 600;
  // 올릴 것이 없는 최신 버전의 파일이라, 여는 쪽은 WAL로 바꾸는 일만 한다.
  // WAL이 아닌 파일에 읽는 연결이 끝까지 붙어 있고, 다른 프로세스의 쓰기 예약은 도중에 풀린다.
  // 예약이 걸린 동안에는 전환이 바로 실패하고, 예약이 풀린 뒤에는 SQLite가 읽는 연결을 기다리려 한다.
  createCurrentFileWithoutWal(path);
  const reader = new DatabaseSync(path);
  t.after(() => reader.close());
  reader.exec("BEGIN; SELECT count(*) FROM requests;");
  const reserver = startWorker(["reserve", path, String(reservedMs)], home);
  t.after(() => reserver.kill());
  await reserver.waitForLine("locked");

  const startedAt = performance.now();
  assert.throws(() => openDb(path, { busyTimeoutMs: budgetMs }), isBusyError);
  const elapsedMs = performance.now() - startedAt;

  // 예약이 풀린 뒤에 기다림을 새로 시작했다면 reservedMs + budgetMs가 걸린다.
  assert.ok(elapsedMs >= budgetMs - 20, `${elapsedMs.toFixed(0)}ms 만에 끝났다`);
  assert.ok(elapsedMs < budgetMs + 250, `${elapsedMs.toFixed(0)}ms가 걸렸다`);
  const reserved = await reserver.finished();
  assert.equal(reserved.code, 0, reserved.stderr);
});

test("S29: 정상인 예전 버전의 파일을 여러 프로세스가 시차를 두고 열어도 모두 열리고, 한 번만 올라간다", {
  timeout: WORKER_TEST_TIMEOUT_MS,
}, async (t) => {
  // 한 프로세스가 올리는 동안 나머지가 버전을 읽고 잠금을 기다리게, 줄을 넉넉히 넣고 조금씩 늦게 시작시킨다.
  const requests = 4000;
  const processes = 9;
  const staggerMs = 9;
  const cases = [
    { name: "버전 2, WAL 모드", version: 2, wal: true },
    { name: "버전 2, WAL이 아닌 파일", version: 2, wal: false },
    { name: "버전 1, WAL 모드", version: 1, wal: true },
    { name: "버전 1, WAL이 아닌 파일", version: 1, wal: false },
  ];

  for (const { name, version, wal } of cases) {
    const home = makeTempDir(t);
    const path = join(home, "ledger.sqlite");
    // 예전 버전의 파일을 그 버전의 형태로 고정한 SQL로 만든다. 시각은 밀리초 형태다.
    const old = new DatabaseSync(path);
    if (wal) {
      old.exec("PRAGMA journal_mode = WAL");
    }
    old.exec(
      MIGRATIONS.slice(0, version)
        .map((migration) => migration.sql)
        .join("\n"),
    );
    const insertChange = old.prepare(
      `INSERT INTO changes
         (at, actor, target_kind, target_id, before_value, after_value, evidence)
       VALUES (?, '{"kind":"user","via":"web"}', 'request', ?, 'null', '{"title":"R"}', '[]')`,
    );
    const insertRequest =
      version >= 2
        ? old.prepare("INSERT INTO requests (id, title, created_at) VALUES (?, 'R', ?)")
        : undefined;
    const millisecondTime = (index: number) => new Date(Date.UTC(2026, 0, 1) + index).toISOString();
    old.exec("BEGIN");
    for (let index = 0; index < requests; index += 1) {
      insertChange.run(millisecondTime(index), `r${index}`);
      insertRequest?.run(`r${index}`, millisecondTime(index));
    }
    old.exec(`COMMIT; PRAGMA user_version = ${version}`);
    old.close();

    // "race"는 "go"를 받은 뒤에 원장을 연다. 쓰는 횟수는 0이라 여는 일만 한다.
    const workers = Array.from({ length: processes }, (_, index) =>
      startWorker(["race", `opener-${index}`, "0"], home),
    );
    t.after(() => {
      for (const worker of workers) {
        worker.kill();
      }
    });
    await Promise.all(workers.map((worker) => worker.waitForLine("ready")));
    workers.forEach((worker, index) => {
      setTimeout(() => worker.send("go"), index * staggerMs);
    });
    const results = await Promise.all(workers.map((worker) => worker.finished()));

    // 잘못 거부된 프로세스가 없다.
    results.forEach((result, index) => {
      assertAllWritten(result, 0, `${name}, ${index}번째 프로세스: `);
    });
    // 한 번만 올라갔다. 시각이 두 번 옮겨지지 않았고 줄도 그대로다.
    const raw = new DatabaseSync(path, { readOnly: true });
    try {
      const moved = (index: number) => `${millisecondTime(index).slice(0, 23)}000Z`;
      assert.equal(raw.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length, name);
      assert.equal(raw.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal", name);
      assert.deepEqual(
        {
          ...raw
            .prepare("SELECT count(*) AS count, min(at) AS first, max(at) AS last FROM changes")
            .get(),
        },
        { count: requests, first: moved(0), last: moved(requests - 1) },
        name,
      );
      assert.equal(
        raw.prepare("SELECT count(*) AS count FROM changes WHERE length(at) <> 27").get()?.count,
        0,
        name,
      );
      assert.deepEqual(
        { ...raw.prepare("SELECT count(*) AS count, max(created_at) AS last FROM requests").get() },
        version >= 2 ? { count: requests, last: moved(requests - 1) } : { count: 0, last: null },
        name,
      );
    } finally {
      raw.close();
    }
  }
});

test("자식 프로세스가 신호로 죽으면 줄을 기다리던 쪽이 바로 실패한다", {
  timeout: WORKER_TEST_TIMEOUT_MS,
}, async (t) => {
  const worker = startWorker(["race", "killed", "1"], makeTempDir(t));
  t.after(() => worker.kill());
  await worker.waitForLine("ready");

  worker.kill("SIGKILL");

  await assert.rejects(worker.waitForLine("never-printed"), /signal SIGKILL/);
  assert.deepEqual(await worker.finished().then(({ code, signal }) => ({ code, signal })), {
    code: null,
    signal: "SIGKILL",
  });
});
