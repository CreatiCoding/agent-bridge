// End-to-end check of 로컬 전체 화면 (local --full, REQ-F-900~902, REQ-S-103~105) on this Mac: a site (this checkout's
// server, BRIDGE_DEV_LOGIN, on its own port) hands out the signed Mac build; an installed agent (its files copied into
// a fresh CLAUDE_BRIDGE_HOME) is linked to that site by a stand-in for the bridge tab; `local --full on` takes the
// build, the agent switches to its own local server, the one-time link signs in, what must be turned away is, the
// web screen is served, and `local --full off` brings the link back to the site. The running agent (~/.claude-bridge)
// is not touched. Needs docker (the Mac build is made as the image makes it) and the signed server/localfull.json:
//   node test/e2e-localfull.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Relay, sseMessages, archOf } from '../agent/localfull.mjs'
import { buildLocalFull } from '../scripts/sign-agent.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SITE_PORT = Number(process.env.SITE_PORT || 4393)
const AGENT_PORT = Number(process.env.PORT || 4392)
const LOCAL_PORT = AGENT_PORT + 10
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)))
const home = tmp('cb-lf-home-')
const siteRoot = tmp('cb-lf-site-')
const siteData = tmp('cb-lf-data-')
const tmuxDir = tmp('cb-lf-tmux-')
const step = (s) => console.log(`\n== ${s}`)
let fails = 0
const ok = (cond, what) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`)
  if (!cond) fails++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (f, ms = 20000, what = '') => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await f()) return true
    await sleep(300)
  }
  throw new Error(`기다리다 끝남: ${what}`)
}
/** A request with the Host and headers given (fetch cannot set Host). */
const raw = (port, p, { method = 'GET', headers = {}, body } = {}) =>
  new Promise((res) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (x) => {
      let b = ''
      x.on('data', (c) => (b += c))
      x.on('end', () => res({ status: x.statusCode, headers: x.headers, body: b }))
    })
    r.on('error', () => res({ status: 0, headers: {}, body: '' }))
    if (body) r.write(body)
    r.end()
  })

const kids = []
let agentOut = ''
let streamSample = ''
const arch = archOf()
try {
  if (!arch) throw new Error('macOS 에서만 돌아요')
  step('the site: this checkout, with the Mac builds made as the image makes them')
  for (const d of ['agent', 'web', 'ui', 'server', 'package.json']) fs.symlinkSync(path.join(ROOT, d), path.join(siteRoot, d))
  fs.mkdirSync(path.join(siteRoot, 'localfull'))
  buildLocalFull(path.join(siteRoot, 'localfull'))
  const siteBin = path.join(siteRoot, 'bridge-server-site')
  execFileSync('go', ['build', '-o', siteBin, '.'], { cwd: path.join(ROOT, 'server'), stdio: 'inherit' })
  const site = spawn(siteBin, [], { env: { ...process.env, PORT: String(SITE_PORT), BRIDGE_DATA: siteData, BRIDGE_ROOT: siteRoot, BRIDGE_DEV_LOGIN: '1', GITHUB_ALLOWED_LOGINS: 'lfe2e' }, stdio: ['ignore', 'pipe', 'pipe'] })
  kids.push(site)
  let siteOut = ''
  site.stdout.on('data', (b) => (siteOut += b))
  site.stderr.on('data', (b) => (siteOut += b))
  const SITE = `http://127.0.0.1:${SITE_PORT}`
  await until(() => fetch(`${SITE}/api/health`).then((r) => r.ok).catch(() => false), 20000, 'site')
  ok((await fetch(`${SITE}/localfull/${arch}.json`)).status === 200, `사이트가 서명된 ${arch} 빌드를 내줌 ${siteOut.includes('localfull') ? '' : ''}`)
  const dev = await fetch(`${SITE}/api/auth/dev?login=lfe2e`, { redirect: 'manual' })
  const siteCookie = /(?:__Host-)?cb=[^;]+/.exec(dev.headers.get('set-cookie') ?? '')?.[0]
  ok(!!siteCookie, '사이트에 개발 로그인')

  step('an installed agent, linked to the site by a stand-in for its bridge tab')
  const files = JSON.parse(/const AGENT_FILES = (\[[^\]]+\])/.exec(fs.readFileSync(path.join(ROOT, 'agent/agent.mjs'), 'utf8'))[1].replace(/'/g, '"'))
  for (const f of files) fs.copyFileSync(path.join(ROOT, 'agent', f), path.join(home, f))
  const env = { ...process.env, CLAUDE_BRIDGE_HOME: home, TMUX_TMPDIR: tmuxDir }
  delete env.TMUX
  const AGENT = path.join(home, 'agent.mjs')
  const agent = spawn(process.execPath, [AGENT, SITE, '--port', String(AGENT_PORT), '--no-open', '--mux', 'tmux', '--name', 'e2e-localfull'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  kids.push(agent)
  agent.stdout.on('data', (b) => (agentOut += b))
  agent.stderr.on('data', (b) => (agentOut += b))
  const A = `http://127.0.0.1:${AGENT_PORT}`
  await until(() => fetch(`${A}/ping`).then((r) => r.ok).catch(() => false), 20000, 'agent')
  const key = () => JSON.parse(fs.readFileSync(path.join(home, 'agent.json'), 'utf8')).key
  /** The site's bridge tab, as web/relay.js does it, in this test: the agent's stream up, the site's commands down. */
  function siteTab() {
    const ac = new AbortController()
    const said = []
    const relay = new Relay({ base: SITE, secret: '', auth: { Cookie: siteCookie }, toAgent: (cmd) => fetch(`${A}/cmd?key=${encodeURIComponent(key())}&tab=e2e`, { method: 'POST', body: JSON.stringify(cmd) }), saveFile: async () => '' })
    relay.start()
    ;(async () => {
      const r = await fetch(`${A}/events?key=${encodeURIComponent(key())}&tab=e2e&takeover=1`, { signal: ac.signal })
      let buf = ''
      const dec = new TextDecoder()
      for await (const c of r.body) {
        const { msgs, rest } = sseMessages(buf + dec.decode(c, { stream: true }))
        buf = rest
        for (const m of msgs) (said.push(m), relay.fromAgent(m))
      }
    })().catch(() => {})
    return { said, stop: () => (ac.abort(), relay.stop()) }
  }
  const hostId = JSON.parse(fs.readFileSync(path.join(home, 'agent.json'), 'utf8')).hostId
  /** Whether a server shows this Mac online, from the first state its page stream sends. */
  const online = async (base, headers) => {
    const ac = new AbortController()
    try {
      const r = await fetch(`${base}/api/classic/stream`, { headers, signal: ac.signal })
      let buf = ''
      const dec = new TextDecoder()
      const end = Date.now() + 4000
      for await (const c of r.body) {
        buf += dec.decode(c, { stream: true })
        streamSample = buf.slice(0, 1500)
        const { msgs, rest } = sseMessages(buf)
        buf = rest
        const st = msgs.find((m) => m?.t === 'state' && Array.isArray(m.hosts))
        if (st) return st.hosts.find((h) => h.id === hostId)?.online === true
        if (Date.now() > end) return false
      }
      return false
    } catch {
      return false
    } finally {
      ac.abort()
    }
  }
  let tab = siteTab()
  await until(() => online(SITE, { Cookie: siteCookie }), 20000, '사이트에 연결')
  ok(true, '사이트 탭으로 사이트에 연결됨')

  step('local --full on: the signed build from the site, then the switch')
  const on = spawnSync(process.execPath, [AGENT, 'local', '--full', 'on', '--no-open', '--port', String(AGENT_PORT)], { env, encoding: 'utf8', timeout: 120_000 })
  console.log(on.stdout.trim().split('\n').map((l) => `  | ${l}`).join('\n'))
  ok(on.status === 0, `local --full on 이 끝남 (${on.status}) ${on.stderr.trim()}`)
  const t1 = /#t=([A-Za-z0-9_-]{43})/.exec(on.stdout)?.[1]
  ok(!!t1, '일회용 링크를 줌')
  ok(await until(() => tab.said.some((m) => m.t === 'replaced'), 5000).catch(() => false), '사이트 탭은 넘겨받음(replaced)을 들음')
  const ev = await fetch(`${A}/events?key=${encodeURIComponent(key())}&tab=other`).then((r) => r.text())
  ok(/"busy".*"local":true/.test(ev), `사이트의 다른 탭은 로컬 연동 중이라 거절됨: ${ev.trim()}`)
  ok((await fetch(`${A}/cmd?key=${encodeURIComponent(key())}&tab=other`, { method: 'POST', body: '{"t":"ping"}' })).status === 409, '사이트 탭의 명령은 409')
  tab.stop()
  const L = LOCAL_PORT
  ok((await raw(L, '/api/health')).status === 200, `로컬 서버가 127.0.0.1:${L} 에서 답함`)
  const listen = spawnSync('lsof', ['-nP', `-iTCP:${L}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout
  ok(/127\.0\.0\.1:/.test(listen) && !/\*:/.test(listen), `127.0.0.1 에만 열림: ${listen.split('\n')[1]?.trim()}`)
  ok(fs.statSync(path.join(home, 'localfull')).mode % 0o1000 === 0o700, 'localfull 폴더 0700')

  step('who is turned away')
  ok((await raw(L, '/api/me')).status === 401, '링크 없이 API 401')
  ok((await raw(L, '/', { headers: { Host: `evil.example:${L}` } })).status === 403, '다른 Host(리바인딩) 403')
  const login = (t, headers = {}) => raw(L, '/api/local/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-UI': '1', ...headers }, body: JSON.stringify({ ticket: t }) })
  ok((await login(t1, { Origin: 'https://evil.example' })).status === 403, '다른 Origin 403')
  ok((await login(t1, { Origin: `http://127.0.0.1:${AGENT_PORT}` })).status === 403, '같은 맥의 다른 포트 Origin 403')
  ok((await raw(L, '/api/local/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: t1 }) })).status === 403, 'X-Local-UI 없이 403')
  ok((await raw(L, '/api/bridge/hello', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key()}` }, body: JSON.stringify({ hostId, name: 'x' }) })).status === 401, '에이전트의 연동 키로는 연동 경로 401')

  step('the one-time link')
  const r1 = await login(t1)
  ok(r1.status === 200, `링크로 로그인 (${r1.status} ${r1.body})`)
  const cookie = String(r1.headers['set-cookie']?.[0] ?? '').split(';')[0]
  ok(cookie.startsWith(`__Host-cb-l${L}=`) && /SameSite=Strict/.test(r1.headers['set-cookie']?.[0]) && /HttpOnly/.test(r1.headers['set-cookie']?.[0]), `이 포트만의 HttpOnly·Strict 쿠키`)
  ok((await login(t1)).status === 403, '같은 링크는 두 번 쓰지 못함')
  const me = await raw(L, '/api/me', { headers: { Cookie: cookie } })
  ok(me.status === 200 && me.body.includes('"local"'), '쿠키로 주인')
  ok((await raw(L, '/api/bridge/hello', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ hostId, name: 'x' }) })).status === 401, '주인 쿠키로는 연동 경로 401')
  const page = await raw(L, '/', { headers: { Cookie: cookie } })
  ok(page.status === 200 && page.body.includes('<div id="root">'), '웹 화면(ui) 을 내줌')
  ok(/script-src 'self'/.test(page.headers['content-security-policy'] ?? '') && /connect-src 'self';/.test(page.headers['content-security-policy'] ?? ''), `로컬 화면의 CSP: ${page.headers['content-security-policy']}`)
  ok(await online(`http://127.0.0.1:${L}`, { Cookie: cookie, Host: `127.0.0.1:${L}` }), '로컬 서버에서 이 맥이 연결됨')
  ok(!(await online(SITE, { Cookie: siteCookie })), '사이트에서는 이 맥이 끊김(동시 연결 없음)')
  const t2 = /#t=([A-Za-z0-9_-]{43})/.exec(spawnSync(process.execPath, [AGENT, 'local', '--full', 'open', '--no-open', '--port', String(AGENT_PORT)], { env, encoding: 'utf8' }).stdout)?.[1]
  ok(!!t2, 'local --full open 이 새 링크를 줌')
  console.log(`\n브라우저로 볼 링크(5분, 한 번): http://127.0.0.1:${L}/#t=${t2}`)
  if (process.env.HOLD) await sleep(Number(process.env.HOLD) * 1000)

  step('local --full off: back to the site')
  const off = spawnSync(process.execPath, [AGENT, 'local', '--full', 'off', '--no-open', '--port', String(AGENT_PORT)], { env, encoding: 'utf8', timeout: 60_000 })
  ok(off.status === 0, `local --full off (${off.stdout.trim()})`)
  await until(async () => (await raw(L, '/api/health')).status === 0, 10000, '로컬 서버 내림')
  ok(true, '로컬 서버가 내려감')
  tab = siteTab()
  await until(() => online(SITE, { Cookie: siteCookie }), 20000, '사이트에 다시 연결')
  ok(true, '사이트 탭이 다시 붙어 사이트에 연결됨')
  tab.stop()
  if (fails) console.log(`\n--- agent log ---\n${agentOut.slice(-3000)}`)
} catch (e) {
  fails++
  console.log(`FAIL ${e.message}`)
  console.log(`--- stream ---\n${streamSample}\n--- agent ---\n${agentOut.slice(-2500)}`)
} finally {
  for (const k of kids) k.kill('SIGTERM')
  await sleep(500)
  spawnSync('tmux', ['kill-server'], { env: { ...process.env, TMUX_TMPDIR: tmuxDir } })
  for (const d of [home, siteRoot, siteData, tmuxDir]) fs.rmSync(d, { recursive: true, force: true })
  console.log(fails ? `\n${fails}개 실패` : '\n모두 통과')
  process.exit(fails ? 1 : 0)
}
