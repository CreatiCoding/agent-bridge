// End-to-end check of 전부 허용 that asks nothing (REQ-F-796) on the public demo, against a local server (no Mac or
// agent is needed). Needs playwright (not a dependency):
//   cd server && go build -o /tmp/bridge-server . && BRIDGE_DEMO=1 BRIDGE_ORIGIN=http://localhost:4399 PORT=4399 BRIDGE_DATA=/tmp/cb-allow /tmp/bridge-server
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs SHOTS=<folder> node test/e2e-allow-all.mjs
const { chromium } = await import(process.env.PLAYWRIGHT)
const SITE = process.env.SITE || 'http://localhost:4399'
const shots = process.env.SHOTS
const step = (s) => console.log(`\n== ${s}`)
const ok = (cond, what) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`)
  if (!cond) process.exitCode = 1
}

const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } })
const app = await ctx.newPage()
const errors = []
app.on('pageerror', (e) => errors.push(e.message))
const shot = (name) => shots && app.screenshot({ path: `${shots}/${name}.png` })
const later = () => app.getByRole('button', { name: '나중에' }).click({ timeout: 3000 }).catch(() => {})

step('데모로 들어가기')
await app.goto(SITE)
await app.getByRole('button', { name: '데모로 둘러보기' }).click()
await app.waitForFunction(() => document.querySelectorAll('[data-sid]').length >= 1, null, { timeout: 15000 })
await later()
const sid = await app.$eval('.side [data-sid]', (el) => el.dataset.sid)
const dot = () => app.locator(`.side [data-sid="${sid}"] .srow-dot`).first()

step('권한 모드에 두 가지 전부 허용')
const opts = await app.evaluate(() => fetch('/api/options').then((r) => r.json()))
const modes = opts.modes.map((m) => m.value)
ok(modes.includes('autoAllow') && modes.includes('allowAll'), `모드 ${modes.join(',')}`)
ok(/^안전한 전부 허용/.test(opts.modes.find((m) => m.value === 'autoAllow').label), '기존 전부 허용은 안전한 전부 허용')
ok(/전부 허용/.test(opts.modes.find((m) => m.value === 'allowAll').label), '새 모드는 전부 허용')

step('세션 설정에서 전부 허용으로')
await app.goto(`${SITE}/s/${sid}`)
await later()
await app.locator('.chip', { hasText: /모델|Opus|Sonnet|Fable|Haiku/ }).first().click()
const select = app.locator('.sheet select.input').nth(1)
await select.waitFor({ timeout: 5000 })
await select.selectOption('allowAll')
await app.getByRole('button', { name: '바꾸기', exact: true }).click({ timeout: 5000 })
await app.waitForFunction(() => [...document.querySelectorAll('.chip')].some((c) => c.textContent.includes('전부 허용 중')), null, { timeout: 8000 })
const chip = app.locator('.chip', { hasText: '전부 허용 중' })
ok(await chip.evaluate((c) => c.classList.contains('chip-bad')), '칩이 빨간색(chip-bad)')
ok((await select.getAttribute('class')).includes('input-allow-all'), '선택칸도 빨간색')
await app.keyboard.press('Escape')
await app.waitForTimeout(300)
ok(await dot().evaluate((d) => d.classList.contains('srow-dot-allow-all')), '목록의 점에 빨간 표시')
await shot('allow-all-on')

step('안전한 전부 허용으로')
await app.evaluate((id) => fetch(`/api/sessions/${id}/do`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'mode', arg: 'autoAllow' }) }), sid)
await app.waitForFunction(() => [...document.querySelectorAll('.chip')].some((c) => c.textContent.includes('안전한 전부 허용')), null, { timeout: 8000 })
ok(await app.locator('.chip', { hasText: '안전한 전부 허용' }).evaluate((c) => c.classList.contains('chip-warn')), '칩이 주황색(chip-warn)')
ok(!(await dot().evaluate((d) => d.classList.contains('srow-dot-allow-all'))), '점의 빨간 표시가 사라짐')

step('칩을 눌러 끄기')
await app.locator('.chip', { hasText: '안전한 전부 허용' }).click()
await app.waitForFunction(() => ![...document.querySelectorAll('.chip')].some((c) => /전부 허용/.test(c.textContent)), null, { timeout: 8000 })
ok(true, '전부 허용 칩이 사라짐')

ok(errors.length === 0, `페이지 오류 없음 ${errors.join(' | ')}`)
await browser.close()
