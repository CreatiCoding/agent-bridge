// 계정 삭제 (REQ-F-770) against a real server.mjs: alice deletes her account; what the server kept about her goes,
// her old sign-in and her Mac's bridge tab are refused, and bob's account is as it was.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startServer } from './server-harness.mjs'
import { mac } from './fake-mac.mjs'

const A = 'host-alice-0001'
const B = 'host-bob-00001'
const read = (srv, f) => JSON.parse(fs.readFileSync(path.join(srv.data, f), 'utf8'))

describe('계정 삭제', () => {
  let srv
  let aliceMac
  let bobSid
  let aliceJar
  before(async () => {
    srv = await startServer({ seed: { 'access.json': { alice: { login: 'alice', status: 'pending', firstAt: 1, attempts: 1 } }, 'login-pins.json': { alice: 'dev-alice' } }, env: { BRIDGE_DEMO: '1' } })
    for (const who of ['alice', 'bob']) await srv.login(who)
    aliceJar = srv.jar('alice')
    aliceMac = await mac(srv, 'alice', A, 'alice-mac')
    const bobMac = await mac(srv, 'bob', B, 'bob-mac')
    for (const [who, m, host] of [['alice', aliceMac, A], ['bob', bobMac, B]]) {
      const started = srv.api(who, '/api/sessions', { method: 'POST', body: { hostId: host, cwd: '~/x' } })
      await m.answerNew()
      const r = await started
      assert.equal(r.status, 200)
      if (who === 'bob') bobSid = r.json.id
      assert.equal((await srv.api(who, '/api/prefs/prompt', { method: 'POST', body: { text: `${who} 의 프롬프트` } })).status, 200)
      assert.equal((await srv.api(who, '/api/push/subscribe', { method: 'POST', body: { endpoint: `https://fcm.googleapis.com/fcm/send/${who}-endpoint` } })).status, 200)
    }
    assert.ok(fs.existsSync(path.join(srv.data, 'u/dev-alice/push.json')))
  })
  after(() => srv?.stop())

  test('a login name that is not this account’s is refused, and nothing goes', async () => {
    const r = await srv.api('alice', '/api/account/delete', { method: 'POST', body: { login: 'bob' } })
    assert.equal(r.status, 400)
    assert.equal((await srv.api('alice', '/api/me')).status, 200)
  })

  test('deleting removes alice’s data, signs her out everywhere and cuts her Mac off', async () => {
    const r = await srv.api('alice', '/api/account/delete', { method: 'POST', body: { login: 'ALICE' } })
    assert.equal(r.status, 200)
    assert.match(r.headers.get('set-cookie') ?? '', /cb=;.*Max-Age=0/)
    assert.ok(!fs.existsSync(path.join(srv.data, 'u/dev-alice')))
    assert.ok(!('dev-alice' in read(srv, 'users.json')))
    assert.ok(!(A in read(srv, 'hosts.json')))
    assert.ok(!Object.values(read(srv, 'logins.json')).some((v) => v.uid === 'dev-alice'))
    assert.ok(!('alice' in read(srv, 'access.json')))
    // Kept on purpose: the name stays tied to the GitHub id that held it.
    assert.equal(read(srv, 'login-pins.json').alice, 'dev-alice')
  })

  test('her old cookie and her Mac’s bridge tab get 401', async () => {
    const as = (p, opts = {}) => fetch(`${srv.origin}${p}`, { method: opts.body ? 'POST' : 'GET', headers: { cookie: aliceJar, ...(opts.body ? { 'content-type': 'application/json', origin: srv.origin } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined })
    assert.equal((await as('/api/me')).status, 401)
    assert.equal((await as('/api/bridge/hello', { body: { hostId: A, name: 'alice-mac' } })).status, 401)
    assert.equal((await as('/api/bridge/up', { body: { hostId: A, conn: 'x', msgs: [] } })).status, 401)
    assert.equal((await as(`/api/bridge/stream?hostId=${A}&conn=x`)).status, 401)
  })

  test('bob’s account is as it was', async () => {
    assert.equal((await srv.api('bob', '/api/me')).status, 200)
    assert.equal((await srv.api('bob', '/api/prefs/prompt')).json.text, 'bob 의 프롬프트')
    assert.ok(B in read(srv, 'hosts.json'))
    assert.ok('dev-bob' in read(srv, 'users.json'))
    assert.ok(fs.existsSync(path.join(srv.data, 'u/dev-bob/s', bobSid, 'meta.json')))
    assert.equal(read(srv, 'u/dev-bob/push.json').length, 1)
  })

  test('the demo account is only put back to where it starts, and stays signed in', async () => {
    const d = await startServer({ env: { BRIDGE_DEMO: '1', DEMO_LOGIN: 'reviewer', DEMO_PASSWORD: 'test-only-password' } })
    try {
      const r = await fetch(`${d.origin}/api/auth/demo`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', origin: d.origin, 'x-forwarded-for': '10.9.9.9' }, body: JSON.stringify({ login: 'reviewer', password: 'test-only-password' }) })
      const jar = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
      const call = (p, body) => fetch(`${d.origin}${p}`, { method: body ? 'POST' : 'GET', headers: { cookie: jar, ...(body ? { 'content-type': 'application/json', origin: d.origin } : {}) }, body: body ? JSON.stringify(body) : undefined })
      const del = await call('/api/account/delete', { login: '심사용 데모' })
      assert.equal(del.status, 200)
      assert.equal((await del.json()).demo, true)
      assert.ok(!(del.headers.get('set-cookie') ?? '').includes('cb='))
      assert.equal((await call('/api/me')).status, 200)
    } finally {
      await d.stop()
    }
  })

  test('signing in again starts a new, empty account', async () => {
    await srv.login('alice')
    assert.equal((await srv.api('alice', '/api/me')).status, 200)
    assert.equal((await srv.api('alice', '/api/prefs/prompt')).json.text, '')
  })
})
