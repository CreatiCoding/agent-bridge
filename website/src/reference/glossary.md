---
description: Agent Bridge 문서와 화면에서 쓰는 용어와 약어의 뜻, 그리고 자세히 다루는 페이지를 모은 용어집이에요.
---

# 용어집

이 페이지는 문서와 화면에서 쓰는 용어와 약어를 한곳에 모아 뜻을 풀어요. 처음이라면 [소개](/guide/introduction)부터 읽고, 모르는 말이 나올 때 이 페이지로 돌아오세요.

이 페이지는 SPEC 판 1.309 기준이에요.

## 구성 요소

| 용어 | 뜻 | 관련 페이지 |
|---|---|---|
| 서버 | 사이트를 내주는 웹 서버 프로세스예요. 표준 라이브러리만 쓰는 Go 바이너리 하나이고, 로그인·중계·세션 목록·알림을 맡아요. Claude Code 를 직접 돌리지 않아요. | [구성과 연결](/guide/concepts/architecture) |
| 호스트 | 에이전트가 설치된 macOS 컴퓨터 한 대, 곧 내 맥이에요. 서버는 32자 16진수 hostId 로 알아봐요. | [구성과 연결](/guide/concepts/architecture) |
| 에이전트 | 호스트에서 도는 `agent.mjs` 프로세스예요. Claude Code 세션을 띄우고 읽어요. `127.0.0.1` 에서만 듣고 바깥으로 직접 연결하지 않아요. | [설치 스크립트와 에이전트 명령](/reference/agent-cli) |
| 연동 페이지 | 호스트의 브라우저 탭에 열어 두는 이 사이트의 페이지(`/bridge`)예요. 에이전트와 서버를 잇는 유일한 길이에요. | [구성과 연결](/guide/concepts/architecture) |
| 중계 | 연동 페이지가 에이전트와 서버 사이에서 메시지를 옮기는 일이에요. | [구성과 연결](/guide/concepts/architecture) |
| 조작 페이지 | 사람이 폰이나 웹에서 쓰는 화면이에요. 사이트의 `/` 에서 열려요. | [폰에서 세션 다루기](/guide/use/sessions) |
| 헤드리스 연동 모드 | 에이전트가 그 맥의 Chrome 을 화면 없이 띄워 연동 페이지를 대신 열어 두는 방식이에요. 맥마다 켜고 꺼요. | [맥을 늘 연결해 두기](/guide/use/always-on) |
| 플러그인 | 서버에 함께 빌드되는 기능 묶음이에요. 지금은 Slack 하나예요. | [플러그인 API](/reference/plugin-api) |

## 사람

| 용어 | 뜻 | 관련 페이지 |
|---|---|---|
| 사용자 | GitHub 계정(iOS 앱은 Apple 계정)으로 로그인한 사람이에요. 서버는 uid 로 알아봐요. 사용자마다 호스트와 세션이 따로예요. | [보안 모델](/guide/concepts/security) |
| 운영자 | 서버 환경 변수 `BRIDGE_ADMIN_LOGINS` 에 든 사용자예요. 접근 요청을 승인하고 운영 화면을 봐요. | [접근 관리와 운영 화면](/guide/operate/admin) |

## 세션과 대화

| 용어 | 뜻 | 관련 페이지 |
|---|---|---|
| 세션 | 서버가 관리하는 Claude Code 실행 단위 하나예요. sid(UUID)로 알아봐요. 세션은 늘 호스트에서 돌아요. | [세션의 일생](/guide/concepts/sessions) |
| 대화 | Claude Code 의 대화 기록 파일(`<conv>.jsonl`)과 그 id(conv)예요. `/clear` 를 하면 같은 세션 안에서 대화가 바뀔 수 있어요. | [맥의 파일과 경로](/reference/files#에이전트-폴더-밖) |
| 이벤트 | 세션 기록의 한 항목이에요. 세션마다 1부터 1씩 늘어나는 seq 가 붙어요. 원본은 그 세션의 맥에 있어요. | [세션의 일생](/guide/concepts/sessions) |
| 작업 폴더 | 세션이 도는 폴더(cwd)예요. | [폰에서 세션 다루기](/guide/use/sessions) |
| 카드 | 터미널 확인 창을 대신하는 결정 요청 하나예요. 종류는 권한 요청, 질문, 플랜 승인, 터미널 확인, 지시 대기예요. | [세션 상태와 카드](/reference/states#카드-종류) |
| 확인 창 | Claude Code 터미널에 그려지는 번호·키 선택 창이에요. 에이전트가 읽어서 카드로 바꿔요. | [세션 상태와 카드](/reference/states#에이전트가-스스로-넘기는-확인-창) |
| 붙잡은 글 | 도구가 도는 동안 보내서, 넣을 때를 기다리며 미뤄 둔 글이에요. | [세션 상태와 카드](/reference/states#붙잡은-글) |
| 전부 허용 | 세션의 권한 요청에 에이전트가 스스로 "허용"을 누르게 하는 스위치예요. 프로젝트 MCP 서버 사용 같은 다른 확인 창은 여전히 카드로 물어요. | [폰에서 세션 다루기](/guide/use/sessions) |
| 휴면 | 세션에 붙는 쉬는 중 표시예요. 세션 상태를 바꾸지 않아요. | [목록 정리와 잠금](/guide/use/organize) |

## 세션 다루기

| 용어 | 뜻 | 관련 페이지 |
|---|---|---|
| 옮기기 | 세션을 다른 호스트로 넘기는 일이에요. 보내는 호스트가 연결돼 있어야 해요. | [세션 옮기기](/guide/use/move) |
| 다시 열기 | 같은 호스트에서 같은 대화로 Claude Code 를 다시 띄우는 일이에요(새로고침, 다시 연결). | [세션의 일생](/guide/concepts/sessions) |
| 가져오기 | 호스트에 있는, Agent Bridge 밖에서 시작한 대화를 새 세션으로 만드는 일이에요. | [맥의 대화 가져오기](/guide/use/adopt) |
| 되살리기 | 호스트가 다시 켜진 뒤 에이전트가 세션을 스스로 다시 여는 일이에요. 12시간 안에 살아 있던 세션을 5개까지 열어요. | [한도와 시간](/reference/limits#세션-동작) |
| 잠금 | 세션에 거는 비밀번호 보호예요. | [목록 정리와 잠금](/guide/use/organize) |
| 열쇠 | 잠금을 푼 탭이 받는 토큰이에요. 12시간 동안 통하고 서버를 다시 띄우면 무효가 돼요. | [보안 모델](/guide/concepts/security) |
| 그룹 | 세션 목록의 묶음이에요. 3단계까지 겹쳐 넣을 수 있어요. | [목록 정리와 잠금](/guide/use/organize) |

## 알림과 맥 설정

| 용어 | 뜻 | 관련 페이지 |
|---|---|---|
| 알림 | 서버가 사용자마다 두는 알림 항목이에요. 30일, 30개까지 둬요. | [알림과 웹 푸시](/guide/use/notifications) |
| 웹 푸시 | 내용 없는 Web Push 로 브라우저의 서비스 워커를 깨워 알림을 띄우는 일이에요. | [알림과 웹 푸시](/guide/use/notifications) |
| 잠자기 막기 | 에이전트가 켜져 있는 동안 맥이 쓰지 않아서 잠드는 것을 막는 스위치예요(`caffeinate -i`). | [맥을 늘 연결해 두기](/guide/use/always-on) |
| 덮개를 닫아도 켜 두기 | 맥북의 덮개를 닫아도 잠들지 않게 하는 스위치예요(`pmset disablesleep`). 한 번 `awake setup` 이 필요해요. | [맥을 늘 연결해 두기](/guide/use/always-on) |
| 자동 복구 | 에이전트가 1분마다 스스로 살펴 고칠 수 있는 것을 고치는 일이에요. | [점검 항목](/reference/checks#자동-복구) |

## 약어와 외부 기술

| 약어 | 뜻 | 관련 페이지 |
|---|---|---|
| SSE | Server-Sent Events. 서버가 브라우저로 이어서 보내는 `text/event-stream` 응답이에요. | [주소와 HTTP API](/reference/routes) |
| CSRF | Cross-Site Request Forgery. 다른 사이트가 내 로그인으로 요청을 보내는 공격이에요. 서버는 같은 출처만 받아 막아요. | [주소와 HTTP API](/reference/routes#요청-규칙) |
| CSP | Content-Security-Policy 머리글이에요. | [보안 모델](/guide/concepts/security) |
| VAPID | Voluntary Application Server Identification. 웹 푸시를 보내는 서버를 밝히는 방식(RFC 8292)이에요. | [알림과 웹 푸시](/guide/use/notifications) |
| PBKDF2 | Password-Based Key Derivation Function 2(RFC 8018). 잠금 비밀번호를 120,000회 늘려 저장해요. | [보안 모델](/guide/concepts/security) |
| OAuth | GitHub OAuth App 로그인이에요. | [서버 올리기](/guide/operate/self-host) |
| tmux | 터미널 멀티플렉서예요. zeropty 가 안 될 때 세션이 그 안에서 돌아요. | [점검 항목](/reference/checks) |
| zeropty | 에이전트가 정해진 버전과 해시로 받아 세션 터미널로 쓰는 프로그램이에요. | [맥의 파일과 경로](/reference/files) |
| launchd | macOS 의 서비스 관리자예요. 에이전트를 백그라운드 서비스로 띄워요. | [설치 스크립트와 에이전트 명령](/reference/agent-cli#launchd-서비스) |
| seq | 세션 이벤트의 일련번호예요(1부터 1씩 늘어나는 정수). | — |
| sid | 세션 식별자(UUID)예요. | — |
| conv | 대화 식별자(Claude Code 의 session id, UUID)예요. | — |
| uid | 서버가 만든 사용자 식별자예요. | — |
| hostId | 호스트 식별자(16진수 32자)예요. | [설치 스크립트와 에이전트 명령](/reference/agent-cli#agentjson-키) |
