---
description: 서버가 내는 이벤트를 웹훅으로 받고, 액션 앞뒤에 서버 훅을 걸고, 맥에서 세션 시작·닫기·턴 끝에 명령을 돌리는 방법을 다뤄요.
---

# 알림 웹훅과 훅

이 가이드를 마치면 세션의 턴이 끝날 때 내 주소로 알림을 받고, 위험한 액션을 서버에서 막고, 맥에서 세션이 열릴 때 내 스크립트를 돌릴 수 있어요. 서버 설정 파일 자체는 [서버 설정 파일](/guide/operate/config)을, 바깥으로 무엇이 나가는지는 [보안 모델](/guide/concepts/security#웹훅과-훅이-보내는-것)을 보세요.

## 세 가지 길 중에 고르기

| 길 | 어디에 적나 | 무엇을 하나 | 이럴 때 |
|---|---|---|---|
| 알림 웹훅 `notify` | 서버 `bridge.yaml` | 이벤트를 내 주소로 POST, 실패하면 세 번 다시 | 다른 시스템에 소식을 꼭 전하고 싶을 때 |
| 서버 훅 `hooks` (`.after`, `.before`) | 서버 `bridge.yaml` | 웹훅이나 서버 안 명령을 불러요. `before` 는 막거나 몇 필드를 바꿀 수 있어요 | 액션 전에 검사하거나, 서버 안에서 스크립트를 돌릴 때 |
| 에이전트 훅 `hooks` | 맥 `agent.json` | 그 맥에서 내 명령을 돌려요 | 맥의 파일·앱을 건드리고 싶을 때 |

다시 보내기가 필요하면 `notify` 를, 막아야 하면 `before` 훅을, 맥에서 해야 하면 에이전트 훅을 고르세요. `after` 훅은 한 번만 보내고 다시 보내지 않아요.

## 시작하기 전에

- 서버 훅과 알림 웹훅은 서버의 `bridge.yaml` 에 적어요. 기본 위치는 데이터 폴더의 `bridge.yaml` 이에요(Docker 면 `/data/bridge.yaml`). 서버는 이 파일을 시작할 때 한 번 읽으므로, 고친 뒤 서버를 다시 시작하세요.
- 맥의 에이전트 훅은 그 맥의 `~/.claude-bridge/agent.json` 에 적어요.
- 받는 쪽 주소는 `https://` 를 권해요. 주소와 비밀값은 `${NOTIFY_URL}` 처럼 환경 변수로 넣을 수 있어요.

## 서버가 내는 이벤트

**이벤트**는 서버에서 일어난 일을 JSON 하나로 적은 것이에요. 두 종류가 있어요.

| 종류 | 이름 | 언제 |
|---|---|---|
| 일어난 일 | `session.done` | 세션의 턴이 끝났을 때(일하는 중에서 쉬는 중으로) |
| | `decision.waiting` | 맥이 권한·질문 같은 확인 창(카드)을 열었을 때 |
| | `decision.answered` | 열려 있던 카드가 닫혔을 때 |
| 사람이 한 액션 | `login`, `session.create`, `message.send` 등 14개 | 서버를 거쳐 그 일이 실제로 일어났을 때 |

이벤트는 받는 곳이 하나라도 있을 때만 만들어져요. 받는 곳이 없으면 서버는 지금과 똑같이 움직여요.

::: details 이벤트 전체 목록
| 이름 | 더 붙는 필드 | 설명 |
|---|---|---|
| `login` | `provider` | 로그인 쿠키를 새로 줄 때마다(GitHub·Apple·데모·QR·헤더 로그인 등) |
| `session.create` | `mode`, `from` | 세션을 만들 때. `from` 은 `new`·`adopt`·`fork`·`lightfork`·`delegate`·`report` |
| `session.close` | `kind` | `end`(종료)·`remove`(목록에서 지우기)·`trash`(휴지통) |
| `message.send` | `text`, `images`, `videos` | Claude 에 글을 넣을 때. `images`·`videos` 는 개수예요 |
| `message.btw` | `text` | 끼어들기 질문 |
| `message.retract` | `do`, `ids?` | `retract`(거두기)·`dropheld`(붙잡은 글 버리기) |
| `session.key` | `keys` | 키 입력 |
| `session.do` | `do`, `when?`, `port?` | `sendnow`·`esc`·`refresh`·`compact`·`trimlog`·`killserver` |
| `session.setting` | `kind`, `value` | 세션 설정 하나 |
| `session.settings` | `changed` | `autoAllow`·`allowAll`·`autoPush`·`resting`·`favorite`·`title` 중 바뀐 것 |
| `session.move` | `do`, `cwd?`, `hostId?` | `cwd`(폴더 바꾸기)·`move`(맥 옮기기)·`resume`(이어 열기) |
| `session.lock` | `do` | `lock`·`unlock`·`lockclear` |
| `session.sudo` | `command` 또는 `host`·`do` | `:sudo` 명령, 또는 맥 단위 관리자 권한 열기·닫기(`open`·`off`) |
| `permission.answer` | `card`, `option` | 이 서버로 카드에 답했을 때. 고른 선택지의 `n`·`label`·`kind` |
| `session.done` | — | 턴 끝 |
| `decision.waiting` | `card` | `{id, kind, title, tool?, options:[{n, label, kind}]}`. `tool` 은 도구 이름이에요 |
| `decision.answered` | `card`, `n`, `via`, `by` | `via` 는 `card`(이 서버로 답함)·`message`(글을 보내서)·`auto`(자동 허용)·`terminal`(맥에서 직접) |
:::

::: details 본문의 모양
모든 이벤트는 같은 틀이에요.

```json
{
  "id": "3f9c…(32자 hex)",
  "name": "session.done",
  "at": 1767225600000,
  "user": { "uid": "…", "login": "octocat" },
  "session": { "id": "…", "host": "iMac", "hostId": "…", "cwd": "/Users/me/app", "title": "배포" },
  "url": "https://bridge.example.com/s/…"
}
```

- `id` 는 이벤트마다 새로 만들고, 다시 보낼 때도 같아요. 받는 쪽은 이것으로 중복을 거르세요.
- `at` 은 밀리초예요.
- `session` 은 세션 이벤트에만 있어요. `url` 은 세션 이벤트면 그 세션 주소, 아니면 서버 주소예요.
- 액션에는 `by` 가 붙어요. 요청이 들어온 길이에요: `page`(로그인한 화면), `service`(서비스 API), `slack`(Slack 플러그인), `delegate`(맥의 맡기기), `system`(서버 스스로 한 일).
- 서버 훅으로 갈 때는 `hook` 필드(예 `message.send.after`)가 더 붙어요. 알림 웹훅 본문에는 없어요.

`session.done`, `decision.*` 은 맥이 보고한 값으로 만들어요. 감사 기록으로 믿을 수 있는 것은 사람이 서버로 한 액션이에요.
:::

## 예 1. 턴이 끝나면 내 웹훅으로 받기

`bridge.yaml` 에 적으세요.

```yaml [bridge.yaml]
notify:
  - type: webhook
    url: ${NOTIFY_URL}          # 예: https://hooks.example.com/bridge
    secret: ${NOTIFY_SECRET}    # 16자 이상
    events: [session.done, decision.waiting]
```

서버를 다시 시작하면, 세션의 턴이 끝날 때와 확인 창이 열릴 때 `https://hooks.example.com/bridge` 로 이벤트가 와요. 받는 쪽은 서명을 확인한 뒤 2xx 로 답하세요. 서명 확인 코드는 아래 **받는 쪽에서 서명 확인하기** 를 펼쳐 보세요.

::: details notify 의 키와 규칙
| 키 | 필요 | 뜻 |
|---|---|---|
| `type` | 예 | `webhook` 만 받아요 |
| `url` | 예 | `http(s)://호스트/경로`. `user:password@` 와 `#` 는 안 돼요 |
| `secret` | 예 | 서명에 쓰는 비밀값. 16자 이상 |
| `events` | 예 | 받을 이벤트 이름 목록. 위 전체 목록의 이름만 받아요 |

- 수신처는 10개까지예요.
- 모르는 키, 이 서버가 내지 않는 이벤트 이름, 짧은 secret 이 있으면 서버가 뜨지 않아요. 오류 문구에는 주소의 출처만 나와요.
- 한 번 보낼 때 10초까지 기다려요. 2xx 가 아니거나 답이 없으면 1초, 10초, 60초 뒤 다시 보내요. 그래도 안 되면 버리고 서버 로그에 출처와 마지막 이유만 한 줄 남겨요.
- 다시 보낼 때 본문(`id` 포함)은 같고 서명은 새로 만들어요.
- 보낸 기록은 남기지 않아요.
:::

::: details 받는 쪽에서 서명 확인하기
서버가 보내는 모든 웹훅(notify, 서버 훅의 webhook)에는 이 헤더가 붙어요.

| 헤더 | 값 |
|---|---|
| `X-Bridge-Timestamp` | 보낸 시각(초) |
| `X-Bridge-Nonce` | 무작위 16 byte hex |
| `X-Bridge-User` | 사용자 uid(없으면 빈 값) |
| `X-Bridge-Login` | 로그인 이름(없으면 빈 값) |
| `X-Bridge-Signature` | `v1=<hex>` |

`<hex>` 는 HMAC-SHA256(secret, 정규 문자열)이에요. 정규 문자열은 다음 여덟 줄을 줄바꿈(`\n`)으로 이은 것이에요: `v1`, timestamp, nonce, 메서드(`POST`), 경로와 쿼리(설정한 주소 그대로, 경로가 없으면 `/`), user, login, 본문의 SHA-256 hex.

받는 쪽은 같은 문자열을 만들어 상수 시간으로 비교하고, 5분 넘게 차이 나는 timestamp 와 5분 안에 본 nonce 를 거절하고, 본문의 `id` 로 중복을 거르세요.

```js [receiver.mjs]
import crypto from 'node:crypto'
import http from 'node:http'

const SECRET = process.env.BRIDGE_WEBHOOK_SECRET
const seen = new Map() // nonce → 받은 시각(ms)

http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const h = (k) => req.headers[k] ?? ''
    const ts = h('x-bridge-timestamp')
    const nonce = h('x-bridge-nonce')
    const canon = ['v1', ts, nonce, req.method, req.url, h('x-bridge-user'), h('x-bridge-login'),
      crypto.createHash('sha256').update(body).digest('hex')].join('\n')
    const want = Buffer.from('v1=' + crypto.createHmac('sha256', SECRET).update(canon).digest('hex'))
    const got = Buffer.from(h('x-bridge-signature'))
    const now = Date.now()
    for (const [n, at] of seen) if (now - at > 300_000) seen.delete(n)
    const ok = got.length === want.length && crypto.timingSafeEqual(got, want)
      && Math.abs(now / 1000 - Number(ts)) <= 300 && !seen.has(nonce)
    if (!ok) return res.writeHead(401).end()
    seen.set(nonce, now)
    const ev = JSON.parse(body)
    // ev.id 로 중복을 거르세요. 다시 보낸 이벤트는 id 가 같아요.
    console.log(ev.name, ev.session?.title ?? '')
    res.writeHead(204).end()
  })
}).listen(8080)
```

앞단 프록시가 경로를 바꿔 넘기면 `req.url` 이 서버가 서명한 경로와 달라져요. 그때는 `bridge.yaml` 에 적은 주소의 경로와 쿼리를 쓰세요.
:::

## 예 2. 위험한 액션 전에 검사하기

`before` 훅은 액션이 일어나기 직전에 물어요. 답이 `allow: false` 면 그 요청은 막혀요. 여기서는 서버 안의 명령으로 `:sudo`(관리자 권한)를 늘 막아 볼게요.

1. 서버 호스트에 명령을 만들고 실행 권한을 주세요. 데이터 폴더 **밖**에 두어야 해요.

   ```sh [/srv/bridge-hooks/no-sudo]
   #!/bin/sh
   cat > /dev/null
   echo '{"allow": false, "reason": "이 서버에서는 관리자 권한을 쓸 수 없어요"}'
   ```

2. 컨테이너에 읽기 전용으로 붙이세요. 예: `docker run … -v /srv/bridge-hooks:/hooks:ro …`
3. `bridge.yaml` 에 적고 서버를 다시 시작하세요.

   ```yaml [bridge.yaml]
   hooks:
     session.sudo.before:
       - type: exec
         run: /hooks/no-sudo
         onError: deny    # 명령이 실패해도 막아요
   ```

이제 세션에서 `:sudo` 를 쓰거나 맥 단위 관리자 권한을 열면, 그 요청이 403 과 함께 `reason` 문구로 막혀요.

::: tip 웹훅으로 묻기
정책 서버가 따로 있으면 `type: webhook`, `url`, `secret` 으로 적으세요. 서명은 예 1 과 같고, 서버는 2xx 응답의 본문을 답으로 읽어요.
:::

::: warning 훅은 가드레일이에요
맥 주인은 터미널이나 맥의 설정으로 서버를 거치지 않을 수 있어요. 훅은 서버를 거치는 요청만 보고, 정책을 강제하는 경계가 아니에요.
:::

::: details hooks 의 키와 이름
**이름**은 `<액션>.before`, `<액션>.after`, `<일어난 일>.after` 예요. 액션은 위 전체 목록의 14개, 일어난 일은 `session.done`·`decision.waiting`·`decision.answered` 셋이에요. 그 밖의 이름이 있으면 서버가 뜨지 않아요. 이름마다 5개까지 적을 수 있어요.

| 키 | webhook | exec | 뜻 |
|---|---|---|---|
| `type` | `webhook` | `exec` | 종류 |
| `url` | 필요 | 쓰지 않음 | notify 의 `url` 과 같은 검사 |
| `secret` | 필요(16자 이상) | 쓰지 않음 | 서명 비밀값 |
| `run` | 쓰지 않음 | 필요 | 명령의 절대 경로. 셸을 거치지 않고 인자 없이 실행해요 |
| `timeoutMs` | 선택 | 선택 | 1~10000, 기본 3000 |
| `onError` | `before` 만 | `before` 만 | `allow`(기본) 또는 `deny` |

**exec 명령이 받는 것**

- stdin 으로 이벤트 본문(JSON)을 받아요.
- 환경 변수는 `PATH`(표준 경로), `HOME`(임시 폴더), `BRIDGE_VERSION` 만 받아요. 서버의 비밀 환경 변수는 넘어가지 않아요.
- 명령은 서버 컨테이너 안에서, 서버가 실행되는 사용자로 돌아요.
- 명령이 데이터 폴더 안에 있으면(링크를 풀어 비교해요) 서버가 뜨지 않아요. 서버는 시작할 때 데이터 폴더의 파일을 0600 으로 바꿔 실행 권한이 사라져요.
- 서버 사용자로 실행할 수 없는 명령은 시작할 때 로그에 남기고, 부를 때마다 실패로 다뤄요.
- 출력은 64 KB 까지만 읽어요.

**after 훅**

- 액션이 실제로 일어난 뒤 훅마다 한 번 보내요. 한 요청 안에서 같은 이름·같은 대상은 한 번만 내요.
- `timeoutMs` 안에 2xx(webhook) 또는 종료 코드 0(exec)이 아니면 실패예요. 실패는 로그 한 줄이고 다시 보내지 않아요.

**before 훅의 답**

답은 JSON 객체예요. webhook 은 2xx 응답의 본문, exec 는 종료 코드 0 의 표준 출력이에요.

```json
{ "allow": true, "reason": "…", "patch": { "text": "…" } }
```

- `allow: false` 면 403 이에요. 오류 문구는 `reason`(300자까지)이고, 없으면 `이 서버의 규칙으로 막혔어요`.
- `patch` 는 글 값만 받고, 그 액션에 있는 필드만 바꿀 수 있어요: `text`(`message.send`), `title`(`session.create`, `session.settings`), `prompt`·`mode`(`session.create`, `mode` 는 `features.permissionModes` 안). `message.send` 의 `text` 를 비우면 400 이에요.
- 훅이 여럿이면 적은 차례로 묻고, 처음 거절에서 멈춰요. `patch` 는 차례로 합치고 뒤의 것이 이겨요.
- 시간 안에 답이 없거나, 2xx·종료 0 이 아니거나, 답을 읽을 수 없으면 실패예요. `onError: allow` 면 그 훅을 건너뛰고, `deny` 면 403 `확인 서버에 묻지 못해 막았어요`. 기본이 `allow` 인 것은 정책 서버가 죽어도 글을 보내고 카드에 답할 수 있게 하려는 거예요.

**before 를 묻지 않는 때**

- 서버 스스로 하는 일(`by: system`): 맥의 보고, 타이머, 맡긴 세션의 답 전달 등.
- 관리자(`BRIDGE_ADMIN_LOGINS`·`auth.admins`)의 `login`. 정책 서버가 죽어도 관리자는 들어올 수 있어요.

**기다리는 동안**

before 훅에 묻는 동안 서버는 다른 요청을 처리해요. 답을 받은 뒤 대상이 그대로인지 다시 봐요. 세션이 바뀌었거나, 다른 카드가 열렸거나, 맥이 끊겼으면 409 `확인을 기다리는 사이 세션이 바뀌었어요. 다시 해 주세요`. before 훅이 없으면 기다리지 않아요.

카드에 답할 때 서버가 아는 다른 카드가 열려 있으면, 훅이 없어도 409 `다른 질문이 열려 있어요. 화면을 새로 고친 뒤 답해 주세요` 예요.
:::

## 예 3. 맥에서 스크립트 돌리기

세션이 이 맥에서 열리거나, 닫히거나, 턴이 끝날 때 내 명령을 돌릴 수 있어요.

1. 맥에 실행할 수 있는 명령을 만드세요. 예: `~/bin/on-done`

   ```sh [~/bin/on-done]
   #!/bin/sh
   # stdin: {"name":"session.done","at":…,"session":{"id":"…","cwd":"/Users/me/app","host":"iMac"}}
   cat > /dev/null
   osascript -e 'display notification "턴이 끝났어요" with title "Agent Bridge"'
   ```

   `chmod +x ~/bin/on-done` 로 실행 권한을 주세요.

2. `~/.claude-bridge/agent.json` 에 `hooks` 를 더하세요.

   ```json [agent.json]
   {
     "hooks": {
       "session.done.after": [{ "run": "~/bin/on-done" }]
     }
   }
   ```

3. 에이전트를 다시 시작하세요. 에이전트는 `agent.json` 을 시작할 때 읽어요.
4. 그 맥의 기기 화면에서 **점검** 줄의 **훅** 이 초록이면 성공이에요. 잘못된 항목이 있으면 **훅** 이 노랗게 되고, 화면 위 경고에 이유가 나와요.

::: details 에이전트 훅의 규칙
| 이름 | 언제 |
|---|---|
| `session.create.after` | 이 맥에서 세션을 새로 열었을 때(새 세션·복제·가벼운 복제·가져오기) |
| `session.close.after` | 세션을 닫았을 때 |
| `session.done.after` | 턴이 끝났을 때 |

- `run` 은 절대 경로나 `~/…` 예요. 셸을 거치지 않고 인자 없이, 홈 폴더에서, 에이전트의 환경 그대로 실행해요.
- stdin 에 `{name, at, session: {id, cwd, host}}` JSON 한 줄을 줘요. `host` 는 이 맥의 hostname 이에요. 서버의 이벤트보다 필드가 적어요.
- 10초 안에 끝나지 않으면 끊어요. 시작 못 함·종료 코드 0 아님·시간 초과는 에이전트 로그에 경고 한 줄이고, 세션에는 영향이 없어요. 표준 출력이 64 KB 를 넘으면 명령을 끊고 실패 경고를 남겨요.
- 다른 맥으로 옮기거나 이어서 연 세션은 새로 연 것이 아니라 `session.create.after` 를 부르지 않아요. claude 가 맥에서 스스로 끝난 것은 닫기가 아니에요.
- 모르는 이름, 모양이 틀린 값, 상대 경로는 건너뛰고 기기 화면 위 **훅** 경고로 보여요. 실행할 수 없는 명령도 경고에 나와요.
- 에이전트는 돌면서 `agent.json` 을 다시 쓸 수 있어요. 고친 뒤에는 바로 다시 시작하고 **훅** 항목으로 확인하세요.
- 에이전트는 원래 브리지 서버 말고는 연결하지 않아요. 맥 주인이 정한 명령은 어디에든 연결할 수 있고, 이것은 그 원칙의 예외예요.
:::

## 문제가 생기면

| 증상 | 해결 |
|---|---|
| 서버가 뜨지 않고 `notify` 나 `hooks` 오류가 나와요 | 오류 문구가 가리키는 줄을 고치세요. 모르는 키·이름, 16자보다 짧은 secret, 데이터 폴더 안의 명령은 시작을 막아요 |
| 웹훅이 오지 않아요 | 서버 로그에서 `notify:` 나 `hooks:` 로 시작하는 줄을 찾으세요. 출처와 실패 이유(`HTTP 500`, `연결 실패`, `시간 초과`)가 나와요 |
| 받는 쪽에서 서명이 맞지 않아요 | 경로와 쿼리가 `bridge.yaml` 에 적은 그대로인지, 본문을 바꾸기 전 원본 바이트로 해시했는지 보세요 |
| before 훅이 있는데 아무것도 막히지 않아요 | 훅이 실패하면 기본으로 건너뛰어요(`onError: allow`). 서버 로그의 `hooks: … 실패` 줄을 보세요 |
| 맥의 훅이 돌지 않아요 | 그 맥의 기기 화면 위 **훅** 경고를 보세요. 에이전트 로그에 `hook` 경고가 남아요 |

## 다음 단계

- [서버 설정 파일](/guide/operate/config): `bridge.yaml` 을 두는 곳과 읽는 순서를 알 수 있어요.
- [bridge.yaml 키](/reference/config): `notify`, `hooks` 와 다른 키를 찾아볼 수 있어요.
- [익스텐션 두기와 만들기](/guide/operate/extensions): 화면과 서버에 기능을 더하는 다른 길이에요.
- [보안 모델](/guide/concepts/security#웹훅과-훅이-보내는-것): 웹훅·훅이 바깥으로 보내는 것과 처리방침의 수신처를 알 수 있어요.
