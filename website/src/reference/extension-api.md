---
description: 익스텐션이 받는 bridge 객체(액션, slot, 단축키, 시트, kit, 저장, 서버 라우트, 이벤트, i18n)와 extension.yaml 의 키, extensionApi 버전 규칙을 정리한 표예요.
---

# 익스텐션 API

이 페이지는 익스텐션이 기대어도 되는 공개 API(`extensionApi: 1`)를 정리해요. 익스텐션을 서버에 두고 켜는 방법은 [익스텐션 두기와 만들기](/guide/operate/extensions)를 보세요.

이 페이지는 [1.371 판](/changelog) 기준이에요.

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
| `before(name, fn, opts?)` | `(args, ctx) => 새 args \| {cancel: 이유} \| void` | 인자를 바꾸거나 멈춰요. `renderer.block` 에는 못 붙여요 |
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
- **동기 액션**(`session.open`, `link.open`, `clipboard.copy`, `renderer.block`, `notify.show`): 누르는 동안 끝나야 해요(iOS 는 누른 동안에만 새 창·클립보드 쓰기를 허락해요). Promise 를 돌려주는 `before` 는 무시하고 기록해요. 처리기 오류는 기록하고 다음으로 넘어가요.
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
| `notify.show` | `{text, sid?}` | 없음 | 서버 알림 토스트 |

`renderer.block` 의 기본 구현은 코드 상자예요. `around` 에서 그릴 React 요소를 돌려주거나, 내 블록이 아니면 `next(args)` 를 돌려줘요. `closed` 는 펜스가 닫혔는지예요(답을 쓰는 중이면 `false`).

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

화면의 정해진 자리 넷에 항목을 더해요. `uses.slots` 에 적지 않은 slot 을 쓰면 예외가 나요.

| slot | 어디 | 항목 | 컨텍스트 |
|---|---|---|---|
| `composer.actions` | 입력칸의 버튼 줄 | `{id, order?, render, menu?}` | `{sid, text, attachments, sending, busy, disabled, setText, addAttachment, clear, focus}` |
| `session.menu` | 세션 메뉴(목록과 세션 화면) | `{id, order?, label, icon?, hint?, danger?, sep?, header?, visible?, checked?, enabled?, run?, items?}` | `{sid, session, closed, alive, away, hostConnected, canMoveHost, slackOn, phase, wide, todoBlocked, place: 'page'\|'list'}` |
| `session-list.row.badges` | 세션 목록 행의 배지 | `{id, order?, render}` | `{session}` |
| `settings.section` | 설정 탭의 카드 아래 | `{id, order?, tab?, render}` | `{user, tab}` |

| 함수 | 하는 일 |
|---|---|
| `slots.register(slot, item)` | 항목을 더해요. `order: {before?: id, after?: id}` 로 자리를 잡고, 그 id 가 없으면 끝에 놓아요 |
| `slots.replace(slot, id, orig => item)` | 페이지의 항목이나 더한 항목을 감싸거나 바꿔요. id 는 그대로예요 |
| `slots.hide(slot, id)` | 항목을 숨겨요 |
| `slots.useSlotContext()` | 항목의 `render` 안에서 그 slot 의 컨텍스트를 읽는 훅이에요 |

`render` 는 컴포넌트로 그려져서 훅(`useSlotContext`, `data.shared`, `React.useState`)을 써도 돼요. `visible`·`checked`·`enabled`·`run` 은 컨텍스트를 받아요.

::: details slot 의 자세한 규칙
- 항목의 `id` 는 그 slot 안에서 하나여야 하고, 페이지의 id 와 같으면 거절해요.
- **페이지 자기 항목의 id** (`order`·`replace`·`hide` 에 쓸 수 있어요):
  - `composer.actions`: `attach`, `chips`, `mic`, `send`
  - `session-list.row.badges`: `state`, `slack`, `delegated`
  - `session.menu`: `split`, `split-add`, `split-full`, `split-leave`, `same-group`, `copy-path`, `screen`, `todos`, `doc`, `place`, `resume`, `rename`, `remove`, `group`, `refresh`, `compact`, `fork`, `lightfork`, `trim-log`, `move-host`, `move-account`, `move-cwd`, `lock`, `favorite`, `rest`, `log`, `end`, `trash`
  - `settings.section`: 없음
- `session.menu` 의 순서는 공개하지 않아요. 구분선은 `{id, sep: true}`, 제목은 `{id, header}` 예요. 하위 메뉴 `items` 는 항목만 받아요. 목록의 스와이프 동작은 slot 이 아니에요.
- `composer.actions`: 화면 너비 480px 미만이면 더한 항목은 첫 하나만 보이고 나머지는 ⋯ 메뉴로 접혀요. 접혔을 때 쓰는 것이 `menu: {label, icon?, enabled?(ctx), run(ctx)}` 예요. 음성 모드일 때는 이 줄이 없어요. `attachments[]` 는 `{kind: 'image'|'video'|'file', name, pct?}` 예요.
- `session-list.row.badges`: 행이 링크라서 누를 수 있는 것은 넣지 않아요. 더한 배지는 둘까지 보이고 나머지는 `+n` 이에요.
- `settings.section`: `tab` 의 기본은 `plugins` 예요. 탭 id 는 `launch`, `prompt`, `accounts`, `device`, `plugins`, `voice`, `admin`, `changes`, `more` 예요.
- `replace` 가 던지면 그 바꾸기만 건너뛰어요. 항목을 그리다 오류가 나면 그 항목만 빠지고 화면은 남아요.
:::

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
| `session.done` | 세션의 턴이 끝났을 때 | `session` |
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
  slots: [composer.actions, session.menu, session-list.row.badges, settings.section]
```

| 키 | 필수 | 설명 |
|---|---|---|
| `id` | 예 | `^[a-z][a-z0-9-]{1,31}$`(소문자로 시작, 2~32자). `errors` 는 쓸 수 없어요 |
| `name` | 예 | 화면에 보일 이름이에요 |
| `version` | 예 | 익스텐션의 버전 글이에요 |
| `extensionApi` | 예 | 요구하는 API 버전(정수)이에요. 이 서버는 `1` 까지예요 |
| `entry` | 예 | 폴더 안의 `.js`·`.mjs` 파일이에요 |
| `uses.actions` | 아니오 | 쓰는 액션과 이벤트 이름이에요. [액션 목록](#액션-목록)의 열 개와 `session.done`·`decision.waiting`·`decision.answered` 중에서 골라요 |
| `uses.slots` | 아니오 | 쓰는 slot 이름이에요 |
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
| GET | `/api/ext` | `[{id, name, version, entry, hash, extensionApi, uses, routes, hooks, storesData, consented, loadError?, errors?}]`. `/api/me` 의 `extensions` 도 같아요 |
| POST·DELETE | `/api/ext/<id>/consent` | 동의 `{hash}`(지금 해시가 아니면 409)와 거두기예요 |
| GET·PUT·DELETE | `/api/ext/<id>/storage/<scope>/<키>` | [저장](#저장-storage)이에요 |
| PUT·DELETE·GET | `/api/ext/<id>/secrets[/<키>]` | 비밀값이에요 |
| GET·POST | `/api/ext/<id>/call/<경로>` | [서버 라우트](#서버-라우트-api)예요 |
| POST | `/api/ext/<id>/events/<eventId>/claim` | [이벤트](#이벤트)의 claim 이에요 |
| POST | `/api/ext/errors` | 화면 오류 보고 `{id, message, stack}`. 사람마다 분당 10, 메시지·스택 1KB 까지예요 |

SSE 로는 `{t: "ext-event", event}` 와 `{t: "ext-reload"}`(개발 모드에서 파일이 바뀌었을 때)가 와요.
:::
