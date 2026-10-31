---
description: 호스트(맥·Linux), 브라우저, 서버에 필요한 운영체제·도구·버전을 표로 정리해요.
---

# 지원 환경

이 페이지는 Agent Bridge 를 쓰는 데 필요한 운영체제, 도구, 브라우저, 서버 버전을 정리해요. 설치 절차는 [시작하기](/guide/getting-started)를, 서버 준비는 [서버 올리기](/guide/operate/self-host)를 보세요.

표의 **선택**은 없어도 기본 기능이 도는 항목이에요.

## 호스트(맥·Linux)

| 항목 | 요구 | 비고 |
|---|---|---|
| 운영체제 | macOS, 또는 systemd 가 있는 Linux(예: Ubuntu) | Windows 호스트는 지원하지 않아요. 서비스는 macOS 에서 launchd, Linux 에서 `systemctl --user` 로 돌아요. Linux 절차는 [Linux 서버 연결하기](/guide/use/linux)를 보세요 |
| Node.js | 18 이상 | 설치 스크립트가 주 버전을 확인하고, 낮으면 멈춰요. Linux 에서 없으면 Node.js 22 를 `~/.claude-bridge/node` 에 받을지 물어요 |
| Claude Code (`claude`) | `claude --help` 에 `--session-id`, `--resume` 이 있는 버전, 로그인됨 | 점검은 실행되는지, 두 옵션이 있는지, `claude auth status` 의 로그인 여부를 봐요 |
| git | 설치됨(2.30 이상을 가정) | 없으면 세션은 열리지만 브랜치·커밋 싱크와 자동 push 가 빠져요. macOS 는 Xcode 명령줄 도구, Linux 는 `sudo apt install git` 으로 설치해요 |
| 세션 터미널: [zeropty](https://github.com/CreatiCoding/zeropty) | macOS 0.1.3, Linux x86_64 0.1.6 (고정) | 에이전트가 직접 받아 SHA-256 을 확인한 뒤 `~/.claude-bridge/zeropty/<버전>/` 에 둬요. 따로 설치하지 않아요. Linux 판은 glibc 2.29·커널 5.3 이상이 필요해요. 그 밖의 Linux 아키텍처용 판은 없어요 |
| 세션 터미널: [tmux](https://github.com/tmux/tmux) | 3.2 이상을 가정 · **선택** | zeropty 가 안 될 때의 대비예요. x86_64 가 아닌 Linux 에서는 꼭 있어야 해요. zeropty 도 tmux 도 없으면 세션을 시작할 수 없어요. `--mux tmux` 로 고정한 기기는 zeropty 를 받지 않아요 |
| GitHub CLI (`gh`) | **선택** | PR 링크와 상태를 보여 줄 때 써요 |
| Homebrew | **선택** · macOS | 설치 스크립트가 없는 도구를 설치할지 물을 때만 써요 |
| Google Chrome | 111 이상 | 연동 페이지와 [헤드리스 연동 모드](/guide/use/always-on)에 필요해요. 화면 없는 Linux 서버는 Chrome 이나 Chromium(apt·snap)을 헤드리스로 써요([Linux 서버 연결하기](/guide/use/linux)) |

에이전트가 하는 점검 항목 전체는 [점검 항목](/reference/checks)을 보세요.

## 브라우저

| 쓰임 | 브라우저 | 비고 |
|---|---|---|
| 연동 페이지(맥과 서버를 잇는 탭) | macOS 의 Chrome 111 이상 | Safari 는 이 페이지가 `127.0.0.1` 의 에이전트에 붙는 것을 막을 수 있어요. Chrome 이 "로컬 네트워크의 기기에 연결" 을 물으면 허용해야 해요 |
| 조작 페이지(폰·PC) | Chrome 111 이상(macOS·Windows·Android), Safari 16.4 이상(iOS·iPadOS·macOS) | 폰 폭(390 px)을 기준으로 만들었어요 |
| 웹 푸시 | 위 브라우저 | iPhone·iPad 는 "홈 화면에 추가" 한 경우에만 와요 |

## iOS 앱 <Badge type="info" text="선택" />

저장소의 `ios/` 에 조작 페이지를 띄우는 얇은 iOS 앱이 있어요. iOS 17 이상의 iPhone·iPad 에서 돌고, TestFlight 나 Xcode 로 설치해요. 앱이 여는 사이트 주소는 앱 소스에 고정돼 있어요. 직접 올린 서버를 앱으로 쓰려면 주소를 바꿔 Xcode 로 빌드해야 해요. 앱 없이 브라우저만으로도 모든 조작을 할 수 있어요.

앱 안에서 세션 줄을 길게 누르면 브라우저처럼 페이지 메뉴가 떠요. 링크 미리보기는 꺼 뒀어요.

::: details 카메라 번역 (시험 기능)
앱 아이콘을 길게 누르면 **카메라 번역 (시험)** 이 있어요. 누르면 뒤 카메라 화면이 페이지 위에 열리고, 비춘 일본어 줄을 한국어로 바꿔 줄 위와 아래 목록에 보여 줘요.

- iOS 18 이상에서만 돼요. 그보다 낮으면 "카메라 번역은 iOS 18 이상에서 돼요." 가 보여요.
- 글 읽기(Vision)와 번역(Translation)은 모두 기기 안에서 돌아요. 카메라 화면은 기기 밖으로 나가지 않아요.
- 처음 한 번 일본어→한국어 언어를 받아야 해요. 받는 동안 "언어 받는 중… 끝나면 바로 번역해요" 가 보이고, 받은 뒤에는 인터넷 없이 돼요.
- 1분이 지나도 받기가 끝나지 않으면 "언어 받기가 오래 걸려요" 와 함께 인터넷 확인, 설정 → 앱 → 번역 → 다운로드한 언어 안내, **다시 받기** 단추가 보여요.

시험 기능이라 언제든 바뀌거나 빠질 수 있어요.
:::

## 서버

| 항목 | 요구 | 비고 |
|---|---|---|
| 실행 방식 | Docker 이미지, 또는 소스에서 빌드한 바이너리 | 이미지는 저장소의 `Dockerfile` 로 만들어요 |
| 실행 이미지 | `alpine:3.22` 에 Go 정적 바이너리 하나 | 런타임이 따로 들지 않아요 |
| 빌드 | `golang:1.27.3-alpine`(서버), `node:22.23.4-alpine`(조작 페이지) | 소스에서 빌드하면 Go 1.27(`server/go.mod`)이 필요해요. 세 베이스 이미지는 빌드 인자 `NODE_IMAGE`·`GO_IMAGE`·`RUN_IMAGE` 로 바꿀 수 있어요 |
| 포트 | `PORT`, 기본 4300 | 서버는 평문 HTTP 로 들어요 |
| HTTPS | 앞단 리버스 프록시 | 서버 프로세스에는 TLS 가 없어요. 운영할 때는 `https://` 주소가 필요해요 |
| 로그인 | GitHub OAuth App, 또는 앞단 프록시의 헤더 로그인 | GitHub 은 클라이언트 id 와 비밀값을 환경 변수로 넣어요. 헤더 로그인은 `bridge.yaml` 의 `auth.providers` 로 켜요([bridge.yaml 키](/reference/config)) |
| 데이터 | 볼륨 하나(`BRIDGE_DATA`, 이미지 기본 `/data`) | 데이터베이스는 쓰지 않아요. 서버 설정 파일 `bridge.yaml` 도 기본으로 여기에 둬요([서버 설정 파일 bridge.yaml](/guide/operate/config)) |

환경 변수 전체는 [환경 변수](/reference/env)를 보세요.
