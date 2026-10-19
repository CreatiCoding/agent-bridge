// End-to-end check of 음성 모드 across 분할 화면's panes (REQ-F-788) on the public demo, with Chrome's fake microphone.
// Against a local server (no Mac or agent). Needs playwright (not a dependency):
//   BRIDGE_DEMO=1 BRIDGE_ORIGIN=http://localhost:4399 PORT=4399 BRIDGE_DATA=/tmp/cb-voice node server/server.mjs
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node test/e2e-split-voice.mjs
const { chromium } = await import(process.env.PLAYWRIGHT)
const SITE = process.env.SITE || 'http://localhost:4399'
const shots = process.env.SHOTS
const ok = (cond, what) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`)
  if (!cond) process.exitCode = 1
}
const browser = await chromium.launch({
  ...(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {}),
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})
const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, permissions: ['microphone'] })
const app = await ctx.newPage()
const errors = []
app.on('pageerror', (e) => errors.push(e.message))
const pane = (i) => app.frameLocator('iframe.split-pane').nth(i)
const hearing = () => app.locator('iframe.split-pane').evaluateAll((fs) => fs.map((f) => f.classList.contains('hearing')))

await app.goto(SITE)
await app.getByRole('button', { name: '데모로 둘러보기' }).click()
await app.waitForFunction(() => document.querySelectorAll('[data-sid]').length >= 3, null, { timeout: 15000 })
await app.getByRole('button', { name: '나중에' }).click({ timeout: 10000 })
const ids = await app.$$eval('[data-sid]', (els) => [...new Set(els.map((e) => e.dataset.sid))])
// The two sessions that do not wait on a permission card.
await app.goto(`${SITE}/split?s=${ids.slice(0, 3).join(',')}`)
await app.waitForFunction(() => [...document.querySelectorAll('iframe.split-pane')].filter((f) => f.contentDocument?.querySelector('.inputbox')).length === 3, null, { timeout: 20000 })
await app.getByRole('button', { name: '나중에' }).click({ timeout: 3000 }).catch(() => {})

console.log('\n== 한 칸에서 켜기')
await pane(0).locator('.mic-btn').first().click()
await pane(0).locator('.voice-mode').waitFor({ timeout: 15000 })
ok(true, '켠 칸(1번)에 음성 판')
ok(/1번 칸이 받는 중/.test(await pane(0).locator('.voice-pane').textContent()), '음성 판에 "1번 칸이 받는 중"')
await pane(1).locator('.voice-elsewhere').waitFor({ timeout: 5000 })
await pane(2).locator('.voice-elsewhere').waitFor({ timeout: 5000 })
ok(/1번 칸/.test(await pane(1).locator('.voice-elsewhere').textContent()), '다른 칸들은 "음성 모드 · 1번 칸이 받는 중" 띠')
ok(JSON.stringify(await hearing()) === '[true,false,false]', '받는 칸(1번)에 테두리')
ok(await pane(0).getByRole('button', { name: '전송' }).isVisible(), '받는 칸에 전송 버튼')
shots && (await app.screenshot({ path: `${shots}/voice-1.png` }))

console.log('\n== 여기로 받기')
await pane(1).getByRole('button', { name: '여기로 받기' }).click()
await pane(1).locator('.voice-mode').waitFor({ timeout: 5000 })
await pane(0).locator('.voice-elsewhere').waitFor({ timeout: 5000 })
ok(/2번 칸이 받는 중/.test(await pane(1).locator('.voice-pane').textContent()), '2번 칸이 음성 판을 받음')
ok(/2번 칸/.test(await pane(0).locator('.voice-elsewhere').textContent()), '1번 칸은 "2번 칸이 받는 중" 띠')
ok(JSON.stringify(await hearing()) === '[false,true,false]', '테두리가 2번 칸으로')
ok(await pane(1).getByRole('button', { name: '전송' }).isVisible(), '2번 칸에 전송 버튼')
shots && (await app.screenshot({ path: `${shots}/voice-2.png` }))

console.log('\n== 끄기')
await pane(2).getByRole('button', { name: '음성 모드 끄기' }).click()
for (const i of [0, 1, 2]) await pane(i).locator('.inputbox textarea').waitFor({ timeout: 5000 })
ok(true, '한 칸에서 끄면 세 칸 모두 입력창으로')
ok(JSON.stringify(await hearing()) === '[false,false,false]', '테두리 없음')

ok(!errors.length, `페이지 오류 없음${errors.length ? `: ${errors.join(' / ')}` : ''}`)
await browser.close()
