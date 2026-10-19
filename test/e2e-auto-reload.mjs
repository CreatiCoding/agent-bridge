// End-to-end (AC-1196, AC-1197): a page left open reloads itself into a newer build of the page, but not while
// something is being typed. Run from the repository root with a server
// (SITE, default :4699) serving this checkout's ui/dist. Puts a fake newer build in ui/dist and takes it out again.
//   PLAYWRIGHT=… node test/e2e-auto-reload.mjs
import fs from 'node:fs'
import path from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT)
const SITE = process.env.SITE || 'http://localhost:4699'
const DIST = path.join(process.cwd(), 'ui/dist')
const ok = (c, w) => (console.log(`${c ? 'PASS' : 'FAIL'} ${w}`), c || (process.exitCode = 1))

const index = path.join(DIST, 'index.html')
const before = fs.readFileSync(index, 'utf8')
const old = /\/assets\/(index-[\w-]+\.js)/.exec(before)[1]
const fresh = 'index-E2ERELOAD.js'
const browser = await chromium.launch()
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })
  await ctx.request.get(`${SITE}/api/auth/dev?login=tester`)
  const post = (url, data) => ctx.request.post(`${SITE}${url}`, { data, headers: { Origin: SITE } })
  const page = await ctx.newPage()
  await page.goto(`${SITE}/`)
  await page.waitForFunction(() => window.__build?.().mine, null, { timeout: 15000 })
  ok((await page.evaluate(() => window.__build().mine)) === old, `페이지가 자기 빌드를 앎: ${old}`)
  await page.evaluate(() => (window.__same = true))

  // Something is being typed when the newer build arrives.
  const field = page.locator('input:visible, textarea:visible').first()
  await field.click()
  await field.fill('지우면 안 되는 글')
  fs.copyFileSync(path.join(DIST, 'assets', old), path.join(DIST, 'assets', fresh))
  fs.writeFileSync(index, before.replace(old, fresh))
  await post('/api/groups', { op: 'create', name: `reload-${Date.now()}` })
  await page.waitForFunction((f) => window.__build?.().wanted === f, fresh, { timeout: 15000 }).then(
    () => ok(true, '서버가 새 빌드를 알림'),
    () => ok(false, '서버가 새 빌드를 알림'),
  )
  await page.waitForTimeout(4000)
  ok(await page.evaluate(() => window.__same === true).catch(() => false), '입력 중에는 새로고침하지 않음')

  // Typing stops (focus leaves, no touch for 3 s): it reloads into the new build.
  await page.evaluate(() => document.activeElement?.blur())
  await page.waitForFunction(() => !window.__same, null, { timeout: 15000 }).catch(() => {})
  await page.waitForLoadState()
  await page.waitForFunction(() => window.__build?.().mine, null, { timeout: 15000 })
  ok((await page.evaluate(() => window.__build().mine)) === fresh, `입력이 끝나면 새 빌드로 새로고침: ${await page.evaluate(() => window.__build().mine)}`)

  // And back again: each newer build is followed.
  fs.writeFileSync(index, before)
  await post('/api/groups', { op: 'create', name: `reload-${Date.now()}` })
  await page.waitForFunction((o) => window.__build?.().mine === o, old, { timeout: 20000 }).then(
    () => ok(true, '다시 바뀐 빌드에도 따라감'),
    () => ok(false, '다시 바뀐 빌드에도 따라감'),
  )
} finally {
  fs.writeFileSync(index, before)
  fs.rmSync(path.join(DIST, 'assets', fresh), { force: true })
  await browser.close()
}
