# AI Butler의 설계에 참고한 제품

2026년 11월 22일에 조사한 사례에 11월 27일 원래 구상에 쓰인 세 제품군을 보강했다. 여러 Claude Code·Codex 세션을 열어야 실제 완료와 내 차례를 알 수 있었던 경험이 비교의 출발점이다. 다음 표의 가운데 열은 공식 자료에서 확인한 동작이고, 오른쪽 열은 그 경험을 Butler에서 어떻게 이어갈지에 대한 설계 판단이다.

## 원래 구상에 쓰인 세 제품군

| 가져오려는 경험 | 제품에서 확인한 동작 | Butler에서 사용자가 보게 될 결과 |
|---|---|---|
| Hermes Agent · Grok Bot에서 본 **일을 맡기는 비서** | Hermes의 Kanban은 역할별 에이전트에 의존 관계가 있는 작업을 배정하고 인수인계를 남긴다. Hermes는 반복해서 쓸 절차를 스킬로 관리한다. Grok Bot의 엔지니어링 사례에서는 봇이 Cursor 작업의 검증 자료를 읽고 후속 지시를 보낸다. [Hermes Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban) · [Hermes 스킬](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) · [Grok Bot 사례](https://x.ai/bot/guides/grok-bot-for-engineering) | 사용자는 비서 한 명에게 일을 맡긴다. 팀원의 보고에 근거가 부족하면 비서가 권한 안에서 보완을 맡긴다. 사용자는 중간 진척을 목록에서 보고, 자신의 결정이 필요하거나 맡긴 범위의 결과가 확인되면 알림을 받는다. |
| Jira · Asana에서 본 **일의 흐름이 보이는 목록** | Jira 칸반은 작업을 진행 단계별로 보여 준다. Asana Dash는 결정이 필요한 일을 찾고, AI Teammates는 업무 기록에 진행 상황을 남긴다. [Jira 칸반](https://www.atlassian.com/software/jira/features/kanban-boards) · [Asana Dash](https://asana.com/product/ai/dash) · [AI Teammates](https://help.asana.com/s/article/ai-teammates) | 카드 한 장은 요청 하나다. Jira 티켓이 끝나도 원래 Slack 스레드에 회신할 일이 남았다면 카드에 그 일이 보인다. 목록이나 대화 어디서 내린 결정이든 같은 요청에 남고, 필요한 카드만 열어 담당과 근거를 확인한다. |
| Paperclip · OpenRig에서 본 **다시 일을 맡길 수 있는 AI 팀** | Paperclip은 서로 다른 실행 도구를 쓰는 에이전트의 역할과 작업 이력을 관리한다. OpenRig는 팀을 이름으로 다시 불러오며, 팀을 복원할 때 각 에이전트의 대화를 어떻게 이어받았는지 알려 준다. [Paperclip 공식 저장소](https://github.com/paperclipai/paperclip) · [OpenRig FAQ](https://openrig.dev/docs/faq) | 같은 팀원이 관련 업무를 폭넓게 맡고 새 세션에서도 역할·지침·경험을 이어 간다. 비서는 독립적인 일을 병렬로 배정한다. 사용자가 지난번 결과를 다시 확인해야 했던 이유가 밝혀지면 비서의 판단과 팀원의 지침을 함께 고치고, 기존 권한과 승인 조건을 지킨다. |

## 제품별 비교

| 제품 | 공식 자료에서 확인한 동작 | AI Butler와의 접점 또는 차이 | 공식 자료 |
|---|---|---|---|
| Asana Dash + AI Teammates | Dash는 회의·Slack·이메일·프로젝트에서 막힌 일과 결정이 필요한 일을 찾아 적합한 AI Teammate에게 연결한다. Teammate는 복잡한 일을 하위 작업으로 나누고 진행 내용을 Asana에 남긴다. | 사용자와 소통하는 주체, 실제 작업을 수행하는 주체, 진행 상황을 확인하는 업무 화면이 한 흐름으로 이어진다. | [Dash](https://asana.com/product/ai/dash) · [AI Teammates](https://help.asana.com/s/article/ai-teammates) |
| Jira Service Management + Request Resolver | 서비스 요청을 읽고 운영 지침에 근거한 단계별 계획을 티켓에 제시한다. 관리자가 요청 유형별로 정한 방식에 따라 사람의 승인을 받거나 연결된 도구에서 자율적으로 실행한다. | 같은 부탁이라도 사전에 제공된 시스템 정보에 따라 비서가 직접 진행할 단계와 사람을 기다릴 단계가 달라진다. | [Request Resolver의 실행 방식](https://support.atlassian.com/jira-service-management-cloud/docs/work-with-request-resolver/) |
| Linear Asks + Agents | Slack이나 이메일로 들어온 요청을 이슈로 접수한다. 이슈를 에이전트에 위임해도 사용자의 업무 목록에 남고, Slack에서 요청의 업데이트를 주고받을 수 있다. | 내가 책임지는 요청 안에서도 지금 행동할 주체는 사용자·다른 사람·에이전트 사이에서 바뀔 수 있다. | [Linear Asks](https://linear.app/integrations/linear-asks) · [에이전트 위임과 업무 목록](https://linear.app/docs/agents-in-linear) |
| ClickUp Super Agents | 업무 공간에서 에이전트에 지침·도구·지식을 제공하고, 일정이나 이벤트를 계기로 실행하도록 설정한다. 사용자의 피드백에서 배운 선호를 저장할 때는 승인을 구한다. | 역할별 에이전트의 지침과 기억을 어떻게 관리할지 참고할 수 있다. Butler의 학습 목표에는 사용자가 직접 다시 처리한 일에서 배우는 것도 포함된다. | [Super Agents의 지침·실행 조건·기억](https://help.clickup.com/hc/en-us/articles/37092796379927-Super-Agent-instructions-Skills-triggers-knowledge-and-memory) |
| Meta Muse | 사용자가 개인 목표나 프로젝트를 맡기면 Muse가 계획을 세우고 전용 가상 컴퓨터에서 작업한다. 웹 탐색과 양식 입력은 브라우저 전담 에이전트에 맡긴다. | 사용자는 Muse와 대화하고, 개별 작업에 필요한 전문 에이전트의 조율은 Muse에 맡긴다. | [Meta의 Muse 소개](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) · [브라우저 작업 위임](https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse) |
| Grok Bot | 공식 엔지니어링 사례에서 Bot은 Slack 등으로 받은 일을 Cursor 에이전트에 위임한다. 실행 기록과 PR에 첨부된 검증 자료를 살피고 후속 지시를 보낸다. | 개발 작업을 위임한 뒤에도 결과가 원래 부탁을 충족했는지 판단하는 책임은 Butler에 남는다. | [Grok Bot 엔지니어링 사례](https://x.ai/bot/guides/grok-bot-for-engineering) |
| OpenAI Dots | 같은 dot이 ChatGPT·Slack·Teams에서 맥락을 이어 가고, Work나 Codex에 작업을 병렬로 위임할 수 있다. 사용자는 진행 중에도 피드백을 주고 방향을 조정할 수 있다. | 한 비서에게 변경을 알리면 관련 작업에 반영되는 경험이다. 사용자가 각 에이전트를 찾아다니며 변경 사항을 전달할 필요가 줄어든다. | [OpenAI의 Dots 소개](https://openai.com/ko-KR/index/introducing-dots/) · [작업 위임과 진행 확인](https://learn.chatgpt.com/docs/enterprise/dots-security) |
| OpenClaw | 상시 지침에 업무 범위와 승인 조건을 정하고, 자동화를 연결해 받은편지함의 항목을 주기적으로 분류·기록할 수 있다. | 먼저 일을 찾는 방식은 채널 확장에 참고한다. 첫 버전은 사용자가 대화에서 짚은 기록부터 따라간다. | [상시 지침과 받은편지함 사례](https://docs.openclaw.ai/automation/standing-orders) |
| NanoClaw | Slack에서 역할별 에이전트에게 직접 메시지를 보내거나 여러 에이전트를 같은 채널에 초대할 수 있다. | 역할을 가진 팀원을 다시 쓴다는 점이 닮았다. Butler 사용자는 진행 확인이나 방향 변경을 비서 한 명에게 맡긴다. | [NanoClaw의 Slack 협업 방식](https://nanoclaw.dev/slack) |

## 목표에 반영한 판단

- **첫 접수 채널은 사용자와의 대화다.** 첫 버전부터 대화에서 짚은 Slack 스레드나 Jira 티켓을 그 요청에 연결하고, 요청이 끝날 때까지 후속 변경을 따라간다. Dash처럼 연결된 채널 전체에서 새 요청을 발굴하는 기능은 이후에 더한다. 사용자가 직접 처리하는 일도 연결된 기록으로 진척을 확인하고 다음 차례에 필요한 자료를 준비한다.
- **Butler가 요청 전체를 조율한다.** 사용자와 대화하는 비서가 실제 작업을 다른 에이전트에게 위임하는 방식은 Asana Dash, Muse, Grok Bot, Dots에서 공통으로 확인된다. Asana에서 특히 참고한 점은 Dash가 찾아낸 일과 Teammate의 진행 기록이 같은 업무 관리 화면에 연결된다는 것이다. Butler는 각 에이전트의 결과를 한 요청에 모아 지금 누구 차례인지 보여 주고, 약속한 결과가 이루어질 때까지 후속 작업을 조율한다.
- **기다리는 일도 먼저 챙긴다.** Dash가 막힌 일을 드러내는 방식은 다른 사람에게 부탁한 일을 사용자가 계속 확인해야 했던 문제와 맞닿아 있다. 다른 사람 또는 에이전트의 조치가 늦어져 후속 작업이나 약속한 일정에 영향이 생기면 Butler가 먼저 기록에서 진행 상황을 확인하고, 맡긴 범위 안에서는 담당자에게도 묻는다.
- **진행 중에도 사용자가 방향을 바꿀 수 있다.** Dots처럼 같은 비서에게 변경을 알리는 경험을 목표에 반영했다. 사용자가 특정 작업을 보류하면 Butler는 목록과 후속 작업을 갱신하고, 맡긴 범위 안에서 영향을 받는 사람과 에이전트에게 전달한다.
- **수행 결과를 약속한 결과와 대조한다.** Grok Bot이 실행 에이전트의 검증 자료를 살피는 사례를 참고했다. 예를 들어 사용자가 두 서비스의 배포 결과를 부탁했고 한 서비스의 배포만 확인됐다면, Butler는 확인된 서비스만 완료로 표시하고 나머지 확인을 이어 간다.

이 판단을 화면에 적용한 예가 칸반 목업의 ‘결제 중복 건 데이터 수정’과 ‘주간 지표 리포트 초안 작성’이다. 전자는 Jira에서 조치한 뒤에도 Slack 회신이 남는 경우이고, 후자는 비서가 팀원들의 병렬 작업과 검증을 맡는 경우다. [칸반보드 목업](kanban-mockup.html) · [AI Butler의 목표](../intent/ai-butler.md) · [요청 처리 원칙](../intent/request-handling-principles.md) · [요청 처리 사례](request-handling-cases.md)

## 설계에 참고할 내용

Jira의 요청 유형별 승인 설정, ClickUp의 기억 저장 승인, Muse의 전용 컴퓨터, Grok Bot 사례의 Cursor 연동은 각 제품이 택한 구체적인 방식이다. AI Butler는 팀원의 역할과 작업 배정, 진행 기록, 후속 판단을 직접 관리한다. 모델 호출과 작업 수행에는 기존 실행 도구를 활용할 수 있다. 어떤 실행 도구를 연결하고 업무별 승인 조건을 어떻게 설정할지는 시스템 설계에서 정한다. 팀원끼리 직접 일을 넘기거나 팀 전체에 일을 맡기는 방식은 개별 팀원에게 직접 배정한 경험을 바탕으로 추후 검토한다.
