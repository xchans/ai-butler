// 주체(party)의 형태와, 두 주체가 같은지 가리는 규칙을 둔다.
import { LedgerError } from "./errors.ts";
import { isNonBlank } from "./input.ts";
import type { Party } from "./types.ts";

const NAMED_KINDS = ["person", "team", "agent"] as const;

function invalidParty(what: string, why: string): LedgerError {
  return new LedgerError("invalid_party", `${what}: ${why}`);
}

/**
 * 밖에서 받은 주체의 형태를 확인하고, 저장할 형태로 돌려준다.
 * 사용자는 식별자를 두지 않는다. 나머지는 이름을 담고, 출처와 식별자는 둘 다 있거나 둘 다 없다.
 * `what`은 오류에 적을 값의 이름이다.
 */
export function checkedParty(value: unknown, what: string): Party {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidParty(what, "주체는 종류(kind)를 담은 객체여야 한다");
  }
  const { kind, name, source, externalId, ...rest } = value as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length > 0) {
    throw invalidParty(what, `주체에 알 수 없는 항목이 있다 (${extra.join(", ")})`);
  }
  if (kind === "user") {
    if (name !== undefined || source !== undefined || externalId !== undefined) {
      throw invalidParty(what, "사용자는 이름이나 식별자를 두지 않는다");
    }
    return { kind };
  }
  if (!NAMED_KINDS.includes(kind as (typeof NAMED_KINDS)[number])) {
    throw invalidParty(what, "주체의 종류는 user, person, team, agent 가운데 하나다");
  }
  if (!isNonBlank(name)) {
    throw invalidParty(what, "사용자가 아닌 주체는 이름을 담는다");
  }
  const namedKind = kind as (typeof NAMED_KINDS)[number];
  if (source === undefined && externalId === undefined) {
    return { kind: namedKind, name };
  }
  if (!isNonBlank(source) || !isNonBlank(externalId)) {
    throw invalidParty(what, "출처(source)와 식별자(externalId)는 둘 다 있거나 둘 다 없다");
  }
  return { kind: namedKind, name, source, externalId };
}

/**
 * 주체 키. 종류와, 식별자가 있으면 출처와 식별자, 없으면 이름을 JSON 배열로 적은 문자열이다.
 * 두 주체의 주체 키가 같으면 같은 주체다.
 */
export function partyKey(party: Party): string {
  if (party.kind === "user") {
    return JSON.stringify(["user"]);
  }
  if (party.source !== undefined && party.externalId !== undefined) {
    return JSON.stringify([party.kind, "id", party.source, party.externalId]);
  }
  return JSON.stringify([party.kind, "name", party.name]);
}

/**
 * 두 값이 같은 주체인지 가린다. 종류가 같고 출처와 식별자가 같으면 같다. 둘 다 식별자가 없으면 종류와 이름으로 가린다.
 * 한쪽에만 식별자가 있거나 출처가 다르면 이름이 같아도 다른 주체다. 같은 사람이라고 추정하지 않는다.
 */
export function sameParty(a: Party, b: Party): boolean {
  return partyKey(a) === partyKey(b);
}

/** 저장한 주체를 읽는다. 비어 있으면 null. */
export function storedParty(value: unknown): Party | null {
  return typeof value === "string" ? (JSON.parse(value) as Party) : null;
}
