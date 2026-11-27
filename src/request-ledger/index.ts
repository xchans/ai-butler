// request-ledger의 공개 계약. 다른 모듈은 이 파일만 import한다.
import { randomUUID } from "node:crypto";
import { changesSince } from "./changes.ts";
import { type LedgerDb, openDb, resolveLedgerPath } from "./db.ts";
import { LedgerError } from "./errors.ts";
import { createRequest } from "./request.ts";
import type { Actor, Change, Clock, CreatedRequest, CreateRequestInput, NewId } from "./types.ts";

export type { LedgerErrorCode } from "./errors.ts";
export { LedgerError } from "./errors.ts";
export type {
  Actor,
  Change,
  ChangeTarget,
  Clock,
  CreatedRequest,
  CreateRequestInput,
  JsonValue,
  NewId,
  UserSurface,
} from "./types.ts";

export type OpenLedgerOptions = {
  /** 원장 파일의 경로. 없으면 `$AI_BUTLER_HOME/ledger.sqlite`를 쓴다. */
  readonly path?: string;
  /** 현재 시각. 없으면 시스템 시계를 쓴다. */
  readonly clock?: Clock;
  /** 새 식별자. 없으면 UUID를 만든다. */
  readonly newId?: NewId;
};

/**
 * 연 원장. 쓰는 함수는 모두 첫 인자로 주체를 받고, 계약을 어기면 `LedgerError`를 던진다.
 * 함수는 작업을 구현하면서 스펙의 공개 계약 표대로 더한다.
 */
export type Ledger = {
  /** 요청을 등록한다. 지금은 제목만 받는다. */
  createRequest(actor: Actor, input: CreateRequestInput): CreatedRequest;
  /** 주어진 순번 뒤의 변경 이력을 돌려준다. 다른 프로세스가 쓴 변경도 나온다. */
  changesSince(seq: number): Change[];
  /** 파일을 닫는다. 닫은 뒤에 부른 함수는 `ledger_closed` 오류를 낸다. */
  close(): void;
};

/** 원장 파일을 열고 스키마를 올린다. 프로세스마다 따로 열어 같은 파일을 함께 읽고 쓴다. */
export function openLedger(options: OpenLedgerOptions = {}): Ledger {
  const db = openDb(options.path ?? resolveLedgerPath());
  const clock: Clock = options.clock ?? (() => new Date());
  const newId: NewId = options.newId ?? randomUUID;

  const opened = (): LedgerDb => {
    if (!db.isOpen) {
      throw new LedgerError("ledger_closed", "닫은 원장은 쓸 수 없다");
    }
    return db;
  };

  return {
    createRequest: (actor, input) => createRequest(opened(), actor, input, clock, newId),
    changesSince: (seq) => changesSince(opened(), seq),
    close: () => {
      if (db.isOpen) {
        db.close();
      }
    },
  };
}
