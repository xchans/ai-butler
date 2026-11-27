/** 어떤 규칙을 어겼는지 알려 주는 코드. 규칙이 늘면 여기에 더한다. */
export type LedgerErrorCode =
  /** 파일의 스키마 버전이 이 코드가 아는 것보다 높다 */
  | "schema_version_too_new"
  /** 파일의 스키마 버전이 음수처럼 이 코드가 만든 적 없는 값이다 */
  | "schema_version_invalid"
  /** 쓰기 콜백이 동기로 끝나지 않고 Promise를 돌려줬다 */
  | "async_write"
  /** 이미 끝난 쓰기로 값이나 변경 이력을 쓰려 했다 */
  | "write_ended"
  /** 닫은 원장을 불렀다 */
  | "ledger_closed"
  /** 쓰기에 주체를 밝히지 않았거나 주체의 형태가 틀렸다 */
  | "invalid_actor"
  /** 인자의 형태가 틀렸다 */
  | "invalid_argument"
  /** 제목이 비어 있다 */
  | "title_required";

/** 계약을 어긴 호출에 던지는 오류. 거부된 쓰기는 아무것도 바꾸지 않는다. */
export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}
