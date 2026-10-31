---
description: 에이전트가 맥·Linux 에서 돌리는 점검 항목 전체와 각 항목의 문제·해결 방법, 세션 시작을 막는지, 점검이 도는 때를 정리한 표예요.
---

# 점검 항목

이 페이지는 에이전트가 맥에서 돌리는 **점검**의 모든 항목과, 기기 화면의 진단 항목, 점검이 도는 때를 정리해요. 문제를 고치는 순서는 [문제 해결](/guide/operate/troubleshooting)을 보세요.

이 페이지는 [1.371 판](/changelog) 기준이에요.

점검 결과는 세 가지예요. **ok** 는 정상, **warn** 은 경고(세션은 시작돼요), **fail** 은 실패예요. "세션 시작"이 **막음**인 항목이 fail 이면 에이전트는 새 세션·다시 열기를 거절하고 해결 방법을 함께 알려요.

## 점검 항목

| id | 제목 | 문제일 때 | 결과 | 해결 | 세션 시작 |
|---|---|---|---|---|---|
| `zeropty` | zeropty | 아직 받지 못했거나 실행되지 않아요. 새 세션은 tmux 로 열어요. | warn | 에이전트가 다시 받아 봐요(손댈 것 없음). | 막지 않음 |
| `zeropty` | zeropty | 이 시스템(예: `linux-arm64`)용 zeropty 가 아직 없어요. 세션은 tmux 로 열어요. | warn | — | 막지 않음 |
| `zeropty` | zeropty | `--mux tmux` 로 고정했고 zeropty 세션이 남아 있지 않아 받지 않아요. 문구는 `이 기기는 tmux 로 고정: zeropty 를 받지 않습니다 (--mux auto 로 풀기)` 예요. | ok | — | — |
| `tmux` | tmux | 설치돼 있지 않고, zeropty 가 되는 기기예요. tmux 는 대비용이에요. | warn | macOS `brew install tmux`, Linux `sudo apt install tmux` | 막지 않음 |
| `tmux` | tmux | 설치돼 있지 않고, zeropty 가 없거나 `--mux tmux` 로 고정한 기기예요. | fail | 같음 | **막음** |
| `git` | git | 설치돼 있지 않거나 Xcode 명령줄 도구가 없어요. 브랜치·커밋 싱크와 자동 push 가 빠져요. | warn | macOS `xcode-select --install`, Linux `sudo apt install git` | 막지 않음 |
| `claude` | claude | `claude` 를 실행할 수 없어요. | fail | `curl -fsSL https://claude.ai/install.sh \| bash` | **막음** |
| `claude-version` | claude 버전 | 이 버전에 `--session-id` 또는 `--resume` 이 없어 세션을 시작하거나 옮길 수 없어요. | fail | `claude update` | **막음** |
| `claude-login` | claude 로그인 | 로그인돼 있지 않아요. 세션을 열면 로그인 화면에서 멈춰요. | fail | 이 기기의 터미널에서 `claude` 를 실행하고 `/login` | **막음** |
| `claude-login` | claude 로그인 | 로그인 상태를 확인하지 못했어요(`claude auth status` 가 없는 버전). | warn | 이 기기의 터미널에서 `claude` 를 한 번 실행해 로그인 확인 | 막지 않음 |
| `start-path` | `start` 의 PATH | `start` 로 띄운 에이전트가 `tmux`·`claude` 를 찾지 못했어요. | warn | 터미널에서 `node ~/.claude-bridge/agent.mjs` 를 한 번 실행해 PATH 를 저장한 뒤 다시 `start` | 막지 않음(없는 도구의 항목이 막아요) |
| `state-dir` | 에이전트 폴더 | `~/.claude-bridge` 에 쓸 수 없어요. | fail | `chmod u+rwx <폴더>` | **막음** |
| `claude-dir` | claude 기록 폴더 | Claude Code 의 `projects` 폴더에 쓸 수 없어요. | fail | `chmod u+rwx <폴더>` | **막음** |
| `disk` | 디스크 | 홈 디스크의 남은 공간이 1GB 보다 적어요. 대화 기록을 쓰지 못할 수 있어요. | fail | 디스크 공간을 1GB 이상 비우기 | 막지 않음 |
| `disk` | 디스크 | 남은 공간이 5GB 보다 적어요. | warn | 디스크 공간 비우기 | 막지 않음 |
| `sleep` | 잠자기 | 잠자기 막기를 켰는데 `caffeinate` 를 실행하지 못했어요. | warn | — | 막지 않음 |
| `sleep` | 잠자기 | 이 맥은 N분 동안 쓰지 않으면 잠들어요. 잠들면 연결이 끊기고 세션이 멈춰요. | warn | 기기 화면에서 "잠자기 막기" 켜기(맥북은 "덮개를 닫아도 켜 두기"도) | 막지 않음 |
| `browser` | 브라우저 | (macOS) Chrome 이 없어요. Safari 는 연동 페이지가 127.0.0.1 에 붙는 것을 막을 수 있어요. | warn | Chrome 을 깔고 연동 링크를 Chrome 에서 열기 | 막지 않음 |
| `browser` | 브라우저 | (Linux) Chrome·Chromium 이 없어요. 화면 없이 연동하려면 헤드리스 연동 모드에 필요해요. | warn | Google Chrome `.deb` 를 받아 `sudo apt install` | 막지 않음 |
| `service` | 실행 방식 | 터미널에서 실행 중이에요. 터미널을 닫으면 에이전트가 꺼져요. | warn | `node ~/.claude-bridge/agent.mjs service install` | 막지 않음 |
| `service` | 실행 방식 | (Linux) systemd 사용자 서비스인데 linger 가 꺼져 있어, 로그아웃하면 멈추고 재부팅 뒤에는 로그인해야 켜져요. | warn | `sudo loginctl enable-linger <사용자>` | 막지 않음 |
| `supervisor` | 서비스 | `agent.json` 의 `supervisor` 가 `none` 인데 백그라운드 서비스가 설치돼 있어요. | warn | `node ~/.claude-bridge/agent.mjs service uninstall` | 막지 않음 |
| `hooks` | 훅 | `agent.json` 의 `hooks` 에 잘못된 항목이 있거나 실행할 수 없는 명령이 있어요. 그 항목은 건너뛰어요. 자세한 내용은 [알림 웹훅과 훅](/guide/operate/hooks)을 보세요. | warn | `agent.json` 의 `hooks` 를 고치기 | 막지 않음 |

`sleep` 은 macOS 에서만, `browser`·`service` 는 macOS 와 Linux 에서 봐요. `start` 로 띄운 에이전트의 `service` 는 "`start` 로 실행 (터미널 없이)" 으로 ok 예요. `doctor` 로 돌리면 폴더가 아직 없을 때 "아직 없음, 처음 켤 때 만들어짐" 으로 ok 를 내고, `service` 는 서비스 설치 여부만 알려요.

## 점검이 도는 때

| 때 | 설명 |
|---|---|
| 에이전트가 켜질 때 | 듣기 시작한 직후 한 번 돌리고 결과를 터미널에 출력해요. |
| `doctor` | 점검만 하고 결과를 출력해요. fail 이 있으면 종료 코드 1 이에요. |
| `service install` | 서비스를 등록하기 전에 한 번 돌리고 출력해요. |
| 세션을 시작하기 직전 | 새 세션·다시 열기·되살리기 등 Claude Code 를 띄우기 전에 다시 돌려요. "막음" 항목이 fail 이면 거절해요. |
| 상태 보고 직전 | 에이전트는 15,000 ms 마다 서버에 상태를 보내요. 마지막 점검 뒤 하나라도 ok 가 아니면 60,000 ms(1분), 모두 ok 이면 600,000 ms(10분)가 지났을 때 다시 돌려요. |
| 기기 화면의 "다시 점검" | 사이트에서 점검을 요청하면 바로 돌려요. "지금 복구"의 점검 동작도 같아요. |
| zeropty 를 막 받았을 때 | 다음 상태 보고에서 다시 돌려요. |

점검 결과는 바뀔 때만 에이전트 로그에 남아요. ok 가 아니게 되면 fail 은 `error`, warn 은 `warn` 한 줄을, 다시 ok 가 되면 "해결됨 — 제목: 내용" 한 줄을 써요.

## 기기 화면의 진단 항목

기기 화면은 위 점검과 함께 에이전트의 각 부분을 보여 줘요. 상태는 ok·warn·fail·off(꺼짐) 가운데 하나예요. "지금 복구" 열은 사이트의 버튼이 에이전트에 시키는 동작이에요.

| id | 제목 | 보여 주는 것 | 지금 복구 | 문제일 때 해결 |
|---|---|---|---|---|
| `link` | 연동 | 브라우저 탭이나 헤드리스 브라우저가 연동 중인지 | — | 이 맥의 Chrome 에서 사이트를 열거나 헤드리스 연동 모드 켜기 |
| `background` | 헤드리스 연동 모드 | 꺼짐, Chrome 없음, 연동 중(다시 띄운 횟수), 연결 대기 | `background-restart` | Chrome 설치, 또는 기기 화면에서 껐다가 다시 켜기(다시 로그인) |
| `awake` | 잠자기 막기 (macOS) | 꺼짐, `caffeinate` 실행 중(pid), 떠 있지 않음 | `awake-apply` | — |
| `lid` | 덮개를 닫아도 켜 두기 | 맥북이거나 켜 둔 맥만. `pmset` 의 `SleepDisabled` 값과 덮개 상태 | `awake-apply` | `node ~/.claude-bridge/agent.mjs awake setup` |
| `chrome` | Claude in Chrome | 새 세션을 `--chrome` 으로 띄우는지 | — | 에이전트를 `--chrome` 으로 한 번 띄우기 |
| `sessions` | 세션 | 살아 있는 세션 수, 멈춘 세션 수, 훅이 오지 않는 세션 수 | — | 그 세션의 메뉴에서 새로고침 |
| `checks` | 도구·환경 점검 | 위 점검 결과를 한 줄로 | `check` | 첫 번째 문제 항목의 해결 방법 |
| `update` | 자동 업데이트 | 꺼짐, 새 버전을 받아 곧 바꿈, 지금 build | — | — |
| `key` | 에이전트 키 | 키를 바꾼 때와 `하루마다 스스로 바꿈`, 마지막 교체 뒤 연동 탭이 새 키를 받았는지. 1.140 전 키이거나 연동 탭이 새 키로 오지 않았으면 warn | `rekey` | 키 바꾸기를 다시 누르기 |
| `agent` | 에이전트 | 실행 방식(백그라운드 서비스, `start` 로 실행, 터미널에서 실행), 켜진 시간, 메모리 | `restart`(서비스와 `start` 로 띄운 에이전트만) | — |

"훅이 오지 않는 세션"은 살아 있고 시작 중이 아니며 훅을 한 번도 받지 않았고 띄운 지 120,000 ms(2분)가 넘은 세션이에요.

## 자동 복구

에이전트는 60,000 ms(1분)마다 스스로 살펴 고칠 수 있는 것을 고쳐요. `doctor`·`service`·`link`·`awake` 명령으로 실행할 때는 돌지 않아요.

| 대상 | 조건 | 하는 일 |
|---|---|---|
| 헤드리스 연동 모드 | `agent.mjs headless` 로 받은 로그인 주소가 있어요. | 헤드리스 연동 모드를 켜고 그 주소로 로그인해요. |
| 잠자기 막기 | 켜 뒀는데 `caffeinate` 가 떠 있지 않아요. | 다시 띄워요. |
| 덮개를 닫아도 켜 두기 | `pmset` 의 `SleepDisabled` 가 설정과 달라요. | 설정대로 다시 적용해요. |
| 헤드리스 브라우저 | 켜 뒀는데 떠 있지 않고 마지막으로 띄운 지 90,000 ms 가 넘었어요. | 바로 다시 띄워요. |
| 헤드리스 브라우저 | 떠 있는데 띄운 지 120,000 ms 가 넘도록 연동하지 않고, 이 고침을 한 지 600,000 ms 가 넘었어요. | 끝내고 2,000 ms 뒤 다시 띄워요. |

고친 기록은 새것부터 30개까지 남아 기기 화면에 보여요. 잠자기 막기와 덮개 항목은 macOS 에서만 고쳐요.

에이전트 키는 자동 복구와 따로 600,000 ms(10분)마다 나이를 봐요. 24시간이 지났고 연동 탭이 지금 키로 붙어 있으면 스스로 바꿔요.
