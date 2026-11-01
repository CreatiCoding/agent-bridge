// Manual check (REQ-F-839 rule 7·8, AC-1523): the real server and page with a played Mac whose tidy report lists two
// test sessions offered "끝내기". Open the printed address in a browser, open the host on 디스크 관리, press 끝내기 on
// one: the row dims as 처리 중 at once, and after the recalculation (counted here) it is gone.
//   node test/manual-tidy-recalc.mjs   (runs 10 minutes)
import { startServer } from './unit/server-harness.mjs'
import { mac } from './unit/fake-mac.mjs'

const srv = await startServer({ env: { BRIDGE_ROOT: process.cwd() } })
await srv.login('alice')
const hostId = 'aaaaaaaa-0000-4000-8000-0000000000f1'
const m = await mac(srv, 'alice', hostId, '시험 맥')
const sids = []
for (const title of ['시험 세션 A', '시험 세션 B']) {
  const made = srv.api('alice', '/api/sessions', { method: 'POST', body: { hostId, cwd: '/Users/x', title } })
  await m.answerNew()
  sids.push((await made).json.id)
}
const day = 86_400_000
const report = () => ({
  at: Date.now(),
  mode: 'suggest',
  local: { date: '2026-11-02', hour: 12 },
  platform: 'darwin',
  sessions: sids.map((sid) => ({ sid, alive: false, lastHumanAt: Date.now() - 40 * day, from: 'transcript', idleDays: 40, act: null, why: null, stopAt: null, rest: false, close: true })),
  folders: [],
  transcripts: [],
  done: { noticed: [], stopped: [], trashed: [], failed: [] },
  would: { stop: 0, trash: 0, bytes: 0 },
})
await m.up({ t: 'tidyReport', report: report() })
let runs = 0
;(async () => {
  for (;;) {
    const cmd = await m.next((x) => x.t === 'tidyRun', 600_000).catch(() => null)
    if (!cmd) return
    runs++
    console.log(`${new Date().toISOString()} tidyRun #${runs}`)
    // A Mac takes a moment to work it out.
    setTimeout(() => void m.up({ t: 'tidyRun', reqId: cmd.reqId, ok: true, report: report() }), 1500)
  }
})()
console.log(`READY ${srv.origin}/api/auth/dev?login=alice  then  ${srv.origin}/disk  sessions ${sids.join(' ')}`)
setTimeout(async () => (m.close(), await srv.stop(), process.exit(0)), 600_000)
