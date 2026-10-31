---
description: 서버 설정 파일 bridge.yaml 이 받는 모든 키를 형식, 기본값, 같은 뜻의 환경 변수와 함께 정리하고, 문법·치환·검사 규칙을 담은 표예요.
---

# bridge.yaml 키

이 페이지는 서버 설정 파일 `bridge.yaml` 이 받는 키를 빠짐없이 정리해요. 파일을 두는 곳과 옮기는 법은 [서버 설정 파일 bridge.yaml](/guide/operate/config)을 보세요.

이 페이지는 [1.371 판](/changelog) 기준이에요.

서버는 시작할 때 파일을 한 번 읽어요. 키를 바꾸면 서버를 다시 시작해야 해요. 표에 없는 키가 있으면 서버가 시작하지 않아요.

"환경 변수" 열의 변수는 그 키의 기본값이에요. 파일에 값이 있으면 파일이 이겨요. 그 열이 비어 있는 키는 "기본값" 열이 지금 동작이에요.

## origins

| 키 | 형식 | 기본값 | 환경 변수 | 뜻 |
|---|---|---|---|---|
| `origins.primary` | 출처 `http(s)://호스트[:포트]` | 환경 변수 값 | `BRIDGE_ORIGIN` | 사이트의 공개 주소예요. 맥 연동, GitHub 로그인 콜백, 설치 스크립트가 이 주소를 써요. |
| `origins.extra` | 출처 목록 | 빈 목록 | — | 같은 서버를 여는 다른 주소예요. `auth.providers` 의 trusted-header 가 있어야 써요. 맥 연동은 하지 않아요. |

## auth

| 키 | 형식 | 기본값 | 환경 변수 | 뜻 |
|---|---|---|---|---|
| `auth.allow` | 로그인 이름 목록 | 환경 변수 값 | `GITHUB_ALLOWED_LOGINS` | 처음부터 허용할 계정이에요. `"*"` 는 누구나예요. 헤더 로그인이면 이메일을 적어요. |
| `auth.admins` | 로그인 이름 목록 | 환경 변수 값 | `BRIDGE_ADMIN_LOGINS` | **운영자** 계정이에요. 운영 탭을 봐요. |
| `auth.providers` | 목록(항목 하나) | 빈 목록 | — | 앞단 프록시가 확인한 사람을 헤더로 받아 로그인시켜요. 지금은 `type: trusted-header` 만 받아요. |
| `auth.headerOnly` | `true`·`false` | `false` | — | 헤더 로그인만 받아요. GitHub·Apple·데모·QR 로그인과 헤드리스 연동을 닫아요. |

`auth.providers` 의 항목에는 다섯 필드가 모두 있어야 해요.

| 필드 | 형식 | 뜻 |
|---|---|---|
| `type` | `trusted-header` | 제공자 종류예요. |
| `userHeader` | 헤더 이름 | 프록시가 사용자 이메일을 넣는 헤더예요. |
| `secretHeader` | 헤더 이름 | 프록시가 공유 비밀을 넣는 헤더예요. `userHeader` 와 달라야 해요. |
| `secret` | 16자 이상 글자 | 공유 비밀이에요. `"${PROXY_SECRET}"` 처럼 환경 변수로 넣으세요. |
| `trustFrom` | IP·CIDR 목록 | 프록시의 주소예요. 연결한 TCP 주소로 비교해요. |

## retention

| 키 | 형식 | 기본값 | 환경 변수 | 뜻 |
|---|---|---|---|---|
| `retention.allowPurge` | `true`·`false` | 환경 변수 값 | `BRIDGE_PURGE` | 운영 탭에서 예전 판의 데이터 정리를 실행하게 해요. |
| `retention.uploadsHours` | 정수 1~8760 | `24` | — | 맥이 받지 못한 업로드를 보관하는 시간이에요. |
| `retention.previews` | `true`·`false` | `true` | — | `false` 면 세션 기록에 미리보기 문구를 남기지 않아요. |

## features

모두 `true`·`false` 이고 기본은 `true` 예요. 같은 뜻의 환경 변수는 없어요. 끄면 그 API 가 403 `이 서버에서 꺼진 기능이에요` 로 거절하고, 화면은 그 입구를 숨겨요.

| 키 | 끄면 닫히는 것 |
|---|---|
| `features.sessionMove` | 다른 맥으로 옮기기, 이어서 열기의 다른 맥, 일 받기 스위치, 다른 맥에 일 맡기기 |
| `features.webpush` | 웹 푸시 키·구독·발송. iOS 앱 알림은 그대로예요 |
| `features.voice` | 음성 탭, 입력창 마이크, 음성 단축키 |
| `features.preview` | 세션 화면의 서버 미리보기와 미리보기 출처의 모든 요청 |
| `features.skills` | 스킬 링크, `/skills`, 스킬 저장소 설정 |
| `features.slack` | 플러그인 탭, Slack 으로 옮기기, 시작 가이드의 Slack 단계. 저장된 연결은 남아요 |
| `features.remoteKeys` | 터미널 화면 시트의 키 버튼 |

| 키 | 형식 | 기본값 | 뜻 |
|---|---|---|---|
| `features.permissionModes` | 모드 목록 | 여섯 모드 전부 | 고를 수 있는 권한 모드예요. 항목은 `default`·`acceptEdits`·`plan`·`auto`·`autoAllow`·`allowAll`(대소문자 그대로)이에요. `default` 는 적지 않아도 늘 들어 있어요. |

권한 모드의 키와 화면(새 세션, 세션 설정)의 이름은 이래요.

| 키 | 화면 이름 |
|---|---|
| `default` | manual · 편집·명령마다 물어봄 |
| `acceptEdits` | acceptEdits · 파일 편집은 자동 승인 |
| `plan` | plan · 계획만 세우고 실행 안 함 |
| `auto` | auto · 거의 모두 자동 승인 |
| `autoAllow` | 안전한 전부 허용 · 위험한 호출만 물어봄 |
| `allowAll` | 전부 허용 · 하나도 묻지 않음 |

## csp, privacy

| 키 | 형식 | 기본값 | 뜻 |
|---|---|---|---|
| `csp.frameSrc` | `https://` 출처 목록 | 빈 목록 | 조작 페이지 CSP 의 `frame-src` 끝에 붙여요. |
| `csp.imgSrc` | `https://` 출처 목록 | 빈 목록 | 조작 페이지 CSP 의 `img-src` 끝에 붙여요. |
| `privacy.file` | `.html` 파일 경로 | 없음 | `GET /privacy` 가 이 파일을 내줘요. 상대 경로는 설정 파일이 있는 폴더 기준이에요. |

`script-src`·`connect-src` 는 넓히지 않아요. CSP 항목은 `https://호스트[:포트][/경로]` 모양이고, 호스트 맨 앞에 `*.` 를 쓸 수 있어요.

## notify, hooks, extensions

이 키들은 각 가이드에서 자세히 다뤄요.

| 키 | 형식 | 기본값 | 뜻 |
|---|---|---|---|
| `notify` | 목록 | 빈 목록 | 서버의 이벤트를 바깥 웹훅으로 보내요. [알림 웹훅과 훅](/guide/operate/hooks) |
| `hooks` | 훅 이름 → 목록 | 없음 | 액션·이벤트에 웹훅이나 명령을 걸어요. [알림 웹훅과 훅](/guide/operate/hooks) |
| `extensions` | 목록 | 빈 목록 | 서버가 불러올 익스텐션 폴더와, 그 익스텐션이 읽어도 되는 환경 변수예요. [익스텐션 두기와 만들기](/guide/operate/extensions) |
| `extensionConsent` | `true`·`false` | `true` | `false` 면 모든 사람이 익스텐션에 동의한 것으로 봐요. [익스텐션 두기와 만들기](/guide/operate/extensions) |

`notify`·`hooks`·`extensions`·`extensionConsent` 는 절이 아니라 맨 위 키예요.

## 예

```yaml [bridge.yaml]
origins:
  primary: "${BRIDGE_ORIGIN:-}"
auth:
  admins: "${BRIDGE_ADMIN_LOGINS:-}"
retention:
  uploadsHours: 6
features:
  slack: false
  permissionModes: [default, acceptEdits, plan]
csp:
  frameSrc: [https://embed.example.com]
privacy:
  file: privacy.html
```

## 규칙

::: details 문법
`bridge.yaml` 은 YAML 의 일부만 받아요.

- 받는 것: 블록 맵·목록, 한 줄 흐름 표기 `[a, b]`·`{k: v}`, 따옴표 없는 글, 큰따옴표 글(`\" \\ \/ \n \t \r \uXXXX`), 작은따옴표 글(`''`), `#` 주석. 파일이 `{` 로 시작하면 JSON 으로 읽어요.
- 거절하는 것: 앵커·별칭(`&` `*`), 태그(`!`), 여러 줄 글(`|` `>`), 여러 문서(`---`)·지시어(`%`), 들여쓰기의 탭, 같은 키 두 번.
- 모든 값은 글자로 읽고, 키가 자료형을 정해요. `yes`·`on` 은 참이 아니에요. `true`·`false` 만 받아요.
- `*`·`@`·`` ` ``·`%` 로 시작하는 값은 큰따옴표로 감싸세요(예: `"*"`).
- 흐름 표기 안에 `{`·`[` 가 든 값은 큰따옴표로 감싸세요(예: `["${A}"]`).
- 값이 빈 절(`retention:`)은 그 절을 적지 않은 것과 같아요. `~`·`null` 값은 그 키를 적지 않은 것과 같아요.
- 흐름 표기 안의 `${…}` 는 큰따옴표 안에서만 받아요.
:::

::: details 환경 변수 치환
- `${NAME}`: 그 환경 변수 값이에요. 비어 있으면 시작하지 않아요.
- `${NAME:-}`: 비어도 돼요. 결과가 빈 값이면 그 키(목록이면 그 항목)를 적지 않은 것과 같아요.
- `$${`: 글자 `${` 예요.
- `${NAME:-기본값}` 은 받지 않아요.
- 치환은 파싱이 끝난 뒤 값 하나씩 해요.

값이 정확히 그 키의 같은 뜻 환경 변수 참조(`"${BRIDGE_ORIGIN}"` 이나 `"${BRIDGE_ORIGIN:-}"`)면 그 환경 변수의 규칙으로 읽어요. 그래서 운영 탭이 내보낸 파일은 환경 변수만 쓸 때와 같은 값이 되고, 환경 변수를 고치면 그대로 따라가요.

| 키 | 환경 변수 규칙 | 파일 값 규칙 |
|---|---|---|
| `origins.primary` | 끝의 `/` 를 지우고 형식을 보지 않아요 | `http(s)://호스트[:포트]`, 경로 없이. 끝 `/` 는 지워요 |
| `auth.allow`, `auth.admins` | 쉼표로 나누고 앞뒤 공백 제거, 소문자, 빈 항목 버림 | YAML 목록: 항목마다 앞뒤 공백 제거·소문자, 빈 항목은 거절해요. 쉼표로 이은 글 하나: 쉼표로 나누고 앞뒤 공백 제거·소문자, 빈 항목은 버려요 |
| `retention.allowPurge` | 정확히 `1` 일 때만 참 | `true`·`false` |

목록에서는 한 항목이 그 참조여도 되고, 그 자리에 펼쳐져요.
:::

::: details 키 사이 규칙
- `auth.headerOnly: true` 는 `auth.providers` 에 trusted-header 가 있어야 해요.
- `origins.extra` 는 `auth.providers` 에 trusted-header 가 있어야 하고, `origins.primary`(또는 `BRIDGE_ORIGIN`)가 있어야 해요. primary 와 같은 호스트는 안 돼요.
- trusted-header 는 하나만 둘 수 있어요.
- `GITHUB_CLIENT_ID` 가 있는데 합친 `origins.primary` 가 없으면 시작하지 않아요.
:::

::: details 오류 문구
틀린 곳이 있으면 서버는 표준 오류에 `설정 파일 오류로 시작하지 않습니다: <이유>` 를 쓰고 시작하지 않아요. 이유 앞에는 `N번째 줄: ` 이 붙어요. 오류 문구에는 비밀값을 싣지 않아요.

| 경우 | 문구 |
|---|---|
| 모르는 키 | `모르는 키 <키> (이 서버(<버전>)가 받는 키: …)` |
| 비어 있는 `${NAME}` | `환경변수 <NAME> 가 비어 있습니다(비어도 되면 ${<NAME>:-})` |
| 기본값을 붙인 참조 | `${<NAME>:-…}: 비어 있지 않은 기본값은 받지 않습니다(${<NAME>:-} 만 됩니다)` |
| 출처 모양이 틀림 | `<키> 는 https://호스트[:포트] 모양이어야 합니다(경로 없이)` |
| 참·거짓이 아님 | `<키> 는 true 나 false 여야 합니다` |
| 보관 시간 범위 밖 | `retention.uploadsHours 는 1 부터 8760 까지의 정수(시간)여야 합니다` |
| 모르는 권한 모드 | `features.permissionModes 의 <모드> 는 모르는 모드입니다(받는 모드: …)` |
| CSP 항목 모양 | `<키> 의 <값> 는 https://호스트[:포트][/경로] 모양이어야 합니다` |
| 처리방침 파일 | `privacy.file 는 .html 파일이어야 합니다(그대로 웹 페이지로 내줍니다)` |
| 비밀이 짧음 | `auth.providers[].secret 은 16자 이상이어야 합니다` |
| 헤더 이름이 틀림 | `auth.providers[].<필드> 는 헤더 이름이어야 합니다(영문·숫자·-, Cookie·Host 는 안 됨)` |
| trustFrom 이 틀림 | `auth.providers[].trustFrom 의 <값> 는 IP 주소나 CIDR(10.0.0.0/8)이어야 합니다` |
| headerOnly 만 있음 | `auth.headerOnly 는 auth.providers 에 trusted-header 가 있어야 씁니다(없으면 아무도 들어올 수 없습니다)` |
| extra 만 있음 | `origins.extra 는 auth.providers 에 trusted-header 가 있어야 씁니다(OAuth 로그인은 origins.primary 에서만 됩니다)` |
| 경로가 상대 경로 | `BRIDGE_CONFIG 는 절대 경로여야 합니다(지금 값: …)` |
| 정한 파일이 없음 | `BRIDGE_CONFIG 의 파일이 없습니다: … (마운트가 빠졌는지 보세요)` |
| 자리가 폴더 | `설정 파일 자리가 폴더입니다: … (없는 파일을 -v 로 마운트하면 Docker 가 폴더를 만듭니다)` |
| 서버 사용자가 못 읽음 | `설정이 가리키는 파일을 서버 사용자(uid 1000)가 읽을 수 없습니다: … (권한을 0644 로 하거나 소유자를 바꾸세요)` |
:::

::: details 권한 모드 목록의 동작
- 목록 밖 모드로 시작하려는 세션(새 세션, 개인 기본값, 복제, 위임, 제보 대응)은 거절하지 않고 `default` 로 낮춰요.
- 전부 허용(`autoAllow`·`allowAll`)은 그 모드가 목록에 있을 때만 켜요.
- 세션 설정에서 목록 밖 모드나 목록 밖 전부 허용으로 바꾸면 403 이에요.
- 맥이 목록 밖 전부 허용을 알리면 서버가 끄고 맥에도 끄라고 보내요.
- 서비스 API 는 `autoAllow` 가 목록에 없으면 403 이에요.
- `permissionModes: []` 는 `default` 하나예요.
- 키 입력이나 맥 쪽 설정 같은 우회까지 막지는 않아요. 가드레일이에요.
:::

## 관련 주소

운영자만 쓸 수 있어요. 운영자가 아니면 403 `운영자만 볼 수 있습니다` 예요.

| 메서드 | 경로 | 하는 일 |
|---|---|---|
| `GET` | `/api/admin/config` | 지금 파일 상태, 시작 때 읽은 파일, 환경 변수와 다른 키, 시작 실패 기록 |
| `GET` | `/api/admin/config/export` | 지금 환경 변수로 참조만 담은 `bridge.yaml` 을 내려받기. 파일이 있으면 409 |
| `POST` | `/api/admin/config/save` | 내보낸 내용을 기본 위치에 한 번 저장. 본문 1 KiB 까지 |
| `POST` | `/api/admin/config/check` | `{yaml?}` 를 검사. 없으면 디스크의 파일을 검사. 본문 256 KiB 까지 |

명령줄은 컨테이너 안에서 `/app/bridge-server config export` 와 `/app/bridge-server config check [파일]` 이에요.
