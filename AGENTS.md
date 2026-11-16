# AGENTS.md

이 저장소의 작업 규칙은 [CLAUDE.md](CLAUDE.md) 에 있다. 모든 에이전트는 그 규칙(SPEC 갱신, worktree, 검증, 배포, SVG 아이콘 기준 §6)을 따른다.

## iOS 홈 화면 앱(standalone): 상태 표시줄 위 흐림 막기

홈 화면에 추가해서 열면 맨 위 시계·배터리 줄에 흐림(블러) 띠가 생기는 문제. SPEC 1.74·1.163(조작 페이지)과 1.549(REQ-F-919, `web/` 페이지·문서 사이트)에서 맞췄다. 새 화면을 만들 때도 같은 규칙을 지킨다.

- 원인: iOS 26 홈 화면 앱은 화면 맨 위 4px 아래 요소에서 부모로 올라가며 **폭 90% 이상인 `position: fixed`/`sticky` 상자**를 찾는다. 있으면 그 길에서 처음 만난 배경색으로 상태 표시줄을 칠하고, **없으면 흐리게 덮는다.**
- 규칙:
  1. 화면마다 맨 바깥 틀을 `position: fixed; inset: 0`(스크롤은 그 안에서 `overflow: auto`)로 두거나, 상단 바를 폭 100% `position: sticky; top: 0` 로 둔다. 로그인·404 같은 별도 화면도 빠뜨리지 않는다.
  2. 그 틀에서 맨 위 요소까지 가는 길에 **배경색이 있어야 한다.** 모두 투명이면 iOS 가 엉뚱한 색으로 칠한다(1.163).
  3. `viewport` 에 `viewport-fit=cover` 를 쓰지 않는다. 쓰면 내용이 상태 표시줄 밑으로 깔린다(1.70).
  4. `<meta name="theme-color">` 를 라이트·다크 두 개(`media="(prefers-color-scheme: …)"`)로 두고, 값은 맨 위 상단 바(없으면 페이지 바탕)의 배경색과 같게 한다. `<meta name="color-scheme" content="light dark">` 도 둔다. 테마를 JS 로 바꾸면 theme-color 도 같이 바꾼다(REQ-F-182).
- 이 저장소에서 맞춘 곳:
  - 조작 페이지(`ui/`): 틀 `.app` 이 `position: fixed; inset: 0`, theme-color `#faf9f5`/`#262624` 를 `ui/src/main.tsx` 가 `--bg` 로 맞춘다.
  - `web/` 페이지: `body.bridge`(`app.css`)·`body.guide`(`guide.css`)·`.bridge-login`(`login.css`)·`body.sk`(`skills.css`)·처리방침의 `body` 가 fixed 틀. **`body` 를 틀로 쓸 때는 `html` 에 `overflow: hidden` 을 같이 준다**(아니면 body 의 overflow 가 뷰포트로 넘어가 아무것도 스크롤되지 않는다). theme-color 는 `#faf9f5`/`#262624`(스킬 `#f4f5f7`/`#17191e`), 앱에서 고른 테마는 `web/theme.js` 가 load 뒤 맞춘다. `test/unit/web-status-bar.test.mjs` 가 지킨다.
  - 문서 사이트(`website/`, VitePress): 960px 아래에서 `.VPNav` 를 sticky 로, 첫 화면 상단 바에도 바탕색, 목차 바(`.VPLocalNav`)는 그 밑(`theme/style.css`). theme-color `#ffffff`/`#0a0a0b` 를 `theme/index.ts` 가 테마 전환 때 `--vp-nav-bg-color` 로 맞춘다.
- 입력칸: iOS Safari 는 16px 보다 작은 `input`·`textarea` 에 포커스하면 화면을 확대한다. 터치 기기(`@media (pointer: coarse)`)에서는 16px 이상으로 둔다. 연락처·주소 자동완성은 `autocomplete="off"` 를 무시하니, 막아야 하는 대화 입력칸은 `contenteditable="plaintext-only"` 로 만든다.
- 확인: 폰 폭(390px)으로 띄워 `document.elementFromPoint(195, 4)` 에서 부모로 올라가며 fixed/sticky 상자와 배경색이 나오는지 본다. 실제 확인은 iPhone 홈 화면 앱에서 한다.
