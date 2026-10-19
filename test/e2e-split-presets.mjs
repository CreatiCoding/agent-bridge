// End-to-end check of 분할 조합 (REQ-F-790) on the public demo at an iPad lying down, against a local server (no
// Mac or agent is needed). Needs playwright (not a dependency):
//   BRIDGE_DEMO=1 BRIDGE_ORIGIN=http://localhost:4399 PORT=4399 BRIDGE_DATA=/tmp/cb-split node server/server.mjs
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs SHOTS=<folder> node test/e2e-split-presets.mjs
const { chromium } = await import(process.env.PLAYWRIGHT)
const SITE = process.env.SITE || 'http://localhost:4399'
const shots = process.env.SHOTS
const step = (s) => console.log(`\n== ${s}`)
const ok = (cond, what) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`)
  if (!cond) process.exitCode = 1
}

const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {})
const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
const app = await ctx.newPage()
const errors = []
app.on('pageerror', (e) => errors.push(e.message))
const shot = (name) => shots && app.screenshot({ path: `${shots}/${name}.png` })
const ids = () => new URL(app.url()).searchParams.get('s')?.split(',') ?? []
const title = () => app.locator('.split-title').textContent()
const menu = async (...items) => {
  for (const item of items) await app.getByRole('menuitem', { name: new RegExp(item) }).first().click()
}
const answer = async (name, ok = '저장') => {
  const box = app.locator('.sheet input.input')
  await box.waitFor({ timeout: 5000 })
  await box.fill(name)
  await app.getByRole('button', { name: ok, exact: true }).click()
}
const saved = () => app.evaluate(() => fetch('/api/prefs/splits').then((r) => r.json()).then((r) => r.splits))
const openSplit = async (list) => {
  await app.goto(`${SITE}/split?s=${list.join(',')}`)
  await app.locator('iframe.split-pane').nth(list.length - 1).waitFor({ timeout: 15000 })
}

step('데모로 들어가기')
await app.goto(SITE)
await app.getByRole('button', { name: '데모로 둘러보기' }).click()
await app.waitForFunction(() => document.querySelectorAll('[data-sid]').length >= 3, null, { timeout: 15000 })
await app.getByRole('button', { name: '나중에' }).click({ timeout: 10000 })
const all = await app.$$eval('.side [data-sid]', (els) => [...new Set(els.map((e) => e.dataset.sid))])
const [a, b, c] = all
ok(all.length >= 3, `세션 ${all.length}개`)
ok((await app.locator('.split-presets-list').count()) === 0, '저장한 조합이 없으면 목록에 분할 조합 칸이 없음')

step('지금 조합 저장')
await openSplit([a, b])
ok((await title()) === '분할 화면', '저장 전 제목은 분할 화면')
await app.getByRole('button', { name: '조합' }).click()
await menu('지금 조합 저장')
await answer('작업 A')
await app.waitForFunction(() => document.querySelector('.split-title')?.textContent === '작업 A', null, { timeout: 5000 })
ok(true, '저장하면 제목이 조합 이름')
let list = await saved()
ok(list.length === 1 && list[0].name === '작업 A' && list[0].ids.join() === [a, b].join(), `서버에 저장 (${JSON.stringify(list.map((x) => x.name))})`)
await shot('presets-0-saved')

step('다른 조합 저장 후 분할 화면 안에서 바꿔 열기')
await openSplit([b, c, a])
await app.getByRole('button', { name: '조합' }).click()
await menu('지금 조합 저장')
await answer('작업 B')
await app.waitForFunction(() => document.querySelector('.split-title')?.textContent === '작업 B', null, { timeout: 5000 })
await app.getByRole('button', { name: '조합' }).click()
ok((await app.getByRole('menuitem', { name: /작업 B.*저장됨/ }).count()) === 1, '메뉴 맨 위는 지금 조합(저장됨)')
await menu('^작업 A')
await app.waitForFunction(() => document.querySelectorAll('iframe.split-pane').length === 2, null, { timeout: 5000 })
ok(ids().join() === [a, b].join(), `칸이 작업 A 로 바뀜 (${ids().length}칸)`)
ok((await title()) === '작업 A', '제목도 작업 A')
await shot('presets-1-swapped')

step('세션 목록 맨 위에서 열기')
await app.goto(SITE)
await app.locator('.split-presets-list').waitFor({ timeout: 10000 })
ok((await app.locator('.split-presets-list .split-preset').count()) === 2, '목록에 분할 조합 2개')
await shot('presets-2-list')
// The demo's permission request comes up again on the list.
await app.getByRole('button', { name: '나중에' }).click({ timeout: 5000 }).catch(() => {})

step('순서 바꾸기')
const order = () => app.locator('.split-preset .row-title').allTextContents()
ok((await order()).join() === '작업 A,작업 B', '저장한 순서대로')
await app.getByRole('button', { name: '분할 조합 관리' }).click()
await menu('^작업 B')
ok(await app.getByRole('menuitem', { name: /아래로 옮기기/ }).isDisabled(), '맨 아래 조합은 아래로 옮기기가 꺼짐')
await menu('위로 옮기기')
await app.waitForFunction(() => [...document.querySelectorAll('.split-preset .row-title')].map((e) => e.textContent).join() === '작업 B,작업 A', null, { timeout: 5000 })
ok(true, '위로 옮기면 작업 B 가 먼저')
ok((await saved()).map((x) => x.name).join() === '작업 B,작업 A', '서버에도 그 순서')
await app.getByRole('button', { name: '분할 조합 관리' }).click()
await menu('^작업 B')
ok(await app.getByRole('menuitem', { name: /위로 옮기기/ }).isDisabled(), '맨 위 조합은 위로 옮기기가 꺼짐')
await app.keyboard.press('Escape')
await app.locator('.menu-pop').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
await app.locator('.split-preset', { hasText: '작업 B' }).click()
await app.waitForURL(/\/split\?s=/, { timeout: 10000 })
ok(ids().join() === [b, c, a].join(), '작업 B 로 3칸이 열림')

step('이름 바꾸기 · 지우기')
await app.getByRole('button', { name: '조합' }).click()
await menu('작업 B.*저장됨', '이름 바꾸기')
await answer('작업 C', '바꾸기')
await app.waitForFunction(() => document.querySelector('.split-title')?.textContent === '작업 C', null, { timeout: 5000 })
ok(true, '이름을 바꾸면 제목도 바뀜')
await app.getByRole('button', { name: '조합' }).click()
await menu('작업 C.*저장됨', '지우기')
await app.getByRole('button', { name: '지우기', exact: true }).click()
await app.waitForFunction(() => document.querySelector('.split-title')?.textContent === '분할 화면', null, { timeout: 5000 })
list = await saved()
ok(list.length === 1 && list[0].name === '작업 A', '지우면 하나만 남고 제목은 분할 화면')

step('서버가 잘못된 조합을 거절')
const bad = await app.evaluate(async (one) => {
  const r = await fetch('/api/prefs/splits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'save', name: 'x', ids: [one] }) })
  return r.status
}, a)
ok(bad === 400, `세션 하나뿐인 조합은 400 (${bad})`)
const lost = await app.evaluate(async () => {
  const r = await fetch('/api/prefs/splits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'move', id: 'nope', by: 1 }) })
  return r.status
})
ok(lost === 404, `없는 조합 옮기기는 404 (${lost})`)

ok(!errors.length, `페이지 오류 없음${errors.length ? `: ${errors.join(' | ')}` : ''}`)
await browser.close()
