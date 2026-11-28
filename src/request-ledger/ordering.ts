// "앞뒤"를 따지는 규칙이 쓰는 두 가지 비교를 한 곳에 둔다.
// 하나는 근거의 시각(판본은 원본 시각)이고, 다른 하나는 변경 이력의 순번(쓰기 순번)이다.
// 시각은 길이와 형태가 같은 문자열로 저장하므로 문자열 비교가 곧 시각 비교다.

/** 근거의 시각이 기준 시각보다 뒤인지. 같으면 뒤가 아니다. */
export function isAfter(evidenceAt: string, baseAt: string): boolean {
  return evidenceAt > baseAt;
}

/** 근거들 가운데 기준 시각보다 뒤인 것이 하나라도 있는지. */
export function anyAfter(evidenceTimes: readonly string[], baseAt: string): boolean {
  return evidenceTimes.some((time) => isAfter(time, baseAt));
}

/**
 * 나중 판본이 있는지. 나중 판본은 원본 시각이 사용자의 정정보다 뒤이고,
 * 그 값에 마지막으로 반영된 근거 판본의 원본 시각보다 앞서지 않는 판본이다.
 * 판본이 늦게 도착해도 값이 예전으로 되돌아가지 않게 한다.
 */
export function hasLaterRevision(
  revisionTimes: readonly string[],
  correctedAt: string,
  reflectedAt: string | null,
): boolean {
  return revisionTimes.some(
    (time) => isAfter(time, correctedAt) && (reflectedAt === null || time >= reflectedAt),
  );
}

/** 근거들 가운데 가장 늦은 시각. 없으면 null. */
export function latestOf(times: readonly string[]): string | null {
  return times.reduce<string | null>(
    (latest, time) => (latest === null || time > latest ? time : latest),
    null,
  );
}

/** 쓰기 순번이 기준 쓰기보다 뒤인지. 시각이 같아도 순번이 뒤면 뒤다. 같은 쓰기에서 함께 들어온 것은 뒤가 아니다. */
export function wroteAfter(seq: number, baseSeq: number): boolean {
  return seq > baseSeq;
}
