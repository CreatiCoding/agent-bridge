# 세션 실행기(runner) 설계

SPEC REQ-F-851(1.405). 출처: 사용자 요청.

## 목표

세션이 터미널에서 띄우는 CLI 를 Claude Code 하나에서 "실행기"로 바꿀 자리를 만들고, 첫 다른 실행기로 OpenAI Codex CLI 를 붙인다. Claude Code 세션은 동작이 하나도 바뀌지 않는다.

## 1단계 (1.405)

- **실행기 정의** `agent/runners.mjs`: `{id, name, caps}`. `caps` 는 Claude Code 만의 기능 이름(hooks·cards·bridgeTools·model·effort·mode·autoAllow·fork·move·account·compact·trim·skills·btw·todos·preview·adopt·routing·chrome·sessionMd·zeropty) 중 그 실행기가 하는 것. 대화 보기·입력·Esc·터미널 화면·종료·같은 맥에서 다시 열기는 모든 실행기가 한다.
- **기록**: 세션의 `runner` 를 맥의 `sessions.json`·닫은 세션 기록과 서버 meta 에 둔다. 없으면 Claude Code. 에이전트 코드는 `isClaude(s)` 로만 갈라, Claude Code 는 예전 코드를 그대로 지난다.
- **알리기**: hello `runners`. 서버 `cleanRunners` 가 걸러 호스트에 두고 화면에 준다.
- **Codex** `agent/codex.mjs`:
  - 띄우기: tmux, `codex [resume <id>] --no-daemon -c check_for_update_on_startup=false -c projects."<폴더>".trust_level="trusted" -c developer_instructions=…`. 승인·샌드박스 옵션은 건드리지 않는다.
  - 기록 읽기: `$CODEX_HOME/sessions/**/rollout-*.jsonl` 만. `auth.json`·`config.toml` 은 읽지 않는다. rollout → Claude Code 트랜스크립트 줄(사본 `~/.claude-bridge/runners/<sid>.jsonl`)로 바꾸는 순수 함수라, 서버·화면·봉인·줄 번호는 그대로 쓴다.
  - 턴: rollout 의 task_started / task_complete·turn_aborted.
  - 화면: 빈 입력칸(쉼), `Working (…esc to interrupt)`, 폴더 신뢰 질문, 명령 승인 질문 → 권한 카드(답은 선택지의 키).
  - 입력: 붙여 넣은 뒤 1 s 기다려 Enter(codex 의 붙여넣기 판정).
- **숨기기·거절**: 화면 `runnerCan`, 서버 `runnerGate`(409), 에이전트 `can`.
- **trust**: `new` 의 서명 항목에 `runner`(TRUST_VERSION 4). 서버를 믿지 않는 맥은 `open` 에서 맥의 기록만 쓴다.

## 2단계 (계획)

1. Claude Code 의 띄우기·기록 읽기·화면 판독·입력·턴 상태를 `agent/runners/claude.mjs` 로 옮겨, 모든 실행기가 `launch`·`sync`(→ 공통 이벤트)·`watch`·`deliver`·`turn`·`caps` 한 인터페이스를 따르게 한다.
2. Codex: MCP 도구 승인 창을 카드로, 작성 중 미리보기, 사용량 게이지, 모델 바꾸기(`/model`), 맥 밖에서 시작한 codex 대화 가져오기(adopt).
3. 다른 맥으로 옮기기(rollout 을 함께 보냄)와 복제(`codex fork`).
4. e2e 확장: 실행기를 오가는 다시 열기, trust 봉인 중 codex 세션.
