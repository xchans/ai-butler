/** 현재 시각. 테스트에서 고정할 수 있게 원장을 열 때 주입한다. 저장할 때는 UTC ISO 8601 문자열로 바꾼다. */
export type Clock = () => Date;

/** 새 식별자. 테스트에서 고정할 수 있게 원장을 열 때 주입한다. */
export type NewId = () => string;

/** 사용자가 쓰는 창구. 웹 화면 또는 스킬이다. */
export type UserSurface = "web" | "skill";

/** 쓰기의 주체. 사용자는 창구를, 비서는 쓴 모듈의 이름을 밝힌다. */
export type Actor =
  | { readonly kind: "user"; readonly via: UserSurface }
  | { readonly kind: "assistant"; readonly module: string };

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** 변경 이력이 가리키는 대상. 저장하는 것이 늘면 종류를 더한다. */
export type ChangeTarget = { readonly kind: "request"; readonly id: string };

/** 변경 이력 한 건. 쓰기 하나가 남긴 것이고, 한 번 남기면 고치거나 지우지 않는다. */
export type Change = {
  /** 순번. 1부터 하나씩 늘고 빠지거나 겹치지 않는다. */
  readonly seq: number;
  /**
   * 쓰기 잠금을 잡은 뒤에 읽은 시각. UTC ISO 8601.
   * 시계가 조정되면 앞선 변경보다 이를 수 있으므로, 변경의 앞뒤는 시각이 아니라 순번으로 가린다.
   */
  readonly at: string;
  readonly actor: Actor;
  readonly target: ChangeTarget;
  /** 이전 값. 새로 만든 것이면 null */
  readonly before: JsonValue;
  readonly after: JsonValue;
  /** 쓰기에 단 근거. 근거의 종류와 형태는 기록과 판본을 다루는 작업에서 정한다. */
  readonly evidence: readonly JsonValue[];
  readonly reason: string | null;
};

export type CreateRequestInput = {
  /** 비워 둘 수 없다. */
  readonly title: string;
};

/** 요청을 등록한 결과. */
export type CreatedRequest = {
  readonly id: string;
  readonly title: string;
  /** 접수 시각. 요청을 등록한 시각이다. */
  readonly createdAt: string;
};
