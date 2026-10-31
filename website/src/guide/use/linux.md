---
description: Ubuntu 같은 systemd Linux 서버에 에이전트를 설치하고, 화면 없이 헤드리스 브라우저로 서버에 연결하는 절차예요.
---

# Linux 서버 연결하기

이 가이드를 마치면 브라우저 화면이 없는 Linux 서버를 호스트로 붙여, 폰에서 그 서버의 세션을 띄울 수 있어요. 맥과 달리 Linux 서버에는 사이트 탭을 열어 둘 화면이 없어서, 이 절차가 꼭 필요해요.

아래에서 `SITE` 는 서버 주소예요(예: `https://bridge.example.com`).

## 시작하기 전에

- **systemd 가 있는 Linux.** Ubuntu 같은 배포판이에요. 에이전트는 `systemctl --user` 사용자 서비스로 돌아요.
- **Google Chrome 이나 Chromium.** 에이전트가 화면 없이 띄워 사이트에 연결해요(헤드리스 연동 모드). snap 의 Chromium 은 숨김 폴더에 쓰지 못할 수 있어 Google Chrome 을 권해요.
- **Claude Code**(`claude`)가 설치돼 있고 로그인돼 있어야 해요.
- **tmux.** x86_64 서버는 없어도 돼요(세션은 zeropty 에서 돌아요). 그 밖의 아키텍처는 꼭 있어야 해요(`sudo apt install tmux`).
- 사이트에 로그인할 수 있는 다른 기기(폰이나 노트북) 하나.

## 1. 에이전트 설치하기

그 서버의 터미널에서 실행하세요.

```sh [터미널]
curl -fsSL SITE/install.sh | bash
```

설치가 끝나면 `백그라운드 서비스(systemd --user)로 설치했습니다.` 가 찍혀요. 기기 종류는 **서버**로 잡혀요.

::: details Linux 에서 설치 스크립트가 다르게 하는 것
- `node` 가 없으면 nodejs.org 의 Node.js 22 를 `~/.claude-bridge/node` 에 받을지 물어요. 함께 올라온 SHA-256 목록으로 확인하고, 관리자 권한은 필요 없어요.
- Homebrew 대신 `sudo apt install tmux`, `sudo apt install git` 같은 직접 설치 방법을 알려 줘요.
- 서비스는 `~/.config/systemd/user/dev.claude-bridge.agent.service` 로 쓰고 `systemctl --user enable --now` 로 켜요.
- zeropty 는 Linux x86_64 용 0.1.6 을 받아요(glibc 2.29·커널 5.3 이상).
:::

## 2. 늘 켜 두기 (linger)

systemd 사용자 서비스는 그 사용자가 로그아웃하면 멈추고, 재부팅 뒤에는 로그인해야 켜져요. 늘 켜 두려면 관리자 권한으로 한 번 실행하세요. `USER` 는 그 서버의 사용자 이름이에요.

```sh [터미널]
sudo loginctl enable-linger USER
```

linger 가 꺼져 있으면 설치 끝과 `service status` 에서 이 명령을 알려 줘요.

## 3. 로그인 주소 만들기

1. 다른 기기에서 사이트에 로그인하고 **설정** → **더 보기** → **기기**로 가세요.
2. **화면 없는 기기 연결** → **로그인 주소 만들기**를 누르세요. 주소는 5분 동안 한 번만 쓸 수 있어요.

## 4. 서버에 로그인 주소 넘기기

화면에 보이는 명령을 복사해 그 서버의 터미널에서 실행하세요.

```sh [터미널]
node ~/.claude-bridge/agent.mjs headless 'LOGIN_URL'
```

`LOGIN_URL` 은 3단계에서 만든 로그인 주소예요. 에이전트가 1분 안에 헤드리스 연동 모드를 켜고, 그 주소로 헤드리스 브라우저를 로그인시켜요.

::: details 이 로그인 주소가 지키는 것
- 이 주소는 헤드리스 브라우저(User-Agent 에 `HeadlessChrome/` 이 있는 브라우저)에서만 로그인돼요. 다른 브라우저로 열면 "서버에 붙여 넣는 주소예요" 안내만 보여요.
- 서버 설정 `auth.headerOnly` 가 켜진 서버에서는 헤드리스 연동 모드와 이 로그인 주소를 쓸 수 없어요("헤더 로그인만 쓰는 서버에서는 백그라운드 연동을 쓸 수 없어요"). [서버 설정 파일 bridge.yaml](/guide/operate/config)을 보세요.
- Linux 에서는 잠자기·덮개 감시를 하지 않아요. 브라우저는 `/usr/bin/google-chrome`, `/usr/bin/chromium`, `/snap/bin/chromium` 같은 경로에서 찾아요.
- 헤드리스 브라우저와 연동 키가 어떻게 지켜지는지는 [맥을 늘 연결해 두기](/guide/use/always-on#3-헤드리스-연동-모드-켜기)를 보세요.
:::

## 확인하기

**기기** 목록에 그 서버가 **서버** 종류로, "연결됨" 으로 뜨면 성공이에요. 폰에서 그 서버로 새 세션을 띄워 첫 답이 오는지도 보세요.

## 문제가 생기면

| 증상 | 해결 |
|---|---|
| **Chrome·Chromium 이 없습니다** | Google Chrome 을 설치하세요. snap 의 Chromium 은 숨김 폴더에 쓰지 못할 수 있어요 |
| `… 의 로그인 주소가 아닙니다` | 주소가 이 사이트 것이 아니거나 잘렸어요. 기기 화면에서 새 주소를 만들어 작은따옴표로 감싸 넘기세요 |
| `systemctl --user 를 쓸 수 없습니다` | systemd 가 없는 시스템이에요. `curl -fsSL SITE/install.sh \| bash -s -- --foreground` 로 터미널에서 돌리세요 |
| 로그아웃하거나 재부팅하면 끊겨요 | 2단계의 linger 를 켜세요 |
| 세션이 시작되지 않아요 | `node ~/.claude-bridge/agent.mjs doctor` 로 없는 도구를 확인하세요. 점검 항목은 [점검 항목](/reference/checks)에 있어요 |

## 다음 단계

- [폰에서 세션 다루기](/guide/use/sessions): 붙인 서버에서 세션을 띄우고 다뤄요.
- [기기 상태와 디스크 관리](/guide/use/devices): 서버의 CPU·메모리·디스크를 보고 공간을 비워요.
- [설치 스크립트와 에이전트 명령](/reference/agent-cli#systemd-사용자-서비스-linux): systemd 서비스와 `headless` 명령의 자세한 값이에요.
