---
description: 에이전트가 맥에 쓰는 파일과 폴더(~/.claude-bridge, ~/.zeropty, launchd plist, sudoers 규칙, Claude Code 대화 기록)와 서버의 데이터 폴더(BRIDGE_DATA) 배치를 정리한 표예요.
---

# 맥의 파일과 경로

이 페이지는 에이전트가 **호스트**(에이전트가 설치된 맥)에 만드는 파일과 폴더, 그리고 서버가 데이터 폴더에 두는 파일을 빠짐없이 정리해요. 설치와 제거 방법은 [시작하기](/guide/getting-started)를, 서버 데이터 백업은 [서버 올리기](/guide/operate/self-host)를 보세요.

이 페이지는 SPEC 판 1.309 기준이에요.

## 에이전트 폴더 `~/.claude-bridge/`

에이전트 폴더는 `CLAUDE_BRIDGE_HOME` 으로 바꿀 수 있어요. 설치 스크립트는 늘 `~/.claude-bridge` 에 파일을 둬요. 폴더에는 에이전트 키와 모든 세션의 기록이 있어서, 설치 스크립트와 에이전트가 시작할 때마다 권한을 0700 으로 맞춰요.

### 프로그램과 설정

| 경로 | 쓰는 쪽 | 권한 | 설명 |
|---|---|---|---|
| `*.mjs` (17개) | 설치 스크립트, 자동 업데이트 | — | 에이전트 프로그램이에요. 목록은 [설치 스크립트](/reference/agent-cli#설치-스크립트-installsh)를 보세요. |
| `agent.json` | 에이전트 | 0600 | 설정과 신원(호스트 id, 에이전트 키 등)이에요. 키는 [agent.json 키](/reference/agent-cli#agentjson-키)를 보세요. |
| `sessions.json` | 에이전트 | 0600 | 이 맥의 세션 목록이에요(작업 폴더, 대화 id, 모델, 붙잡은 글 등). |
| `hooks.json` | 에이전트 | 0600 | 브리지 세션의 Claude Code 에만 `--settings` 로 넘기는 훅·상태 줄 설정이에요. 사람의 `~/.claude/settings.json` 은 건드리지 않아요. |
| `hook.header` | 에이전트 | 0600 | 훅이 `curl -H @파일` 로 붙이는 머리글(`x-bridge-key: <훅 키>`)이에요. 키를 명령줄에 싣지 않으려고 파일로 둬요. |
| `askpass` | 에이전트 | 0700 | 세션 안의 `sudo` 가 관리자 비밀번호를 사이트에서 받도록 부르는 스크립트예요. |
| `bin/sudo` | 에이전트 | 0700 | 세션의 `PATH` 앞에 두는 `sudo` 래퍼예요. `askpass` 를 써요. |
| `accounts.json` | 에이전트 | 0600 | 더한 Claude 계정 목록 `[{id, name, dir}]` 이에요. 기본 계정은 넣지 않아요. |
| `accounts/<id>/` | 에이전트, Claude Code | 0700 | 더한 Claude 계정의 설정 폴더(`CLAUDE_CONFIG_DIR`)예요. |
| `accounts-removed/<id>-<ms>/` | 에이전트 | — | 뺀 계정의 폴더예요. 지우지 않고 옮겨 둬요. |
| `skill-usage.json` | 에이전트 | — | 스킬을 얼마나 썼는지 세어 둔 것이에요. 스킬 메뉴의 순서에 써요. |

### 기록과 사본

| 경로 | 쓰는 쪽 | 권한 | 크기 | 설명 |
|---|---|---|---|---|
| `events/<sid>.jsonl` | 에이전트 | — | 돌리지 않음 | 서버가 순번을 매겨 내려보낸 세션 이벤트 기록이에요. 서버는 대화를 저장하지 않고 이 맥이 원본을 가져요. |
| `images/` | 에이전트 | 0700 | — | 페이지에서 보낸 그림과 대화 기록 속 그림이에요. |
| `prompts/<sid>.txt` | 에이전트 | 폴더 0700, 파일 0600 | — | 세션에 붙이는 지시문(`--append-system-prompt`)이에요. 세션을 내려놓으면 지워요. |
| `prompts/<sid>.mcp.json` | 에이전트 | — | — | 세션에 넘기는 MCP 설정(`--mcp-config`)이에요. |
| `overwritten/<sid>-<ms>-<이름>` | 에이전트 | 폴더 0700, 파일 0600 | — | 옮기기·다시 열기 때 작업 폴더의 지침 파일(`SESSION.md`, `AGENTS.md`, `CLAUDE.md`)을 덮어쓰기 전에 둔 원래 내용이에요. |
| `trimmed/<conv>-<ms>.jsonl` | 에이전트 | — | 원본 그대로 | "대화 기록 정리" 전의 원본 대화 기록이에요. 에이전트는 지우지 않아요. |
| `handoff.json` | 에이전트 | — | — | 에이전트가 다시 시작할 때 넘겨줄 세션 상태예요. 새 프로세스가 120,000 ms 안에 쓴 것을 읽고 지워요. |
| `cb-<uuid>.txt` | 에이전트 | 0600 | — | 긴 글을 터미널에 붙여 넣을 때 쓰는 임시 파일이에요. |

### 로그

| 경로 | 쓰는 쪽 | 권한 | 크기 | 설명 |
|---|---|---|---|---|
| `agent.log` | 에이전트 | 0600 | 돌리지 않음 | 한 줄에 JSON `{ ts, level, area, text, sid }` 하나씩 덧붙여요. 내용은 줄마다 2,000자까지예요. |
| `service.log` | launchd | — | 돌리지 않음 | 서비스 모드에서 에이전트의 표준 출력·오류 그대로예요. |
| `voice.log` | 에이전트 | 0600 | 512 KB 를 넘으면 뒤쪽 절반만 남김 | 음성 입력마다 시각, 받아쓴 원문, 다듬은 글, 걸린 시간을 한 줄씩 남겨요. |

### 실행 중 상태와 내려받은 도구

| 경로 | 쓰는 쪽 | 크기 | 설명 |
|---|---|---|---|
| `agent.pid` | 에이전트 | — | 돌고 있는 에이전트의 pid 예요. |
| `browser/` | 에이전트, Chrome | Chrome 프로필 크기 | 헤드리스 연동 모드에서 띄우는 Chrome 의 프로필(`--user-data-dir`)이에요. 사이트 로그인 쿠키가 들어 있어요. |
| `browser.pid` | 에이전트 | — | 헤드리스 Chrome 의 pid 예요. 에이전트가 다시 시작해도 같은 Chrome 을 이어받는 데 써요. |
| `whisper/` | 에이전트 | 모델마다 다름 | 음성 입력용 whisper.cpp 모델(`ggml-<이름>.bin`), 말소리 감지 모델 `ggml-silero-v5.1.2.bin`(885 KB), 잡음 줄이기 모델 `rnnoise.rnnn`, `whisper-server.pid` 를 둬요. |
| `zeropty/<버전>/` | 에이전트 | — | 에이전트가 GitHub 릴리스에서 받아 SHA-256 을 확인한 [zeropty](https://github.com/CreatiCoding/zeropty)(지금 0.1.3)예요. `zeropty`, `zeropty-tty`, `shim.dylib` 이 들어 있어요. |
| `.update-XXXXXX/` | 자동 업데이트 | — | 업데이트 파일을 받는 임시 폴더예요. 끝나면 지워요. |
| `.update.XXXXXX/` | 설치 스크립트 | — | 설치 파일을 받는 임시 폴더예요. 끝나면 지워요. |

## 에이전트 폴더 밖

| 경로 | 쓰는 쪽 | 권한 | 크기 | 설명 |
|---|---|---|---|---|
| `~/Library/LaunchAgents/dev.claude-bridge.agent.plist` | `service install` | — | — | 백그라운드 서비스 정의예요. 파일 이름은 `CLAUDE_BRIDGE_LABEL` 을 따라요. `service uninstall` 이 지워요. |
| `/etc/sudoers.d/claude-bridge-pmset` | `awake setup` | 0440, root:wheel | — | 이 사용자가 비밀번호 없이 `pmset -a disablesleep 0`, `pmset -a disablesleep 1` 만 실행하게 하는 규칙이에요. `awake remove` 가 지워요. |
| `~/.zeropty/tty/<해시>/bin/claude` | zeropty-tty | — | claude 한 벌 크기(약 260MB) | zeropty-tty 가 처음에 만드는 서명을 바꾼 `claude` 사본이에요. claude 가 바뀌면 다시 만들어요. |
| `~/.zeropty/mux.sock` | zeropty | — | — | zeropty 서버의 소켓이에요(`ZEROPTY_SOCK` 으로 바꿀 수 있어요). 에이전트가 꺼져도 세션은 남아요. |
| `~/.claude/projects/<폴더>/<conv>.jsonl` | Claude Code | — | 대화가 길수록 커짐 | Claude Code 가 쓰는 **대화** 기록(트랜스크립트)이에요. `<폴더>` 는 작업 폴더 경로의 영문자·숫자가 아닌 글자를 `-` 로 바꾼 이름이에요. 에이전트는 이 파일을 읽어 서버로 보내요. |
| `~/.claude-bridge/accounts/<id>/projects/<폴더>/<conv>.jsonl` | Claude Code | — | 같음 | 더한 Claude 계정으로 연 세션의 대화 기록이에요. |

`CLAUDE_CONFIG_DIR` 을 바꾸면 `~/.claude` 대신 그 폴더를 써요. `claude auth status` 가 `projectsDirectory` 를 알려 주면 에이전트는 그 경로를 따라요.

::: warning 주의
대화 기록이 100MB 를 넘으면 사이트에서 글을 보낼 수 없어요(`/` 로 시작하는 명령은 예외예요). 세션 메뉴의 "대화 기록 정리"는 원본을 `trimmed/` 로 옮기고 마지막 압축 앞부분을 덜어 내요.
:::

## 서버 데이터 폴더 `BRIDGE_DATA`

서버의 영속 상태는 `BRIDGE_DATA`(이미지 기본값 `/data`) 아래 파일뿐이에요. 데이터베이스를 쓰지 않아요. 1.277 부터 서버는 대화 원본 줄·화면 이벤트·대화 그림을 디스크에 쓰지 않아요. 원본은 그 세션의 맥에 있어요. 쓰기 도중에는 `<파일>.tmp` 가 잠깐 생겨요.

```text
BRIDGE_DATA/
├── users.json
├── logins.json
├── access.json
├── login-pins.json
├── hosts.json
├── pid.json
├── vapid.json
├── instance.json
├── handover.json
├── handover.secret
├── retention.json
├── models.json
├── agent-seq.json
├── app-build.json
├── skills-repo.json
├── skills-install.secret
├── report-auto.json
├── reports/
└── u/
    └── <uid>/
        ├── prefs.json
        ├── notices.json
        ├── push.json
        ├── apns.json
        ├── apple.json
        ├── plugins.json
        ├── hosts/<hostId>.log, <hostId>.log.1
        ├── uploads/
        └── s/<sid>/meta.json
```

| 경로 | 설명 |
|---|---|
| `users.json` | 사용자 목록이에요(GitHub 로그인 이름, 표시 이름, 아바타 주소 등). |
| `logins.json` | 로그인 토큰의 SHA-256 과 만료예요. 토큰 원문은 저장하지 않아요. |
| `access.json` | 접근 요청 기록(처음·마지막 시각, 시도 수, 결정한 운영자)이에요. |
| `login-pins.json` | 로그인 이름 → 처음 쓴 GitHub id 이름표예요. 이름을 바꿔 남의 허용을 얻지 못하게 해요. |
| `hosts.json` | 호스트 목록(이름, 종류, 홈 경로, 에이전트 정보)이에요. |
| `pid.json` | Slack 형식 세션 번호 카운터예요. |
| `vapid.json` | 웹 푸시에 쓰는 VAPID(Voluntary Application Server Identification) 키 쌍이에요. 서버가 처음 켜질 때 만들어요. |
| `instance.json`, `handover.json`, `handover.secret` | 끊기지 않는 배포 때 두 서버가 주고받는 표시와 비밀값이에요. |
| `retention.json` | 오래된 항목 정리의 기준 시각이에요. |
| `models.json` | 새 세션 화면의 모델 목록과 마지막 확인 정보예요. |
| `agent-seq.json` | 내준 에이전트 업데이트의 서명 순번 기록이에요. |
| `app-build.json` | iOS 앱의 최신 빌드 번호예요. 운영자의 맥이 보낸 값만 받아요. |
| `skills-repo.json` | 운영 화면에서 정한 스킬 저장소예요(1.294 의 값을 옮기는 데 써요). |
| `skills-install.secret` | `/skills/install.sh` 서명 키예요. 처음 시작 때 만들고 0600 이에요. |
| `report-auto.json` | 문제 제보 자동 대응 설정이에요(기본 꺼짐). |
| `reports/` | 문제 제보와 그 그림·영상이에요. 90일 뒤 지워요. |
| `u/<uid>/prefs.json` | 그룹, 기본 프롬프트, 음성 설정, 스킬 저장소 같은 사용자 설정이에요. |
| `u/<uid>/notices.json` | 알림이에요. 새것부터 30개, 30일까지 둬요. |
| `u/<uid>/push.json` | 웹 푸시 구독이에요. 20개까지 둬요. |
| `u/<uid>/apns.json` | iOS 앱 알림 기기 토큰이에요. |
| `u/<uid>/apple.json` | Apple 로 로그인한 계정의 정보예요. |
| `u/<uid>/plugins.json` | 플러그인 설정과 상태예요. 비밀 값은 목록 응답에서 `••••••••` 로 가려요. |
| `u/<uid>/hosts/<hostId>.log` | 호스트 로그(JSON Lines)예요. 5,242,880 byte(5 MiB)를 넘으면 `.log.1` 로 돌려요. |
| `u/<uid>/uploads/` | 보낸 영상이에요. 맥이 받으면 바로, 늦어도 24시간 뒤 지워요. 한 개 500 MB 까지예요. |
| `u/<uid>/s/<sid>/meta.json` | 세션 정보(제목, 상태, 맥, 작업 폴더, 통계 숫자 등)예요. |

1.277 전에 서버에 저장된 대화 파일(`transcript*.jsonl`, `events.jsonl`, `fork-skip.txt`, `u/<uid>/img/`)은 운영자가 `BRIDGE_PURGE=1` 로 켜고 지울 때까지 남아요. 자세한 내용은 [접근 관리와 운영 화면](/guide/operate/admin)을 보세요.
