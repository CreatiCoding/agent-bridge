# 서버를 믿지 않는 맥 (기기 짝짓기·명령 서명·출력 봉인) 설계

출처: 사용자 요청. 이 문서는 설계와 결정의 이유를 적고, 요구사항·AC 는 `SPEC.md` 의 REQ-S-090~ 에 둔다. 2판: 적대적 검토 1차 지적(입구 7곳, 서명된 open 의 저장소 clone, fork 의 권한 모드, 업데이트 되돌리기, R1 범위, 짝짓기 남발, 맥 안 프로세스, 자유 명령의 실제 동작, 키 지연, 원문 누출, 봉인 문맥) 반영. 3판: 2차 지적(받아쓰기 자동 전송, 내 말풍선, 서버의 글 분류, 켜기 전 상태, 끝난 세션 이어가기, 확장, bg, fork 사본, 업데이트 하한, 경로 기준 평문, 예전 키 입구, 숫자 입력) 반영. 4판: 3차 지적(꼬리표 범위, 정화는 한 번만, 정정 글은 맥이 정함, fork 다시 봉인 범위, `/`·`:` 명령 이름, 백그라운드 작업을 맥이 셈, 업데이트 하한 문구) 반영. 5판: 4차 지적(서명 표시의 수명, 정정 순서 바꿔치기) 반영. 5차 검토: 보안 지적 없음(정정의 정상 동작 1건 반영).

## 0. 한 줄 요약

맥의 `agent.json` 에 `"trust": "enforce"` 를 넣고, 맥 터미널에서 연 짝짓기 창 안에서 조작 페이지(브라우저·폰)를 숫자로 확인해 짝지으면, 그 맥은 **짝지은 기기가 서명한 명령만** 실행한다. 맥 터미널에서 `trust seal on` 을 더 켜면 **대화·화면 내용을 짝지은 기기만 풀 수 있게 봉인**해 내보낸다(봉인은 따로 고르는 선택, 기본 꺼짐: 서버가 글을 읽던 기능 일부가 멈추기 때문, §7). 서버는 전달만 한다. 기본값은 `off` 이고, 끈 맥은 지금과 똑같이 돈다.

이 모드가 실제로 막는 범위는 §2 의 R1 때문에 "서버로 바로 명령·서버에서 내용 읽기"까지다. **서버가 내려주는 페이지 코드를 바꾸는 공격자는 그 코드가 기기 키를 가진 브라우저에서 도는 동안 막지 못한다.**

## 1. 지금 구조에서 신뢰가 흐르는 길 (코드에서 확인)

```
폰/브라우저 ──HTTPS(쿠키)──▶ 서버(Go) ──SSE /api/bridge/stream──▶ 맥의 연동 탭(web/relay.js, 서버가 내려준 코드)
                                                               └─POST 127.0.0.1:<port>/cmd?key=…──▶ 에이전트(agent/agent.mjs)
에이전트 ──SSE /events──▶ 연동 탭 ──POST /api/bridge/up──▶ 서버 ──SSE /api/classic/stream──▶ 폰/브라우저
```

- 에이전트는 밖으로 연결하지 않는다. 연동 키(`config.key`)는 서버가 내려준 코드(연동 탭)가 쥐므로, 털린 서버는 그 키로 열리는 **모든 입구**에 무엇이든 넣을 수 있다고 본다. 지금 그 키로 열리는 입구: `/cmd`, `/events`, `/hook`, `/statusline`, `/delegate`, `/askpass`, `/file`, `/visible-login`, `/login-state`, `/host`(`agent.mjs` 5037 `keyOk` 가 경로를 가리지 않음). `/hook` 등은 원래 Claude Code 훅용 `hookKey` 로 오는 곳이다.
- 서버는 원본 대화 기록(JSONL `lines`)을 받아 **자기가 해석해** 화면 이벤트·제목·카드·알림을 만든다(`eventlog.go convert`, `events.go lineToEvents`).
- 서버가 브라우저 요청 없이 스스로 만드는 명령이 있다: `welcome`(남의 세션 kill), `set`/`bg`, `log`/`putimg`/`forget`, `flush`(git push 까지 함), 위임(`delegate.go`), 서비스 API(`service.go`), Slack(`slack.go`→`cscmd.go`), 제보 자동 수정(`reports.go`), `update`(관리자 서명됨).
- 서버가 채우는 값이 Claude·셸·설정으로 들어가는 길이 있다: `sysPrompt`(new·open·refresh·fork·lightfork·adopt, 그리고 `sessions.json` 에 저장돼 다시 열 때·되살릴 때·trimlog 때 쓰이는 `s.sysPrompt`), `open` 의 `folder.repos`(없는 폴더에 clone, sha checkout), `folder.files`·`transcript`·`home`·`account`·`chrome`·`mdFile`, fork·lightfork 의 `launch`(권한 모드)·`newSid`, new 의 `sid`·`autoPush`(git push), refresh 의 `interrupted`, retract 의 `quoted`, 훅(`hooks.go .before`)이 고친 `send` 글.

## 2. 위협 모델

### 2.1 가정

- 공격자는 **서버를 완전히 가진다**: 서버 프로세스·디스크·DB·환경변수, 서버가 내려주는 모든 페이지·스크립트(`ui`, `web/relay.js`, `sw.js`), 서비스 토큰, Slack 연동, 다른 사용자 계정, 운영자 권한, 사용자의 로그인 쿠키.
- 맥의 에이전트 파일과 `~/.claude-bridge/`, 맥 앞 사람이 보는 터미널은 믿는다. 에이전트 업데이트는 관리자 서명(REQ-S-067)이라 서버가 새 코드를 넣을 수 없다.

### 2.2 막는 것 (모드가 `enforce` 이고 짝지은 기기가 있을 때)

| # | 공격 | 막는 방법 |
|---|---|---|
| T1 | 털린 서버·훔친 쿠키·서비스 토큰·Slack·위임·운영자 권한으로 맥에 동작을 일으킨다 | §5 분류표의 "서명 필요" 명령은 짝지은 기기의 ECDSA 서명이 맞아야 실행, "끔" 명령은 거부. 연동 키로는 `/cmd`·`/events`·`/host`·`/login-state` 만 열리고 훅 입구는 `hookKey` 로만(§5.6) |
| T2 | 서명된 명령을 늦게·다시·다른 맥·다른 세션·다른 명령에 쓴다 | 서명에 맥 id·기기 id·시각·일련번호·명령·세션 id. 맥이 ±60 s 창과 본 일련번호를 디스크에 기억(§5.4). 키 입력은 그때 열린 카드에 묶음 |
| T3 | 서명된 명령에 서버가 값을 덧붙여 Claude·셸·설정에 끼운다 | 맥은 **서명한 칸 + 맥이 가진 기록**만으로 명령을 다시 만든다. 서버 칸은 명령마다 정한 무해한 칸만 남긴다(§5.3) |
| T4 | 짝짓기에 끼어들어 자기 키를 등록한다 | 맥 터미널에서 사람이 연 5분 창 안에서만 받음. 커밋-공개 + 6자리 숫자를 터미널에서 확인(§4). 페이지가 정직하면 끼어들어 맞출 확률은 10⁻⁶ |
| T5 | 서버 디스크·백업·DB 가 새거나 서버가 대화 내용을 읽는다 | 맥에서 나가는 대화·터미널 화면·파일·오류 글과 화면이 보내는 글을 콘텐츠 키(AES-256-GCM)로 봉인, 키는 짝지은 기기만 ECDH 로 받음(§6) |
| T6 | 서버가 권한 카드를 바꿔 보여 줘 엉뚱한 답을 서명하게 한다 | 카드 전체를 한 덩어리로 봉인, 서명에 카드 id·번호, 맥은 지금 열린 카드일 때만 누름(§6.4) |
| T7 | 서버가 모드를 낮추거나 기기를 지우거나 trust 이전 빌드로 되돌린다 | 모드는 맥 파일로만. 서명 없는 기기 해제는 늘 거부. `trust` 가 `off` 가 아니면 `trust.mjs` 의 `TRUST_VERSION` 이 지금보다 낮거나 없는 업데이트를 거부(§5.7) |

### 2.3 못 막는 것

| # | 남는 위험 | 이유·완화 |
|---|---|---|
| R1 | **서버가 내려주는 코드가 기기 키를 쓴다.** 조작 페이지·iOS 앱(웹뷰가 서버 주소를 염, `ios/Bridge/BridgeApp.swift:10`)·서비스 워커(`web/sw.js`, 푸시만으로 깨어남)·맥에서 열린 탭이 늘 돌리는 연동(`ui/src/components/relay-status.ts`) 모두 서버가 준 코드다. 그 출처에서 도는 코드는 "내보낼 수 없는" 키도 **쓸** 수 있다. 털린 서버가 코드를 바꾸면, 키를 가진 브라우저에서 그 코드가 도는 동안(사람이 열지 않아도, 서비스 워커·상주 탭으로) 아무 명령에나 서명하고 봉인을 푼다. 짝짓기 페이지도 맥에 뜰 숫자를 계산해 보여 줄 수 있다 | 웹 페이지만으로는 막을 수 없다. 이 모드는 공격자에게 "서버에 접근"만으로는 부족하고 "배포되는 코드를 바꿔 짝지은 브라우저에서 돌게 하기"까지 요구한다. 완화: 맥의 `trust/audit.log`(서버를 거치지 않음)에 기기·명령별 기록, `trust log` 로 보기, 맥 CLI 로 기기 해제. 안내: **맥의 연동 탭으로 쓰는 브라우저 프로필과는 짝짓지 말고 폰을 짝짓는다**. 더 나아가려면 명령마다 생체 확인(WebAuthn) 또는 서버 밖에서 서명·배포한 조작 앱이 필요하다(이번 범위 밖, §8) |
| R2 | 메타데이터: 어느 세션이 언제 얼마나 말하는지, 도구 이름, 모델, 세션 폴더 경로·홈·호스트 이름, 글 길이, 사용량, 짝지은 기기 이름 | 서버가 상태(도는 중·끝남·카드 열림)를 계산하는 데 쓰므로 평문(§6.2) |
| R3 | 서비스 거부: 명령·출력을 버리거나 늦추기, 짝짓기 막기, 맥을 다른 hostId 로 보여 화면이 서명·봉인하지 않게 하기 | 전달자가 서버라 막을 수 없다. 늦춘 명령은 60 s 뒤 거부. 다른 hostId 로 보이면 화면은 평문·서명 없이 보내고(그 글은 서버가 본다) 맥은 거부한다 |
| R4 | 화면 표시 바꿔치기: 봉인 조각을 같은 맥·같은 세션·같은 방향 안에서 옮기거나 지우거나 순서 바꾸기 | 조각은 맥·kid·방향·세션에 묶이지만 자리(칸)에는 묶이지 않는다. 권한 카드만 따로 막는다(T6) |
| R5 | 사람이 올리는 그림·음성(받아쓰기 원본) | 서버가 저장·보여 주는 경로라 평문. 서명이 그림의 SHA-1 을 묶어 바꿔치기는 막는다. 영상·파일은 `enforce` 에서 끔 |
| R6 | 맥 안에서 같은 사용자로 도는 프로그램(프롬프트 주입된 Claude 포함)이 `agent.json`·`trust/` 를 고침 | 맥 자체의 일이라 범위 밖. 완화: `trust/` 쓰기를 위험 호출(`riskyCall`)로 보아 전부 허용 중에도 묻는다, `devices.json` 에 기기가 있는데 `trust` 칸이 없으면 `enforce` 로 본다(닫힌 쪽으로) |
| R7 | `warn` 모드 | 기록만 하고 실행하므로 T1~T3 를 막지 않는다 |
| R8 | 처음 설치와 **다시 설치**(`curl … | bash`) | 서버가 준 파일을 그대로 까는 일이라 서버를 믿는 일이다. trust 모드 맥에서는 다시 설치하지 않는다(문서·`trust` CLI 안내) |
| R9 | 기기를 잃음, 해제한 기기가 예전 키로 예전 봉인을 품 | 맥 CLI `trust remove`. 해제 뒤 새 키로 바꾸지만 이미 받은 내용은 되돌릴 수 없다 |

### 2.4 원칙

- **서버가 준 글은 사람에게 보이기 전에 서명하지 않는다.** 받아쓰기 결과, 서버가 만든 문구·버튼 글, 확장이 만든 글이 그렇다. 짝지은 맥에서는 받아쓰기 "전송" 자동 보내기를 끄고 입력칸에 채워 사람이 보내게 한다. 받아쓰기 결과는 봉인돼 있어야 하고(`m` 조각, 그 녹음의 SHA-256 을 함께 봉인) 페이지는 자기 녹음과 맞을 때만 채운다.
- **짝지은 기기에서는 확장(ext)을 띄우지 않는다.** 확장 코드는 같은 출처에서 돌아 기기 키를 쓰고 풀린 글을 읽을 수 있다(`ui/src/lib/ext-host.tsx`).
- **서명 표시는 맥만 붙인다.** 들어온 명령의 `signed`·`autoAllowSigned` 칸은 모든 모드에서 늘 버린다. held 의 `signed`, 세션의 `autoAllowSigned` 는 `verify()` 가 맞을 때만 맥이 붙이고(held 의 `signed` 는 맥 앞 사람이 로컬 화면(1.398, `docs/LOCAL-UI-DESIGN.md`)으로 보낸 글에도 붙인다), 서명 없이 전부 허용이 바뀌면(어느 모드든) `autoAllowSigned` 를 지운다.
- **켤 때 한 번 정리하고, 그 밖의 예전 상태는 남는다.** 맥은 `trust/state.json` 에 `{mode, purgedAt}` 을 둔다. 모드가 실제로 `enforce` 로 바뀐 때(그 파일의 mode 가 enforce 가 아니었을 때) 한 번만: 서명 표시(`signed`)가 없는 붙잡아 둔 글(held)을 버리고, 서명으로 켜지 않은(`autoAllowSigned` 가 없는) 전부 허용(autoAllow·allowAll)을 끄고 기록한다. 다시 켜기·업데이트·재부팅 뒤 되살리기에서는 하지 않는다. 그 전에 서버가 써 둔 폴더의 CLAUDE.md·AGENTS.md·SESSION.md 같은 파일은 그대로다(안내에 적는다).

## 3. 모드

`~/.claude-bridge/agent.json` 의 `trust`:

| 값 | 명령 | 출력 | 짝짓기 |
|---|---|---|---|
| `off`(기본, 칸 없음) | 지금 그대로 | 평문 | 받지 않음 |
| `warn` | 서명이 없거나 틀려도 실행하되 `trust/audit.log`·에이전트 로그에 남기고 화면에 경고 알림. "끔" 명령도 실행 | 짝지은 기기가 있으면 봉인 | 맥 창 안에서 받음 |
| `enforce` | "서명 필요"는 서명이 맞아야, "끔"은 늘 거부 | 짝지은 기기가 있으면 봉인. 없으면 평문(서명 필요한 명령은 모두 거부되므로 짝짓기만 의미 있음) | 맥 창 안에서 받음 |

- 모드는 **맥에서만** 바꾼다: `node ~/.claude-bridge/agent.mjs trust mode <off|warn|enforce>` 또는 `agent.json` 을 고친다. 서버가 보내는 어떤 명령도 `trust` 를 쓰지 않는다. 에이전트는 `agent.json` 을 쓸 때 디스크의 `trust` 를 다시 읽어 지키고, 2 s 마다 바뀐 `trust` 를 읽는다.
- `devices.json` 에 기기가 있는데 `trust` 가 없거나 모르는 값이면 `enforce` 로 본다.
- 모드·기기 목록(id·이름·짝지은 때·마지막 사용)·맥 공개키 지문은 `hello`·`trust info` 로 화면에 알린다. 서버가 속여도 결과는 거부(R3)뿐이다. 화면은 자기가 짝지은 맥이면 보고된 모드와 무관하게 늘 서명·봉인한다.

## 4. 기기 짝짓기

### 4.1 키

- **기기(브라우저)**: WebCrypto ECDSA P-256(서명)과 ECDH P-256(키 받기)을 `extractable:false` 로 만들어 IndexedDB(`cb2-trust`)에 `CryptoKey` 로 둔다. 기기 id = base64url(SHA-256(서명 공개키 raw ‖ ECDH 공개키 raw))[:22]. 브라우저 프로필 하나에 한 쌍, 맥 여러 대와 짝지을 수 있다.
- **맥**: Node `crypto` 로 ECDH P-256 한 쌍(`trust/host-key.pem`)과 콘텐츠 키 K(32 바이트, `trust/content-keys.json`, kid 별). `trust/` 0700, 파일 0600.

### 4.2 절차

맥 앞의 사람이 `node ~/.claude-bridge/agent.mjs trust pair` 를 실행한다. 이 CLI 가 5분 창을 열고(`trust/pair-window.json`), 끝날 때까지 터미널에서 기다린다. 창이 없으면 에이전트는 `pair1` 을 받지 않는다. 서버가 원할 때 맥에 무엇을 띄울 수 없다.

```
기기                                         맥(에이전트)                          맥 터미널(trust pair)
nB ← 32B, c = SHA256("bt-pair-commit"‖Spub‖Dpub‖nB)
 ── pair1 {c} ──────────────────────────────▶ 창 없음·진행 중 있음 → 거부
                                              pid ← 16B(맥이 만듦), nA ← 32B, 만료 3분
 ◀── {pid, Apub, nA} ───────────────────────
 ── pair3 {pid, Spub, Dpub, nB, name} ─────▶ c 를 다시 계산(틀리면 폐기)
                                              SAS = (SHA256("bt-pair-sas"‖hostId‖Apub‖Spub‖Dpub‖nA‖nB) 앞 8B) mod 10⁶
                                              trust/pending.json 에 {pid, sas, name, 기기 id}   ─▶ "기기 '<이름>'(서버가 전달한 이름) 이
 기기 화면: "확인 숫자 123 456 — 맥 터미널에 입력하세요"                                       짝짓기를 요청했어요. 기기 화면의
                                                                                            6자리 숫자를 입력하세요: ______"
                                                                                            맞으면 "확인 숫자 123 456 일치" 를 보이고 짝지음
                                              ◀── trust/confirm.json {pid, sas} ───────── 입력한 숫자
                                              pid·sas 가 맞으면 devices.json 에 추가, 창 닫힘
 ── pair4 {pid} (2 s 마다) ─────────────────▶ 확인 전: pending / 거절·만료: no
 ◀── {ok, kid, salt, wrap} ─────────────────  wrap = AES-GCM(K, HKDF-SHA256(ECDH(Apriv,Dpub), salt=nA‖nB, info="bt-wrap|"+hostId))
기기: 같은 HKDF 로 K 를 풀면 짝지어짐. IndexedDB 에 {hostId, Apub, kid→K(non-extractable)}
```

- **커밋 먼저**: 기기가 nB 를 숨긴 채 약속하고, 맥이 nA 를 낸 뒤에 nB 를 연다. 중간의 서버는 양쪽 숫자가 같도록 고를 수 없다(블루투스 숫자 비교·ZRTP 방식). 단, 짝짓기 페이지 자체가 변조되면 의미가 없다(R1).
- **숫자는 사람이 맥에 입력**: 요구는 "양쪽에 같은 숫자를 띄우고 맥에서 확인"이다. 맥이 숫자를 먼저 보여 주고 y 를 받으면 기기 화면을 보지 않고 누르기 쉬워, 기기 화면의 숫자를 맥 터미널에 입력하게 하고 맞으면 맥도 그 숫자를 보여 준다(양쪽에 같은 숫자가 뜬다). 세 번 틀리거나 빈 줄이면 그 짝짓기는 거절되고 `trust pair` 창도 닫힌다(다시 하려면 맥에서 다시 연다).
- **확인은 맥 터미널에서만**: 대화상자·HTTP 입구를 두지 않는다. 확인 파일은 `trust/` 안(0700)이고 연동 키로 닿는 입구가 없다. 확인 파일에 pid 와 숫자를 함께 적어 만료된 pid 를 바꿔치기해도 맞지 않는다.
- 이름은 서버가 바꿀 수 있으므로 "서버가 전달한 이름"이라고 쓰고 64자·제어문자 제거.
- **위조 불가**: 서버가 `pair4` 결과를 꾸며도 기기는 ECDH 비밀 없이 만든 `wrap` 을 풀 수 없다. 서버가 `pair4` 를 막으면 맥만 짝지은 상태(해롭지 않음, CLI 로 해제).

### 4.3 목록·해제·키 교체

- 목록: CLI `trust devices`, 화면 설정(맥이 알린 목록).
- 해제: CLI `trust remove <id>`, 또는 짝지은 기기가 서명한 `trust {op:'remove', id}`(모든 모드에서 서명 필수).
- 해제하면 새 kid 의 K 를 만들어 남은 기기마다 새 salt 로 감싸 두고(`trust {op:'keys'}` 로 받아 감), 앞으로의 봉인은 새 kid 로만 한다. 예전 kid 는 맥에 남겨 예전 봉인을 풀 수 있게 한다.

## 5. 명령 서명

### 5.1 서명 묶음

```json
{ "p": "<서명한 JSON 문자열>", "s": "<base64url, ECDSA P-256 SHA-256, r‖s 64B>" }
p = {"v":1,"h":"<hostId>","d":"<기기 id>","ts":<ms>,"n":<일련번호>,"t":"<에이전트 명령>","i":{…}}
```

- 화면 `ui/src/lib/api.ts` 의 `call()` 이 경로·본문으로 나갈 에이전트 명령을 정하고(`ui/src/lib/trust.ts` 경로표), 그 맥과 짝지은 기기면 명령마다 묶음을 만들어 머리글 `X-Bridge-Auth: base64url(JSON 배열)`(최대 8개, 각 2 KB)로 보낸다.
- 글은 원문을 넣지 않는다. 짝지은 맥에는 글을 봉인 조각으로 보내고, 그 칸 **전체 문자열**의 SHA-256 을 묶는다(조각마다 난수 iv 라 사전 대입 불가). 맥은 칸 전체의 해시를 비교한 뒤 연다.
- 서버는 머리글을 맥별 대기열에 30 s 넣었다가 그 맥에 나가는 명령 중 `t`·`sid` 가 맞는 첫 명령에 `auth` 로 붙인다(`toHost`·`ask` 한 곳). 틀리게 붙여도 결과는 거부뿐이다.
- 일련번호: 기기마다 IndexedDB 카운터를 `navigator.locks` 로 잠가 올린다(여러 탭이 같은 키를 써도 겹치지 않음).

### 5.2 맥의 확인 순서

1. 모드 `off` → 지금처럼 실행.
2. 분류표(§5.5) `TRUST_CLASS[t]`(op 가 있는 명령은 op 별). 표에 없는 `t` 는 "끔"으로 본다(닫힌 쪽).
3. "서명 필요"면 확인: `p.v==1`, `p.h==hostId`, `p.d` 가 짝지은 기기, `p.t==cmd.t`, 서명이 맞음, `|지금-p.ts| ≤ 60 s`, 일련번호(§5.4), 묶은 해시가 맞음. 하나라도 틀리면 `enforce` 거부(`error` 봉인 + `trust/audit.log`), `warn` 실행하고 기록.
4. 실행할 명령 = `{t, reqId}` + 표의 `keep` 칸(서버 값, 무해한 것만) + 서명한 `i` + 표의 `local`(맥이 정함). 서버의 나머지 칸은 버린다.
5. `trust` 가 `off` 가 아니면 Claude 를 띄우는 한 곳(`launch`)이 늘 맥의 프롬프트(`trust/prompt.txt` 또는 기본 문구)를 쓴다. 저장된 `s.sysPrompt` 는 쓰지 않는다.

### 5.3 명령을 다시 만드는 법 (서명 필요 명령, `enforce`·`warn` 서명됨 공통)

| t | 서명 `i` | 맥이 정함(`local`) | 서버에서 남김(`keep`) |
|---|---|---|---|
| new | cwd, promptH, model, effort, mode, create, account, chrome, autoPush | sysPrompt ← `trust/prompt.txt` 또는 기본 문구. sid 는 `safeConvId` 이고 맥에 없는 것만 | sid, prompt |
| open | sid | 맥의 세션 기록(`sessions.json`, 닫힌 세션은 `trust/closed.json` 의 남김 기록: cwd·conv·account·chrome·mdFile·autoPush, 최근 200개)에 있는 세션만. model·effort·mode 도 그 기록. autoAllow·allowAll 은 끔. folder·transcript·home 없음, 폴더가 이미 있어야(만들지 않음). sysPrompt 맥 | — |
| send | sid, textH, imgs[](SHA-1 id) | 그림은 데이터의 SHA-1 을 맥이 다시 계산해 id·목록 확인, videos 없음. 받은 글은 held 에 `signed:true` 로 | text, files, id |
| sendnow, esc, close, forget, trash, trimlog | sid | | |
| dropheld | sid, id | | |
| retract | sid, quotedM, kid | 맥은 마지막으로 Claude 에 넣은 전달 한 번(붙잡혔다 한꺼번에 넣은 것 포함)에 들어 있던 **서명된 send 의 글 하나하나**를 기억한다. `quotedM` = HMAC-SHA256(kid 의 K, 정정할 글) 이 그중 하나와 맞을 때만 그 글로 정정(서버가 정정과 다음 글의 순서를 바꾸면 맞지 않아 거부). 맥이 친 글(새로고침 안내·인수인계·`/model`)은 세지 않는다. 아직 붙잡혀 있는 글은 화면이 정정 대신 `dropheld` 를 쓴다 | |
| answer | sid, card, n | 맥이 지금 열린 카드 id 와 비교 | |
| key | sid, keys, card(그때 열린 카드 id 또는 null) | 맥의 지금 카드와 비교 | |
| set | sid, autoPush?, autoAllow?, allowAll? | 서명으로 켠 전부 허용은 `autoAllowSigned` 로 표시 | |
| setting | sid, kind, value | | |
| refresh | sid, when | sysPrompt 맥, interrupted 는 맥이 센 백그라운드 작업. `later` 는 서버의 bg 수 대신 맥이 대화 기록에서 직접 센 백그라운드 작업(서버 `trackBackgroundLine` 과 같은 규칙을 에이전트로 옮김)이 0 이고 턴이 끝나면 다시 연다 | |
| fork | sid | newSid 는 `safeConvId` 이고 맥에 없는 것, launch 없음(원래 세션 설정 그대로), sysPrompt 맥, copyLog 는 정수만. 복사한 기록의 봉인 조각 중 원래 sid 의 것만 방향(`d`)을 그대로 두고 새 sid 로 다시 봉인, 나머지 조각은 `🔒`(`u` 를 `m` 으로 바꾸지 않는다) | newSid, copyLog |
| lightfork | sid, cut(mode 칸, 잘라 내는 방식) | newSid 같음, launch 없음, sysPrompt 맥 | newSid |
| btw | sid, textH | | text |
| killserver | sid, port | | |
| background | on, proxy | login 은 `config.site` 와 같은 출처일 때만 | login |
| heal | action | | |
| awake | idle, lid | | |
| compact | window | | |
| updatePolicy | mode, from, to, skipBusy | | |
| updateNow | — | | |
| disk(prune·clean·trash) | op, id, path, paths | | |
| trust(remove) | id | | |
| tidyStop(세션 정리의 손으로 내리기) | sids | holds 는 서버 것(지킬 세션만 늘어남) | holds |
| tidyTrash(세션 정리의 버리기) | items(kind, path) | 맥의 `trashable` 검사 그대로 | |
| flush(push 할 때) | — | `enforce` 에서 서버가 부른 flush 는 읽기만 하고 push 하지 않는다. 맥이 스스로 하는 동기화는 그대로 | |

### 5.4 재전송 막기

- 기기마다 `{floor, seen:{n→ts}}` 를 `trust/replay.json` 에 둔다. `|지금-ts| ≤ 60 s`, `n > floor`, `seen` 에 없음이면 받고 **실행 전에** 파일에 쓴다. 60 s 지난 `seen` 은 지우며 `floor = max(floor, 지운 n)`.
- 다시 켜도 파일이 남는다. `p.h`·`i.sid`·`p.t` 로 다른 맥·세션·명령에 못 쓴다. 키 입력·권한 답은 카드 id 에 묶여, 늦게 열린 다른 카드에 못 쓴다.

### 5.5 명령 분류표 (에이전트 `commands` 전부)

- **서명 필요**: §5.3 표의 명령.
- **끔**(`enforce` 거부): `adopt`, `release`, `sudo`, `sudopass`, `account`(op≠list), `http`, `ws`, `delegated`, `sudoans`. 그리고 `welcome` 의 남의 세션 kill 은 `enforce` 에서 하지 않는다.
- **자유**(서명 없이): 
  - 상태: `ping`, `rehello`, `check`, `report`, `resync`, `welcome`(kill 없이), `models`, `sudooff`(비밀번호를 잊기만), `bg`(`enforce` 에서는 세는 수만 기록하고 새로고침을 일으키지 않음).
  - 맥 사본: `log`(이벤트 사본, `enforce` 에서 통계·PR 링크에 쓰지 않음), `putimg`(`enforce` 에서는 id 가 `<sha1>.(png|jpg|gif|webp)` 이고 데이터의 SHA-1 이 같고 그림 머리 바이트가 맞을 때만).
  - 읽기(결과·오류 모두 봉인): `events`, `export`, `img`, `screen`, `flush`(push 없이), `readfile`, `readimage`, `trashinfo`, `disk`(info·scan·worktrees), `prsearch`, `prstates`, `skills`, `dirs`, `recent`, `account`(list), `voice`, `attachment`(1.401, 세션이 첨부한 id 로만), `convread`(1.401, 봉인 중이면 거절).
  - `update`: 관리자 서명 + §5.7.
  - `trust`(info·pair1·pair3·pair4·keys): 짝짓기 자체. `pair1` 은 맥 창이 있을 때만.
  - `tidyRun`(세션 정리의 정해진 계산): trust 가 켜져 있으면 서버가 보낸 정책이 `auto` 여도 `suggest` 로 낮춰, 맥이 스스로 세션을 내리지 않고 보고만 한다.
- 서버가 실행 설정으로 보내는 칸(`launch`, 모델 라우팅 `routing`, 새 세션의 `base`)은 서명 칸이 아니라 다시 만들 때 빠진다. fork 는 원래 세션의 라우팅을 맥이 그대로 쓴다.
- 단위 시험이 `commands` 의 키를 모두 읽어 `TRUST_CLASS` 에 없는 것이 있으면 실패한다.

### 5.6 다른 입구 (`trust` 가 `off` 가 아닐 때)

| 입구 | 처리 |
|---|---|
| `/cmd`, `/events` | 연동 키(§5.2 로 확인) |
| `/host`(로컬 미리보기 정보), `/login-state`(헤드리스 로그인 상태 알림), `/ping`, `/bg-open`(일회 토큰) | 지금 그대로. 동작을 일으키지 않는다 |
| `/hook`, `/statusline`, `/delegate`, `/askpass`, `/visible-login` | `hookKey` 만. 연동 키로는 403. CLI `link --visible` 은 `hookKey` 로 부르게 바꾼다 |
| `/file`(영상·파일 올리기) | `enforce` 거부, `warn` 받고 기록 |
| `/local/*`(로컬 화면, 1.398) | 연동 키·`hookKey` 로는 열리지 않음. 맥 터미널 `local open` 의 일회용 입장권 → 로컬 토큰으로만, Host·Origin 은 `127.0.0.1:<port>` 만. 서버를 거치지 않는 맥 앞 사람의 요청이라 서명을 확인하지 않고 `trust/audit.log` 에 `local …` 로 남긴다. 화면 묶음은 관리자 서명·순번 하한(`localui` 명령은 `free`) |
| 키 없이·예전 키로 온 요청의 연동 다시 열기(`reopenLink`·`restartBgForKey`, 맥에서 브라우저를 엶) | 하지 않음 |
| 맥이 내는 `delegate`(MCP 위임), `sudoask` | `enforce` 에서 내지 않고 바로 실패. 기억한 sudo 비밀번호는 지운다 |

### 5.7 업데이트 되돌리기 막기

- `agent/trust.mjs` 가 `export const TRUST_VERSION = 1` 과 `TRUST_MIN_SEQ`(trust 가 처음 들어간 서명 순번)를 둔다. 맥에는 `agent.sig` 가 없어 새로 설치한 맥의 하한은 `TRUST_MIN_SEQ` 다. `trust` 가 `off` 가 아니면 `update` 를 받을 때와 받아 둔 업데이트를 **깔 때**(`applyUpdate`) 모두, 파일에 `trust.mjs` 가 없거나 그 `TRUST_VERSION` 이 지금보다 작거나 순번이 `max(updateSeq, TRUST_MIN_SEQ)` 이하면 거부한다(관리자 서명이 맞아도). trust 경로의 보안 수정(이 파일뿐 아니라 `agent.mjs` 의 봉인·명령 다시 만들기·입구 검사(1.398 의 `/local/` 입구 포함)를 고칠 때도)마다 `TRUST_VERSION` 을 올려(1.394 에 2, 1.398 에 3: 로컬 화면 입구와 `agent.json` 의 `trustSeal` 을 에이전트가 덮어쓰지 않게 한 수정), 알려진 구멍이 있는 예전 trust 빌드로 되돌릴 수 없게 한다.

## 6. 봉인

봉인은 `agent.json` 의 `trustSeal: true`(맥 터미널 `trust seal on|off`)이고 모드가 `off` 가 아니며 짝지은 기기가 있을 때만 한다(1.394). 그림은 서버가 맥에서 받아 보여 주는 길이라 봉인하지 않는다(R5 에 더함). 봉인 중에는 대화 파일 내보내기를 서버로 보내지 않는다. 화면이 봉인되지 않은 글에 붙이는 경고(§6.3 마지막 줄)는 아직 하지 않았다.

### 6.1 형식

- 조각: `⟦bt1:<kid>:<base64url(iv12 ‖ 암호문 ‖ tag16)>⟧`, AES-256-GCM, AAD = `"bt1|"+hostId+"|"+kid`.
- 평문 = JSON `{"d":"m"|"u","s":"<sid 또는 ''>","v":"<글>"}`. `d`=방향(m: 맥→화면, u: 화면→맥). 맥은 `u` 만 받아 푼다. 화면은 `m` 을 보여 주고, `u` 는 사람 말풍선(이벤트 k=user)과 붙잡아 둔 글(held)에서만 보여 준다(서버가 페이지가 보낸 글로 사람 말풍선을 만든다, `eventlog.go logSaid`). 세션 자리에 다른 세션의 `s` 조각이 오면 `🔒`.
- 조각은 글 안 어디에나 둘 수 있다(평문 접두 허용). 화면은 받은 JSON 의 모든 문자열에서 조각을 찾아 푼다. 못 풀면 `🔒`.
- 서버는 조각을 자를 때 가운데를 자르지 않는다(`sealSafeSlice`).

### 6.2 무엇을 봉인하나 (에이전트 `emit` 에서, `t` 별)

| t | 봉인 | 평문 |
|---|---|---|
| lines | 각 JSONL 줄의 모든 문자열 잎. 평문은 **경로로** 정한 것만: 줄 맨 위의 type·subtype·uuid·parentUuid·sessionId·timestamp·version·cwd·gitBranch·isSidechain·isMeta·userType·requestId·level·toolUseID, `message` 의 role·model·id·stop_reason·type, `message.content[]` 의 type·id·name·tool_use_id·is_error, `source.media_type`·`source.type`, 도구 입력의 run_in_background, TodoWrite `todos[]` 의 status. 객체의 키 이름은 평문(R2) | 구조 |
| lines 글 안의 꼬리표 | **사람 줄(role=user)의 글에서만**, 서버가 쓰는 감싸기 태그 이름(`events.go:48` ENVELOPE_RE 의 channel·task-notification·system-reminder·agent-message·local-command-*·command-name·command-message·command-args·bash-input·bash-stdout·bash-stderr, 그리고 summary·status)의 여는·닫는 태그만 평문(속성이 있으면 `<이름 ⟦속성⟧>` 로 봉인). 정확히 `[Request interrupted by user]`·`[Request interrupted by user for tool use]` 인 줄, `[Image attached: <맥 그림 폴더>/<sha1>.<ext>]` 와 `[Image #n]` 은 평문, `[Attached file: ⟦경로⟧]`·`[Video attached: ⟦경로⟧] ⟦안내⟧` 는 경로를 봉인. 그 밖의 태그(Claude 답의 HTML 등)는 모두 봉인 | |
| lines 의 `attachment` | `attachment.type`, `deferred_tools_delta` 의 `addedNames[]`(도구 이름) 평문 | |
| lines 의 사람 글 | 봉인은 위와 같다. 서버의 에코 제거(`isEcho`, 글 비교)가 봉인 글로는 맞지 않으므로, 맥이 방금 `send` 로 넣은 글과 같은 사람 줄에 `"bridgeEcho":true` 를 더하고 서버는 이 칸이 있으면 에코로 본다(서버가 이 칸을 속여 얻는 것은 사람 말풍선 하나를 숨기는 것, R4). 맥이 친 글(`[정정] ` 등 `bridgeTypedRe` 접두, COMPACT 글)은 접두를 평문으로 두고 뒤를 봉인 | |
| screen, preview | text | |
| status | held[].text, tool.title, running[] 글, servers[].title | phase 등 |
| card | 카드 전체를 `sealed` 한 칸에({id, title, tool, context, options[{n,label}]}), 평문 글 칸은 `🔒` | id, kind, 선택지 수·n |
| note, toast, error | text, message | level |
| folder, flushed | files 내용, repos 의 PR 제목 | 가지·sha |
| file | content, name, path | |
| attachment(1.401) | id·세션·이름·종류·크기·바이트를 한 조각 `sealed` 로(화면이 안의 id·sid 확인), 오류 | id, size |
| convread(1.401) | text, error(단, 봉인 중에는 아예 거절해 글을 보내지 않음) | |
| image, img, export | data | |
| btw | answer | |
| voice | text 와 그 녹음의 SHA-256 을 한 조각에(`{"text","audioH"}` 를 JSON 으로) | |
| recent | 대화마다 title·first·last·cwd | |
| dirs, trashinfo, disk, skills, prsearch, prstates | 글 칸 전부(오류 글 포함) | 숫자 |
| stats | prLinks | 숫자 |
| logs | entries[].text | |
| opened, hello, health, sysdialog, pong, conv, delivered 등 | 없음 | 메타데이터(R2) |

### 6.3 화면

- 받는 곳 셋에서 푼다: `store.ts` SSE(받은 순서대로 한 줄 대기), `session-log.ts` 이벤트 페이지, `api.ts` 응답. 같은 조각은 캐시.
- 화면이 보내는 글(send·new·btw)은 그 맥의 K 로 `u` 조각을 만들어 보낸다. 맥은 풀어서 쓴다. 글이 `/이름` 또는 `:이름` 으로 시작하면 그 첫 낱말은 평문으로 두고 나머지를 봉인한다(서버의 `slashColonRe`·100MB 넘은 기록에서 `/` 명령만 받기가 맞도록, `api3.go:991·1007`). `:` 글 명령은 페이지가 봉인하기 전에 경로표로 바꿔 서명한다(§7).
- 짝지은 맥의 사람·Claude 글 칸(이벤트 k=user·text·note·tool 결과, 화면, 카드)이 봉인되지 않고 오면 "⚠️ 봉인되지 않은 글(서버가 보냈을 수 있음)" 표시를 붙인다.

### 6.4 권한 카드

화면은 카드의 `sealed` 를 풀어 그 안의 선택지(번호와 글이 한 덩어리)로 버튼을 그리고, 서명의 card 는 풀린 덩어리의 id 다. `sealed` 가 없거나 못 풀면 버튼을 그리지 않고 "맥에서 확인할 수 없는 카드" 로 보인다. 맥은 card 가 지금 열린 카드 id 와 같을 때만 누른다.

## 7. 기존 기능 영향표 (`enforce`·봉인된 맥)

| 기능 | 코드 | 어떻게 되나 |
|---|---|---|
| 대화·화면·카드 보기 | ui store/session-log | 짝지은 기기에서 보임, 그 밖은 `🔒` |
| 세션 목록 제목·마지막 글 | eventlog.go 89-97, agentmsg.go 507 | 짝지은 기기에서 풀림. 4 KB 넘는 조각은 서버가 `🔒` |
| 푸시(APNs)·알림 본문 | notices.go 166, apple.go 292 | 내용 없이 "세션 · 새 알림" |
| 알림의 허용·거부 버튼 | web/sw.js 39 | 서명이 없어 거부. 페이지에서 답 |
| Slack 연동 | slack.go, cs.go, cscmd.go | 내용을 보내지 않고 안내 한 번. Slack 의 명령은 거부 |
| notify 웹훅·훅·확장 훅 | outbound.go, hooks.go, ext_data.go | 봉인 조각은 `🔒`. `.before` 훅이 글을 고치면 해시가 달라 거부 |
| 위임(맥→맥) | delegate.go, agent mcp | 끔 |
| 파일 첨부(bridge MCP `attach`, 1.401) | agent attachFile, api3.go attachment | 됨. 맥 안에서 복사하고, 화면이 받을 때 봉인된 한 조각으로 |
| 다른 세션 읽기(bridge MCP `read_session`, 1.401) | agent readSession, delegate.go readSession | `enforce`·봉인 맥은 서버에 묻지 않고 이 맥 세션만 id 로. 봉인 맥은 다른 맥의 `convread` 를 거절 |
| 서비스 API·제보 자동 수정 | service.go, reports.go | 거부 |
| PR 링크 모으기·리뷰 루프·배포 표시·통계의 PR | cscmd.go 501, eventlog.go 964-976 | 동작 안 함 |
| 답 끝의 선택지 버튼, ```todos 블록, 출처 접기 | events.go 136-203·333·SOURCES_HEAD_RE | 안 보임(서버가 글 구조를 못 봄). 글은 그대로 보임 |
| 할 일 패널의 이름 비교·백그라운드 작업 이름 | eventlog.go 544-557·772 | 이름은 풀려 보이지만 서버의 같은 이름 비교는 안 맞아 겹치거나 남을 수 있음 |
| 새로고침 예약과 백그라운드 작업 | agentmsg.go 723, eventlog.go 535 | 맥이 턴 끝에 다시 연다. 끊긴 백그라운드 작업 안내(interrupted)는 빠짐 |
| 받아쓰기 "전송" 자동 보내기 | voice-mode.tsx 141-152 | 짝지은 맥에선 입력칸에 채우기만 |
| 확장(ext) | ext-host.tsx | 짝지은 기기에서는 띄우지 않음 |
| `:` 글 명령 | cscmd.go | 서명표로 바뀌는 것만(§9 경로표), 나머지 거부 |
| 이어가기·멈춘 세션에 보내기 | session.go 296·440, api3.go 661-676·995-1004 | 같은 맥에 기록(살아 있는 세션 또는 닫힌 세션 남김 기록)이 있으면 됨. 페이지가 `open` 에도 서명 |
| 다른 맥으로 옮기기·폴더 바꾸기·가져오기 | session.go, api2.go 123 | 끔 |
| 미리보기(서버 프록시) | preview.go | 끔. 맥 앞의 로컬 미리보기는 그대로 |
| sudo | session.go 26, api2.go 350 | 끔 |
| Claude 계정 추가·로그인 | api2.go 167 | 끔(목록만) |
| 영상·파일 보내기 | /file | 끔(그림은 됨) |
| 대화 속 그림(도구 결과) | notices.go imageRef | 안 보임 |
| 계정 기본 프롬프트 | store.go sysPromptOf | 맥의 `trust/prompt.txt` |
| 운영자의 남의 맥 고치기 | session.go 226 | 주인 기기 서명 없으면 거부 |
| 서버 쪽 검색 | 없음 | 해당 없음 |
| 받아쓰기 | api3.go 106, store.go cleanVoiceHost | 음성은 평문(R5), 결과 글은 봉인. 받아쓰기를 맡는 맥이 짝짓지 않은 다른 맥이면 결과가 평문이라 짝지은 맥의 화면은 받지 않는다(안 됨) |
| 맥의 연동 탭으로 열린 화면 | relay | 그대로(전달만) |
| 세션 정리 자동 내리기 | tidy.go, agent tidyRun | 제안만(맥이 스스로 내리지 않음). 손으로 고른 내리기·버리기는 서명해서 됨 |
| 모델 라우팅(서버 설정) | agent routingShell | 서명한 새 세션·이어가기·새로고침·가벼운 복제에는 서버 라우팅을 쓰지 않음 |
| 새 세션을 전부 허용으로 시작 | session.go turnOnAutoAllow | 서버가 뒤따라 보내는 `set` 은 세션 id 를 미리 알 수 없어 서명이 없다. 거부되어 기본 모드로 시작하고, 페이지에서 다시 켜면 된다 |

## 8. 하지 않은 것과 이유

- **명령마다 생체 확인(WebAuthn)**: R1 의 "몰래 서명"을 막지만, 글 하나 보낼 때마다 Touch ID 가 필요하고, 변조된 페이지는 사람이 하는 정상 확인 한 번에 다른 내용을 실어 보낼 수 있으며, iOS 앱 웹뷰에서 되는지 확인하지 못했다. 다음 단계 후보.
- **조작 페이지를 서버 밖에서 서명·배포**: 배포 구조를 바꾸는 일이라 범위 밖.

## 9. 단계

1. **1단계 (SPEC 1.392)**: `agent/trust.mjs`(키·짝짓기·CLI·재전송·분류표·명령 다시 만들기), `agent.mjs` 의 입구 정리·`/cmd` 확인·`delegate`/`sudo`/`welcome`/`flush`/`putimg`/`update` 처리. 서버: `X-Bridge-Auth` 대기열, `/api/hosts/:id/trust`, 호스트 상태의 `trust`. 화면: `ui/src/lib/trust.ts`(키·짝짓기·서명·경로표), 설정 → 이 기기 "맥 짝짓기" 카드, 경고. 시험: 단위 + e2e(짝짓기 → enforce 에서 서명 없는 send 거부·서명한 send 실행·재전송 거부).
2. **2단계 (SPEC 1.394)**: 봉인, `trust seal on` 으로 따로 켬(에이전트 emit·대화 줄, 화면 풀기·보내는 글 봉인, 서버의 자르기·알림·Slack·훅·에코 처리, 카드 덩어리). 그림은 평문, 평문 경고는 하지 않음. 시험: 봉인 왕복 단위(`test/unit/trust.test.mjs`, `server/sealtext_test.go`), e2e 로 서버 기록·데이터 폴더에 원문이 없는지(`test/e2e-trust.mjs`).
3. **로컬 화면과 맞추기 (SPEC 1.398)**: 서버가 내려가도 쓰는 로컬 화면(`docs/LOCAL-UI-DESIGN.md`). 입구 표에 `/local/`, 맥 터미널 전용 파일·명령(`trust/`·`localui/`·`agent.mjs trust|local`)은 묻지 않는 전부 허용에서도 묻는다(`bridgeSelfCall`), `writeJson` 이 `trustSeal` 도 디스크 값을 지킨다, `TRUST_VERSION` 3.
