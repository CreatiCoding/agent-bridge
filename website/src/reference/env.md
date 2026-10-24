---
description: Agent Bridge 서버와 맥 에이전트가 읽는 환경 변수 전체를 기본값, 필수 여부, 설명과 함께 정리한 표예요.
---

# 환경 변수

이 페이지는 서버와 에이전트가 읽는 환경 변수를 빠짐없이 정리해요. 서버를 올리는 순서는 [서버 올리기](/guide/operate/self-host)를 보세요.

이 페이지는 SPEC 판 1.309 기준이에요.

모든 환경 변수는 프로세스가 시작할 때 한 번 읽어요. 그래서 값을 바꾸면 서버나 에이전트를 다시 시작해야 해요.

## 서버 환경 변수

### 기본

| 이름 | 기본값 | 필수 | 설명 |
|---|---|---|---|
| `BRIDGE_ORIGIN` | 빈 값 | GitHub 로그인을 쓰면 예 | 사이트의 공개 주소예요(예: `https://bridge.example.com`). 끝의 `/` 는 지워요. 쿠키 `Secure`, OAuth 콜백, 설치 스크립트 주소, 웹 푸시, 플러그인 링크에 써요. 비어 있으면 요청의 `X-Forwarded-Proto`(없으면 `http`)와 `Host` 로 만들어요. `GITHUB_CLIENT_ID` 가 있는데 비어 있으면 서버가 시작하지 않아요. |
| `PORT` | `4300` | 아니오 | 서버가 듣는 TCP 포트예요(모든 인터페이스). 이미지도 `4300` 이에요. |
| `BRIDGE_DATA` | `<저장소>/data` (이미지 `/data`) | 아니오 | 서버 상태를 두는 폴더예요. 없으면 만들어요. 배치는 [맥의 파일과 경로](/reference/files#서버-데이터-폴더-bridge_data)를 보세요. |
| `BRIDGE_ROOT` | 실행 파일 옆 또는 작업 폴더 | 아니오 | 저장소 위치(`agent/`, `web/` 가 있는 곳)예요. 비우면 실행 파일 옆과 작업 폴더에서 `agent/agent.mjs` 가 있는 곳을 찾아요. |
| `TZ` | 없음(컨테이너는 UTC) | 아니오 | 통계의 날짜·요일·시간 경계에 쓰는 IANA 시간대 이름이에요(예: `Asia/Seoul`). |

### 로그인과 접근

| 이름 | 기본값 | 필수 | 설명 |
|---|---|---|---|
| `GITHUB_CLIENT_ID` | 빈 값 | GitHub 로그인을 쓰면 예 | GitHub OAuth 앱의 client id 예요. 비어 있으면 GitHub 로그인이 꺼지고 `/api/auth/github` 는 안내 페이지(503)를 내요. |
| `GITHUB_CLIENT_SECRET` | 빈 값 | `GITHUB_CLIENT_ID` 와 함께 예 | GitHub OAuth 앱의 client secret 이에요. 토큰 교환에만 쓰고 로그에 남기지 않아요. |
| `GITHUB_ALLOWED_LOGINS` | 빈 값 | 아니오 | 들어올 수 있는 GitHub 로그인 이름을 쉼표로 적어요. 앞뒤 공백을 지우고 소문자로 맞춰요. `*` 는 누구나예요. 목록에 없는 계정은 운영자 승인을 기다려요. |
| `BRIDGE_ADMIN_LOGINS` | 빈 값 | 아니오 | **운영자** 계정을 쉼표로 적어요. 허용 목록에 없어도 로그인되고 운영 화면을 볼 수 있어요. |
| `BRIDGE_DEMO` | 없음(꺼짐) | 아니오 | 정확히 `1` 이면 공개 데모를 켜요. 로그인 화면과 승인 대기 안내에 "데모로 둘러보기" 가 생겨요. |
| `BRIDGE_DEV_LOGIN` | 없음(꺼짐) | 아니오 | 정확히 `1` 이면 GitHub 없이 `/api/auth/dev?login=이름` 으로 로그인돼요. 개발·시험용이에요. |

::: danger 공개 서버에서 BRIDGE_DEV_LOGIN 을 켜지 마세요
`BRIDGE_DEV_LOGIN=1` 이면 주소 하나로 아무 이름으로나 로그인할 수 있어요. 인터넷에 열린 서버에는 절대 두지 마세요.
:::

### iOS 앱과 Apple

| 이름 | 기본값 | 필수 | 설명 |
|---|---|---|---|
| `APPLE_CLIENT_ID` | 코드에 정한 앱 번들 id | 아니오 | Apple 로그인 토큰의 `aud` 와 client secret 의 `sub` 에 써요. 직접 만든 앱이면 그 번들 id 로 바꾸세요. |
| `APPLE_TEAM_ID` | 없음 | Apple 기능을 쓰면 예 | Apple 개발자 팀 id 예요. |
| `APPLE_KEY_ID` | 없음 | Apple 기능을 쓰면 예 | Apple 키 id 예요. |
| `APPLE_PRIVATE_KEY` | 없음 | Apple 기능을 쓰면 예 | `.p8` 키의 PEM 전체 또는 본문이에요. 줄바꿈을 `\n` 으로 써도 돼요. 셋이 다 있어야 계정 삭제 때 Apple 토큰을 취소해요. 읽지 못하면 로그를 남기고 꺼요. |
| `APNS_KEY_ID` | 없음 | 아니오 | 앱 알림 전용 키 id 예요. `APNS_PRIVATE_KEY` 와 함께 있어야 써요. 없으면 `APPLE_KEY_ID` 를 써요. |
| `APNS_PRIVATE_KEY` | 없음 | 아니오 | 앱 알림 전용 키예요. 형식은 `APPLE_PRIVATE_KEY` 와 같아요. |
| `APNS_TEST_ORIGIN` | 없음 | 아니오 | 시험용이에요. `BRIDGE_DEV_LOGIN=1` 일 때만 읽고, APNs 대신 이 HTTP/2 주소로 보내요. |
| `APPLE_TEST_JWKS` | 없음 | 아니오 | 시험용이에요. `BRIDGE_DEV_LOGIN=1` 일 때만 읽고, Apple 공개 키 대신 이 JWKS(JSON) 를 써요. |

### 스킬 마켓플레이스

| 이름 | 기본값 | 필수 | 설명 |
|---|---|---|---|
| `SKILLS_REPO` | 빈 값 | 아니오 | 스킬 저장소의 서버 기본값(`owner/repo`)이에요. 사용자가 설정에서 자기 저장소를 정하면 그것이 먼저예요. 둘 다 없으면 그 사람의 `/skills` 는 꺼져요. |
| `SKILLS_GITHUB_TOKEN` | 빈 값 | `/skills` 를 쓰면 예(App 이 없을 때) | 스킬 저장소에 Contents: Read 만 가진 fine-grained 토큰이에요. |
| `SKILLS_GITHUB_APP_ID` | 없음 | 아니오 | GitHub App 의 App ID 또는 Client ID 예요. `SKILLS_GITHUB_APP_KEY` 와 함께 있으면 토큰보다 먼저 써요. |
| `SKILLS_GITHUB_APP_KEY` | 없음 | 아니오 | GitHub App 의 비밀 키 PEM(또는 그 base64)이에요. 읽지 못하면 로그를 남기고 `SKILLS_GITHUB_TOKEN` 으로 넘어가요. |
| `SKILLS_GITHUB_API` | `https://api.github.com` | 아니오 | 스킬 저장소를 읽는 API 주소예요. 시험용이에요. |

### 화면, 미리보기, 플러그인

| 이름 | 기본값 | 필수 | 설명 |
|---|---|---|---|
| `BRIDGE_SOURCE_URL` | `https://github.com/CreatiCoding/agent-bridge` | 아니오 | 화면 아래 "소스 코드" 링크예요(AGPL-3.0). 포크는 자기 저장소 주소로 바꾸세요. `http(s)://` 로 시작하지 않거나 공백·`"`·`<`·`>` 가 있으면 기본값을 써요. |
| `BRIDGE_GUIDE_DOKPLOY_URL` | `https://<Dokploy 주소>` | 아니오 | MCP 안내 페이지(`/guide/mcp`)에 보여 줄 배포 도구 화면 주소예요. 비우면 자리표시가 그대로 보여요. |
| `BRIDGE_PREVIEW_ORIGIN` | `BRIDGE_ORIGIN` 의 호스트 앞에 `lp.` (없으면 `http://lp.localhost:<PORT>`) | 아니오 | 로컬 미리보기를 내주는 출처예요. DNS 와 인증서가 이 서버로 와야 해요. |
| `BRIDGE_PREVIEW_POOL` | `https://lp1-…` ~ `lp8-…` 후보 | 아니오 | 미리보기 출처 후보를 쉼표로 적어 바꿔요. |
| `SLACK_API_URL` | `https://slack.com/api` | 아니오 | Slack Web API 주소예요. 시험용이에요. |
| `SLACK_AUTO_EDIT_MS` | `3000` | 아니오 | Slack 에서 자동 허용 줄 묶음을 고쳐 쓰기까지 기다리는 시간(ms)이에요. |

### 운영

| 이름 | 기본값 | 필수 | 설명 |
|---|---|---|---|
| `BRIDGE_PURGE` | 없음(꺼짐) | 아니오 | 정확히 `1` 이면 운영 화면에서 기존 데이터 정리(1.277 전의 대화 파일, 기한 지난 알림·제보 등)를 실행할 수 있어요. 꺼져 있으면 409 로 거절해요. |
| `BRIDGE_RUN_AS_ROOT` | 없음 | 아니오 | 정확히 `1` 이면 root 로 시작한 서버가 그대로 root 로 돌아요. 없으면 넘겨주기가 끝난 뒤 데이터 폴더를 `node`(1000) 에게 넘기고 그 사용자로 바꿔요. |
| `BRIDGE_TRACE` | 없음(꺼짐) | 아니오 | 정확히 `1` 이면 연동 페이지를 지나는 메시지 종류를 표준 출력에 찍어요. 내용은 찍지 않아요. |

웹 푸시의 VAPID 키는 환경 변수가 아니에요. 서버가 처음 켜질 때 `BRIDGE_DATA/vapid.json` 에 만들어요. 1.219 에 없앤 `DEMO_LOGIN`·`DEMO_PASSWORD` 는 더 읽지 않으니 지워도 돼요.

## 에이전트 환경 변수

서비스 모드에서는 launchd 가 plist 에 적힌 값만 넘겨요. plist 에는 `PATH`, `HOME`, `LANG` 과, `service install` 때 설정돼 있던 `CLAUDE_BRIDGE_HOME`·`CLAUDE_CONFIG_DIR`·`CLAUDE_BRIDGE_LABEL` 만 들어가요. 그래서 "서비스 모드" 열이 "다시 설치"인 변수는 바꾼 뒤 `service install` 을 다시 해야 하고, "쓰이지 않음"인 변수는 서비스 모드에서 기본값으로 돌아요.

| 이름 | 기본값 | 필수 | 서비스 모드 | 설명 |
|---|---|---|---|---|
| `CLAUDE_BRIDGE_HOME` | `~/.claude-bridge` | 아니오 | 다시 설치 | 에이전트 폴더예요. 자동 업데이트는 에이전트 파일이 이 폴더에 있을 때만 해요. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | 아니오 | 다시 설치 | Claude Code 설정 폴더예요. 대화 기록은 `<폴더>/projects` 에서 찾아요. |
| `CLAUDE_BRIDGE_LABEL` | `dev.claude-bridge.agent` | 아니오 | 다시 설치 | launchd 라벨과 plist 파일 이름이에요. |
| `CLAUDE_BRIDGE_CLAUDE` | `claude` | 아니오 | 쓰이지 않음 | 세션과 점검에서 부르는 claude 명령 이름이나 경로예요. |
| `CLAUDE_BRIDGE_DEFAULT_BRANCHES` | `main,develop,master` | 아니오 | 쓰이지 않음 | 자동 push 하지 않는 기본 브랜치예요. 쉼표로 나누고 공백은 지우지 않아요. |
| `CLAUDE_BRIDGE_SYNC_FILES` | `SESSION.md,AGENTS.md,CLAUDE.md` | 아니오 | 쓰이지 않음 | git 이 아닌 작업 폴더에서 옮길 때 따라가는 지침 파일이에요. |
| `CLAUDE_BRIDGE_SKIP_TOOL_PROMPT` | 없음 | 아니오 | — | 값이 있으면 시작 때 tmux 설치를 묻지 않아요. 설치 스크립트가 `1` 로 둬요. |
| `PATH` | 셸의 값 | 예 | 설치 때 값으로 고정 | tmux·git·claude·gh·node 를 찾는 경로예요. |
| `LANG` | 셸의 값(plist 는 비어 있으면 `en_US.UTF-8`) | 아니오 | 설치 때 값으로 고정 | 자식 프로세스의 로캘이에요. |
| `HOME` | 로그인 사용자의 홈 | 예 | 설치 때 값으로 고정 | 상태·기록 경로의 기준이에요. |
| `CB_DELEGATE` | 에이전트가 넣음 | — | — | 내부용이에요. 직접 정하지 않아요. 세션의 `bridge` MCP 서버(`mcp.mjs`)가 다른 맥에 일을 맡길 때 부르는 에이전트 주소 `http://127.0.0.1:<port>/delegate?sid=<sid>` 예요. |
| `CB_KEY_FILE` | 에이전트가 넣음 | — | — | 내부용이에요. 직접 정하지 않아요. `bridge` MCP 서버가 에이전트를 부를 때 쓰는 훅 키 머리글 파일(`hook.header`)의 경로예요. |

에이전트는 세션에 `CB_HOOK=http://127.0.0.1:<port>/hook?sid=<sid>` 와 `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` 를 스스로 넣고, claude 를 띄우기 전에 `CLAUDECODE`·`CLAUDE_CODE_SESSION_ID` 같은 바깥 Claude Code 의 변수를 지워요. 사용자가 정하는 값이 아니에요.

## 서명 스크립트 환경 변수

포크를 운영하며 에이전트 업데이트에 직접 서명할 때만 써요. 자세한 내용은 [에이전트 서명 키](/guide/operate/signing)를 보세요.

| 이름 | 기본값 | 필수 | 설명 |
|---|---|---|---|
| `CLAUDE_BRIDGE_SIGN_KEY` | `~/.claude-bridge-signing/agent-ed25519.pem` | 아니오 | `node scripts/sign-agent.mjs` 가 쓰는 ed25519 개인 키 파일 경로예요. |
