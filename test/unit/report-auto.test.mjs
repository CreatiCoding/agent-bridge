// 자동 대응 (REQ-F-738): the operator picks which of their Macs the fix sessions start on.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './server-harness.mjs'
import { mac } from './fake-mac.mjs'

const NOW = Date.now()
let srv
before(async () => {
  srv = await startServer({
    seed: {
      'hosts.json': {
        'h-boss-air': { uid: 'dev-boss', name: '맥북', lastSeen: NOW },
        'h-boss-mini': { uid: 'dev-boss', name: '맥 미니', lastSeen: NOW },
        'h-alice': { uid: 'dev-alice', name: 'alice-mac', lastSeen: NOW },
      },
    },
  })
  await srv.login('boss')
  await srv.login('alice')
})
after(() => srv?.stop())

const auto = (body) => srv.api('boss', '/api/admin/reports/auto', { method: 'POST', body })

test('자동 대응 starts on the first Mac connected until one is picked', async () => {
  const r = await srv.api('boss', '/api/admin/reports/auto')
  assert.equal(r.status, 200)
  assert.equal(r.json.hostId, null)
})

test('the operator picks one of their own Macs, and can go back to the first one connected', async () => {
  let r = await auto({ hostId: 'h-boss-mini' })
  assert.equal(r.status, 200)
  assert.equal(r.json.hostId, 'h-boss-mini')
  assert.equal((await srv.api('boss', '/api/admin/reports')).json.auto.hostId, 'h-boss-mini')
  r = await auto({ on: true })
  assert.equal(r.json.on, true)
  assert.equal(r.json.hostId, 'h-boss-mini', 'turning it on keeps the pick')
  r = await auto({ hostId: '' })
  assert.equal(r.json.hostId, null)
  await auto({ on: false })
})

test("someone else's Mac cannot be picked", async () => {
  const r = await auto({ hostId: 'h-alice' })
  assert.equal(r.status, 400)
  assert.equal((await srv.api('boss', '/api/admin/reports/auto')).json.hostId, null)
  assert.equal((await srv.api('alice', '/api/admin/reports/auto', { method: 'POST', body: { hostId: 'h-alice' } })).status, 403)
})

test("the operator's own report under 자동 대응 starts a 전부 허용 session (1.424, AC-1205)", async () => {
  const m = await mac(srv, 'boss', 'h-boss-live', '맥북')
  try {
    await auto({ hostId: 'h-boss-live', cwd: '/tmp/auto-fix-work' })
    await auto({ on: true })
    const sent = srv.api('boss', '/api/reports', { method: 'POST', body: { text: '고쳐 주세요' } })
    const opened = await m.answerNew()
    assert.equal((await sent).status, 200)
    const set = await m.next((x) => x.t === 'set' && x.sid === opened.sid && 'autoAllow' in x)
    assert.equal(set.autoAllow, true)
    assert.equal(set.allowAll, true, '안전한 전부 허용이 아니라 전부 허용')
  } finally {
    await auto({ on: false })
    m.close()
  }
})
