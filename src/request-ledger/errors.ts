/** 어떤 규칙을 어겼는지 알려 주는 코드. 규칙이 늘면 여기에 더한다. */
export type LedgerErrorCode =
  /** 파일의 스키마 버전이 이 코드가 아는 것보다 높다 */
  | "schema_version_too_new"
  /** 파일의 스키마 버전이 음수처럼 이 코드가 만든 적 없는 값이다 */
  | "schema_version_invalid"
  /** 예전 버전의 파일에 새 형태로 옮길 수 없는 시각이 있다. 파일은 그대로 두고 열지 않는다 */
  | "unmigratable_time"
  /** 여는 동안 다른 프로그램이 파일의 저널 모드를 계속 바꿔, 정해진 횟수 안에 WAL 모드로 열지 못했다 */
  | "journal_mode_unstable"
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
  /** 시각으로 읽을 수 없거나, 시간대가 없거나, 마이크로초보다 잘게 적혔다 */
  | "invalid_time"
  /** 주체(party)의 형태가 틀렸다 */
  | "invalid_party"
  /** 제목이 비어 있다 */
  | "title_required"
  /** 사용자만 할 수 있는 쓰기를 비서가 했다 */
  | "requires_user"
  /** 비서만 할 수 있는 쓰기를 사용자가 했다 */
  | "requires_assistant"
  /** 가리킨 요청이 없다 */
  | "request_not_found"
  /** 가리킨 작업이 없다 */
  | "task_not_found"
  /** 가리킨 기록이 없다 */
  | "record_not_found"
  /** 가리킨 확인할 사항이 없다 */
  | "open_item_not_found"
  /** 가리킨 알릴 일이 없다 */
  | "notice_not_found"
  /** 가리킨 준비 자료가 없다 */
  | "material_not_found"
  /** 사용자 지정이 걸린 값을 비서가 조건을 채우지 않고 바꾸려 했다. 어긋난 값은 `fields`에 있다 */
  | "user_set_protected"
  /** 사용자가 바로잡은 작업의 값을 비서가 나중 판본 없이 바꾸려 했다. 어긋난 값은 `fields`에 있다 */
  | "user_corrected_protected"
  /** 미정은 등록할 때만 붙일 수 있다 */
  | "undecided_only_at_creation"
  /** 근거로 가리킨 판본이나 확인할 사항이 없다 */
  | "evidence_not_found"
  /** 근거로 달 수 없는 것을 달았다. 직접 맡긴 말, 비서가 단 사용자 확인이나 답이 그렇다 */
  | "evidence_not_allowed"
  /** 사유가 있어야 하는 쓰기에 사유가 없다. 비서의 취소가 그렇다 */
  | "reason_required"
  /** 근거가 있어야 하는 쓰기에 근거가 없다 */
  | "evidence_required"
  /** 단 근거의 시각이 조건보다 이르다 */
  | "evidence_too_early"
  /** 사용자의 정정보다 뒤인 근거가 사용자가 되돌린 완료나 취소에 달았던 것뿐이다 */
  | "evidence_overruled"
  /** 답하면서 바꾸려는 값이 그 확인할 사항이 달린 요청이나 그 요청의 작업의 것이 아니다 */
  | "change_outside_request"
  /** 답하면서 한 대상에 같은 쓰기를 두 번 넣었다 */
  | "duplicate_change"
  /** 원본 시각이 같은데 본문이 다른 판본이다 */
  | "revision_conflict"
  /** 직접 맡긴 말은 접수 원본으로만 연결한다 */
  | "conversation_record_intake_only"
  /** 같은 기록이 같은 요청(과 작업)에 같은 역할로 이미 연결돼 있다 */
  | "link_exists"
  /** 작업이 가리킨 요청에 속하지 않는다 */
  | "task_not_in_request"
  /** 대기 대상 없이 상태를 대기로 쓰려 했거나, 대기가 아닌 작업에 대기 대상을 적으려 했다 */
  | "waiting_target_mismatch"
  /** 완료와 취소는 `updateTask`로 쓸 수 없다 */
  | "finish_with_dedicated_write"
  /** 이미 완료했거나 취소한 작업이다 */
  | "task_already_finished"
  /** 사용자가 표시한 완료나 사용자가 취소한 작업을 비서가 되돌리려 했다 */
  | "user_finished_protected"
  /** 먼저 끝나야 하는 작업이 같은 요청에 없거나, 자기 자신이거나, 따라가면 자기에게 돌아온다 */
  | "invalid_dependency"
  /** 이미 푼 확인할 사항에 다시 답하려 했다 */
  | "open_item_already_resolved"
  /** 확인할 사항이 가리킨 작업에 달린 것이 아니다 */
  | "open_item_not_on_task"
  /** 아직 전하지 않은 알릴 일을 봤다고 표시하려 했다 */
  | "notice_not_delivered"
  /** 가리킨 보류가 없다. 이미 푼 보류도 없는 보류다 */
  | "hold_not_found"
  /** 요청에 건 보류를 작업 하나에서만 풀려 했거나, 가리킨 작업에 건 보류가 아니다 */
  | "hold_not_on_task"
  /** 재개 조건이 없는 보류를 비서가 풀려 했다 */
  | "hold_without_resume_condition";

/** 계약을 어긴 호출에 던지는 오류. 거부된 쓰기는 아무것도 바꾸지 않는다. */
export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  /** 한 쓰기에 든 값 가운데 규칙에 어긋난 값의 이름. 값 때문에 거부된 것이 아니면 비어 있다. */
  readonly fields: readonly string[];

  constructor(code: LedgerErrorCode, message: string, fields: readonly string[] = []) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
    this.fields = [...fields];
  }
}
