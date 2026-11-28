// 쓰기 함수가 받은 인자의 형태를 확인하는 도우미다. 틀린 인자는 고쳐서 받지 않고 오류로 거부한다.
import { LedgerError } from "./errors.ts";

export type Fields = Record<string, unknown>;

function invalid(message: string): LedgerError {
  return new LedgerError("invalid_argument", message);
}

/** 인자가 객체이고 아는 항목만 담고 있는지 확인한다. 모르는 항목은 조용히 버리지 않고 거부한다. */
export function checkedFields(value: unknown, what: string, allowed: readonly string[]): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${what}은(는) 객체여야 한다`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw invalid(`${what}에 알 수 없는 항목이 있다 (${unknown.join(", ")})`);
  }
  return value as Fields;
}

export function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** 비어 있지 않은 문자열. */
export function requiredText(value: unknown, what: string): string {
  if (!isNonBlank(value)) {
    throw invalid(`${what}은(는) 비어 있지 않은 문자열이어야 한다`);
  }
  return value;
}

/** 없거나 null이면 null, 있으면 비어 있지 않은 문자열. */
export function optionalText(value: unknown, what: string): string | null {
  return value === undefined || value === null ? null : requiredText(value, what);
}

/** 정해진 값 가운데 하나. */
export function oneOf<T extends string>(value: unknown, what: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw invalid(`${what}은(는) ${allowed.join(", ")} 가운데 하나다`);
  }
  return value as T;
}

/**
 * 배열인지 확인하고 모든 자리의 값을 돌려준다. 없으면(undefined) 빈 배열이다.
 * `new Array(1)`처럼 빈 자리가 있는 배열은 `map`이 그 자리를 건너뛰므로, 빈 자리를 undefined로 드러내
 * 항목을 검사하는 쪽이 거부하게 한다.
 */
export function everyItem(value: unknown, what: string): unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalid(`${what}은(는) 배열이어야 한다`);
  }
  return Array.from(value as ArrayLike<unknown>);
}

/** 서로 다른 비어 있지 않은 문자열의 배열. 없으면 빈 배열. */
export function distinctTexts(value: unknown, what: string): string[] {
  const items = everyItem(value, what).map((item) => requiredText(item, `${what}의 항목`));
  if (new Set(items).size !== items.length) {
    throw invalid(`${what}에 같은 항목이 두 번 있다`);
  }
  return items;
}

/** 서로 다른 정해진 값의 배열. 없으면 빈 배열. */
export function distinctOneOf<T extends string>(
  value: unknown,
  what: string,
  allowed: readonly T[],
): T[] {
  return distinctTexts(value, what).map((item) => oneOf(item, `${what}의 항목`, allowed));
}
