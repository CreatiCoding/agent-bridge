// The small signed-out pages the server writes itself (REQ-F-767, REQ-F-768): the sign-in page's footer and the
// page a GitHub account that is not allowed yet lands on. Drawn like the sign-in page (web/login.css .panel).

/** The app's name as people see it; code, paths and the repository keep `claude-bridge` (REQ-F-768). */
export const APP_NAME = 'Agent Bridge'

/** Where questions and deletion requests go; also in web/privacy.html. Set by the operator (2026-10-18). */
const CONTACT = 'nodejsdeveloper@kakao.com'

/**
 * Where this server's source is (REQ-F-791, AGPL-3.0 section 13: people who use it over the network can get the
 * source). `BRIDGE_SOURCE_URL` for a fork; only http(s) addresses, anything else falls back to the default.
 */
export const SOURCE_URL = /^https?:\/\/[^\s"<>]+$/.test(process.env.BRIDGE_SOURCE_URL || '') ? process.env.BRIDGE_SOURCE_URL : 'https://github.com/CreatiCoding/agent-bridge'

const esc =(s) => String(s).replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`)

/** Under every signed-out page: where the privacy policy and support are, and that this is not Anthropic's. */
export const FOOTER = `<p class="muted" style="margin:20px 0 0;font-size:var(--fs-small)"><a href="/privacy">개인정보 처리방침 · Privacy Policy</a> · <a href="/support">지원 · Support</a> · <a href="${SOURCE_URL.replace(/&/g, '&amp;')}">소스 코드 · Source</a></p><p class="muted" style="margin:6px 0 0;font-size:var(--fs-small)">Anthropic 과 무관한 독립 프로젝트예요. Claude 는 Anthropic 의 상표입니다.<br>An independent project, not affiliated with Anthropic. Claude is a trademark of Anthropic.</p>`

const shell = (title, body) =>
  `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title} · ${APP_NAME}</title><script src="/theme.js"></script><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/login.css"><body class="bridge-login"><div class="panel">${body}${FOOTER}</div></body></html>`

/**
 * A GitHub account an operator has not allowed yet (REQ-F-769): instead of a dead end, what this is, what it needs,
 * what happens once allowed, and what can be done meanwhile. `demo`: the public demo is on (REQ-F-766).
 * `apple`: an Apple account from the iOS app (REQ-F-772), named by its name or e-mail, signing in again from the app.
 */
/**
 * 공개 데모 (REQ-F-766): one press, no id or password, into a demo of the visitor's own. A form, so no script is needed
 * and the press is a POST from this site (IF-222). As plain to see as the GitHub button.
 */
export const DEMO_BUTTON = '<form method="post" action="/api/auth/demo" style="margin:10px 0 0"><button class="btn" type="submit" style="width:100%;text-align:center">데모로 둘러보기</button><p class="muted" style="margin:8px 0 0;font-size:var(--fs-small)">맥 없이, 로그인 없이 정해진 데모 화면으로 둘러봐요.</p></form>'

export function pendingPage({ login, demo, apple = false }) {
  const kind = apple ? 'Apple' : 'GitHub'
  const li = (t) => `<li style="margin:6px 0">${t}</li>`
  return shell(
    '승인을 기다리는 중',
    `<h1>승인을 기다리는 중이에요</h1>
<p>${kind} 계정 <b>${esc(login)}</b> 의 사용 요청이 이 서버의 운영자에게 전달됐어요.</p>
<h2 style="font-size:var(--fs-large);margin:20px 0 6px">${APP_NAME} 는</h2>
<p style="margin:0">내 맥에서 도는 Claude Code 세션을 폰과 웹에서 이어서 보고 조작하는 도구예요. 세션은 언제나 내 맥에서 돌고, 이 사이트는 그 화면을 옮겨 줄 뿐이에요.</p>
<h2 style="font-size:var(--fs-large);margin:20px 0 6px">쓰려면 필요한 것</h2>
<ol style="margin:0;padding-left:20px">${li('Claude Code 가 깔린 <b>맥</b> 한 대')}${li('그 맥에 까는 <b>에이전트</b>(승인 뒤 <a href="/guide">시작 가이드</a> 를 따라 터미널 한 줄로 깔아요)')}${li('이 서버 <b>운영자의 승인</b>')}</ol>
<h2 style="font-size:var(--fs-large);margin:20px 0 6px">승인되면</h2>
<p style="margin:0">다시 <b>${apple ? 'Apple로 로그인' : 'GitHub 로 로그인'}</b> 하면 바로 들어가요. 따로 알림은 가지 않으니, 운영자에게 받은 연락이 있거나 시간이 지난 뒤 다시 로그인해 보세요.</p>
<h2 style="font-size:var(--fs-large);margin:20px 0 6px">그동안 할 수 있는 것</h2>
<ul style="margin:0;padding-left:20px">${li('<a href="/guide">시작 가이드</a> 에서 무엇을 하는 도구인지, 어떻게 까는지 미리 보기')}${demo ? li('아래 <b>데모로 둘러보기</b> 로 맥 없이 데모 맥과 세션을 바로 둘러보기') : ''}${li('<a href="/privacy">개인정보 처리방침</a> 에서 이 서버가 무엇을 저장하는지 보기')}${li(`궁금한 점이나 요청 기록 삭제는 <a href="mailto:${CONTACT}">${CONTACT}</a> 로 문의하기`)}</ul>
<a class="btn primary" href="${apple ? '/' : '/api/auth/github'}" style="display:inline-block;margin-top:20px">다시 로그인</a>${demo ? DEMO_BUTTON : ''}
<p class="muted" style="margin:16px 0 0;font-size:var(--fs-small)">Waiting for approval: the operator of this server has been asked to allow your ${kind} account. ${APP_NAME} lets you watch and drive the Claude Code sessions running on your own Mac from a phone or the web; it needs a Mac with Claude Code, its agent, and the operator's approval. Once allowed, sign in with ${kind} again. Questions: <a href="mailto:${CONTACT}">${CONTACT}</a></p>`,
  )
}

/**
 * 지원 (REQ-F-783): the App Store support URL, readable signed out at /support. Drawn like web/privacy.html (same
 * style, light and dark), no script. What it is, how to start, a few questions, where to write, the privacy policy.
 */
export function supportPage() {
  const qa = (q, a) => `<h3>${q}</h3><p>${a}</p>`
  return `<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<title>지원 · ${APP_NAME}</title>
<meta name="description" content="${APP_NAME} 지원: 시작 방법, 자주 묻는 것, 문의. Support for ${APP_NAME}.">
<style>
:root{--fs-small:13px;--fs-large:16px;--fs-xlarge:22px;--bg:#faf9f5;--text:#1f1e1d;--muted:#6b6a65;--line:rgba(127,127,127,.28);--card:rgba(127,127,127,.08)}
@media (prefers-color-scheme:dark){:root{--bg:#262624;--text:#ecebe6;--muted:#a3a19a}}
body{margin:0;background:var(--bg);color:var(--text);font:var(--fs-large)/1.7 -apple-system,system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:var(--fs-xlarge);margin:8px 0 4px}
h2{font-size:var(--fs-large);margin:32px 0 8px}
h3{font-size:var(--fs-large);margin:20px 0 6px}
p,li{overflow-wrap:anywhere}
li{margin:4px 0}
a{color:inherit}
.muted{color:var(--muted);font-size:var(--fs-small)}
.box{border:1px solid var(--line);border-radius:12px;padding:12px 16px;background:var(--card)}
</style>
<main>
<p class="muted"><a href="/">← ${APP_NAME}</a> · <a href="#en">English summary</a></p>
<h1>지원</h1>
<div class="box">
<p style="margin:0"><b>${APP_NAME}</b> 는 내 맥에서 도는 Claude Code 세션을 폰과 웹에서 이어서 보고 조작하는 도구예요. 세션은 언제나 내 맥에서 돌고, 이 앱은 그 화면을 옮겨 줄 뿐이에요.</p>
</div>

<h2>시작하기</h2>
<p><a href="/guide">시작 가이드</a> 에 무엇이 필요한지와 까는 법이 순서대로 있어요. Claude Code 가 깔린 맥 한 대와, 그 맥에 까는 에이전트가 필요해요.</p>

<h2>자주 묻는 것</h2>
${qa('맥은 어떻게 연결하나요?', '로그인한 뒤 <a href="/guide">시작 가이드</a> 의 터미널 한 줄을 맥에서 실행하면 에이전트가 깔리고, 그 맥이 내 계정에 연결돼요. 연결된 맥은 설정 → 더 보기 → 기기에서 볼 수 있어요.')}
${qa('앱 알림은 어디서 켜나요?', '앱에서 <b>설정 → 이 기기 → 이 기기로 앱 알림</b> 스위치를 켜요. 처음 켤 때 알림 허락을 물어요. 결정을 기다리는 세션, 끝난 작업 같은 알림이 와요.')}
${qa('새 버전은 어떻게 받나요?', 'TestFlight 나 App Store 에서 앱을 업데이트해요. 앱이 옛 빌드면 화면에 업데이트 안내가 떠요.')}
${qa('계정은 어떻게 지우나요?', '앱에서 <b>설정 → 더 보기 → 계정 삭제</b> 를 눌러요. 확인 뒤 이 서버에 있는 내 계정과 기록이 바로 지워져요. 맥에 있는 대화 파일·작업 폴더는 건드리지 않아요.')}

<h2>문의</h2>
<p>궁금한 점, 문제 제보, 기록 삭제 요청은 <a href="mailto:${CONTACT}">${CONTACT}</a> 로 보내 주세요.</p>
<p>무엇을 저장하고 얼마나 보관하는지는 <a href="/privacy">개인정보 처리방침</a> 에 있어요.</p>

<section id="en">
<h2>English summary</h2>
<p>${APP_NAME} lets you watch and drive the Claude Code sessions running on your own Mac from your phone or the web. Sessions always run on your Mac. To start, follow the <a href="/guide">guide</a>: you need a Mac with Claude Code and a small agent installed with one terminal line. Turn on app notifications in Settings → 이 기기 (This device) → 이 기기로 앱 알림. Update the app from TestFlight or the App Store. Delete your account in Settings → 더 보기 (More) → 계정 삭제 (Delete account). Questions: <a href="mailto:${CONTACT}">${CONTACT}</a>. See also the <a href="/privacy">Privacy Policy</a>.</p>
</section>
${FOOTER}
</main>
</html>`
}
