// End-to-end check of a Mac that does not trust the server (REQ-S-090~095): pairing at the Mac's terminal, the
// page's signatures, what the Mac refuses in enforce (no signature, a reused one, one for another text), and
// sealing (`trust seal on`): the paired page reads the words, the server and an unpaired page see pieces.
// DATA=<the server's data folder> also searches it for the sealed word.
// Needs a running server, one agent (see README: 개발) and playwright (not a dependency of this repo):
//   PLAYWRIGHT=… AGENT_A=/tmp/agentA WORK=<folder> SHOTS=<folder> [DATA=<folder>] node test/e2e-trust.mjs
// It changes the agent's trust mode and leaves it off at the end.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT)
const SITE = process.env.SITE || 'http://localhost:4399'
const [home, work, shots] = [process.env.AGENT_A, process.env.WORK, process.env.SHOTS]
const MODEL = process.env.MODEL ?? 'claude-haiku-4-5-20251001'
const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent', 'agent.mjs')
const cfg = JSON.parse(fs.readFileSync(path.join(home, 'agent.json'), 'utf8'))
const audit = () => (fs.existsSync(path.join(home, 'trust', 'audit.log')) ? fs.readFileSync(path.join(home, 'trust', 'audit.log'), 'utf8') : '')
const step = (s) => console.log(`\n== ${s}`)
const ok = (cond, what) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`)
  if (!cond) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cli = (...args) => spawnSync(process.execPath, [AGENT, 'trust', ...args], { env: { ...process.env, CLAUDE_BRIDGE_HOME: home }, encoding: 'utf8' }).stdout
const until = async (f, ms = 20000, what = '') => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await f()) return true
    await sleep(300)
  }
  throw new Error(`기다리다 끝남: ${what}`)
}

/** `trust pair` at the terminal: answers with what `answer(name)` gives, and resolves with its output. */
function terminalPair(answer) {
  const p = spawn(process.execPath, [AGENT, 'trust', 'pair'], { env: { ...process.env, CLAUDE_BRIDGE_HOME: home } })
  let out = ''
  const ready = new Promise((res) => {
    p.stdout.on('data', async (b) => {
      out += b
      if (/5분 동안/.test(out)) res()
      if (/6자리 숫자를 입력하세요[^\n]*$/.test(out)) {
        out += '\n'
        p.stdin.write(`${await answer()}\n`)
      }
    })
  })
  const done = new Promise((res) => p.on('exit', () => res(out)))
  return { ready, done, kill: () => p.kill() }
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
const J = { 'content-type': 'application/json', origin: SITE }

try {
  step('off: 짝짓기를 받지 않음')
  cli('mode', 'off')
  await sleep(2500)
  const r0 = await otherCtx.request.post(`${SITE}/api/hosts/${cfg.hostId}/trust`, { headers: J, data: { op: 'pair1', c: 'A'.repeat(43) } })
  ok(r0.status() === 409 && /off/.test((await r0.json()).error ?? ''), `off 인 맥은 짝짓기를 거절 (${r0.status()})`)

  step('warn 으로 켜고 터미널에서 짝짓기')
  cli('mode', 'warn')
  await sleep(2500)
  const phone = watch(await phoneCtx.newPage(), 'phone')
  await phone.goto(`${SITE}/settings/device`)
  await phone.waitForSelector('text=맥 짝짓기', { timeout: 15000 })
  // Without the terminal's window the Mac refuses.
  const early = await otherCtx.request.post(`${SITE}/api/hosts/${cfg.hostId}/trust`, { headers: J, data: { op: 'pair1', c: 'A'.repeat(43) } })
  ok(early.status() === 409 && /창/.test((await early.json()).error ?? ''), '맥에서 창을 열기 전에는 거절')
  let shown = ''
  const term = terminalPair(async () => shown)
  await term.ready
  await phone.getByRole('button', { name: '짝짓기' }).first().click()
  await phone.waitForFunction(() => [...document.querySelectorAll('div')].some((d) => /^\d{3} \d{3}$/.test(d.textContent ?? '')), null, { timeout: 20000 })
  shown = (await phone.evaluate(() => [...document.querySelectorAll('div')].map((d) => d.textContent ?? '').find((t) => /^\d{3} \d{3}$/.test(t)))).replace(' ', '')
  ok(/^\d{6}$/.test(shown), `기기 화면에 확인 숫자 (${shown})`)
  await phone.screenshot({ path: `${shots}/trust-1-sas.png` })
  const termOut = await term.done
  ok(termOut.includes(`확인 숫자 ${shown.slice(0, 3)} ${shown.slice(3)} 일치`) && /짝지었어요/.test(termOut), '터미널에 같은 숫자가 뜨고 짝지어짐')
  await phone.waitForSelector('text=이 기기와 짝지음', { timeout: 20000 })
  ok(true, '화면에 짝지음 표시')
  ok(/짝지은 때/.test(cli('devices')), 'CLI 기기 목록에 보임')
  await phone.screenshot({ path: `${shots}/trust-2-paired.png` })

  step('틀린 숫자는 세 번 뒤 거절')
  const other = watch(await otherCtx.newPage(), 'other')
  await other.goto(`${SITE}/settings/device`)
  await other.waitForSelector('text=맥 짝짓기', { timeout: 15000 })
  const bad = terminalPair(async () => '000000')
  await bad.ready
  await other.getByRole('button', { name: '짝짓기' }).first().click()
  const badOut = await bad.done
  ok(/거절하고 짝짓기 창을 닫았어요/.test(badOut), '터미널이 거절하고 창을 닫음')
  await other.waitForSelector('text=거절했거나 숫자가 달랐어요', { timeout: 20000 })
  ok(!(await other.locator('text=이 기기와 짝지음').count()), '다른 기기는 짝지어지지 않음')

  step('세션 하나(warn: 서명 없이도 실행하고 기록)')
  const r = await otherCtx.request.post(`${SITE}/api/sessions`, { headers: J, data: { hostId: cfg.hostId, cwd: work, prompt: 'Reply with exactly the word TRUST_ONE and nothing else.', model: MODEL } })
  const sid = (await r.json()).id
  await phone.goto(`${SITE}/s/${sid}`)
  const answered = (re, timeout = 120000) => phone.waitForFunction((src) => [...document.querySelectorAll('.msg-text')].some((m) => new RegExp(src).test(m.textContent)), re, { timeout })
  await answered('TRUST_ONE')
  ok(/warn \S+ new|warn new/.test(audit()), '서명 없는 새 세션이 warn 으로 기록됨')

  step('enforce: 서명 없는 글은 거부')
  cli('mode', 'enforce')
  await sleep(2500)
  await otherCtx.request.post(`${SITE}/api/sessions/${sid}/say`, { headers: J, data: { text: 'Reply with exactly the word TRUST_BAD and nothing else.' } })
  await until(() => /refused send \S+: 서명 없음/.test(audit()), 15000, '서명 없는 send 거부 기록')
  ok(true, '서명 없는 send 를 맥이 거부')

  step('enforce: 화면에서 보낸 글은 실행')
  let header = null
  phone.on('request', (q) => {
    if (q.url().endsWith(`/api/sessions/${sid}/say`)) header = q.headers()['x-bridge-auth'] ?? null
  })
  await phone.fill('.inputbox textarea', 'Reply with exactly the word TRUST_GOOD and nothing else.')
  await phone.click('.inputbox .send')
  await answered('TRUST_GOOD')
  ok(!!header, '요청에 X-Bridge-Auth 가 붙음')
  ok(/ok \S+ send/.test(audit()), '맥이 서명을 확인하고 실행')
  ok(!(await phone.locator('.msg-text', { hasText: 'TRUST_BAD' }).count()), '거부한 글은 대화에 답이 없음')

  step('재전송·변조 거부')
  await otherCtx.request.post(`${SITE}/api/sessions/${sid}/say`, { headers: { ...J, 'x-bridge-auth': header }, data: { text: 'Reply with exactly the word TRUST_GOOD and nothing else!' } })
  await until(() => /refused send \S+: 이미 쓴 서명/.test(audit()), 15000, '재전송 거부')
  ok(true, '같은 서명을 다시 쓰면 거부')
  // A token the server kept and never used, put on another text.
  let fresh = null
  await phone.route(`**/api/sessions/${sid}/say`, (route) => ((fresh = route.request().headers()['x-bridge-auth']), route.abort()))
  await phone.fill('.inputbox textarea', 'Reply with exactly the word TRUST_ORIG and nothing else.')
  await phone.click('.inputbox .send')
  await until(() => !!fresh, 10000, '가로챈 서명')
  await phone.unroute(`**/api/sessions/${sid}/say`)
  await otherCtx.request.post(`${SITE}/api/sessions/${sid}/say`, { headers: { ...J, 'x-bridge-auth': fresh }, data: { text: 'Reply with exactly the word TRUST_SWAP and nothing else.' } })
  await until(() => /refused send \S+: 서명한 글·그림과 다름/.test(audit()), 15000, '변조 거부')
  ok(true, '다른 글에 붙인 서명은 거부')

  step('enforce: 끈 명령(sudo)·서명 없는 맥 동작')
  await otherCtx.request.post(`${SITE}/api/hosts/${cfg.hostId}/update`, { headers: J, data: { mode: 'night', from: 2, to: 5 } })
  await until(() => /refused updatePolicy/.test(audit()), 15000, 'updatePolicy 거부')
  ok(true, '서명 없는 업데이트 시간 바꾸기 거부')

  step('봉인(1.394): 내용은 짝지은 기기만 읽음')
  cli('seal', 'on')
  await sleep(2500)
  await phone.goto(`${SITE}/settings/device`)
  await phone.waitForSelector('text=봉인', { timeout: 15000 })
  ok(true, '설정에 봉인 표시')
  await phone.goto(`${SITE}/s/${sid}`)
  await phone.fill('.inputbox textarea', 'Reply with exactly the word SEALWORD and nothing else.')
  await phone.click('.inputbox .send')
  await answered('SEALWORD')
  ok(true, '짝지은 기기에서 봉인된 답이 풀려 보임')
  const mine = await phone.evaluate(() => document.body.innerText.split('the word SEALWORD and').length - 1)
  ok(mine === 1, `내 말풍선이 풀려 한 번만 보임(에코는 bridgeEcho 로 빠짐) (${mine})`)
  const evs = await (await otherCtx.request.get(`${SITE}/api/sessions/${sid}/events`)).text()
  ok(!/SEALWORD/.test(evs) && /⟦bt1:/.test(evs), '서버가 주는 대화 기록에는 봉인 조각만')
  if (process.env.DATA) {
    const hits = []
    const walk = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name)
        if (f.isDirectory()) walk(p)
        else if (f.isFile() && fs.statSync(p).size < 64 * 1024 * 1024 && fs.readFileSync(p).includes('SEALWORD')) hits.push(p)
      }
    }
    walk(process.env.DATA)
    ok(!hits.length, `서버 데이터 폴더에 평문 없음 ${hits.join(' ')}`)
  }
  const stranger = watch(await otherCtx.newPage(), 'other')
  await stranger.goto(`${SITE}/s/${sid}`)
  await stranger.waitForFunction(() => [...document.querySelectorAll('.msg-text')].some((m) => m.textContent.includes('🔒')), null, { timeout: 20000 })
  ok(!(await stranger.locator('.msg-text', { hasText: 'SEALWORD' }).count()), '짝짓지 않은 브라우저에는 🔒')
  await phone.screenshot({ path: `${shots}/trust-4-sealed.png` })
  await stranger.close()

  step('봉인 중 짝지은 기기에서 연 새 세션에도 이름(1.452)')
  await phone.goto(SITE)
  await phone.click('.fab')
  await phone.waitForSelector('.folder-item', { timeout: 15000 })
  await phone.fill('input.input.mono', work)
  await phone.press('input.input.mono', 'Enter')
  await phone.waitForFunction(() => !document.querySelector('.folder-item .spinner'), null, { timeout: 15000 })
  await phone.fill('textarea.input', 'NAMEWORD: reply with exactly the word NAMEDONE and nothing else.')
  await phone.getByRole('button', { name: '시작' }).click()
  await phone.waitForURL(/\/s\/[\w-]+$/, { timeout: 60000 })
  const named = phone.url().split('/').pop()
  await answered('NAMEDONE')
  const titleOnServer = async () => {
    const pid = Math.random().toString(16).slice(2).padEnd(16, '0')
    const j = await (await otherCtx.request.get(`${SITE}/api/classic/poll?wait=0&pid=${pid}`)).json()
    const st = (j.msgs ?? []).map((m) => JSON.parse(m)).find((m) => m.t === 'state')
    return st?.sessions.find((s) => s.id === named)?.title ?? ''
  }
  const t1 = await titleOnServer()
  ok(/^⟦bt1:[^⟧]+⟧$/.test(t1), `서버의 이름은 봉인 조각 하나(🔒 아님) (${t1.slice(0, 24)}…)`)
  await phone.waitForFunction(() => {
    const b = document.querySelector('.crumbs b') ?? document.querySelector('header b')
    return !!b && !!b.textContent.trim() && !b.textContent.includes('🔒')
  }, null, { timeout: 30000 })
  const shownName = await phone.evaluate(() => (document.querySelector('.crumbs b') ?? document.querySelector('header b')).textContent)
  ok(!!shownName && !shownName.includes('🔒'), `짝지은 기기에 이름이 풀려 보임 (${shownName})`)
  await phone.screenshot({ path: `${shots}/trust-5-named.png` })
  cli('seal', 'off')
  await sleep(2500)

  step('설정에서 해제')
  await phone.goto(`${SITE}/settings/device`)
  await phone.waitForSelector('text=서명 필수', { timeout: 15000 })
  await phone.screenshot({ path: `${shots}/trust-3-enforce.png` })
  await phone.getByRole('button', { name: '해제' }).first().click()
  await phone.getByRole('button', { name: '해제' }).last().click()
  await until(() => /짝지은 기기 없음/.test(cli('devices')), 15000, '해제')
  ok(true, '서명한 해제로 기기가 빠짐')
  await phone.waitForSelector('button:has-text("짝짓기")', { timeout: 15000 })
  ok(true, '화면도 짝짓기 전으로')
  ok(!errors.length, `페이지 오류 없음 ${errors.join(' | ')}`)
} catch (e) {
  console.log(`FAIL ${e.message}`)
  console.log(`페이지 오류: ${errors.join(' | ') || '없음'}`)
  for (const [i, p] of mac.pages().concat(phoneCtx.pages(), otherCtx.pages()).entries()) await p.screenshot({ path: `${shots}/trust-fail-${i}.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  cli('seal', 'off')
  cli('mode', 'off')
  await browser.close()
}
