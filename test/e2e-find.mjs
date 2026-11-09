// 세션 찾기 (REQ-F-895), end to end: the server, one agent, the real `claude` pointed at the stand-in Anthropic
// Messages API (test/fixtures/fake-responses.mjs through ANTHROPIC_BASE_URL, so no account or usage). Two sessions; a
// link said in one is found by 대화 내용에서 찾기 (also after the session is closed), not in the other; AI 로 찾기 runs
// `claude -p` once and only the listed session it picks comes back (the id the stand-in makes up is dropped); the
// list's search box runs both by Enter and ⌘Enter and a found row opens its session. Starts its own server, agent and
// stand-in on free ports, and stops them.
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs [CHANNEL=chrome] node test/e2e-find.mjs
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { chromium } = await import(process.env.PLAYWRIGHT)
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

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-e2e-find-')))
const children = []
const cleanup = () => {
  for (const c of children) c.kill()
  try {
    execFileSync('pkill', ['-f', tmp])
  } catch {}
  if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true })
  else console.log(`kept ${tmp}`)
}

const LINK = 'https://example.slack.com/archives/C0FIND/p1700000000000001'
const [serverPort, agentPort, fakePort] = [await freePort(), await freePort(), await freePort()]
const SITE = `http://localhost:${serverPort}`
const work = path.join(tmp, 'work')
fs.mkdirSync(work)
const data = path.join(tmp, 'data')
fs.mkdirSync(data)

const fake = spawn(process.execPath, [path.join(ROOT, 'test', 'fixtures', 'fake-responses.mjs'), String(fakePort)], { stdio: 'ignore' })
children.push(fake)
const bin = path.join(tmp, 'bridge-server')
execFileSync('go', ['build', '-o', bin, '.'], { cwd: path.join(ROOT, 'server'), stdio: 'inherit' })
const server = spawn(bin, [], { cwd: ROOT, env: { ...process.env, CLAUDECODE: '', HOME: data, PORT: String(serverPort), BRIDGE_DATA: data, BRIDGE_DEV_LOGIN: '1', GITHUB_ALLOWED_LOGINS: 'tester', BRIDGE_ORIGIN: SITE, BRIDGE_ROOT: ROOT }, stdio: ['ignore', 'pipe', 'pipe'] })
children.push(server)
const slog = fs.createWriteStream(path.join(tmp, 'server.log'))
server.stdout.pipe(slog)
server.stderr.pipe(slog)

try {
  for (let i = 0; i < 100 && !(await fetch(`${SITE}/api/health`).then((r) => r.ok, () => false)); i++) await wait(100)
  const home = path.join(tmp, 'agent')
  const agent = spawn(process.execPath, [path.join(ROOT, 'agent', 'agent.mjs'), SITE, '--port', String(agentPort), '--name', 'MacFind', '--no-open', '--no-chrome', '--no-auto-update'], { env: { ...process.env, CLAUDECODE: '', CLAUDE_BRIDGE_HOME: home, ANTHROPIC_BASE_URL: `http://127.0.0.1:${fakePort}`, ANTHROPIC_AUTH_TOKEN: 'fake', ANTHROPIC_API_KEY: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, stdio: 'ignore' })
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
  const watcher = await ctx.newPage()
  await watcher.goto(`${SITE}/api/health`)
  await watcher.evaluate(() => { new EventSource('/api/classic/stream').onmessage = (e) => { const m = JSON.parse(e.data); if (m.sessions) window.__st = m } })
  const sess = (id) => watcher.evaluate((x) => window.__st?.sessions.find((s) => s.id === x) ?? null, id)
  await until(() => watcher.evaluate(() => !!window.__st), 20000)

  step('세션 둘')
  const start = async (prompt) => (await (await ctx.request.post(`${SITE}/api/sessions`, { data: { hostId: c.hostId, cwd: work, prompt }, headers: H })).json()).id
  const one = await start(`FINDONE 이 스레드 봐 줘 ${LINK}`)
  const two = await start('FINDTWO 배포 스크립트 고치기')
  ok(!!one && !!two, '세션 시작')
  for (const id of [one, two]) ok((await until(async () => (await sess(id))?.state?.phase === 'idle' && /echo:/.test((await sess(id))?.last ?? ''), 120000)) !== null, `답을 받고 쉬는 중 (${id.slice(0, 8)})`)

  const find = async (mode, q) => {
    const r = await ctx.request.post(`${SITE}/api/find`, { data: { mode, q }, headers: H, timeout: 150000 })
    return { status: r.status(), body: await r.json().catch(() => ({})) }
  }
  const hitsOf = (b) => (b.hosts ?? []).flatMap((h) => h.hits ?? [])

  step('대화 내용에서 찾기 (1단계)')
  const t1 = await find('text', 'example.slack.com/archives/C0FIND')
  ok(t1.status === 200, `200 (${t1.status} ${JSON.stringify(t1.body).slice(0, 200)})`)
  const h1 = hitsOf(t1.body)
  ok(h1.length === 1 && h1[0].sid === one, `링크가 나온 세션 하나만 (${JSON.stringify(h1.map((h) => h.sid.slice(0, 8)))})`)
  ok(h1[0]?.n >= 2 && h1[0]?.snips?.some((s) => s.includes(LINK)), `맞은 횟수와 문맥 (${h1[0]?.n} ${JSON.stringify(h1[0]?.snips)})`)
  ok(t1.body.hosts?.[0]?.state === 'ok' && t1.body.hosts[0].searched >= 2, '맥이 답함')
  ok((await find('text', 'a')).status === 400, '짧은 글은 400')
  const mixed = await ctx.request.post(`${SITE}/api/find`, { data: { mode: 'text', q: 'example', qh: { [c.hostId]: `⟦bt1:0011aabb:${'A'.repeat(60)}⟧` } }, headers: H })
  ok(mixed.status() === 400, `평문 글과 봉인 글을 한 요청에 같이 보내면 400 (${mixed.status()})`)

  step('AI 로 찾기 (2단계)')
  const a1 = await find('ai', 'FINDTWO 배포')
  ok(a1.status === 200 && a1.body.hosts?.[0]?.state === 'ok', `200 (${a1.status} ${JSON.stringify(a1.body).slice(0, 300)})`)
  const p1 = hitsOf(a1.body)
  ok(p1.length === 1 && p1[0].sid === two, `고른 세션 하나, 지어낸 id 는 빠짐 (${JSON.stringify(p1)})`)
  ok(/findtwo/.test(p1[0]?.why ?? ''), '이유 한 줄')
  ok(!fs.readdirSync(path.join(home, 'find')).length, 'claude -p 는 빈 폴더에서, 아무것도 남기지 않음')

  step('화면')
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${SITE}/`)
  const box = page.locator('.list-tools .search')
  await box.fill(LINK)
  ok(await page.getByText('대화 내용에서 찾기').isVisible(), '찾기 줄이 보임')
  ok(await page.getByText('AI 로 찾기').isVisible(), 'AI 로 찾기 줄이 보임')
  await box.press('Enter')
  ok((await until(async () => (await page.locator('.conv-find-hit').count()) === 1, 30000)) !== null, 'Enter 로 찾은 세션 한 줄')
  ok((await page.locator('.conv-find-hit mark').first().textContent())?.toLowerCase() === LINK.toLowerCase(), '찾은 글에 표시')
  await box.fill('FINDTWO 배포')
  await box.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
  ok((await until(async () => (await page.locator('.section-head').allTextContents()).some((t) => /AI 가 고른 세션 · 1/.test(t)), 120000)) !== null, '⌘Enter 로 AI 가 고른 세션 한 줄')
  await page.locator('.conv-find-hit').first().click()
  ok((await until(async () => page.url().endsWith(`/s/${two}`), 10000)) !== null, '누르면 그 세션이 열림')

  step('닫은 세션도 찾음')
  const end = await ctx.request.post(`${SITE}/api/sessions/${one}/do`, { data: { cmd: 'exit' }, headers: H })
  ok(end.ok(), `끝내기 (${end.status()})`)
  ok((await until(async () => (await sess(one))?.closed === true, 30000)) !== null, '닫힘')
  const t2 = await find('text', LINK)
  const h2 = hitsOf(t2.body)
  ok(h2.length === 1 && h2[0].sid === one && h2[0].closed === true, `닫은 세션으로 찾음 (${JSON.stringify(h2.map((h) => [h.sid.slice(0, 8), h.closed]))})`)
  ok(!errors.length, `페이지 오류 없음 ${errors.join(' | ')}`)
  await browser.close()
} catch (e) {
  console.log('FAIL', e.stack || e.message)
  process.exitCode = 1
} finally {
  cleanup()
}
