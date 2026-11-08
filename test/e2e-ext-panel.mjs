// 세션 보조 패널 (REQ-F-892, AC-1701), end to end: the server with the example extension (its session.panel note),
// one agent and a real `claude` session (a few tokens). On a wide screen the panel opens as a dock beside the
// conversation, the input steps aside, dragging its edge widens it, and the open panel and its width survive a reload;
// on a phone the same panel opens as a sheet.
// Starts its own server (built from server/) and agent on free ports, and stops them at the end.
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs [SHOTS=<folder>] [CHANNEL=chrome] [MODEL=…] node test/e2e-ext-panel.mjs
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { chromium } = await import(process.env.PLAYWRIGHT)
const shots = process.env.SHOTS
const MODEL = process.env.MODEL ?? 'claude-haiku-4-5-20251001'
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
    await wait(300)
  }
  return null
}
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)) }) })

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-e2e-panel-'))
const children = []
let browser = null
const cleanup = async () => {
  await browser?.close().catch(() => {})
  for (const c of children) c.kill()
  try {
    execFileSync('pkill', ['-f', tmp])
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true })
}

const data = path.join(tmp, 'data')
fs.mkdirSync(data)
fs.writeFileSync(path.join(data, 'bridge.yaml'), `extensions:\n  - path: ${path.join(ROOT, 'extensions', 'example')}\n`)
const work = path.join(tmp, 'work')
fs.mkdirSync(work)

const [serverPort, agentPort] = [await freePort(), await freePort()]
const SITE = `http://localhost:${serverPort}`
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
  const agent = spawn(process.execPath, [path.join(ROOT, 'agent', 'agent.mjs'), SITE, '--port', String(agentPort), '--name', 'MacPanel', '--no-open', '--no-chrome', '--no-auto-update'], { env: { ...process.env, CLAUDECODE: '', CLAUDE_BRIDGE_HOME: home }, stdio: 'ignore' })
  children.push(agent)
  await until(async () => fs.existsSync(path.join(home, 'agent.json')) && JSON.parse(fs.readFileSync(path.join(home, 'agent.json'), 'utf8')).key, 20000)
  const c = JSON.parse(fs.readFileSync(path.join(home, 'agent.json'), 'utf8'))

  browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {})
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ko-KR' })
  await ctx.request.get(`${SITE}/api/auth/dev?login=tester`)
  const H = { origin: SITE, 'X-Bridge-Ext': '1' }

  step('익스텐션에 동의')
  const list = await (await ctx.request.get(`${SITE}/api/ext`, { headers: H })).json()
  const x = list.extensions.find((e) => e.id === 'example')
  ok(x && !x.loadError && x.uses?.slots?.includes('session.panel'), `예시 익스텐션이 session.panel 을 씀 (${x?.loadError ?? ''})`)
  ok((await ctx.request.post(`${SITE}/api/ext/example/consent`, { data: { hash: x.hash }, headers: H })).ok(), '동의')

  step('연동과 세션')
  const bridge = await ctx.newPage()
  bridge.on('dialog', (d) => d.accept())
  await bridge.goto(`${SITE}/bridge#port=${c.port}&key=${c.key}`)
  await bridge.waitForFunction(() => document.getElementById('server-text')?.textContent === '연결됨', null, { timeout: 30000 })
  const made = await ctx.request.post(`${SITE}/api/sessions`, { data: { hostId: c.hostId, cwd: work, prompt: 'Reply with exactly the word OK and nothing else. Do not use any tools.', model: MODEL }, headers: { origin: SITE } })
  const sid = (await made.json()).id
  ok(!!sid, `세션 시작 (${made.status()})`)

  step('넓은 화면: 도크')
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${SITE}/s/${sid}`)
  const toggle = page.locator('.topbar').getByRole('button', { name: '세션 메모', exact: true })
  const seen = (await until(() => toggle.isVisible(), 30000)) !== null
  ok(seen, '위 막대에 패널 버튼')
  if (!seen) {
    console.log(await page.locator('.topbar button').evaluateAll((b) => b.map((x) => x.getAttribute('aria-label') || x.textContent)))
    if (shots) await page.screenshot({ path: path.join(shots, 'panel-fail.png') })
  }
  await toggle.click()
  const dock = page.locator('.ext-dock')
  ok((await until(() => dock.locator('textarea').isVisible(), 10000)) !== null, '도크가 대화 오른쪽에 열리고 패널 내용(메모 입력칸)이 보임')
  ok((await toggle.getAttribute('aria-pressed')) === 'true', '버튼이 눌린 상태')
  const w0 = (await dock.boundingBox()).width
  // The input's padding slides (0.26 s).
  const padOf = () => page.locator('.composer').evaluate((el) => parseFloat(getComputedStyle(el).paddingRight))
  await until(async () => (await padOf()) >= w0, 3000)
  const pad = await padOf()
  ok(Math.abs(w0 - 360) <= 2 && pad >= w0, `처음 폭 360 px, 입력칸이 비켜 섬 (폭 ${w0}, 오른쪽 여백 ${pad})`)
  const convo = await page.locator('.convo').boundingBox()
  const db = await dock.boundingBox()
  ok(db.x >= convo.x + convo.width - 1, '도크가 대화 오른쪽')
  if (shots) await page.screenshot({ path: path.join(shots, 'panel-dock.png') })
  const edge = await page.locator('.ext-resize').boundingBox()
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2)
  await page.mouse.down()
  await page.mouse.move(edge.x + edge.width / 2 - 100, edge.y + edge.height / 2, { steps: 5 })
  await page.mouse.up()
  const w1 = (await dock.boundingBox()).width
  ok(Math.abs(w1 - (w0 + 100)) <= 4, `가장자리를 끌면 넓어짐 (${w0} → ${w1})`)
  await page.locator('.ext-resize').focus()
  await page.keyboard.press('ArrowRight')
  const w2 = (await dock.boundingBox()).width
  ok(Math.abs(w2 - (w1 - 24)) <= 2, `키보드 → 로 24 px 좁아짐 (${w1} → ${w2})`)

  step('다시 열어도 열린 패널과 폭이 그대로')
  await page.reload()
  ok((await until(() => page.locator('.ext-dock textarea').isVisible(), 30000)) !== null, '다시 열어도 도크가 열려 있음')
  const w3 = (await page.locator('.ext-dock').boundingBox()).width
  ok(Math.abs(w3 - w2) <= 2, `폭을 이 기기에 기억 (${w2} → ${w3})`)
  await page.locator('.ext-dock').getByRole('button', { name: '세션 메모 닫기' }).click()
  ok((await until(async () => !(await page.locator('.ext-dock').count()), 5000)) !== null, '닫기로 접힘')
  await until(async () => (await padOf()) < 100, 3000)
  const pad2 = await padOf()
  ok(pad2 < 100, `접으면 입력칸 여백이 돌아옴 (${pad2})`)

  step('좁은 화면: 시트')
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'ko-KR' })
  await phone.addCookies(await ctx.cookies())
  const p2 = await phone.newPage()
  p2.on('pageerror', (e) => errors.push(e.message))
  await p2.goto(`${SITE}/s/${sid}`)
  const t2 = p2.locator('.topbar').getByRole('button', { name: '세션 메모', exact: true })
  ok((await until(() => t2.isVisible(), 30000)) !== null, '휴대폰 위 막대에도 패널 버튼')
  await t2.click()
  ok((await until(() => p2.locator('.sheet.ext-panel-sheet textarea').isVisible(), 10000)) !== null, '휴대폰에서는 시트로 열림')
  ok(!(await p2.locator('.ext-dock').count()), '휴대폰에는 도크가 없음')
  // After the sheet has risen.
  if (shots) await wait(600).then(() => p2.screenshot({ path: path.join(shots, 'panel-sheet.png') }))

  ok(errors.length === 0, `페이지 오류 없음 ${errors.join(' | ')}`)
  await ctx.request.post(`${SITE}/api/sessions/${sid}/close`, { headers: { origin: SITE } }).catch(() => {})
  await browser.close()
} catch (e) {
  console.log('FAIL', e)
  console.log(serverLog.slice(-3000))
  process.exitCode = 1
} finally {
  await cleanup()
}
