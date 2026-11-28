// 작업 1(프로젝트 뼈대)의 완료 조건을 확인한다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as ledgerModule from "./index.ts";
import { makeTempDir } from "./test-support.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as PackageJson;
}

test("package.json의 스크립트가 공통 규약의 명령 절과 같다", () => {
  assert.deepEqual(readPackageJson().scripts, {
    test: 'node --test "src/**/*.test.ts" "tests/**/*.test.ts"',
    typecheck: "tsc --noEmit",
    lint: "biome check .",
    format: "biome check --write .",
    check: "npm run typecheck && npm run lint && npm test",
  });
});

test("실행 의존성은 없고 개발 의존성은 셋이다", () => {
  const pkg = readPackageJson();
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}).sort(), [
    "@biomejs/biome",
    "@types/node",
    "typescript",
  ]);
});

test("tsc가 지워지지 않는 문법과 확장자 없는 import를 오류로 잡는다", (t) => {
  const dir = makeTempDir(t);
  const sources: Record<string, string> = {
    "valid.ts": 'export type Level = "high" | "low";\nexport const level: Level = "high";\n',
    "with-extension.ts": 'import { level } from "./valid.ts";\n\nexport const copy = level;\n',
    "enum.ts": "export enum Level {\n  High,\n  Low,\n}\n",
    "namespace.ts": "export namespace Ledger {\n  export const version = 1;\n}\n",
    "parameter-property.ts": "export class Hold {\n  constructor(readonly id: string) {}\n}\n",
    "extensionless-import.ts": 'import { level } from "./valid";\n\nexport const copy = level;\n',
  };
  for (const [name, source] of Object.entries(sources)) {
    writeFileSync(join(dir, name), source);
  }
  // 저장소처럼 ESM 패키지로 두고 저장소의 tsconfig.json을 그대로 물려받아, 저장소의 설정이 잡는지를 본다.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      extends: join(repoRoot, "tsconfig.json"),
      compilerOptions: { types: [] },
      include: ["*.ts"],
    }),
  );

  const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tsc, "--project", dir, "--pretty", "false"], {
    encoding: "utf8",
  });
  const output = `${result.stdout}${result.stderr}`;
  const errorCodesOf = (name: string): string[] =>
    output
      .split("\n")
      .filter((line) => line.includes(`${name}(`))
      .map((line) => /error (TS\d+)/.exec(line)?.[1] ?? "");

  assert.notEqual(result.status, 0, output);
  assert.deepEqual(errorCodesOf("valid.ts"), [], output);
  assert.deepEqual(errorCodesOf("with-extension.ts"), [], output);
  // TS1294: erasableSyntaxOnly에서 쓸 수 없는 문법
  assert.deepEqual(errorCodesOf("enum.ts"), ["TS1294"], output);
  assert.deepEqual(errorCodesOf("namespace.ts"), ["TS1294"], output);
  assert.deepEqual(errorCodesOf("parameter-property.ts"), ["TS1294"], output);
  // TS2835: 상대 경로 import에 확장자가 없다
  assert.deepEqual(errorCodesOf("extensionless-import.ts"), ["TS2835"], output);
});

test(".gitignore가 node_modules와 로컬 데이터 파일을 제외한다", () => {
  const paths = [
    "node_modules/typescript/package.json",
    "ledger.sqlite",
    "ledger.sqlite-wal",
    "ledger.sqlite-shm",
    "data/ledger.sqlite",
  ];
  // --no-index: 이미 추적 중인 파일인지와 상관없이 무시 규칙만 본다.
  const result = spawnSync("git", ["check-ignore", "--no-index", ...paths], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.deepEqual(result.stdout.trim().split("\n"), paths, result.stderr);

  const tracked = spawnSync("git", ["check-ignore", "--no-index", "src/request-ledger/index.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(tracked.stdout.trim(), "", "소스 파일은 제외하지 않는다");
});

test("공개 계약: index.ts는 openLedger와 LedgerError만 값으로 내보낸다", () => {
  assert.deepEqual(Object.keys(ledgerModule).sort(), ["LedgerError", "openLedger"]);
  assert.equal(typeof ledgerModule.openLedger, "function");
  assert.ok(new ledgerModule.LedgerError("ledger_closed", "확인용") instanceof Error);
});

test("공개 계약: 나머지 함수는 openLedger가 돌려준 원장 객체의 메서드다", (t) => {
  const ledger = ledgerModule.openLedger({ path: ":memory:" });
  t.after(() => ledger.close());

  // 스펙의 공개 계약 표에 있는 이름만 둔다. 작업이 함수를 더하면 이 목록에도 더한다.
  assert.deepEqual(Object.keys(ledger).sort(), [
    "addNotice",
    "addRevision",
    "addTask",
    "attachMaterial",
    "cancelTask",
    "changesSince",
    "clearTurn",
    "close",
    "completeTask",
    "createRequest",
    "getRequest",
    "linkRecord",
    "listNotices",
    "listRequests",
    "markNoticeDelivered",
    "markNoticeSeen",
    "placeHold",
    "raiseOpenItem",
    "releaseHold",
    "replaceMaterial",
    "resolveOpenItem",
    "setOrder",
    "setPriority",
    "setProgress",
    "setTurn",
    "updateRequest",
    "updateTask",
  ]);
  for (const method of Object.values(ledger)) {
    assert.equal(typeof method, "function");
  }
});

test("공개 계약: 한 프로세스에서 원장을 여럿 열 수 있고 하나를 닫아도 다른 것은 열려 있다", (t) => {
  const first = ledgerModule.openLedger({ path: ":memory:", newId: () => "req-first" });
  const second = ledgerModule.openLedger({ path: ":memory:", newId: () => "req-second" });
  t.after(() => second.close());
  const user = { kind: "user", via: "web" } as const;
  first.createRequest(user, { stated: { title: "첫째 원장의 요청" } });

  // close는 값을 돌려주지 않고, 두 번 닫아도 오류가 아니다.
  assert.equal(first.close(), undefined);
  assert.equal(first.close(), undefined);

  // 닫은 뒤의 읽기와 쓰기는 ledger_closed 오류다.
  const isClosedError = (error: unknown) =>
    error instanceof ledgerModule.LedgerError && error.code === "ledger_closed";
  assert.throws(() => first.changesSince(0), isClosedError);
  assert.throws(
    () => first.createRequest(user, { stated: { title: "닫은 뒤의 요청" } }),
    isClosedError,
  );
  assert.throws(() => first.getRequest("req-first"), isClosedError);
  assert.throws(() => first.listRequests(), isClosedError);
  assert.throws(() => first.listNotices(), isClosedError);

  // 다른 원장은 그대로 읽고 쓴다. 경로와 id 생성은 원장마다 따로다.
  assert.equal(
    second.createRequest(user, { stated: { title: "둘째 원장의 요청" } }).id,
    "req-second",
  );
  assert.deepEqual(
    second.changesSince(0).map((change) => change.target.id),
    ["req-second"],
  );
});
