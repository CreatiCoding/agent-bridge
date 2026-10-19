// The sign-in cookie is __Host-cb (REQ-S-080): no other subdomain can plant it. Until 2026-11-02 a sign-in still in
// the old `cb` is moved over; a `__Host-cb` always wins, and two `cb` (one planted for a parent domain) count as none.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './server-harness.mjs'

let srv
before(async () => {
  srv = await startServer()
})
after(() => srv.stop())

const token = (jar) => /(?:^|; )__Host-cb=([^;]+)/.exec(jar)?.[1]
const me = (cookie) => fetch(`${srv.origin}/api/me`, { headers: { cookie } })

test('sign-in sets __Host-cb: Secure, Path=/, no Domain, and no bare cb', async () => {
  const r = await fetch(`${srv.origin}/api/auth/dev?login=alice`, { redirect: 'manual' })
  const set = r.headers.getSetCookie()
  const host = set.find((c) => c.startsWith('__Host-cb='))
  assert.ok(host)
  assert.match(host, /; Path=\/;/)
  assert.match(host, /; Secure/)
  assert.doesNotMatch(host, /Domain=/i)
  assert.ok(!set.some((c) => c.startsWith('cb=')))
})

test('a sign-in in the old cb is moved to __Host-cb and the old one dropped', async () => {
  const t = token(await srv.login('alice'))
  const r = await me(`cb=${t}`)
  assert.equal(r.status, 200)
  assert.equal((await r.json()).user.login, 'alice')
  const set = r.headers.getSetCookie()
  assert.ok(set.some((c) => c.startsWith(`__Host-cb=${t};`) && /; Secure/.test(c)))
  assert.ok(set.some((c) => /^cb=; Path=\/; Max-Age=0/.test(c)))
  assert.equal((await me(`__Host-cb=${t}`)).status, 200)
})

test('__Host-cb wins over a planted cb', async () => {
  const a = token(await srv.login('alice'))
  const m = token(await srv.login('mallory'))
  const r = await me(`cb=${m}; __Host-cb=${a}`)
  assert.equal((await r.json()).user.login, 'alice')
  assert.ok(!r.headers.getSetCookie().some((c) => c.startsWith('__Host-cb=')))
  assert.ok(r.headers.getSetCookie().some((c) => /^cb=; /.test(c)))
})

test('two cb values (one planted for a parent domain) are not moved', async () => {
  const a = token(await srv.login('alice'))
  const m = token(await srv.login('mallory'))
  const r = await me(`cb=${a}; cb=${m}`)
  assert.equal(r.status, 401)
  assert.ok(!r.headers.getSetCookie().some((c) => c.startsWith('__Host-cb=')))
  assert.ok(r.headers.getSetCookie().some((c) => /^cb=; /.test(c)))
})

test('a cb that is no sign-in is only dropped', async () => {
  const r = await me('cb=nothing')
  assert.equal(r.status, 401)
  assert.deepEqual(r.headers.getSetCookie().map((c) => c.split(';')[0]), ['cb='])
})

test('logout clears __Host-cb and ends the sign-in', async () => {
  const jar = await srv.login('alice')
  const r = await fetch(`${srv.origin}/api/auth/logout`, { method: 'POST', headers: { cookie: jar, origin: srv.origin } })
  assert.ok(r.headers.getSetCookie().some((c) => /^__Host-cb=; .*Max-Age=0/.test(c)))
  assert.equal((await me(jar)).status, 401)
})

test('on a real domain the old cb is dropped for the host and every parent domain', async () => {
  const s = await startServer({ env: { BRIDGE_ORIGIN: 'https://bridge.example.com' } })
  try {
    const t = token(await s.login('alice'))
    const r = await fetch(`${s.origin}/api/me`, { headers: { cookie: `cb=${t}` } })
    assert.equal(r.status, 200)
    const clears = r.headers.getSetCookie().filter((c) => c.startsWith('cb='))
    assert.deepEqual(clears.map((c) => /Domain=([^;]+)/.exec(c)?.[1] ?? null), [null, 'bridge.example.com', 'example.com'])
  } finally {
    await s.stop()
  }
})

test('plain http on another host keeps the bare cb (it cannot hold a Secure cookie)', async () => {
  const s = await startServer({ env: { BRIDGE_ORIGIN: 'http://bridge.lan' } })
  try {
    const r = await fetch(`${s.origin}/api/auth/dev?login=alice`, { redirect: 'manual' })
    const c = r.headers.getSetCookie().find((x) => x.startsWith('cb='))
    assert.ok(c)
    assert.doesNotMatch(c, /Secure/)
    assert.equal((await fetch(`${s.origin}/api/me`, { headers: { cookie: c.split(';')[0] } })).status, 200)
  } finally {
    await s.stop()
  }
})
