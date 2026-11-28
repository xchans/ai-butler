// 근거 기록과 판본. 기록은 채널이나 업무 도구에 있는 원본 하나이고, 판본은 그 원본을 읽은 내용이다.
import type { WriteScope } from "./changes.ts";
import { LedgerError } from "./errors.ts";
import { CONVERSATION_SOURCE } from "./evidence.ts";
import { checkedFields, optionalText, requiredText } from "./input.ts";
import { checkedParty } from "./party.ts";
import { externalTime } from "./time.ts";
import type { Party, TimeInput } from "./types.ts";

export type AddRevisionInput = {
  /** 출처. 예: `slack`, `jira`. 직접 맡긴 말은 `conversation`이다. */
  readonly source: string;
  /** 출처 안의 id. 출처와 이 id가 같으면 같은 기록이다. */
  readonly sourceId: string;
  /** 원본 시각. 원본에서 생기거나 바뀐 시각이다. 직접 맡긴 말이면 말한 시각이다. */
  readonly originalAt: TimeInput;
  /** 원본 그대로의 본문. */
  readonly body: string;
  /** 주소. 직접 맡긴 말에는 없다. */
  readonly url?: string | null;
  /** 작성자. 직접 맡긴 말의 작성자는 사용자다. */
  readonly author?: Party | null;
  /** 읽어 온 시각. 없으면 이 쓰기의 시각이다. */
  readonly fetchedAt?: TimeInput;
};

export type AddRevisionResult = {
  readonly recordId: string;
  readonly revisionId: string;
  /** 판본을 새로 더했으면 true. 원본 시각이 같은 판본이 이미 있어 그대로 돌려줬으면 false. */
  readonly added: boolean;
};

/**
 * 원본을 읽은 내용을 판본으로 더한다. 처음 보는 원본이면 기록도 함께 만든다.
 * 판본은 기록과 원본 시각으로 구별한다. 원본 시각이 같은 판본을 다시 읽어 와도 판본이 늘지 않고,
 * 원본 시각이 다르면 본문이 같아도 새 판본이다. 원본 시각이 같은데 본문이 다르면 거부한다.
 */
export function addRevision(scope: WriteScope, input: AddRevisionInput): AddRevisionResult {
  const fields = checkedFields(input, "addRevision의 인자", [
    "source",
    "sourceId",
    "originalAt",
    "body",
    "url",
    "author",
    "fetchedAt",
  ]);
  const source = requiredText(fields.source, "출처(source)");
  const sourceId = requiredText(fields.sourceId, "출처 안의 id(sourceId)");
  const originalAt = externalTime(fields.originalAt, "원본 시각(originalAt)");
  if (typeof fields.body !== "string") {
    throw new LedgerError("invalid_argument", "본문(body)은 문자열이어야 한다");
  }
  const body = fields.body;
  let url = optionalText(fields.url, "주소(url)");
  let author =
    fields.author === undefined || fields.author === null
      ? null
      : checkedParty(fields.author, "작성자");
  if (source === CONVERSATION_SOURCE) {
    // 직접 맡긴 말은 사용자 채널의 기록이다. 작성자는 사용자이고 주소는 없다.
    if (url !== null) {
      throw new LedgerError("invalid_argument", "직접 맡긴 말에는 주소가 없다");
    }
    if (author !== null && author.kind !== "user") {
      throw new LedgerError("invalid_argument", "직접 맡긴 말의 작성자는 사용자다");
    }
    url = null;
    author = { kind: "user" };
  }
  const fetchedAt =
    fields.fetchedAt === undefined
      ? scope.at
      : externalTime(fields.fetchedAt, "읽어 온 시각(fetchedAt)");

  const record = scope.get(
    "SELECT id FROM records WHERE source = ? AND source_id = ?",
    source,
    sourceId,
  );
  if (record !== undefined) {
    const recordId = String(record.id);
    const same = scope.get(
      "SELECT id, body FROM revisions WHERE record_id = ? AND original_at = ?",
      recordId,
      originalAt,
    );
    if (same !== undefined) {
      if (same.body !== body) {
        throw new LedgerError(
          "revision_conflict",
          "원본 시각이 같은데 본문이 다른 판본이다. 원본이 바뀌었으면 바뀐 시각을 원본 시각으로 넘긴다",
        );
      }
      return { recordId, revisionId: String(same.id), added: false };
    }
  }

  const recordId = record === undefined ? scope.newId() : String(record.id);
  if (record === undefined) {
    scope.run(
      "INSERT INTO records (id, source, source_id) VALUES (?, ?, ?)",
      recordId,
      source,
      sourceId,
    );
  }
  const revisionId = scope.newId();
  scope.run(
    `INSERT INTO revisions (id, record_id, original_at, body, url, author, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    revisionId,
    recordId,
    originalAt,
    body,
    url,
    author === null ? null : JSON.stringify(author),
    fetchedAt,
  );
  // 본문은 판본에 지워지지 않고 남으므로 변경 이력에는 식별자만 적는다.
  const revision = { id: revisionId, originalAt, fetchedAt };
  scope.record({
    target: { kind: "record", id: recordId },
    requestId: null,
    before: record === undefined ? null : { revision: null },
    after: record === undefined ? { source, sourceId, revision } : { revision },
  });
  return { recordId, revisionId, added: true };
}
