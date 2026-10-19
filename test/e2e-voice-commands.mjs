// End-to-end check of 음성 명령 (REQ-F-789) in 분할 화면 on the public demo: the Mac's transcription is answered here
// with set words, and each phrase is handed to the panel as the microphone would after a pause. Chrome's fake
// microphone. Against a local server (no Mac or agent). Needs playwright (not a dependency):
//   BRIDGE_DEMO=1 BRIDGE_ORIGIN=http://localhost:4399 PORT=4399 BRIDGE_DATA=/tmp/cb-vc node server/server.mjs
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node test/e2e-voice-commands.mjs
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
// What "the Mac" writes for each phrase, in turn.
const words = []
await ctx.route('**/api/sessions/*/voice', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, raw: words[0], text: words.shift() ?? '', sec: 1 }) }))
const app = await ctx.newPage()
const errors = []
app.on('pageerror', (e) => errors.push(e.message))
const pane = (i) => app.frameLocator('iframe.split-pane').nth(i)
const hearing = () => app.locator('iframe.split-pane').evaluateAll((fs) => fs.findIndex((f) => f.classList.contains('hearing')) + 1)
// One phrase, as the microphone hands it to the panel hearing it after a pause.
const say = async (text) => {
  words.push(text)
  await app.evaluate(() => window.cbSplit.voice().listen.taker({ audio: 'AAAA' }))
  await app.waitForTimeout(700)
}
const voiceText = (i) => pane(i).locator('.voice-text').textContent()

await app.goto(SITE)
await app.getByRole('button', { name: '데모로 둘러보기' }).click()
await app.waitForFunction(() => document.querySelectorAll('[data-sid]').length >= 3, null, { timeout: 15000 })
await app.getByRole('button', { name: '나중에' }).click({ timeout: 10000 })
const ids = await app.$$eval('[data-sid]', (els) => [...new Set(els.map((e) => e.dataset.sid))])
await app.goto(`${SITE}/split?s=${ids.slice(0, 3).join(',')}`)
await app.waitForFunction(() => [...document.querySelectorAll('iframe.split-pane')].filter((f) => f.contentDocument?.querySelector('.inputbox')).length === 3, null, { timeout: 20000 })
await app.getByRole('button', { name: '나중에' }).click({ timeout: 3000 }).catch(() => {})
await pane(0).locator('.mic-btn').first().click()
await pane(0).locator('.voice-mode').waitFor({ timeout: 15000 })

console.log('\n== 맨 앞의 칸 이름')
await say('두 번째 세션, 할 일 정리해 줘')
await pane(1).locator('.voice-mode').waitFor({ timeout: 5000 })
ok((await hearing()) === 2, '"두 번째 세션" 으로 받는 칸이 2번')
ok((await voiceText(1)).includes('할 일 정리해 줘') && !(await voiceText(1)).includes('세션'), '2번 칸에 칸 이름을 뺀 말이 쌓임')
ok(/2번 칸/.test(await pane(0).locator('.voice-elsewhere').textContent()), '1번 칸은 "2번 칸이 받는 중" 띠')

console.log('\n== 맨 끝의 리셋')
await say('아니 다 틀렸어 리셋')
ok(!(await voiceText(1)).includes('할 일') && !(await voiceText(1)).includes('틀렸어'), '"리셋" 으로 모은 말이 지워짐')

console.log('\n== 맨 끝의 전송')
await say('안녕하세요')
ok((await voiceText(1)).includes('안녕하세요'), '명령이 없으면 그냥 쌓임')
await say('반가워요 전송')
await pane(1).locator('.msg-user', { hasText: '안녕하세요 반가워요' }).first().waitFor({ timeout: 10000 })
ok(true, '"전송" 으로 모은 말이 2번 칸 세션에 감("전송" 은 빠짐)')
ok(!(await pane(1).locator('.msg-user', { hasText: '전송' }).count()), '보낸 글에 "전송" 이 없음')

console.log('\n== 칸 이름 + 전송')
await say('세 번째 세션 좋아요 전송')
await pane(2).locator('.msg-user', { hasText: '좋아요' }).first().waitFor({ timeout: 10000 })
ok((await hearing()) === 3, '3번 칸이 받고')
ok(true, '3번 칸 세션에 "좋아요" 가 바로 감')

console.log('\n== 중간의 명령 말은 글')
await say('전송 버튼은 그대로 둬')
ok((await voiceText(2)).includes('전송 버튼은 그대로 둬'), '맨 끝이 아닌 "전송" 은 글로 쌓임')
shots && (await app.screenshot({ path: `${shots}/voice-commands.png` }))

console.log('\n== 끈 뒤')
await pane(0).getByRole('button', { name: '음성 모드 끄기' }).click()
await pane(0).locator('.inputbox textarea').waitFor({ timeout: 5000 })
ok(!(await pane(0).locator('.inputbox textarea').inputValue()).includes('할 일'), '1번 칸 입력창에는 2번 칸으로 간 말이 남지 않음')

ok(!errors.length, `페이지 오류 없음${errors.length ? `: ${errors.join(' / ')}` : ''}`)
await browser.close()
