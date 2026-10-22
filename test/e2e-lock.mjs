// End-to-end check of session locks, the conversation cache and the phone gestures on the control page.
// Needs a running server, one agent (see README: 개발) and playwright (not a dependency of this repo):
//   PLAYWRIGHT=… AGENT_A=/tmp/agentA WORK=<folder> SHOTS=<folder> node test/e2e-lock.mjs
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
const newCtx = async (opts) => {
  const c = await browser.newContext(opts)
  await c.request.get(`${SITE}/api/auth/dev?login=tester`)
  return c
}
const mac = await newCtx({ viewport: { width: 1280, height: 820 } })
const phoneCtx = await newCtx({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
const otherCtx = await newCtx({ viewport: { width: 1280, height: 820 } })
const errors = []
const watch = (p, name) => (p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`)), p)
const bridge = await mac.newPage()
await bridge.goto(`${SITE}/bridge#port=${cfg.port}&key=${cfg.key}`)
await bridge.waitForFunction(() => document.getElementById('server-text')?.textContent === '연결됨', null, { timeout: 30000 })

const app = watch(await phoneCtx.newPage(), 'phone')
const answered = (page, re, timeout = 120000) => page.waitForFunction((src) => [...document.querySelectorAll('.msg-text')].some((m) => new RegExp(src).test(m.textContent)), re, { timeout })

step('세션 하나')
const r = await app.request.post(`${SITE}/api/sessions`, { headers: { 'content-type': 'application/json', origin: SITE }, data: { hostId: cfg.hostId, cwd: work, prompt: 'Reply with exactly the word LOCK_ONE and nothing else.', model: MODEL } })
const sid = (await r.json()).id
await app.goto(`${SITE}/s/${sid}`)
await answered(app, 'LOCK_ONE')
ok(true, '답이 옴')

step('대화 캐시')
await app.waitForTimeout(2500)
const cached = await app.evaluate((id) => new Promise((res) => {
  const req = indexedDB.open('cb2-cache')
  req.onsuccess = () => {
    const g = req.result.transaction('logs').objectStore('logs').get(id)
    g.onsuccess = () => res(g.result?.events?.length ?? 0)
    g.onerror = () => res(-1)
  }
  req.onerror = () => res(-1)
}), sid)
ok(cached > 0, `대화가 이 브라우저에 저장됨 (${cached}개 이벤트)`)
await app.reload()
await answered(app, 'LOCK_ONE', 3000)
ok(true, '다시 열면 바로 그려짐')

step('잠그기')
await app.getByRole('button', { name: '세션 메뉴' }).click()
await app.getByRole('menuitem', { name: /잠그기/ }).click()
await app.fill('.sheet input.input', 'pass1234')
await app.getByRole('button', { name: '다음' }).click()
await app.fill('.sheet input.input', 'pass1234')
await app.getByRole('button', { name: '잠그기', exact: true }).click()
await app.waitForTimeout(1500)
ok(await app.locator('.msg-text', { hasText: 'LOCK_ONE' }).count() > 0, '잠근 탭에서는 그대로 보임')
const other = watch(await otherCtx.newPage(), 'other')
await other.goto(`${SITE}/s/${sid}`)
await other.waitForSelector('.lock-screen', { timeout: 15000 })
ok((await other.locator('.msg-text').count()) === 0, '다른 기기에서는 비밀번호를 묻고 대화가 보이지 않음')
await other.screenshot({ path: `${shots}/lock-0-other.png` })
const raw = await other.request.get(`${SITE}/api/sessions/${sid}/events`)
ok(raw.status() === 423, `열쇠 없는 요청은 423 (${raw.status()})`)
const row = await other.evaluate(async (id) => {
  const res = await fetch('/api/classic/stream')
  const rd = res.body.getReader()
  // Read until the first whole frame: it may come in several reads, split inside a character.
  const dec = new TextDecoder()
  let buf = ''
  while (!buf.includes('\n\n')) {
    const { value, done } = await rd.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
  }
  rd.cancel()
  const m = /data: (.*)/.exec(buf)
  return JSON.parse(m[1]).sessions.find((s) => s.id === id)
}, sid)
ok(row.locked === true && !row.last && !row.preview && !row.lock, '목록에는 잠겼다는 것만 오고 내용·잠금 정보는 없음')
ok(!JSON.stringify(row).includes('LOCK_ONE'), '목록의 어느 필드에도 대화의 말이 없음 (보낸 글 기록 포함)')
await other.fill('.lock-screen input', 'wrong')
await other.getByRole('button', { name: '열기' }).click()
await other.waitForSelector('.lock-error', { timeout: 10000 })
ok(true, '틀린 비밀번호는 거절')
await other.fill('.lock-screen input', 'pass1234')
await other.getByRole('button', { name: '열기' }).click()
await answered(other, 'LOCK_ONE', 15000)
ok(true, '맞는 비밀번호로 열림')
const kept = await other.evaluate((id) => new Promise((res) => {
  const req = indexedDB.open('cb2-cache')
  req.onupgradeneeded = () => req.result.createObjectStore('logs', { keyPath: 'sid' })
  req.onsuccess = () => {
    const g = req.result.transaction('logs').objectStore('logs').get(id)
    g.onsuccess = () => res(!!g.result)
  }
}), sid)
await other.waitForTimeout(2000)
ok(!kept, '잠긴 세션은 브라우저에 저장하지 않음')

step('잠긴 채로 쓰기')
await other.fill('.inputbox textarea', 'Reply with exactly the word LOCK_TWO and nothing else.')
await other.click('.inputbox .send')
await answered(other, 'LOCK_TWO')
ok(true, '연 탭에서는 보내고 답을 받음')
await answered(app, 'LOCK_TWO', 20000)
ok(true, '잠근 탭에도 새 답이 옴 (내용 없는 신호 → 열쇠로 받아 옴)')

step('다시 잠그기 · 잠금 없애기')
await other.getByRole('button', { name: '세션 메뉴' }).click()
await other.getByRole('menuitem', { name: /^잠금/ }).click()
await other.getByRole('menuitem', { name: '이 탭에서 다시 잠그기' }).click()
await other.waitForSelector('.lock-screen', { timeout: 10000 })
ok(true, '이 탭에서 다시 잠그면 대화가 사라짐')
await app.getByRole('button', { name: '세션 메뉴' }).click()
await app.getByRole('menuitem', { name: /^잠금/ }).click()
await app.getByRole('menuitem', { name: /잠금 없애기/ }).click()
await app.fill('.sheet input.input', 'pass1234')
await app.getByRole('button', { name: '잠금 없애기' }).click()
await other.waitForSelector('.msg-text', { timeout: 15000 })
ok(true, '잠금을 없애면 다른 기기에서도 보임')

step('폰 몸짓')
await app.goto(`${SITE}/`)
await app.waitForSelector('.swipe .srow')
const box = await app.locator('.swipe .srow', { hasText: 'LOCK_ONE' }).first().boundingBox()
const cdp = await phoneCtx.newCDPSession(app)
const touch = async (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
const y = box.y + box.height / 2
await touch('touchStart', box.x + box.width - 20, y)
for (let i = 1; i <= 8; i++) await touch('touchMove', box.x + box.width - 20 - i * 20, y)
await touch('touchEnd')
await app.waitForTimeout(400)
await app.screenshot({ path: `${shots}/lock-1-swipe.png` })
const shifted = await app.locator('.swipe .srow', { hasText: 'LOCK_ONE' }).first().evaluate((el) => el.style.transform)
ok(/translateX\(-144px\)/.test(shifted), `행을 왼쪽으로 밀면 동작 버튼이 나옴 (${shifted})`)
await app.locator('.swipe', { hasText: 'LOCK_ONE' }).first().getByRole('button', { name: '휴면', exact: true }).click()
await app.waitForFunction(() => document.body.textContent.includes('휴면으로 뒀어요'), null, { timeout: 10000 })
ok(true, '밀어서 나온 버튼이 동작함')
await app.goto(`${SITE}/s/${sid}`)
await answered(app, 'LOCK_ONE', 15000)
await app.evaluate(() => history.replaceState({ idx: 1 }, '', location.href))
await touch('touchStart', 6, 400)
for (let i = 1; i <= 8; i++) await touch('touchMove', 6 + i * 20, 402)
await touch('touchEnd')
await app.waitForURL((u) => !u.pathname.startsWith('/s/'), { timeout: 5000 }).then(() => ok(true, '왼쪽 끝에서 밀면 목록으로 돌아감'), () => ok(false, '왼쪽 끝에서 밀면 목록으로 돌아감'))

step('정리')
await app.request.post(`${SITE}/api/sessions/${sid}/close`, { headers: { 'content-type': 'application/json', origin: SITE }, data: {} })
ok(!errors.length, `페이지 오류 없음${errors.length ? `: ${errors.join(' | ')}` : ''}`)
await browser.close()
