// End-to-end check of 사이트와 로컬 서버에 함께 연동 (local --full both, REQ-F-924) on this Mac: a site (this checkout's
// server, BRIDGE_DEV_LOGIN) hands out the signed Mac build; an installed agent is linked to it by a stand-in for the
// bridge tab; `local --full both` starts the local server beside the site instead of in its place. Then: both servers
// show the Mac online and the site's tab is never replaced; a session started on the site appears on the local server
// with its conversation (and the other way round); a favourite and a name set on one reach the other; a session ended
// on one is closed on the other; `local --full off` leaves the site linked. The real `claude` answers through the
// stand-in Messages API (test/fixtures/fake-responses.mjs), so no account is used. The running agent is not touched.
// Needs docker (the Mac build), go, tmux, claude and the signed server/localfull.json:
//   node test/e2e-localfull-both.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Relay, sseMessages, archOf } from '../agent/localfull.mjs'
import { buildLocalFull } from '../scripts/sign-agent.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SITE_PORT = Number(process.env.SITE_PORT || 4395)
const AGENT_PORT = Number(process.env.PORT || 4394)
const FAKE_PORT = Number(process.env.FAKE_PORT || 4397)
const LOCAL_PORT = AGENT_PORT + 10
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)))
const home = tmp('cb-lfb-home-')
const siteRoot = tmp('cb-lfb-site-')
const siteData = tmp('cb-lfb-data-')
const tmuxDir = tmp('cb-lfb-tmux-')
const work = tmp('cb-lfb-work-')
const step = (s) => console.log(`\n== ${s}`)
let fails = 0
const ok = (cond, what) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`)
  if (!cond) fails++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (f, ms = 30000, what = '') => {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    last = await f()
    if (last) return last
    await sleep(400)
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
let sample = ''
const arch = archOf()
try {
  if (!arch) throw new Error('macOS 에서만 돌아요')
  step('the site, the stand-in Messages API, and an installed agent linked to the site')
  for (const d of ['agent', 'web', 'ui', 'server', 'package.json']) fs.symlinkSync(path.join(ROOT, d), path.join(siteRoot, d))
  fs.mkdirSync(path.join(siteRoot, 'localfull'))
  buildLocalFull(path.join(siteRoot, 'localfull'))
  const siteBin = path.join(siteRoot, 'bridge-server-site')
  execFileSync('go', ['build', '-o', siteBin, '.'], { cwd: path.join(ROOT, 'server'), stdio: 'inherit' })
  const site = spawn(siteBin, [], { env: { ...process.env, PORT: String(SITE_PORT), BRIDGE_DATA: siteData, BRIDGE_ROOT: siteRoot, BRIDGE_DEV_LOGIN: '1', GITHUB_ALLOWED_LOGINS: 'lfbe2e' }, stdio: ['ignore', 'pipe', 'pipe'] })
  kids.push(site)
  const fake = spawn(process.execPath, [path.join(ROOT, 'test', 'fixtures', 'fake-responses.mjs'), String(FAKE_PORT)], { stdio: 'ignore' })
  kids.push(fake)
  const SITE = `http://127.0.0.1:${SITE_PORT}`
  await until(() => fetch(`${SITE}/api/health`).then((r) => r.ok).catch(() => false), 20000, 'site')
  const dev = await fetch(`${SITE}/api/auth/dev?login=lfbe2e`, { redirect: 'manual' })
  const siteCookie = /(?:__Host-)?cb=[^;]+/.exec(dev.headers.get('set-cookie') ?? '')?.[0]
  ok(!!siteCookie, '사이트에 개발 로그인')
  const files = JSON.parse(/const AGENT_FILES = (\[[^\]]+\])/.exec(fs.readFileSync(path.join(ROOT, 'agent/agent.mjs'), 'utf8'))[1].replace(/'/g, '"'))
  for (const f of files) fs.copyFileSync(path.join(ROOT, 'agent', f), path.join(home, f))
  const env = { ...process.env, CLAUDE_BRIDGE_HOME: home, TMUX_TMPDIR: tmuxDir, CLAUDECODE: '', ANTHROPIC_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`, ANTHROPIC_AUTH_TOKEN: 'fake', ANTHROPIC_API_KEY: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
  delete env.TMUX
  const AGENT = path.join(home, 'agent.mjs')
  const agent = spawn(process.execPath, [AGENT, SITE, '--port', String(AGENT_PORT), '--no-open', '--no-chrome', '--no-auto-update', '--mux', 'tmux', '--name', 'e2e-both'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  kids.push(agent)
  agent.stdout.on('data', (b) => (agentOut += b))
  agent.stderr.on('data', (b) => (agentOut += b))
  const A = `http://127.0.0.1:${AGENT_PORT}`
  await until(() => fetch(`${A}/ping`).then((r) => r.ok).catch(() => false), 20000, 'agent')
  const key = () => JSON.parse(fs.readFileSync(path.join(home, 'agent.json'), 'utf8')).key
  const hostId = JSON.parse(fs.readFileSync(path.join(home, 'agent.json'), 'utf8')).hostId
  /** The site's bridge tab, as web/relay.js does it: the agent's stream up, the site's commands down. */
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
  /** The first state a server's page stream sends: {host online, sessions}. */
  const state = async (base, headers) => {
    const ac = new AbortController()
    try {
      const r = await fetch(`${base}/api/classic/stream`, { headers, signal: ac.signal })
      let buf = ''
      const dec = new TextDecoder()
      const end = Date.now() + 5000
      let hosts = null
      let sessions = null
      for await (const c of r.body) {
        buf += dec.decode(c, { stream: true })
        const { msgs, rest } = sseMessages(buf)
        buf = rest
        for (const m of msgs) {
          if (Array.isArray(m?.hosts)) hosts = m.hosts
          if (Array.isArray(m?.sessions)) sessions = m.sessions
        }
        if (hosts && sessions) {
          sample = JSON.stringify(sessions).slice(0, 1500)
          return { online: hosts.find((h) => h.id === hostId)?.online === true, sessions }
        }
        if (Date.now() > end) break
      }
      return { online: hosts?.find((h) => h.id === hostId)?.online === true, sessions: sessions ?? [] }
    } catch {
      return { online: false, sessions: [] }
    } finally {
      ac.abort()
    }
  }
  const tab = siteTab()
  const siteH = { Cookie: siteCookie, Origin: SITE }
  await until(async () => (await state(SITE, siteH)).online, 20000, '사이트에 연결')
  ok(true, '사이트 탭으로 사이트에 연결됨')

  step('local --full both: the local server beside the site')
  const on = spawnSync(process.execPath, [AGENT, 'local', '--full', 'both', '--no-open', '--port', String(AGENT_PORT)], { env, encoding: 'utf8', timeout: 120_000 })
  console.log(on.stdout.trim().split('\n').map((l) => `  | ${l}`).join('\n'))
  ok(on.status === 0, `local --full both 이 끝남 (${on.status}) ${on.stderr.trim()}`)
  const t1 = /#t=([A-Za-z0-9_-]{43})/.exec(on.stdout)?.[1]
  ok(!!t1, '일회용 링크를 줌')
  await sleep(3000)
  ok(!tab.said.some((m) => m.t === 'replaced'), '사이트 탭은 끊기지 않음(replaced 없음)')
  ok((await fetch(`${A}/cmd?key=${encodeURIComponent(key())}&tab=e2e`, { method: 'POST', body: '{"t":"ping","ts":1}' })).status === 200, '사이트 탭의 명령은 그대로 받음')
  const L = LOCAL_PORT
  const LO = `http://127.0.0.1:${L}`
  const r1 = await raw(L, '/api/local/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-UI': '1' }, body: JSON.stringify({ ticket: t1 }) })
  ok(r1.status === 200, `로컬 서버에 링크로 로그인 (${r1.status})`)
  const cookie = String(r1.headers['set-cookie']?.[0] ?? '').split(';')[0]
  const localH = { Cookie: cookie, Host: `127.0.0.1:${L}`, Origin: LO }
  await until(async () => (await state(LO, localH)).online, 20000, '로컬 서버에 연결')
  ok(true, '로컬 서버에서 이 맥이 연결됨')
  ok((await state(SITE, siteH)).online, '사이트에서도 이 맥이 그대로 연결됨(함께 연동)')
  const status = spawnSync(process.execPath, [AGENT, 'local', '--full', 'status', '--port', String(AGENT_PORT)], { env, encoding: 'utf8' }).stdout
  ok(/사이트와 로컬 서버.*함께 연동 중/.test(status), `status 가 함께 연동이라고 말함: ${status.trim().split('\n')[0]}`)

  step('a session started on the site appears on the local server, with its conversation')
  const post = (base, headers, p, data) => fetch(`${base}${p}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))
  const localPost = (p, data) => raw(L, p, { method: 'POST', headers: { ...localH, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then((r) => ({ status: r.status, body: (() => { try { return JSON.parse(r.body) } catch { return {} } })() }))
  const s1 = await post(SITE, siteH, '/api/sessions', { hostId, cwd: work, prompt: 'site-hello' })
  ok(s1.status === 200 && s1.body.id, `사이트에서 세션 시작 (${s1.status} ${JSON.stringify(s1.body).slice(0, 200)})`)
  const sid1 = s1.body.id
  const find = async (base, headers, sid) => (await state(base, headers)).sessions.find((x) => x.id === sid)
  const onLocal = await until(async () => {
    const x = await find(LO, localH, sid1)
    return x && /site-hello/.test(JSON.stringify(x)) ? x : null
  }, 60000, '로컬 서버에 사이트 세션과 그 첫 메시지').catch(() => null)
  ok(!!onLocal, `로컬 서버에 사이트에서 시작한 세션이 그 대화와 함께 보임 ${onLocal ? '' : sample}`)
  const onSite = await until(async () => {
    const x = await find(SITE, siteH, sid1)
    return x && /site-hello/.test(JSON.stringify(x)) ? x : null
  }, 30000, '사이트에도 그 첫 메시지').catch(() => null)
  ok(!!onSite, '사이트에도 그대로 보임')

  step('a session started on the local server appears on the site')
  const s2 = await localPost('/api/sessions', { hostId, cwd: work, prompt: 'local-hello' })
  ok(s2.status === 200 && s2.body.id, `로컬 서버에서 세션 시작 (${s2.status} ${JSON.stringify(s2.body).slice(0, 200)})`)
  const sid2 = s2.body.id
  const onSite2 = await until(async () => {
    const x = await find(SITE, siteH, sid2)
    return x && /local-hello/.test(JSON.stringify(x)) ? x : null
  }, 60000, '사이트에 로컬 세션').catch(() => null)
  ok(!!onSite2, `사이트에 로컬 서버에서 시작한 세션이 그 대화와 함께 보임 ${onSite2 ? '' : sample}`)

  step('a favourite and a name set on one server reach the other')
  const fav = await post(SITE, siteH, `/api/sessions/${sid1}/settings`, { favorite: true, title: '사이트에서 붙인 이름' })
  ok(fav.status === 200, `사이트에서 즐겨찾기·이름 (${fav.status})`)
  const favLocal = await until(async () => {
    const x = await find(LO, localH, sid1)
    return x && x.favorite === true && x.title === '사이트에서 붙인 이름' ? x : null
  }, 20000, '로컬에 즐겨찾기').catch(() => null)
  ok(!!favLocal, `로컬 서버에 바로 넘어감 ${favLocal ? '' : sample}`)
  const name2 = await localPost(`/api/sessions/${sid2}/settings`, { favorite: true, title: '로컬에서 붙인 이름' })
  ok(name2.status === 200, `로컬에서 즐겨찾기·이름 (${name2.status})`)
  const favSite = await until(async () => {
    const x = await find(SITE, siteH, sid2)
    return x && x.favorite === true && x.title === '로컬에서 붙인 이름' ? x : null
  }, 20000, '사이트에 즐겨찾기').catch(() => null)
  ok(!!favSite, `사이트에 바로 넘어감 ${favSite ? '' : sample}`)

  step('a message from the local server into the site\'s session reaches both')
  const sent = await localPost(`/api/sessions/${sid1}/send`, { text: 'from-local' })
  ok(sent.status === 200, `로컬에서 사이트 세션에 글 (${sent.status} ${JSON.stringify(sent.body).slice(0, 120)})`)

  step('ended on the local server, closed on the site')
  const end = await localPost(`/api/sessions/${sid2}/do`, { cmd: 'exit' })
  ok(end.status === 200, `로컬에서 종료 (${end.status})`)
  const closedSite = await until(async () => {
    const x = await find(SITE, siteH, sid2)
    return x && (x.closed === true || x.state === 'closed' || x.phase === 'ended') ? x : null
  }, 20000, '사이트에서 닫힘').catch(() => null)
  ok(!!closedSite, `사이트에서도 닫힘 ${closedSite ? '' : sample}`)

  step('local --full off: the site stays linked')
  const off = spawnSync(process.execPath, [AGENT, 'local', '--full', 'off', '--no-open', '--port', String(AGENT_PORT)], { env, encoding: 'utf8', timeout: 60_000 })
  ok(off.status === 0, `local --full off (${off.stdout.trim()})`)
  await until(async () => (await raw(L, '/api/health')).status === 0, 10000, '로컬 서버 내림')
  ok(true, '로컬 서버가 내려감')
  ok(!tab.said.some((m) => m.t === 'replaced') && (await state(SITE, siteH)).online, '사이트 연동은 그대로')
  tab.stop()
  if (fails) console.log(`\n--- agent log ---\n${agentOut.slice(-4000)}`)
} catch (e) {
  fails++
  console.log(`FAIL ${e.message}`)
  console.log(`--- sample ---\n${sample}\n--- agent ---\n${agentOut.slice(-4000)}`)
} finally {
  for (const k of kids) k.kill('SIGTERM')
  await sleep(500)
  spawnSync('tmux', ['kill-server'], { env: { ...process.env, TMUX_TMPDIR: tmuxDir } })
  for (const d of [home, siteRoot, siteData, tmuxDir, work]) fs.rmSync(d, { recursive: true, force: true })
  console.log(fails ? `\n${fails}개 실패` : '\n모두 통과')
  process.exit(fails ? 1 : 0)
}
