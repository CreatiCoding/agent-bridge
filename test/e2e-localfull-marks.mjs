// End-to-end check that a session's favourite and given name survive 로컬로 바꾸기 (local --full on, REQ-F-923) on this
// Mac: a site (this checkout's server, BRIDGE_DEV_LOGIN) hands out the signed Mac build; an installed agent is linked
// to it by a stand-in for the bridge tab; two sessions are started on the site and marked there (one a favourite with
// a name, one only a name). Then the switch to the local server, which cuts the site: the local server shows both with
// the site's marks. Then the same through the button on the site's page (REQ-F-926), after marks changed on the
// site. The real `claude` answers through the stand-in Messages API (test/fixtures/fake-responses.mjs).
// Needs docker (the Mac build), go, tmux, claude and the signed server/localfull.json:
//   node test/e2e-localfull-marks.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Relay, sseMessages, archOf } from '../agent/localfull.mjs'
import { buildLocalFull } from '../scripts/sign-agent.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SITE_PORT = Number(process.env.SITE_PORT || 4385)
const AGENT_PORT = Number(process.env.PORT || 4384)
const FAKE_PORT = Number(process.env.FAKE_PORT || 4387)
const LOCAL_PORT = AGENT_PORT + 10
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)))
const home = tmp('cb-lfm-home-')
const siteRoot = tmp('cb-lfm-site-')
const siteData = tmp('cb-lfm-data-')
const tmuxDir = tmp('cb-lfm-tmux-')
const work = tmp('cb-lfm-work-')
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
  const site = spawn(siteBin, [], { env: { ...process.env, PORT: String(SITE_PORT), BRIDGE_DATA: siteData, BRIDGE_ROOT: siteRoot, BRIDGE_DEV_LOGIN: '1', GITHUB_ALLOWED_LOGINS: 'lfme2e' }, stdio: ['ignore', 'pipe', 'pipe'] })
  kids.push(site)
  const fake = spawn(process.execPath, [path.join(ROOT, 'test', 'fixtures', 'fake-responses.mjs'), String(FAKE_PORT)], { stdio: 'ignore' })
  kids.push(fake)
  const SITE = `http://127.0.0.1:${SITE_PORT}`
  await until(() => fetch(`${SITE}/api/health`).then((r) => r.ok).catch(() => false), 20000, 'site')
  const dev = await fetch(`${SITE}/api/auth/dev?login=lfme2e`, { redirect: 'manual' })
  const siteCookie = /(?:__Host-)?cb=[^;]+/.exec(dev.headers.get('set-cookie') ?? '')?.[0]
  ok(!!siteCookie, '사이트에 개발 로그인')
  const files = JSON.parse(/const AGENT_FILES = (\[[^\]]+\])/.exec(fs.readFileSync(path.join(ROOT, 'agent/agent.mjs'), 'utf8'))[1].replace(/'/g, '"'))
  for (const f of files) fs.copyFileSync(path.join(ROOT, 'agent', f), path.join(home, f))
  const env = { ...process.env, CLAUDE_BRIDGE_HOME: home, TMUX_TMPDIR: tmuxDir, CLAUDECODE: '', ANTHROPIC_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`, ANTHROPIC_AUTH_TOKEN: 'fake', ANTHROPIC_API_KEY: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
  delete env.TMUX
  const AGENT = path.join(home, 'agent.mjs')
  const agent = spawn(process.execPath, [AGENT, SITE, '--port', String(AGENT_PORT), '--no-open', '--no-chrome', '--no-auto-update', '--mux', 'tmux', '--name', 'e2e-marks'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
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
  const post = (base, headers, p, data) => fetch(`${base}${p}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))
  const find = async (base, headers, sid) => (await state(base, headers)).sessions.find((x) => x.id === sid)

  step('two sessions on the site, marked there')
  const started = []
  for (const p of ['marks-one', 'marks-two']) {
    const s = await post(SITE, siteH, '/api/sessions', { hostId, cwd: work, prompt: p })
    ok(s.status === 200 && s.body.id, `사이트에서 세션 시작 (${s.status})`)
    started.push(s.body.id)
    await until(async () => /marks-/.test(JSON.stringify((await find(SITE, siteH, s.body.id)) ?? '')), 60000, '첫 메시지')
  }
  const [sid1, sid2] = started
  ok((await post(SITE, siteH, `/api/sessions/${sid1}/settings`, { favorite: true, title: '즐겨찾기 이름' })).status === 200, '첫 세션: 즐겨찾기와 이름')
  ok((await post(SITE, siteH, `/api/sessions/${sid2}/settings`, { title: '이름만' })).status === 200, '둘째 세션: 이름만')
  const kept = await until(() => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(home, 'localfull', 'marks.json'), 'utf8'))
      return m[sid1]?.favorite === true && m[sid1]?.title === '즐겨찾기 이름' && m[sid2]?.title === '이름만' ? m : null
    } catch {
      return null
    }
  }, 15000, '맥이 받아 둠').catch(() => null)
  ok(!!kept, `맥이 사이트의 즐겨찾기·이름을 받아 둠 ${kept ? '' : fs.existsSync(path.join(home, 'localfull', 'marks.json')) ? fs.readFileSync(path.join(home, 'localfull', 'marks.json'), 'utf8') : '(파일 없음)'}`)

  step('local --full on: the site is cut, the local server shows the marks')
  const on = spawnSync(process.execPath, [AGENT, 'local', '--full', 'on', '--no-open', '--port', String(AGENT_PORT)], { env, encoding: 'utf8', timeout: 120_000 })
  ok(on.status === 0, `local --full on 이 끝남 (${on.status}) ${on.stderr.trim()}`)
  const t1 = /#t=([A-Za-z0-9_-]{43})/.exec(on.stdout)?.[1]
  ok(!!t1, '일회용 링크를 줌')
  tab.stop()
  const L = LOCAL_PORT
  const LO = `http://127.0.0.1:${L}`
  const r1 = await raw(L, '/api/local/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-UI': '1' }, body: JSON.stringify({ ticket: t1 }) })
  ok(r1.status === 200, `로컬 서버에 링크로 로그인 (${r1.status})`)
  const cookie = String(r1.headers['set-cookie']?.[0] ?? '').split(';')[0]
  const lkey = (() => { try { return JSON.parse(r1.body).key ?? '' } catch { return '' } })()
  const localH = { Cookie: cookie, 'X-Local-Key': lkey, Host: `127.0.0.1:${L}`, Origin: LO }
  await until(async () => (await state(LO, localH)).online, 20000, '로컬 서버에 연결')
  ok(true, '로컬 서버에서 이 맥이 연결됨')
  const both = await until(async () => {
    const a = await find(LO, localH, sid1)
    const b = await find(LO, localH, sid2)
    return a?.favorite === true && a?.title === '즐겨찾기 이름' && b?.title === '이름만' && b?.favorite !== true ? [a, b] : null
  }, 20000, '로컬에 즐겨찾기·이름').catch(() => null)
  ok(!!both, `로컬 서버에 즐겨찾기·이름이 그대로 ${both ? '' : sample}`)

  step('local --full off')
  const off = spawnSync(process.execPath, [AGENT, 'local', '--full', 'off', '--no-open', '--port', String(AGENT_PORT)], { env, encoding: 'utf8', timeout: 60_000 })
  ok(off.status === 0, `local --full off (${off.stdout.trim()})`)
  await until(async () => (await raw(L, '/api/health')).status === 0, 10000, '로컬 서버 내림')

  step('the button on the site\'s page (REQ-F-926): marks changed on the site, then the switch from the page')
  const tab2 = siteTab()
  await until(async () => (await state(SITE, siteH)).online, 20000, '사이트에 다시 연결')
  ok(true, '사이트에 다시 연결됨')
  ok((await post(SITE, siteH, `/api/sessions/${sid2}/settings`, { favorite: true, title: '버튼 전에 바꾼 이름' })).status === 200, '사이트에서 둘째 세션에 즐겨찾기와 새 이름')
  ok((await post(SITE, siteH, `/api/sessions/${sid1}/settings`, { favorite: false })).status === 200, '사이트에서 첫 세션 즐겨찾기 풀기')
  await sleep(1500)
  const press = (headers) => fetch(`${A}/localfull/on`, { method: 'POST', headers })
  ok((await press({ Origin: 'https://evil.example', 'X-Bridge-Key': key() })).status === 403, '다른 사이트의 페이지는 403')
  ok((await press({ Origin: SITE })).status === 401, '키 없이 401')
  ok((await press({ Origin: SITE, 'X-Bridge-Key': 'x'.repeat(43) })).status === 401, '틀린 키 401')
  const pre = await fetch(`${A}/localfull/on`, { method: 'OPTIONS', headers: { Origin: SITE, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-bridge-key', 'Access-Control-Request-Private-Network': 'true' } })
  ok(pre.status === 204 && pre.headers.get('access-control-allow-origin') === SITE && /x-bridge-key/.test(pre.headers.get('access-control-allow-headers') ?? ''), '사이트 페이지의 사전 확인(CORS)을 받음')
  // Two presses at once: the agent takes the first that comes and turns the other away, whichever it is.
  const pair = await Promise.all([press({ Origin: SITE, 'X-Bridge-Key': key() }), press({ Origin: SITE, 'X-Bridge-Key': key() })])
  const p1 = pair.find((r) => r.status !== 409) ?? pair[0]
  const p2 = pair.find((r) => r !== p1)
  const j1 = await p1.json().catch(() => ({}))
  ok(p1.status === 200 && /^http:\/\/127\.0\.0\.1:\d+\/#t=[A-Za-z0-9_-]{43}$/.test(j1.link ?? ''), `버튼: 일회용 링크를 줌 (${p1.status} ${JSON.stringify(j1).replace(/#t=[^"]+/, '#t=***')})`)
  ok(p1.headers.get('access-control-allow-origin') === SITE, '답에 사이트의 CORS 머리')
  ok(p2.status === 409, `바꾸는 중의 두 번째 누름은 409 (${p2.status})`)
  ok(await until(() => tab2.said.some((m) => m.t === 'replaced'), 5000).catch(() => false), '사이트 탭은 넘겨받음(replaced)을 들음')
  tab2.stop()
  // The site sees the Mac gone once the tab's stream to it ends, not at once.
  ok(await until(async () => !(await state(SITE, siteH)).online, 15000).catch(() => false), '사이트에서는 이 맥이 끊김')
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'agent.json'), 'utf8')).localFull
  ok(cfg?.on === true && cfg?.both === false, `agent.json localFull: ${JSON.stringify(cfg)}`)
  const t2 = /#t=([A-Za-z0-9_-]{43})/.exec(j1.link ?? '')?.[1]
  const r2 = await raw(L, '/api/local/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-UI': '1' }, body: JSON.stringify({ ticket: t2 }) })
  ok(r2.status === 200, `버튼의 링크로 로컬 서버에 로그인 (${r2.status})`)
  const cookie2 = String(r2.headers['set-cookie']?.[0] ?? '').split(';')[0]
  const lkey2 = (() => { try { return JSON.parse(r2.body).key ?? '' } catch { return '' } })()
  const localH2 = { Cookie: cookie2, 'X-Local-Key': lkey2, Host: `127.0.0.1:${L}`, Origin: LO }
  const after = await until(async () => {
    const a = await find(LO, localH2, sid1)
    const b = await find(LO, localH2, sid2)
    return a && a.favorite !== true && a.title === '즐겨찾기 이름' && b?.favorite === true && b?.title === '버튼 전에 바꾼 이름' ? [a, b] : null
  }, 20000, '로컬에 바뀐 즐겨찾기·이름').catch(() => null)
  ok(!!after, `로컬 서버에 사이트에서 바꾼 즐겨찾기·이름이 그대로 ${after ? '' : sample}`)
  const again = await press({ Origin: SITE, 'X-Bridge-Key': key() })
  ok(again.status === 200 && /#t=/.test((await again.json().catch(() => ({}))).link ?? ''), '이미 로컬일 때 다시 누르면 새 링크만')
  const off2 = spawnSync(process.execPath, [AGENT, 'local', '--full', 'off', '--no-open', '--port', String(AGENT_PORT)], { env, encoding: 'utf8', timeout: 60_000 })
  ok(off2.status === 0, 'local --full off')
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
