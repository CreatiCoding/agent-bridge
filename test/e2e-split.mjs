// End-to-end check of 분할 화면 (REQ-F-786) on the public demo, at an iPad's sizes, against a local server (the demo
// is on with BRIDGE_DEMO=1; no Mac or agent is needed). Needs playwright (not a dependency):
//   BRIDGE_DEMO=1 BRIDGE_ORIGIN=http://localhost:4399 PORT=4399 BRIDGE_DATA=/tmp/cb-split node server/server.mjs
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs SHOTS=<folder> node test/e2e-split.mjs
const { chromium } = await import(process.env.PLAYWRIGHT)
const SITE = process.env.SITE || 'http://localhost:4399'
const shots = process.env.SHOTS
const step = (s) => console.log(`\n== ${s}`)
const ok = (cond, what) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`)
  if (!cond) process.exitCode = 1
}

const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {})
// An iPad Pro 11" lying down: a touch screen, 1180 × 820.
const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
const app = await ctx.newPage()
const errors = []
app.on('pageerror', (e) => errors.push(e.message))
const shot = (name) => shots && app.screenshot({ path: `${shots}/${name}.png` })
const frames = () => app.locator('iframe.split-pane')
const pane = (i) => app.frameLocator('iframe.split-pane').nth(i)
const ids = () => new URL(app.url()).searchParams.get('s')?.split(',') ?? []
const paneMenu = async (i, item) => {
  await pane(i).getByRole('button', { name: '세션 메뉴' }).click()
  await pane(i).getByRole('menuitem', { name: new RegExp(item) }).click()
}
const pick = async (title) => {
  await app.waitForSelector('.split-picker', { timeout: 10000 })
  await app.locator('.split-picker .split-pick', { hasText: title }).first().click()
}

step('데모로 들어가 세션 열기')
await app.goto(SITE)
await app.getByRole('button', { name: '데모로 둘러보기' }).click()
await app.waitForFunction(() => document.querySelectorAll('[data-sid]').length >= 3, null, { timeout: 15000 })
await app.getByRole('button', { name: '나중에' }).click({ timeout: 10000 })
const titles = await app.$$eval('.side .srow .srow-title, .side .srow b', (els) => [...new Set(els.map((e) => e.textContent.trim()).filter(Boolean))])
console.log('세션:', titles.join(' / '))
await app.locator('.side .srow', { hasText: '이 앱은 무엇을 하나요?' }).first().click()
await app.waitForURL(/\/s\/[\w-]+$/, { timeout: 15000 })
const first = app.url().split('/s/')[1]

step('⋯ → 분할로 띄우기 → 세션 고르기')
await app.getByRole('button', { name: '세션 메뉴' }).click()
await app.getByRole('menuitem', { name: /분할로 띄우기/ }).click()
await app.waitForSelector('.split-picker', { timeout: 10000 })
const offered = await app.locator('.split-picker .split-pick').count()
ok(offered >= 2, `고르기 창에 다른 세션 ${offered}개`)
ok(!(await app.locator('.split-picker .split-pick', { hasText: '이 앱은 무엇을 하나요?' }).count()), '고르기 창에 지금 세션은 없음')
await shot('split-0-picker')
await app.locator('.split-picker .split-pick').first().click()
await app.waitForURL(/\/split\?s=/, { timeout: 10000 })
ok(ids().length === 2 && ids()[0] === first, `주소가 /split?s=<지금>,<고른 것> (${ids().join(',')})`)
ok((await frames().count()) === 2, '칸 2개')
await pane(1).locator('.inputbox textarea').waitFor({ timeout: 15000 })
ok(true, '두 칸 모두 세션 화면')
ok((await app.locator('.demo-banner').count()) === 1, '데모 띠는 바깥에만 한 번')
ok((await pane(0).locator('.demo-banner').count()) === 0 && (await pane(0).locator('.app-rail').count()) === 0, '칸 안은 폰 화면(데모 띠·앱 레일 없음)')

step('칸의 ⋯ → 옆에 세션 추가 (3칸)')
await paneMenu(0, '옆에 세션 추가')
await pick('')
await app.waitForFunction(() => document.querySelectorAll('iframe.split-pane').length === 3, null, { timeout: 10000 })
ok(ids().length === 3 && new Set(ids()).size === 3, `세 칸, 서로 다른 세션 (${ids().join(',')})`)
const widths = await frames().evaluateAll((fs) => fs.map((f) => Math.round(f.getBoundingClientRect().width)))
ok(widths.every((w) => w >= 340 && w <= 400), `가로 1180 에서 칸 폭 ${widths.join(', ')} px (폰 폭)`)
ok(await app.getByRole('button', { name: '세션 추가' }).isDisabled(), '3칸이면 세션 추가가 꺼짐')
await pane(2).locator('.inputbox textarea').waitFor({ timeout: 15000 })
await pane(0).getByRole('button', { name: '세션 메뉴' }).click()
ok(await pane(0).getByRole('menuitem', { name: /옆에 세션 추가/ }).isDisabled(), '칸 메뉴의 옆에 세션 추가도 꺼짐')
await app.keyboard.press('Escape')
await pane(0).locator('.menu-pop, .sheet').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
ok((await app.locator('.scrim').count()) === 0, '세 칸이 다 보이면 바깥에 권한 창이 뜨지 않음')
await shot('split-1-three')

step('칸마다 따로 보내기')
const target = pane(0)
await target.locator('.inputbox textarea').fill('안녕하세요')
await target.locator('.inputbox .send').click()
await target.locator('.msg-text', { hasText: '데모 모드예요' }).first().waitFor({ timeout: 15000 })
ok(true, '왼쪽 칸에 데모 답이 옴')
ok(!(await pane(2).locator('.msg-user', { hasText: '안녕하세요' }).count()), '오른쪽 칸에는 보낸 글이 없음')

step('분할에서 빼기 · 다시 열기')
const third = ids()[2]
await paneMenu(2, '분할에서 빼기')
await app.waitForFunction(() => document.querySelectorAll('iframe.split-pane').length === 2, null, { timeout: 10000 })
ok(ids().length === 2 && !ids().includes(third), '칸이 빠지고 주소도 두 개')
await app.reload()
await app.waitForFunction(() => document.querySelectorAll('iframe.split-pane').length === 2, null, { timeout: 15000 })
ok(true, '새로고침해도 같은 두 칸')

step('칸 안에서 다른 세션으로 옮기기')
await pane(1).getByRole('button', { name: '뒤로' }).click()
await pane(1).locator('.srow').first().waitFor({ timeout: 10000 })
const other = pane(1).locator('.srow', { hasText: '이 앱은 무엇을 하나요?' }).first()
await other.click()
await app.waitForFunction((a) => new URLSearchParams(location.search).get('s')?.split(',')[1] === a, first, { timeout: 10000 }).catch(() => {})
ok(ids()[1] === first, `칸이 고른 세션으로 바뀌고 주소도 따라감 (${ids().join(',')})`)

step('아이패드 세로')
await app.setViewportSize({ width: 820, height: 1180 })
await app.waitForTimeout(300)
const tall = await frames().evaluateAll((fs) => fs.map((f) => Math.round(f.getBoundingClientRect().width)))
ok(tall.length === 2 && tall.every((w) => w >= 340), `세로 820 에서 두 칸 ${tall.join(', ')} px`)
await shot('split-2-portrait')
// The waiting session (README) left the panes when the second pane moved: the page around them asks it now.
ok(await app.getByRole('button', { name: '나중에' }).isVisible(), '칸에서 빠진 세션의 권한 요청은 바깥 화면이 물음')
await app.getByRole('button', { name: '나중에' }).click()

step('이 세션만 크게')
const big = ids()[0]
await paneMenu(0, '이 세션만 크게')
await app.waitForURL(new RegExp(`/s/${big}$`), { timeout: 10000 })
ok(true, '첫 칸의 세션 화면으로')

step('폰에는 분할로 띄우기가 없음')
await app.setViewportSize({ width: 390, height: 844 })
await app.waitForTimeout(300)
await app.getByRole('button', { name: '세션 메뉴' }).click()
await app.getByRole('menuitem', { name: /터미널 화면/ }).waitFor({ timeout: 5000 })
ok(!(await app.getByRole('menuitem', { name: /분할로 띄우기/ }).count()), '폭 390 의 세션 메뉴에 분할로 띄우기 없음')

ok(!errors.length, `페이지 오류 없음${errors.length ? `: ${errors.join(' / ')}` : ''}`)
await browser.close()
