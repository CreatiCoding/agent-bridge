// 스트림이 막힌 네트워크 (REQ-F-849), end to end: the server, one agent and a browser behind a local proxy that holds
// every event stream (text/event-stream) back until it ends, as a buffering proxy does. The control page and the
// Mac's bridge tab must fall back to fetching, keep working (a command reaches the Mac, a change reaches the page),
// and go back to streams once the proxy lets them through again.
// Starts its own server (built from server/), proxy and agent on free ports, and stops them at the end. No `claude`
// session is started. Takes about three minutes (the page tries a stream again a minute after it began fetching).
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs [SHOTS=<folder>] [CHANNEL=chrome] node test/e2e-sse-fallback.mjs
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { chromium } = await import(process.env.PLAYWRIGHT)
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
const secs = (ms) => (ms === null ? '안 됨' : `${(ms / 1000).toFixed(1)}초`)
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)) }) })

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-e2e-sse-'))
const children = []
const cleanup = () => {
  for (const c of children) c.kill()
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ---- the server ----
const [serverPort, proxyPort, agentPort] = [await freePort(), await freePort(), await freePort()]
const SITE = `http://localhost:${proxyPort}`
const bin = path.join(tmp, 'bridge-server')
execFileSync('go', ['build', '-o', bin, '.'], { cwd: path.join(ROOT, 'server'), stdio: 'inherit' })
const data = path.join(tmp, 'data')
fs.mkdirSync(data)
const server = spawn(bin, [], { cwd: ROOT, env: { ...process.env, CLAUDECODE: '', HOME: data, PORT: String(serverPort), BRIDGE_DATA: data, BRIDGE_DEV_LOGIN: '1', GITHUB_ALLOWED_LOGINS: 'tester', BRIDGE_ORIGIN: SITE, BRIDGE_ROOT: ROOT }, stdio: ['ignore', 'pipe', 'pipe'] })
children.push(server)
let serverLog = ''
server.stdout.on('data', (d) => (serverLog += d))
server.stderr.on('data', (d) => (serverLog += d))

// ---- the proxy: passes everything, except that while `blocking` an event stream is held until it ends ----
let blocking = true
const held = { streams: 0, released: 0 }
const proxy = http.createServer((req, res) => {
  const up = http.request({ host: '127.0.0.1', port: serverPort, path: req.url, method: req.method, headers: req.headers }, (ur) => {
    const stream = /text\/event-stream/.test(ur.headers['content-type'] || '')
    if (!stream || !blocking) {
      res.writeHead(ur.statusCode, ur.headers)
      return void ur.pipe(res)
    }
    held.streams++
    const chunks = []
    ur.on('data', (c) => chunks.push(c))
    ur.on('end', () => {
      held.released++
      res.writeHead(ur.statusCode, ur.headers)
      res.end(Buffer.concat(chunks))
    })
    res.on('close', () => ur.destroy())
  })
  up.on('error', () => res.destroy())
  req.pipe(up)
})
await new Promise((r) => proxy.listen(proxyPort, '127.0.0.1', r))

try {
  for (let i = 0; i < 100 && !(await fetch(`${SITE}/api/health`).then((r) => r.ok, () => false)); i++) await wait(100)

  // ---- one agent, linked through the proxy ----
  const home = path.join(tmp, 'agent')
  const agent = spawn(process.execPath, [path.join(ROOT, 'agent', 'agent.mjs'), SITE, '--port', String(agentPort), '--name', 'MacE2E', '--no-open', '--no-chrome', '--no-auto-update'], { env: { ...process.env, CLAUDECODE: '', CLAUDE_BRIDGE_HOME: home }, stdio: 'ignore' })
  children.push(agent)
  await until(async () => fs.existsSync(path.join(home, 'agent.json')) && JSON.parse(fs.readFileSync(path.join(home, 'agent.json'), 'utf8')).key, 20000)
  const c = JSON.parse(fs.readFileSync(path.join(home, 'agent.json'), 'utf8'))

  const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {})
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  await ctx.request.get(`${SITE}/api/auth/dev?login=tester`)
  const relayState = (p) => p.evaluate(() => window.__relay?.state()).catch(() => null)
  /** A command to the Mac and back, through the bridge tab. */
  const reaches = async () => (await ctx.request.get(`${SITE}/api/hosts/${c.hostId}/dirs?path=~`, { timeout: 15000 }).catch(() => null))?.status() === 200

  step('스트림이 막힌 채 연동 탭을 엶')
  const bridge = await ctx.newPage()
  bridge.on('dialog', (d) => d.accept())
  await bridge.goto(`${SITE}/bridge#port=${c.port}&key=${c.key}`)
  let t = await until(async () => (await relayState(bridge))?.down === 'poll', 60000)
  ok(t !== null, `연동 탭이 서버 스트림이 막힌 것을 알아채고 폴링으로 넘어감 (${secs(t)})`)
  ok(held.streams >= 2, `프록시가 스트림을 붙잡고 있었음 (${held.streams}개)`)
  t = await until(reaches, 30000)
  ok(t !== null, `폴링으로도 명령이 맥까지 왕복 (${secs(t)})`)

  step('스트림이 막힌 채 조작 화면을 엶')
  const page = await ctx.newPage()
  await page.goto(`${SITE}/`)
  const chip = () => page.locator('.poll-chip').first().isVisible()
  t = await until(chip, 60000)
  ok(t !== null, `조작 화면이 폴링으로 넘어가 "폴링" 표시가 보임 (${secs(t)})`)
  if (shots) await page.screenshot({ path: path.join(shots, 'sse-fallback-poll.png') })
  const name = `폴링그룹${Date.now() % 10000}`
  await ctx.request.post(`${SITE}/api/groups`, { data: { op: 'create', name }, headers: { origin: SITE } })
  t = await until(async () => (await page.content()).includes(name), 30000)
  ok(t !== null, `폴링 중에도 바뀐 것이 화면에 옴 (새 그룹, ${secs(t)})`)
  ok((await page.evaluate(() => document.title)).length > 0 && (await relayState(bridge))?.healthy, '연동 탭이 폴링 중에도 건강함')

  step('프록시가 스트림을 다시 통과시킴')
  blocking = false
  t = await until(async () => !(await chip()) && (await relayState(bridge))?.down === 'sse', 150000)
  ok(t !== null, `조작 화면과 연동 탭이 다시 스트림으로 돌아옴 (${secs(t)})`)
  if (shots) await page.screenshot({ path: path.join(shots, 'sse-fallback-back.png') })
  t = await until(reaches, 30000)
  ok(t !== null, `스트림으로 돌아온 뒤에도 명령이 맥까지 왕복 (${secs(t)})`)
  const name2 = `스트림그룹${Date.now() % 10000}`
  await ctx.request.post(`${SITE}/api/groups`, { data: { op: 'create', name: name2 }, headers: { origin: SITE } })
  t = await until(async () => (await page.content()).includes(name2), 15000)
  ok(t !== null, `스트림으로 돌아온 뒤 바뀐 것이 화면에 옴 (${secs(t)})`)
  await browser.close()
} catch (e) {
  console.log('FAIL', e)
  console.log(serverLog.slice(-3000))
  process.exitCode = 1
} finally {
  proxy.close()
  proxy.closeAllConnections?.()
  cleanup()
}
console.log(process.exitCode ? '\n실패' : '\n모두 통과')
process.exit()
