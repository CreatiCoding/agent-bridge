// 조용한 답과 message.render (REQ-F-850, AC-1578), end to end: the server with one extension that declares
// `messages.quiet: [{suffix: "[조용히]"}]` and changes one word through message.render, one agent and a real
// `claude` session (a few tokens). The page must fold the quiet answer to one line that opens, leave the "새 답" dot
// off for it in the list, and mark the word the extension changed.
// Starts its own server (built from server/) and agent on free ports, and stops them at the end.
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs [SHOTS=<folder>] [CHANNEL=chrome] [MODEL=…] node test/e2e-ext-quiet.mjs
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
    await wait(500)
  }
  return null
}
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)) }) })

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-e2e-quiet-'))
const children = []
let sid = null
const cleanup = () => {
  for (const c of children) c.kill()
  // The session's claude and its terminal run apart from the agent: whatever still runs from this folder goes too.
  try {
    execFileSync('pkill', ['-f', tmp])
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ---- the extension and the server's settings ----
const ext = path.join(tmp, 'ext', 'hush')
fs.mkdirSync(ext, { recursive: true })
fs.writeFileSync(path.join(ext, 'extension.yaml'), `id: hush
name: 조용히 시험
version: 0.1.0
extensionApi: 1
entry: ./index.js
uses:
  actions: [message.render]
messages:
  quiet:
    - suffix: "[조용히]"
      label: 할 일 없음
`)
fs.writeFileSync(path.join(ext, 'index.js'), `export default function (bridge) {
  bridge.actions.around('message.render', (a, next) => (a.text.includes('BRIDGE_SWAP') ? { text: a.text.replace('BRIDGE_SWAP', 'BRIDGE_CHANGED') } : next(a)))
}
`)
const data = path.join(tmp, 'data')
fs.mkdirSync(data)
fs.writeFileSync(path.join(data, 'bridge.yaml'), `extensions:\n  - path: ${ext}\n`)
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
  const agent = spawn(process.execPath, [path.join(ROOT, 'agent', 'agent.mjs'), SITE, '--port', String(agentPort), '--name', 'MacQuiet', '--no-open', '--no-chrome', '--no-auto-update'], { env: { ...process.env, CLAUDECODE: '', CLAUDE_BRIDGE_HOME: home }, stdio: 'ignore' })
  children.push(agent)
  await until(async () => fs.existsSync(path.join(home, 'agent.json')) && JSON.parse(fs.readFileSync(path.join(home, 'agent.json'), 'utf8')).key, 20000)
  const c = JSON.parse(fs.readFileSync(path.join(home, 'agent.json'), 'utf8'))

  const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {})
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  await ctx.request.get(`${SITE}/api/auth/dev?login=tester`)
  const H = { origin: SITE, 'X-Bridge-Ext': '1' }

  step('익스텐션에 동의')
  const list = await (await ctx.request.get(`${SITE}/api/ext`, { headers: H })).json()
  const x = list.extensions.find((e) => e.id === 'hush')
  ok(x && !x.loadError && x.quiet?.[0]?.suffix === '[조용히]' && x.quietAgreed === false, `목록에 규칙이 있고 아직 동의 전 (${JSON.stringify(x?.quiet)})`)
  ok((await ctx.request.post(`${SITE}/api/ext/hush/consent`, { data: { hash: x.hash }, headers: H })).ok(), '동의')
  ok((await (await ctx.request.get(`${SITE}/api/ext`, { headers: H })).json()).extensions[0].quietAgreed === true, 'quietAgreed 참')

  step('연동과 세션')
  const bridge = await ctx.newPage()
  bridge.on('dialog', (d) => d.accept())
  await bridge.goto(`${SITE}/bridge#port=${c.port}&key=${c.key}`)
  await bridge.waitForFunction(() => document.getElementById('server-text')?.textContent === '연결됨', null, { timeout: 30000 })
  const made = await ctx.request.post(`${SITE}/api/sessions`, { data: { hostId: c.hostId, cwd: work, prompt: 'Reply with exactly this line and nothing else, no tools: 오늘은 할 일이 없어요 [조용히]', model: MODEL }, headers: { origin: SITE } })
  sid = (await made.json()).id
  ok(!!sid, `세션 시작 (${made.status()})`)

  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${SITE}/s/${sid}`)
  let t = await until(() => page.locator('.msg-folded').first().isVisible(), 180000)
  ok(t !== null, '조용한 답이 한 줄로 접힘')
  const line = await page.locator('.msg-folded').first().textContent()
  ok(/조용히 접은 답/.test(line) && /할 일 없음/.test(line) && /조용히 시험/.test(line), `접힌 줄에 이유와 익스텐션 이름 (${line})`)
  ok(!(await page.locator('.msg-text').filter({ hasText: '오늘은 할 일이 없어요' }).count()), '펼치기 전에는 글이 안 보임')
  if (shots) await page.screenshot({ path: path.join(shots, 'quiet-folded.png') })
  await page.locator('.msg-folded').first().getByRole('button', { name: '펼치기' }).click()
  ok(await page.locator('.msg-text').filter({ hasText: '오늘은 할 일이 없어요' }).first().isVisible(), '펼치면 글이 보임')
  // The session as the page gets it: the stream's first message is the whole state.
  const meta = await page.evaluate(async (id) => {
    const r = await fetch('/api/classic/stream')
    const rd = r.body.getReader()
    let buf = ''
    for (;;) {
      const { value, done } = await rd.read()
      if (done) return null
      buf += new TextDecoder().decode(value)
      const m = buf.match(/^data: (.+)$/m)
      if (m && m[1].includes('"sessions"')) {
        rd.cancel()
        return JSON.parse(m[1]).sessions?.find((x) => x.id === id) ?? null
      }
    }
  }, sid)
  ok(meta?.lastQuiet === true && (meta.loudSeq ?? 0) < meta.seq, `세션이 조용한 답으로 끝나 새 답 점이 안 뜸 (lastQuiet ${meta?.lastQuiet}, loudSeq ${meta?.loudSeq}, seq ${meta?.seq})`)

  step('보통 답과 message.render 로 바꾼 글')
  await ctx.request.post(`${SITE}/api/sessions/${sid}/say`, { data: { text: 'Reply with exactly the word BRIDGE_SWAP and nothing else.' }, headers: { origin: SITE } })
  t = await until(() => page.locator('.msg-text').filter({ hasText: 'BRIDGE_CHANGED' }).first().isVisible(), 120000)
  ok(t !== null, '익스텐션이 바꾼 글이 보임')
  const mark = page.locator('.msg-changed').filter({ hasText: '이 바꿈' }).first()
  ok(await mark.isVisible(), '바뀐 답 아래 "<이름> 이 바꿈"')
  await mark.getByRole('button', { name: '원문 보기' }).click()
  ok(await page.locator('.msg-text').filter({ hasText: 'BRIDGE_SWAP' }).first().isVisible(), '원문 보기로 답의 글이 보임')
  if (shots) await page.screenshot({ path: path.join(shots, 'quiet-changed.png') })
  ok(errors.length === 0, `페이지 오류 없음 ${errors.join(' | ')}`)
  await ctx.request.post(`${SITE}/api/sessions/${sid}/close`, { headers: { origin: SITE } }).catch(() => {})
  await browser.close()
} catch (e) {
  console.log('FAIL', e)
  console.log(serverLog.slice(-3000))
  process.exitCode = 1
} finally {
  cleanup()
}
