---
description: Agent Bridge 서버 플러그인의 정의 모양(id, fields, start, choices, moveIn/moveOut)과 플러그인이 부를 수 있는 호스트 호출, 설정 API 를 정리한 표예요.
---

# 플러그인 API

::: tip 화면을 넓히거나 바깥 서비스와 잇는 것은 익스텐션이에요
조작 페이지에 버튼·메뉴·설정을 더하거나, 페이지가 하는 일에 끼어들거나, 바깥 API 를 부르려면 **익스텐션**을 쓰세요. 서버를 다시 빌드하지 않고 폴더만 두면 돼요. [익스텐션 두기와 만들기](/guide/operate/extensions)와 [익스텐션 API](/reference/extension-api)를 보세요. 이 페이지의 플러그인은 서버 안에 Go 로 빌드해 넣는 것(지금은 Slack)이에요.
:::

이 페이지는 서버 **플러그인**의 정의 모양과, 플러그인이 사용자로서 부를 수 있는 호출을 정리해요. Slack 플러그인을 켜고 쓰는 방법은 [Slack 플러그인](/guide/use/slack)을 보세요.

이 페이지는 [1.371 판](/changelog) 기준이에요.

## 플러그인은 무엇으로 쓰나요?

플러그인은 서버 안에 함께 빌드되는 **Go 코드**예요. 서버는 표준 라이브러리만 쓰는 Go 바이너리 하나라서, 실행 중에 바깥 파일을 읽어 플러그인을 더하지 않아요. 새 플러그인은 `server/` 에 Go 로 정의를 쓰고 `newPlugins` 의 목록(`ALL_PLUGINS`)에 넣은 뒤 서버를 다시 빌드해요.

지금 들어 있는 플러그인은 Slack 하나예요(`server/slack.go` 의 `slackPlugin()`). 사용자마다 설정과 실행 인스턴스가 따로 있어서, 한 사람의 플러그인 오류는 다른 사람에게 번지지 않아요.

## 플러그인 정의 `pluginDef`

| 필드 | 자료형 | 필수 | 설명 |
|---|---|---|---|
| `id` | 문자열 | 예 | 플러그인 id 예요(예: `slack`). 설정 파일의 키와 API 경로 `/api/plugins/<id>` 에 써요. |
| `name` | 문자열 | 예 | 화면에 보일 이름이에요. |
| `about` | 문자열 | 예 | 설정 화면에 보일 한 문단 설명이에요. |
| `fields` | `[]pluginField` | 예 | 사용자가 채우는 설정 칸이에요. 아래 표를 보세요. |
| `help` | 배열 | 아니오 | 설정 화면의 단계별 안내예요. 항목마다 `title`, `text`, 선택으로 `link {label, url}`, `copy {label, text}` 를 둬요. |
| `prompt` | 객체 | 아니오 | "AI 에게 맡기기" 프롬프트예요. `label`, `about`, `text` 를 둬요. `text` 의 `{origin}` 은 화면이 사이트 주소로 바꿔요. |
| `start(config, host)` | 함수 → `PluginInst` | 예 | 켤 때 부르는 함수예요. 저장된 설정과 [호스트](#호스트-호출)를 받아 실행 인스턴스를 돌려줘요. 예외가 나면 인스턴스 상태는 `error` 가 돼요. |
| `choices(config, key)` | 함수 → 배열 | 아니오 | `pick` 이 있는 칸에서 고를 수 있는 값이에요. 항목은 `{value, label}` 이에요. |

### 설정 칸 `pluginField`

| 필드 | 자료형 | 기본값 | 설명 |
|---|---|---|---|
| `key` | 문자열 | — | 설정 값의 키예요. |
| `label` | 문자열 | — | 칸 이름이에요. |
| `placeholder` | 문자열 | 빈 값 | 칸의 예시 글이에요. |
| `secret` | 불리언 | `false` | 비밀 값이에요. 목록 응답에서 값이 있으면 `••••••••` 로 가리고, 빈 칸으로 저장하면 원래 값을 지켜요. |
| `required` | 불리언 | `false` | 켜려면 꼭 채워야 해요. 비어 있으면 켜지 않고 "… 을(를) 채워 주세요" 로 거절해요. |
| `prefix` | 문자열 | 빈 값 | 값이 이 글자로 시작해야 해요(예: `xoxb-`). 두 칸의 값이 서로 바뀌어 들어오면 제자리로 옮기고 알려 줘요. |
| `pick` | 문자열 | 빈 값 | 고르기 버튼의 이름이에요(예: "채널 고르기"). `choices` 로 값을 받아요. 필수 칸이 비어 있고 고를 값이 하나뿐이면 그 값으로 정해요. |
| `kind` | 문자열 | 빈 값 | 특별한 입력 모양이에요(Slack 은 `places`: 맥마다 새 세션을 띄울 곳). |
| `max` | 정수 | `400` | 값의 최대 길이(자)예요. 앞뒤 공백을 지운 뒤 잘라요. |

### 실행 인스턴스 `PluginInst`

| 메서드 | 필수 | 설명 |
|---|---|---|
| `status()` | 예 | `{state, note}` 를 돌려줘요. `state` 는 `connecting`·`on`·`error`·`off` 등이에요. 설정 화면과 목록 응답에 그대로 보여요. |
| `stop()` | 예 | 끌 때, 설정을 바꿀 때, 서버가 끝날 때 불러요. 예외는 무시해요. |
| `onEvent(thread, ev)` | 아니오 | 그 사용자의 세션에 이벤트가 생길 때마다 불러요. `ev` 는 Slack 형식 이벤트예요. |
| `moveIn(thread)` | 아니오 | 세션을 웹에서 이 플러그인으로 옮길 때 불러요. `{url}` 을 돌려주면 세션 화면이 그 주소로 링크해요. 이 메서드가 있고 상태가 `on` 이면 세션 메뉴의 옮길 곳에 나타나요. |
| `moveOut(thread)` | 아니오 | 세션을 이 플러그인에서 웹으로 되돌릴 때 불러요. |

Slack 플러그인은 계정 연결용으로 `link(code)`·`who(code)` 도 둬요. 이것은 Slack 연결 경로만 쓰는 Slack 전용 메서드예요.

## 호스트 호출

`start` 가 받는 `host` 는 그 사용자로서만 동작해요. 다른 사람의 세션에는 닿지 않아요.

| 호출 | 매개변수 | 돌려주는 것 | 설명 |
|---|---|---|---|
| `Origin()` | — | 문자열 | `BRIDGE_ORIGIN`, 없으면 `http://localhost:<PORT>` 예요. |
| `Code()` | — | 문자열 | 무작위 16 byte 16진수예요. 연결 코드 같은 데 써요. |
| `Sessions()` | — | 배열 | 그 사용자의 끝나지 않은 세션 행(Slack 형식)을 만든 순서로 줘요. 잠긴 세션은 가린 모습이에요. |
| `Find(thread)` | `thread` 문자열 | 세션 행 또는 `nil` | 그 thread 키의 세션이에요. |
| `Command(value)` | `value` 문자열 | 문자열 | Slack 형식 명령(`:status`, `:esc`, `:answer 2` 등)을 실행하고 결과 글을 돌려줘요. |
| `Seat(thread)` | `thread` | `{where, link, closed}` 또는 `nil` | 세션을 지금 어디서 조작하는지(`web` 또는 `slack`), 세션 화면 주소(`<origin>/s/<sid>`), 끝났는지예요. |
| `Summary(thread)` | `thread` | `{title, host, cwd, last, link}` 또는 `nil` | 제목, 맥 이름, 작업 폴더(홈은 `~`), 최근 기록 400개 중 마지막 답 글, 세션 주소예요. |
| `SeatUrl(thread, url)` | `thread`, `url` | — | 세션이 그 플러그인에 있을 때 스레드 주소를 앞 500자까지 저장해요. 세션 화면이 그 주소로 링크해요. |
| `MoveTo(thread, to)` | `thread`, `to`(`web`·`slack`) | `{ok, note, url}` | 작업하는 곳을 옮겨요. 세션이 없으면 400 `세션을 찾지 못했어요` 예요. |
| `Send(thread, text, images)` | `thread`, 글, 그림 배열 | `{ok, …}` | 세션에 글을 보내요. 세션이 없거나 끝났으면 400 `이미 끝난 세션이에요` 예요. |
| `Start(prompt, cwd, places)` | 첫 지시, 폴더, places JSON | `{thread}` | 새 세션을 띄워요. 아래 규칙을 보세요. |
| `state` | 객체 | — | 플러그인이 자기 상태를 담아 두는 곳이에요. `plugins.json` 에 함께 저장돼요. |
| `save()` | — | — | `state` 를 포함한 설정을 저장해요. |
| `changed()` | — | — | 상태가 바뀌었다고 알려요. 그 사용자의 화면이 다시 그려져요. |
| `log(text)` | 글 | — | 서버 로그에 `plugin <id> user=<uid>: <글>` 한 줄을 남겨요. |

`Start` 는 이렇게 맥과 폴더를 골라요.

1. 그 사용자의 연결된 맥이 없으면 400 `연결된 맥이 없어요. 맥의 브라우저에서 Agent Bridge 를 열어 두세요.` 예요.
2. `places` 는 JSON `{main, dirs}` 예요. `main` 맥이 연결돼 있으면 그 맥, 아니면 연결된 맥 중 첫째예요.
3. 폴더는 `dirs[맥 id]` 가 비어 있지 않으면 그것, 아니면 `cwd` 예요. 없는 폴더는 만들어요.

## 설정 API

조작 페이지의 설정 → 플러그인이 쓰는 경로예요. 요청 규칙은 [주소와 HTTP API](/reference/routes#요청-규칙)를 보세요.

| 메서드 | 경로 | 본문 | 설명 |
|---|---|---|---|
| GET | `/api/plugins` | — | `{plugins: [{id, name, about, fields, help, prompt, added, enabled, config, status}]}` 예요. 비밀 칸은 가려요. |
| POST | `/api/plugins/<id>` | `{enabled?, config?}` 또는 `{remove: true}` | 플러그인을 더하고, 설정을 바꾸고, 켜고 끄고, 빼요. 저장하면 인스턴스를 다시 시작해요. 본문은 16,384 byte 까지예요. |
| POST | `/api/plugins/<id>/choices` | `{key, config?}` | `{ok, choices}` 로 `pick` 칸에서 고를 수 있는 값을 줘요. 저장하지 않은 입력값(`config`)도 반영해요. |

플러그인 오류는 HTTP 400 과 `{"ok":false,"note":"…"}` 로 돌아와요.

`bridge.yaml` 에서 서버 기능 `features.slack` 을 끄면 Slack 플러그인의 경로(`/api/plugins/slack`, `/choices`, `/link`)는 403 이고, 설정의 플러그인 탭도 탭 줄에서 사라져요.

## 저장

설정은 사용자마다 `BRIDGE_DATA/u/<uid>/plugins.json` 에 `{ <id>: { enabled, config, state } }` 로 저장돼요. 서버가 켜지면 저장된 모든 사용자의 켜진 플러그인을 시작해요.
