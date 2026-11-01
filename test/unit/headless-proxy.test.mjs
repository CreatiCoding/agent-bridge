// AC-1507: the link Chrome's command line (agent.json chromeFlags) and how the relay tells a proxy's sign-in gate
// from this server's answer (REQ-F-833).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chromeArgs } from '../../agent/guard.mjs'
import { turnedAway } from '../../web/relay.js'

test('chromeArgs: both flags by default, one profile and cookie store for headless and visible', () => {
  const h = chromeArgs('/p', { mac: true, headless: true })
  assert.equal(h[0], '--headless=new')
  assert.ok(h.includes('--user-data-dir=/p'))
  assert.ok(h.includes('--disable-features=LocalNetworkAccessChecks'))
  assert.ok(h.includes('--use-mock-keychain'))
  assert.ok(h.includes('--mute-audio'))
  const v = chromeArgs('/p', { mac: true, headless: false })
  assert.ok(!v.some((a) => a.startsWith('--headless') || a === '--mute-audio'))
  assert.deepEqual(
    v.filter((a) => a.startsWith('--user-data-dir') || a.includes('keychain') || a.includes('LocalNetwork')),
    h.filter((a) => a.startsWith('--user-data-dir') || a.includes('keychain') || a.includes('LocalNetwork')),
  )
})

test('chromeArgs: chromeFlags leaves the two flags out; Linux keeps its basic store', () => {
  const off = chromeArgs('/p', { mac: true, headless: true, flags: { localNetwork: false, mockKeychain: false } })
  assert.ok(!off.some((a) => a.includes('LocalNetworkAccessChecks') || a === '--use-mock-keychain'))
  const one = chromeArgs('/p', { mac: true, headless: true, flags: { localNetwork: false } })
  assert.ok(one.includes('--use-mock-keychain') && !one.some((a) => a.includes('LocalNetworkAccessChecks')))
  const linux = chromeArgs('/p', { mac: false, headless: true, flags: { mockKeychain: false } })
  assert.ok(linux.includes('--password-store=basic') && !linux.includes('--use-mock-keychain'))
  assert.ok(chromeArgs('/p', { mac: true, headless: true, flags: 'x' }).includes('--use-mock-keychain'))
})

const res = (status, type = 'basic', ct = 'application/json') => ({ status, type, ok: status >= 200 && status < 300, headers: new Headers({ 'content-type': ct }) })

test('turnedAway: a redirect, 401 or an HTML page where JSON was asked; not this server answers', () => {
  assert.match(turnedAway(res(0, 'opaqueredirect')), /다른 주소/)
  assert.match(turnedAway(res(302)), /다른 주소/)
  assert.equal(turnedAway(res(401)), 'HTTP 401')
  assert.match(turnedAway(res(200, 'basic', 'text/html; charset=utf-8')), /HTML/)
  assert.equal(turnedAway(res(200)), null)
  assert.equal(turnedAway(res(204, 'basic', '')), null)
  assert.equal(turnedAway(res(409)), null)
  // A gateway's error page is not a sign-in.
  assert.equal(turnedAway(res(502, 'basic', 'text/html')), null)
})
