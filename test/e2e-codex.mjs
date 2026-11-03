// The codex runner (REQ-F-851), end to end: the server, one agent and a real `codex` (OpenAI Codex CLI) in tmux,
// pointed at a stand-in Responses API (test/fixtures/fake-responses.mjs) through its own CODEX_HOME, so no account or
// key is used. A new codex session from the page, its answers, a message while it works, codex's approval question as
// a card, a reopen that goes on with the same conversation, and the features codex has not (hidden, and refused).
// Starts its own server, agent and stand-in on free ports, and stops them at the end.
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs CODEX=/path/to/codex [SHOTS=<folder>] [CHANNEL=chrome] node test/e2e-codex.mjs
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { chromium } = await import(process.env.PLAYWRIGHT)
const CODEX = process.env.CODEX || 'codex'
const shots = process.env.SHOTS
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

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-e2e-codex-')))
const children = []
const cleanup = () => {
  for (const c of children) c.kill()
  try {
    execFileSync('pkill', ['-f', tmp])
  } catch {}
  // KEEP=1 leaves the folder (the agent's log is in agent/) to look at after a failure.
  if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true })
  else console.log(`kept ${tmp}`)
}

const [serverPort, agentPort, fakePort] = [await freePort(), await freePort(), await freePort()]
const SITE = `http://localhost:${serverPort}`
// codex's own folder for this test: the stand-in provider, nothing of the person's.
const codexHome = path.join(tmp, 'codex-home')
fs.mkdirSync(codexHome)
fs.writeFileSync(path.join(codexHome, 'config.toml'), `model = "fake-model"\nmodel_provider = "fake"\n\n[model_providers.fake]\nname = "Fake"\nbase_url = "http://127.0.0.1:${fakePort}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n\n[tui]\nscreen_reader_detection_done = true\n`)
// A git folder: codex asks whether to trust those, and the bridge must not leave that question to anyone.
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

try {
  for (let i = 0; i < 100 && !(await fetch(`${SITE}/api/health`).then((r) => r.ok, () => false)); i++) await wait(100)
  const home = path.join(tmp, 'agent')
  const agent = spawn(process.execPath, [path.join(ROOT, 'agent', 'agent.mjs'), SITE, '--port', String(agentPort), '--name', 'MacCodex', '--no-open', '--no-chrome', '--no-auto-update'], { env: { ...process.env, CLAUDECODE: '', CLAUDE_BRIDGE_HOME: home, CLAUDE_BRIDGE_CODEX: CODEX, CODEX_HOME: codexHome }, stdio: 'ignore' })
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

  step('새 세션 화면에 실행기')
  await page.goto(`${SITE}/new?host=${c.hostId}`)
  const picker = page.locator('button', { hasText: /^Codex/ }).first()
  ok((await until(() => picker.isVisible(), 90000)) !== null, '이 맥이 codex 를 쓸 수 있어 실행기 고르기에 Codex 가 보임')
  if (shots) await page.screenshot({ path: path.join(shots, 'codex-new.png') })

  step('codex 세션과 첫 답')
  const made = await ctx.request.post(`${SITE}/api/sessions`, { data: { hostId: c.hostId, cwd: work, prompt: '첫 인사 CODEX_ONE', runner: 'codex' }, headers: H })
  const sid = (await made.json()).id
  ok(made.ok() && !!sid, `세션 시작 (${made.status()})`)
  await page.goto(`${SITE}/s/${sid}`)
  const answered = (text, ms = 90000) => until(() => page.locator('.msg-text').filter({ hasText: text }).first().isVisible(), ms)
  ok((await answered('echo: 첫 인사 CODEX_ONE')) !== null, '첫 답이 화면에 옴')
  ok((await page.locator('.msg-text').filter({ hasText: 'environment_context' }).count()) === 0, 'codex 가 모델에게 주는 환경 글은 안 보임')
  ok(await page.getByText('Codex', { exact: false }).first().isVisible(), '세션 화면에 Codex 표시')

  step('메시지와 작업 중 붙잡기')
  // Sent once it is up and idle (a message said while it starts waits with any other and goes as one).
  const watcher = await ctx.newPage()
  await watcher.goto(`${SITE}/api/health`)
  await watcher.evaluate(() => { new EventSource('/api/classic/stream').onmessage = (e) => { const m = JSON.parse(e.data); if (m.sessions) window.__st = m } })
  const phase = () => watcher.evaluate((id) => window.__st?.sessions.find((x) => x.id === id)?.state?.phase, sid)
  ok((await until(async () => (await phase()) === 'idle', 60000)) !== null, '첫 턴이 끝나 쉬는 중')
  await ctx.request.post(`${SITE}/api/sessions/${sid}/say`, { data: { text: 'WAIT 기다려 줘' }, headers: H })
  ok((await until(async () => (await phase()) === 'busy', 20000)) !== null, '긴 턴이 도는 중')
  await ctx.request.post(`${SITE}/api/sessions/${sid}/say`, { data: { text: '그다음 CODEX_TWO' }, headers: H })
  ok((await answered('기다린 뒤 답: WAIT 기다려 줘')) !== null, '긴 턴의 답')
  ok((await answered('echo: 그다음 CODEX_TWO')) !== null, '작업 중에 보낸 글은 턴이 끝난 뒤 전달되어 답이 옴')

  step('승인 질문은 카드로')
  await ctx.request.post(`${SITE}/api/sessions/${sid}/say`, { data: { text: 'RUNCMD 실행해' }, headers: H })
  ok((await until(() => page.locator('.dcard.open').isVisible(), 60000)) !== null, '권한 카드가 뜸')
  const detail = await page.locator('.dcard.open').textContent()
  ok(/echo hello-from-fake/.test(detail ?? ''), '카드에 실행할 명령이 보임')
  if (shots) await page.screenshot({ path: path.join(shots, 'codex-card.png') })
  await page.locator('.dcard.open .opt.primary').click()
  ok((await answered('명령 결과를 받았습니다')) !== null, '허용하자 명령이 돌고 결과로 답함')

  step('없는 기능')
  const fork = await ctx.request.post(`${SITE}/api/sessions/${sid}/fork`, { data: {}, headers: H })
  ok(fork.status() === 409, `복제는 거절 (${fork.status()})`)
  const setting = await ctx.request.post(`${SITE}/api/sessions/${sid}/setting`, { data: { kind: 'model', value: 'other' }, headers: H })
  ok(setting.status() === 409, `모델 바꾸기는 거절 (${setting.status()})`)
  await page.getByRole('button', { name: /더보기|메뉴|⋯/ }).first().click().catch(() => {})
  await wait(500)
  ok((await page.getByRole('menuitem', { name: '복제' }).count()) === 0, '세션 메뉴에 복제가 없음')
  await page.keyboard.press('Escape')

  step('다시 열어도 같은 대화')
  const before = await page.locator('.msg-text').filter({ hasText: 'echo: 첫 인사 CODEX_ONE' }).count()
  ok((await ctx.request.post(`${SITE}/api/sessions/${sid}/refresh`, { data: { when: 'now' }, headers: H })).ok(), '새로고침')
  await wait(9000)
  await ctx.request.post(`${SITE}/api/sessions/${sid}/say`, { data: { text: '이어서 CODEX_THREE' }, headers: H })
  ok((await answered('echo: 이어서 CODEX_THREE')) !== null, '다시 연 세션이 답함')
  const rollouts = execFileSync('find', [path.join(codexHome, 'sessions'), '-name', 'rollout-*.jsonl']).toString().trim().split('\n').filter(Boolean)
  ok(rollouts.length === 1, `같은 codex 대화를 이어 씀 (rollout ${rollouts.length}개)`)
  ok((await page.locator('.msg-text').filter({ hasText: 'echo: 첫 인사 CODEX_ONE' }).count()) === before, '다시 열어도 앞의 답이 두 번 보이지 않음')

  step('끝내기')
  ok((await ctx.request.post(`${SITE}/api/sessions/${sid}/close`, { data: {}, headers: H })).ok(), '세션 종료')
  ok((await until(async () => !fs.existsSync(path.join(home, 'runners', `${sid}.jsonl`)), 15000)) !== null, '변환 사본이 지워짐')
  ok(errors.length === 0, `페이지 오류 없음 ${errors.join(' | ')}`)
  await browser.close()
} catch (e) {
  console.log('FAIL', e)
  console.log(serverLog.slice(-3000))
  process.exitCode = 1
} finally {
  cleanup()
}
