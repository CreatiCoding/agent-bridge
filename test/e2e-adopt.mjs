// End-to-end check of two things an agent does on its own Mac: carrying on a conversation that was started
// outside the bridge, and opening sessions again after the Mac restarts. Needs a running server and one agent
// (see README: 개발), a conversation made beforehand in WORK2 with `claude -p "Reply with exactly ADOPT_SEED …"`,
// and playwright (not a dependency of this repo):
//   PLAYWRIGHT=… AGENT_A=/tmp/agentA AGENT_START="<command that starts the agent>" WORK2=<folder> SHOTS=<folder> node test/e2e-adopt.mjs
import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT)
const SITE = process.env.SITE || 'http://localhost:4399'
const [home, work2, shots] = [process.env.AGENT_A, process.env.WORK2, process.env.SHOTS]
let MUX = 'tmux'
const cfg = JSON.parse(fs.readFileSync(path.join(home, 'agent.json'), 'utf8'))
const step = (s) => console.log(`\n== ${s}`)
const ok = (cond, what) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`)
  if (!cond) process.exitCode = 1
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {})
const newCtx = async (viewport) => {
  const c = await browser.newContext({ viewport })
  await c.request.get(`${SITE}/api/auth/dev?login=tester`)
  return c
}
const mac = await newCtx({ width: 1280, height: 820 })
const phone = await newCtx({ width: 390, height: 844 })
const linkMac = async () => {
  const p = await mac.newPage()
  await p.goto(`${SITE}/bridge#port=${cfg.port}&key=${cfg.key}`)
  await p.waitForFunction(() => document.getElementById('server-text')?.textContent === '연결됨', null, { timeout: 30000 })
  return p
}
let bridge = await linkMac()
const app = await phone.newPage()
const errors = []
app.on('pageerror', (e) => errors.push(e.message))
const answered = (re, timeout = 120000) => app.waitForFunction((src) => [...document.querySelectorAll('.msg-text')].some((m) => new RegExp(src).test(m.textContent)), re, { timeout })

step('맥의 대화 이어 가기')
await app.goto(`${SITE}/new`)
await app.getByRole('radio', { name: '맥의 대화 이어 가기' }).click()
const item = app.locator('.adopt-item', { hasText: 'ADOPT_SEED' }).first().locator('.adopt-main')
await item.waitFor({ timeout: 30000 })
ok((await item.textContent()).includes(path.basename(work2)), '목록에 bridge 밖에서 만든 대화가 폴더와 함께 보임')
await app.screenshot({ path: `${shots}/adopt-0-list.png` })
await item.click()
await app.getByRole('button', { name: '이어 가기' }).click()
await app.waitForURL(/\/s\/[\w-]+$/, { timeout: 90000 })
const sid = app.url().split('/').pop()
await answered('^ADOPT_SEED$', 60000)
ok(true, '가져오기 전의 대화가 보임')
await app.waitForFunction(() => document.querySelector('.topbar-title > span:not(.crumbs)')?.textContent?.includes('대기'), null, { timeout: 60000 })
await app.fill('.inputbox textarea', 'Reply with exactly the word ADOPT_TWO and nothing else.')
await app.click('.inputbox .send')
await answered('ADOPT_TWO')
ok(true, '가져온 대화가 같은 대화로 이어짐')
await app.screenshot({ path: `${shots}/adopt-1-session.png` })

step('맥이 다시 켜진 뒤 되살리기')
const tmuxName = `cb-${cfg.hostId.slice(0, 4)}-${sid.slice(0, 8)}`
// The program the session's terminal is in (REQ-F-794): zeropty when the agent recorded it, else tmux.
if (JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8'))[sid]?.mux === 'zeropty') {
  const v = fs.readdirSync(path.join(home, 'zeropty')).find((d) => /^\d/.test(d))
  MUX = path.join(home, 'zeropty', v, 'zeropty')
}
console.log(`terminal: ${MUX}`)
const pid = Number(fs.readFileSync(path.join(home, 'agent.pid'), 'utf8'))
process.kill(pid)
await wait(1500)
execSync(`'${MUX}' kill-session -t =${tmuxName}`)
ok(!hasSession(tmuxName), '에이전트를 끄고 세션의 터미널을 없앰 (다시 켜진 맥처럼)')
spawn('/bin/sh', ['-c', process.env.AGENT_START], { detached: true, stdio: 'ignore' }).unref()
let back = false
for (let i = 0; i < 60 && !back; i++) (await wait(1000)), (back = hasSession(tmuxName))
ok(back, '에이전트가 켜지면서 세션을 다시 열었음')
await bridge.close()
bridge = await linkMac()
await app.waitForFunction(() => [...document.querySelectorAll('.note')].some((n) => n.textContent.includes('맥이 다시 켜져서')), null, { timeout: 60000 }).then(() => ok(true, '대화에 다시 열었다고 남김'), () => ok(false, '대화에 다시 열었다고 남김'))
await app.waitForFunction(() => document.querySelector('.topbar-title > span:not(.crumbs)')?.textContent?.includes('대기'), null, { timeout: 90000 })
await app.fill('.inputbox textarea', 'What exact word did you reply with last time? Reply with that word followed by _AGAIN.')
await app.click('.inputbox .send')
await answered('ADOPT_TWO_AGAIN')
ok(true, '다시 연 세션이 앞의 대화를 기억함')
await app.screenshot({ path: `${shots}/adopt-2-revived.png` })

step('정리')
await app.getByRole('button', { name: '세션 메뉴' }).click()
await app.getByRole('menuitem', { name: /^종료/ }).click()
await app.getByRole('button', { name: '끝내기' }).click()
ok(!errors.length, `페이지 오류 없음${errors.length ? `: ${errors.join(' | ')}` : ''}`)
await browser.close()

function hasSession(name) {
  try {
    execSync(`'${MUX}' has-session -t =${name}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
