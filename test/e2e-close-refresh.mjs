// End-to-end (AC-1426): a session deleted while it is being reopened (a changed default prompt reopens it) stays
// closed: the reopening stops, and no terminal (zeropty or tmux) is left on the Mac for a session the server no
// longer has. Tried at a few moments of the reopening: before its new terminal exists, while claude is starting in
// it, and just after. Needs a server (SITE, default :4699) and an agent; its home folder as the first argument.
// The terminal programs are the agent's own: `tmux` on PATH and the agent's zeropty (ZEROPTY_SOCK as the agent has it).
//   PLAYWRIGHT=… node test/e2e-close-refresh.mjs <agent home>
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
const { chromium } = await import(process.env.PLAYWRIGHT)
const T = process.argv[2]
const SITE = process.env.SITE || 'http://localhost:4699'
const ok = (c, w) => (console.log(`${c ? 'PASS' : 'FAIL'} ${w}`), c || (process.exitCode = 1))
const cfg = JSON.parse(fs.readFileSync(`${T}/agent/agent.json`, 'utf8'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const zpDir = fs.existsSync(`${T}/agent/zeropty`) ? fs.readdirSync(`${T}/agent/zeropty`).map((v) => `${T}/agent/zeropty/${v}/zeropty`).find((f) => fs.existsSync(f)) : null
const has = (bin, name) => {
  try {
    execFileSync(bin, ['has-session', '-t', `=${name}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const terminals = (name) => [...(zpDir && has(zpDir, name) ? ['zeropty'] : []), ...(has('tmux', name) ? ['tmux'] : [])]

const browser = await chromium.launch()
const ctx = await browser.newContext()
await ctx.request.get(`${SITE}/api/auth/dev?login=tester`)
const bridge = await ctx.newPage()
await bridge.goto(`${SITE}/bridge#port=${cfg.port}&key=${cfg.key}`)
await bridge.waitForFunction(() => document.getElementById('server-text')?.textContent === '연결됨', null, { timeout: 30000 })
const post = (url, data) => ctx.request.post(`${SITE}${url}`, { data, headers: { Origin: SITE } })
// What the server has: its live stream, as the page reads it.
const app = await ctx.newPage()
await app.goto(SITE)
await app.evaluate(() => { new EventSource('/api/classic/stream').onmessage = (e) => { const m = JSON.parse(e.data); if (m.sessions) window.__st = m } })
const onServer = (id) => app.evaluate((id) => window.__st?.sessions.find((x) => x.id === id) ?? null, id)
const work = `${T}/work-close`
fs.mkdirSync(work, { recursive: true })
const logLen = () => fs.statSync(`${T}/agent.log`).size
for (const delay of [0, 1500, 3500]) {
  const { id } = await (await post('/api/sessions', { hostId: cfg.hostId, cwd: work, model: 'claude-haiku-4-5-20251001', prompt: 'Reply with exactly HI.' })).json()
  const name = `cb-${cfg.hostId.slice(0, 4)}-${id.slice(0, 8)}`
  for (let i = 0; i < 120; i++) {
    if ((await onServer(id))?.state?.phase === 'idle') break
    await wait(1000)
  }
  ok(terminals(name).length === 1, `[${delay}ms] 세션 터미널이 하나 떠 있음 (${terminals(name)})`)
  const from = logLen()
  await post('/api/prefs/prompt', { text: `close-refresh ${Date.now()}` })
  await wait(delay)
  await ctx.request.delete(`${SITE}/api/sessions/${id}`, { headers: { Origin: SITE } })
  await wait(12000)
  const log = fs.readFileSync(`${T}/agent.log`).subarray(from).toString()
  ok(/\[refresh\].*refreshing on request/.test(log.split('\n').filter((l) => l.includes(id.slice(0, 8))).join('\n')), `[${delay}ms] 다시 열기가 시작됐음`)
  ok(terminals(name).length === 0, `[${delay}ms] 지운 세션의 터미널이 남지 않음 (${terminals(name).join(',') || '없음'})`)
  const saved = JSON.parse(fs.readFileSync(`${T}/agent/sessions.json`, 'utf8'))
  ok(!(id in saved), `[${delay}ms] 에이전트의 sessions.json 에도 없음`)
  ok(!(await onServer(id)), `[${delay}ms] 서버 목록에도 없음`)
}
await post('/api/prefs/prompt', { text: '' })
await browser.close()
