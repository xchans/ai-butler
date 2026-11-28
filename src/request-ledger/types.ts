/** 현재 시각. 테스트에서 고정할 수 있게 원장을 열 때 주입한다. 저장할 때는 UTC, 마이크로초 여섯 자리로 바꾼다. */
export type Clock = () => Date;

/** 새 식별자. 테스트에서 고정할 수 있게 원장을 열 때 주입한다. */
export type NewId = () => string;

/** 사용자가 쓰는 창구. 웹 화면 또는 스킬이다. */
export type UserSurface = "web" | "skill";

/** 쓰기의 주체. 사용자는 창구를, 비서는 쓴 모듈의 이름을 밝힌다. */
export type Actor =
  | { readonly kind: "user"; readonly via: UserSurface }
  | { readonly kind: "assistant"; readonly module: string };

/** 값을 정한 쪽. 사용자이거나 비서다. */
export type SetBy = Actor["kind"];

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * 주체(party). 요청자, 담당, 대기 대상, 결과를 알릴 사람, 판본의 작성자가 모두 이 형태다.
 * 사용자는 이 비서를 쓰는 한 사람이고 식별자를 두지 않는다. 나머지는 이름을 담고,
 * 채널에서의 식별자를 알면 그 출처와 함께 담는다. 출처와 식별자는 둘 다 있거나 둘 다 없다.
 */
export type Party =
  | { readonly kind: "user" }
  | {
      readonly kind: "person" | "team" | "agent";
      readonly name: string;
      readonly source?: string;
      readonly externalId?: string;
    };

/** 시각을 받는 인자. `Date`이거나 시간대가 붙은 ISO 8601 문자열이다. */
export type TimeInput = Date | string;

/** 정정의 적용 범위. 이 요청에만 해당하는지, 다음 유사 업무에도 적용할지다. */
export type AppliesTo = "this_request" | "similar_future";

/** 쓰기에 적는 사유. 어느 쓰기에나 적을 수 있고 변경 이력에 남는다. 공백뿐인 사유는 없는 것으로 본다. */
export type Reasoned<Input> = Input & { readonly reason?: string | null };

/** 변경 이력을 남기는 쓰기. 공개 계약의 함수 이름이다. */
export type WriteAction =
  | "createRequest"
  | "updateRequest"
  | "setPriority"
  | "setOrder"
  | "mergeRequests"
  | "splitRequest"
  | "addTask"
  | "updateTask"
  | "completeTask"
  | "cancelTask"
  | "moveTask"
  | "setContinue"
  | "setTurn"
  | "clearTurn"
  | "addRevision"
  | "linkRecord"
  | "moveRecord"
  | "unlinkRecord"
  | "placeHold"
  | "releaseHold"
  | "setEnding"
  | "confirmClosure"
  | "clearEnding"
  | "closeRequest"
  | "reopenRequest"
  | "raiseOpenItem"
  | "resolveOpenItem"
  | "addNotice"
  | "markNoticeDelivered"
  | "markNoticeSeen"
  | "setDelegation"
  | "clearDelegation"
  | "addDirection"
  | "assignTask"
  | "addInstruction"
  | "addReport"
  | "recordCheck"
  | "endAssignment"
  | "stopAssignment"
  | "setProgress"
  | "attachMaterial"
  | "replaceMaterial";

/** 변경 이력이 가리키는 대상의 종류. */
export type ChangeTargetKind =
  | "request"
  | "task"
  | "record"
  | "link"
  | "hold"
  | "open_item"
  | "notice"
  | "material";

/** 변경 이력이 가리키는 대상. */
export type ChangeTarget = { readonly kind: ChangeTargetKind; readonly id: string };

/**
 * 쓰기에 다는 근거 한 건. 판본은 기록이 아니라 판본을 가리켜, 원본이 나중에 바뀌어도 판단할 때 본 내용이 남는다.
 * 비서의 쓰기에는 판본만 달 수 있고, 사용자 확인과 확인할 사항의 답은 사용자의 쓰기에만 붙는다.
 * 보고 근거(`artifact`)는 맡긴 일을 다루는 단계에서 더한다.
 */
export type EvidenceRef =
  | { readonly kind: "revision"; readonly revisionId: string }
  | { readonly kind: "user_confirmation" }
  | { readonly kind: "answer"; readonly openItemId: string };

/** 변경 이력 한 건. 쓰기 하나가 대상 하나에 남긴 것이고, 한 번 남기면 고치거나 지우지 않는다. */
export type Change = {
  /** 순번. 1부터 하나씩 늘고 빠지거나 겹치지 않는다. */
  readonly seq: number;
  /** 쓰기 순번. 그 쓰기가 남긴 첫 건의 순번이다. 같은 쓰기가 남긴 건은 값이 같다. */
  readonly writeSeq: number;
  /**
   * 쓰기 잠금을 잡은 뒤에 읽은 시각. UTC, 마이크로초 여섯 자리.
   * 시계가 조정되면 앞선 변경보다 이를 수 있으므로, 변경의 앞뒤는 시각이 아니라 순번으로 가린다.
   */
  readonly at: string;
  readonly actor: Actor;
  /** 이 건을 만든 쓰기. 공개 계약의 함수 이름이다. */
  readonly action: WriteAction;
  readonly target: ChangeTarget;
  /** 쓸 때 대상이 속해 있던 요청. 요청에 속하지 않는 대상(기록과 판본)은 null */
  readonly requestId: string | null;
  /** 바뀐 항목의 이전 값. 새로 만든 것이면 null */
  readonly before: JsonValue;
  /** 바뀐 항목의 새 값. 지운 것이면 null */
  readonly after: JsonValue;
  /** 쓰기에 단 근거. 종류와 함께 나온다. */
  readonly evidence: readonly JsonValue[];
  readonly reason: string | null;
  /**
   * 정정의 적용 범위. 비서의 쓰기에는 없다(null).
   * 사용자가 밝혔으면 그 값이고 `stated`가 true다. 밝히지 않았으면 쓰기에 따른 기본값이고 `stated`가 false다.
   */
  readonly appliesTo: { readonly scope: AppliesTo; readonly stated: boolean } | null;
};
