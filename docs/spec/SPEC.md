# Spec: AI Butler 공통 규약 — V1

## 목적

[capability map](capability-map.md)의 모든 모듈이 따르는 기술 스택, 명령, 디렉터리 구조, 코드 스타일, 테스트 전략, 경계를 정한다. 모듈별 스펙(`docs/spec/SPEC-<module id>.md`)은 그 모듈의 목적과 계약, 완료 조건만 적고 나머지는 이 문서를 따른다.

제품의 목표는 [AI Butler의 목표](../intent/ai-butler.md), 용어와 판단 기준은 [요청 처리 원칙](../intent/request-handling-principles.md), 기획·개발·리뷰·검증의 진행 방식은 [CLAUDE.md](../../CLAUDE.md)를 따른다.

## 기술 스택

| 항목 | 선택 | 비고 |
|---|---|---|
| 런타임 | Node.js 26 | `.ts` 파일을 빌드 없이 바로 실행한다 |
| 언어 | TypeScript 7 | 타입 검사에만 쓴다 (`tsc --noEmit`) |
| 저장소 | SQLite — Node 내장 `node:sqlite` | 별도 패키지를 설치하지 않는다 |
| 테스트 | Node 내장 `node:test`, `node:assert/strict` | |
| 린트·포맷 | Biome 2 | |

실행에 필요한 의존성은 두지 않고 시작한다. 개발 의존성은 `typescript`, `@biomejs/biome`, `@types/node` 셋이다.

## 명령

```
설치:        npm install
테스트:      npm test                 → node --test "src/**/*.test.ts" "tests/**/*.test.ts"
타입 검사:   npm run typecheck        → tsc --noEmit
린트:        npm run lint             → biome check .
포맷:        npm run format           → biome check --write .
전체 확인:   npm run check            → npm run typecheck && npm run lint && npm test
```

## 디렉터리 구조

```
src/<module id>/            → 모듈 하나의 소스. 폴더 이름은 capability map의 module id
src/<module id>/index.ts    → 모듈의 공개 계약. 다른 모듈은 이 파일만 import한다
src/<module id>/*.test.ts   → 그 모듈의 단위 테스트. 대상 파일 옆에 둔다
src/app/                    → 모듈을 조합해 실행하는 진입점(상시 실행 프로세스, 웹 화면 서버, 스킬이 호출하는 명령). 모듈이 아니다
tests/                      → 요청 처리 사례를 재현하는 시나리오 테스트. 한 모듈만 쓰는 시나리오도 여기에 둔다
docs/spec/                  → capability map, 공통 규약, 모듈별 스펙
docs/tasks/                 → 모듈별 구현 계획과 작업 목록
docs/intent/                → 목표와 요청 처리 원칙
docs/ideas/                 → 사례와 참고 자료
```

- 모듈 사이의 import 방향은 capability map의 의존 방향과 같아야 한다. `src/app/`은 어느 모듈의 `index.ts`든 import할 수 있고, 모듈은 `src/app/`을 import하지 않는다.
- 실행 중에 생기는 데이터는 저장소 밖 `~/Library/Application Support/ai-butler/`에 둔다. 환경 변수 `AI_BUTLER_HOME`으로 위치를 바꿀 수 있고, 테스트는 이 변수로 임시 폴더를 쓴다.

## 실행 형태

- 상시 실행 프로세스, 웹 화면 서버, 비서 스킬이 호출하는 명령은 서로 다른 프로세스일 수 있다. 모두 `request-ledger`를 라이브러리로 직접 열어 같은 SQLite 파일을 읽고 쓴다.
- 상시 실행 프로세스는 모듈이 아니라 `src/app/`의 진입점이다. 진입점이 커넥터에서 기록을 받아 판단 모듈을 부르고, `channel-connectors`는 읽어서 공통 형식으로 넘기기만 한다. 등록 방법과 채널을 살피는 주기는 이를 처음 쓰는 `channel-connectors` 스펙에서 정해 이 문서에 더한다.
- 모델 호출 방식은 모델을 처음 쓰는 `intake-triage` 스펙에서 정해 이 문서에 더한다. 그때까지 지킬 것은 하나다. 판단 모듈은 모델을 직접 부르지 않고 호출을 감싼 경계 하나를 거친다. 호출 방식을 바꿔도 판단 모듈은 고치지 않는다.

## 코드 스타일

```ts
// src/request-ledger/hold.ts
import type { Actor, Clock, HoldTarget } from "./types.ts";
import { LedgerError } from "./errors.ts";

export type HoldInput = {
  target: HoldTarget;
  /** 사용자가 미리 정한 재개 조건. 없으면 사용자가 직접 풀 때까지 둔다. */
  resumeCondition?: string;
};

/** 보류는 사용자의 지시다. 비서는 걸 수 없다. */
export function placeHold(db: LedgerDb, actor: Actor, input: HoldInput, clock: Clock): Hold {
  if (actor.kind !== "user") {
    throw new LedgerError("hold_requires_user", "보류는 사용자만 걸 수 있다");
  }
  // ...
}
```

- ESM을 쓰고 import 경로에 `.ts` 확장자를 적는다. named export만 쓴다.
- Node가 지우기만 하면 되는 문법만 쓴다. `enum`, `namespace`, 생성자 매개변수 속성은 쓰지 않는다. 상태처럼 값이 정해진 것은 문자열 리터럴 유니언으로 적는다.
- 코드 식별자는 영어, 주석과 오류 메시지, 문서는 한국어로 쓴다. 용어의 영어 이름은 모듈 스펙의 대응표를 따른다.
- 계약을 어긴 호출은 코드가 있는 오류를 던진다. 조용히 무시하거나 값을 고쳐서 받아들이지 않는다.
- 시각은 UTC ISO 8601 문자열로 저장한다. 현재 시각과 id 생성은 인자로 주입해 테스트에서 고정할 수 있게 한다.

## 테스트 전략

- 단위 테스트는 대상 파일 옆에, 사례를 재현하는 시나리오 테스트는 `tests/`에 둔다.
- 모듈 스펙의 완료 조건마다 그 조건을 확인하는 테스트가 하나 이상 있어야 한다. `npm run check` 통과처럼 명령의 결과가 곧 조건인 것은 예외다.
- 시나리오 테스트는 [요청 처리 사례](../ideas/request-handling-cases.md)를 재현한다. 첫 사례는 슬랙과 Jira에 걸친 CS팀 VOC 요청이다.
- 테스트는 네트워크를 쓰지 않는다. 채널과 모델은 가짜 구현으로 바꾼다. 저장소는 메모리 DB나 임시 폴더의 SQLite 파일을 쓴다.
- 테스트 데이터는 지어낸 것만 쓴다. 실제 사내 대화, 티켓, 이름, 토큰을 넣지 않는다.

## 경계

- **항상 한다**
  - 코드를 바꾼 커밋은 커밋 전에 `npm run check`를 통과시킨다. 문서만 바꾼 커밋에는 적용하지 않는다.
  - 설계나 계약을 바꿀 때는 스펙을 먼저 고친다.
  - 요청과 작업의 값은 `request-ledger`의 계약을 거쳐서만 쓴다.
  - capability map의 의존 방향을 지킨다.
- **먼저 묻는다**
  - 의존성 추가
  - 저장된 데이터를 옮겨야 하는 스키마 변경
  - 모듈 id나 모듈 경계의 변경
  - 채널에 대한 쓰기 권한이나 새 자격 증명 요구
  - 데이터 저장 위치 변경
- **하지 않는다**
  - 실제 사내 데이터, 토큰, DB 파일을 저장소에 커밋하지 않는다.
  - 추적 모듈에서 채널에 글을 쓰거나 다른 사람에게 연락하지 않는다.
  - 사용자의 지시를 비서의 판단으로 덮어쓰지 않는다.
  - 실패하는 테스트를 승인 없이 지우거나 건너뛰지 않는다.

## 완료 조건

- 저장소를 새로 받아 `npm install` 뒤 `npm run check`가 통과한다.
- `package.json`의 스크립트가 "명령" 절과 같다.
- `src/app/`을 뺀 `src/`의 폴더는 모두 capability map의 module id와 이름이 같고(아직 만들지 않은 모듈의 폴더는 없어도 된다), 다른 모듈의 `index.ts` 밖 파일을 import하는 곳이 없다. 모듈이 `src/app/`을 import하거나 capability map에서 의존한다고 적지 않은 모듈을 import하는 곳도 없다.

## 이번 버전에서 하지 않는 것

- 상시 실행 프로세스의 등록과 주기 — `channel-connectors` 스펙에서 정한다.
- 모델 호출 방식 — `intake-triage` 스펙에서 정한다.
- 웹 화면의 프레임워크 — `worklist-ui` 스펙에서 정한다.
- 배포와 자동 업데이트, CI — 혼자 쓰는 로컬 실행에서는 아직 필요하지 않다.

## 정해야 할 것

없음.
