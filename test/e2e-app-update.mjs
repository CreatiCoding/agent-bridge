// 앱 업데이트 안내 (REQ-F-781) in a phone-sized page: an older app build is asked to update, "나중에" puts it off,
// a browser is never asked. Starts its own server (with ui/dist built) and needs playwright:
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs SHOTS=<folder> node test/e2e-app-update.mjs
import path from 'node:path'
import { startServer } from './unit/server-harness.mjs'

const { chromium } = await import(process.env.PLAYWRIGHT)
const shots = process.env.SHOTS
const ok = (cond, what) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`)
  if (!cond) process.exitCode = 1
}
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const s = await startServer({ seed: { 'app-build.json': { build: 412, at: Date.now() - 3600_000 } } })
const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {})
try {
  const open = async (ua) => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: ua })
    await c.request.get(`${s.origin}/api/auth/dev?login=tester`)
    const page = await c.newPage()
    await page.goto(s.origin)
    return page
  }
  const app = await open(`${IPHONE} AgentBridge/1.0 (400)`)
  const title = app.getByText('새 버전이 있어요')
  await title.waitFor({ timeout: 10_000 }).catch(() => {})
  ok(await title.isVisible(), '옛 빌드 앱: "새 버전이 있어요"')
  ok(await app.getByText('지금 앱은 빌드 400, 새 빌드는 412 이에요.').isVisible(), '본문에 두 빌드')
  await app.waitForTimeout(800)
  if (shots) await app.screenshot({ path: path.join(shots, 'app-update-390.png') })
  await app.getByRole('button', { name: '나중에' }).click()
  await app.reload()
  await app.waitForTimeout(2500)
  ok(!(await app.getByText('새 버전이 있어요').isVisible()), '"나중에" 뒤 다시 열어도 묻지 않음')
  const web = await open(IPHONE)
  await web.waitForTimeout(2500)
  ok(!(await web.getByText('새 버전이 있어요').isVisible()), '브라우저(앱 아님)는 묻지 않음')
  const fresh = await open(`${IPHONE} AgentBridge/1.0 (412)`)
  await fresh.waitForTimeout(2500)
  ok(!(await fresh.getByText('새 버전이 있어요').isVisible()), '최신 빌드 앱은 묻지 않음')
} finally {
  await browser.close()
  await s.stop()
}
