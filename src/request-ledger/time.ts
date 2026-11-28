// 시각의 저장 형태를 정하는 한 곳이다. 모든 시각은 UTC이고 마이크로초 여섯 자리까지 적은 한 가지 형태로만 저장한다.
//   2026-11-28T03:04:05.678000Z
// 길이와 형태가 같아 문자열 비교가 곧 시각 비교다.
import { LedgerError } from "./errors.ts";

/**
 * 밖에서 받는 ISO 8601 시각. 날짜와 시각을 `T`로 잇고 시간대(`Z`나 `+09:00`)를 붙인 형태만 받는다.
 * 초 아래 자릿수는 여기서 세지 않고 아래에서 따로 본다. 오류에 이유를 밝히려는 것이다.
 */
const EXTERNAL =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

const MS_PER_MINUTE = 60_000;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** 밀리초 시각과 그 아래 마이크로초 세 자리를 저장 형태로 적는다. 연도가 0000~9999를 벗어나면 undefined. */
function formatUtc(epochMs: number, microDigits: string): string | undefined {
  const date = new Date(epochMs);
  const year = date.getUTCFullYear();
  if (Number.isNaN(year) || year < 0 || year > 9999) {
    return undefined;
  }
  return (
    `${pad(year, 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}` +
    `T${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}` +
    `.${pad(date.getUTCMilliseconds(), 3)}${microDigits}Z`
  );
}

function invalidTime(what: string, why: string): LedgerError {
  return new LedgerError("invalid_time", `${what}: ${why}`);
}

function fromDate(date: Date, what: string): string {
  const stored = formatUtc(date.getTime(), "000");
  if (stored === undefined) {
    throw invalidTime(what, "시각으로 읽을 수 없거나 연도가 0000~9999를 벗어난다");
  }
  return stored;
}

/** 원장의 시계가 준 시각을 저장 형태로 바꾼다. 시계는 밀리초까지 주므로 뒤 세 자리는 000이다. */
export function clockTime(now: Date): string {
  return fromDate(now, "원장의 시계가 준 시각");
}

/**
 * 밖에서 받은 시각(원본 시각, 기한 등)을 저장 형태로 바꾼다. `Date`이거나 시간대가 붙은 ISO 8601 문자열이어야 한다.
 * 시간대가 없거나, 시각으로 읽을 수 없거나, 마이크로초보다 잘게 적힌 값은 줄이지 않고 거부한다.
 * 소수점 아래 일곱째 자리부터가 모두 0인 값은 잃는 것이 없으므로 받는다.
 * `what`은 오류에 적을 값의 이름이다.
 */
export function externalTime(value: unknown, what: string): string {
  if (value instanceof Date) {
    return fromDate(value, what);
  }
  if (typeof value !== "string") {
    throw invalidTime(what, "시각은 Date이거나 시간대가 붙은 ISO 8601 문자열이어야 한다");
  }
  const match = EXTERNAL.exec(value);
  if (match === null) {
    throw invalidTime(what, `시각으로 읽을 수 없다 (${value})`);
  }
  const [, year, month, day, hour, minute, second = "00", fraction = "", zone] = match;
  if (zone === undefined) {
    throw invalidTime(what, `시간대가 없는 시각은 받지 않는다 (${value})`);
  }
  // 일곱째 자리부터가 모두 0이면 잃는 것이 없으므로 받는다. 0이 아닌 자리가 있으면 줄이지 않고 거부한다.
  if (/[1-9]/.test(fraction.slice(6))) {
    throw invalidTime(what, `마이크로초보다 잘게 적힌 시각은 줄이지 않고 거부한다 (${value})`);
  }
  const parts = [year, month, day, hour, minute, second].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const local = new Date(0);
  // Date.UTC는 0~99년을 1900년대로 읽으므로 연도를 따로 넣는다.
  local.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
  local.setUTCHours(parts[3], parts[4], parts[5], 0);
  const sameAsWritten =
    local.getUTCFullYear() === parts[0] &&
    local.getUTCMonth() === parts[1] - 1 &&
    local.getUTCDate() === parts[2] &&
    local.getUTCHours() === parts[3] &&
    local.getUTCMinutes() === parts[4] &&
    local.getUTCSeconds() === parts[5];
  if (!sameAsWritten) {
    // 13월, 2월 30일, 25시, 60초처럼 달력에 없는 값이다.
    throw invalidTime(what, `시각으로 읽을 수 없다 (${value})`);
  }
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    const hours = Number(digits.slice(0, 2));
    const minutes = Number(digits.slice(2, 4) || "0");
    if (hours > 23 || minutes > 59) {
      throw invalidTime(what, `시간대를 읽을 수 없다 (${value})`);
    }
    offsetMinutes = (zone.startsWith("-") ? -1 : 1) * (hours * 60 + minutes);
  }
  const micros = fraction.slice(0, 6).padEnd(6, "0");
  const epochMs = local.getTime() + Number(micros.slice(0, 3)) - offsetMinutes * MS_PER_MINUTE;
  const stored = formatUtc(epochMs, micros.slice(3));
  if (stored === undefined) {
    throw invalidTime(what, `연도가 0000~9999를 벗어난다 (${value})`);
  }
  return stored;
}
