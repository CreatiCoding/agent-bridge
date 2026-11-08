# 익스텐션

운영자가 서버에 둔 폴더의 스크립트를 조작 페이지가 불러, 페이지가 하는 일(액션)에 끼어들고 정해진 자리(slot)에 항목을 더한다. 공개 API 는 `extensionApi: 1` 이고 [docs/SPEC.md](../docs/SPEC.md) 의 "익스텐션 공개 API" 절과 [agent-bridge-ext.d.ts](agent-bridge-ext.d.ts) 가 그 전부다. 거기 없는 것(DOM 구조, CSS 클래스, 전역 변수)은 언제든 바뀐다.

- `agent-bridge-ext.d.ts` `bridge` 객체·액션·이벤트·slot 의 타입. 페이지가 자기 `bridge` 객체를 이 타입과 맞대 타입 검사한다(`ui/src/lib/ext-api-check.ts`).
- `example/` 예시 익스텐션. API 의 각 부분을 한 번씩 쓴다: 입력칸의 "? 붙여 보내기" 버튼과 ⌥⇧Q, 세션 메뉴의 "메모"(시트, 사용자 저장), 메모가 있는 세션 행의 배지, 설정 → 플러그인의 스위치, 턴이 끝날 때 한 번만 뜨는 알림(`session.done`, claim), ` ```checklist ` 블록 그리기.

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

## AI 의 결과를 익스텐션으로 받기

전용 통로는 아직 없다. 지금 되는 길:

- 답 안의 전용 코드블록(예: ```` ```slack-draft ````)을 `bridge.actions.around('renderer.block', …)` 로 받아 그리거나 패널로 넘긴다. 쓰는 중인 블록은 `closed: false` 라 다 쓴 블록만 골라 쓸 수 있다.
- 턴이 끝날 때 `session.done` 을 `after` 로 받고, 열린 페이지가 여럿이어도 `bridge.events.claim(event)` 로 한 번만 처리한다. 화면이 닫혀 있을 때의 결과는 `server.hooks` 의 `session.done.after` webhook 으로 자기 서버가 받아 둔다.

맥의 파일·명령을 익스텐션이 직접 부르는 길은 없다. 바깥 데이터는 아래의 서버 라우트(자기 서버)로 받는다.

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
