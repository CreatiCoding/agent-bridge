# claude-bridge 작업 규칙

호스트(macOS)의 Claude Code 세션을 웹에서 다루는 셀프호스팅 시스템이다.

- `server/`: 서버(Node, 의존성 없음)
- `agent/`: 호스트 에이전트(Node, 의존성 없음)
- `web/`: 연동 페이지(`/bridge`)와 예전 화면
- `ui/`: 조작 페이지(React + Vite, yarn)
- `docs/`: `PRD.md`, `SPEC.md`, `LESSONS.md`

## 0. 먼저: 운영자 저장소인가

작업을 시작하면 `git remote get-url origin` 을 본다.

- `github.com/CreatiCoding/agent-bridge`(`https://github.com/CreatiCoding/agent-bridge(.git)` 또는 `git@github.com:CreatiCoding/agent-bridge(.git)`)이면 **운영자 저장소**다. §1~§6 을 모두 따른다. §4·§5 의 "운영자 규칙"(main push = 운영 배포, 배포 확인, 에이전트 서명·재시작)이 이 경우에만 적용된다.
- 그 밖(포크, 다른 주소, origin 없음)이면 **기여자**다. §1·§2·§3·§6 을 따르고, §4·§5 대신 §7 "기여자 규칙"을 따른다. 운영 서버·배포·Dokploy·서명 키는 없다고 보고 건드리지 않는다.

## 1. 작업하면 SPEC.md 도 같이 고친다

- 코드를 고치는 모든 작업은 **같은 커밋에서 `docs/SPEC.md` 를 갱신한다.** 동작, 화면, API, 프로토콜, 상수, 한도, 오류 문구, 환경변수, 파일 위치가 바뀌면 해당 요구사항(REQ-…)·인터페이스·상수·오류·수용 기준(AC)·추적성 표를 고친다.
- 새 기능은 새 ID 를 붙이고 수용 기준을 하나 이상 단다. 없앤 기능의 ID 는 지우지 말고 "폐기"로 적는다.
- 문서 머리의 "코드 기준 커밋"과 §6 변경 이력을 함께 고친다.
- **SPEC 판을 올리면 같은 커밋에서 `ui/src/lib/changes.ts`(설정 → 변경 기록)에 그 판을 맨 위에 더한다.** 사람이 보는 말로, `commit` 은 비워 두고 앞 판의 `commit` 을 채운다. SPEC 머리의 판과 CHANGES[0].version 이 다르면 `npm test` 가 실패한다.
- SPEC 에 영향이 없는 변경(주석, 리팩터링, 테스트만)이면 커밋 본문에 `SPEC: 변경 없음` 이라고 적는다.
- **화면·동작·API·보안이 바뀌면 같은 커밋에서 `ui/src/lib/changes.ts`(설정 → 변경 기록, REQ-F-744)의 `CHANGES` 맨 앞에 릴리스를 더한다.** changelog 양식이다: `version` 은 이번 SPEC 판, `date`, `changes` 의 줄마다 `kind`(added·changed·fixed·removed·security), `scope`(ui·server·agent), `text`(무엇이 어떻게, 기술적으로 짧게), `refs`(REQ·IF·ERR id). `commit` 은 자기 해시를 모르니 비워 두고, 바로 앞 릴리스의 `commit` 이 비어 있으면 그 해시(`git log`)를 채운다. 테스트·리팩터링·문서만 바꾼 것은 적지 않는다. 2026-10-11 사용자가 정했다.

## 2. 넣으면 안 되는 것

- 특정 회사 맥락(회사 이름, 사내 주소, 사내 도구 이름)을 코드·문서·커밋에 넣지 않는다.
- 공개 npm 에 없는 패키지는 쓰지 않는다. 필요하면 직접 만든다. 새 의존성은 먼저 묻는다.
- 비밀값(토큰, 키, 비밀번호)은 저장소에 넣지 않는다.

## 3. 커밋 전에 검증

- 화면(`ui/`)을 고쳤으면 `cd ui && corepack yarn build` 를 통과시킨다(타입 검사 포함).
- 에이전트(`agent/`)를 고쳤으면 `node scripts/sign-agent.mjs` 로 서명해 `agent/agent.sig` 를 같은 커밋에 넣는다. 에이전트는 관리자 서명이 맞는 업데이트만 받는다(SPEC REQ-S-067). 서명 키는 이 맥의 `~/.claude-bridge-signing/` 에만 있고 저장소·서버에 두지 않는다. 서명이 파일과 맞지 않으면 `npm test` 가 실패한다. (기여자는 §7 의 서명 항목을 따른다.)
- `npm test`(저장소 루트)를 통과시킨다.
- 동작을 바꿨으면 해당 e2e(`test/e2e-ui.mjs`, `test/e2e-lock.mjs`, `test/e2e-adopt.mjs`)를 로컬 서버·에이전트로 돌린다.

## 4. (운영자 규칙) 커밋·push·배포·재시작은 알아서 끝까지

§0 에서 운영자 저장소일 때만 따른다.

사용자가 허락했다(2026-10-10): **커밋, `main` push, 배포 확인, 재시작까지 묻지 않고 한 번에 끝낸다.** 받은 작업은 그 턴에 배포까지 마친다.

1. 위 §1(SPEC)·§2(금지)·§3(검증)을 모두 통과한 뒤 커밋한다. 하나라도 실패하면 push 하지 않고 고친다.
2. `git push origin main`. `main` 에 push 하면 Dokploy 가 서버를 자동 배포한다(start-first, 끊김 없음).
3. 배포가 끝났는지 확인한다: Dokploy 의 최신 배포 상태가 `done` 이고, `https://bridge.creco.dev/api/health` 가 200 이며, 바뀐 화면·경로가 실제로 보이는지 본다. `error` 면 로그를 보고 고쳐서 다시 올린다.
4. 에이전트(`agent/`)를 고쳤으면: 배포되면 맥의 에이전트가 스스로 새 버전으로 바뀐다(SPEC REQ-F-368). 세션이 쉬기를 기다리지 않는다. 에이전트 자신의 몇 초짜리 동작(전달 확인·뜨는 중·다시 여는 중)만 끝나면, 길어도 60 s 뒤 바로 바꾼다. 일하던 세션의 턴·카드·대기·화면 값은 handoff.json 으로 넘어가고, 헤드리스 연동 Chrome 은 다음 에이전트가 이어받아 연결이 끊기지 않는다. 그러니 일하는 세션이 있어도 기다리지 않는다. 확인할 것: `~/.claude-bridge/agent.mjs` 에 바뀐 코드가 들어갔는지, 호스트가 연결돼 있는지. 바로 바꿔야 하면 사이트의 "다시 시작"(`POST /api/hosts/<id>/heal` `{action:'restart'}`)을 쓴다. `kill`·`launchctl kickstart` 는 쓰지 않는다(handoff 를 쓰지 않고 끝나 Chrome 까지 닫힌다).
5. 끝나면 무엇을 올렸고 어떻게 확인했는지 사용자에게 알린다.

- 예외: 데이터 삭제·되돌릴 수 없는 운영 작업(볼륨·DB·Dokploy 설정 변경, `git reset`·강제 push)은 여전히 먼저 묻는다.
- Dokploy 응답에는 비밀값(환경 변수, 키)이 들어 있다. 출력·로그·대화에 옮기지 않는다.

## 5. (운영자 규칙) 작업은 항상 worktree 에서

§0 에서 운영자 저장소일 때만 따른다(기여자도 worktree 를 써도 되지만 올리는 곳은 §7).

main 체크아웃(저장소 루트)에서는 파일을 고치거나 커밋하지 않는다. `.claude/settings.json` 의 훅(`scripts/require-worktree.sh`)이 main 체크아웃에서의 Edit·Write·커밋·푸시·파일 쓰기를 막는다.

1. 작업을 시작하면 먼저 `EnterWorktree`(이름은 작업 주제, 예: `group-tree`)로 worktree 를 만든다. `.claude/worktrees/<이름>` 에 `origin/main` 에서 갈라진 브랜치가 생기고 세션이 그리로 옮겨 간다.
2. 거기서 고치고, 빌드(`cd ui && corepack yarn install && corepack yarn build` — worktree 마다 `node_modules` 가 따로 필요하다)·`npm test`·e2e 를 돌리고, 커밋한다.
3. 올릴 때: `git pull --rebase origin main` 뒤 `git push origin HEAD:main`. main 에 올라가면 자동 배포된다(§4). 충돌이 나면 거기서 풀고 다시 올린다.
4. 끝나면 `ExitWorktree`(`remove`)로 정리한다. 이어서 할 일이 있으면 `keep`.
5. 같은 저장소를 여러 세션이 동시에 고치므로, 한 worktree 가 한 작업이다. 다른 세션의 worktree 를 건드리지 않는다.

## 6. SVG 아이콘 기준

새 아이콘을 그리거나 고칠 때(`ui/src/kit/icons.tsx`) 이 기준을 지킨다. 2026-10-11 사용자가 정했다.

1. **크기는 18 px 하나(기본값).** `Icon`·`IconButton` 은 크기를 받지 않는다. 자리가 좁다고 아이콘을 줄이지 말고 자리를 맞춘다. 사용자는 설정 → 이 기기 → 아이콘에서 크기(14~24 px)와 채움을 바꿀 수 있고, 계정에 저장된다(CSS 변수 `--icon`·`--icon-fill`, REQ-F-728). 그래서 아이콘 크기에 기대는 자리는 `18px` 대신 `var(--icon)` 으로 쓴다.
2. **그림은 24×24 칸에, 선 두께 2.2, 끝과 꺾임은 둥글게, 글자색(`currentColor`).**
3. **그려진 부분(선 두께 포함)의 긴 변이 아이콘 전체 평균으로 24칸의 약 81%**(상자형 아이콘은 약 90%, 사방 약 2칸 여백, 흔한 아이콘 세트의 20칸 기준과 같은 정도). 어떤 아이콘도 96% 를 넘지 않는다.
4. 화살표·닫기·더하기처럼 원래 가벼운 그림은 상자형 아이콘보다 작게 둔다(대략 57~67%). 모든 아이콘을 같은 크기로 늘리지 않는다.
5. 새 아이콘을 넣으면 그려진 범위를 재서(브라우저 `getBBox` + 선 두께) 위 범위에 드는지 확인한다.

## 7. 기여자 규칙

§0 에서 운영자 저장소가 아닐 때 따른다.

1. 자기 포크에서 브랜치를 만들어 작업한다(`git switch -c <주제>`). `main` 에 직접 커밋·push 하지 않는다.
2. §1(SPEC·`changes.ts`)·§2(금지)·§3(빌드·`npm test`·e2e)은 똑같이 지킨다. e2e 는 로컬 서버·에이전트로만 돌린다.
3. 에이전트(`agent/`)를 고쳤으면 서명하지 않는다. `agent/agent.sig`·`agent/keys.mjs` 는 PR 에 넣지 않고, `npm test` 의 서명 시험(`test/unit/agent-sign.test.mjs`)만 실패하는 것은 괜찮다(PR 본문에 적는다). 메인테이너가 병합 뒤 자기 키로 서명한다. 자기 서버를 따로 운영하는 포크라면 README 의 "자기 서명 키 만들기"를 따르되, 그 키 변경은 원 저장소 PR 에 넣지 않는다.
4. 올릴 때: 자기 포크로 push 하고 `CreatiCoding/agent-bridge` 의 `main` 으로 PR 을 연다. PR 에 무엇을 바꿨고 어떻게 확인했는지 적는다.
5. 운영 서버(배포 확인, `/api/hosts/<id>/heal`, Dokploy), TestFlight 업로드(`scripts/testflight.sh`), 운영 데이터는 쓰지 않는다.
