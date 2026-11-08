// 실행기 전환 (REQ-F-891), end to end: the server, one agent, a real `codex` against the stand-in Responses API
// (test/fixtures/fake-responses.mjs, its own CODEX_HOME) and the real `claude` (only started, never asked anything, so
// no usage). A Codex session switches to Claude Code and back in place: the same session id, no second session, the
// conversation on the page kept and not drawn twice, the codex conversation resumed (one rollout), refused while it
// works. Starts its own server, agent and stand-in on free ports, and stops them at the end.
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs CODEX=/path/to/codex [CHANNEL=chrome] node test/e2e-switch.mjs
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { chromium } = await import(process.env.PLAYWRIGHT)
const CODEX = process.env.CODEX || 'codex'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (s) => console.log(`\n== ${s}`)
const ok = (cond, what) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`)
  if (!cond) process.exitCode = 1
}
const until = async (fn, ms) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn().catch(() => false)) return Date.now() - t0
    await wait(500)
  }
  return null
}
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)) }) })

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-e2e-switch-')))
const children = []
const cleanup = () => {
  for (const c of children) c.kill()
  try {
    execFileSync('pkill', ['-f', tmp])
  } catch {}
  if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true })
  else console.log(`kept ${tmp}`)
}

const [serverPort, agentPort, fakePort] = [await freePort(), await freePort(), await freePort()]
const SITE = `http://localhost:${serverPort}`
const codexHome = path.join(tmp, 'codex-home')
fs.mkdirSync(codexHome)
fs.writeFileSync(path.join(codexHome, 'config.toml'), `model = "fake-model"\nmodel_provider = "fake"\n\n[model_providers.fake]\nname = "Fake"\nbase_url = "http://127.0.0.1:${fakePort}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n\n[tui]\nscreen_reader_detection_done = true\n`)
const work = path.join(tmp, 'work')
fs.mkdirSync(work)
execFileSync('git', ['init', '-q', work])
const data = path.join(tmp, 'data')
fs.mkdirSync(data)

const fake = spawn(process.execPath, [path.join(ROOT, 'test', 'fixtures', 'fake-responses.mjs'), String(fakePort)], { stdio: 'ignore' })
children.push(fake)
const bin = path.join(tmp, 'bridge-server')
execFileSync('go', ['build', '-o', bin, '.'], { cwd: path.join(ROOT, 'server'), stdio: 'inherit' })
const server = spawn(bin, [], { cwd: ROOT, env: { ...process.env, CLAUDECODE: '', HOME: data, PORT: String(serverPort), BRIDGE_DATA: data, BRIDGE_DEV_LOGIN: '1', GITHUB_ALLOWED_LOGINS: 'tester', BRIDGE_ORIGIN: SITE, BRIDGE_ROOT: ROOT }, stdio: ['ignore', 'pipe', 'pipe'] })
children.push(server)
let serverLog = ''
server.stdout.on('data', (d) => (serverLog += d))
server.stderr.on('data', (d) => (serverLog += d))
const slog = fs.createWriteStream(path.join(os.tmpdir(), 'e2e-switch-server.log'))
server.stdout.pipe(slog)
server.stderr.pipe(slog)
server.on('exit', (code, sig) => console.log('SERVER EXIT', code, sig))

try {
  for (let i = 0; i < 100 && !(await fetch(`${SITE}/api/health`).then((r) => r.ok, () => false)); i++) await wait(100)
  const home = path.join(tmp, 'agent')
  const agent = spawn(process.execPath, [path.join(ROOT, 'agent', 'agent.mjs'), SITE, '--port', String(agentPort), '--name', 'MacSwitch', '--no-open', '--no-chrome', '--no-auto-update'], { env: { ...process.env, CLAUDECODE: '', CLAUDE_BRIDGE_HOME: home, CLAUDE_BRIDGE_CODEX: CODEX, CODEX_HOME: codexHome }, stdio: 'ignore' })
  children.push(agent)
  await until(async () => fs.existsSync(path.join(home, 'agent.json')) && JSON.parse(fs.readFileSync(path.join(home, 'agent.json'), 'utf8')).key, 20000)
  const c = JSON.parse(fs.readFileSync(path.join(home, 'agent.json'), 'utf8'))

  const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {})
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 860 } })
  await ctx.request.get(`${SITE}/api/auth/dev?login=tester`)
  const H = { origin: SITE }
  const bridge = await ctx.newPage()
  bridge.on('dialog', (d) => d.accept())
  await bridge.goto(`${SITE}/bridge#port=${c.port}&key=${c.key}`)
  await bridge.waitForFunction(() => document.getElementById('server-text')?.textContent === '연결됨', null, { timeout: 30000 })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const watcher = await ctx.newPage()
  await watcher.goto(`${SITE}/api/health`)
  await watcher.evaluate(() => { new EventSource('/api/classic/stream').onmessage = (e) => { const m = JSON.parse(e.data); if (m.sessions) window.__st = m } })
  const sess = (id) => watcher.evaluate((x) => window.__st?.sessions.find((s) => s.id === x) ?? null, id)
  const count = () => watcher.evaluate(() => window.__st?.sessions.filter((s) => !s.closed).length ?? 0)
  await until(async () => (await count()) >= 0 && (await watcher.evaluate(() => !!window.__st)), 20000)

  step('Codex 세션')
  ok((await until(async () => (await watcher.evaluate(() => window.__st?.hosts?.[0]?.runners?.some((r) => r.id === 'codex'))) === true, 90000)) !== null, '이 맥이 codex 를 씀')
  const made = await ctx.request.post(`${SITE}/api/sessions`, { data: { hostId: c.hostId, cwd: work, prompt: '첫 인사 SWITCH_ONE', runner: 'codex' }, headers: H })
  const sid = (await made.json()).id
  ok(made.ok() && !!sid, `세션 시작 (${made.status()})`)
  await page.goto(`${SITE}/s/${sid}`)
  const shown = (text) => page.locator('.msg-text').filter({ hasText: text })
  const answered = (text, ms = 90000) => until(() => shown(text).first().isVisible(), ms)
  ok((await answered('echo: 첫 인사 SWITCH_ONE')) !== null, '첫 답')
  ok((await until(async () => (await sess(sid))?.state?.phase === 'idle', 60000)) !== null, '쉬는 중')
  const sessions0 = await count()

  step('작업 중에는 거절')
  await ctx.request.post(`${SITE}/api/sessions/${sid}/say`, { data: { text: 'WAIT 기다려 줘' }, headers: H })
  ok((await until(async () => (await sess(sid))?.state?.phase === 'busy', 20000)) !== null, '긴 턴')
  const busy = await ctx.request.post(`${SITE}/api/sessions/${sid}/switch`, { data: { runner: 'claude' }, headers: H })
  ok(busy.status() === 409, `작업 중 전환은 409 (${busy.status()})`)
  ok((await answered('기다린 뒤 답: WAIT 기다려 줘')) !== null, '긴 턴의 답')
  ok((await until(async () => (await sess(sid))?.state?.phase === 'idle', 60000)) !== null, '다시 쉬는 중')

  step('Codex → Claude Code, 같은 세션')
  const toClaude = await ctx.request.post(`${SITE}/api/sessions/${sid}/switch`, { data: { runner: 'claude' }, headers: H, timeout: 180000 })
  const toClaudeBody = await toClaude.json().catch(() => ({}))
  ok(toClaude.ok(), `전환 (${toClaude.status()} ${JSON.stringify(toClaudeBody)})`)
  ok(toClaudeBody.resumed === false, '이 세션의 첫 Claude Code 대화')
  const s1 = await until(async () => { const s = await sess(sid); return s && !s.runner && s.state?.alive }, 60000)
  ok(s1 !== null, '같은 id 의 세션이 Claude Code 로 살아 있음')
  ok((await count()) === sessions0, `세션이 늘지 않음 (${await count()})`)
  ok((await shown('echo: 첫 인사 SWITCH_ONE').count()) === 1, 'Codex 때의 대화가 그대로 한 번 보임')
  ok((await until(async () => (await page.locator('.note').allTextContents()).some((t) => /Claude Code 로 전환했어요/.test(t)), 20000)) !== null, '전환 알림')
  const tmux = execFileSync('tmux', ['list-sessions', '-F', '#S']).toString()
  ok(!/codex/.test(execFileSync('ps', ['-axo', 'command']).toString().split('\n').filter((l) => l.includes(tmp) && /\bcodex\b/.test(l) && !l.includes('fake-responses')).join('\n')), 'codex 는 내려감')
  ok(tmux.split('\n').filter((x) => x.includes(sid.slice(0, 8))).length <= 1, '터미널은 하나')
  ok((await until(async () => (await sess(sid))?.state?.phase === 'idle', 90000)) !== null, 'Claude Code 가 뜨고 쉬는 중')

  step('Claude Code → Codex, 예전 codex 대화를 이어서')
  const toCodex = await ctx.request.post(`${SITE}/api/sessions/${sid}/switch`, { data: { runner: 'codex' }, headers: H, timeout: 180000 })
  const toCodexBody = await toCodex.json().catch(() => ({}))
  ok(toCodex.ok(), `전환 (${toCodex.status()} ${JSON.stringify(toCodexBody)})`)
  ok(toCodexBody.resumed === true, '예전 codex 대화를 이어서 엶')
  ok((await until(async () => (await sess(sid))?.runner === 'codex' && (await sess(sid))?.state?.phase === 'idle', 90000)) !== null, '같은 세션이 다시 Codex')
  await ctx.request.post(`${SITE}/api/sessions/${sid}/say`, { data: { text: '돌아와서 SWITCH_TWO' }, headers: H })
  ok((await answered('echo: 돌아와서 SWITCH_TWO')) !== null, '돌아온 codex 가 답함')
  const rollouts = execFileSync('find', [path.join(codexHome, 'sessions'), '-name', 'rollout-*.jsonl']).toString().trim().split('\n').filter(Boolean)
  ok(rollouts.length === 1, `같은 codex 대화를 이어 씀 (rollout ${rollouts.length}개)`)
  ok((await shown('echo: 첫 인사 SWITCH_ONE').count()) === 1, '예전 답이 두 번 보이지 않음')
  ok((await shown('기다린 뒤 답: WAIT 기다려 줘').count()) === 1, '긴 턴의 답도 한 번')
  ok((await count()) === sessions0, '여전히 세션 하나')
  const same = await ctx.request.post(`${SITE}/api/sessions/${sid}/switch`, { data: { runner: 'codex' }, headers: H })
  ok(same.status() === 409, `같은 실행기로는 409 (${same.status()})`)

  step('끝내기')
  ok((await ctx.request.post(`${SITE}/api/sessions/${sid}/close`, { data: {}, headers: H })).ok(), '세션 종료')
  ok(errors.length === 0, `페이지 오류 없음 ${errors.join(' | ')}`)
  await browser.close()
} catch (e) {
  console.log('FAIL', e)
  console.log(serverLog.slice(-3000))
  process.exitCode = 1
} finally {
  cleanup()
}
