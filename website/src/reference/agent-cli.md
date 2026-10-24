---
description: 맥에 에이전트를 까는 install.sh 와 node ~/.claude-bridge/agent.mjs 의 모든 명령, 옵션, 기본값, agent.json 에 저장되는 키를 정리한 표예요.
---

# 설치 스크립트와 에이전트 명령

이 페이지는 맥에 **에이전트**(맥에서 도는 `agent.mjs` 프로세스)를 까는 설치 스크립트와 에이전트의 명령·옵션, 설정 파일 `agent.json` 의 키를 빠짐없이 정리해요. 사용법은 [시작하기](/guide/getting-started)와 [맥을 늘 연결해 두기](/guide/use/always-on)를 보세요.

이 페이지는 SPEC 판 1.309 기준이에요.

## 설치 스크립트 `install.sh`

```sh [터미널]
curl -fsSL SITE/install.sh | bash
curl -fsSL SITE/install.sh | bash -s -- --foreground --name "작업용 맥북"
```

`SITE` 는 서버 주소예요(예: `https://bridge.example.com`). 서버가 스크립트 안의 사이트 주소와 에이전트 파일 목록을 채워서 내줘요. `bash -s --` 뒤의 인자는 아래 표의 `--foreground` 를 빼고 모두 에이전트에 그대로 넘어가요.

| 인자 | 기본값 | 설명 |
|---|---|---|
| (없음) | — | 에이전트를 백그라운드 서비스로 설치해요(`agent.mjs SITE service install` 을 실행). |
| `--foreground` | 꺼짐 | 서비스로 설치하지 않고 이 터미널에서 에이전트를 돌려요. 터미널을 닫으면 에이전트도 꺼져요. |
| 그 밖의 인자 | — | [에이전트 옵션](#옵션)으로 그대로 넘겨요(예: `--name`, `--kind`, `--no-auto-update`, `--mux tmux`). |

스크립트가 하는 일은 순서대로 아래와 같아요.

| 순서 | 하는 일 | 실패하면 |
|---|---|---|
| 1 | macOS 인지 확인해요. | "이 설치 스크립트는 macOS 용입니다." 후 종료 코드 1 |
| 2 | PATH 에 없어도 `/opt/homebrew/bin/brew`, `/usr/local/bin/brew` 를 찾아 Homebrew 를 써요. | 계속 |
| 3 | `node` 를 확인하고, 없으면 `brew install node` 를 물어요. | node 가 없으면 종료 코드 1 |
| 4 | `tmux` 를 확인하고, 없으면 설치를 물어요. 세션은 에이전트가 받는 [zeropty](https://github.com/CreatiCoding/zeropty) 에서 돌고, tmux 는 그것이 안 될 때의 대비예요. | 계속(tmux 없이도 zeropty 로 세션을 열어요) |
| 5 | `git` 을 확인하고, 없으면 `brew install git` 을 물어요. 직접 설치는 `xcode-select --install` 이에요. | 계속(없는 도구로 표시) |
| 6 | `claude` 를 확인해요. 자동으로 깔지는 않아요. | 계속(없는 도구로 표시) |
| 7 | node 가 18 이상인지 확인해요. | 종료 코드 1 |
| 8 | `~/.claude-bridge` 를 만들고 권한을 0700 으로 맞춰요. | — |
| 9 | 에이전트 파일 17개를 임시 폴더에 받아 `node --check` 로 검사한 뒤 한꺼번에 옮겨요. | 하나라도 실패하면 아무것도 바꾸지 않고 끝나요 |
| 10 | `CLAUDE_BRIDGE_SKIP_TOOL_PROMPT=1` 을 두고 에이전트를 실행해요. | — |

에이전트 파일 17개는 `agent.mjs`, `dialog.mjs`, `preview.mjs`, `screen.mjs`, `plugins.mjs`, `skills.mjs`, `split.mjs`, `guard.mjs`, `accounts.mjs`, `voice.mjs`, `mcp.mjs`, `cache.mjs`, `scrub.mjs`, `store.mjs`, `stats.mjs`, `mux.mjs`, `keys.mjs` 예요.

::: tip 없는 도구가 있을 때
`git`·`claude` 가 없어도 에이전트는 켜져요. 그 도구를 깔기 전까지 세션을 시작할 수 없고, 깐 뒤에는 에이전트를 다시 켜지 않아도 돼요. 어떤 점검이 세션 시작을 막는지는 [점검 항목](/reference/checks)을 보세요.
:::

## 에이전트 명령

```sh [터미널]
node ~/.claude-bridge/agent.mjs [SITE] [명령] [옵션...]
```

`SITE` 는 `http://` 나 `https://` 로 시작하는 첫 인자예요. 한 번 주면 `agent.json` 의 `site` 에 저장되므로 다음부터는 빼도 돼요.

| 명령 | 사이트 주소 필요 | 하는 일 | 종료 코드 |
|---|---|---|---|
| (없음) | 예 | 이 터미널에서 에이전트를 돌려요. 처음이면 기기 종류와 이름을 물어요. | 계속 실행 |
| `service install` | 예 | 점검 → 돌던 에이전트 내리기 → launchd plist 쓰기 → `launchctl bootstrap`(실패하면 `load -w`) → 250 ms 간격으로 40번 `/ping` 확인. 끝나면 연동 링크를 열어요. | 응답하면 0, 아니면 1 |
| `service status` | 아니오 | 서비스 설치·켜짐 여부, `/ping` 응답, 로그 경로(`service.log`)를 보여요. `service` 만 써도 같아요. | 0 |
| `service uninstall` | 아니오 | `launchctl bootout` 후 plist 를 지워요. 설정과 로그는 `~/.claude-bridge` 에 남아요. | 0 |
| `link` | 예 | 연동 링크 `SITE/bridge#port=PORT&key=KEY` 를 출력하고 macOS 면 브라우저로 열어요. | 0 |
| `doctor` | 아니오 | 점검만 하고 결과를 출력해요. 설정 파일·폴더를 만들지 않아요. | 실패(`fail`)가 있으면 1, 없으면 0 |
| `awake setup` | 아니오 | 덮개를 닫아도 켜 두기용 sudoers 규칙 `/etc/sudoers.d/claude-bridge-pmset` 을 설치해요. `visudo -cf` 로 검사한 뒤 관리자 비밀번호를 한 번 물어요. | 성공 0, 실패 1 |
| `awake status` | 아니오 | 규칙이 설치돼 있는지 보여요. `awake` 만 써도 같아요. | 0 |
| `awake remove` | 아니오 | `pmset -a disablesleep 0` 으로 되돌리고 규칙 파일을 지워요. | 성공 0, 실패 1 |
| 그 밖의 단어 | — | "모르는 명령입니다: …" 를 출력해요. | 1 |

사이트 주소가 필요한 명령에서 주소가 없으면 사용법을 출력하고 종료 코드 1 로 끝나요.

## 옵션

| 옵션 | 값 | 기본값 | `agent.json` 에 저장 | 설명 |
|---|---|---|---|---|
| `--port N` | 정수 | `4317` | 예 (`port`) | 127.0.0.1 에서 듣는 포트예요. 다른 프로그램이 쓰면 1씩 올려 최대 10번 시도하고, 바뀐 포트를 저장해요. |
| `--name 이름` | 문자열 | 처음 실행 때 물음 | 예 (`name`) | 사이트에 보일 맥 이름이에요. 물어서 받을 때는 60자에서 잘라요. |
| `--kind 종류` | `imac`·`macbook`·`macmini`·`macstudio`·`other` | `system_profiler` 로 감지 | 예 (`kind`) | 기기 종류예요. 그 밖의 값이면 종료 코드 1 로 끝나요. |
| `--keep-awake` | 없음 | 꺼짐 | 예 (`keepAwake: true`) | 에이전트가 켜져 있는 동안 쓰지 않아도 맥이 잠들지 않게 해요(`caffeinate -i`). |
| `--allow-sleep` | 없음 | — | 예 (`keepAwake: false`) | 잠자기 막기를 꺼요. |
| `--no-auto-update` | 없음 | 꺼짐(자동 업데이트 받음) | 예 (`noAutoUpdate: true`) | 서버가 내준 새 에이전트를 받지 않아요. 서비스 모드도 `agent.json` 을 읽어 따라요. |
| `--auto-update` | 없음 | — | 예 (`noAutoUpdate: false`) | 자동 업데이트를 다시 받아요. `--no-auto-update` 와 함께 주면 이게 이겨요. |
| `--chrome` | 없음 | 켜짐 | 예 (`chrome: true`) | 이 맥이 여는 새 세션을 `claude --chrome`(Claude in Chrome)으로 띄워요. |
| `--no-chrome` | 없음 | — | 예 (`chrome: false`) | 새 세션을 `--chrome` 없이 띄워요. |
| `--mux tmux` | `tmux` | — | 예 (`mux: "tmux"`) | 새 세션도 zeropty 대신 tmux 에서 열어요. |
| `--mux auto` | `auto` | 자동 | 예 (`mux` 를 지움) | zeropty 가 준비돼 있으면 새 세션을 zeropty 에서 열어요. 그 밖의 값이면 종료 코드 1 로 끝나요. |
| `--no-open` | 없음 | 꺼짐 | 아니오(이번 실행만) | 브라우저를 열지 않아요. |
| `--service` | 없음 | — | 아니오(이번 실행만) | launchd 가 붙이는 옵션이에요. 묻지 않고, 브라우저를 열지 않고, 연동 링크를 출력하지 않아요. 직접 쓸 일은 없어요. |

::: tip 서비스 모드에서 옵션 바꾸기
launchd 는 옵션 없이 `--service` 만 붙여 에이전트를 띄워요. 그래서 저장되는 옵션은 `agent.json` 에 남겨 두고 서비스가 읽어요. 저장되는 옵션을 바꾸려면 `node ~/.claude-bridge/agent.mjs --no-auto-update service install` 처럼 서비스를 다시 설치하세요.
:::

## launchd 서비스

| 항목 | 값 |
|---|---|
| 라벨 | `dev.claude-bridge.agent` (`CLAUDE_BRIDGE_LABEL` 로 바꿀 수 있어요) |
| plist 위치 | `~/Library/LaunchAgents/<라벨>.plist` |
| 도메인 | `gui/<사용자 uid>` |
| 실행 인자 | `which node` 의 경로, `agent.mjs` 의 절대 경로, `--service` |
| 환경 변수 | `PATH`, `HOME`, `LANG`(비어 있으면 `en_US.UTF-8`), 그리고 설치 때 설정돼 있던 `CLAUDE_BRIDGE_HOME`·`CLAUDE_CONFIG_DIR`·`CLAUDE_BRIDGE_LABEL` |
| 켜지는 때 | 맥에 로그인할 때(`RunAtLoad`), 꺼지면 다시 띄움(`KeepAlive`, `ThrottleInterval` 10초) |
| 출력 | 표준 출력·오류 모두 `~/.claude-bridge/service.log` |

에이전트 쪽 환경 변수는 [환경 변수](/reference/env#에이전트-환경-변수)를 보세요.

## `agent.json` 키

`~/.claude-bridge/agent.json` 은 에이전트가 처음 실행될 때 만들고 실행할 때마다 덮어써요(`doctor` 는 쓰지 않아요). 파일 권한은 0600 이에요.

| 키 | 자료형 | 기본값 | 바꾸는 곳 | 설명 |
|---|---|---|---|---|
| `hostId` | 문자열(16진수 32자) | 처음 실행 때 무작위 생성 | 에이전트 | 서버가 이 맥을 알아보는 **호스트** 식별자예요. 손으로 바꾸면 서버는 다른 맥으로 등록해요. |
| `key` | 문자열(base64url 32자) | 처음 실행 때 무작위 생성 | 에이전트, 기기 화면의 키 바꾸기 | 연동 페이지가 127.0.0.1 의 에이전트에 붙을 때 쓰는 비밀 키예요. |
| `keyGen` | 정수 | `2` | 에이전트 | 키 세대예요. 1.140 전에 만든 키(세대 1)는 연동 탭이 이어지면 한 번 바꿔요. |
| `keyAt` | epoch ms | 없음 | 에이전트 | 키를 마지막으로 바꾼 때예요. |
| `oldKey` | `{ key, until }` | 없음 | 에이전트 | 바꾸기 전 키예요. 다른 브라우저 탭이 따라올 수 있게 15분 동안 더 통해요. |
| `retiredKeys` | 배열 | 없음 | 에이전트 | 예전 키들의 지문이에요. 그 키를 가진 브라우저가 길을 찾게 해요. |
| `hookKey` | 문자열(base64url) | 처음 실행 때 무작위 생성 | 에이전트 | Claude Code 훅이 에이전트의 `/hook`·`/statusline` 에 보낼 때만 쓰는 키예요. 명령줄에 실리지 않아요. |
| `site` | URL | 없음 | 명령줄의 사이트 주소 | 사이트 주소예요. 끝의 `/` 는 지워요. |
| `port` | 정수 | `4317` | `--port`, 포트 자동 고르기 | 듣는 포트예요. |
| `kind` | `imac`·`macbook`·`macmini`·`macstudio`·`other` | 감지값 | `--kind`, 첫 실행 질문 | 기기 종류예요. |
| `name` | 문자열 | 종류 이름(`other` 면 호스트 이름) | `--name`, 첫 실행 질문 | 사이트에 보일 이름이에요. 서버는 앞 60자만 써요. |
| `keepAwake` | 불리언 | 없음(꺼짐) | `--keep-awake`, `--allow-sleep`, 기기 화면 | **잠자기 막기**예요. 바로 적용돼요. |
| `keepLidAwake` | 불리언 | 없음(꺼짐) | 기기 화면 | 덮개를 닫아도 켜 두기예요. `awake setup` 으로 규칙을 깔아야 동작해요. |
| `lidApplied` | 불리언 | 없음 | 에이전트 | 에이전트가 `pmset -a disablesleep 1` 을 켜 둔 채인지 적어 둬요. 다음 시작 때 되돌릴지 판단해요. |
| `noAutoUpdate` | 불리언 | 없음(꺼짐) | `--no-auto-update`, `--auto-update` | 자동 업데이트를 받지 않아요. |
| `updateTried` | `{ build, at }` | 없음 | 에이전트 | 마지막 자동 업데이트 시도예요. 같은 빌드는 600,000 ms(10분) 안에 다시 시도하지 않아요. |
| `updateSeq` | 정수 | 없음 | 에이전트 | 마지막으로 적용한 서명된 업데이트의 순번이에요. 이보다 앞선 업데이트는 버려요. |
| `background` | 불리언 | 없음(꺼짐) | 기기 화면 | **헤드리스 연동 모드**를 원하는지예요. |
| `chrome` | 불리언 | `true` | `--chrome`, `--no-chrome` | 새 세션을 Claude in Chrome 과 함께 띄울지예요. |
| `mux` | `"tmux"` 또는 없음 | 없음 | `--mux` | `"tmux"` 면 새 세션을 tmux 에서 열어요. |
| `compactWindow` | 정수(토큰) | 없음 | 기기 화면 | Claude Code 가 대화를 스스로 압축하는 시점이에요. 100,000 ~ 1,000,000 토큰이에요. 없으면 Claude Code 기본값을 따라요. |
| `mainAccountName` | 문자열 | 없음("기본 계정") | 설정의 Claude 계정 | 기본 Claude 계정에 붙인 이름이에요. |
| `bgRelayRestart` | 문자열 | 없음 | 에이전트 | 헤드리스 브라우저를 키 바꾸기 때문에 다시 띄운 빌드를 적어 둬요. 내부용이에요. |

자동 업데이트, 키, 서명이 어떻게 맞물리는지는 [보안 모델](/guide/concepts/security)을 보세요.
