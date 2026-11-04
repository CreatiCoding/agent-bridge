---
description: 익스텐션이 받는 bridge 객체(액션, slot, 단축키, 시트, kit, 저장, 서버 라우트, 이벤트, i18n)와 extension.yaml 의 키, extensionApi 버전 규칙을 정리한 표예요.
---

# 익스텐션 API

이 페이지는 익스텐션이 기대어도 되는 공개 API(`extensionApi: 1`)를 정리해요. 익스텐션을 서버에 두고 켜는 방법은 [익스텐션 두기와 만들기](/guide/operate/extensions)를 보세요.

이 페이지는 [1.404 판](/changelog) 기준이에요.

타입의 원본은 [`extensions/agent-bridge-ext.d.ts`](https://github.com/CreatiCoding/agent-bridge/blob/main/extensions/agent-bridge-ext.d.ts) 예요. 조작 페이지는 자기 `bridge` 객체를 이 타입과 맞대 타입 검사해요. 이 페이지와 d.ts 가 다르면 d.ts 가 맞아요.

::: warning 여기 없는 것은 언제든 바뀌어요
DOM 구조, CSS 클래스, 전역 변수, `kit` 의 다른 내보내기, `Session` 의 다른 필드, 서버의 다른 경로는 공개 API 가 아니에요. 판마다 바뀔 수 있어요.
:::

## 입구

익스텐션의 entry 모듈은 함수 하나를 `default` 로 내보내요. 페이지는 그 함수를 `bridge` 객체와 함께 불러요.

```ts
import type { Bridge } from '../../agent-bridge-ext'

export default function setup(bridge: Bridge) {
  // 처리기·항목·단축키를 여기서 붙여요
}
```

함수는 Promise 를 돌려줘도 돼요. 페이지는 동의한 익스텐션이 하나라도 있으면 모두 끝나거나 1.5초가 지날 때까지 기다린 뒤 화면을 그려요. 등록 함수(`before`, `register` 등)는 모두 **떼는 함수**를 돌려줘요.

## `bridge` 객체

| 부분 | 무엇 |
|---|---|
| `React` | 페이지의 React(19)예요. 자기 React 를 번들하지 말고 이것을 써요 |
| `kit` | 페이지의 UI 부품이에요. [kit](#kit) 을 보세요 |
| `extensionApi` | 이 페이지의 API 버전(지금 `1`)이에요 |
| `id` | 이 익스텐션의 id 예요 |
| `actions` | `before`·`after`·`around`·`dispatch`. [액션](#액션)을 보세요 |
| `slots` | `register`·`replace`·`hide`·`useSlotContext`. [slot](#slot)을 보세요 |
| `commands` | `register(shortcut)`. [단축키](#단축키)를 보세요 |
| `ui` | `sheet.open`·`confirm`·`menu`·`prompt`·`choose`·`toast`. [화면 도구](#화면-도구-ui)를 보세요 |
| `storage` | `user`·`server`·`secrets`. [저장](#저장-storage)을 보세요 |
| `api` | `fetch`·`json`·`blobUrl`. [서버 라우트](#서버-라우트-api)를 보세요 |
| `isPrimary` | 이 페이지가 이 브라우저의 대표 페이지인지예요(한 번만 할 일을 맡는 창) |
| `events.claim(eventId)` | 이 사람의 여러 브라우저 중 처음 부른 곳에서만 `true` 예요. [이벤트](#이벤트)를 보세요 |
| `data.shared(key, fetcher, ms)` | 훅이에요. 이 페이지 안에서 키마다 한 번만 가져오고 `ms` 마다 다시 가져와요. 페이지가 숨겨진 동안은 멈춰요 |
| `i18n` | `locale` 과 `t(key)`. [언어 파일](#언어-파일-i18n)을 보세요 |
| `theme` | `dark()` 는 지금 어두운 테마인지, `token('accent')` 는 페이지의 CSS 변수 `--accent` 값이에요 |
| `user` | `{uid, login, provider, admin}` 이에요 |
| `useSessions()`, `useCurrent()` | 훅이에요. 세션 목록과 지금 화면(`{route, sid?}`)이 바뀌면 다시 그려요 |
| `sessions()`, `current()` | 같은 값을 지금 한 번 읽어요 |

`Session` 에서 공개하는 필드는 `id`, `hostId`, `title`, `cwd`, `closed`, `favorite?`, `lastAt`, `state.phase` 뿐이에요. `phase` 는 `starting`·`idle`·`busy`·`waiting`·`ended` 예요.

## 액션

페이지가 하는 일은 이름 붙은 **액션**으로 지나가요. 처리기는 세 가지로 붙어요.

| 붙이는 법 | 모양 | 하는 일 |
|---|---|---|
| `before(name, fn, opts?)` | `(args, ctx) => 새 args \| {cancel: 이유} \| void` | 인자를 바꾸거나 멈춰요. `renderer.block`·`message.render` 에는 못 붙여요 |
| `around(name, fn, opts?)` | `(args, next, ctx) => 결과` | `next(args)` 를 불러 안쪽으로 넘기거나, 부르지 않고 대신해요 |
| `after(name, fn, opts?)` | `(args, result, ctx) => void` | 성공했을 때만, 기본 구현이 실제로 받은 인자로 불려요 |
| `dispatch(name, args)` | — | 액션을 내요. 동기 액션은 결과를 바로, 비동기 액션은 결과나 `{cancel}` 의 Promise 를 돌려줘요 |

`opts` 는 `{priority?, timeoutMs?}` 예요. `ctx` 는 `{dispatch, waitUser}` 예요. `ctx.dispatch` 는 자기 처리기를 건너뛰고 다시 내요. `ctx.waitUser(promise)` 는 사람을 기다리는 동안(확인 창, 시트) 시간 제한을 멈춰요.

`uses.actions` 에 적지 않은 액션에 처리기를 붙이면 예외가 나요.

::: details 처리기 순서와 시간 제한
- **순서**: priority 가 큰 처리기가 바깥이에요. 같으면 익스텐션 id 순이에요. 기본 구현이 가장 안쪽이고 한 번만 돌아요. `before`·`around`·`after` 는 한 줄로 섞여 이 순서를 따라요.
- 기본 priority 는 `0` 이에요. 페이지 자신의 html 미리보기가 `renderer.block` 에 priority `-1000` 으로 붙어 있어서, 익스텐션은 그 바깥에서 html 블록을 먼저 보고 대신 그릴 수 있어요.
- **비동기 액션**(`composer.submit`, `message.send`, `permission.answer`, `session.create`, `session.close`): `before`·`around` 는 `next` 를 부르기 전까지 시간을 재요. 기본 500ms, `timeoutMs` 로 10초까지 늘려요. `waitUser` 동안은 시계가 멈춰요.
- 시간을 넘기거나 `next` 전에 던지면 액션 전체가 `{cancel: "시간 초과"}` 로 끝나요. `session.close` 만은 그 처리기를 건너뛰고 계속해요. `next` 를 부른 뒤 던지면 `next` 의 결과를 써요. 시간 초과 뒤 늦게 부른 `next` 는 기본 구현을 부르지 않아요.
- 취소되면 이유를 토스트로 보여요. 완료 토스트("끝냈어요" 같은)는 내지 않고, 입력칸은 글을 그대로 둬요. 기본 구현의 오류는 그대로 reject 해요.
- **동기 액션**(`session.open`, `link.open`, `clipboard.copy`, `renderer.block`, `notify.show`, `message.render`): 누르는 동안 끝나야 해요(iOS 는 누른 동안에만 새 창·클립보드 쓰기를 허락해요). Promise 를 돌려주는 `before` 는 무시하고 기록해요. 처리기 오류는 기록하고 다음으로 넘어가요.
- 처리기 오류, 시간 초과, 무시된 Promise 는 그 익스텐션 이름으로 운영 탭에 모여요.
:::

### 액션 목록

| 이름 | 인자 | 결과 | 언제 |
|---|---|---|---|
| `composer.submit` | `{sid, text?}` | `{sent, reason?}` | 입력칸의 보내기 버튼, Enter, ⌘Enter |
| `message.send` | `{sid, text, kind: 'text'\|'command', images: {data, name}[], videos: {id, name}[]}` | 서버 응답 | 입력칸(composer.submit 을 거쳐), 음성 보내기, 할 일 정리, choices 버튼 |
| `permission.answer` | `{sid, known, card: {id, kind?, title?, tool?}, option: {n, label, kind}}` | 서버 응답 | 결정 카드의 선택지, Esc, 확정 |
| `session.open` | `{sid, from, replace?}` | 없음 | 세션으로 가는 모든 이동, `/s/<id>` 링크의 왼쪽 클릭 |
| `session.create` | `{hostId, …}`(새 세션 요청 본문) | `{sid}` | 새 세션 화면의 시작 |
| `session.close` | `{sid, kind: 'end'\|'remove'\|'trash'}` | 서버 응답 | 종료, 지우기·제거, 폴더 버리고 종료 |
| `link.open` | `{url, from, target?: '_self'}` | — | 새 창으로 여는 모든 링크, 같은 창으로 넘기는 곳(`_self`) |
| `clipboard.copy` | `{text, kind: 'code'\|'message'\|'link'\|'other'}` | — | 클립보드에 쓰는 모든 곳 |
| `renderer.block` | `{lang, text, closed, isLast, sid?}` | 그릴 것 | 답 안의 펜스 블록마다(`around` 만) |
| `message.render` | `{sid, seq, text, quiet: {ext, name, label} \| null, isLast}` | `{text}` 또는 `{hide: true, reason?}` | 답(Claude 의 답 글)마다(`around` 만) |
| `notify.show` | `{text, sid?}` | 없음 | 서버 알림 토스트 |

`renderer.block` 의 기본 구현은 코드 상자예요. `around` 에서 그릴 React 요소를 돌려주거나, 내 블록이 아니면 `next(args)` 를 돌려줘요. `closed` 는 펜스가 닫혔는지예요(답을 쓰는 중이면 `false`).

### 답 하나 다루기 `message.render`

`message.render` 는 Claude 의 답 하나를 통째로 받아요. 답을 접거나 글을 바꿀 수 있어요. `around` 만 붙일 수 있고, `uses.actions` 에 적어야 해요.

```ts
// 끝이 [잡담] 인 답은 화면에서만 접어요
bridge.actions.around('message.render', (a, next) =>
  a.text.trimEnd().endsWith('[잡담]') ? { hide: true, reason: '잡담' } : next(a))

// 말을 바꿔요
bridge.actions.around('message.render', (a, next) => {
  const v = next(a)
  return 'hide' in v ? v : { text: v.text.replaceAll('TODO', '할 일') }
})
```

- 접은 답은 지워지지 않아요. 타임라인에 한 줄과 **펼치기**로 남고, 펼치면 글이 그대로 나와요.
- 이 처리기에는 Claude 의 답 글만 와요. 결정 카드, 경고·오류, 사람 말은 오지 않아요. 그래서 권한 요청과 경고는 늘 보여요.
- 글을 바꾸면 답 아래에 "<이름> 이 바꿈 · 원문 보기" 가 붙어요. 누가 바꿨는지(`by`)는 페이지가 붙여요. 익스텐션이 정하지 못해요.
- `messages.quiet` 규칙이 조용하게 만든 답은 처리기가 무엇을 돌려줘도 접힌 채예요. `quiet` 인자로 그 규칙을 알 수 있어요.
- 이 훅으로만 접으면 화면에서만 접혀요. 알림과 "새 답" 점은 그대로 나가요. 막으려면 [`messages.quiet`](#조용한-답-messagesquiet)을 쓰세요.
- 맥과 짝지은 기기에서는 익스텐션이 뜨지 않아서 이 훅도 돌지 않아요. 그 기기에서 설정 → 플러그인의 "이 기기에서도 켜기"를 켠 익스텐션은 예외예요.

::: details 액션별 자세한 규칙
- `composer.submit`: 그 sid 의 입력칸이 이 창에 있을 때만 보내요. 없으면 `{sent: false, reason: 'no-composer'}` 예요. `text` 가 없으면 입력칸의 글을 보내고, 첨부는 입력칸에 붙은 것이에요. 실패 이유는 `empty`(비었음), `sending`(이미 보내는 중), `duplicate`(10초 안에 같은 글), `upload`(영상·파일 올리기 실패)예요. 보내지면 입력칸·첨부·초안을 비워요. 처리기가 정하는 동안 입력칸은 보내는 중(버튼 꺼짐)이에요.
- `message.send`: `kind` 는 글이 `:` 로 시작하면 `command` 예요. 기본 구현은 `POST /api/sessions/<sid>/say` 예요. 대기 말풍선은 모든 `before` 뒤 실제로 보내는 글로 그려요.
- `permission.answer`: `option` 은 늘 채워요. Esc 는 `{n: 'esc', label: 'Esc', kind: 'deny'}`, 확정은 `{n: 'enter', label: '확정', kind: 'other'}` 예요. 페이지가 모르는 카드면 `known: false` 예요.
- `session.create`: 서버 오류(폴더가 없음 등)는 그대로 reject 해요.
- `session.close`: 확인 창은 액션을 내기 전에 물어요. `end` 는 `POST …/close`, `remove` 는 `DELETE /api/sessions/<sid>`, `trash` 는 `POST …/trash` 예요.
- `session.open` 의 `from` 은 링크의 `data-from`, 없으면 `link` 예요.
- 버스를 지나지 않는 것: 주소를 알기 전에 빈 창부터 여는 로컬 미리보기, 분할 화면으로의 이동과 분할 칸의 첫 로드, 서비스 워커.
:::

## slot

화면의 정해진 자리 42곳에 항목을 더해요. 아래 표의 여섯은 자기 방식으로 그려지고, 나머지 36곳은 [화면 전체의 slot](#화면-전체의-slot) 에 있어요. `uses.slots` 에 적지 않은 slot 을 쓰면 예외가 나요.

| slot | 어디 | 항목 | 컨텍스트 |
|---|---|---|---|
| `composer.actions` | 입력칸의 버튼 줄 | `{id, order?, render, menu?}` | `{sid, text, attachments, sending, busy, disabled, setText, addAttachment, clear, focus}` |
| `session.menu` | 세션 메뉴(목록과 세션 화면) | `{id, order?, label, icon?, hint?, danger?, sep?, header?, visible?, checked?, enabled?, run?, items?}` | `{sid, session, closed, alive, away, hostConnected, canMoveHost, slackOn, phase, wide, todoBlocked, place: 'page'\|'list'}` |
| `session-list.row.badges` | 세션 목록 행의 배지 | `{id, order?, render}` | `{session}` |
| `settings.section` | 설정 탭의 카드 아래 | `{id, order?, tab?, render}` | `{user, tab}` |
| `app.rail.items` | PC 왼쪽 앱 레일 | `{id, order?, label, icon, hint?, badge?, active?, disabled?, busy?, run}` | `{place: 'rail', route, sid?, wide}` |
| `app.menu.items` | 앱 메뉴(휴대폰 ⋯, `wide` 면 PC 계정 메뉴에도) | 위와 같고 `wide?` | `{place: 'menu', route, sid?, wide}` |

| 함수 | 하는 일 |
|---|---|
| `slots.register(slot, item)` | 항목을 더해요. `order: {before?: id, after?: id}` 로 자리를 잡고, 그 id 가 없으면 끝에 놓아요 |
| `slots.replace(slot, id, orig => item)` | 페이지의 항목이나 더한 항목을 감싸거나 바꿔요. id 는 그대로예요 |
| `slots.hide(slot, id)` | 항목을 숨겨요 |
| `slots.update(slot, id, patch)` | 이 익스텐션이 더한 항목의 필드(배지·상태·라벨 등, `id`·`order` 제외)를 바꾸고 다시 그려요. 남의 항목이나 페이지 항목이면 예외예요 |
| `slots.supported(slot)` | 이 화면에 그 slot 이 있는지예요. 오래된 화면에서는 없을 수 있어서, 등록 전에 확인하고 다른 길로 가요 |
| `slots.useSlotContext()` | 항목의 `render` 안에서 그 slot 의 컨텍스트를 읽는 훅이에요 |

`render` 는 컴포넌트로 그려져서 훅(`useSlotContext`, `data.shared`, `React.useState`)을 써도 돼요. `visible`·`checked`·`enabled`·`run` 은 컨텍스트를 받아요.

::: details slot 의 자세한 규칙
- 항목의 `id` 는 그 slot 안에서 하나여야 하고, 페이지의 id 와 같으면 거절해요.
- **페이지 자기 항목의 id** (`order`·`replace`·`hide` 에 쓸 수 있어요):
  - `composer.actions`: `attach`, `chips`, `mic`, `send`
  - `session-list.row.badges`: `state`, `slack`, `delegated`, `runner`
  - `session.menu`: `split`, `split-add`, `split-full`, `split-leave`, `same-group`, `copy-path`, `screen`, `todos`, `doc`, `place`, `resume`, `rename`, `remove`, `group`, `refresh`, `compact`, `fork`, `lightfork`, `trim-log`, `move-host`, `move-account`, `move-cwd`, `lock`, `favorite`, `rest`, `log`, `end`, `trash`
  - `settings.section`: 없음
  - `app.rail.items`: `logo`, `sidebar`, `new`, `search`(이 둘은 목록을 접었을 때만), `usage`, `report`, `bell`, `settings`, `account`. `sidebar` 와 `usage` 사이의 빈 칸이 위·아래를 갈라요. 아래쪽 도구 줄에 두려면 `order: {before: 'bell'}` 처럼 써요
  - `app.menu.items`: `new`, `new-group`, `view-group`, `view-recent`(이 둘은 휴대폰만), `settings`, `report`, `account`(제목), `logout`
- `app.rail.items`·`app.menu.items` 의 항목은 그림이 아니라 데이터예요. 같은 `id` 를 두 slot 에 더하면 PC 레일과 휴대폰 메뉴에서 같은 동작이 돼요. `badge` 는 0 보다 큰 수(99 넘으면 `99+`), `'dot'`, `'new'` 이고 `null`·`0` 은 없음이에요. `disabled`(글이면 그 이유)나 `busy`(`true` 또는 진행률 0..1)인 동안은 눌리지 않아서 같은 작업이 두 번 돌지 않아요. 바꿀 때는 `slots.update` 를 써요. 메뉴에 배지 있는 항목이 있으면 휴대폰 ⋯ 버튼에 점이 붙어요. `app.menu.items` 항목은 `wide: true` 가 아니면 PC 계정 메뉴에는 나오지 않아요(PC 는 레일에 있으니까요).
- `session.menu` 의 순서는 공개하지 않아요. 구분선은 `{id, sep: true}`, 제목은 `{id, header}` 예요. 하위 메뉴 `items` 는 항목만 받아요. 목록의 스와이프 동작은 slot 이 아니에요.
- `composer.actions`: 화면 너비 480px 미만이면 더한 항목은 첫 하나만 보이고 나머지는 ⋯ 메뉴로 접혀요. 접혔을 때 쓰는 것이 `menu: {label, icon?, enabled?(ctx), run(ctx)}` 예요. 음성 모드일 때는 이 줄이 없어요. `attachments[]` 는 `{kind: 'image'|'video'|'file', name, pct?}` 예요.
- `session-list.row.badges`: 행이 링크라서 누를 수 있는 것은 넣지 않아요. 더한 배지는 둘까지 보이고 나머지는 `+n` 이에요.
- `settings.section`: `tab` 의 기본은 `plugins` 예요. 탭 id 는 `launch`, `prompt`, `accounts`, `device`, `plugins`, `voice`, `admin`, `changes`, `more` 예요.
- `replace` 가 던지면 그 바꾸기만 건너뛰어요. 항목을 그리다 오류가 나면 그 항목만 빠지고 화면은 남아요.
:::

## 화면 전체의 slot

종류마다 같은 규칙으로 그려져요. 항목이 없으면 그 자리는 그려지지 않아요.

| 종류 | 항목 | 그려지는 모양 |
|---|---|---|
| action | `{id, order?, label, icon, hint?, badge?, active?, disabled?, busy?, danger?, visible?(ctx), run(ctx)}` | 아이콘 버튼. 자리마다 정한 수를 넘으면 ⋯ 메뉴로 접혀요 |
| menu | action 과 같아요 | 그 메뉴 끝에 구분선 뒤로 붙어요 |
| section | `{id, order?, render}` | 세로로 쌓여요 |
| badge | `{id, order?, render}` | 둘까지, 그 뒤는 `+n` |
| data | slot 마다 달라요 | 페이지가 읽어서 그려요 |

| slot | 종류 | 자리 | 컨텍스트 |
|---|---|---|---|
| `session-list.toolbar` | action | 목록 검색칸 옆 | `{filter, setFilter, wide}` |
| `session-list.filters` | section | 검색칸 아래 | `{filter, setFilter, wide}` |
| `session-list.empty` | section | 세션이 하나도 없을 때 | `{filter}` |
| `session-group.actions` | action(1) | 그룹 머리 | `{group: {id, name, parent}, sessions}` |
| `session-group.badges` | badge | 그룹 이름 뒤 | 위와 같아요 |
| `session-group.menu` | menu | 그룹 메뉴 | 위와 같아요 |
| `session-list.row.actions` | menu | 행의 우클릭·길게 누름 메뉴(행이 링크라 버튼은 없어요) | `{session}` |
| `session.header.actions` | action(PC 3·폰 1) | 세션 상단 줄 ⋯ 앞 | `{sid, session, wide, pane}` |
| `session.header.badges` | badge | 상단 줄의 상태 옆 | 위와 같아요 |
| `session.banner` | section | 상단 줄 아래 | 위와 같아요 |
| `session.timeline.before` · `after` | section | 대화 앞·끝 | 위와 같아요 |
| `split-pane.actions` | action(2) | 분할 칸 안의 상단 줄 | 위와 같아요(`pane: true`) |
| `session-tabs.actions` | action(2) | 세션 탭 줄 끝 | `{sid, tabs, group}` |
| `session-tab.menu` | menu | 탭 우클릭(더한 것이 있을 때만) | `{session, active, group}` |
| `composer.before` · `status` · `after` | section | 입력칸 위·아래(높이 30vh 까지) | `composer.actions` 와 같아요 |
| `message.metadata` | section | 각 메시지 아래 | `{sid, session, message: {key, seq, at, id?, role, text}}` |
| `message.actions` | action(3) | 각 메시지 아래 | 위와 같아요 |
| `host-list.toolbar` | action | 기기 화면 상단 | `{hosts}` |
| `host-card.actions` · `badges` | action(1) · badge | 기기 줄과 설정 → 기기 카드 | `{host}` |
| `host-detail.section` | section | 기기 상세의 로그 위 | `{host, mine}` |
| `adopt-list.toolbar` | action | 맥의 대화 이어 가기 검색칸 옆 | `{hostId, shown, picked}` |
| `adopt-list.row.actions` | action(1) | 대화 한 줄 | `{hostId, conversation}` |
| `session-create.fields` | section | 새 세션의 시작 버튼 위 | `{draft, values, set(name, value)}` |
| `session-create.summary` | section | 시작 버튼 바로 위 | `{draft, ext}` |
| `file-list.actions` | action | 디스크 관리의 폴더 줄 | `{hostId, path, items}` |
| `file-row.actions` | action(1) | 파일·폴더 한 줄 | `{hostId, file}` |
| `preview.toolbar` | action | HTML 미리보기 줄, 로컬 미리보기 아래 줄 | `{kind: 'html', html}` 또는 `{kind: 'server', sid, url}` |
| `app.banner` | section | 모든 화면 맨 위 | `{route}` |
| `app.status.items` | action(칩) | 모든 화면 맨 위의 작업 줄. `busy` 면 도는 표시와 %, `tone: 'ok'·'bad'` | `{route}` |
| `notification.items` | data `{id, title, text?, tone?, at?, run?, onClose?}` | 알림 시트 맨 위, 종 숫자에 더해요 | — |
| `settings.tabs` | data `{id, label, icon?, render}` | 설정 탭 줄 끝, `/settings/x/<익스텐션>/<id>` | `{user, tab}` |
| `app.routes` | data `{id, title, render}` | `/x/<익스텐션>/<id>` 의 전용 화면(제목·뒤로 포함) | `{ext, page}` |

::: details 화면 전체 slot 의 자세한 규칙
- host 는 `{id, name, kind, online, runners}`, 대화는 `{conv, cwd, runner, title, exists}`, 파일은 `{path, name, kind, size}` 만 받아요. 키·인증·서명·승인 화면은 어느 slot 에도 넘기지 않고 slot 으로 바꿀 수 없어요.
- 컨텍스트는 읽기 전용이에요. 무언가를 하려면 지금처럼 `actions.dispatch` 나 이 익스텐션의 서버 라우트를 써요.
- 등록할 때 종류에 맞는 칸이 없으면 바로 예외가 나요. `settings.tabs`·`app.routes` 의 id 는 주소에 들어가서 영소문자·숫자·`-` 32자까지예요.
- `visible`·`run`·`render`·`validate` 가 던지면 그 항목만 빠지고 운영 탭에 그 익스텐션의 오류로 남아요.
- `session-create.fields`: 익스텐션마다 자기 `values` 만 보고 `set` 해요. `validate(values, draft)` 가 글을 돌려주면 시작하지 않고 그 글을 보여 줘요. 값은 `session.create` 훅의 `args.ext[<id>]` 로만 오고 서버로는 가지 않아서, 화면의 권한 모드·계정 같은 칸을 덮어쓸 수 없어요.
- `notification.items` 의 × 는 이 화면에서 숨기고 `onClose` 를 불러요. 같은 id 라도 글이 바뀌면 다시 보여요.
:::

| 함수 | 하는 일 |
|---|---|
| `bridge.version` | `{extensionApi, slots: [{name, kind}]}`: 이 화면이 주는 것 |
| `bridge.list` | `filter()`, `setFilter(text)`, `useFilter()`: 세션 목록의 검색어 |
| `bridge.routes` | `href(id)`, `open(id)`: 이 익스텐션의 전용 화면(`app.routes`) |

## 짝지은 기기

맥과 짝지은 기기(서명 필수 맥)에서는 동의한 익스텐션도 기본으로 뜨지 않아요. 익스텐션 코드가 같은 화면에서 돌아 그 기기의 서명 키를 쓸 수 있기 때문이에요. 그 기기에서 설정 → 플러그인의 **이 기기에서도 켜기**를 켜고 경고를 확인하면 떠요. 이 선택은 그 브라우저에만, 익스텐션 해시에 묶여 저장돼서 서버가 켤 수 없고, 파일이 바뀌면 다시 꺼져요. 직접 만들었거나 코드를 확인한 익스텐션에만 쓰세요.

## 단축키

```ts
bridge.commands.register({
  id: 'ask',                       // 페이지가 앞에 "<익스텐션 id>." 를 붙여요
  title: '? 붙여 보내기',
  keys: 'Alt+Shift+Q',
  when: (ctx) => ctx.focused === 'composer',
  run: (ctx) => { /* … */ },
})
```

키는 `Mod+K`, `Alt+Shift+H` 처럼 적어요. `Mod` 는 맥에서 ⌘, 다른 곳에서 Ctrl 이에요. 글자·숫자는 키의 자리(code)로 읽어서 한글 자판에서도 같아요. 이미 있는 id 나 키는 거절해요. 한글 조합 중에는 실행하지 않아요.

`ctx` 는 `{route, sid?, focused: 'composer'|'timeline'|'other', composer?}` 예요. 입력칸에 포커스가 있으면 `composer` 에 `composer.actions` 의 컨텍스트가 와요.

::: details 페이지가 이미 잡은 키
| id | 키 |
|---|---|
| `tab-1` … `tab-9` | `Alt+1` … `Alt+9` |
| `session-prev`, `session-next` | `Alt+ArrowUp`, `Alt+ArrowDown` |
| `search` | `Meta+K`, `Ctrl+K` |
| `sidebar` | `Meta+\`, `Ctrl+\` |
| `voice` | `Alt+Space`, `Ctrl+Shift+Space` |
| `send` | `Enter`, `Meta+Enter`, `Ctrl+Enter` |
| `stop` | `Escape` |
:::

## 화면 도구 `ui`

| 함수 | 돌려주는 것 | 설명 |
|---|---|---|
| `sheet.open(Comp, props?, {title?, wide?})` | `{closed, close}` | 시트를 열어요. `Comp` 는 `props` 와 `close` 를 받아요. 뒤로가기(iOS 뒤로 스와이프 포함)가 페이지를 떠나지 않고 이 시트만 닫아요 |
| `confirm(title, body?)` | `Promise<boolean>` | 확인 창이에요 |
| `prompt(title, {text?, value?, placeholder?, ok?, multiline?})` | `Promise<string \| null>` | 글을 받아요. 취소면 `null` 이에요 |
| `choose(title, options, text?)` | `Promise<string \| null>` | 고르기예요. 항목은 `{value, label, hint?, danger?}` 예요 |
| `menu(items, at, title?)` | — | `at`(요소나 `{x, y}`)에 메뉴를 띄워요. 항목은 `{id?, label, icon?, danger?, checked?, disabled?, hint?, onSelect?, items?}`, 구분선 `'sep'`, 제목 `{header}` 예요 |
| `toast(text, {tone?: 'ok'\|'bad'})` | — | 토스트를 띄워요 |

비동기 액션의 처리기 안에서 확인 창이나 시트를 기다릴 때는 `ctx.waitUser(…)` 로 감싸세요. 그래야 시간 제한에 걸리지 않아요.

## kit

`bridge.kit` 은 페이지와 같은 모양의 부품이에요. 아이콘 이름은 `kit.ICONS` 중 하나예요.

| 부품 | 주요 props |
|---|---|
| `Button` | `tone`(`primary`·`plain`·`danger`·`ghost`·`soft`), `size`(`sm`·`md`·`lg`), `icon`, `busy`, `block` |
| `IconButton` | `icon`, `label`, `active`, `keepFocus`(눌러도 입력칸 포커스와 휴대폰 키보드를 둬요) |
| `Icon` | `name`, `className` |
| `ICONS` | 아이콘 이름 목록 |
| `Badge` | `tone`(`grey`·`blue`·`green`·`red`·`amber`·`violet`), `dot` |
| `Chip` | `icon`, `onClick`, `active`, `tone`(`warn`·`ok`·`bad`·`merged`), `title` |
| `Field` | `label`, `hint` |
| `TextField` | `value`, `onChange`, `label`, `placeholder`, `rows`(여러 줄), `autoFocus`, `disabled`, `onEnter` |
| `Row` | `left`, `title`, `sub`, `right`, `onClick`, `onContextMenu`, `active`, `href`, `className`, `chevron` |
| `SectionHeader` | `title`, `right`, `onClick`, `folded` |
| `Segmented` | `value`, `options: {value, label}[]`, `onChange`, `label` |
| `Sheet` | `open`, `onClose`, `title`, `footer`, `wide`, `className` |
| `Spinner` | `size` |
| `Switch` | `checked`, `onChange`, `label`, `disabled` |
| `Collapse` | `open`, `className` |
| `Empty` | `icon`, `title`, `action` |
| `Help` | `children` |
| `Markdown` | `text`, `className`. 답처럼 그리고, 펜스 블록은 `renderer.block` 을 지나요 |

## 저장 `storage`

| 저장소 | 누가 읽나 | 누가 쓰나 | 함수 |
|---|---|---|---|
| `storage.user` | 그 사람 | 그 사람 | `get`, `set`, `delete`, `list` |
| `storage.server` | 모두 | 관리자만 | `get`, `set`, `delete`, `list` |
| `storage.secrets` | 화면은 못 읽어요 | 그 사람 | `set`, `delete`, `has` |

- `get(key)` → `{value, version} | null`
- `set(key, value, {ifVersion?})` → `{version}`. `ifVersion` 을 주면 값이 아직 그 버전일 때만 써요. 다르면 던져요(409). 다른 창이 그새 저장한 것을 덮어쓰지 않게 할 때 써요.
- `delete(key)`, `list(prefix?)` → 키 목록
- 비밀값은 페이지로 돌아오지 않아요. 라우트 `headers` 의 `${user.KEY}` 로만 쓰여요.

::: details 저장 한도와 경로
- 키는 `^[A-Za-z0-9._-]{1,64}$` 이고, 점만으로 된 키는 400 이에요.
- 값은 JSON 으로 64KB, 익스텐션마다 저장소별 1MB 까지예요(413).
- 서버 경로: `/api/ext/<id>/storage/user|server/<키>`(GET·PUT `{value, ifVersion?}`·DELETE), 키 목록 `GET /api/ext/<id>/storage/<scope>?prefix=`. 비밀값은 `PUT·DELETE /api/ext/<id>/secrets/<키>`, `GET /api/ext/<id>/secrets` 는 이름만 줘요(키 하나 읽기는 405).
- 사람의 값은 `u/<uid>/ext/<id>/data.json`, 비밀값은 `u/<uid>/ext/<id>/secrets.json`(0600), 서버의 값은 `<BRIDGE_DATA>/ext-data/<id>/data.json` 이에요. 계정을 지우면 사람의 값과 비밀값도 지워져요.
- 모든 `/api/ext*` 요청은 헤더 `X-Bridge-Ext: 1` 이 있어야 하고(`bridge` 가 붙여요), 사람·익스텐션마다 분당 120 번까지예요(429). 동의하지 않은 사람은 403 이에요.
:::

## 서버 라우트 `api`

브라우저는 바깥으로 직접 연결하지 못해요. `extension.yaml` 의 `server.routes` 에 적은 upstream 으로 서버가 서명해서 중계해요.

| 함수 | 설명 |
|---|---|
| `api.json(path, body?)` | 본문이 없으면 GET, 있으면 POST 예요. 오류 상태면 던져요 |
| `api.fetch(path, init?)` | `fetch` 와 같은 모양이에요. `Response` 를 돌려줘요 |
| `api.blobUrl(path)` | 라우트의 그림을 `blob:` 주소로 줘요. `<img>` 에 넣어요 |

`path` 는 `/api/ext/<id>/call/` 뒤에 붙어요. 예를 들어 라우트 `path: /docs/`, `upstream: https://api.example.com/v1/` 이면 `api.json('/docs/pages')` 는 `https://api.example.com/v1/pages` 로 가요. 서명과 한도는 [익스텐션 두기와 만들기](/guide/operate/extensions#바깥-서비스와-잇기)의 "바깥 서비스와 잇기" 를 보세요.

## 이벤트

`actions.after` 에 이벤트 이름을 주면 서버가 SSE 로 보내는 이벤트를 받아요. 이벤트 이름도 `uses.actions` 에 적어야 해요.

| 이름 | 언제 | 본문(공통 필드 외) |
|---|---|---|
| `session.done` | 세션의 턴이 끝났을 때 | `session`, `quiet?: true` |
| `decision.waiting` | 결정 카드가 답을 기다릴 때 | `session`, `card: {id, kind, title, tool?, options}` |
| `decision.answered` | 결정에 답했을 때 | `session`, `card: {id}`, `n`, `via: 'card'\|'message'\|'auto'\|'terminal'`, `by` |

공통 필드는 `id`(다시 보내도 같아요), `name`, `at`, `user: {uid, login}`, `url`(세션 화면이나 사이트)이에요. `session` 은 `{id, host, hostId, cwd, title}` 예요.

```ts
bridge.actions.after('session.done', (ev) => {
  void bridge.events.claim(ev.id).then((first) => first && bridge.ui.toast('턴이 끝났어요'))
}, { primaryOnly: true })
```

- `{primaryOnly: true}`: 이 브라우저의 여러 탭 중 대표 페이지에서만 불러요.
- `events.claim(ev.id)`: 이 사람의 브라우저가 여럿(휴대폰과 맥)이어도 처음 부른 곳만 `true` 예요. 둘을 함께 쓰면 사람마다 한 번만 알려요.

::: details 이벤트의 자세한 규칙
- 서버는 동의한 익스텐션이 하나라도 있는 사람의 열린 페이지에 `{t: "ext-event", event}` 를 보내요. 본문은 서버 이벤트와 같아요. [알림 웹훅과 훅](/guide/operate/hooks#서버가-내는-이벤트)의 "서버가 내는 이벤트" 를 보세요.
- `session.done` 의 `quiet: true` 는 턴이 조용한 답으로 끝났다는 뜻이에요. 이때 알림 웹훅(`notify`)에는 보내지 않아요. [조용한 답](#조용한-답-messagesquiet)을 보세요.
- `POST /api/ext/<id>/events/<eventId>/claim`: 그 사람에게 보낸 이벤트가 아니면 404, (익스텐션, 이벤트)마다 처음만 200, 이후 409 예요. `events.claim` 은 200 이면 `true`, 그 밖에는 `false` 예요.
- 서버는 보낸 이벤트와 claim 을 사람마다 10분·1000개 기억해요. 무중단 교체 때는 넘기지만, 서버를 완전히 다시 시작하면 잊어요.
- 대표 페이지는 최상위 창이 Web Lock `bridge-ext-primary` 를 잡아 정해요. 분할 칸은 대표가 되지 않아요. 대표가 닫히면 기다리던 다음 창이 이어받아요.
:::

## 언어 파일 `i18n`

익스텐션 폴더 맨 위의 `locales/<언어>.json` 을 읽어요. entry 가 `dist/index.js` 처럼 하위 폴더에 있어도 `locales/` 는 폴더 맨 위예요.

```json [locales/ko.json]
{ "ask": "? 붙여 보내기", "save": "저장" }
```

- `bridge.i18n.locale` 은 브라우저 언어의 앞부분(`ko`, `en` 등)이에요.
- 그 언어의 파일이 없으면 `ko.json` 을 읽어요.
- `t(key)` 는 그 키의 글을, 없으면 키를 그대로 돌려줘요.

## `extension.yaml`

```yaml [extension.yaml]
id: example
name: 예시 익스텐션
version: 0.1.0
extensionApi: 1
entry: ./dist/index.js
uses:
  actions: [composer.submit, renderer.block, session.done]
  slots: [composer.actions, session.menu, session-list.row.badges, settings.section, app.rail.items, app.menu.items, session.header.actions, app.routes]
messages:
  quiet:
    - suffix: "[조용히]"
      label: 할 일 없음
```

| 키 | 필수 | 설명 |
|---|---|---|
| `id` | 예 | `^[a-z][a-z0-9-]{1,31}$`(소문자로 시작, 2~32자). `errors` 는 쓸 수 없어요 |
| `name` | 예 | 화면에 보일 이름이에요 |
| `version` | 예 | 익스텐션의 버전 글이에요 |
| `extensionApi` | 예 | 요구하는 API 버전(정수)이에요. 이 서버는 `1` 까지예요 |
| `entry` | 예 | 폴더 안의 `.js`·`.mjs` 파일이에요 |
| `uses.actions` | 아니오 | 쓰는 액션과 이벤트 이름이에요. [액션 목록](#액션-목록)의 열한 개(`message.render` 포함)와 이벤트 셋 `session.done`·`decision.waiting`·`decision.answered` 중에서 골라요 |
| `uses.slots` | 아니오 | 쓰는 slot 이름이에요 |
| `messages.quiet[]` | 아니오 | `{suffix, label?}`. 끝이 `suffix` 인 답을 조용한 답으로 봐요. `suffix` 는 1~40자, 한 줄, 앞뒤 공백·제어 문자·`⟦`·`⟧` 없이요. `label` 은 40자까지예요. 익스텐션마다 5개까지예요. [조용한 답](#조용한-답-messagesquiet)을 보세요 |
| `server.routes[]` | 아니오 | `{path, upstream, signingSecret, headers?}`. 서버가 중계하는 라우트예요 |
| `server.hooks` | 아니오 | `<액션·이벤트>.after: [webhook…]`. 동의한 사람의 이벤트만 가요 |

모르는 키가 있으면 그 익스텐션은 불러오지 않아요. `${이름}` 은 `bridge.yaml` 의 그 익스텐션 `env` 에 적은 이름만 읽어요.

::: details server.routes 와 server.hooks 의 규칙
- `path` 는 `/` 로 시작하고 끝나요(예: `/docs/`). 라우트끼리 겹칠 수 없어요.
- `upstream` 은 `http(s)://호스트/경로` 모양이에요. 사용자 정보·쿼리·조각은 안 돼요.
- `signingSecret` 은 16자 이상이에요.
- `headers` 에 `X-Bridge-*`·`Cookie`·`Host` 같은 헤더는 쓸 수 없어요. 값의 `${user.KEY}` 는 요청 때 그 사람의 비밀값이에요.
- `server.hooks` 의 이름은 서버 훅의 액션·이벤트 이름에 `.after` 를 붙인 것만 돼요. 종류는 `webhook` 만이에요. `before` 와 `exec` 는 `bridge.yaml` 의 `hooks` 에서만 써요.
:::

## 조용한 답 `messages.quiet`

`extension.yaml` 에 끝 글자를 적으면, 그 글자로 끝난 Claude 의 답을 **조용한 답**으로 봐요. 예를 들어 예약 작업이 할 일 없이 끝나 답 끝에 `[조용히]` 를 쓴 경우예요. 화면 훅 `message.render` 는 화면만 바꾸지만, 이 규칙은 알림까지 막아요.

```yaml [extension.yaml]
messages:
  quiet:
    - suffix: "[조용히]"
      label: 할 일 없음      # 접힌 줄에 보일 말(선택, 40자)
```

- 정규식이 아니라 **끝 글자**예요. 글 끝의 공백·탭·줄바꿈을 지운 뒤 `suffix` 로 끝나는지 봐요. 규칙이 여럿이면 `bridge.yaml` 순서로 보고 첫 것을 써요.
- 대상은 Claude 의 답 글뿐이에요. 사람 말, 결정 카드, 도구, 알림 줄, API 가 답 대신 쓴 오류는 대상이 아니에요.

**조용한 답이면 이렇게 돼요.**

| 건너뛰는 것 | 그대로인 것 |
|---|---|
| 화면에서 한 줄로 접어요(펼치기로 열어요) | 웹 푸시·APNs: 원래 답마다 보내지 않아요 |
| 세션 목록의 "새 답" 점 | 맡긴 세션의 답 이어받기(delegate follow) |
| 알림 웹훅(`notify`)의 `session.done` | `bridge.yaml` 훅과 익스텐션 훅: `quiet: true` 를 달아 보내요 |
| Slack 스레드 글 | |

::: details 턴 규칙과 동의
- **판정 단위는 턴의 마지막 답이에요.** 조용한 답이 오면 같은 턴의 앞선 글("확인해 볼게요")도 새 답 점을 띄우지 않아요.
- 같은 턴에 경고, 결정 카드, 알림 줄이 있으면 그 턴은 조용하지 않아요. 표지 하나로 경고를 묻을 수 없게 하려는 것이에요. API 오류 답은 조용한 답이 되지 않아요.
- **그 사람이 직접 동의했을 때만** 써요. 동의 글에 "답을 접어요: 끝이 `"[조용히]"` 인 Claude 의 답은 …" 이 보여요. 규칙을 고치면 해시가 바뀌어 다시 물어요. `extensionConsent: false` 인 서버에서는 규칙을 쓰지 않아요.
- 동의를 거두면 예전에 접힌 답도 펼쳐 보여요(알림은 이미 지나갔어요).
:::

::: details 봉인한 세션
서버는 봉인된 답의 글을 못 봐요. 그래서 봉인하는 맥에서는 익스텐션 규칙을 쓰지 않아요. 맥에서 사람이 직접 정한 끝 글자만 써요.

```sh [맥의 터미널]
node ~/.claude-bridge/agent.mjs trust quiet add "[조용히]"
node ~/.claude-bridge/agent.mjs trust quiet rm "[조용히]"
node ~/.claude-bridge/agent.mjs trust quiet     # 목록
```

5개까지예요. 이 규칙으로 접은 답은 표지가 `mac` 이에요. 서버에는 "그 맥 주인이 정한 끝으로 끝났다" 는 한 가지만 알려져요.
:::

::: details 폴링, 로컬 화면, 한계
- 폴링은 SSE 와 같은 메시지를 받아서 `quiet` 도 같이 와요. 로컬 화면(127.0.0.1)은 터미널 화면과 목록만 보여서 대상이 아니에요.
- 표지는 답의 맨 끝에 써요. 서버는 선택지·할 일 블록을 뗀 글로, 봉인한 맥은 원래 글로 판정해요. 40,000자로 잘린 답은 끝 표지가 없어져요.
- 한 턴의 앞선 중간 글은 올 때 바로 Slack 스레드에 올라가요. 끝에서 조용하다고 판정돼도 되돌리지 않아요.
- 맥의 `agent.json` 훅의 `session.done` 에는 `quiet` 이 없어요.
- 화면 훅만으로 접은 답은 알림을 막지 못해요.
:::

## 버전 규칙 `extensionApi`

- `extensionApi` 는 이 사이트의 판 번호(1.371 같은)와 따로 가는 정수예요. 규칙의 원문은 저장소의 명세(`docs/SPEC.md`)의 "익스텐션 공개 API" 절이에요. 지금 서버와 페이지는 `1` 이에요.
- 더 높은 값을 적은 익스텐션은 서버가 불러오지 않고 이유를 남겨요. 페이지도 모르는 값이면 불러오지 않아요.
- 같은 `extensionApi` 안에서는 **더하기만** 해요(새 액션·slot·필드·선택 인자).
- 이름, 뜻, 인자나 결과의 모양을 바꾸거나 빼면 `extensionApi` 를 올려요. `bridge.React` 의 메이저 버전이 바뀌어도 올려요.
- 빼려는 것은 한 판(서버 판) 동안 운영 탭의 "익스텐션" 카드에 경고를 낸 뒤, 다음 `extensionApi` 에서 빼요. 지금 그렇게 표시한 것은 없어요.

::: details 서버 API 전체
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/ext/<id>/<hash>/<파일>` | 익스텐션 파일이에요. 로그인(401), 지금 해시(404), 그 해시에 동의(403)여야 해요 |
| GET | `/api/ext` | `[{id, name, version, entry, hash, extensionApi, uses, routes, hooks, storesData, consented, quiet, quietAgreed, loadError?, errors?}]`. `quiet` 은 규칙 목록, `quietAgreed` 는 이 사람이 그 규칙에 직접 동의했는지예요. `/api/me` 의 `extensions` 도 같아요 |
| POST·DELETE | `/api/ext/<id>/consent` | 동의 `{hash}`(지금 해시가 아니면 409)와 거두기예요 |
| GET·PUT·DELETE | `/api/ext/<id>/storage/<scope>/<키>` | [저장](#저장-storage)이에요 |
| PUT·DELETE·GET | `/api/ext/<id>/secrets[/<키>]` | 비밀값이에요 |
| GET·POST | `/api/ext/<id>/call/<경로>` | [서버 라우트](#서버-라우트-api)예요 |
| POST | `/api/ext/<id>/events/<eventId>/claim` | [이벤트](#이벤트)의 claim 이에요 |
| POST | `/api/ext/errors` | 화면 오류 보고 `{id, message, stack}`. 사람마다 분당 10, 메시지·스택 1KB 까지예요 |

SSE 로는 `{t: "ext-event", event}` 와 `{t: "ext-reload"}`(개발 모드에서 파일이 바뀌었을 때)가 와요.
:::
