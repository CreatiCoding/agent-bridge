// End-to-end (AC-1162): saving a changed default prompt reopens every session that is up, at once; one that was at
// work is told to go on once it is back and finishes its work. Saving the same text again reopens nothing.
// Needs a server (SITE, default :4699) and an agent; its home folder as the first argument. Uses a real claude.
//   PLAYWRIGHT=… node test/e2e-prompt-refresh.mjs <agent home>
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
const hostId = cfg.hostId
const model = 'claude-haiku-4-5-20251001'
fs.mkdirSync(`${T}/work`, { recursive: true })
// One session at rest, one at work (a 25 s command, then a fixed answer).
const idle = (await (await post('/api/sessions', { hostId, cwd: `${T}/work`, model, prompt: 'Reply with exactly IDLE_OK.' })).json()).id
const busy = (await (await post('/api/sessions', { hostId, cwd: `${T}/work`, model, prompt: 'Run this exact shell command with the Bash tool and wait for it: python3 -c "import time; time.sleep(25); print(\'SLEPT\')" (in the foreground). Then reply with exactly WORK_DONE and nothing else.' })).json()).id
await post(`/api/sessions/${busy}/settings`, { autoAllow: true })
const app = await ctx.newPage()
await app.goto(`${SITE}/#/s/${busy}`)
await app.evaluate(() => {
  new EventSource('/api/classic/stream').onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.sessions) window.__st = m
  }
})
const phase = (sid) => app.evaluate((sid) => window.__st?.sessions.find((x) => x.id === sid)?.state?.phase, sid)
for (let i = 0; i < 180 && !((await phase(idle)) === 'idle' && (await phase(busy)) === 'busy'); i++) await wait(500)
ok((await phase(idle)) === 'idle' && (await phase(busy)) === 'busy', '한 세션은 쉬고 한 세션은 일하는 중')
await wait(3000)
const log = () => fs.readFileSync(`${T}/agent.log`, 'utf8')
const before = log().length
const text = `시험 프롬프트 ${Date.now()}`
const r = await (await post('/api/prefs/prompt', { text })).json()
console.log('note:', r.note)
ok(/세션 2개를 새로고침/.test(r.note) && /일하던 1개/.test(r.note), '저장하면 두 세션을 새로고침, 일하던 1개는 이어감이라고 알림')
await wait(4000)
const after = log().slice(before)
ok((after.match(/refreshing on request/g) ?? []).length === 2, '에이전트가 두 세션을 다시 엶')
ok(/mid-turn: will be told to go on/.test(after), '일하던 세션은 이어서 하라고 전할 것으로 표시')
const answered = (w) => app.waitForFunction((w) => [...document.querySelectorAll('.msg-text')].some((m) => m.textContent.includes(w)), w, { timeout: 180000 }).then(() => true, () => false)
ok(await answered('WORK_DONE'), '다시 뜬 뒤 하던 작업을 이어서 끝냄')
// What the bridge typed itself ([새로고침] …) is not shown as the person's; the note says what happens.
ok((await app.evaluate(() => document.querySelector('.main')?.textContent ?? '')).includes('다시 뜨면 이어서 하라고 전할게요'), '대화에 이어서 하라고 전한다는 알림이 보임')
const again = log().length
const r2 = await (await post('/api/prefs/prompt', { text })).json()
await wait(3000)
ok(/바뀐 내용이 없어/.test(r2.note) && !/refreshing on request/.test(log().slice(again)), `같은 내용 저장은 새로고침하지 않음 (${r2.note})`)
await post('/api/prefs/prompt', { text: '' })
for (const id of [idle, busy]) await ctx.request.delete(`${SITE}/api/sessions/${id}`, { headers: { Origin: SITE } })
await browser.close()
