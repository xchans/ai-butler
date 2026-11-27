import { write } from "./changes.ts";
import type { LedgerDb } from "./db.ts";
import { LedgerError } from "./errors.ts";
import type { Actor, Clock, CreatedRequest, CreateRequestInput, NewId } from "./types.ts";

/**
 * 요청을 등록한다. 지금은 제목만 받는다.
 * 요청자, 약속한 결과 같은 값과 값마다의 정한 주체, 사용자 지정은 요청의 값을 다루는 작업에서 더한다.
 */
export function createRequest(
  db: LedgerDb,
  actor: Actor,
  input: CreateRequestInput,
  clock: Clock,
  newId: NewId,
): CreatedRequest {
  return write<CreatedRequest>(db, actor, clock, (scope) => {
    const title: unknown = (input as Partial<CreateRequestInput> | null | undefined)?.title;
    if (typeof title !== "string" || title.trim() === "") {
      throw new LedgerError("title_required", "요청의 제목은 비워 둘 수 없다");
    }
    const request: CreatedRequest = { id: newId(), title, createdAt: scope.at };
    scope.run(
      "INSERT INTO requests (id, title, created_at) VALUES (?, ?, ?)",
      request.id,
      request.title,
      request.createdAt,
    );
    scope.record({
      target: { kind: "request", id: request.id },
      before: null,
      after: { title: request.title },
    });
    return request;
  });
}
