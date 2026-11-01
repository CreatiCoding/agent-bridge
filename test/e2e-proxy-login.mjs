// End-to-end (REQ-F-833): a header-only server behind a sign-in proxy, and the headless link signed in through a
// visible window. Starts its own server (built from server/), a fake proxy and a fake sign-in page, and one agent
// with its own home. The fake sign-in page signs a visible browser in at once and keeps a headless one (User-Agent
// HeadlessChrome) on its page, as nobody is there to sign in. Uses this Mac's Chrome (a window opens twice for a few
// seconds) and playwright for one visible tab of the site. No claude session.
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node test/e2e-proxy-login.mjs
import { spawn, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const T = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), 'cb-proxy-'))
const [SERVER, PROXY, SSO, HOOK, AGENT] = [4799, 4798, 4797, 4795, 4796]
const SITE = `http://localhost:${PROXY}`
const SECRET = 'proxy-secret-0123456789'
// SESSION_COOKIE=1: the proxy's cookie has no expiry. Chrome does not keep such a cookie once it quits, so the
// headless browser started after the visible window is not signed in (expected to fail at step 1).
const SESSION_COOKIE = process.env.SESSION_COOKIE === '1'
const ok = (c, w) => (console.log(`${c ? 'PASS' : 'FAIL'} ${w}`), c || (process.exitCode = 1))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(what, fn, ms = 60_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn().catch(() => null)
    if (v) return v
    await wait(1000)
  }
  console.log(`  (기다림 끝: ${what})`)
  return null
}
const procs = []
function cleanup() {
  for (const p of procs) p.kill()
  try {
    execFileSync('/usr/bin/pkill', ['-f', `user-data-dir=${T}/agent/browser`])
  } catch {}
}
process.on('exit', cleanup)

// ---- the fake sign-in proxy: a valid `sso` cookie passes with the trusted headers, anything else goes to SSO ----
const tokens = new Set()
const newToken = () => (tokens.add(`t${crypto.randomBytes(6).toString('hex')}`), [...tokens].at(-1))
http
  .createServer((req, res) => {
    const u = new URL(req.url, SITE)
    if (u.pathname === '/__sso') return res.writeHead(302, { 'Set-Cookie': `sso=${newToken()}; Path=/; HttpOnly${SESSION_COOKIE ? '' : '; Max-Age=3600'}`, Location: u.searchParams.get('back') || '/' }).end()
    const tok = /(?:^|;\s*)sso=([^;]+)/.exec(req.headers.cookie || '')?.[1]
    fs.appendFileSync(path.join(T, 'proxy.log'), `${new Date().toISOString().slice(11, 19)} ${req.method} ${u.pathname} ${/HeadlessChrome/.test(req.headers['user-agent'] || '') ? 'headless' : 'visible'} cookie=${tok ?? '-'} ${tokens.has(tok) ? 'ok' : 'no'}\n`)
    if (!tokens.has(tok)) return res.writeHead(302, { Location: `http://127.0.0.1:${SSO}/login?back=${encodeURIComponent(SITE + req.url)}` }).end()
    const up = http.request({ host: '127.0.0.1', port: SERVER, path: req.url, method: req.method, headers: { ...req.headers, 'x-bridge-proxy-secret': SECRET, 'x-auth-request-email': 'tester@example.com' } }, (r) => (res.writeHead(r.statusCode, r.headers), r.pipe(res)))
    up.on('error', () => res.writeHead(502).end())
    req.pipe(up)
  })
  .listen(PROXY)
http
  .createServer((req, res) => {
    const back = new URL(req.url, 'http://x').searchParams.get('back') || SITE
    if (/HeadlessChrome/.test(req.headers['user-agent'] || '')) return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><p>로그인하세요</p>')
    res.writeHead(302, { Location: `${SITE}/__sso?back=${encodeURIComponent(back)}` }).end()
  })
  .listen(SSO)
const hooks = []
http.createServer((req, res) => {
  let b = ''
  req.on('data', (c) => (b += c))
  req.on('end', () => {
    try {
      hooks.push(JSON.parse(b))
    } catch {}
    res.writeHead(200).end()
  })
}).listen(HOOK)

// ---- the server ----
execFileSync('go', ['build', '-o', path.join(T, 'bridge-server'), '.'], { cwd: path.join(REPO, 'server'), stdio: 'inherit' })
fs.mkdirSync(path.join(T, 'data'), { recursive: true })
fs.writeFileSync(
  path.join(T, 'bridge.yaml'),
  `origins:\n  primary: ${SITE}\nauth:\n  allow: [tester@example.com]\n  headerOnly: true\n  providers:\n    - type: trusted-header\n      userHeader: X-Auth-Request-Email\n      secretHeader: X-Bridge-Proxy-Secret\n      secret: ${SECRET}\n      trustFrom: [127.0.0.1/32, ::1/128]\nnotify:\n  - type: webhook\n    url: http://127.0.0.1:${HOOK}/hook\n    secret: hook-secret-0123456789\n    events: [host.login_required]\n`,
)
const out = (name) => fs.openSync(path.join(T, `${name}.log`), 'a')
procs.push(spawn(path.join(T, 'bridge-server'), [], { cwd: REPO, env: { ...process.env, PORT: String(SERVER), BRIDGE_DATA: path.join(T, 'data'), BRIDGE_CONFIG: path.join(T, 'bridge.yaml') }, stdio: ['ignore', out('server'), out('server')] }))
ok(await until('서버', () => fetch(`http://127.0.0.1:${SERVER}/api/health`).then((r) => r.ok)), '서버가 뜸')

// ---- the agent, in its own home ----
const env = { ...process.env, CLAUDE_BRIDGE_HOME: path.join(T, 'agent'), CLAUDE_BRIDGE_SKIP_TOOL_PROMPT: '1', CLAUDE_BRIDGE_LABEL: 'dev.claude-bridge.e2e-proxy' }
procs.push(spawn('node', [path.join(REPO, 'agent/agent.mjs'), SITE, '--port', String(AGENT), '--name', 'ProxyMac', '--no-open', '--no-auto-update', '--no-chrome'], { env, stdio: ['ignore', out('agent'), out('agent')] }))
const cfg = await until('agent.json', async () => JSON.parse(fs.readFileSync(path.join(T, 'agent/agent.json'), 'utf8')).hostId && JSON.parse(fs.readFileSync(path.join(T, 'agent/agent.json'), 'utf8')))
ok(await until('에이전트', () => fetch(`http://127.0.0.1:${AGENT}/ping`).then((r) => r.ok)), '에이전트가 뜸')
const agentLog = () => fs.readFileSync(path.join(T, 'agent/agent.log'), 'utf8')
const logHas = (re) => re.test(agentLog())

// The test's own way in: a cookie the proxy takes, as a person's browser would have.
const mine = newToken()
const status = () => fetch(`${SITE}/api/hosts/${cfg.hostId}/status`, { headers: { Cookie: `sso=${mine}` } }).then((r) => (r.ok ? r.json() : null))
const linkVisible = () => execFileSync('node', [path.join(REPO, 'agent/agent.mjs'), 'link', '--visible'], { env, encoding: 'utf8' })

// 1. link --visible: the visible window signs in at the proxy, links, closes, and the headless one takes over.
const said = linkVisible()
ok(/Chrome 창을 띄웠어요/.test(said), `link --visible 이 창을 띄움: ${said.trim()}`)
ok(await until('보이는 창 연동', async () => logHas(/보이는 창이 연동되어 창을 닫고/), 90_000), '보이는 창이 서버에 붙은 뒤 닫힘')
const linked = await until('헤드리스 연동', async () => {
  const s = await status()
  const b = s?.health?.background
  return b?.connected && b.running && !b.visible ? s : null
}, 90_000)
ok(!!linked, '같은 프로필의 헤드리스가 프록시 쿠키로 붙음')
ok(logHas(/헤드리스 브라우저를 띄움/), '헤드리스를 다시 띄웠다는 로그')

// 2. The proxy forgets the headless browser's sign-in: its page notices and tells the agent.
for (const t of [...tokens]) if (t !== mine) tokens.delete(t)
ok(await until('로그인 필요', async () => logHas(/프록시 로그인을 지나지 못함/), 60_000), '헤드리스 페이지가 로그인 풀림을 알아채 에이전트에 알림')

// 3. A visible tab of the site (signed in on its own) takes the link over, and the server raises the event.
const browser = await chromium.launch({ channel: 'chrome' })
const ctx = await browser.newContext()
await ctx.addCookies([{ name: 'sso', value: mine, domain: 'localhost', path: '/' }])
const tab = await ctx.newPage()
await tab.goto(`${SITE}/bridge#port=${AGENT}&key=${encodeURIComponent(JSON.parse(fs.readFileSync(path.join(T, 'agent/agent.json'), 'utf8')).key)}`)
const hit = await until('이벤트', async () => hooks.find((h) => h.name === 'host.login_required'), 60_000)
ok(!!hit, '서버가 host.login_required 를 냄')
ok(hit?.host?.id === cfg.hostId && /link --visible/.test(hit?.fix ?? '') && hit?.url === `${SITE}/hosts/${cfg.hostId}`, `이벤트 본문: ${JSON.stringify(hit)}`)
const st = await status()
ok(st?.health?.background?.login === 'required', '기기 화면의 health 에 로그인 필요')
ok((st?.health?.features ?? []).some((f) => f.id === 'background' && f.state === 'fail' && f.action === 'visible-login'), '점검 행이 실패이고 보이는 창으로 로그인 동작')

// 4. Signing in again through a visible window clears it and the headless browser links again.
linkVisible()
const back = await until('다시 연동', async () => {
  const s = await status()
  const b = s?.health?.background
  return b?.connected && b.running && !b.visible && !b.login ? s : null
}, 120_000)
ok(!!back, '다시 로그인한 뒤 헤드리스가 붙고 로그인 필요가 지워짐')
ok(hooks.filter((h) => h.name === 'host.login_required').length === 1, '이벤트는 한 번')
await browser.close()
console.log(`로그: ${T}`)
process.exit()
