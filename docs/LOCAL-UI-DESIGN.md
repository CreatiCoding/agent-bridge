# 서버가 내려가도 쓰는 로컬 화면 (localUi) 설계

출처: 사용자 요청. 2판: 적대적 검토 지적(옛 Origin 검사 순서, 인증 없는 booted 로 서버가 롤백을 일으킴, 선택·롤백·floor 규칙 불일치, `agent.json` 덮어쓰기(`trustSeal` 포함), L1 완화가 코드에 없음, TRUST-DESIGN 맞추기, 파일 목록 두 곳, OTA 와 업데이트 끔, Linux·포트 넘기기) 반영. 이 문서는 설계와 결정의 이유를 적고, 요구사항·AC 는 `SPEC.md` 의 REQ-F-843~845 / REQ-S-096~098 에 둔다. 화면 파일을 나눠 주는 방식은 Webview Bundle(wvb.dev)의 **기술 방식만** 따랐다(builtin·remote 두 원천, manifest 의 current·previous·staged, sha256 무결성, 서명한 갱신 문서, install 때 다시 확인, rollback). 라이브러리·파일 형식(.wvb 이진 형식)은 쓰지 않고 직접 만들었다.

## 0. 한 줄 요약

웹 서버가 죽거나 닿지 않아도, 맥의 에이전트가 `http://127.0.0.1:<port>/local/` 에서 **관리자 키로 서명된 화면 묶음**을 직접 내주고, 맥 터미널에서 받은 **일회용 링크**로 들어온 브라우저만 그 맥의 세션을 보고(터미널 화면) 입력(글·키·Esc·권한 답)할 수 있다. 화면 묶음은 에이전트에 함께 들어 있고(builtin, 처음부터 오프라인), 서버와 연동 중이면 더 새 서명 묶음을 받아(staged) 확인 뒤 바꾼다(active). 깨지면 직전 것이나 builtin 으로 돌아간다.

## 1. 왜 이 구조인가

- 에이전트는 이미 `127.0.0.1` 에서만 듣고(`server.listen(port,'127.0.0.1')`), 밖으로 연결하지 않는다. 서버가 죽으면 연동 탭(`web/relay.js`)이 끊길 뿐, 세션(zeropty/tmux)은 맥에서 계속 돈다. 그래서 같은 HTTP 서버에 `/local/` 입구만 더하면 된다.
- 화면 코드는 서버가 내려준 것이면 안 된다. 서버가 없을 때 뜰 수 없을 뿐 아니라, 서버를 믿지 않는 맥(TRUST-DESIGN R1)에서 서버가 준 코드는 믿을 수 없다. 그래서 화면 묶음도 에이전트처럼 **관리자 서명**(`~/.claude-bridge-signing/agent-ed25519.pem`, 공개키는 `agent/keys.mjs` 의 `UPDATE_KEYS`)이 맞아야만 쓴다. 덕분에 로컬 화면은 서버가 바꿀 수 없는 코드다(R1 을 이 화면에서는 피한다).

## 2. 화면 묶음 (bundle)

### 2.1 원천(source)

| 원천 | 어디 | 쓰기 | 설명 |
|---|---|---|---|
| builtin | `agent/localbundle.mjs`(에이전트 파일, `AGENT_FILES` 에 들어감) | 읽기 전용 | 에이전트 서명(`agent.sig`)이 덮고, 묶음 자체 서명(DOC·SIG)도 들어 있다. 설치 직후부터 오프라인으로 뜬다 |
| remote | `~/.claude-bridge/localui/remote/` | 에이전트만 | 서버가 연동 중에 보낸 묶음. 서명·해시가 맞아야 staged → install → current |

선택 규칙(wvb 와 같음 + 한 가지 더):
1. remote 에 **current** 가 있고, 그 묶음의 `api` 가 에이전트의 `LOCALUI_API` 와 같고, 확인(§2.4)을 통과하면 remote current 를 쓴다(remote 가 builtin 보다 우선).
2. 단, remote current 의 `seq` 가 builtin 의 `seq` 이하이면(에이전트가 업데이트되어 builtin 이 더 새 것) builtin 을 쓰고 remote current 는 previous 로 내린다. wvb 는 버전을 같음으로만 비교하지만, 여기서는 builtin 이 업데이트로 바뀌므로 더 오래된 remote 가 새 builtin 을 가리지 않게 한다.
3. 그 밖에는 builtin.

### 2.2 묶음 파일 형식 (`cb-bundle` v1)

JSON 한 덩어리(UTF-8). 무결성은 이 바이트 그대로의 SHA-256.

```json
{"format":"cb-bundle","v":1,"name":"localui","api":1,"files":{"index.html":{"type":"text/html; charset=utf-8","data":"<base64>"},"app.js":{...},"app.css":{...}}}
```

- 파일 이름 `^[a-z0-9][a-z0-9._-]{0,63}$`(하위 폴더 없음), 형식은 html·js·css·svg·png·json 중 하나(확장자와 맞아야 함), 파일 32개·합계 2 MB 이하, `index.html` 필수. 하나라도 어기면 확인 실패.
- 원본은 저장소의 `agent/localui/`(index.html·app.js·app.css). `node scripts/sign-agent.mjs` 가 이 폴더로 묶음을 만들고, 바뀌었으면 서명해 `agent/localbundle.mjs` 를 다시 쓴 뒤 에이전트를 서명한다. 원본과 `localbundle.mjs` 가 다르면 `npm test` 가 실패한다.

### 2.3 갱신 문서와 서명

```json
DOC = {"name":"localui","version":"<묶음 sha256 hex 앞 12자>","seq":<정수>,"api":1,"integrity":"sha256:<base64>","size":<바이트>}
SIG = base64(ed25519(관리자 키, "claude-bridge localui v1\n" + DOC 문자열))
```

- 서명은 DOC 의 **정확한 바이트**에 한다(wvb 처럼 파싱 전에 확인). 앞의 `"claude-bridge localui v1\n"` 은 영역 구분: 에이전트 업데이트 서명(`manifestOf`)과 서로 바꿔 쓸 수 없다.
- 키는 에이전트 업데이트와 같은 `UPDATE_KEYS`(둘 중 하나로 맞으면 됨). 서명 키는 이 맥의 `~/.claude-bridge-signing/` 에만 있다.
- `seq` 는 묶음이 바뀌어 다시 서명할 때의 에이전트 서명 순번(늘기만 함). 묶음이 그대로면 DOC·SIG 도 그대로라 `localbundle.mjs` 가 바뀌지 않는다.
- `agent/localbundle.mjs` 형식(서버 Go 가 줄 단위로 읽는다):
  ```js
  export const DOC = "<JSON 문자열 리터럴>"
  export const SIG = "<base64>"
  export const BUNDLE = "<JSON 문자열 리터럴: 묶음 바이트>"
  ```

### 2.4 확인(verify) — 하나라도 틀리면 그 묶음은 절대 쓰지 않는다

1. SIG 가 `UPDATE_KEYS` 중 하나로 `"claude-bridge localui v1\n"+DOC` 에 맞음.
2. DOC 가 JSON 이고 `name=="localui"`, `api==LOCALUI_API`, `seq` 는 안전한 정수, `integrity` 는 `sha256:` 형식.
3. 묶음 바이트의 SHA-256 이 `integrity` 와 같고, 길이가 `size` 와 같고, `version` 이 해시 앞 12자.
4. 묶음 JSON 이 §2.2 규칙을 지킴.

builtin 도 시작할 때 같은 확인을 한다(서명이 안 맞는 builtin = 개발 중 서명 전 → 로컬 화면은 "서명 확인 실패" 안내만 낸다).

### 2.5 맥의 디스크와 manifest (wvb 의 manifest 를 따름)

```
~/.claude-bridge/localui/            0700
  remote/manifest.json               0600  {"manifestVersion":1,"current":v|null,"previous":v|null,"staged":v|null,"floor":<받은 최대 seq>,"bad":[v…],"versions":{v:{"doc","sig","at","confirmed"}}}
  remote/<version>.cbb               0600  묶음 바이트
  tickets.json                       0600  일회용 입장권(§4)
  tokens.json                        0600  로그인 토큰(해시만)
```

- current·previous·staged 만 남기고 나머지 파일은 지운다(prune).

### 2.6 원격 갱신(OTA) 흐름

1. 에이전트의 `hello` 에 `localUi: {on, ota, api, active: {source, version, seq}}` 를 더한다(메타데이터만).
2. 서버는 시작할 때 `agent/localbundle.mjs` 를 읽어 DOC·SIG·BUNDLE 을 들고 있다. hello 를 받으면 `ota` 가 켜져 있고 `DOC.api == localUi.api` 이고 `DOC.seq > active.seq` 이며 `DOC.version != active.version` 이면 그 맥에 `{t:'localui', doc, sig, bundle}` 을 한 번 보낸다(같은 연결에서 같은 버전은 다시 안 보냄). 서버는 서명을 만들 수 없고 전달만 한다.
3. 에이전트 `localui` 명령: `localUi.on`·`ota` 가 꺼져 있거나, 에이전트 업데이트와 같이 `--no-auto-update` 이거나 설치본(`~/.claude-bridge`)이 아닌 곳에서 실행 중이면 받지 않는다(개발 중인 checkout 의 builtin 을 가리지 않게). §2.4 확인 + `seq > max(floor, builtin.seq, active.seq)`(서버가 예전에 서명된 묶음을 다시 보내 되돌리는 것을 막음). 통과하면 **staged** 로 디스크에 쓰고 manifest 에 기록하며, 이때 `floor = seq` 로 올린다(그 묶음이 뒤에 어떻게 되든 그보다 먼저 서명된 것은 다시 받지 않음). 받자마자 4 로 간다.
4. **install**: staged 파일을 디스크에서 다시 읽어 §2.4 를 한 번 더 확인(verify_failed 면 staged 를 지우고 기록) → previous = current, current = staged, staged = null. 결과는 에이전트 로그와 다음 `hello` 의 `active` 로 서버에 보인다.
5. 로드: 화면 요청 때 active 묶음을 메모리에 한 번 읽어 둔다(활성 버전이 바뀌면 다시 읽음). 읽을 때 §2.4 확인.

### 2.7 롤백

- **자동 롤백은 builtin 으로만**: 확인·로드 실패나 페이지가 뜨지 못함으로 되돌릴 때는 previous(더 오래된 원격 묶음)로 가지 않고 builtin 으로 간다. 자동 롤백을 일으킨 쪽(아래)이 예전 서명 묶음을 고르게 두지 않기 위해서다. previous 는 남겨 두어 손으로만 쓴다.
- **확인·로드 실패**: current 를 읽다 확인(§2.4)에 실패하면 그 버전을 `bad` 에 넣고 builtin 으로. `bad` 에 든 버전은 다시 받아도 쓰지 않는다.
- **페이지가 뜨지 못함**: 새 remote current 는 `confirmed:false` 로 시작한다. **사람이 연 페이지**(`Sec-Fetch-Dest: document`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Site: none|same-origin`)로 그 버전의 `index.html` 을 내준 뒤 30 s 안에 페이지가 `POST /local/api/booted` 를 보내지 않으면(스크립트가 깨져 첫 화면을 못 그림) builtin 으로 되돌린다. 이것은 `bad` 에 넣지 않는다(floor 때문에 어차피 다시 깔리지 않음). 다른 페이지가 `<img src=…/local/>`·창 열기로 부른 요청은 시험을 시작하지 않아, 서버가 준 페이지가 좋은 묶음을 되돌리게 할 수 없다. booted 는 지금 시험 중인 버전만 확인한다.
- **손으로**: 맥 터미널 `node ~/.claude-bridge/agent.mjs local rollback` 은 previous 가 확인되고 builtin 보다 새것이면 그것으로, 아니면 builtin 으로. `local reset` 은 remote 를 비우고 builtin.
- 선택 규칙을 한 줄로: 쓰는 묶음은 "확인을 통과하고 bad 가 아닌 remote current 와 builtin 중 seq 가 큰 것".

## 3. 켜고 끄기 (`agent.json`)

```json
"localUi": { "on": true, "ota": true, "sessionHours": 12 }
```

| 칸 | 기본 | 뜻 |
|---|---|---|
| `on` | `true` | `false` 면 `/local/` 전부 404, `localui` 명령 무시 |
| `ota` | `true` | `false` 면 원격 묶음을 받지 않고 builtin(또는 이미 깔린 current)만. `local reset` 과 함께 쓰면 builtin 만 |
| `sessionHours` | `12` | 로그인 토큰 수명(1~168) |

- 칸이 없으면 위 기본값. 바꾸는 법: 맥 터미널 `node ~/.claude-bridge/agent.mjs local on|off|ota on|off|status|open|rollback|reset`, 또는 `agent.json` 을 고친다.
- **서버는 바꾸지 못한다**: 이 칸을 쓰는 명령이 없다. 에이전트는 2 s 마다 디스크의 `localUi` 를 다시 읽고(`trust` 와 같은 방식), 자기가 `agent.json` 을 쓸 때(`writeJson`) 디스크의 `localUi` 를 지킨다. 검토에서 같은 문제가 이미 `trustSeal`(1.394)에 있음을 찾아(시작 때 읽은 config 를 다시 써서 `trust seal on` 이 꺼질 수 있음) 함께 디스크 값을 지키게 고쳤다.
- 기본을 켬으로 둔 이유: 서버가 죽은 뒤에는 원격으로 켤 길이 없고, 입구는 127.0.0.1 + 일회용 입장권이 있어야만 열린다.

## 4. 접근 인증

### 4.1 일회용 링크

- 맥 터미널에서 `node ~/.claude-bridge/agent.mjs local`(= `local open`). macOS 는 기본 브라우저로 열고, Linux 는 `DISPLAY`·`WAYLAND_DISPLAY` 가 있을 때만 `xdg-open`, 화면이 없으면 링크와 함께 `ssh -L <port>:127.0.0.1:<port> <기기>`(같은 포트로) 안내를 출력한다. 폰 등 다른 기기에서는 쓸 수 없다(127.0.0.1 전용).
- 동작: 32 바이트 난수 입장권 t 를 만들어 `localui/tickets.json` 에 **SHA-256 만** 5분 만료로 적고(최대 5개), `http://127.0.0.1:<port>/local/#t=<t>` 를 출력하고 기본 브라우저로 연다(`--no-open` 이면 출력만).
- 입장권은 URL 의 `#` 뒤(fragment)에 있어 HTTP 요청·로그·Referer 에 실리지 않는다. 페이지가 읽고 `history.replaceState` 로 지운 뒤 `POST /local/api/login {ticket}` 로 바꾼다. 에이전트는 해시가 맞고 만료 전이면 그 입장권을 지우고(한 번만) 토큰을 준다.
- 입장권은 파일로만 생긴다: HTTP 입구·서버 명령·연동 키로는 만들 수 없다(짝짓기 확인 파일과 같은 원칙, TRUST-DESIGN §4.2). 맥 터미널(같은 사용자)이 믿는 경계다.

### 4.2 토큰

- 32 바이트 난수, `tokens.json` 에는 SHA-256 과 만료만(최대 10개, 넘치면 오래된 것부터). 에이전트가 다시 켜지거나 업데이트돼도 유지.
- 페이지는 토큰을 `localStorage`(출처 = `http://127.0.0.1:<port>`, 포트까지 포함)에 두고 `Authorization: Bearer` 로 보낸다. **쿠키를 쓰지 않는 이유**: 쿠키는 포트를 가리지 않아, 같은 맥의 다른 127.0.0.1 서버(세션이 띄운 개발 서버 등)에 함께 실려 간다.
- 로그아웃 `POST /local/api/logout` 은 그 토큰을 지운다. `local off` 는 모든 토큰·입장권을 지운다.

### 4.3 입구 규칙 (`/local/` 로 시작하는 요청)

0. 이 분기는 HTTP 처리의 **맨 앞**, 기존 `Origin !== 사이트` 403·OPTIONS·키 검사보다 먼저 온다. `/local/*` 에는 CORS·Private-Network 머리글을 내지 않고 OPTIONS 는 405.
1. `localUi.on` 이 아니면 404.
2. `Host` 가 `127.0.0.1:<port>` 또는 `localhost:<port>` 가 아니면 403 (DNS 리바인딩 막기).
3. `Origin` 이 있으면 `http://127.0.0.1:<port>` 또는 `http://localhost:<port>` 여야 함(아니면 403, `Origin: null` 도 403). CORS 머리글을 내지 않는다(다른 출처는 응답을 읽을 수 없다).
4. 연동 키(`config.key`)·`hookKey` 로는 `/local/api/*` 가 열리지 않는다. 거꾸로 로컬 토큰으로는 `/cmd`·`/events` 등이 열리지 않는다.
5. `GET /local/`·`/local/<파일>`: 묶음 파일(인증 없이, 공개 코드라 비밀이 없음). 머리글: `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`.
6. `/local/api/*`: 모두 `X-Local-UI: 1` 머리글이 있어야 한다(없으면 403, 폼·링크로는 보낼 수 없음). `login`·`booted` 말고는 유효한 Bearer 토큰 필요(아니면 401). 쓰는 요청(POST)은 `Content-Type: application/json`, 본문 64 KB 이하(맞는 토큰을 실은 `send` 만 48 MB: 파일이 base64 로 실린다, 1.517). 토큰을 보기 전에는 64 KB 넘게 읽지 않는다. 로그인 실패는 1분에 10번까지(넘으면 429).

### 4.4 API

| 경로 | 하는 일 |
|---|---|
| `POST /local/api/login {ticket}` | 입장권 → `{token, exp}` |
| `POST /local/api/booted {version}` | 페이지가 첫 화면을 그림(롤백 확인, §2.7) |
| `POST /local/api/logout` | 토큰 지움 |
| `GET /local/api/state` | 맥 이름·hostId·연동 상태(연동 탭 연결 여부)·trust 모드·묶음(source·version)·세션 목록 `{id, name(폴더 이름), cwd, alive, busy, held, card:{id,title,options[{n,label}]}|null}` |
| `GET /local/api/screen?sid=` | 그 세션 터미널 화면(색 SGR 포함 텍스트) |
| `GET /local/api/conv?sid=&limit=` | 대화를 말풍선으로(1.517): 그 맥의 대화 파일에서 최근 60개 `{me, text, at}`. 서버가 쌓는 이벤트 기록이 아니라 대화 파일을 읽으므로 서버가 없어도 된다 |
| `POST /local/api/send {sid, text, files?}` | 글 보내기(16 KB 이하). 웹에서 보낸 것과 같은 길(`inject`): 턴 중이면 붙잡아 둠. `files` 는 `[{name, data:base64}]` 4개·하나 8 MB 까지(1.517): 그림은 앞 바이트로 알아봐 `images/<SHA-1>.<ext>`, 그 밖은 `images/<8자>-<이름>` 에 두고 경로를 글 뒤 줄로 붙인다 |
| `POST /local/api/new {cwd, prompt?}` | 새 세션(1.517): 서버의 new 와 같은 `newSession`(폴더는 만들지 않음). 연동 중이면 hello 를 다시 보내 서버가 받아들인다 |
| `POST /local/api/close {sid}` | 세션 닫기(1.517): 서버의 close 와 같은 `commands.close` |
| `POST /local/api/key {sid, keys[]}` | 키(`KEYS` 목록만, 20개까지) |
| `POST /local/api/esc {sid}` | 멈추기 |
| `POST /local/api/answer {sid, card, n}` | 열린 권한 카드에 답(카드 id 가 지금 열린 것과 같을 때만) |

범위(1.517): 보기·입력, 말풍선 대화, 새 세션·닫기, 파일·그림. 설정·다른 맥·알림·공유는 하지 않는다(웹 화면의 일). 웹 화면(`ui/`) 전체를 맥에서 띄우지 않는 이유: 운영 서버는 Go 바이너리라 맥에 없고, Node 판 `server/server.mjs` 는 시험용이라 최근 기능이 빠져 있으며, 조작 화면의 API·실시간 연결을 에이전트에 다시 짜면 두 구현이 갈라진다. 같은 입구를 넓혀 짝짓기(출처별 키)를 다시 할 일도 없다.

묶음 api 는 2(1.517): 새 경로를 쓰는 화면이 그 경로가 없는 에이전트에 가지 않게 한다(서버는 api 가 같은 맥에만 묶음을 보낸다).

## 5. 서버를 믿지 않는 맥(1.392·1.394)과의 관계

- **명령 확인(trustGate)을 거치지 않는다**: 로컬 화면의 요청은 서버를 거치지 않고, 맥 터미널에서 받은 입장권으로 들어온 사람이 보낸다. TRUST-DESIGN §2.1 이 믿는 범위(맥 앞 사람·`~/.claude-bridge/`)다. 그래서 `enforce` 에서도 된다. 대신 `trust` 가 `off` 가 아니면 로컬 동작마다 `trust/audit.log` 에 `local <동작> <sid>` 를 남긴다.
- **로컬 동작은 명령을 다시 만든다**: 위 API 의 칸만 받아 내부 함수(`inject`·`interrupt`·`answerCard`·키 보내기)를 직접 부른다. sysPrompt·폴더·launch 같은 칸은 받지 않는다.
- **보낸 글은 서명된 글처럼 표시**(`held` 의 `signed:true`): 맥 앞 사람이 보낸 것이라 `enforce` 로 바뀔 때 버려지지 않는다. `signedSaid`(정정 대상)에는 넣지 않는다(정정은 웹 화면의 서명 명령이라 로컬 글과 섞지 않음).
- **봉인과 무관**: 로컬 응답은 맥 밖으로 나가지 않으므로 봉인하지 않는다. 로컬에서 보낸 글은 `trustSaid`(에코 표시)에 넣지 않는다 — 서버가 만든 사람 말풍선이 없으므로 대화 줄은 평소처럼 사람 줄로 보여야 한다(봉인 중이면 그 줄은 봉인된 채 나간다).
- **입구 표(TRUST-DESIGN §5.6)에 `/local/` 을 더한다**: 연동 키·hookKey 로는 열리지 않고 로컬 토큰으로만. §2.4 "held 의 `signed` 는 verify() 가 맞을 때만" 에 "또는 로컬 화면(맥 앞 사람)이 보낸 글" 을 더한다.
- **맥 터미널 전용 파일·명령은 전부 허용 중에도 묻는다**: `guard.mjs bridgeSelfCall` 이 `~/.claude-bridge/(trust|localui)` 를 건드리거나 `agent.mjs local|trust` 를 부르는 도구 호출을 잡고, `riskyCall`(안전한 전부 허용)뿐 아니라 묻지 않는 전부 허용(allowAll)에서도 묻는다. 프롬프트 주입된 세션이 스스로 입장권을 만들어 로그인하는 길을 줄인다(L1).
- **`TRUST_VERSION` 2 → 3**: 새 입구와 `trustSeal` 보존 수정은 trust 경로의 보안 변경이라 올린다(§5.7). 앞으로 `/local/` 입구·토큰 검사를 고칠 때도 올린다.
- **`localui` 명령은 분류표에서 `free`**: `update` 처럼 관리자 서명이 확인 수단이다. 서버가 할 수 있는 것은 이미 서명된 더 새 묶음을 보내거나 안 보내는 것뿐(R3 와 같은 서비스 거부). 예전 서명 묶음으로 되돌리기는 `floor` 로 막는다.
- **연동 탭(서버가 준 코드)이 로컬 화면에 닿지 못함**: 연동 키는 `/local/api` 를 열지 않고, 입장권은 파일로만 생기며, 토큰은 다른 출처(`127.0.0.1:<port>`)의 저장소에 있어 서버 출처의 페이지가 읽을 수 없다.

## 6. 못 막는 것

| # | 남는 위험 | 이유·완화 |
|---|---|---|
| L1 | 같은 사용자로 도는 맥 안 프로그램(프롬프트 주입된 Claude 포함)이 `localui/tickets.json` 에 입장권을 쓰거나 CLI 를 부름, Origin 없이 curl 로 API 를 부름 | TRUST-DESIGN R6 와 같다(맥 자체의 일). 그런 프로그램은 이미 tmux·에이전트 파일을 직접 고칠 수 있다. 완화: Claude 세션의 도구 호출은 `bridgeSelfCall` 로 전부 허용 중에도 묻는다. 글자를 바꿔 쓴 명령(변수·스크립트 안)은 잡지 못한다 |
| L1b | 입장권 링크가 `open` 인자(같은 사용자 `ps`)·브라우저 방문 기록에 잠깐 남음 | 한 번만·5분이라 작다. 페이지가 열리자마자 주소에서 지운다 |
| L2 | 관리자 서명 키가 털림 | 에이전트 업데이트와 같은 위험(REQ-S-067). 키 교체는 `keys.mjs` 예비 키로 |
| L3 | 브라우저 확장이 127.0.0.1 페이지를 읽음 | 브라우저 자체의 일. 범위 밖 |
| L4 | 서버가 OTA 를 보내지 않음 | builtin(또는 이미 깔린 current)으로 그대로 동작 |
| L5 | 연동이 끊긴 동안 웹 화면에 생긴 일(새 세션 등)을 로컬 화면이 다 보여 주지 않음 | 범위를 보기·입력으로 좁혔다 |

## 7. 시험

- 단위(`test/unit/localui.test.mjs`, 16개): 묶음 만들기·확인(서명·해시·형식·api·영역 구분), manifest staged→install→current, floor 로 되돌리기 거부, 확인 실패·로드 실패·booted 시간 초과 롤백, 입장권 한 번만·만료, 토큰 만료, Host·Origin 검사, `localbundle.mjs` 가 원본·서명과 맞음.
- 서버(`server/localui_test.go`): `localbundle.mjs` 읽기·서명 확인, hello 의 seq·api·ota 비교, 에이전트 파일 목록이 `agent.mjs` 와 같은 순서.
- e2e(`test/e2e-localui.mjs`, 37개): 서버 없이 설치본처럼 복사한 에이전트와 실제 Claude Code(haiku) 세션 → `local open` 입장권 → 거부(토큰 없음·연동 키·다른 Host·다른 Origin·머리글 없음·틀린 입장권) → 로그인 → 폴더 신뢰 창을 키로 넘김 → 보낸 글에 Claude 가 답함 → (PLAYWRIGHT 가 있으면) 브라우저에서 입장권이 주소에서 지워지고 터미널이 보이며 폰 폭 가로 스크롤 없음 → 더 새 서명 묶음 설치·booted → 예전 서명·다른 키 묶음 거부 → `local rollback`·`local off`.

## 8. 로컬 전체 화면 (`local --full`, 1.519)

출처: 운영자 요청 "맥에서 웹 화면과 똑같은 화면을 쓰고 싶다". 요구사항은 `SPEC.md` 의 REQ-F-900~902 / REQ-S-103~105.

### 8.1 한 줄 요약

사이트와 **같은 Go 서버**를 맥용(darwin-arm64·darwin-amd64)으로 재현 가능하게 빌드해 관리자 키로 서명해 두면, 맥 터미널의 `node ~/.claude-bridge/agent.mjs local --full on` 이 그 빌드를 받아 확인하고, 에이전트가 사이트 연동을 끊고 그 빌드를 `127.0.0.1:<에이전트 포트+10>` 에 띄워 거기에 연동한다. 브라우저는 터미널의 일회용 링크로만 들어간다. `off` 면 내리고 사이트로 돌아간다.

### 8.2 왜 이 구조인가

- 로컬 화면(§0~§7)을 웹 화면만큼 키우면 화면이 두 벌이 되어 갈라진다(1.518 이 해석기를 한 파일로 만든 이유와 같다). 같은 서버를 맥에서 돌리면 화면·API 가 하나다.
- 서버 코드도 서버가 준 것이면 안 된다(§1). 그래서 빌드는 에이전트 업데이트와 같은 `UPDATE_KEYS` 로 서명된 것만 쓴다. 새 키·새 신뢰 경로는 없다. 접두 `claude-bridge localfull v1\n` 으로 에이전트·로컬 화면 묶음 서명과 섞이지 않는다.
- 바이너리를 git 에 넣지 않는다. 서명은 맥에서 하고(`scripts/sign-agent.mjs`, 키는 이 맥에만), 사이트 이미지는 같은 소스·같은 Go(1.27.4)·같은 설정(`CGO_ENABLED=0 -trimpath -buildvcs=false -ldflags="-s -w -buildid="`)으로 **같은 바이트를 다시 만들어** 서명된 문서와 맞을 때만 이미지가 만들어진다(`bridge-server localfull-verify`). 서명한 것과 나눠 주는 것이 갈라질 수 없다.
  - 재현성 확인(1.519): 서명 맥은 이미지의 `localfull` 단계(`docker build --target localfull`)를 돌려 그 바이트에 서명한다. 맥 호스트에서 `GOTOOLCHAIN=go1.27.3` 로 직접 만든 것과 docker(linux) 에서 만든 것이 바이트까지 같았고, `ui/dist` 도 운영 사이트의 파일과 sha256 이 같았다.
  - `npm test` 는 `server/localfull.json` 의 `src`(입력 파일 목록·내용의 해시)가 지금 소스와 같은지 본다. server·ui·web·Dockerfile 을 고치면 `node scripts/sign-agent.mjs` 로 다시 서명해야 한다(docker 필요).
- 연결은 한 단계 스위치다. 에이전트는 여전히 밖으로 연결하지 않는다는 원칙을 지키되, 로컬 서버는 에이전트가 직접 띄운 자식이라 에이전트가 연동한다(사이트 연동 탭 `web/relay.js` 가 하던 일을 `agent/localfull.mjs` 의 `Relay` 가 한다). 동시에 두 곳에 연동하지 않는다: 켜져 있는 동안 사이트 탭은 `busy local`·409 로 거절되고 30 s 마다 다시 묻는다.

### 8.3 인증

- 로컬 서버는 127.0.0.1 에서만 듣고, 모든 요청 맨 앞에서 Host·Origin 을 로컬 화면처럼 본다(다른 Host·Origin, 같은 맥의 다른 포트 Origin 은 403). CSP 는 `default-src 'none'` 에서 필요한 `'self'` 만.
- 주인: 터미널의 일회용 링크(`#t=`, 5분, 한 번, 해시만 저장)만이 주인 쿠키(`__Host-cb-l<port>`, HttpOnly, SameSite=Strict)를 준다. 같은 맥이라는 것만으로는 주인이 아니다.
- 에이전트↔로컬 서버: 에이전트가 띄울 때마다 만든 32 바이트 비밀을 stdin 으로만 넘긴다(인자·환경·파일에 없음). `/api/bridge/*` 는 그 비밀로만 열리고, 그 비밀은 다른 경로를 열지 않는다. 주인 쿠키·에이전트 연동 키로는 연동 경로가 열리지 않는다.
- 사이트의 짝지은 기기 목록·trust 강제 모드·원격 기기 키는 쓰지도 바꾸지도 않는다. 로컬 서버에서 온 명령은 로컬 화면에서 보낸 것과 같이 맥 앞 사람의 것으로 보고(`signed:'local'`, trust 가 켜져 있으면 감사 로그), 켜져 있는 동안 봉인하지 않는다(응답이 맥 밖으로 나가지 않음). 로그인(GitHub·Apple·QR 등)·서비스·dev 경로는 닫는다.
- 데이터는 `~/.claude-bridge/localfull/data`(0700)에 따로 두고 사이트 계정과 맞추지 않는다.

### 8.4 못 막는 것

L1(같은 사용자로 도는 맥 안 프로그램)·L2(관리자 키)·L3(브라우저 확장)은 §6 과 같다. 더해서:

| # | 남는 위험 | 이유·완화 |
|---|---|---|
| L6 | 로컬 서버의 데이터(그룹·설정 등)가 사이트와 다름 | 맞추지 않기로 했다(사이트 계정 비밀을 맥에 두지 않음). 세션 자체는 맥의 것이라 그대로 보인다 |
| L7 | 사이트가 새 빌드를 내주지 않음 | 받아 둔 빌드로 켠다. 예전 서명 빌드로 되돌리기는 floor 로 막는다 |

### 8.5 시험

- 단위 `test/unit/localfull.test.mjs`(8개): 서명·해시·arch·접두 구분, 설치·floor·디스크 재확인, 입장권, 설정, SSE 읽기, Relay 의 비밀, CLI on·off·open, `server/localfull.json` 이 지금 소스와 맞음.
- Go `server/localfull_test.go`: 빌드 확인·나눠 주기, 입장(Host·Origin·입장권·쿠키·닫은 경로·CSP), 에이전트 연동 비밀, 인자.
- e2e `test/e2e-localfull.mjs`(30개): 이 checkout 의 사이트(4393)와 설치본처럼 복사한 에이전트(4392)로 on → 거절 → 링크 로그인 → 웹 화면 → off 와 사이트 재연결. 운영 에이전트(`~/.claude-bridge`)는 건드리지 않는다.
