// The bridge page: shows what the relay between this Mac's agent and the web server is doing, and is where the
// link the agent opens lands (it carries the agent's port and key). The relay itself is web/relay.js, which the
// control page runs too — so this tab does not have to stay open if another tab of the site does.
import { startRelay, saveAgentInfo, agentInfo } from './relay.js'

const $ = (id) => document.getElementById(id)
function setLink(which, state, text) {
  $(`dot-${which}`).className = `dot ${state}`
  $(`${which}-text`).textContent = text
}
function log(text) {
  const el = $('log')
  el.textContent = `${new Date().toLocaleTimeString()} ${text}\n${el.textContent}`.slice(0, 4000)
}

// The agent prints a link that carries its port and key in the fragment, which never reaches the server.
// `bg=1`: this page is the agent's own headless browser ("헤드리스 연동 모드"); it may carry only the port, the
// key being kept in that browser's profile from its first start.
const hash = new URLSearchParams(location.hash.slice(1))
const background = hash.get('bg') === '1'
const openedByAgent = hash.has('key')
if (openedByAgent) saveAgentInfo(hash.get('port'), hash.get('key'))
else if (hash.get('port') && agentInfo()) saveAgentInfo(hash.get('port'), agentInfo().key)
if (location.hash) history.replaceState(null, '', location.pathname)

const meRes = await fetch('/api/me').catch(() => null)
const me = meRes?.ok ? await meRes.json() : null
// A header-only server (auth.headerOnly, REQ-F-816) has no sign-in page: the proxy in front signs in. Its 401 says so.
const proxyOnly = me ? me.features?.background === false : (await meRes?.json().catch(() => null))?.headerOnly === true
const AGAIN = '이 서버는 사내 로그인(프록시)으로만 들어와요. 프록시를 거쳐 이 페이지를 다시 열어 주세요'
// Nobody is at a background browser to sign in: it waits, and the agent reports it is not linked.
if (!me && !background) {
  if (proxyOnly) $('summary').textContent = AGAIN
  else location.href = '/api/auth/github?next=/bridge'
}

$('install').textContent = `curl -fsSL ${location.origin}/install.sh | bash`
$('copy').onclick = () => navigator.clipboard.writeText($('install').textContent).then(() => ($('copy').textContent = '복사됨'))
$('takeover').onclick = () => {
  sessionStorage.setItem('cb.takeover', '1')
  location.reload()
}
const takeover = openedByAgent || sessionStorage.getItem('cb.takeover') === '1'
sessionStorage.removeItem('cb.takeover')

if (me && !agentInfo()) {
  setLink('agent', 'off', '연결 정보 없음')
  setLink('server', 'wait', '대기')
  $('setup').hidden = false
} else if (me)
  startRelay(
    {
      link: setLink,
      log,
      login: () =>
        proxyOnly
          ? log(background ? '헤더 로그인만 쓰는 서버라 헤드리스 연동을 쓸 수 없습니다. 기기 화면에서 "헤드리스 연동 모드" 를 꺼 주세요' : AGAIN)
          : background
            ? log('로그인이 끝났습니다. 기기 화면에서 "헤드리스 연동 모드" 를 껐다가 다시 켜 주세요')
            : (location.href = '/api/auth/github?next=/bridge'),
      hello(msg) {
        $('summary').textContent = `${msg.name} · 세션 ${msg.sessions.length}개 · ${me.user.login}`
        document.title = `연동: ${msg.name}`
      },
      agentOpen() {
        $('setup').hidden = true
        $('permission').hidden = true
        $('takeover').hidden = true
      },
      agentError({ perm, safari }) {
        $('permission').hidden = perm !== 'denied' && perm !== 'prompt' && !safari
        $('permission').textContent = safari
          ? 'Safari 는 이 페이지가 맥의 에이전트(127.0.0.1)에 붙는 것을 막을 수 있습니다. 에이전트가 켜져 있는데도 연결되지 않으면 이 주소를 Chrome 에서 열어 주세요.'
          : perm === 'denied'
            ? '브라우저가 이 사이트의 로컬 네트워크 접근을 막고 있습니다. 주소창 왼쪽의 사이트 설정에서 "로컬 네트워크 접근"을 허용으로 바꾼 뒤 새로고침해 주세요.'
            : '브라우저가 "로컬 네트워크의 기기에 연결" 을 허용할지 물으면 허용을 눌러 주세요. 이 맥의 에이전트(127.0.0.1)에 붙는 데 필요합니다.'
        $('setup').hidden = perm === 'denied'
      },
      stood(_text, offerTakeover) {
        $('setup').hidden = true
        $('takeover').hidden = !offerTakeover
      },
    },
    background ? { takeover: true, persistent: true, background: true } : { takeover, confirmLeave: true },
  )
