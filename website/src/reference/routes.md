---
description: Agent Bridge 서버의 사용자 페이지 주소, 로그인 없이 열리는 경로, 로그인한 사용자의 HTTP API 묶음, 서비스 API, 요청 규칙·응답 머리글·속도와 스트림 한도, 에이전트의 로컬 경로를 정리한 표예요.
---

# 주소와 HTTP API

이 페이지는 서버가 내주는 모든 페이지 주소와 HTTP API 경로 묶음, 요청 규칙을 정리해요. 서버를 올리고 프록시를 붙이는 방법은 [서버 올리기](/guide/operate/self-host)를 보세요.

이 페이지는 [1.371 판](/changelog) 기준이에요.

아래에서 `SITE` 는 서버 주소예요(예: `https://bridge.example.com`). `<sid>` 는 **세션** id, `<id>` 는 호스트 id 예요.

## 페이지

### 로그인 없이 열리는 페이지

| 주소 | 설명 |
|---|---|
| `/` | 로그인하지 않았으면 로그인 화면(GitHub 로 로그인, 켜져 있으면 "데모로 둘러보기")이에요. 로그인했으면 **조작 페이지**예요. |
| `/guide`, `/guide/move`, `/guide/accounts` | 로그인 전에는 시작 안내 페이지, 로그인 뒤에는 조작 페이지 안의 시작 가이드(처음 시작·옮기기·멀티 계정)예요. |
| `/bridge` | **연동 페이지**예요. 맥의 브라우저에 열어 두면 에이전트와 서버를 이어요. |
| `/install.sh` | 에이전트 설치 스크립트예요. 사이트 주소와 에이전트 파일 목록이 채워져 나가요. |
| `/agent.mjs`, `/agent/<파일>.mjs` | 에이전트 파일 17개예요. 설치 스크립트와 자동 업데이트가 받아요. |
| `/privacy` | 개인정보 처리방침이에요. |
| `/support` | 지원 페이지(시작 방법, 자주 묻는 것, 문의)예요. |
| `/recovery` | 문제가 생겼을 때 보는 복구 안내예요. 기기 화면의 "문제가 생겼을 때" 링크가 여기로 와요. |
| `/skills/install.sh?repo=…&t=…` | 스킬 설치 스크립트예요. 서버가 준 서명(`t`)이 맞을 때만 내주고, 아니면 404 예요. |
| `/skills/version` | 스킬 기능의 코드 지문이에요. 로그인했으면 저장소 정보도 함께 줘요. |
| `/manifest.webmanifest`, `/favicon.ico`, `/assets/…`, `/<이름>.js·.css·.svg` | 앱 설치 정보와 정적 파일이에요. |
| `/cs`, `/classic` | 예전 조작 페이지 주소예요. `/` 로 보내요(302). |
| `/ext/<id>/<hash>/<파일>` | 익스텐션의 화면 파일이에요. 자세한 내용은 [익스텐션 API (화면, JS)](/reference/extension-api)를 보세요. |

### 로그인이 필요한 페이지

로그인하지 않고 열면 GitHub 로그인(`/api/auth/github?next=…`)으로 보내고, 로그인 뒤 그 주소로 돌아와요. GitHub 로그인이 꺼진 서버는 `/` 로 보내요.

| 주소 | 화면 |
|---|---|
| `/s/<sid>` | 세션 화면(대화, 카드, 입력창)이에요. |
| `/new` | 새 세션 화면이에요. |
| `/hosts`, `/hosts/<id>` | 기기 화면(연결 상태, 사용률·배터리, 점검, 잠자기, 헤드리스 연동 모드, 화면 없는 기기 연결, 로그)이에요. |
| `/disk` | 디스크 관리예요. 내 기기를 디스크가 많이 찬 순서로 보여요. [기기 상태와 디스크 관리](/guide/use/devices)를 보세요. |
| `/stats` | 통계예요. |
| `/quality` | 품질 화면이에요. |
| `/split` | 여러 세션을 나란히 보는 화면이에요. |
| `/settings`, `/settings/<탭>` | 설정이에요. |
| `/admin`, `/admin/reports/<id>` | 운영 화면과 문제 제보예요. 운영자만 써요. |
| `/skills`, `/skills/<이름>` | 스킬 마켓플레이스예요. |
| `/guide/mcp` | MCP 안내 페이지예요. |

## 공개 API

### `GET /api/health`

로그인 없이 모든 메서드에 같은 답을 줘요. 속도 제한이 없고, 컨테이너 HEALTHCHECK 가 이 경로를 써요.

| 필드 | 자료형 | 설명 |
|---|---|---|
| `ok` | 불리언 | 늘 `true` 예요. |
| `version` | 문자열 | 서버 버전이에요(지금 `0.2.0`). |
| `instance` | 문자열 | 이 서버 프로세스의 넘겨주기 id 예요. 끊기지 않는 배포에서 새 서버와 옛 서버를 구분해요. |

서버 설정 상태(GitHub 로그인 여부, `BRIDGE_ORIGIN` 설정 여부, root 실행 여부, 에이전트 서명 상태)는 운영자만 보는 `GET /api/admin/overview` 의 `server` 에 있어요.

### 인증 경로 `/api/auth/*`

| 메서드 | 경로 | 설명 |
|---|---|---|
| 모든 메서드 | `/api/auth/github` | GitHub 로그인을 시작해요. |
| 모든 메서드 | `/api/auth/github/callback` | GitHub 가 돌려보내는 곳이에요. |
| POST | `/api/auth/logout` | 로그아웃해요. Origin 을 따로 검사해요. |
| 모든 메서드 | `/api/auth/qr/<code>` | 다른 기기에서 QR 로 로그인해요. 코드는 5분 동안 한 번만 통해요. |
| POST | `/api/auth/demo` | 공개 데모로 들어가요(`BRIDGE_DEMO=1` 일 때). |
| POST | `/api/auth/apple/nonce`, `/api/auth/apple` | iOS 앱의 Apple 로그인이에요. |
| 모든 메서드 | `/api/auth/dev?login=이름` | 개발용 로그인이에요(`BRIDGE_DEV_LOGIN=1` 일 때만). |

## 로그인한 사용자의 API

조작 페이지가 쓰는 경로예요. 모든 경로가 로그인 쿠키를 요구하고, 아니면 401 이에요. 경로는 많지만 묶음으로 보면 아래와 같아요.

### 나와 설정

| 메서드 | 경로 | 하는 일 |
|---|---|---|
| GET | `/api/me` | 로그인한 사용자 정보예요(`uid` 포함). |
| POST | `/api/qr` | 다른 기기 로그인용 QR 코드를 만들어요. `{"headless":true}` 면 화면 없는 기기의 헤드리스 브라우저만 쓰는 로그인 주소(5분, 한 번)를 만들어요. |
| GET·POST | `/api/prefs/prompt` | 기본 프롬프트를 읽고 바꿔요. |
| GET·POST | `/api/prefs/launch` | 새 세션의 처음 모델·effort·권한 모드를 읽고 바꿔요. |
| GET·POST | `/api/prefs/icons` | 아이콘 설정이에요. |
| GET·POST | `/api/prefs/splits` | 나란히 보기 설정이에요. |
| GET·POST | `/api/prefs/voice`, `/api/prefs/voice/hosts` | 음성 입력 설정과 맥별 음성 설정이에요. |
| GET·POST | `/api/prefs/skills` | 내 스킬 저장소예요. |
| POST | `/api/groups` | 그룹을 만들고, 옮기고, 지워요. |
| GET | `/api/options` | 새 세션 화면의 선택지(모델 등)예요. |
| GET | `/api/stats` | 통계예요. |
| POST | `/api/account/delete` | 계정을 지워요. |

### 실시간 스트림

| 메서드 | 경로 | 하는 일 |
|---|---|---|
| GET | `/api/classic/stream` | 조작 페이지의 SSE(Server-Sent Events) 스트림이에요. 상태, 이벤트, 쓰는 중인 글, 화면, 알림이 와요. |
| POST | `/api/focus` | 지금 보고 있는 세션을 알려요(30초마다). 보고 있으면 웹 푸시를 보내지 않아요. |

### 세션 `/api/sessions`

| 메서드 | 경로 | 하는 일 |
|---|---|---|
| POST | `/api/sessions` | 새 세션을 만들어요. |
| DELETE | `/api/sessions/<sid>` | 세션을 목록에서 지워요. |
| GET | `/api/sessions/<sid>/events` | 세션 기록을 쪽 단위(최대 500개)로 읽어요. 맥이 끊겨 있으면 409 예요. |
| GET | `/api/sessions/<sid>/screen`, `/agentsmd`, `/skills`, `/links`, `/trash` | 터미널 화면, `AGENTS.md`, 스킬 메뉴, 언급된 PR, 버리기 정보를 읽어요. |
| POST | `/api/sessions/<sid>/send`, `/say` | 글과 그림을 보내요. |
| POST | `/api/sessions/<sid>/sendnow`, `/retract`, `/dropheld` | **붙잡은 글**을 바로 보내거나, 거두거나, 버려요. |
| POST | `/api/sessions/<sid>/answer`, `/key`, `/esc` | **카드**에 답하거나, 키를 보내거나, 중단해요. |
| POST | `/api/sessions/<sid>/do`, `/setting`, `/settings` | 슬래시 명령과 모델·effort·권한 모드 같은 설정을 바꿔요. |
| POST | `/api/sessions/<sid>/refresh`, `/resume`, `/close` | **다시 열기**, 끝난 세션 이어 열기, 끝내기예요. |
| POST | `/api/sessions/<sid>/move`, `/seat` | 다른 맥으로 **옮기기**, Slack 과 웹 사이에서 작업하는 곳 옮기기예요. |
| POST | `/api/sessions/<sid>/fork`, `/lightfork`, `/trimlog` | 복제, 가벼운 복제, 대화 기록 정리예요. |
| POST | `/api/sessions/<sid>/btw`, `/report`, `/cwd`, `/trash`, `/screen` | 옆길 질문, 보고, 작업 폴더 바꾸기, 버리기, 화면 다시 읽기예요. |
| POST | `/api/sessions/<sid>/voice`, `/upload` | 음성 받아쓰기, 영상·파일 올리기예요. 영상은 그 형식(`video/mp4` 등), 그 밖의 파일은 `application/octet-stream` 으로 올려요. 한 개 512 MiB, 한 사람 2 GiB 까지예요. |
| POST | `/api/sessions/<sid>/preview` | 이 세션이 띄운 로컬 서버(`{port}`)의 미리보기 주소를 받아요. 서버 설정 `features.preview` 를 끄면 403 이에요. 그 포트 서버가 없으면 404 예요. |
| POST | `/api/sessions/<sid>/killserver` | 이 세션이 띄운 로컬 서버(`{port}`)를 맥에서 꺼요. 못 끄면 409 예요. |
| GET | `/api/sessions/<sid>/localimg?path=…` | 대화에 나온 맥의 그림 파일(`~` 나 `/` 로 시작하는 `.png`·`.jpg`·`.gif`·`.webp`)을 맥에서 받아 보여 줘요. 맥이 끊겨 있으면 409 예요. |
| POST | `/api/sessions/<sid>/lock`, `/unlock`, `/lockclear` | **잠금**을 걸고, 풀고, 없애요. |

잠긴 세션의 경로는 `X-Lock` 머리글에 **열쇠**가 있어야 해요. 없으면 423 이에요.

### 호스트 `/api/hosts`

| 메서드 | 경로 | 하는 일 |
|---|---|---|
| GET | `/api/hosts/<id>/status` | 연결, 에이전트 상태, 연동 페이지 진단이에요. |
| GET | `/api/hosts/<id>/logs` | 호스트 로그를 최대 400개 읽어요(`sid`, `level` 로 거르기). |
| GET | `/api/hosts/<id>/dirs`, `/recent` | 폴더 목록, 맥의 대화 목록이에요. |
| POST | `/api/hosts/<id>/adopt` | 맥의 대화를 **가져오기**예요. |
| POST | `/api/hosts/<id>/check` | 점검을 다시 돌려요. |
| POST | `/api/hosts/<id>/heal` | "지금 복구" 동작을 시켜요. |
| POST | `/api/hosts/<id>/awake`, `/background` | 잠자기 막기, 헤드리스 연동 모드를 켜고 꺼요. |
| POST | `/api/hosts/<id>/compact` | 대화 압축 시점을 정해요. |
| POST | `/api/hosts/<id>/accounts` | 그 맥의 Claude 계정을 다뤄요. |
| POST | `/api/hosts/<id>/delegate`, `/sudo` | 맡기기, 관리자 비밀번호 전달이에요. 자기 맥만 돼요. |
| POST | `/api/hosts/<id>/disk` | 디스크 관리예요. 본문 `{op, id?, path?, paths?}`, `op` 는 `info`·`scan`·`clean`·`trash`·`worktrees`·`prune` 이에요. 기기 주인과, 주인이 허락한 운영자만 돼요(아니면 404). |
| POST | `/api/hosts/<id>/disk-help` | 디스크 정리 도움이에요. `{op:"ask"}` 는 운영자가 요청, `{op:"grant", login}` 은 주인이 24시간 허용, `{op:"end"}` 는 주인이나 요청한 운영자가 끝내요. |

### 알림과 웹 푸시

| 메서드 | 경로 | 하는 일 |
|---|---|---|
| GET | `/api/notices` | 알림 목록이에요. |
| POST | `/api/notices/dismiss` | 알림을 지워요. |
| GET | `/api/push/key` | 웹 푸시 공개 키예요. |
| POST | `/api/push/subscribe` | 웹 푸시를 구독해요. |
| GET·POST | `/api/push/apns` | iOS 앱 알림 기기를 확인하고 등록해요. |

### 그림, 플러그인, 스킬, 제보

| 메서드 | 경로 | 하는 일 |
|---|---|---|
| GET | `/api/img/<40 hex>.<png·jpg·gif·webp>` | 그림이에요. 맥에서 받아 넘겨요. |
| GET | `/api/plugins` | 플러그인 목록과 상태예요. |
| POST | `/api/plugins/<id>`, `/api/plugins/<id>/choices` | 플러그인을 켜고 설정하거나, 고를 수 있는 값을 받아요. 자세한 내용은 [플러그인 API (서버 안, Slack)](/reference/plugin-api)를 보세요. |
| GET·POST | `/api/plugins/slack/link` | Slack 이 보낸 10분짜리 연결 링크가 여는 화면이에요. 열기만 해서는 연결되지 않고, 그 화면의 단추(POST)를 눌러야 Slack 계정이 이어져요. |
| GET | `/api/skills`, `/api/skills/<이름>` | 스킬 목록과 내용이에요. |
| GET | `/api/quality` | 설정 → 더 보기 → 성능 리포트가 보여 주는 품질 리포트예요(저장소의 `server/quality.json`). |
| POST | `/api/reports`, `/api/reports/upload` | 문제를 제보하고 영상을 올려요. |
| GET·DELETE | `/api/reports`, `/api/reports/<id>`, `…/img/<id>`, `…/video/<id>` | 내 제보를 보고 지워요. |

### 운영자 `/api/admin`

| 메서드 | 경로 | 하는 일 |
|---|---|---|
| GET | `/api/admin/overview` | 서버 상태와 사용자별 호스트 요약이에요. |
| GET·POST | `/api/admin/access` | 접근 요청을 보고 허용·거절해요. |
| GET·POST | `/api/admin/models` | 모델 목록과 자동 갱신이에요. |
| GET·POST | `/api/admin/purge` | 기존 데이터 정리예요. POST 는 `BRIDGE_PURGE=1` 일 때만 돼요. |
| GET·POST | `/api/admin/reports`, `/api/admin/reports/<id>`, `…/img/<id>`, `…/video/<id>`, `…/fix`, `/api/admin/reports/auto` | 모든 제보, 고치기 세션 띄우기, 자동 대응 설정이에요. |
| GET·POST | `/api/admin/config`, `/api/admin/config/export`, `/api/admin/config/save`, `/api/admin/config/check` | 서버 설정 파일 `bridge.yaml` 의 상태, 내보내기, 저장, 검사예요. [bridge.yaml 키](/reference/config)를 보세요. |
| GET·POST | `/api/admin/ext-leftovers` | 지운 익스텐션이 남긴 데이터를 보고 지워요. [익스텐션 API (화면, JS)](/reference/extension-api)를 보세요. |

### 연동 페이지 `/api/bridge`

| 메서드 | 경로 | 하는 일 |
|---|---|---|
| POST | `/api/bridge/hello` | 연동 페이지가 붙으며 맥과 세션 목록을 알려요. |
| GET | `/api/bridge/stream` | 서버 → 연동 페이지 SSE 스트림이에요. |
| POST | `/api/bridge/up` | 에이전트가 보낸 메시지를 묶어서 올려요. 서버는 받은 글에서 `#…&key=…`·`x-bridge-key: …` 꼴의 키를 `***` 로 가린 뒤 다뤄요. |
| POST | `/api/bridge/bye` | 연동을 끝내요. |
| GET | `/api/bridge/transcript`, `/api/bridge/upload` | 옮기는 중인 대화 기록, 올린 영상·파일을 맥이 받아 가요. |

### 익스텐션 `/api/ext`

| 메서드 | 경로 | 하는 일 |
|---|---|---|
| GET·PUT·POST·DELETE | `/api/ext`, `/api/ext/<id>/…` | 익스텐션 목록·동의·오류 보고, 저장(`storage/user`·`storage/server`), 비밀값, 서버 라우트(`call`), 이벤트 claim 이에요. [익스텐션 API (화면, JS)](/reference/extension-api)를 보세요. |

### 서비스 API `/api/service`

로그인 쿠키 대신 `Authorization: Bearer <BRIDGE_SERVICE_TOKEN>` 으로 부르는 경로예요. `BRIDGE_SERVICE_TOKEN`·`BRIDGE_SERVICE_UID` 가 모두 있을 때만 켜지고, 토큰이 대신하는 한 사람의 맥과, 이 API 로 연 세션만 다뤄요. 켜는 법은 [접근 관리와 운영 화면](/guide/operate/admin#6-서비스-api-켜기-선택)을 보세요.

| 메서드 | 경로 | 하는 일 |
|---|---|---|
| POST | `/api/service/sessions` | `{host, cwd?, prompt, title?}` 로 안전한 전부 허용 세션을 만들어 시작해요. `{ok, id}` 를 돌려줘요. |
| GET | `/api/service/sessions/<sid>` | `{id, host, state, phase, waitingOn?, answer}` 를 돌려줘요. |
| POST | `/api/service/sessions/<sid>/close` | 그 세션을 닫아요. 이미 닫혔으면 200 이에요. |

토큰이 틀리면 401 `서비스 토큰이 맞지 않아요`, 그 사람의 계정이 허용돼 있지 않으면 403 `서비스 토큰의 계정이 허용돼 있지 않아요`, 이 API 로 열지 않은 세션은 404 `세션이 없습니다` 예요.

맞는 경로가 없으면 404 예요. 경로마다 쓰는 요청·응답 모양은 저장소의 `docs/SPEC.md` §3.1.3 을 보세요.

## 요청 규칙

| 규칙 | 값 | 어기면 |
|---|---|---|
| 같은 출처 | `GET` 이 아닌 요청에 `Origin` 머리글이 있으면 사이트 주소와 같아야 해요. | 403 `다른 출처의 요청입니다` |
| 본문 형식 | `POST` 는 `Content-Type: application/json` 이어야 해요(영상·파일 올리기와 Slack 연결 폼은 예외). | 415 `application/json 만 받습니다` |
| 로그인 | 로그인 쿠키(`https` 사이트는 `__Host-cb`, 그 밖의 `http` 주소는 `cb`)가 살아 있어야 해요. 로그인은 30일 뒤 끝나요. | 401 `로그인이 필요합니다` |
| 본문 크기 | 경로마다 한도가 있어요(예: 보내기 6,291,456 byte, 세션 만들기 262,144 byte). | 413 `요청이 너무 큽니다` |
| JSON | 본문은 JSON 객체여야 해요. | 400 `JSON 이 아닙니다` / `JSON 객체가 아닙니다` |
| 꺼진 기능 | 서버 설정 `features.*` 로 끈 기능의 경로는 거절해요([bridge.yaml 키](/reference/config)). | 403 `이 서버에서 꺼진 기능이에요` |
| 헤더 로그인만 | `auth.headerOnly` 를 켠 서버는 `/api/auth/logout` 말고 모든 `/api/auth/*` 를 닫아요. 로그인은 앞단 프록시의 헤더로만 해요. | 404 `없는 주소입니다` |
| 오류 모양 | `{"ok":false,"error":"…"}` 이에요. | — |

`/api/health` 와 `/api/auth/*` 는 같은 출처·본문 형식 검사를 하지 않아요. `/api/service/*` 는 쿠키·출처 검사 앞에서 토큰으로 받아요.

### 응답 머리글

| 머리글 | 값 | 붙는 곳 |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000` | 사이트 주소가 `https://` 일 때 모든 응답(JSON, 이벤트 스트림, 미리보기 출처 포함). `includeSubDomains` 는 붙이지 않아요. `http://` 주소에는 붙지 않아요 |
| `Content-Security-Policy` | `default-src 'self'` 바탕, `connect-src 'self' http://127.0.0.1:*`, `frame-ancestors 'self'`, `base-uri 'self'`, `object-src 'none'` 등 | 페이지 |
| `X-Content-Type-Options` | `nosniff` | 페이지 |
| `Referrer-Policy` | `no-referrer` | 페이지 |

이미지·프레임 출처는 서버 설정의 `csp.imgSrc`·`csp.frameSrc` 로 `https` 출처만 더할 수 있어요([bridge.yaml 키](/reference/config)).

### 스트림 한도

| 대상 | 한도 | 넘으면 |
|---|---|---|
| 한 사람이 여는 조작 페이지 스트림(`/api/classic/stream`) | 32개 | 하나 더 열면 가장 오래된 것을 닫아요 |
| 받는 쪽이 읽지 않아 쌓인 보낼 것(조작 페이지·연동 탭 스트림) | 64 MiB | 그 스트림을 끊어요. 페이지는 다시 열어 전체 상태를 처음부터 받아요 |
| 미리보기 웹소켓 메시지(조각을 합친 크기) | 16 MB | `1009 too big` 으로 닫아요 |

### 속도 제한

| 대상 | 한도 | 넘으면 |
|---|---|---|
| `/api/auth/*` 모든 요청 | 주소마다 60,000 ms 안에 20번 | 429 `too many requests` |
| `POST /api/sessions/<sid>/lock`·`unlock`·`lockclear` | 주소마다 60,000 ms 안에 10번, 세션마다도 10번 | 429 |

발신 주소는 `X-Forwarded-For` 의 맨 뒤 값이에요. 그래서 서버 앞의 프록시가 이 머리글을 써 줘야 하고, 컨테이너 포트를 인터넷에 직접 열면 안 돼요. 이 밖의 경로에는 속도 제한이 없어요. 공개 데모 계정에는 따로 한도가 있어요([한도와 시간](/reference/limits#공개-데모)).

## 맥 에이전트의 로컬 경로

에이전트는 맥의 `127.0.0.1:<port>`(기본 4317)에서만 들어요. 바깥으로 직접 연결하지 않고, 연동 페이지가 이 경로로 에이전트와 말해요.

| 메서드 | 경로 | 키 | 하는 일 |
|---|---|---|---|
| GET | `/ping` | 없음 | `{"agent":"claude-bridge"}` 만 답해요. 같은 포트의 에이전트를 알아보는 데 써요. |
| GET | `/bg-open?t=<32 hex>` | 한 번 쓰는 토큰 | 헤드리스 브라우저의 첫 주소예요. 토큰이 맞으면(2분, 한 번) 키가 든 연동 주소로 302 를 보내요. 아니면 404 예요. |
| GET | `/host` | 에이전트 키 | 이 맥의 호스트 id 예요. |
| GET | `/events` | 에이전트 키 | 에이전트 → 연동 페이지 SSE 스트림이에요. 5,000 ms 마다 유지 신호를 보내요. |
| POST | `/cmd` | 에이전트 키 | 연동 페이지가 서버의 명령을 넘겨요. |
| POST | `/file` | 에이전트 키 | 연동 페이지가 받은 영상·파일을 `~/.claude-bridge/images/` 에 저장해요. |
| POST | `/hook`, `/statusline` | 훅 키 또는 에이전트 키 | Claude Code 훅과 상태 줄이 보내요. |
| POST | `/askpass`, `/delegate` | 훅 키 또는 에이전트 키 | 세션 안의 `sudo` 비밀번호 요청, 세션의 맡기기 요청이에요. |

키가 맞지 않으면 401 이에요.
