// End-to-end check of 작업 폴더 바꾸기 (REQ-F-785, AC-1386) against a running server and one agent on this machine
// (see README: 개발). A real `claude` session (a few tokens) is opened in WORK, moved to a folder that does not exist
// yet, and asked to carry on. Needs playwright (not a dependency of this repo):
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs AGENT_A=/tmp/agentA WORK=<folder> SHOTS=<folder> node test/e2e-cwd.mjs
import fs from 'node:fs'
import path from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT)
const SITE = process.env.SITE || 'http://localhost:4399'
const [home, work, shots] = [process.env.AGENT_A, process.env.WORK, process.env.SHOTS]
const MODEL = process.env.MODEL ?? 'claude-haiku-4-5-20251001'
const cfg = JSON.parse(fs.readFileSync(path.join(home, 'agent.json'), 'utf8'))
const step = (s) => console.log(`\n== ${s}`)
const ok = (cond, what) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`)
  if (!cond) process.exitCode = 1
}

const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } })
await ctx.request.get(`${SITE}/api/auth/dev?login=tester`)
const errors = []
const bridge = await ctx.newPage()
await bridge.goto(`${SITE}/bridge#port=${cfg.port}&key=${cfg.key}`)
await bridge.waitForFunction(() => document.getElementById('server-text')?.textContent === '연결됨', null, { timeout: 15000 })
const app = await ctx.newPage()
app.on('pageerror', (e) => errors.push(e.message))
const api = async (method, url, data) => {
  const r = await ctx.request.fetch(`${SITE}${url}`, { method, data, headers: { Origin: SITE } })
  return { status: r.status(), body: await r.json().catch(() => ({})) }
}

step('세션 띄우기')
const hostId = cfg.hostId
const made = await api('POST', '/api/sessions', { hostId, cwd: work, model: MODEL, prompt: 'Reply with exactly the word CWD_ONE and nothing else. Do not use any tools.' })
ok(made.status === 200, `세션 시작 ${made.status}`)
const sid = made.body.id
await app.goto(`${SITE}/s/${sid}`)
const answered = (re, timeout = 120000) => app.waitForFunction((src) => [...document.querySelectorAll('.msg-text')].some((m) => new RegExp(src).test(m.textContent)), re, { timeout })
await answered('CWD_ONE')
await app.waitForFunction(() => document.querySelector('.topbar-title')?.textContent?.includes('대기'), null, { timeout: 60000 })

step('잘못된 경로')
for (const cwd of ['b', '~/x/../y']) {
  const r = await api('POST', `/api/sessions/${sid}/cwd`, { cwd })
  ok(r.status === 400 && r.body.error === '작업 폴더는 / 또는 ~ 로 시작하는 경로여야 해요', `${cwd} → 400 ${r.body.error}`)
}

step('메뉴 → 작업 폴더 바꾸기')
const target = path.join(path.dirname(work), `${path.basename(work)}-moved-${Date.now().toString(36)}`)
await app.getByRole('button', { name: '세션 메뉴' }).click()
await app.getByRole('menuitem', { name: /작업 폴더 바꾸기/ }).click()
await app.waitForSelector('input[aria-label="작업 폴더"]')
await app.getByRole('button', { name: '새 기본 폴더' }).click()
await app.waitForFunction(() => /\/\d{4}-[0-9a-f]{6}$/.test(document.querySelector('input[aria-label="작업 폴더"]')?.value ?? ''), null, { timeout: 5000 })
ok(true, `새 기본 폴더: ${await app.inputValue('input[aria-label="작업 폴더"]')}`)
await app.fill('input[aria-label="작업 폴더"]', target)
await app.screenshot({ path: `${shots}/cwd-1-sheet.png` })
await app.getByRole('button', { name: '이 폴더로 바꾸기' }).click()
await app.getByRole('button', { name: '만들고 바꾸기' }).click({ timeout: 15000 })
await app.waitForFunction((t) => [...document.querySelectorAll('.msg-text, .notice, .tl-notice')].some((m) => m.textContent.includes('작업 폴더를') && m.textContent.includes(t)), path.basename(target), { timeout: 120000 })
ok(fs.existsSync(target), '새 폴더가 만들어짐')
// The session's row comes with the next state broadcast, a moment after the notice.
await app.waitForFunction((t) => document.querySelector('.topbar-path')?.getAttribute('title')?.split('\n')[0] === t, fs.realpathSync(target), { timeout: 15000 }).catch(() => {})
const shown = await app.locator('.topbar-path').getAttribute('title')
ok(shown?.split('\n')[0] === fs.realpathSync(target), `머리줄 경로가 새 폴더: ${shown?.split('\n')[0]}`)
await app.screenshot({ path: `${shots}/cwd-2-moved.png` })

step('같은 대화로 이어서')
await app.waitForFunction(() => document.querySelector('.topbar-title')?.textContent?.includes('대기'), null, { timeout: 90000 })
await app.fill('.inputbox textarea', 'Run pwd with the Bash tool, then reply on one line with exactly: PWD=<its output> PREV=<the word you replied with in your first answer>')
await app.click('.inputbox .send')
await answered(`PWD=.*${path.basename(target)}.*PREV=CWD_ONE`, 180000)
ok(true, '새 폴더에서 돌고, 앞 대화를 기억함')
await app.screenshot({ path: `${shots}/cwd-3-answer.png` })

await api('POST', `/api/sessions/${sid}/close`, {})
ok(!errors.length, `페이지 오류 없음 ${errors.join(' / ')}`)
await browser.close()
