# 익스텐션

운영자가 서버에 둔 폴더의 스크립트를 조작 페이지가 불러, 페이지가 하는 일(액션)에 끼어들고 정해진 자리(slot)에 항목을 더한다. 공개 API 는 `extensionApi: 1` 이고 [docs/SPEC.md](../docs/SPEC.md) 의 "익스텐션 공개 API" 절과 [agent-bridge-ext.d.ts](agent-bridge-ext.d.ts) 가 그 전부다. 거기 없는 것(DOM 구조, CSS 클래스, 전역 변수)은 언제든 바뀐다.

- `agent-bridge-ext.d.ts` `bridge` 객체·액션·이벤트·slot 의 타입. 페이지가 자기 `bridge` 객체를 이 타입과 맞대 타입 검사한다(`ui/src/lib/ext-api-check.ts`).
- `example/` 예시 익스텐션. API 의 각 부분을 한 번씩 쓴다: 입력칸의 "? 붙여 보내기" 버튼과 ⌥⇧Q, 세션 메뉴의 "메모"(시트, 사용자 저장), 메모가 있는 세션 행의 배지, 설정 → 플러그인의 스위치, 턴이 끝날 때 한 번만 뜨는 알림(`session.done`, claim), ` ```checklist ` 블록 그리기, 메모 패널(`session.panel`)과 그 패널을 여는 위 막대 버튼·세션 진입(`bridge.panels`), 패널의 "맥에 남기기"(로컬 어댑터 `example/adapter`).

## 서버에 두기

`bridge.yaml`:

```yaml
extensions:
  - path: ./extensions/example        # bridge.yaml 이 있는 폴더 기준
    env: [EXAMPLE_SIGNING]               # 이 익스텐션의 extension.yaml 이 ${…} 로 읽어도 되는 환경변수
extensionConsent: true                # 기본. 사람마다 해시에 동의해야 그 사람의 페이지가 불러온다
```

- 서버는 시작할 때 폴더를 메모리로 읽는다(5MB 까지, `node_modules` 와 `.` 으로 시작하는 이름은 읽지 않는다). 고치면 서버를 다시 시작한다. `BRIDGE_EXT_DEV=1` 이면 2초마다 다시 읽고 열린 페이지를 새로 고친다.
- `/ext/<id>/<hash>/` 로 내주는 것은 `.js`·`.mjs`·`.css`·`.json`·`.png`·`.jpg`·`.webp`·`.woff2` 뿐이다. 이 폴더의 `src/` 는 내주지 않고 `package.json`·`tsconfig.json` 은 내준다. 비밀값을 폴더에 두지 않는다.
- 동의하면 그 사람의 권한으로 맥에서 명령을 실행할 수 있다. 운영자가 읽은 코드만 둔다.
- 문제가 있으면 주소에 `?noext=1` 을 붙여 익스텐션 없이 연다(`?noext=0` 으로 푼다). 불러오지 못한 이유와 화면 오류는 설정 → 운영의 "익스텐션" 카드에 있다.

## 만들기

`import 'react'` 같은 bare import 는 쓸 수 없다(CSP 가 인라인 스크립트를 막아 import map 이 없다). 페이지의 `bridge.React` 를 쓰고, 폴더 안 다른 파일은 상대 경로로 부른다. 예시는 classic JSX 를 TypeScript 로 빌드한다(`example/src/jsx.ts` 의 `h`·`Fragment` 가 `bridge.React` 로 그린다).

```sh
cd extensions/example
corepack yarn install
corepack yarn build          # src/ → dist/
```

`dist/` 는 저장소에 들어 있고, `test/unit/ext-example.test.mjs` 가 `src/` 를 빌드한 결과와 같은지 본다. 자기 익스텐션을 만들 때는 `example/` 을 복사하고 `extension.yaml` 의 `id`·`name`·`uses` 를 바꾼다. `uses` 에 없는 액션·slot 을 쓰면 페이지가 거절한다.

```ts
import type { Bridge } from '../../agent-bridge-ext'

export default function setup(bridge: Bridge) {
  bridge.actions.before('composer.submit', (a) => ({ ...a, text: a.text?.trim() }))
  bridge.slots.register('settings.section', { id: 'hello', render: () => bridge.React.createElement('p', null, `안녕, ${bridge.user.login}`) })
}
```

## 세션 옆 패널 (`session.panel`)

대화 옆에 익스텐션 화면을 둔다(REQ-F-892). 세션 위 막대에 버튼이 생기고(패널이 여럿이면 버튼 하나에 메뉴), 누르면 열고 닫는다.

- 화면 폭이 960 px 이상이면 대화 오른쪽 도크, 좁으면(휴대폰, 좁은 분할 칸) 시트로 연다. 분할 화면은 칸마다 따로다.
- 사람이 왼쪽 가장자리를 끌어(키보드는 ←·→) 폭을 260~720 px(화면의 60% 까지)로 바꾼다. 열린 패널과 패널마다의 폭은 이 기기에 남는다.
- 지원 여부는 `bridge.slots.supported('session.panel')` 로 본다. `extension.yaml` 의 `uses.slots` 에 `session.panel` 을 적는다.
- 열린 패널은 세션마다 따로 기억한다(REQ-F-894). 사람이 고른 마지막 패널은 아직 아무도 고르지 않은 세션의 기본값이다.

```ts
if (bridge.slots.supported('session.panel'))
  bridge.slots.register('session.panel', {
    id: 'thread',
    label: '스레드',
    icon: 'doc',
    width: 380, // 처음 폭, 사람이 바꾼 폭이 이긴다
    visible: (ctx) => !ctx.session.closed,
    render: () => {
      const ctx = bridge.slots.useSlotContext<PanelCtx>() // {sid, session, wide, pane, place: 'dock'|'sheet', close()}
      return <Thread sid={ctx.sid} />
    },
  })
```

### 코드로 열고 닫기 (`bridge.panels`)

자기 익스텐션이 등록한 패널을 한 세션에서 열고 닫는다(REQ-F-894). 분할 화면에서는 그 세션의 칸만 바뀌고, 휴대폰에서는 같은 호출이 시트로 연다. 지원 여부는 `bridge.version.features?.includes('panels')`(예전 페이지에는 `features` 가 없다).

```ts
const has = (f: string) => (bridge.version.features ?? []).includes(f)
// 링크를 처음 등록했을 때: 명시적으로 연다(사람이 닫았던 것도 다시 연다)
bridge.panels.open({ sid, id: 'thread' })
// 세션에 들어올 때: 사람이 그 세션에서 닫았으면 열지 않는다
bridge.actions.after('session.open', (a) => linked(a.sid) && bridge.panels.open({ sid: a.sid, id: 'thread' }, { unlessClosed: true }))
bridge.panels.close({ sid, id: 'thread' })            // 그 패널이 열려 있을 때만 닫는다(다른 익스텐션의 패널은 두고)
bridge.panels.state({ sid, id: 'thread' })            // {open, other, closedByUser}
bridge.panels.useState({ sid, id: 'thread' })         // 훅
bridge.panels.subscribe(() => …)                      // 어느 세션이든 바뀌면
```

- 자동으로 여는 곳(세션 진입, 다시 그리기)에는 항상 `unlessClosed: true` 를 쓴다. 그러면 사람이 닫은 패널은 익스텐션이 `unlessClosed` 없이 다시 열 때까지 닫혀 있다.
- `uses.slots` 에 `session.panel` 이 있어야 한다. 아직 등록하지 않은 id 도 열어 둘 수 있고, 등록되고 `visible` 이면 보인다.

## 로컬 어댑터 (`bridge.adapters`)

세션이 도는 맥에서 맥의 주인이 설치한 프로그램(어댑터)의 작업을 부른다(REQ-F-893). 길은 익스텐션 → bridge 서버 → 그 세션의 맥 에이전트(맥이 서버로 연 연결, 맥에 포트를 열지 않음) → 어댑터다. 본체는 작업 이름과 JSON 만 전하고, 인증정보·CLI 실행·캐시는 어댑터의 일이다.

`extension.yaml` 에 부를 작업과 읽기·쓰기를 적는다. 동의 화면에 보이고, 해시에 들어간다.

```yaml
adapters:
  thread.read: read
  thread.refresh: read
  thread.reply: write
```

맥의 주인이 `~/.claude-bridge/adapters/<이름>/adapter.json` 을 둔다(서명된 에이전트 파일은 고치지 않는다, 고치면 다음 호출부터 바로 쓴다).

```json
{ "ext": "slack", "command": ["node", "adapter.mjs"], "actions": { "thread.read": "read", "thread.refresh": "read", "thread.reply": "write" }, "timeoutMs": 30000 }
```

- 부를 때마다 그 폴더에서 `command` 를 한 번 실행한다(`./` 로 시작하면 폴더 안 파일). stdin 은 `{action, access, input, requestId, session: {id, cwd}, ext}`, stdout 의 JSON 이 결과다. 0 이 아닌 종료는 실패(stderr 끝 줄이 이유). 환경 변수 `BRIDGE_ADAPTER_ACTION`·`BRIDGE_ADAPTER_ACCESS`·`BRIDGE_REQUEST_ID` 도 받는다.
- 폴더나 `adapter.json` 을 다른 사용자가 고칠 수 있으면 쓰지 않는다. 한도: 입력 64KB, 결과 512KB, 시간 `timeoutMs`(기본 30 초, 최대 120 초).
- 서버는 세션이 부르는 사람의 것인지, 작업이 `extension.yaml` 에 있는지, 읽기·쓰기가 맞는지를 보고, 맥은 `adapter.json` 의 `ext`·`actions`·읽기·쓰기가 맞는지 본다. 쓰기는 사람·익스텐션마다 분당 30 번.
- 맥이 신뢰 모드 `enforce` 면 쓸 수 없다(입력·결과가 봉인되지 않는다). 예시: [example/adapter](example/adapter).

```ts
const r = await bridge.adapters.call(sid, 'thread.reply', { text }, { requestId })  // requestId 는 bridge.adapters.requestId()
switch (r.state) {
  case 'done': show(r.result); break
  case 'unknown': keep(requestId); break           // 보냈지만 답이 없음: 실행됐을 수 있다
  case 'offline': case 'refused': case 'unsupported': case 'failed': showError(r.error)
}
// 다시 연결된 뒤, 새로 고친 뒤: 같은 requestId 로 묻는다
const s = await bridge.adapters.status(sid, requestId) // done(result) · failed · unknown · running · none(맥에 닿지 않음: 다시 보내도 된다)
await bridge.adapters.list(sid)                       // 이 맥에 있는 작업 {actions, problems}
```

- `call` 은 결과를 throw 하지 않고 `state` 로 돌려준다(`extension.yaml` 에 없는 작업만 throw). 페이지·서버는 다시 보내지 않는다.
- 맥은 쓰기의 `requestId` 를 실행하기 전에 디스크에 적고, 같은 id 는 두 번 실행하지 않는다: 동시에 다시 와도, 나중에 와도, 에이전트가 다시 시작돼도 처음 결과(`replayed: true`)나 `unknown` 을 준다(24시간, 최근 300개). 그래서 `unknown` 뒤에는 **같은 requestId 로** `status` 를 묻거나 다시 보내야 중복 전송이 없다. 새 id 로 다시 보내는 것은 사람이 "다시 보내기"를 눌렀을 때만 한다.
- 쓰기의 결과가 16KB 를 넘으면 다시 줄 때 `result: null, resultDropped: true` 다.

## AI 의 결과를 익스텐션으로 받기

전용 통로는 아직 없다. 지금 되는 길:

- 답 안의 전용 코드블록(예: ```` ```slack-draft ````)을 `bridge.actions.around('renderer.block', …)` 로 받아 그리거나 패널로 넘긴다. 쓰는 중인 블록은 `closed: false` 라 다 쓴 블록만 골라 쓸 수 있다.
- 턴이 끝날 때 `session.done` 을 `after` 로 받고, 열린 페이지가 여럿이어도 `bridge.events.claim(event)` 로 한 번만 처리한다. 화면이 닫혀 있을 때의 결과는 `server.hooks` 의 `session.done.after` webhook 으로 자기 서버가 받아 둔다.

맥에서 무언가 돌려야 하면 위의 로컬 어댑터를, 바깥 서비스는 아래의 서버 라우트(자기 서버)를 쓴다.

## 서버 라우트와 훅

브라우저는 바깥으로 연결할 수 없으므로 바깥 데이터는 서버가 중계한다. `extension.yaml`:

```yaml
server:
  routes:
    - path: /docs/                              # bridge.api.json('/docs/pages') → upstream + pages
      upstream: https://api.example.com/v1/
      signingSecret: ${EXAMPLE_SIGNING}            # 16자 이상. 서버가 X-Bridge-User·Signature 등을 붙여 서명
      headers:
        Authorization: "Bearer ${user.apiToken}"   # 그 사람이 bridge.storage.secrets.set('apiToken', …) 로 둔 값
  hooks:
    session.done.after:                         # 동의한 사람의 이벤트만 간다
      - type: webhook
        url: https://hooks.example.com/done
        secret: ${NOTIFY_SECRET}
```

`${NAME}` 은 `bridge.yaml` 의 그 익스텐션 `env` 에 적은 이름만 읽는다. 다른 이름이 하나라도 있으면(주석 안이어도) 그 익스텐션을 불러오지 않는다.
