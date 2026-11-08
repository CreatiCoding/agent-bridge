// 로컬 어댑터와 패널 열기 API (REQ-F-893·REQ-F-894, AC-1706), end to end: the server with the example extension, one
// agent with the example's adapter installed in its home, and a real `claude` session (a few tokens).
// Adapters: a read and a write go page → server → agent → adapter and back; the same write requestId sent twice (at
// once and again) runs once; status tells none for an id that never arrived. Panels: entering a session that has a
// note opens its panel, folding it keeps it folded on the next entry, the header button opens it again, and its
// "맥에 남기기" reaches the adapter; on a phone the same button opens a sheet.
// Starts its own server (built from server/) and agent on free ports, and stops them at the end.
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs [SHOTS=<folder>] [CHANNEL=chrome] [MODEL=…] node test/e2e-ext-adapter.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-e2e-adapter-'))
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
  // The Mac's owner installs the example's adapter (extensions/example/adapter/README.md).
  const ad = path.join(home, 'adapters', 'example')
  fs.mkdirSync(path.dirname(ad), { recursive: true })
  fs.cpSync(path.join(ROOT, 'extensions', 'example', 'adapter'), ad, { recursive: true })
  fs.chmodSync(ad, 0o755)
  for (const f of fs.readdirSync(ad)) fs.chmodSync(path.join(ad, f), 0o644)
  const notesFile = path.join(ad, 'notes.jsonl')
  const kept = () => (fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  const agent = spawn(process.execPath, [path.join(ROOT, 'agent', 'agent.mjs'), SITE, '--port', String(agentPort), '--name', 'MacAdapter', '--no-open', '--no-chrome', '--no-auto-update'], { env: { ...process.env, CLAUDECODE: '', CLAUDE_BRIDGE_HOME: home, EXAMPLE_ADAPTER_DELAY_MS: '1200' }, stdio: 'ignore' })
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
  ok(x && !x.loadError && x.adapters?.some((a) => a.action === 'note.save' && a.access === 'write'), `예시 익스텐션이 adapters 를 적음 (${x?.loadError ?? ''})`)
  ok((await ctx.request.post(`${SITE}/api/ext/example/consent`, { data: { hash: x.hash }, headers: H })).ok(), '동의')

  step('연동과 세션')
  const bridge = await ctx.newPage()
  bridge.on('dialog', (d) => d.accept())
  await bridge.goto(`${SITE}/bridge#port=${c.port}&key=${c.key}`)
  await bridge.waitForFunction(() => document.getElementById('server-text')?.textContent === '연결됨', null, { timeout: 30000 })
  const made = await ctx.request.post(`${SITE}/api/sessions`, { data: { hostId: c.hostId, cwd: work, prompt: 'Reply with exactly the word OK and nothing else. Do not use any tools.', model: MODEL }, headers: { origin: SITE } })
  const sid = (await made.json()).id
  ok(!!sid, `세션 시작 (${made.status()})`)

  step('로컬 어댑터: 서버 → 맥 → 어댑터')
  const post = async (sub, data) => (await ctx.request.post(`${SITE}/api/ext/example/adapter${sub}`, { data, headers: H, timeout: 60000 })).json()
  const ls = await post('/list', { sid })
  ok(ls.ok && ls.actions?.['note.save'] === 'write' && ls.actions?.['note.list'] === 'read', `맥에 있는 작업 목록 ${JSON.stringify(ls.actions)}`)
  // The same write id sent twice at once (a resend while the first runs: the adapter takes 1.2 s), then again.
  const rid = `e2e-${Date.now()}`
  const [a1, a2] = await Promise.all([post('', { sid, action: 'note.save', input: { text: '첫 줄' }, requestId: rid }), post('', { sid, action: 'note.save', input: { text: '첫 줄' }, requestId: rid })])
  ok(a1.state === 'done' && a2.state === 'done' && (a1.replayed || a2.replayed), `같은 요청 두 번: 둘 다 done, 하나는 replayed (${a1.state}/${a2.state})`)
  const a3 = await post('', { sid, action: 'note.save', input: { text: '첫 줄' }, requestId: rid })
  ok(a3.state === 'done' && a3.replayed, '다시 보내도 처음 결과(replayed)')
  ok(kept().length === 1 && kept()[0].sid === sid, `어댑터는 한 번만 실행 (줄 ${kept().length})`)
  const rd = await post('', { sid, action: 'note.list', input: {}, requestId: `e2e-r-${Date.now()}` })
  ok(rd.state === 'done' && rd.result?.notes?.length === 1 && rd.result.notes[0].text === '첫 줄', `읽기 작업의 결과 ${JSON.stringify(rd.result)}`)
  ok((await post('/status', { sid, requestId: rid })).state === 'done', 'status: 끝난 요청은 done')
  ok((await post('/status', { sid, requestId: 'never-arrived-1' })).state === 'none', 'status: 닿지 않은 요청은 none')
  const undeclared = await ctx.request.post(`${SITE}/api/ext/example/adapter`, { data: { sid, action: 'shell.run', requestId: 'e2e-bad-0001' }, headers: H })
  ok(undeclared.status() === 403, `extension.yaml 에 없는 작업은 403 (${undeclared.status()})`)

  step('패널: 메모가 있는 세션에 들어가면 열림')
  ok((await ctx.request.put(`${SITE}/api/ext/example/storage/user/note.${sid}`, { data: { value: '메모' }, headers: { ...H, 'Content-Type': 'application/json' } })).ok(), '메모 저장')
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${SITE}/`)
  const row = page.locator(`[data-sid="${sid}"]`).first()
  ok((await until(() => row.isVisible(), 30000)) !== null, '목록에 세션')
  await row.click()
  const dock = page.locator('.ext-dock')
  ok((await until(() => dock.locator('textarea').isVisible(), 15000)) !== null, '들어가자 메모 패널이 도크로 열림 (panels.open)')
  await dock.getByRole('button', { name: '세션 메모 닫기' }).click()
  ok((await until(async () => !(await dock.count()), 5000)) !== null, '사람이 닫음')
  await page.goto(`${SITE}/`)
  await until(() => row.isVisible(), 30000)
  await row.click()
  await until(() => page.locator('.topbar').isVisible(), 10000)
  await wait(2500)
  ok(!(await dock.count()), '사람이 닫은 패널은 다시 들어가도 닫혀 있음 (unlessClosed)')

  step('패널: 위 막대의 메모 버튼으로 다시 열고 맥에 남기기')
  const btn = page.locator('.topbar').getByRole('button', { name: '메모', exact: true })
  ok((await until(() => btn.isVisible(), 10000)) !== null, '위 막대에 메모 버튼')
  await btn.click()
  ok((await until(() => dock.locator('textarea').isVisible(), 10000)) !== null, '버튼이 패널을 엶 (명시적으로 다시 열기)')
  await until(async () => (await dock.locator('textarea').inputValue()) === '메모', 5000)
  await dock.locator('textarea').fill('패널에서')
  await dock.getByRole('button', { name: '맥에 남기기' }).click()
  ok((await until(async () => kept().some((n) => n.text === '패널에서'), 15000)) !== null, '패널의 버튼이 맥의 어댑터에 닿음')
  ok((await until(() => page.getByText('맥에 남겼어요').first().isVisible(), 5000)) !== null, '결과 안내')
  if (shots) await page.screenshot({ path: path.join(shots, 'adapter-dock.png') })

  step('좁은 화면: 같은 버튼이 시트로')
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'ko-KR' })
  await phone.addCookies(await ctx.cookies())
  const p2 = await phone.newPage()
  p2.on('pageerror', (e) => errors.push(e.message))
  await p2.goto(`${SITE}/s/${sid}`)
  // This device has its own memory: the panel was opened from the PC, so it is open here only once asked for.
  const t2 = p2.locator('.topbar').getByRole('button', { name: '메모', exact: true })
  const sheet = p2.locator('.sheet.ext-panel-sheet textarea')
  if (!(await sheet.isVisible().catch(() => false))) {
    ok((await until(() => t2.isVisible(), 30000)) !== null, '휴대폰 위 막대에 메모 버튼')
    await t2.click()
  }
  ok((await until(() => sheet.isVisible(), 10000)) !== null, '휴대폰에서는 시트로 열림')
  ok(!(await p2.locator('.ext-dock').count()), '휴대폰에는 도크가 없음')

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
