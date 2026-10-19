// End-to-end: the agent restarts in the middle of a turn (the site's "restart", as an update does) and a message is sent while
// it is down. Expect: no error on the page, the turn is still a turn after the restart, the message is delivered
// once the agent is back, and both answers arrive.
// Needs a server (SITE, default :4699) and an agent run with --service under a loop that starts it again when it
// exits (as launchd does), its home folder as the first argument (agent.json, agent.log there). Uses a real claude.
//   PLAYWRIGHT=… node test/e2e-restart.mjs <agent home>
import fs from 'node:fs'
const { chromium } = await import(process.env.PLAYWRIGHT)
const T = process.argv[2]
const SITE = process.env.SITE || 'http://localhost:4699'
const ok = (c, w) => (console.log(`${c ? 'PASS' : 'FAIL'} ${w}`), c || (process.exitCode = 1))
const cfg = JSON.parse(fs.readFileSync(`${T}/agent/agent.json`, 'utf8'))
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } })
await ctx.request.get(`${SITE}/api/auth/dev?login=tester`)
const bridge = await ctx.newPage()
await bridge.goto(`${SITE}/bridge#port=${cfg.port}&key=${cfg.key}`)
await bridge.waitForFunction(() => document.getElementById('server-text')?.textContent === '연결됨', null, { timeout: 30000 })
const post = (url, data) => ctx.request.post(`${SITE}${url}`, { data, headers: { Origin: SITE } })
const hostId = cfg.hostId
const r = await post('/api/sessions', { hostId, cwd: `${T}/work`, model: 'claude-haiku-4-5-20251001', prompt: 'Run this exact shell command with the Bash tool and wait for it: python3 -c \"import time; time.sleep(30); print(\'SLEPT\')\" (in the foreground). Then reply with exactly FIRST_DONE and nothing else.' })
const { id } = await r.json()
await post(`/api/sessions/${id}/settings`, { autoAllow: true })
const app = await ctx.newPage()
const errors = []
app.on('pageerror', (e) => errors.push(e.message))
await app.goto(`${SITE}/s/${id}`)
const toasts = []
await app.exposeFunction('__toast', (t) => toasts.push(t))
await app.evaluate(() => new MutationObserver(() => document.querySelectorAll('.toast').forEach((t) => !t.dataset.seen && ((t.dataset.seen = 1), window.__toast(t.textContent)))).observe(document.body, { childList: true, subtree: true }))
const phase = async () => (await app.evaluate(() => [...document.querySelectorAll('.main .topbar span, .main .topbar-title')].map((e) => e.textContent).join(' | '))).slice(0, 200)
// Wait until the Bash call is running.
await app.waitForFunction(() => /작업 중/.test(document.querySelector('.main')?.textContent ?? ''), null, { timeout: 90000 }).catch(async (e) => { await app.screenshot({ path: `${T}/stuck.png` }); console.log('MAIN:', (await app.evaluate(() => document.querySelector('.main')?.innerText ?? '')).slice(0, 600)); throw e })
await new Promise((r) => setTimeout(r, 4000))
console.log('turn running:', await phase())
const before = fs.readFileSync(`${T}/agent.log`, 'utf8').split('--- agent exited').length
const heal = await post(`/api/hosts/${hostId}/heal`, { action: 'restart' })
console.log('restart asked:', heal.status(), (await heal.json()).note ?? '')
// Send while it goes down.
for (let i = 0; i < 40 && !/다시 시작합니다/.test(fs.readFileSync(`${T}/agent.log`, "utf8").split("\n").slice(-3).join(" ")); i++) await new Promise((r) => setTimeout(r, 100))
await new Promise((r) => setTimeout(r, 450))
const sent = await post(`/api/sessions/${id}/send`, { text: 'After that, also reply with exactly SECOND_DONE on its own line.' })
console.log('send during restart:', sent.status())
ok(sent.ok(), '재시작 중에 보낸 글이 오류로 거절되지 않음')
for (let i = 0; i < 40 && fs.readFileSync(`${T}/agent.log`, 'utf8').split('--- agent exited').length === before; i++) await new Promise((r) => setTimeout(r, 250))
ok(fs.readFileSync(`${T}/agent.log`, 'utf8').split('--- agent exited').length > before, '에이전트가 일하는 중에 바로 재시작함(쉴 때까지 기다리지 않음)')
await new Promise((r) => setTimeout(r, 6000))
console.log('after restart:', await phase())
ok(/작업 중|응답 대기/.test(await app.evaluate(() => document.querySelector('.main')?.textContent ?? '')), '재시작 뒤에도 그 턴이 일하는 중으로 보임')
const answered = (w) => app.waitForFunction((w) => [...document.querySelectorAll('.msg-text')].some((m) => m.textContent.includes(w)), w, { timeout: 150000 }).then(() => true, () => false)
ok(await answered('FIRST_DONE'), '재시작 전에 시작한 턴의 답이 옴')
ok(await answered('SECOND_DONE'), '재시작 중에 보낸 글이 전달되어 답이 옴')
const bad = toasts.filter((t) => /502|못했|연결돼 있지|실패|오류/.test(t))
ok(!bad.length, `오류 토스트 없음${bad.length ? `: ${bad.join(' | ')}` : ''}`)
ok(!errors.length, `페이지 오류 없음${errors.length ? `: ${errors.join(' | ')}` : ''}`)
console.log('agent log tail:', fs.readFileSync(`${T}/agent.log`, 'utf8').split('\n').filter((l) => /update|handoff|relay|에이전트에 닿지|시작:|exited/.test(l)).slice(-6).join('\n'))
await ctx.request.delete(`${SITE}/api/sessions/${id}`, { headers: { Origin: SITE } })
await browser.close()
