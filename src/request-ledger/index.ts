// request-ledger의 공개 계약. 다른 모듈은 이 파일만 import한다.
import { randomUUID } from "node:crypto";
import { changesSince, type WriteScope, write } from "./changes.ts";
import { type LedgerDb, openDb, resolveLedgerPath, type SyncResult } from "./db.ts";
import { LedgerError } from "./errors.ts";
import { getRequest, type RequestView } from "./get-request.ts";
import { type LinkRecordInput, type LinkRecordResult, linkRecord } from "./link.ts";
import {
  type AttachMaterialInput,
  type AttachMaterialResult,
  attachMaterial,
  type ReplaceMaterialInput,
  replaceMaterial,
} from "./material.ts";
import {
  type AddNoticeInput,
  type AddNoticeResult,
  addNotice,
  type ListNoticesFilter,
  listNotices,
  type MarkNoticeInput,
  markNoticeDelivered,
  markNoticeSeen,
  type Notice,
} from "./notice.ts";
import {
  type RaiseOpenItemInput,
  type RaiseOpenItemResult,
  type ResolveOpenItemInput,
  raiseOpenItem,
  resolveOpenItem,
} from "./open-item.ts";
import { type SetProgressInput, setProgress } from "./progress.ts";
import { type AddRevisionInput, type AddRevisionResult, addRevision } from "./record.ts";
import {
  type CreateRequestInput,
  type CreateRequestResult,
  createRequest,
  type SetPriorityInput,
  setPriority,
  type UpdateRequestInput,
  updateRequest,
} from "./request.ts";
import {
  type AddTaskInput,
  type AddTaskResult,
  addTask,
  type CancelTaskInput,
  type CompleteTaskInput,
  cancelTask,
  completeTask,
  type UpdateTaskInput,
  updateTask,
} from "./task.ts";
import type { Actor, AppliesTo, Change, Clock, NewId, Reasoned, WriteAction } from "./types.ts";

export type { LedgerErrorCode } from "./errors.ts";
export { LedgerError } from "./errors.ts";
export type {
  CitedRevisionView,
  EvidenceView,
  FinishView,
  LinkView,
  MaterialView,
  OpenItemView,
  RecordView,
  RequestView,
  RevisionView,
  TaskView,
  ValueView,
} from "./get-request.ts";
export type { LinkRecordInput, LinkRecordResult, LinkRole } from "./link.ts";
export type {
  AttachMaterialInput,
  AttachMaterialResult,
  ReplaceMaterialInput,
} from "./material.ts";
export type {
  AddNoticeInput,
  AddNoticeResult,
  ListNoticesFilter,
  MarkNoticeInput,
  Notice,
  NoticeKind,
  NoticeState,
} from "./notice.ts";
export type {
  FollowUpWrite,
  OpenItemKind,
  RaiseOpenItemInput,
  RaiseOpenItemResult,
  ResolveOpenItemInput,
} from "./open-item.ts";
export type { SetProgressInput } from "./progress.ts";
export type { AddRevisionInput, AddRevisionResult } from "./record.ts";
export type {
  CreateRequestInput,
  CreateRequestResult,
  PromisedOutcomeInput,
  RequestValuesInput,
  SetPriorityInput,
  UpdateRequestInput,
  WriteGrounds,
} from "./request.ts";
export type {
  AddTaskInput,
  AddTaskResult,
  CancelTaskInput,
  CompleteTaskInput,
  TaskStatus,
  UnfinishedStatus,
  UpdateTaskInput,
  WaitingForInput,
} from "./task.ts";
export type {
  Actor,
  AppliesTo,
  Change,
  ChangeTarget,
  ChangeTargetKind,
  Clock,
  EvidenceRef,
  JsonValue,
  NewId,
  Party,
  Reasoned,
  SetBy,
  TimeInput,
  UserSurface,
  WriteAction,
} from "./types.ts";
export type { PriorityLevel, PromisedOutcome } from "./value.ts";

export type OpenLedgerOptions = {
  /** 원장 파일의 경로. 없으면 `$AI_BUTLER_HOME/ledger.sqlite`를 쓴다. */
  readonly path?: string;
  /** 현재 시각. 없으면 시스템 시계를 쓴다. */
  readonly clock?: Clock;
  /** 새 식별자. 없으면 UUID를 만든다. */
  readonly newId?: NewId;
};

/**
 * 쓰기에 함께 적는 사유와, 사용자의 쓰기에 함께 밝힐 수 있는 정정의 적용 범위.
 * 적용 범위는 이 요청에만 해당하는지, 다음 유사 업무에도 적용할지다. 밝히지 않으면 변경 이력을 조회할 때
 * 쓰기에 따른 기본값이 나온다. 비서의 쓰기에는 붙일 수 없다.
 */
export type Scoped<Input> = Reasoned<Input> & { readonly appliesTo?: AppliesTo };

/**
 * 연 원장. 쓰는 함수는 모두 첫 인자로 주체를 받고, 계약을 어기면 `LedgerError`를 던진다.
 * 규칙에 어긋난 쓰기는 아무것도 바꾸지 않는다. 함수는 작업을 구현하면서 스펙의 공개 계약 표대로 더한다.
 */
export type Ledger = {
  /** 요청을 등록한다. 사용자가 명시한 값(`stated`)에만 사용자 지정을 건다. */
  createRequest(actor: Actor, input: Scoped<CreateRequestInput>): CreateRequestResult;
  /** 제목, 요청자, 약속한 결과, 기한을 쓰고, 미정을 풀고, 사용자 지정을 푼다. */
  updateRequest(actor: Actor, input: Scoped<UpdateRequestInput>): void;
  /** 긴급도와 중요도를 쓰고, 그 사용자 지정을 푼다. */
  setPriority(actor: Actor, input: Scoped<SetPriorityInput>): void;
  /** 원본을 읽은 내용을 판본으로 더한다. 처음 보는 원본이면 기록도 만든다. */
  addRevision(actor: Actor, input: Scoped<AddRevisionInput>): AddRevisionResult;
  /** 기록을 요청(필요하면 그 요청의 작업)에 연결한다. */
  linkRecord(actor: Actor, input: Scoped<LinkRecordInput>): LinkRecordResult;
  /** 요청에 작업을 더한다. */
  addTask(actor: Actor, input: Scoped<AddTaskInput>): AddTaskResult;
  /** 작업의 값을 쓴다. 완료나 취소인 작업을 되돌릴 때도 쓴다. */
  updateTask(actor: Actor, input: Scoped<UpdateTaskInput>): void;
  /** 작업을 완료로 표시한다. 비서는 근거를 달아야 한다. */
  completeTask(actor: Actor, input: Scoped<CompleteTaskInput>): void;
  /** 작업을 취소로 표시한다. 비서는 사유를 적어야 한다. */
  cancelTask(actor: Actor, input: Scoped<CancelTaskInput>): void;
  /** 확인할 사항을 남긴다. 비서만 남긴다. */
  raiseOpenItem(actor: Actor, input: Reasoned<RaiseOpenItemInput>): RaiseOpenItemResult;
  /** 확인할 사항에 답해 푼다. 사용자만 답한다. 답에 따라 값을 함께 바꿀 수 있다. */
  resolveOpenItem(actor: Actor, input: Scoped<ResolveOpenItemInput>): void;
  /** 알릴 일을 남긴다. */
  addNotice(actor: Actor, input: Scoped<AddNoticeInput>): AddNoticeResult;
  /** 알릴 일을 전했다고 표시한다. */
  markNoticeDelivered(actor: Actor, input: Scoped<MarkNoticeInput>): void;
  /** 사용자가 알릴 일을 봤다고 표시한다. 사용자만 쓴다. */
  markNoticeSeen(actor: Actor, input: Scoped<MarkNoticeInput>): void;
  /** 알릴 일을 만든 순서대로 돌려준다. 상태와 요청으로 거를 수 있다. */
  listNotices(filter?: ListNoticesFilter): Notice[];
  /** 요청이나 작업에 준비 자료를 붙인다. */
  attachMaterial(actor: Actor, input: Scoped<AttachMaterialInput>): AttachMaterialResult;
  /** 준비 자료를 새 내용으로 바꾼다. 이전 내용은 변경 이력에 남는다. */
  replaceMaterial(actor: Actor, input: Scoped<ReplaceMaterialInput>): void;
  /** 요청의 진척을 쓴다. 비서만 쓴다. */
  setProgress(actor: Actor, input: Reasoned<SetProgressInput>): void;
  /**
   * 요청 하나를 값, 작업, 연결된 기록과 판본, 확인할 사항, 준비 자료, 변경 이력, 근거로 달린 판본과 함께 돌려준다.
   * 한 시점의 내용이다.
   */
  getRequest(requestId: string): RequestView;
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

  /**
   * 쓰기 함수 하나를 원장의 메서드로 만든다. 주체와 적용 범위를 확인하고, 규칙 검사와 값 저장,
   * 변경 이력을 한 쓰기 트랜잭션으로 묶는다.
   */
  const writer =
    <Input, Result>(action: WriteAction, body: (scope: WriteScope, input: Input) => Result) =>
    (actor: Actor, input: Scoped<Input>): Result => {
      const env = { db: opened(), clock, newId };
      // 적용 범위와 사유는 쓰기 전체에 붙는 값이라 쓰기의 틀이 받고, 나머지를 쓰기 함수에 넘긴다.
      let appliesTo: unknown;
      let reason: unknown;
      let rest: unknown = input;
      if (typeof input === "object" && input !== null && !Array.isArray(input)) {
        ({ appliesTo, reason, ...rest } = input as Record<string, unknown>);
      }
      return write<Result>(
        env,
        actor,
        { action, appliesTo, reason },
        (scope) => body(scope, rest as Input) as SyncResult<Result>,
      );
    };

  return {
    createRequest: writer("createRequest", createRequest),
    updateRequest: writer("updateRequest", updateRequest),
    setPriority: writer("setPriority", setPriority),
    addRevision: writer("addRevision", addRevision),
    linkRecord: writer("linkRecord", linkRecord),
    addTask: writer("addTask", addTask),
    updateTask: writer("updateTask", updateTask),
    completeTask: writer("completeTask", completeTask),
    cancelTask: writer("cancelTask", cancelTask),
    raiseOpenItem: writer("raiseOpenItem", raiseOpenItem),
    resolveOpenItem: writer("resolveOpenItem", resolveOpenItem),
    addNotice: writer("addNotice", addNotice),
    markNoticeDelivered: writer("markNoticeDelivered", markNoticeDelivered),
    markNoticeSeen: writer("markNoticeSeen", markNoticeSeen),
    listNotices: (filter) => listNotices(opened(), filter),
    attachMaterial: writer("attachMaterial", attachMaterial),
    replaceMaterial: writer("replaceMaterial", replaceMaterial),
    setProgress: writer("setProgress", setProgress),
    getRequest: (requestId) => getRequest(opened(), requestId),
    changesSince: (seq) => changesSince(opened(), seq),
    close: () => {
      if (db.isOpen) {
        db.close();
      }
    },
  };
}
