// End-to-end check (AC-1393): on an iPad Enter sends and Shift+Enter starts a new line; on a phone Enter stays a new
// line. On the public demo, against a local server (no Mac or agent). Needs playwright (not a dependency):
//   BRIDGE_DEMO=1 BRIDGE_ORIGIN=http://localhost:4399 PORT=4399 BRIDGE_DATA=/tmp/cb-enter node server/server.mjs
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node test/e2e-ipad-enter.mjs
const { chromium } = await import(process.env.PLAYWRIGHT)
const SITE = process.env.SITE || 'http://localhost:4399'
const ok = (cond, what) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`)
  if (!cond) process.exitCode = 1
}
const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {})
const errors = []

// An iPad's Safari (and the iOS app) says "Macintosh" and has a touch screen of several points.
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'

async function open(ua, viewport) {
  const ctx = await browser.newContext({ viewport, hasTouch: true, isMobile: true, userAgent: ua })
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 }))
  const app = await ctx.newPage()
  app.on('pageerror', (e) => errors.push(e.message))
  await app.goto(SITE)
  await app.getByRole('button', { name: '데모로 둘러보기' }).click()
  await app.waitForFunction(() => document.querySelectorAll('[data-sid]').length >= 3, null, { timeout: 15000 })
  await app.getByRole('button', { name: '나중에' }).click({ timeout: 10000 })
  await app.locator('.srow', { hasText: '이 앱은 무엇을 하나요?' }).first().click()
  await app.locator('.inputbox textarea').waitFor({ timeout: 15000 })
  return { app, ctx }
}

console.log('\n== iPad')
{
  const { app, ctx } = await open(IPAD_UA, { width: 1180, height: 820 })
  const box = app.locator('.inputbox textarea')
  ok((await app.evaluate(() => matchMedia('(pointer: fine)').matches)) === false, '마우스 없는 화면(pointer: coarse)')
  ok((await box.getAttribute('enterkeyhint')) === 'send', '화면 키보드의 리턴 키가 보내기')
  await box.click()
  await app.keyboard.type('첫 줄')
  await app.keyboard.press('Shift+Enter')
  await app.keyboard.type('둘째 줄')
  ok((await box.inputValue()) === '첫 줄\n둘째 줄', 'Shift+Enter 는 줄바꿈')
  await app.keyboard.press('Enter')
  await app.locator('.msg-user', { hasText: '둘째 줄' }).first().waitFor({ timeout: 10000 })
  await app.waitForFunction(() => document.querySelector('.inputbox textarea').value === '', null, { timeout: 5000 }).catch(() => {})
  const left = await box.inputValue()
  ok(left === '', `Enter 로 보내고 입력칸이 빔${left ? ` (남은 글: ${JSON.stringify(left)})` : ''}`)
  await ctx.close()
}

console.log('\n== iPhone')
{
  const { app, ctx } = await open(IPHONE_UA, { width: 390, height: 844 })
  const box = app.locator('.inputbox textarea')
  ok((await box.getAttribute('enterkeyhint')) === 'enter', '화면 키보드의 리턴 키는 줄바꿈')
  await box.click()
  await app.keyboard.type('하나')
  await app.keyboard.press('Enter')
  await app.keyboard.type('둘')
  ok((await box.inputValue()) === '하나\n둘', '폰에서 Enter 는 줄바꿈(보내지 않음)')
  await ctx.close()
}

ok(!errors.length, `페이지 오류 없음${errors.length ? `: ${errors.join(' / ')}` : ''}`)
await browser.close()
