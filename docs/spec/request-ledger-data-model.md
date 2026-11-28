# 데이터 모델: request-ledger

[request-ledger 스펙](SPEC-request-ledger.md)이 정한 "저장하는 것"을 SQLite 테이블과 컬럼으로 옮긴 문서다. 규칙은 스펙이 정하고, 이 문서는 그 규칙을 지키는 데 필요한 값을 어디에 두는지만 정한다. 둘이 어긋나면 스펙이 맞고 이 문서를 고친다. 테이블을 바꿀 때는 이 문서를 먼저 고치고 `src/request-ledger/migrations.ts`에 마이그레이션을 더한다.

1~5단계의 테이블은 확정이고, 6단계(맡긴 일과 팀원의 작업)의 테이블은 잠정이다. 6단계는 `coordination`과 `agent-runtime` 스펙을 쓴 뒤에 다시 본다.

## 공통 규칙

- **테이블** — 모두 `STRICT`다. 연결을 열 때마다 `PRAGMA foreign_keys = ON`을 켠다.
- **식별자** — 원장을 열 때 받은 `newId`로 만든 `TEXT`다. 변경 이력만 자동으로 늘어나는 순번을 쓴다.
- **예/아니오** — `INTEGER`에 `0`과 `1`만 쓰고 `CHECK`로 막는다.
- **정해진 값** — 상태나 종류처럼 값이 정해진 컬럼은 스펙의 코드를 `TEXT`로 저장하고 `CHECK`로 막는다.
- **지금 유효한 것만 둔다** — 푼 보류, 끊은 연결, 거둔 사유와 그때까지 채운 확인은 테이블에서 지우고 변경 이력에만 남긴다. 요청, 작업, 기록, 판본, 확인할 사항, 알릴 일, 준비 자료는 지우지 않는다.
- **보호에 쓰는 값은 처음부터 적는다** — 사용자가 만든 연결, 사용자가 바로잡은 시각처럼 뒤 작업의 검사가 읽는 값은, 그 일이 처음 일어날 수 있는 작업부터 기록한다. 검사를 더하는 작업이 뒤에 있어도 그 전에 생긴 사용자의 지시를 잊지 않는다. 아래 표의 "처음 쓰는 작업"이 이 기준이다.
- **기존 줄이 있는 테이블에 컬럼을 더할 때** — 비울 수 없는 컬럼은 상수 기본값으로 더한 뒤 실제 값으로 채운다. 마이그레이션 1과 2는 고치지 않는다.
- **색인** — 아래에 적은 것만 만든다. 나머지는 조회가 느려질 때 더한다.

### 시각

모든 시각은 UTC이고 소수점 아래 여섯 자리(마이크로초)까지 적은 한 가지 형태로만 저장한다.

```
2026-11-28T03:04:05.678000Z
```

- 길이와 형태가 같아 문자열 비교가 곧 시각 비교다. 연도는 0000부터 9999까지만 받는다.
- 원장의 시계는 밀리초까지 주므로 뒤 세 자리를 `000`으로 채운다.
- 원본 시각과 기한처럼 밖에서 받은 시각은 `Date`이거나 시간대가 붙은 ISO 8601 문자열이어야 하고, 쓰기 함수가 위 형태로 바꿔 저장한다. 시간대가 없거나, 시각으로 읽을 수 없거나, 마이크로초보다 잘게 적힌 값은 줄이지 않고 거부한다. 더 잘게 주는 출처의 시각을 어떻게 줄일지는 커넥터가 정한다.
- 기한도 시각으로 저장하며, 날짜만 있는 기한을 몇 시로 볼지는 값을 쓰는 쪽이 정한다.
- 버전 2까지의 파일에 밀리초 형태로 저장된 `changes.at`과 `requests.created_at`은 작업 4의 마이그레이션에서 위 형태로 바꾼다. 뜻은 바뀌지 않는다.

### 주체

주체(`party`)는 JSON 문자열로 저장한다. 사용자는 `{"kind":"user"}`이고, 나머지는 종류와 이름을 담으며 채널에서의 식별자를 알면 출처와 함께 담는다.

```json
{"kind":"person","name":"김지원","source":"slack","externalId":"U0000001"}
{"kind":"team","name":"CS팀"}
```

`source`와 `externalId`는 둘 다 있거나 둘 다 없다. 두 주체가 같은지는 **주체 키**로 가린다. 주체 키는 종류와, 식별자가 있으면 출처와 식별자, 없으면 이름을 JSON 배열로 적은 문자열이다(`["person","id","slack","U0000001"]`, `["team","name","CS팀"]`, `["user"]`). 주체 키가 같으면 같은 주체다. 주체 키를 저장하는 컬럼은 같은 쓰기에서 주체로부터 만든다.

### 근거 참조

쓰기에 단 근거는 JSON 배열로 저장한다. 한 건은 아래 넷 가운데 하나다.

```json
{"kind":"revision","revisionId":"…"}
{"kind":"artifact","artifactId":"…"}
{"kind":"user_confirmation","confirmation":"result_delivered","partyKey":"…"}
{"kind":"answer","openItemId":"…"}
```

판본과 보고 근거는 지워지지 않으므로 식별자만 적는다. `artifact`는 6단계에서 쓴다. `user_confirmation`의 `confirmation`과 `partyKey`는 닫힘의 확인을 직접 채울 때만 적는다. 근거의 시각은 판본이면 원본 시각, 보고 근거면 보고를 받은 시각이고, 그 쓰기 안에서 판본이나 보고를 읽어 구한다.

### 쓰기 순번

스펙에서 "앞뒤는 변경 이력의 순번으로 가린다"는 규칙은 **쓰기 순번**으로 확인한다. 쓰기 순번은 그 쓰기가 남긴 변경 이력 가운데 첫 건의 순번이다. 한 쓰기가 변경 이력을 여러 건 남겨도 쓰기 순번은 하나이므로, 두 값의 쓰기 순번이 같으면 같은 쓰기에서 함께 들어온 것이다. 아래 표에서 이름이 `_seq`로 끝나는 컬럼은 모두 쓰기 순번이다.

- 쓰기 순번은 쓰기 잠금을 잡은 뒤 `changes`의 다음 순번을 읽어 정한다. 그 쓰기의 첫 건은 이 순번으로 저장하고, 같은 쓰기의 다음 건과 상태 컬럼에 같은 값을 쓴다. 변경 이력을 남기기 전에도 쓰기 순번을 알 수 있다.
- 값을 바꾼 쓰기는 변경 이력을 한 건 이상 남긴다. 거부된 쓰기와 아무것도 바꾸지 않은 쓰기는 순번을 쓰지 않는다.

## 테이블 한눈에

| 테이블 | 저장하는 것 | 만드는 작업 |
|---|---|---|
| `changes` | 변경 이력 | 작업 2 (있음), 작업 4에서 컬럼 추가 |
| `requests` | 요청과 요청 단위의 값, 닫힘 | 작업 2 (있음), 작업 4에서 컬럼 추가 |
| `records` | 근거 기록 | 작업 6 |
| `revisions` | 판본 | 작업 6 |
| `tasks` | 작업 | 작업 6 (테이블), 작업 7 (쓰는 함수) |
| `links` | 기록과 요청의 연결 | 작업 6 |
| `task_dependencies` | 먼저 끝나야 하는 작업 | 작업 7 |
| `open_items` | 확인할 사항 | 작업 8 |
| `notices` | 알릴 일 | 작업 10 |
| `materials` | 준비 자료 | 작업 10 |
| `holds` | 보류 | 작업 11 |
| `endings` | 끝내기로 한 사유 | 작업 14 |
| `confirmations` | 닫는 데 채운 확인 | 작업 14 (끝내기로 정할 때 채우는 확인), 작업 15 (나머지) |
| `severed_links` | 사용자가 끊은 연결이라는 표시 | 작업 17 |
| `user_splits` | 사용자가 나눈 요청이라는 표시 | 작업 17 |

`requests`와 `tasks`는 처음 컬럼을 더하거나 만들 때 5단계까지 쓰는 컬럼을 모두 넣는다. 나머지 테이블은 표에 적은 작업에서 마이그레이션 하나로 만든다. `links`가 `tasks`를 가리키고, 가리키는 테이블이 없으면 `links`에 줄을 넣을 수 없으므로 `tasks` 테이블은 작업 6의 마이그레이션에서 만들고 쓰는 함수는 작업 7에서 만든다.

```
requests ─┬─ tasks ── task_dependencies
          ├─ links ── records ── revisions
          ├─ open_items
          ├─ notices
          ├─ materials
          ├─ holds
          ├─ endings
          ├─ confirmations
          ├─ severed_links
          └─ user_splits
changes (모든 쓰기)
```

요청에 딸린 테이블(`links`, `open_items`, `notices`, `materials`, `holds`)은 모양이 같다. `request_id`는 항상 있고, 작업 하나를 가리킬 때만 `task_id`가 있다. `task_id`가 있으면 `request_id`는 그 작업이 속한 요청과 같아야 한다. 작업을 다른 요청으로 옮길 때 함께 바꾸는 줄은 "합치기와 나누기에서 함께 바뀌는 것"에 적는다.

## 변경 이력

### `changes`

작업 2에서 만든 테이블에 작업 4에서 컬럼 넷을 더한다.

| 컬럼 | 타입 | 내용 |
|---|---|---|
| `seq` | INTEGER, 자동 증가 기본 키 | 순번 |
| `at` | TEXT | 쓰기 잠금을 잡은 뒤 읽은 시각 |
| `actor` | TEXT (JSON) | 쓴 주체. 사용자와 창구, 또는 비서와 모듈 이름 |
| `target_kind` | TEXT | 대상의 종류. `request`, `task`, `record`, `link`, `hold`, `open_item`, `notice`, `material` |
| `target_id` | TEXT | 대상의 식별자 |
| `before_value` | TEXT (JSON) | 바뀐 항목의 이전 값. 새로 만든 것이면 `null` |
| `after_value` | TEXT (JSON) | 바뀐 항목의 새 값. 지운 것이면 `null` |
| `evidence` | TEXT (JSON) | 근거 참조의 배열 |
| `reason` | TEXT, 비어 있을 수 있음 | 사유 |
| `write_seq` | INTEGER (추가) | 쓰기 순번. 같은 쓰기가 남긴 건은 값이 같다 |
| `action` | TEXT (추가) | 이 건을 만든 쓰기. 공개 계약의 함수 이름으로 적는다. 예: `updateRequest` |
| `request_id` | TEXT, 비어 있을 수 있음 (추가) | 쓸 때 대상이 속해 있던 요청. 요청에 속하지 않는 대상(기록과 판본)은 비운다. 외래 키를 걸지 않는다 |
| `applies_to` | TEXT, 비어 있을 수 있음 (추가) | 사용자가 밝힌 정정의 적용 범위. `this_request` 또는 `similar_future`. 밝히지 않았거나 비서의 쓰기면 비운다 |

색인: `(request_id, seq)`, `(target_kind, target_id, seq)`.

- **한 건의 단위** — 쓰기 하나가 대상 하나에 한 건을 남긴다. `updateRequest`가 값 셋을 바꾸면 한 건이고, 이전 값과 새 값에는 바뀐 항목만 들어간다. 값뿐 아니라 정한 주체와 사용자 지정이 바뀐 것도 적는다.
- **답하면서 값을 바꾸는 쓰기** — 답은 `resolveOpenItem`으로, 값 변경은 그 값을 쓰는 함수의 이름(`updateRequest`, `confirmClosure` 등)으로 `action`을 적는다. 쓰기 순번이 같아 한 쓰기임을 알 수 있다.
- **끝내기로 한 사유, 닫힘, 확인** — 대상은 요청이다. 거두거나 다시 열 때 지운 사유와 확인은 이전 값에 모두 적는다.
- **지우거나 새로 만든 줄** — 풀어서 지운 보류, 끊어서 지운 연결은 대상마다 한 건을 남기고 이전 값에 줄의 내용을 모두 적는다.
- **본문은 옮겨 적지 않는다** — 판본의 본문처럼 다른 테이블에 지워지지 않고 남는 내용은 식별자만 적는다. 바꾸면 사라지는 값(준비 자료의 이전 내용, 요청의 이전 값)은 그대로 적는다.
- **적용 범위** — 사용자가 밝힌 값만 저장하고, 밝힌 값은 그 쓰기가 남긴 모든 건에 적는다. 밝히지 않은 건은 조회할 때 스펙의 "정정의 적용 범위"가 정한 기본값을 `action`으로 골라 채우고, 밝힌 것인지 기본값인지를 함께 돌려준다.
- **두 요청에 걸친 쓰기** — 합치기, 나누기, 작업이나 기록 옮기기는 아래를 모두 남긴다.
  - 떠나는 요청과 받는 요청에 한 건씩. 상대 요청과, 옮긴 것의 종류와 식별자를 적는다. 요청 단위의 값이 바뀌었으면 이전 값과 새 값도 적는다.
  - 옮긴 작업마다 한 건. 이전 요청과 새 요청을 적는다. `request_id`는 받는 요청이다.
  - 그 쓰기에서 지우거나 새로 만든 줄마다 한 건. 요청의 보류가 작업의 보류로 바뀌면 지운 보류와 새 보류를 각각 남기고, 새 보류의 새 값에 원래 보류의 식별자를 적는다. 같은 연결이 겹쳐 하나로 합쳐지면 사라진 연결의 이전 값과 남은 연결의 식별자를 적는다.
- **요청 조회의 변경 이력** — `request_id`가 그 요청이거나 그 요청으로 합쳐진 요청인 건과, 지금 그 요청에 있는 것(작업, 연결, 보류, 확인할 사항, 알릴 일, 준비 자료)을 대상으로 한 건이다. 그래서 여러 번 옮겨 온 작업의 예전 이력도 작업의 식별자로 찾는다.
- **버전 2까지의 파일** — 있던 줄은 `write_seq`를 `seq`로, `action`을 `createRequest`로, 대상이 요청인 줄의 `request_id`를 `target_id`로 채운다. `requests`에 줄이 없는 요청의 이력도 그대로 남긴다.
- `changesSince`와 요청 조회는 더한 컬럼을 함께 돌려준다.

## 요청

### `requests`

작업 2에서 만든 테이블(`id`, `title`, `created_at`)에 작업 4에서 나머지 컬럼을 더한다.

**기본**

| 컬럼 | 타입 | 내용 | 처음 쓰는 작업 |
|---|---|---|---|
| `id` | TEXT, 기본 키 | 요청의 식별자 | 2 |
| `created_at` | TEXT | 접수 시각 | 2 |
| `created_seq` | INTEGER | 등록한 쓰기 순번. 접수 시각이 같을 때 등록한 순서를 가린다 | 4 |
| `undecided` | INTEGER 0/1 | 미정. 처리할 요청인지 아직 정해지지 않았다 | 4 |
| `user_order` | INTEGER, 비어 있을 수 있음 | 사용자가 정한 처리 순서 | 13 |
| `progress` | TEXT, 비어 있을 수 있음 | 진척 | 10 |
| `added_seq` | INTEGER | 이 요청에 기록이 연결됐거나 작업이 더해진 마지막 쓰기 순번. 옮겨 온 것과 합쳐 온 것도 센다 | 6 |

**값** — 값마다 값, 정한 주체, 사용자 지정이 걸린 시각을 나란히 둔다. 정한 주체는 `user`, `assistant`이고 빈 값에는 없다. 사용자 지정이 걸린 시각이 비어 있으면 사용자 지정이 없는 것이다. 모두 작업 4부터 쓴다.

| 값 | 값 컬럼 | 정한 주체 | 사용자 지정이 걸린 시각 | 그 밖 |
|---|---|---|---|---|
| 제목 | `title` TEXT, 비울 수 없음 | `title_set_by` | `title_user_set_at` | `title_written_seq` |
| 요청자 | `requester` TEXT (주체) | `requester_set_by` | `requester_user_set_at` | |
| 약속한 결과 | `promise` TEXT (JSON) | `promise_set_by` | `promise_user_set_at` | `promise_evidence_at`, `promise_work_seq` |
| 기한 | `due` TEXT (시각) | `due_set_by` | `due_user_set_at` | `due_evidence_at` |
| 긴급도 | `urgency` TEXT (`high`, `medium`, `low`) | `urgency_set_by` | `urgency_user_set_at` | |
| 중요도 | `importance` TEXT (`high`, `medium`, `low`) | `importance_set_by` | `importance_user_set_at` | |

- `promise`는 `{"work":"…","notify":[주체, …]}`다. `work`는 해 주기로 한 일, `notify`는 결과를 알릴 사람들이다.
- `title_written_seq`는 제목의 값이 바뀌었거나 제목에 사용자 지정이 걸린 마지막 쓰기 순번이다. 사용자 지정이 걸린 제목을 비서가 바꿀 수 있는지는 `added_seq > title_written_seq`로 가린다. 제목과 같은 쓰기에서 함께 들어온 것은 두 값이 같아 세지 않는다.
- `promise_evidence_at`과 `due_evidence_at`은 그 값에 마지막으로 반영된 근거 판본의 원본 시각이고, 근거를 단 쓰기가 생기는 작업 6부터 적는다. 나중 판본인지는 원본 시각이 사용자 지정이 걸린 시각보다 뒤이고 이 시각보다 앞서지 않는지로 가린다. 사용자 지정이 걸려 있을 때만 검사하고, 사용자 지정을 풀면 이 시각 때문에 거부하지 않는다.
- `promise_work_seq`는 해 주기로 한 일이 마지막으로 바뀐 쓰기 순번이다. 6단계에서 그 전에 남긴 확인 내용을 판정으로 세지 않는 데 쓴다.
- **버전 2까지의 파일** — 있던 요청은 그 요청을 등록한 변경 이력에서 채운다. `created_seq`, `title_written_seq`, `added_seq`는 그 건의 순번이고, `title_set_by`는 그 건의 주체다. 사용자가 등록한 요청이면 제목에 사용자 지정을 걸어 `title_user_set_at`을 접수 시각으로 채운다.

**닫힘과 묶음**

| 컬럼 | 타입 | 내용 | 처음 쓰는 작업 |
|---|---|---|---|
| `closed_reason` | TEXT, 비어 있을 수 있음 | 닫힌 이유. `completed`, `withdrawn`, `transferred`, `declined`, `not_a_request`. 비어 있으면 열린 요청이다 | 15 |
| `closed_at` | TEXT, 비어 있을 수 있음 | 닫힌 시각 | 15 |
| `closed_transferee` | TEXT (주체), 비어 있을 수 있음 | 이관으로 닫혔을 때 넘겨받은 쪽 | 15 |
| `user_reverted_at` | TEXT, 비어 있을 수 있음 | 사용자가 마지막으로 사유를 거뒀거나 다시 연 시각. 사용자가 사유를 거두는 작업 14부터 적고, 검사는 작업 16에서 더한다 | 14 |
| `merged_into` | TEXT, 비어 있을 수 있음, `requests(id)` 참조 | 합쳐져 들어간 요청. 값이 있으면 목록에 나오지 않는다. 이 요청을 찾으면 `merged_into`를 끝까지 따라간 요청을 돌려준다 | 18 |
| `user_merged` | INTEGER 0/1 | 사용자가 다른 요청을 이 요청에 합쳤다. 비서가 나눌 수 없다 | 18 |

다시 열면 `closed_reason`, `closed_at`, `closed_transferee`를 비우고 `confirmations`의 줄을 지운다.

## 작업

### `tasks`

| 컬럼 | 타입 | 내용 | 처음 쓰는 작업 |
|---|---|---|---|
| `id` | TEXT, 기본 키 | 작업의 식별자 | 7 |
| `request_id` | TEXT, `requests(id)` 참조 | 속한 요청 | 7 |
| `created_at` | TEXT | 더한 시각 | 7 |
| `added_seq` | INTEGER | 더한 쓰기 순번. 요청 안에서 작업의 순서이고, 끝내기로 정하기 전에 더한 작업인지 가리는 기준이다. 옮겨도 바뀌지 않는다 | 7 |
| `work` | TEXT | 할 일 | 7 |
| `work_seq` | INTEGER | 할 일이 마지막으로 바뀐 쓰기 순번 | 7 |
| `status` | TEXT | `todo`, `in_progress`, `waiting`, `done`, `cancelled` | 7 |
| `assignee` | TEXT (주체), 비어 있을 수 있음 | 담당 | 7 |
| `waiting_for` | TEXT (주체), 비어 있을 수 있음 | 대기 대상의 주체. 상태가 대기이면 있어야 한다 | 7 |
| `waiting_what` | TEXT, 비어 있을 수 있음 | 대기 대상에게 요청한 내용 | 7 |
| `status_corrected_at` | TEXT, 비어 있을 수 있음 | 사용자가 상태를 마지막으로 바로잡은 시각. 완료를 되돌린 것도 포함한다. 검사는 작업 9에서 더한다 | 7 |
| `status_evidence_at` | TEXT, 비어 있을 수 있음 | 상태에 마지막으로 반영된 근거의 시각 | 7 |
| `assignee_corrected_at`, `assignee_evidence_at` | TEXT, 비어 있을 수 있음 | 담당에 대한 같은 두 값 | 7 |
| `waiting_corrected_at`, `waiting_evidence_at` | TEXT, 비어 있을 수 있음 | 대기 대상에 대한 같은 두 값 | 7 |
| `finished_by` | TEXT, 비어 있을 수 있음 | 완료나 취소를 쓴 쪽. `user`, `assistant`. 끝나지 않은 작업은 비어 있다 | 7 |
| `finished_at` | TEXT, 비어 있을 수 있음 | 완료나 취소를 쓴 시각 | 7 |
| `finished_evidence_at` | TEXT, 비어 있을 수 있음 | 그 쓰기에 단 근거 가운데 가장 늦은 시각. 근거 없이 썼으면 비어 있다 | 7 |
| `finished_seq` | INTEGER, 비어 있을 수 있음 | 그 쓰기의 쓰기 순번. 완료에 단 근거는 변경 이력에서 `write_seq`가 이 값이고 대상이 이 작업인 건에서 찾는다 | 7 |
| `cancel_reason` | TEXT, 비어 있을 수 있음 | 취소한 사유 | 7 |
| `turn` | TEXT (주체), 비어 있을 수 있음 | 사용자가 정한 차례 | 13 |
| `turn_set_at` | TEXT, 비어 있을 수 있음 | 차례를 정한 시각 | 13 |
| `keep_going` | INTEGER 0/1 | 계속하라는 지시. 사유를 거두거나 요청을 닫으면 `0`으로 돌린다 | 14 |
| `user_placed` | INTEGER 0/1 | 사용자가 이 요청으로 옮겼다. 사용자가 합치거나 나누면서 옮긴 작업도 같다. 비서가 옮길 수 없다 | 18 |

색인: `(request_id)`.

- **완료를 확인한 방식**은 따로 저장하지 않는다. 사용자의 완료는 언제나 사용자가 표시한 완료이고 비서의 완료는 언제나 근거가 있어야 하므로, 상태가 완료이고 `finished_by`가 `user`이면 사용자가 표시한 완료, `assistant`이면 기록에서 확인한 완료다.
- 완료나 취소를 되돌리면 `finished_`로 시작하는 컬럼과 `cancel_reason`을 비운다. 비서가 되돌릴 때는 근거 판본의 원본 시각을 `finished_evidence_at`과 비교하고, 그것이 비어 있으면 `finished_at`과 비교한다.
- 작업은 지우지 않는다. 취소는 상태다.

### `task_dependencies`

| 컬럼 | 타입 | 내용 |
|---|---|---|
| `task_id` | TEXT, `tasks(id)` 참조 | 기다리는 작업 |
| `depends_on` | TEXT, `tasks(id)` 참조 | 먼저 끝나야 하는 작업 |

기본 키는 `(task_id, depends_on)`이다. 두 작업이 같은 요청에 있는지와 자기에게 돌아오지 않는지는 쓰기 함수가 검사한다.

## 기록과 연결

### `records`

| 컬럼 | 타입 | 내용 |
|---|---|---|
| `id` | TEXT, 기본 키 | 기록의 식별자 |
| `source` | TEXT | 출처. 예: `slack`, `jira`, `conversation` |
| `source_id` | TEXT | 출처 안의 id |

`(source, source_id)`는 유일하다. 출처가 `conversation`인 기록이 직접 맡긴 말이다.

### `revisions`

| 컬럼 | 타입 | 내용 |
|---|---|---|
| `id` | TEXT, 기본 키 | 판본의 식별자 |
| `record_id` | TEXT, `records(id)` 참조 | 어느 기록의 판본인지 |
| `original_at` | TEXT | 원본 시각. 원본에서 생기거나 바뀐 시각 |
| `body` | TEXT | 원본 그대로의 본문 |
| `url` | TEXT, 비어 있을 수 있음 | 주소. 직접 맡긴 말에는 없다 |
| `author` | TEXT (주체), 비어 있을 수 있음 | 작성자 |
| `fetched_at` | TEXT | 읽어 온 시각 |

`(record_id, original_at)`은 유일하다. 원본 시각이 같은 판본이 다시 들어오면 본문이 같을 때는 있던 줄을 그대로 돌려주고 아무것도 바꾸지 않으며, 본문이 다르면 거부한다. 판본은 고치거나 지우지 않는다.

### `links`

| 컬럼 | 타입 | 내용 | 처음 쓰는 작업 |
|---|---|---|---|
| `id` | TEXT, 기본 키 | 연결의 식별자 | 6 |
| `record_id` | TEXT, `records(id)` 참조 | 연결한 기록 | 6 |
| `request_id` | TEXT, `requests(id)` 참조 | 속한 요청 | 6 |
| `task_id` | TEXT, 비어 있을 수 있음, `tasks(id)` 참조 | 작업 하나에 속하면 그 작업 | 7 |
| `role` | TEXT | 역할. `intake`(접수 원본), `progress`(진행 기록), `completion_evidence`(완료 근거), `delivery`(결과 전달) | 6 |
| `user_set` | INTEGER 0/1 | 사용자가 만들었거나 옮긴 연결. 비서가 끊거나 옮길 수 없다. 사용자가 연결을 만들 수 있는 작업 6부터 적고, 검사는 작업 17에서 더한다 | 6 |

같은 기록을 같은 요청(과 작업)에 같은 역할로 두 번 연결할 수 없다. 유일 색인 둘로 막는다. `task_id`가 빈 줄은 `(record_id, request_id, role)`, `task_id`가 있는 줄은 `(record_id, request_id, role, task_id)`다. 색인: `(request_id)`.

연결을 끊으면 줄을 지운다. 사용자가 끊었으면 `severed_links`에 표시를 남긴다.

### `severed_links` (작업 17)

| 컬럼 | 타입 | 내용 |
|---|---|---|
| `record_id` | TEXT, `records(id)` 참조 | 끊은 기록 |
| `request_id` | TEXT, `requests(id)` 참조 | 그 기록을 끊어 낸 요청 |

기본 키는 `(record_id, request_id)`다. 이 줄이 있으면 비서는 그 기록을 그 요청에 어느 역할로도 새로 연결할 수 없다. 그 기록의 다른 연결이 그 요청에 남아 있으면 그 연결은 그대로다. 사용자가 그 기록을 그 요청에 다시 연결하면 줄을 지운다.

### `user_splits` (작업 17)

| 컬럼 | 타입 | 내용 |
|---|---|---|
| `request_id` | TEXT, `requests(id)` 참조 | 사용자가 나눈 두 요청 가운데 하나 |
| `other_request_id` | TEXT, `requests(id)` 참조 | 다른 하나 |

기본 키는 `(request_id, other_request_id)`이고 두 식별자 가운데 작은 쪽을 `request_id`에 둔다. 이 줄이 있으면 비서는 두 요청을 한 요청에 모을 수 없다.

## 요청에 딸린 것

### `open_items` (작업 8)

| 컬럼 | 타입 | 내용 |
|---|---|---|
| `id` | TEXT, 기본 키 | 확인할 사항의 식별자 |
| `request_id` | TEXT, `requests(id)` 참조 | 속한 요청 |
| `task_id` | TEXT, 비어 있을 수 있음, `tasks(id)` 참조 | 작업에 달렸으면 그 작업 |
| `kind` | TEXT | `question`(질문), `approval`(승인), `unverified`(미확인), `mismatch`(어긋남) |
| `content` | TEXT | 내용 |
| `options` | TEXT (JSON), 비어 있을 수 있음 | 선택지. 문자열의 배열 |
| `raised_at` | TEXT | 남긴 시각 |
| `answer` | TEXT, 비어 있을 수 있음 | 사용자의 답 |
| `resolved_at` | TEXT, 비어 있을 수 있음 | 푼 시각. 비어 있으면 풀리지 않은 것이다 |

색인: `(request_id)`. 푼 뒤에도 지우지 않는다. 답을 근거로 단 쓰기가 이 줄을 가리킨다. 남긴 모듈은 변경 이력의 주체에 있다.

### `notices` (작업 10)

| 컬럼 | 타입 | 내용 |
|---|---|---|
| `id` | TEXT, 기본 키 | 알릴 일의 식별자 |
| `request_id` | TEXT, `requests(id)` 참조 | 어느 요청에 대한 것인지 |
| `task_id` | TEXT, 비어 있을 수 있음, `tasks(id)` 참조 | 작업에 대한 것이면 그 작업 |
| `open_item_id` | TEXT, 비어 있을 수 있음, `open_items(id)` 참조 | 확인할 사항에 대한 것이면 그 확인할 사항 |
| `kind` | TEXT | `new_request`(새 요청), `my_turn`(내 차례), `open_item`(확인할 사항), `verified_result`(확인된 결과), `closed`(닫힘) |
| `content` | TEXT | 전할 내용 |
| `created_at` | TEXT | 만든 시각 |
| `delivered_at` | TEXT, 비어 있을 수 있음 | 전한 시각 |
| `seen_at` | TEXT, 비어 있을 수 있음 | 사용자가 본 시각 |

색인: `(request_id)`. 전하지 않은 것은 `delivered_at`이 빈 줄, 전했지만 보지 않은 것은 `delivered_at`이 있고 `seen_at`이 빈 줄이다. `task_id`와 `open_item_id`가 둘 다 있으면 그 확인할 사항은 그 작업에 달린 것이어야 한다.

### `materials` (작업 10)

| 컬럼 | 타입 | 내용 |
|---|---|---|
| `id` | TEXT, 기본 키 | 준비 자료의 식별자 |
| `request_id` | TEXT, `requests(id)` 참조 | 속한 요청 |
| `task_id` | TEXT, 비어 있을 수 있음, `tasks(id)` 참조 | 작업에 붙였으면 그 작업 |
| `title` | TEXT | 제목 |
| `content` | TEXT | 내용 |
| `source` | TEXT, 비어 있을 수 있음 | 출처 |
| `checked_at` | TEXT | 마지막으로 확인한 시각 |

색인: `(request_id)`. `replaceMaterial`은 줄을 고치고 이전 내용을 변경 이력에 남긴다.

### `holds` (작업 11)

| 컬럼 | 타입 | 내용 |
|---|---|---|
| `id` | TEXT, 기본 키 | 보류의 식별자 |
| `request_id` | TEXT, `requests(id)` 참조 | 속한 요청 |
| `task_id` | TEXT, 비어 있을 수 있음, `tasks(id)` 참조 | 비어 있으면 요청에 건 보류, 있으면 그 작업에 건 보류다 |
| `resume_condition` | TEXT, 비어 있을 수 있음 | 재개 조건 |
| `placed_at` | TEXT | 건 시각. 물려받은 보류는 원래 보류의 건 시각이다 |

색인: `(request_id)`. 풀면 줄을 지운다. 물려받은 보류가 어느 보류에서 왔는지는 변경 이력에 남는다.

## 닫기

### `endings` (작업 14)

열린 요청에 지금 걸려 있는 끝내기로 한 사유다. 요청마다 많아야 한 줄이다.

| 컬럼 | 타입 | 내용 |
|---|---|---|
| `id` | TEXT, 기본 키 | 이 결정의 식별자. `confirmClosure`, `closeRequest`, `clearEnding`이 가리킨다 |
| `request_id` | TEXT, 유일, `requests(id)` 참조 | 끝내기로 정한 요청 |
| `reason` | TEXT | `withdrawn`, `declined`, `transferred` |
| `transferee` | TEXT (주체), 비어 있을 수 있음 | 이관이면 넘겨받는 쪽 |
| `decided_at` | TEXT | 정한 시각 |
| `decided_seq` | INTEGER | 정한 쓰기 순번. `tasks.added_seq`가 이보다 작은 끝나지 않은 작업이 멈춰야 하는 작업이다 |

사유를 거두면 줄과 그 요청의 `confirmations`를 지운다. 요청을 닫으면 사유와 넘겨받는 쪽을 `requests`의 닫힘 컬럼으로 옮기고 줄을 지우며, `confirmations`는 남긴다. 거뒀다가 다시 정하면 새 식별자가 붙으므로 예전 식별자를 가리키는 쓰기는 거부된다.

### `confirmations` (작업 14, 15)

끝내기로 정한 요청에 지금까지 채운 확인과, 닫힌 요청을 닫는 데 채운 확인이다. `setEnding`이 정하면서 채우는 확인(철회 확인, "정했다"는 확인)을 여기에 저장하고 `clearEnding`이 읽으므로 테이블은 작업 14에서 만든다.

| 컬럼 | 타입 | 내용 |
|---|---|---|
| `request_id` | TEXT, `requests(id)` 참조 | 어느 요청의 확인인지 |
| `kind` | TEXT | 어느 확인인지. 아래 표의 코드 |
| `party_key` | TEXT | 사람마다 채우는 확인이면 그 사람의 주체 키, 아니면 빈 문자열 |
| `party` | TEXT (주체), 비어 있을 수 있음 | 그 사람 |
| `filled_by` | TEXT | `evidence`(근거 판본이나 보고 근거로 채움), `user`(사용자가 직접 확인했거나 확인할 사항의 답으로 채움). 쓴 주체가 아니라 채운 방식이다. 사용자가 판본을 내어 채운 확인은 `evidence`다 |
| `evidence` | TEXT (JSON) | 채운 근거 참조의 배열 |
| `evidence_at` | TEXT, 비어 있을 수 있음 | 채운 근거 가운데 가장 늦은 시각. `filled_by`가 `user`이면 비어 있다 |
| `filled_at` | TEXT | 채운 시각 |

기본 키는 `(request_id, kind, party_key)`다.

| 확인 | 코드 | 쓰는 닫힌 이유 |
|---|---|---|
| 약속한 일이 이루어졌다 | `outcome_achieved` | 완료 |
| 결과가 전달됐다 (알릴 사람마다) | `result_delivered` | 완료 |
| 요청자가 철회했다 | `withdrawn_by_requester` | 철회 |
| 사용자가 정했다 | `user_decided` | 맡지 않음, 이관, 요청 아님 |
| 그 결정이 요청자에게 전달됐다 | `decision_delivered` | 맡지 않음, 이관 |
| 넘겨받는 쪽이 인수했다 | `handover_accepted` | 이관 |

- 비서가 다시 열거나 사유를 거둘 수 있는지는 이 테이블로 가린다. `filled_by`가 `user`인 줄이 하나라도 있거나 닫힌 이유(또는 사유)가 맡지 않음, 이관, 요청 아님이면 비서는 되돌릴 수 없다.
- 비서가 철회의 사유를 거둘 때는 근거 판본의 원본 시각을 `withdrawn_by_requester` 줄의 `evidence_at`과 비교한다.

## 합치기와 나누기에서 함께 바뀌는 것

규칙은 스펙의 "합치기와 나누기"가 정한다. 여기에는 그때 어느 줄과 컬럼을 함께 바꾸는지 적는다.

**작업을 다른 요청으로 옮길 때** (합치기, 나누기, `moveTask`에 공통)

- `tasks.request_id`를 바꾼다. `added_seq`는 그대로 둔다. 사용자가 옮겼으면 `user_placed`를 `1`로 한다.
- 그 작업을 가리키는 `links`, `open_items`, `materials`, `holds`, `notices`의 `request_id`를 바꾼다. `notices`는 `task_id`가 그 작업인 줄과, `open_item_id`가 그 작업에 달린 확인할 사항인 줄을 모두 바꾼다.
- 떠나는 요청에 요청 보류가 있으면 옮겨 가는 작업마다 `holds`에 새 줄을 만들고 재개 조건과 건 시각을 그대로 옮긴다.
- 받는 요청의 `added_seq`를 이 쓰기 순번으로 바꾼다.

**합치기** (B를 A에 합침)

- 값마다 A의 것을 쓰면 아무 컬럼도 바꾸지 않는다. B의 것을 가져오면 값, 정한 주체, 사용자 지정이 걸린 시각, 마지막으로 반영된 근거 판본의 시각을 묶음으로 그대로 복사한다. B의 제목을 가져왔으면 `title_written_seq`를 이 쓰기 순번으로 바꾸고, A의 제목이 남았으면 그대로 둔다.
- `added_seq`는 옮겨 온 연결이나 작업이 하나라도 있을 때만 이 쓰기 순번으로 바꾼다.
- `user_reverted_at`은 두 요청 가운데 늦은 값, `progress`는 A의 값이고 비어 있으면 B의 값이다. `created_at`, `created_seq`, `undecided`, `user_order`는 A의 것이다.
- B의 작업을 위와 같이 옮기고, 요청만 가리키는 B의 줄(`links`, `open_items`, `notices`, `materials`)도 `request_id`를 A로 바꾼다. B의 요청 보류 줄은 작업의 보류로 바꾼 뒤 지운다.
- 같은 기록이 두 요청에 같은 역할로 연결돼 있어 연결이 겹치면 하나로 합친다. 어느 한쪽에라도 `user_set`이 걸려 있었으면 남는 줄에 건다.
- B의 `merged_into`를 A로 한다. 사용자가 합쳤으면 A의 `user_merged`, 옮겨 온 작업의 `user_placed`, 옮겨 온 연결의 `user_set`을 `1`로 한다.
- `severed_links`에서 B의 줄을 A로 옮기고 겹치면 한 줄로 둔다. 옮기기 전에, 합친 뒤의 연결과 표시가 부딪치는지 양쪽 방향으로 본다. A에서 끊은 기록이 B에 연결돼 있거나 B에서 끊은 기록이 A에 연결돼 있으면 부딪치는 것이다. 비서의 합치기는 거부하고, 사용자의 합치기는 부딪친 표시만 지운다.
- `user_splits`에서 B가 든 줄의 식별자를 A로 바꾸고 작은 쪽을 앞에 두도록 다시 맞추며, 겹치면 한 줄로 둔다. 바꾼 뒤 두 식별자가 같아지는 줄이 있으면 사용자가 나눈 두 요청을 모으는 합치기다. 비서의 합치기는 거부하고, 사용자의 합치기는 그 줄을 지운다.

**나누기** (A에서 새 요청 C를 만듦)

- C의 제목과 약속한 결과는 새로 정하고, 사용자가 명시한 값에만 사용자 지정을 건다. `title_written_seq`와 `added_seq`는 둘 다 이 쓰기 순번이다. 요청자, 기한, 긴급도, 중요도는 따로 정하지 않으면 A의 묶음(값, 정한 주체, 사용자 지정이 걸린 시각, 마지막으로 반영된 근거 판본의 시각)을 그대로 복사한다. `user_order`, `progress`, `user_reverted_at`은 비우고 `undecided`는 `0`이다.
- 고른 작업을 위와 같이 옮기고, 고른 연결의 `request_id`를 C로 바꾼다.
- `severed_links`에서 A의 줄을 C에도 복사한다.
- `user_splits`에서 A가 든 줄마다 A 자리에 C를 넣은 줄을 더한다. 사용자가 나눈 요청에서 다시 갈라져 나온 요청도 원래 상대와 모을 수 없게 된다. 사용자가 나눴으면 A와 C의 줄도 더한다.

## 저장하지 않고 계산하는 것

| 값 | 무엇으로 계산하는지 |
|---|---|
| 요청의 상태 | `closed_reason`이 있으면 닫힘. 없으면 작업들의 `status`와 `endings`에 줄이 있는지로 접수와 진행 중을 가린다 |
| 작업의 표시 | 스펙의 표를 위에서부터 본다. 요청의 닫힘, `endings.decided_seq`와 `tasks.added_seq`와 `keep_going`, `holds`, `task_dependencies`와 선행 작업의 `status`, 작업의 `status` |
| 작업의 차례 | 표시가 닫힌 요청의 남은 작업, 멈춰야 함, 보류이면 `turn`이 있어도 없다. 나머지 표시에서는 `turn`이 있으면 그 값, 없으면 표시에 따라 `waiting_for`나 `assignee` |
| 요청의 차례, 내 차례인 요청 | 끝나지 않은 작업들의 차례. 열린 요청이면 풀리지 않은 질문과 승인(`open_items`)이 있을 때 사용자를 더한다. 닫힌 요청에는 더하지 않는다 |
| 다음 작업 미정 | 열린 요청에 끝나지 않은 작업이 없고 `endings`에 줄이 없다 |
| 완료를 확인한 방식 | `tasks.finished_by` |
| 남은 확인 | 사유(또는 닫힌 이유)에 필요한 확인에서 `confirmations`에 있는 것을 뺀 것 |
| 목록의 순서 | `user_order`, `urgency`, `importance`, `due`, `created_at`, `created_seq` |
| 밝히지 않은 적용 범위 | `changes.action`과 스펙의 기본값 |

## 6단계의 테이블 (잠정)

`coordination`과 `agent-runtime` 스펙을 쓴 뒤에 확정한다. 1~5단계의 테이블이 이것들을 막지 않는지 보려고 적어 둔다.

| 테이블이나 컬럼 | 저장하는 것 |
|---|---|
| `delegations` | 맡긴 범위. 식별자, 맡긴 요청, 내용, 요청 전체인지, 맡긴 시각과 쓰기 순번 |
| `tasks.delegation_id` | 맡긴 작업이라는 표시와 따르는 맡긴 범위. 비어 있으면 맡긴 작업이 아니다 |
| `assignments` | 배정. 작업, 팀원(주체), 할 일, 기대한 결과, 넘긴 도구와 권한의 범위, 상태, 이어받은 배정(유일), 만든 시각과 쓰기 순번 |
| `instructions` | 지시. 배정, 종류, 내용, 보낸 시각과 쓰기 순번, 가리키는 보고·답·방향 변경, 인용한 근거 참조 |
| `reports` | 보고. 배정, 실행 도구가 붙인 id(배정 안에서 유일), 종류, 내용, 받은 시각과 쓰기 순번 |
| `artifacts` | 보고 근거. 보고, 보고 안에서의 순서, 제목, 내용, 어디서 확인했는지 |
| `checks` | 확인 내용. 요청, 작업(비어 있으면 약속한 일), 판정, 부족한 점, 남긴 쓰기 순번 |
| `check_evidence` | 확인 내용이 본 근거. 확인 내용마다 판본이나 보고 근거 한 줄씩 |
| `directions` | 방향 변경. 요청, 작업, 내용, 창구, 시각과 쓰기 순번, 적용 범위 |
| `open_items.report_id` | 확인할 사항이 어느 보고에서 나왔는지 |

`changes.target_kind`에는 `delegation`, `assignment`, `instruction`, `report`, `check`, `direction`이 더해진다.

확정할 때 함께 정할 것이다.

- 맡기기 전에 바로잡은 값인지는 시각과 쓰기 순번을 섞어 비교할 수 없다. 맡길 때 `tasks`의 `_corrected_at`을 비우는 식으로 보호 상태를 바꿀지, 정정의 쓰기 순번을 따로 둘지 정한다.
- 같은 시각에 더한 지시와 보고, 한 보고의 여러 근거도 더한 순서대로 돌려줘야 하므로 쓰기 순번과 보고 안에서의 순서로 정렬한다.
- 방향 변경을 전달할 배정은 방향 변경을 준 때 그 요청에 있던 배정이어야 한다. 그 뒤 다른 요청에서 옮겨 온 배정을 가려내도록, 그때의 대상 배정을 적어 둘지 이력에서 다시 구할지 정한다.

## 정해야 할 것

- **기록의 연결 가운데 일부만 끊었을 때 막는 범위** — 한 기록이 요청의 접수 원본이면서 그 요청의 작업 하나의 진행 기록일 때 사용자가 뒤의 것만 끊은 경우다. 지금 문서는 `severed_links`를 기록과 요청의 쌍으로 두어, 비서가 그 기록을 그 요청에 어느 역할로도 새로 연결하지 못하게 한다. 끊은 역할과 작업만 막게 하려면 기본 키에 역할과 작업을 더한다. `severed_links`를 만드는 작업 17 전에 정한다.
