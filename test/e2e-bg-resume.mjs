// End-to-end (AC-1163): a background agent that finished and is woken again with SendMessage counts as running
// again, so a refresh tells the session it was cut off (and to start it anew, not resume it).
// Needs a server (SITE, default :4699) and an agent; its home folder as the first argument. Uses a real claude.
//   PLAYWRIGHT=… node test/e2e-bg-resume.mjs <agent home>
import fs from 'node:fs'
const { chromium } = await import(process.env.PLAYWRIGHT)
const T = process.argv[2]
const SITE = process.env.SITE || 'http://localhost:4699'
const ok = (c, w) => (console.log(`${c ? 'PASS' : 'FAIL'} ${w}`), c || (process.exitCode = 1))
const cfg = JSON.parse(fs.readFileSync(`${T}/agent/agent.json`, 'utf8'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } })
await ctx.request.get(`${SITE}/api/auth/dev?login=tester`)
const bridge = await ctx.newPage()
await bridge.goto(`${SITE}/bridge#port=${cfg.port}&key=${cfg.key}`)
await bridge.waitForFunction(() => document.getElementById('server-text')?.textContent === '연결됨', null, { timeout: 30000 })
const post = (url, data) => ctx.request.post(`${SITE}${url}`, { data, headers: { Origin: SITE } })
fs.mkdirSync(`${T}/work`, { recursive: true })
const { id } = await (await post('/api/sessions', { hostId: cfg.hostId, cwd: `${T}/work`, model: 'claude-haiku-4-5-20251001', prompt: 'Use the Agent tool with run_in_background set to true, description "bg-probe", and this prompt for the agent: "Reply with exactly PROBE_ONE and nothing else." Do not wait for it. Then reply with exactly LAUNCHED.' })).json()
await post(`/api/sessions/${id}/settings`, { autoAllow: true })
const app = await ctx.newPage()
await app.goto(`${SITE}/#/s/${id}`)
await app.evaluate(() => {
  new EventSource('/api/classic/stream').onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.sessions) window.__st = m
  }
})
const bg = () => app.evaluate((sid) => window.__st?.sessions.find((x) => x.id === sid)?.bg ?? [], id)
const phase = () => app.evaluate((sid) => window.__st?.sessions.find((x) => x.id === sid)?.state?.phase, id)
for (let i = 0; i < 120 && !(await bg()).length; i++) await wait(500)
ok((await bg()).length === 1, `띄운 백그라운드 에이전트를 셈 (${JSON.stringify(await bg())})`)
// It finishes (a task notification), and the session is told so.
for (let i = 0; i < 240 && (await bg()).length; i++) await wait(500)
ok(!(await bg()).length, '끝나면 목록에서 빠짐')
for (let i = 0; i < 120 && (await phase()) !== 'idle'; i++) await wait(500)
await post(`/api/sessions/${id}/send`, { text: 'Use the SendMessage tool to send the same background agent (by its agent id) this message: "Run this exact shell command with the Bash tool and wait for it: sleep 90. Then reply PROBE_TWO." Do not wait for it. Then reply with exactly RESUMED.' })
for (let i = 0; i < 240 && !(await bg()).length; i++) await wait(500)
ok((await bg()).length === 1 && (await bg())[0].kind === 'agent', `SendMessage 로 다시 깨운 에이전트를 다시 셈 (${JSON.stringify(await bg())})`)
for (let i = 0; i < 120 && (await phase()) !== 'idle'; i++) await wait(500)
const log = () => fs.readFileSync(`${T}/agent.log`, 'utf8')
const before = log().length
await post(`/api/sessions/${id}/refresh`, { when: 'now' })
for (let i = 0; i < 60 && !/releasing held messages \(refreshed\)/.test(log().slice(before)); i++) await wait(500)
ok(/releasing held messages \(refreshed\)/.test(log().slice(before)), '새로고침 뒤 끊긴 백그라운드 작업 안내를 보냄')
// What was typed in reaches the conversation file once Claude takes it in: looked for in the folder's files.
const dir = fs.readdirSync(`${process.env.HOME}/.claude/projects`).map((d) => `${process.env.HOME}/.claude/projects/${d}`).find((d) => fs.readdirSync(d).some((f) => f.startsWith(id)))
const read = () => (dir ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => fs.readFileSync(`${dir}/${f}`, 'utf8')).join('\n') : '')
let sent = ''
for (let i = 0; i < 60 && !/백그라운드 작업이 끊겼어요/.test((sent = read())); i++) await wait(1000)
ok(/백그라운드 작업이 끊겼어요/.test(sent) && /새 에이전트/.test(sent), '안내에 끊긴 에이전트와 새로 띄우라는 말이 있음')
await ctx.request.delete(`${SITE}/api/sessions/${id}`, { headers: { Origin: SITE } })
await browser.close()
