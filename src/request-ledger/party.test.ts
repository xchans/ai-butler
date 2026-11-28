// 작업 6 가운데 주체(party)의 형태와 같은 주체인지 가리는 규칙을 확인한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LedgerError } from "./errors.ts";
import { checkedParty, partyKey, sameParty } from "./party.ts";
import type { Party } from "./types.ts";

const withId: Party = { kind: "person", name: "김지원", source: "slack", externalId: "U0000001" };

test("식별자가 있는 주체와 이름만 같은 주체는 다른 주체다", () => {
  const nameOnly: Party = { kind: "person", name: "김지원" };

  assert.equal(sameParty(withId, nameOnly), false);
  assert.equal(sameParty(nameOnly, withId), false);
  assert.notEqual(partyKey(withId), partyKey(nameOnly));
});

test("종류가 같고 출처와 식별자가 같으면 이름의 표기가 달라도 같은 주체다", () => {
  const otherSpelling: Party = { ...withId, name: "Jiwon Kim" };

  assert.equal(sameParty(withId, otherSpelling), true);
});

test("출처나 식별자, 종류가 다르면 이름이 같아도 다른 주체다", () => {
  assert.equal(sameParty(withId, { ...withId, source: "jira" }), false);
  assert.equal(sameParty(withId, { ...withId, externalId: "U0000002" }), false);
  assert.equal(sameParty(withId, { ...withId, kind: "agent" }), false);
});

test("둘 다 식별자가 없으면 종류와 이름으로 가린다", () => {
  const team: Party = { kind: "team", name: "CS팀" };

  assert.equal(sameParty(team, { kind: "team", name: "CS팀" }), true);
  assert.equal(sameParty(team, { kind: "team", name: "CS 팀" }), false);
  assert.equal(sameParty(team, { kind: "person", name: "CS팀" }), false);
});

test("사용자는 한 사람이고, 이름이 사용자와 같아도 종류가 사람이면 사용자가 아니다", () => {
  assert.equal(sameParty({ kind: "user" }, { kind: "user" }), true);
  assert.equal(sameParty({ kind: "user" }, { kind: "person", name: "user" }), false);
});

test("주체 키는 종류와, 식별자가 있으면 출처와 식별자, 없으면 이름을 적은 JSON 배열이다", () => {
  assert.equal(partyKey(withId), '["person","id","slack","U0000001"]');
  assert.equal(partyKey({ kind: "team", name: "CS팀" }), '["team","name","CS팀"]');
  assert.equal(partyKey({ kind: "user" }), '["user"]');
  // 이름에 구분 문자가 들어 있어도 식별자가 있는 주체의 키와 겹치지 않는다.
  assert.notEqual(partyKey({ kind: "person", name: 'id","slack","U0000001' }), partyKey(withId));
});

test("주체의 형태를 확인하고 저장할 형태로 돌려준다", () => {
  assert.deepEqual(checkedParty({ kind: "user" }, "담당"), { kind: "user" });
  assert.deepEqual(checkedParty({ kind: "team", name: "CS팀" }, "담당"), {
    kind: "team",
    name: "CS팀",
  });
  // 항목의 순서가 달라도 저장하는 형태는 하나다.
  assert.equal(
    JSON.stringify(
      checkedParty(
        { externalId: "U0000001", source: "slack", name: "김지원", kind: "person" },
        "담당",
      ),
    ),
    '{"kind":"person","name":"김지원","source":"slack","externalId":"U0000001"}',
  );
});

test("형태가 틀린 주체는 거부한다. 출처와 식별자는 둘 다 있거나 둘 다 없다", () => {
  const invalid: unknown[] = [
    undefined,
    null,
    "김지원",
    [],
    {},
    { kind: "bot", name: "봇" },
    { kind: "person" },
    { kind: "person", name: "" },
    { kind: "person", name: "  " },
    { kind: "person", name: "김지원", source: "slack" },
    { kind: "person", name: "김지원", externalId: "U0000001" },
    { kind: "person", name: "김지원", source: "", externalId: "U0000001" },
    { kind: "user", name: "나" },
    { kind: "user", source: "slack", externalId: "U0000009" },
    { kind: "team", name: "CS팀", email: "cs@example.test" },
  ];
  for (const value of invalid) {
    assert.throws(
      () => checkedParty(value, "요청자"),
      (error) =>
        error instanceof LedgerError &&
        error.code === "invalid_party" &&
        /요청자/.test(error.message),
      JSON.stringify(value),
    );
  }
});
