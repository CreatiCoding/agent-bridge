// Several tabs of the site in one browser on the Mac: one relays, the others wait. What this checks is that the
// Mac stays connected whatever happens to the relaying tab, without anyone having to find and reload that tab.
// Against a running server and one agent on this machine (see README: 개발). No `claude` session is started.
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs SITE=http://localhost:4399 AGENT_A=/tmp/agentA node test/e2e-tabs.mjs
import fs from 'node:fs'
import path from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT)
const SITE = process.env.SITE || 'http://localhost:4399'
const c = JSON.parse(fs.readFileSync(path.join(process.env.AGENT_A, 'agent.json'), 'utf8'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (s) => console.log(`\n== ${s}`)
const ok = (cond, what) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`)
  if (!cond) process.exitCode = 1
}
const until = async (fn, ms) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return Date.now() - t0
    await wait(400)
  }
  return null
}
const secs = (ms) => (ms === null ? '안 됨' : `${(ms / 1000).toFixed(1)}초`)

const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {})
const ctx = await browser.newContext()
await ctx.request.get(`${SITE}/api/auth/dev?login=tester`)
/** What a tab's relay says about itself (web/relay.js). */
const st = (p) => p.evaluate(() => window.__relay?.state()).catch(() => null)
/** A command to the Mac and back, through whichever tab relays. */
const reaches = async () => (await ctx.request.get(`${SITE}/api/hosts/${c.hostId}/dirs?path=~`, { timeout: 8000 }).catch(() => null))?.status() === 200
const relays = async (p) => (await st(p))?.holding && (await st(p)).healthy
const bridgeTab = async () => {
  const p = await ctx.newPage()
  p.on('dialog', (d) => d.accept())
  await p.goto(`${SITE}/bridge#port=${c.port}&key=${c.key}`) // the link the agent opens: it carries the key and takes over
  return p
}
const freeze = async (p) => {
  const cdp = await ctx.newCDPSession(p)
  await cdp.send('Debugger.enable')
  await cdp.send('Debugger.pause') // scripts stop, connections stay open: a tab that is there but does nothing
  return cdp
}

step('한 탭이 연동하고, 다른 탭은 기다린다')
const first = await bridgeTab()
await wait(2500)
await first.close({ runBeforeUnload: false })
const tab1 = await ctx.newPage()
await tab1.goto(`${SITE}/`)
ok((await until(() => relays(tab1), 15000)) !== null, '탭 1이 연동을 맡음')
const tab2 = await ctx.newPage()
await tab2.goto(`${SITE}/`)
await wait(10000)
ok((await relays(tab1)) && !(await st(tab2)).holding && (await st(tab2)).takeovers === 0, '탭 1이 멀쩡한 동안 탭 2는 10초가 지나도 넘겨받지 않음')

step('연동하던 탭이 멈춤 (닫히지는 않음)')
const cdp1 = await freeze(tab1)
let t = await until(async () => (await relays(tab2)) && (await reaches()), 30000)
ok(t !== null, `기다리던 탭 2가 스스로 넘겨받고 명령이 맥까지 왕복 (${secs(t)})`)
await cdp1.send('Debugger.resume')
await cdp1.send('Debugger.disable')
await wait(5000)
const seen = new Set()
for (let i = 0; i < 15; i++) {
  seen.add(`${(await st(tab1))?.holding ? 1 : 0}${(await st(tab2))?.holding ? 1 : 0}`)
  await wait(1000)
}
ok(seen.size === 1 && seen.has('01'), `다시 움직인 탭 1은 물러나 기다리고, 두 탭이 연동을 주고받지 않음 (${[...seen].join(',')})`)

step('에이전트가 연 탭이 넘겨받고, 그 탭이 닫힘')
const b2 = await bridgeTab()
ok((await until(async () => (await relays(b2)) && !(await st(tab2))?.holding, 15000)) !== null, '에이전트가 연 탭이 넘겨받고 탭 2는 물러남')
await wait(9000)
await b2.close({ runBeforeUnload: false })
// Told to stop before the new tab held the lock, the old one used to hand it to the next tab in line: two tabs went
// for the agent, one was turned away, and after this close the Mac stayed unconnected for half a minute.
t = await until(async () => ((await relays(tab1)) || (await relays(tab2))) && (await reaches()), 8000)
ok(t !== null, `닫자마자 기다리던 탭이 이어받고 명령이 왕복 (${secs(t)})`)

step('연동 탭이 멈춘 채로, 다른 탭을 새로고침')
const [holder, other] = (await st(tab1))?.holding ? [tab1, tab2] : [tab2, tab1]
await freeze(holder)
await wait(1000)
await other.reload()
t = await until(async () => (await relays(other)) && (await reaches()), 30000)
ok(t !== null, `새로고침한 탭이 넘겨받음: 멈춘 탭을 찾아 새로고침할 필요가 없음 (${secs(t)})`)

await browser.close()
console.log(process.exitCode ? '\n실패 있음' : '\n모두 통과')
process.exit(process.exitCode ?? 0)
