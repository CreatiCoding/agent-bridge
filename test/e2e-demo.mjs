// End-to-end check of 공개 데모 (REQ-F-766, REQ-S-068) in a browser, against a local server (the demo is on with
// BRIDGE_DEMO=1). No Mac or agent is needed: the server plays the demo Mac itself. Needs playwright (not a dependency):
//   BRIDGE_DEMO=1 BRIDGE_ORIGIN=http://localhost:4399 PORT=4399 BRIDGE_DATA=/tmp/cb-demo node server/server.mjs
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs SHOTS=<folder> node test/e2e-demo.mjs
const { chromium } = await import(process.env.PLAYWRIGHT)
const SITE = process.env.SITE || 'http://localhost:4399'
const shots = process.env.SHOTS
const step = (s) => console.log(`\n== ${s}`)
const ok = (cond, what) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`)
  if (!cond) process.exitCode = 1
}

const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {})
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
const app = await ctx.newPage()
const errors = []
app.on('pageerror', (e) => errors.push(e.message))
const shot = (name) => shots && app.screenshot({ path: `${shots}/${name}.png` })

step('데모로 둘러보기')
await app.goto(SITE)
ok(await app.getByRole('button', { name: '데모로 둘러보기' }).isVisible(), '데모로 둘러보기 버튼이 처음부터 보임')
ok((await app.locator('input[type=password]').count()) === 0, '아이디·비밀번호 칸 없음')
await shot('demo-0-login')
await app.getByRole('button', { name: '데모로 둘러보기' }).click()
await app.waitForSelector('.demo-banner', { timeout: 15000 })
ok((await app.textContent('.demo-banner'))?.includes('실제 맥에 연결되지 않아요'), '위쪽에 데모 모드 띠')
ok((await app.getAttribute('.demo-banner a', 'href')) === '/api/auth/github', '띠에 GitHub 로그인 길')
await app.waitForFunction(() => document.querySelectorAll('[data-sid]').length >= 3, null, { timeout: 15000 })
ok(true, '세션 목록에 데모 세션 3개')
ok(/데모 프로젝트/.test(await app.textContent('.side')), '그룹이 보임')
await shot('demo-1-list')
// The seed's waiting permission comes up as the app's own permission window, as a real one would.
await app.getByRole('button', { name: '나중에' }).click({ timeout: 10000 })
ok(true, '권한 대기 세션이 권한 창으로 뜸')

step('세션 열고 보내기')
await app.locator('.side .srow', { hasText: '이 앱은 무엇을 하나요?' }).first().click()
await app.waitForURL(/\/s\/[\w-]+$/, { timeout: 15000 })
await app.waitForFunction(() => [...document.querySelectorAll('.msg-text')].some((m) => /데모 모드/.test(m.textContent)), null, { timeout: 15000 })
ok(true, '대화 기록이 보임')
await app.fill('.inputbox textarea', '안녕하세요')
await app.click('.inputbox .send')
await app.waitForFunction(() => [...document.querySelectorAll('.msg-text')].some((m) => /안녕하세요! 데모 모드예요/.test(m.textContent)), null, { timeout: 15000 })
ok(true, '1~2초 뒤 정해진 답이 옴')
await shot('demo-2-answer')

step('권한 카드')
await app.fill('.inputbox textarea', '권한 요청 보여 줘')
await app.click('.inputbox .send')
await app.waitForSelector('.dcard.open', { timeout: 15000 })
await shot('demo-3-card')
await app.locator('.dcard.open .opt.primary').click()
await app.waitForFunction(() => [...document.querySelectorAll('.msg-text')].some((m) => /아무것도 실행되지 않았어요/.test(m.textContent)), null, { timeout: 15000 })
ok(true, '카드 버튼으로 허용하면 답이 이어짐')

step('음성 · 설정')
ok((await app.locator('.mic-btn').count()) === 1, '입력창에 음성 모드 버튼이 있음')
// The voice mode's recording is not driven here: automated Chrome on macOS waits on getUserMedia. What the demo Mac
// answers to a recording is in test/unit/demo.test.mjs.
await app.goto(`${SITE}/settings/voice`)
await app.waitForFunction(() => /데모 맥/.test(document.body.textContent), null, { timeout: 15000 })
ok(true, '설정 → 음성에 데모 맥이 보임')
await shot('demo-5-settings-voice')

step('막힌 API')
const post = (p, data) => app.request.post(`${SITE}${p}`, { headers: { 'content-type': 'application/json', origin: SITE }, data })
for (const [p, data] of [['/api/bridge/hello', { hostId: 'some-real-host-1', name: 'x' }], ['/api/qr', {}], ['/api/reports', { text: 'x' }]]) ok((await post(p, data)).status() === 403, `${p} 는 403`)
ok((await app.request.get(`${SITE}/api/admin/overview`)).status() === 403, '/api/admin/overview 는 403')

ok(!errors.length, `페이지 오류 없음${errors.length ? `: ${errors.join(' / ')}` : ''}`)
await browser.close()
