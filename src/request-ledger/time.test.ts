// 작업 4 가운데 시각의 저장 형태를 확인한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LedgerError } from "./errors.ts";
import { clockTime, externalTime } from "./time.ts";

/** 저장하는 시각의 형태. UTC, 마이크로초 여섯 자리다. */
const STORED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function rejectsAsInvalidTime(error: unknown): boolean {
  return error instanceof LedgerError && error.code === "invalid_time";
}

test("원장의 시계가 준 시각은 UTC로, 뒤 세 자리를 000으로 채운 마이크로초 여섯 자리로 적는다", () => {
  assert.equal(clockTime(new Date("2026-11-28T03:04:05.678Z")), "2026-11-28T03:04:05.678000Z");
  assert.equal(clockTime(new Date("2026-11-28T12:04:05+09:00")), "2026-11-28T03:04:05.000000Z");
  assert.throws(() => clockTime(new Date(Number.NaN)), rejectsAsInvalidTime);
});

test("밖에서 받은 시각은 Date이거나 시간대가 붙은 ISO 8601 문자열이고, 한 가지 형태로 바뀐다", () => {
  const cases: [unknown, string][] = [
    [new Date("2026-11-28T03:04:05.678Z"), "2026-11-28T03:04:05.678000Z"],
    ["2026-11-28T03:04:05Z", "2026-11-28T03:04:05.000000Z"],
    ["2026-11-28T03:04Z", "2026-11-28T03:04:00.000000Z"],
    ["2026-11-28T03:04:05.6Z", "2026-11-28T03:04:05.600000Z"],
    ["2026-11-28T03:04:05.678Z", "2026-11-28T03:04:05.678000Z"],
    ["2026-11-28T03:04:05.678901Z", "2026-11-28T03:04:05.678901Z"],
    // 시간대가 붙은 시각은 UTC로 옮기고, 마이크로초는 그대로 남는다.
    ["2026-11-28T12:04:05.000001+09:00", "2026-11-28T03:04:05.000001Z"],
    ["2026-11-28T12:04:05+0900", "2026-11-28T03:04:05.000000Z"],
    ["2026-11-27T22:04:05-05", "2026-11-28T03:04:05.000000Z"],
    ["2026-12-31T23:30:00.999999-01:00", "2027-01-01T00:30:00.999999Z"],
    ["0000-01-01T00:00:00Z", "0000-01-01T00:00:00.000000Z"],
    ["0099-03-01T00:00:00Z", "0099-03-01T00:00:00.000000Z"],
    ["9999-12-31T23:59:59.999999Z", "9999-12-31T23:59:59.999999Z"],
    ["2028-02-29T00:00:00Z", "2028-02-29T00:00:00.000000Z"],
  ];
  for (const [given, stored] of cases) {
    assert.equal(externalTime(given, "원본 시각"), stored, String(given));
    assert.match(stored, STORED);
  }
});

test("저장한 형태는 길이가 같아 문자열 비교가 곧 시각 비교다", () => {
  const earlier = externalTime("2026-11-28T03:04:05.1Z", "원본 시각");
  const later = externalTime("2026-11-28T03:04:05.100001Z", "원본 시각");
  const muchLater = externalTime("2026-11-28T12:04:06+09:00", "원본 시각");

  assert.equal(earlier.length, later.length);
  assert.ok(earlier < later);
  assert.ok(later < muchLater);
});

test("시간대가 없는 시각은 거부한다", () => {
  for (const given of ["2026-11-28T03:04:05", "2026-11-28T03:04:05.678", "2026-11-28T03:04"]) {
    assert.throws(() => externalTime(given, "기한"), rejectsAsInvalidTime, given);
  }
});

test("마이크로초보다 잘게 적힌 시각은 줄이지 않고 거부한다", () => {
  for (const given of [
    "2026-11-28T03:04:05.6789012Z",
    "2026-11-28T03:04:05.678901234Z",
    "2026-11-28T03:04:05.0000001Z",
    "2026-11-28T03:04:05.678901000100+09:00",
  ]) {
    assert.throws(() => externalTime(given, "원본 시각"), rejectsAsInvalidTime, given);
  }
});

test("일곱째 자리부터가 모두 0이면 잃는 것이 없으므로 받는다", () => {
  assert.equal(
    externalTime("2026-11-28T03:04:05.6789010Z", "원본 시각"),
    "2026-11-28T03:04:05.678901Z",
  );
  assert.equal(
    externalTime("2026-11-28T03:04:05.000000000Z", "원본 시각"),
    "2026-11-28T03:04:05.000000Z",
  );
});

test("시각으로 읽을 수 없는 값은 거부한다", () => {
  const invalid: unknown[] = [
    undefined,
    null,
    1_764_299_045_678,
    "",
    "내일",
    "2026-11-28",
    "2026-11-28 03:04:05Z",
    "2026-13-01T00:00:00Z",
    "2026-02-30T00:00:00Z",
    "2027-02-29T00:00:00Z",
    "2026-11-28T24:00:00Z",
    "2026-11-28T03:60:00Z",
    "2026-11-28T03:04:60Z",
    "2026-11-28T03:04:05.Z",
    "2026-11-28T03:04:05+24:00",
    "2026-11-28T03:04:05+09:60",
    "26-11-28T03:04:05Z",
    "+002026-11-28T03:04:05Z",
    new Date(Number.NaN),
    new Date(Date.UTC(10_000, 0, 1)),
    // UTC로 옮기면 연도가 0000~9999를 벗어난다.
    "9999-12-31T23:59:59-01:00",
    "0000-01-01T00:00:00+01:00",
  ];
  for (const given of invalid) {
    assert.throws(() => externalTime(given, "원본 시각"), rejectsAsInvalidTime, String(given));
  }
});

test("오류에 어느 값이 틀렸는지 나온다", () => {
  assert.throws(
    () => externalTime("2026-11-28T03:04:05", "기한"),
    (error) => error instanceof LedgerError && /기한/.test(error.message),
  );
});
