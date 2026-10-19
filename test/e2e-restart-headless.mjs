// End-to-end (AC-1157): an agent linked through 헤드리스 연동 모드 restarts (the site's "restart", as an update does).
// Expect: the Mac never shows as offline, the same Chrome is taken over, the session's gauges (context, usage,
// transcript size) never drop out, and the open session page does not move.
// Needs a server (SITE, default :4699) and an agent run with --service under a loop that starts it again when it
// exits (as launchd does), its home folder as the first argument (agent.json, agent.log there). Uses a real claude
// and this Mac's Chrome.
//   PLAYWRIGHT=… node test/e2e-restart-headless.mjs <agent home>
import fs from 'node:fs'
const { chromium } = await import(process.env.PLAYWRIGHT)
const T = process.argv[2]
const SITE = process.env.SITE || 'http://localhost:4699'
const ok = (c, w) => (console.log(`${c ? 'PASS' : 'FAIL'} ${w}`), c || (process.exitCode = 1))
const cfg = JSON.parse(fs.readFileSync(`${T}/agent/agent.json`, 'utf8'))
const pidFile = `${T}/agent/browser.pid`
const readPid = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : '')
const exits = () => fs.readFileSync(`${T}/agent.log`, 'utf8').split('--- agent exited').length
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } })
await ctx.request.get(`${SITE}/api/auth/dev?login=tester`)
const post = (url, data) => ctx.request.post(`${SITE}${url}`, { data, headers: { Origin: SITE } })
const hostId = cfg.hostId
// A tab links first (헤드리스 연동 모드 is turned on through a linked host), then hands over to the headless Chrome.
const bridge = await ctx.newPage()
await bridge.goto(`${SITE}/bridge#port=${cfg.port}&key=${cfg.key}`)
await bridge.waitForFunction(() => document.getElementById('server-text')?.textContent === '연결됨', null, { timeout: 30000 })
ok((await post(`/api/hosts/${hostId}/background`, { on: true })).ok(), '헤드리스 연동 모드를 켬')
await bridge.close()
const app = await ctx.newPage()
await app.goto(`${SITE}/#/hosts`)
await app.evaluate(() => {
  new EventSource('/api/classic/stream').onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.hosts) window.__st = m
  }
})
const host = () => app.evaluate((id) => window.__st?.hosts.find((h) => h.id === id), hostId)
for (let i = 0; i < 120 && !(await host())?.background?.connected; i++) await wait(500)
ok((await host())?.background?.connected, '헤드리스 브라우저가 연동함')
const { id } = await (await post('/api/sessions', { hostId, cwd: `${T}/work`, model: 'claude-haiku-4-5-20251001', prompt: 'Reply with exactly HI.' })).json()
await app.goto(`${SITE}/#/s/${id}`)
await app.waitForFunction(() => [...document.querySelectorAll('.msg-text')].some((m) => m.textContent.includes('HI')), null, { timeout: 120000 })
// Long enough for the gauges to be read off Claude Code (the status line runs after the answer).
await wait(15000)
const gauges = () => app.evaluate((sid) => {
  const s = window.__st?.sessions.find((x) => x.id === sid)?.state
  return { context: s?.context ?? null, usage: s?.usage ? 'set' : null, size: s?.size ?? null }
}, id)
const had = await gauges()
console.log('before:', JSON.stringify(had), 'chrome pid', readPid())
const pid = readPid()
await app.evaluate(({ hid, sid }) => {
  window.__t0 = performance.now()
  window.__shifts = []
  new PerformanceObserver((l) => l.getEntries().forEach((e) => !e.hadRecentInput && window.__shifts.push(+e.value.toFixed(4)))).observe({ type: 'layout-shift' })
  window.__online = []
  window.__lost = []
  setInterval(() => {
    const h = window.__st?.hosts.find((x) => x.id === hid)
    if (window.__online.at(-1) !== h?.online) window.__online.push(h?.online)
    const s = window.__st?.sessions.find((x) => x.id === sid)?.state
    for (const k of ['context', 'usage', 'size']) if (s && s[k] == null && !window.__lost.includes(k)) window.__lost.push(k)
  }, 50)
}, { hid: hostId, sid: id })
const before = exits()
await post(`/api/hosts/${hostId}/heal`, { action: 'restart' })
for (let i = 0; i < 80 && exits() === before; i++) await wait(250)
ok(exits() > before, '에이전트가 다시 시작함')
await wait(15000)
ok(JSON.stringify(await app.evaluate(() => window.__online)) === '[true]', `다시 시작하는 동안 기기가 끊김으로 바뀌지 않음 (${JSON.stringify(await app.evaluate(() => window.__online))})`)
ok(!!pid && readPid() === pid, `같은 Chrome 을 이어받음 (${pid} → ${readPid()})`)
ok((await host())?.background?.connected, '다시 시작한 뒤에도 헤드리스 브라우저가 연동 중')
const lost = (await app.evaluate(() => window.__lost)).filter((k) => had[k] != null)
ok(!lost.length, `컨텍스트·사용량·대화 기록 크기가 빠지지 않음${lost.length ? `: ${lost.join(', ')}` : ''}`)
const shifts = await app.evaluate(() => window.__shifts)
ok(!shifts.length, `세션 화면이 흔들리지 않음 (layout-shift ${shifts.length}건)`)
await ctx.request.delete(`${SITE}/api/sessions/${id}`, { headers: { Origin: SITE } })
await post(`/api/hosts/${hostId}/background`, { on: false })
await wait(1500)
let alive = false
try {
  process.kill(Number(pid), 0)
  alive = true
} catch {}
ok(!alive, '헤드리스 연동 모드를 끄면 Chrome 이 끝남')
await browser.close()
