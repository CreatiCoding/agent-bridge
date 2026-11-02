// End-to-end check of the local screen (REQ-F-843~845, REQ-S-096~098, docs/LOCAL-UI-DESIGN.md) with no server at all:
// an installed agent (its files copied into a fresh CLAUDE_BRIDGE_HOME, so remote bundles are taken), a real Claude
// Code session (MODEL, haiku by default), a one-time link from `local open`, sign-in, the state and
// the terminal, typing, what is turned away (no token, the bridge key, another Host or Origin), then a newer signed
// bundle passed in as the server would (installed), an old or unsigned one (refused), booted and `local rollback`.
// Needs tmux, a signed-in `claude` and the maintainer's signing key (~/.claude-bridge-signing/agent-ed25519.pem, or CLAUDE_BRIDGE_SIGN_KEY):
//   node test/e2e-localui.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { docOf, signDoc, makeBundle } from '../agent/localui.mjs'
import { DOC } from '../agent/localbundle.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT || 4391)
// Its real path: the agent tells an installed copy by comparing its own folder with CLAUDE_BRIDGE_HOME.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-local-home-')))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-local-work-'))
const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-local-tmux-'))
const keyFile = process.env.CLAUDE_BRIDGE_SIGN_KEY || path.join(os.homedir(), '.claude-bridge-signing', 'agent-ed25519.pem')
const step = (s) => console.log(`\n== ${s}`)
const ok = (cond, what) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`)
  if (!cond) process.exitCode = 1
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

// The installed agent: its files, as install.sh puts them, so it is not "a checkout being worked on".
const files = JSON.parse(/const AGENT_FILES = (\[[^\]]+\])/.exec(fs.readFileSync(path.join(ROOT, 'agent/agent.mjs'), 'utf8'))[1].replace(/'/g, '"'))
for (const f of files) fs.copyFileSync(path.join(ROOT, 'agent', f), path.join(home, f))
const MODEL = process.env.MODEL ?? 'claude-haiku-4-5-20251001'
const env = { ...process.env, CLAUDE_BRIDGE_HOME: home, TMUX_TMPDIR: tmuxDir }
delete env.TMUX
const AGENT = path.join(home, 'agent.mjs')
const cli = (...args) => spawnSync(process.execPath, [AGENT, 'local', ...args, '--no-open', '--port', String(PORT)], { env, encoding: 'utf8' })

const agent = spawn(process.execPath, [AGENT, 'http://localhost:9', '--port', String(PORT), '--no-open', '--mux', 'tmux', '--name', 'e2e-local'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
agent.stdout.on('data', (b) => (out += b))
agent.stderr.on('data', (b) => (out += b))
const base = `http://127.0.0.1:${PORT}`
const req = (p, { method = 'GET', headers = {}, body, token } = {}) =>
  fetch(base + p, { method, headers: { 'X-Local-UI': '1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
const cfg = () => JSON.parse(fs.readFileSync(path.join(home, 'agent.json'), 'utf8'))
let lastToken = ''
const cmd = (c) => fetch(`${base}/cmd?key=${encodeURIComponent(cfg().key)}`, { method: 'POST', body: JSON.stringify(c) })

try {
  step('agent up, a session')
  await until(() => fetch(`${base}/ping`).then((r) => r.ok).catch(() => false), 20000, 'agent')
  const sid = crypto.randomUUID()
  await cmd({ t: 'new', sid, cwd: work, prompt: '', model: MODEL })

  step('a one-time link from the terminal')
  const r1 = cli('open')
  const t = /#t=([A-Za-z0-9_-]{43})/.exec(r1.stdout)?.[1]
  ok(!!t, `local open 이 링크를 줌: ${r1.stdout.split('\n')[0]}`)
  ok(!fs.readFileSync(path.join(home, 'localui', 'tickets.json'), 'utf8').includes(t), '입장권은 해시로만 저장')

  step('what is turned away')
  ok((await req('/local/api/state')).status === 401, '토큰 없이 401')
  ok((await req('/local/api/state', { token: 'A'.repeat(43) })).status === 401, '틀린 토큰 401')
  ok((await fetch(`${base}/local/api/state`, { headers: { 'X-Local-UI': '1', Authorization: `Bearer ${cfg().key}` } })).status === 401, '연동 키로는 401')
  // fetch cannot set Host: a plain request, as a page of another name resolving to 127.0.0.1 would send.
  const hostStatus = await new Promise((res) => http.get({ host: '127.0.0.1', port: PORT, path: '/local/', headers: { Host: `evil.example:${PORT}` } }, (r) => (r.resume(), res(r.statusCode))).on('error', () => res(0)))
  ok(hostStatus === 403, `다른 Host(리바인딩) 403 (${hostStatus})`)
  ok((await req('/local/api/login', { method: 'POST', body: { ticket: t }, headers: { Origin: 'https://bridge.example' } })).status === 403, '다른 Origin 403')
  ok((await fetch(`${base}/local/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: t }) })).status === 403, 'X-Local-UI 없이 403')
  ok((await req('/local/api/login', { method: 'POST', body: { ticket: 'B'.repeat(43) } })).status === 403, '틀린 입장권 403')

  step('sign in, the state and the page')
  const login = await req('/local/api/login', { method: 'POST', body: { ticket: t }, headers: { Origin: base } })
  const { token } = await login.json()
  lastToken = token
  ok(login.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(token ?? ''), '입장권으로 로그인')
  ok((await req('/local/api/login', { method: 'POST', body: { ticket: t } })).status === 403, '같은 입장권은 두 번 안 됨')
  const page = await fetch(`${base}/local/`)
  const html = await page.text()
  ok(page.status === 200 && /로컬 화면/.test(html), '묶음의 index.html')
  ok(/script-src 'self'/.test(page.headers.get('content-security-policy') ?? '') && page.headers.get('x-frame-options') === 'DENY', 'CSP·프레임 막기 머리글')
  ok(page.headers.get('access-control-allow-origin') === null, 'CORS 머리글 없음')
  await until(async () => (await (await req('/local/api/state', { token })).json()).sessions?.some((s) => s.id === sid), 20000, '세션이 state 에')
  const st = await (await req('/local/api/state', { token })).json()
  ok(st.linked === false && st.bundle?.source === 'builtin', `서버 없음(linked=false), 기본 묶음 ${st.bundle?.version}`)

  step('the terminal, and typing into it')
  await until(async () => /claude|Claude|>/.test((await (await req(`/local/api/screen?sid=${sid}`, { token })).json()).text ?? ''), 60000, 'claude 화면')
  // A fresh folder: Claude Code asks whether to trust it. Answered with the local screen's keys.
  const screenText = async () => ((await (await req(`/local/api/screen?sid=${sid}`, { token })).json()).text ?? '').replace(/\x1b\[[0-9;]*m/g, '')
  await until(async () => /trust this folder/.test(await screenText()) || (await (await req('/local/api/state', { token })).json()).sessions?.find((s) => s.id === sid)?.phase === 'idle', 60000, '폴더 신뢰 창 또는 쉬는 중')
  if (/trust this folder/.test(await screenText())) {
    ok((await req('/local/api/key', { method: 'POST', token, body: { sid, keys: ['Down', 'Enter'] } })).status === 200, '키(↓·Enter)로 폴더 신뢰 창에 답함')
  }
  await until(async () => (await (await req('/local/api/state', { token })).json()).sessions?.find((s) => s.id === sid)?.phase === 'idle', 90000, '세션이 쉬는 중')
  ok(true, '터미널 화면이 보임')
  const sent = await req('/local/api/send', { method: 'POST', token, body: { sid, text: 'Reply with exactly the word PONGLOCAL and nothing else. Do not use tools.' } })
  ok(sent.status === 200, '글 보내기')
  await until(async () => /PONGLOCAL\s*$|⏺ PONGLOCAL|● PONGLOCAL/m.test((await (await req(`/local/api/screen?sid=${sid}`, { token })).json()).text?.replace(/\x1b\[[0-9;]*m/g, '') ?? ''), 120000, 'Claude 가 답함')
  ok(true, '로컬 화면에서 보낸 글에 Claude 가 답함(터미널 화면)')
  ok((await req('/local/api/key', { method: 'POST', token, body: { sid, keys: ['rm -rf /'] } })).status === 400, '목록에 없는 키는 거부')
  ok((await req('/local/api/send', { method: 'POST', token, body: { sid: 'nope', text: 'x' } })).status === 404, '없는 세션 404')

  // The page itself in a browser, when PLAYWRIGHT names playwright's index.mjs (not a dependency of this repo).
  if (process.env.PLAYWRIGHT) {
    step('the page in a browser')
    const { chromium } = await import(process.env.PLAYWRIGHT)
    const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {})
    try {
      const pg = await browser.newPage({ viewport: { width: 1100, height: 760 } })
      const errors = []
      pg.on('pageerror', (e) => errors.push(e.message))
      pg.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
      const t2 = /#t=([A-Za-z0-9_-]{43})/.exec(cli('open').stdout)[1]
      await pg.goto(`${base}/local/#t=${t2}`)
      await pg.waitForSelector('#sessions button', { timeout: 15000 })
      ok(!(await pg.evaluate(() => location.hash)), '입장권이 주소에서 지워짐')
      await pg.click('#sessions button')
      await pg.waitForFunction(() => /PONGLOCAL/.test(document.getElementById('screen').textContent), null, { timeout: 15000 })
      ok(true, '브라우저에서 세션 터미널이 보임')
      if (process.env.SHOTS) await pg.screenshot({ path: path.join(process.env.SHOTS, 'localui.png') })
      await pg.setViewportSize({ width: 390, height: 800 })
      if (process.env.SHOTS) await pg.screenshot({ path: path.join(process.env.SHOTS, 'localui-phone.png') })
      ok(await pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '폰 폭에서 가로 스크롤 없음')
      await pg.reload()
      await pg.waitForSelector('#sessions button', { timeout: 15000 })
      ok(true, '새로 고쳐도 로그인 유지(localStorage 토큰)')
      ok(!errors.length, `페이지 오류 없음 ${errors.join(' | ')}`)
    } finally {
      await browser.close()
    }
  }

  step('a newer signed bundle, as the server passes it on (OTA)')
  const key = crypto.createPrivateKey(fs.readFileSync(keyFile))
  const dir = path.join(ROOT, 'agent/localui')
  const src = Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]))
  const builtinSeq = JSON.parse(DOC).seq
  const v2bundle = makeBundle({ ...src, 'index.html': src['index.html'].replace('<title>로컬 화면</title>', '<title>로컬 화면 v2</title>') })
  const v2doc = docOf(v2bundle, builtinSeq + 10)
  await cmd({ t: 'localui', doc: v2doc, sig: signDoc(v2doc, key), bundle: v2bundle })
  await until(async () => (await (await req('/local/api/state', { token })).json()).bundle?.source === 'remote', 10000, '원격 묶음 설치')
  ok(/로컬 화면 v2/.test(await (await fetch(`${base}/local/`, { headers: { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' } })).text()), '새 묶음을 내줌(staged → install → active)')
  ok((await req('/local/api/booted', { method: 'POST', body: {} })).status === 200, '페이지가 떴다고 알림(booted)')
  ok(JSON.parse(fs.readFileSync(path.join(home, 'localui/remote/manifest.json'), 'utf8')).versions[JSON.parse(v2doc).version]?.confirmed === true, 'manifest 에 확인됨')

  const oldBundle = makeBundle({ ...src, 'index.html': src['index.html'].replace('<title>로컬 화면</title>', '<title>OLD</title>') })
  const oldDoc = docOf(oldBundle, builtinSeq + 5)
  await cmd({ t: 'localui', doc: oldDoc, sig: signDoc(oldDoc, key), bundle: oldBundle })
  const evil = crypto.generateKeyPairSync('ed25519').privateKey
  const evilDoc = docOf(oldBundle, builtinSeq + 99)
  await cmd({ t: 'localui', doc: evilDoc, sig: signDoc(evilDoc, evil), bundle: oldBundle })
  await sleep(800)
  ok(/로컬 화면 v2/.test(await (await fetch(`${base}/local/`)).text()), '예전 서명 묶음·다른 키 묶음은 쓰지 않음')
  ok(/old/.test(fs.readFileSync(path.join(home, 'agent.log'), 'utf8')) && /verify_failed/.test(fs.readFileSync(path.join(home, 'agent.log'), 'utf8')), '로그에 old·verify_failed')

  step('rollback at the terminal, and off')
  const rb = cli('rollback')
  ok(/되돌렸어요/.test(rb.stdout), `local rollback: ${rb.stdout.trim()}`)
  await sleep(300)
  ok((await (await req('/local/api/state', { token })).json()).bundle?.source === 'builtin', '기본 묶음으로 돌아감')
  ok(/상태|켜짐/.test(cli('status').stdout), 'local status')
  cli('off')
  await sleep(2300)
  ok((await fetch(`${base}/local/`)).status === 404, 'local off 면 404')
  ok(cfg().localUi?.on === false, 'agent.json 에 꺼짐이 남음(에이전트가 덮어쓰지 않음)')
  cli('on')
  await sleep(2300)
  ok((await req('/local/api/state', { token })).status === 401, '끈 뒤에는 예전 토큰이 안 됨')
  await cmd({ t: 'close', sid })
  await sleep(500)
} catch (e) {
  console.log(`FAIL ${e.message}`)
  process.exitCode = 1
  if (lastToken) {
    const st = await (await req('/local/api/state', { token: lastToken })).json().catch(() => null)
    console.log('state:', JSON.stringify(st))
    for (const x of st?.sessions ?? []) console.log(`screen ${x.id}:\n${((await (await req(`/local/api/screen?sid=${x.id}`, { token: lastToken })).json()).text ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(-2500)}`)
  }
} finally {
  agent.kill('SIGTERM')
  spawnSync('tmux', ['kill-server'], { env })
  if (process.exitCode) console.log(`\n--- agent output ---\n${out.slice(-3000)}\n--- agent.log ---\n${fs.existsSync(path.join(home, 'agent.log')) ? fs.readFileSync(path.join(home, 'agent.log'), 'utf8').slice(-3000) : ''}`)
}
