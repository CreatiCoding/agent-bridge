---
description: Docker 로 Agent Bridge 서버를 올리고, GitHub 로그인과 HTTPS 리버스 프록시를 붙여 첫 맥을 연결하기까지의 절차예요.
---

# 서버 올리기

이 가이드를 마치면 내 도메인에서 Agent Bridge 서버가 HTTPS 로 돌고, GitHub 로 로그인해 첫 맥을 연결할 수 있어요. 서버가 무엇을 믿고 무엇을 지키는지는 [보안 모델](/guide/concepts/security)을, 환경 변수 전체 목록은 [환경 변수](/reference/env)를 보세요.

## 시작하기 전에

다음이 필요해요.

- **도메인과 HTTPS 리버스 프록시**: 서버는 HTTP 만 말해요. TLS 는 앞단의 프록시(Caddy, nginx, Traefik 등)가 끝내야 해요.
- **Docker**: 이미지를 빌드하고 컨테이너를 돌릴 곳이에요. 컨테이너 하나에 vCPU 1개, 메모리 512 MiB, `/data` 볼륨 10 GiB 정도를 잡아 두세요.
- **GitHub 계정**: 로그인용 OAuth App 을 만들 계정이에요.
- **저장소 소스**: [agent-bridge](https://github.com/CreatiCoding/agent-bridge) 를 받아 둔 폴더예요. 포크라면 포크한 저장소예요.

이 문서에서 쓰는 자리표시는 이래요.

| 자리표시 | 뜻 |
|---|---|
| `SITE` | 서버의 공개 주소예요(예: `https://bridge.example.com`). 끝에 `/` 를 붙이지 않아요 |
| `CLIENT_ID`, `CLIENT_SECRET` | 1단계에서 만드는 GitHub OAuth App 의 값이에요 |
| `YOUR_LOGIN` | 운영자가 될 내 GitHub 계정 이름이에요 |

::: danger 서버를 운영하는 사람을 믿을 수 있어야 해요
서버는 대화를 디스크에 저장하지 않아요. 대화 원본은 그 세션의 맥이 가지고, 서버는 중계만 해요. 하지만 대화는 서버를 거쳐 지나가고, 서버는 세션마다 최근 이벤트를 메모리에 둬요. 또 서버는 연결된 맥에 세션을 열고 메시지를 보내는 곳이에요. 서버를 가진 사람은 그 사용자의 맥에서 Claude 를 움직일 수 있어요. 믿을 수 있는 사람만 서버를 운영하세요. 자세한 내용은 [보안 모델](/guide/concepts/security)을 보세요.
:::

## 1. GitHub OAuth App 만들기

1. GitHub 에서 **Settings → Developer settings → OAuth Apps → New OAuth App** 을 여세요.
2. **Homepage URL** 에 `SITE` 를 넣으세요.
3. **Authorization callback URL** 에 `SITE/api/auth/github/callback` 을 넣으세요.
4. 앱을 만든 뒤 **Client ID** 를 적어 두고, **Generate a new client secret** 으로 비밀값을 만들어 적어 두세요.

콜백 주소가 한 글자라도 다르면 GitHub 가 로그인을 돌려보내지 않아요. `SITE` 와 3단계에서 정할 `BRIDGE_ORIGIN` 이 같은 값인지 확인하세요.

## 2. 이미지 빌드하기

저장소 폴더에서 이미지를 빌드하세요.

```sh [터미널]
docker build -t claude-bridge .
```

서버는 Go 바이너리 하나로 `alpine:3.22` 이미지에 담겨요. `go test` 등이 실패하면 이미지가 만들어지지 않아요. `agent/*.mjs` 는 맥에 내려보낼 파일로만 들어 있어요.

## 3. 컨테이너 실행하기

`docker run` 으로 바로 띄우려면 다음을 실행하세요.

```sh [터미널]
docker run -d --name bridge \
  -p 127.0.0.1:4300:4300 \
  -v bridge-data:/data \
  -e BRIDGE_ORIGIN=SITE \
  -e GITHUB_CLIENT_ID=CLIENT_ID \
  -e GITHUB_CLIENT_SECRET=CLIENT_SECRET \
  -e GITHUB_ALLOWED_LOGINS= \
  -e BRIDGE_ADMIN_LOGINS=YOUR_LOGIN \
  claude-bridge
```

같은 설정을 Docker Compose 로 두려면 이 파일을 저장소 폴더에 만드세요.

```yaml [docker-compose.yml]
services:
  bridge:
    build: .
    image: claude-bridge
    restart: unless-stopped
    ports:
      - "127.0.0.1:4300:4300"   # 같은 기계의 프록시만 닿게
    volumes:
      - bridge-data:/data
    environment:
      BRIDGE_ORIGIN: https://bridge.example.com
      GITHUB_CLIENT_ID: ${GITHUB_CLIENT_ID}
      GITHUB_CLIENT_SECRET: ${GITHUB_CLIENT_SECRET}
      GITHUB_ALLOWED_LOGINS: ""          # 비우면 접근 관리 화면에서만 허용
      BRIDGE_ADMIN_LOGINS: YOUR_LOGIN    # 쉼표로 여러 명
volumes:
  bridge-data:
```

비밀값은 같은 폴더의 `.env` 에 `GITHUB_CLIENT_ID=…`, `GITHUB_CLIENT_SECRET=…` 로 두고 `docker compose up -d --build` 로 띄우세요.

각 값의 뜻은 이래요.

| 변수 | 뜻 |
|---|---|
| `BRIDGE_ORIGIN` | 사이트의 공개 주소(`SITE`). `https://` 로 시작해야 해요 |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | 1단계의 OAuth App 값 |
| `GITHUB_ALLOWED_LOGINS` | 처음부터 허용할 GitHub 계정(쉼표 구분). `*` 는 누구나예요 |
| `BRIDGE_ADMIN_LOGINS` | **운영자** 계정(쉼표 구분). 허용 목록에 없어도 로그인되고, 운영 탭을 봐요 |

이미지에는 `PORT=4300`, `BRIDGE_DATA=/data` 가 들어 있어요. 바꿀 일이 없으면 그대로 두세요. 나머지 변수는 [환경 변수](/reference/env)를 보세요.

::: warning 주의
`GITHUB_CLIENT_ID` 를 넣고 `BRIDGE_ORIGIN` 을 비우면 서버가 시작하지 않아요. 로그에 `BRIDGE_ORIGIN 이 없습니다. GitHub 로그인을 쓰는 서버는 사이트 주소(예: https://bridge.example.com)를 BRIDGE_ORIGIN 으로 정해야 합니다.` 가 찍히고 종료 코드 1 로 끝나요.
:::

## 4. HTTPS 리버스 프록시 뒤에 두기

프록시가 `SITE` 의 요청을 컨테이너의 `4300` 포트로 넘기게 설정하세요. 프록시는 다음을 지켜야 해요.

- TLS 1.2 이상으로 HTTPS 를 끝내요.
- `X-Forwarded-Proto` 를 넘기고, `X-Forwarded-For` 는 자기가 본 클라이언트 주소로 덮어써서 넘겨요. 서버는 이 머리글의 마지막 항목으로 속도 제한을 걸어요.
- `text/event-stream` 응답을 버퍼링하거나 압축하지 않아요. 연동 페이지와 조작 페이지는 이 스트림(SSE, Server-Sent Events)으로 실시간 상태를 받아요.
- 업스트림 읽기 유휴 한도를 60초 이상으로 둬요.
- 요청 본문 한도를 32 MiB(33,554,432 byte) 이상으로 둬요.

::: danger 서버 포트를 인터넷에 바로 열지 마세요
`BRIDGE_ORIGIN` 이 없으면 서버는 요청의 `Host` 와 `X-Forwarded-Proto` 를 믿고 자기 주소를 만들어요. 설치 명령, 로그인 콜백, 다른 출처 검사가 모두 이 주소를 써요. 그래서 반드시 `BRIDGE_ORIGIN` 을 정하고, 포트는 프록시만 닿게 두세요. 위 예시가 `127.0.0.1:4300` 에만 묶는 이유예요. 로그인 쿠키의 `Secure` 속성도 `BRIDGE_ORIGIN` 이 `https:` 일 때만 붙어요.
:::

## 5. 데이터 볼륨 지키기

서버의 모든 상태는 `/data` 볼륨에 있어요. 대화 원본 줄, 화면 이벤트, 대화의 그림은 서버가 디스크에 쓰지 않아요. 그것은 각 맥의 `~/.claude-bridge/` 에 있어요. 서버에 남는 주요 내용은 이래요.

| 경로 | 내용 |
|---|---|
| `users.json`, `logins.json`, `access.json` | 사용자, 로그인, 접근 요청 기록 |
| `hosts.json` | 연결된 맥(**호스트**) 목록 |
| `u/<uid>/s/<sid>/meta.json` | 세션 정보: 제목, 미리보기(80자), 상태, 맥, 작업 폴더, PR 링크, 통계 숫자, 실행 설정 |
| `u/<uid>/prefs.json`, `notices.json`, `push.json`, `plugins.json` | 사용자 설정, 알림, 웹 푸시 구독, 플러그인 설정 |
| `u/<uid>/hosts/<hostId>.log` | 호스트 로그 |
| `vapid.json` | 웹 푸시 키 |
| `models.json` | 새 세션 화면의 모델 목록 |
| `agent-seq.json` | 맥에 내보낸 에이전트 서명 순번 |
| `instance.json`, `handover.json`, `handover.secret` | 끊기지 않는 배포에 쓰는 파일 |

비밀번호로 잠근 세션은 미리보기와, 손으로 붙이지 않은 제목도 디스크에 쓰지 않아요.

::: details 예전 판에서 올린 서버라면
예전 판의 서버는 대화 사본(`transcript*.jsonl`), 화면 이벤트(`events.jsonl`), 그림(`u/<uid>/img/`)을 데이터 폴더에 썼어요. 이 파일은 저절로 지워지지 않아요. 운영자는 `GET /api/admin/purge` 로 남은 양을 보고, 서버를 `BRIDGE_PURGE=1` 로 다시 띄운 뒤 `POST /api/admin/purge` 로 지울 수 있어요. 자세한 내용은 [주소와 HTTP API](/reference/routes)를 보세요.
:::

컨테이너는 root 로 시작해요(이미지에 `USER` 지시가 없어요). 서버는 켜질 때 `/data` 의 소유자를 uid 1000 으로 바꾸고 그 사용자로 내려가요. 파일 권한도 0600, 폴더는 0700 으로 맞춰요. 내려가지 못하면 운영 탭의 서버 타일에 `root 로 실행 중` 이 보여요.

볼륨을 백업할 때는 이 폴더 전체를 같이 보관하세요. 로그인 정보와 세션 제목, 작업 폴더 경로가 들어 있으니 백업도 같은 수준으로 지켜야 해요.

## 6. 선택 기능 켜기

필요한 것만 켜세요.

- **웹 푸시**: 설정할 것이 없어요. 서버가 처음 켜질 때 VAPID(Voluntary Application Server Identification) 키 쌍을 만들어 `/data/vapid.json` 에 두고, 그 뒤로는 바꾸지 않아요. 사용자는 설정 → 이 기기에서 알림을 켜요. 자세한 내용은 [알림과 웹 푸시](/guide/use/notifications)를 보세요.
- **`/skills`**: 사용자가 자기 GitHub 저장소의 스킬을 둘러보는 페이지예요. GitHub App 을 권해요(`SKILLS_GITHUB_APP_ID`, `SKILLS_GITHUB_APP_KEY`). 토큰을 쓰려면 그 저장소에만 Contents: Read 를 준 fine-grained 토큰을 `SKILLS_GITHUB_TOKEN` 에 넣으세요. 저장소는 사용자마다 설정 → 더 보기 → 스킬 저장소에서 정하고, `SKILLS_REPO` 는 정하지 않은 사람의 기본값이에요.
- **공개 데모**: `BRIDGE_DEMO=1` 이면 로그인 화면에 "데모로 둘러보기" 가 보여요. 맥 없이 정해진 데모 화면을 둘러보게 해요. 기본은 꺼져 있어요.
- **포크의 소스 링크**: 포크라면 `BRIDGE_SOURCE_URL` 에 내 저장소 주소를 넣으세요. 화면의 "소스 코드" 링크가 이 주소를 가리켜요.

포크라면 에이전트 서명 키도 만들어야 맥이 자동 업데이트를 받아요. 절차는 [에이전트 서명 키](/guide/operate/signing)를 보세요.

## 확인하기

1. 서버가 답하는지 보세요.

   ```sh [터미널]
   curl SITE/api/health
   ```

   `{"ok":true,"version":"0.2.0","instance":"…"}` 가 보이면 성공이에요. `instance` 는 지금 도는 서버 프로세스의 id 예요.

2. 컨테이너 로그에서 사용자 전환을 확인하세요. `docker logs bridge` 에 `user: node(1000) 사용자로 바꿈` 이 있으면 돼요.
3. 브라우저로 `SITE` 를 열고 GitHub 로 로그인하세요. `YOUR_LOGIN` 이면 바로 들어가지고, 설정에 **운영** 탭이 보여요.
4. 맥의 터미널에서 설치 스크립트를 실행하세요.

   ```sh [터미널]
   curl -fsSL SITE/install.sh | bash
   ```

   연동 페이지가 열리고, 조작 페이지의 기기 화면에 그 맥이 "연결됨" 으로 보이면 성공이에요. 맥 쪽 절차는 [시작하기](/guide/getting-started)를 보세요.

## 문제가 생기면

- **컨테이너가 바로 꺼져요**: `docker logs bridge` 를 보세요. `BRIDGE_ORIGIN 이 없습니다` 면 3단계의 `BRIDGE_ORIGIN` 을 넣으세요.
- **로그인하면 "GitHub 로그인이 설정되지 않았습니다" 가 떠요**: `GITHUB_CLIENT_ID` 가 비어 있어요. 넣고 컨테이너를 다시 띄우세요. 환경 변수는 시작할 때 한 번만 읽어요.
- **로그인하면 "승인을 기다리는 중이에요" 가 떠요**: 허용되지 않은 계정이에요. 운영자가 접근 관리에서 허용하면 돼요. [접근 관리와 운영 화면](/guide/operate/admin)을 보세요.
- **연동 페이지가 자꾸 끊겨요**: 프록시가 SSE 를 버퍼링하거나 유휴 연결을 일찍 끊는지 4단계를 다시 보세요.

## 다음 단계

- [접근 관리와 운영 화면](/guide/operate/admin): 사람을 허용하고 모든 맥의 상태를 봐요.
- [끊기지 않는 배포](/guide/operate/deploy): 새 버전을 요청 실패 없이 올려요.
- [에이전트 서명 키](/guide/operate/signing): 포크의 맥들이 자동 업데이트를 받게 해요.
- [환경 변수](/reference/env), [주소와 HTTP API](/reference/routes): 전체 목록이에요.
