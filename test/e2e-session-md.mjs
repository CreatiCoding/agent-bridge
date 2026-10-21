// End-to-end (AC-1159): the session file's gauge (SESSION.md / SESSION-<id8>.md) opens the file in a sheet, like the
// AGENTS.md chip. Needs a server (SITE, default :4699) and an agent; its home folder as the first argument.
//   PLAYWRIGHT=… node test/e2e-session-md.mjs <agent home>
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
const work = `${T}/work-md`
fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })
fs.writeFileSync(`${work}/AGENTS.md`, '# 폴더 규칙\n')
const { id } = await (await post('/api/sessions', { hostId: cfg.hostId, cwd: work, model: 'claude-haiku-4-5-20251001', prompt: 'Reply with exactly HI.' })).json()
const app = await ctx.newPage()
await app.goto(`${SITE}/#/s/${id}`)
await app.waitForFunction(() => [...document.querySelectorAll('.msg-text')].some((m) => m.textContent.includes('HI')), null, { timeout: 120000 })
const md = await ctx.request.get(`${SITE}/api/sessions/${id}/agentsmd?file=session`)
console.log('before file:', md.status(), (await md.json()).error)
ok(md.status() === 404, '파일이 없으면 404')
fs.writeFileSync(`${work}/SESSION-${id.slice(0, 8)}.md`, '# 세션 인계\n\n- 할 일: 시험 MDVIEW_OK\n')
// A wide screen folds the calm gauges behind "+{n}" (REQ-F-149 rule 8, AC-1359), and a small SESSION.md is calm:
// wait until the state has the file, open the fold, then take the file's own gauge (not the "+{n}" button).
await app.evaluate(() => { new EventSource('/api/classic/stream').onmessage = (e) => { const m = JSON.parse(e.data); if (m.sessions) window.__st = m } })
await app.waitForFunction((sid) => window.__st?.sessions.find((x) => x.id === sid)?.state?.sessionMd, id, { timeout: 40000 }).catch(async (e) => {
  console.log('state:', JSON.stringify(await app.evaluate((sid) => { const s = window.__st?.sessions.find((x) => x.id === sid)?.state; return { sessionMd: s?.sessionMd, mdFile: s?.mdFile, phase: s?.phase } }, id)), fs.readdirSync(work))
  throw e
})
const more = app.locator('.gauge-more')
await app.waitForTimeout(500)
if (await more.count()) {
  ok(/SESSION-[0-9a-f]{8}\.md/.test((await more.getAttribute('title')) ?? ''), `조용한 SESSION 게이지는 "+n" 에 접힘: ${await more.textContent()} (${await more.getAttribute('title')})`)
  await more.click()
}
const gauge = app.locator('.gauge-link:not(.gauge-more)', { hasText: 'SESSION' })
await gauge.waitFor({ timeout: 10000 })
ok((await gauge.textContent()).includes('SESSION'), `게이지가 버튼으로 보임: ${await gauge.textContent()}`)
// The limit comes with the state (a tenth of the window: Haiku 200k → 20 KB) and the gauge says it.
await app.waitForFunction((sid) => window.__st?.sessions.find((x) => x.id === sid)?.state?.mdMax, id, { timeout: 15000 }).catch(() => {})
const mdMax = await app.evaluate((sid) => window.__st?.sessions.find((x) => x.id === sid)?.state?.mdMax, id)
ok(mdMax === 20000, `200k 세션의 한도 mdMax = 20000 (${mdMax})`)
ok(/20KB 가 넘으면/.test((await gauge.getAttribute('title')) ?? ''), `게이지 설명에 20KB: ${await gauge.getAttribute('title')}`)
await gauge.click()
await app.waitForSelector('.sheet', { timeout: 10000 })
await app.waitForFunction(() => document.querySelector('.sheet')?.textContent.includes('MDVIEW_OK'), null, { timeout: 15000 }).catch(() => {})
const text = await app.evaluate(() => document.querySelector('.sheet')?.textContent ?? '')
ok(/SESSION-[0-9a-f]{8}\.md/.test(text) && text.includes('MDVIEW_OK') && text.includes('세션 인계'), `시트에 SESSION.md 내용: ${text.slice(0, 80)}`)
await app.screenshot({ path: `${T}/mdview.png` })
await app.keyboard.press('Escape')
await app.waitForTimeout(400)
// A wide screen has AGENTS.md in the ⋯ menu, not as a chip (REQ-F-145, 1.249).
await app.getByRole('button', { name: '세션 메뉴' }).click()
await app.getByRole('menuitem', { name: /^AGENTS\.md/ }).click()
await app.waitForFunction(() => document.querySelector('.sheet')?.textContent.includes('폴더 규칙'), null, { timeout: 15000 }).then(() => ok(true, '⋯ 메뉴의 AGENTS.md 는 그대로 AGENTS.md'), () => ok(false, '⋯ 메뉴의 AGENTS.md 는 그대로 AGENTS.md'))
await ctx.request.delete(`${SITE}/api/sessions/${id}`, { headers: { Origin: SITE } })
await browser.close()
