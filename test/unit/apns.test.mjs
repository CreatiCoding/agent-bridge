// 앱 알림 (REQ-F-774): the whole path against the real server with a local HTTP/2 server standing in for Apple's
// (the provider token, the payload and the client's request are tested in server/apns_test.go): registering a device, sending a notice, dropping tokens APNs refuses,
// the demo, no key, deleting the account, and the web push not saying the same thing twice.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http2 from 'node:http2'
import path from 'node:path'
import { startServer } from './server-harness.mjs'
import { mac } from './fake-mac.mjs'

const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
const PEM = ec.privateKey.export({ format: 'pem', type: 'pkcs8' })
const json64 = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
const tok = (c) => c.repeat(64).slice(0, 64)
const OK = tok('a1')
const DEAD = tok('d0')
const BAD = tok('b0')

/** A stand-in for APNs: records each request; DEAD gets 410 Unregistered, BAD gets 400 BadDeviceToken. */
async function fakeApns() {
  const seen = []
  const server = http2.createServer()
  server.on('stream', (stream, headers) => {
    let body = ''
    stream.setEncoding('utf8')
    stream.on('data', (d) => (body += d))
    stream.on('end', () => {
      seen.push({ headers, body: JSON.parse(body) })
      const token = headers[':path'].split('/').pop()
      const [status, reason] = token === DEAD ? [410, 'Unregistered'] : token === BAD ? [400, 'BadDeviceToken'] : [200, '']
      stream.respond({ ':status': status, 'apns-id': crypto.randomUUID() })
      stream.end(reason ? JSON.stringify({ reason }) : '')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { origin: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) }
}
const until = async (ok, ms = 3000) => {
  for (let t = 0; t < ms && !ok(); t += 25) await new Promise((r) => setTimeout(r, 25))
  assert.ok(ok(), 'timed out')
}
/** apns.json of whoever holds it (uid folders are not named after the login). */
const deviceFiles = (data) => {
  const u = path.join(data, 'u')
  return fs.readdirSync(u).map((id) => path.join(u, id, 'apns.json')).filter((f) => fs.existsSync(f))
}
const tokensIn = (data) => deviceFiles(data).flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')).map((d) => d.token))

describe('앱 알림 against the server', () => {
  let srv, apns
  before(async () => {
    apns = await fakeApns()
    srv = await startServer({ env: { APPLE_TEAM_ID: 'TEAM123456', APPLE_KEY_ID: 'KEY1234567', APPLE_PRIVATE_KEY: PEM.replace(/\n/g, '\\n'), APNS_TEST_ORIGIN: apns.origin, BRIDGE_DEMO: '1' } })
    for (const who of ['alice', 'bob', 'carol']) await srv.login(who)
  })
  after(async () => {
    await srv?.stop()
    await apns?.close()
  })
  const register = (who, token, extra = {}) => srv.api(who, '/api/push/apns', { method: 'POST', body: { token, env: 'production', device: 'iphone', ...extra } })

  test('bad tokens and device info are refused', async () => {
    assert.equal((await register('alice', 'xyz')).status, 400)
    assert.equal((await register('alice', OK, { env: 'staging' })).status, 400)
    assert.equal((await register('alice', OK, { device: 'watch' })).status, 400)
  })

  test('a notice goes to each device; 410 and 400 BadDeviceToken drop the token, others stay', async () => {
    for (const t of [OK, DEAD, BAD]) assert.equal((await register('alice', t)).json.apns, true)
    assert.deepEqual((await srv.api('alice', `/api/push/apns?token=${OK}`)).json, { on: true, apns: true })
    assert.equal((await srv.api('alice', '/api/push/key')).json.apns, true)
    apns.seen.length = 0
    assert.equal((await srv.api('alice', '/api/dev/notice', { method: 'POST', body: { sid: 'sess-0001', title: '내 세션', text: 'Bash 권한 대기' } })).status, 200)
    await until(() => apns.seen.length === 3)
    const toOk = apns.seen.find((r) => r.headers[':path'].endsWith(OK))
    assert.equal(toOk.headers['apns-topic'], 'dev.creco.bridge')
    assert.equal(toOk.headers['apns-push-type'], 'alert')
    assert.deepEqual(toOk.body, { aps: { alert: { title: '내 세션', body: 'Bash 권한 대기' }, sound: 'default', 'thread-id': 'sess-0001' }, sid: 'sess-0001' })
    await until(() => tokensIn(srv.data).length === 1)
    assert.deepEqual(tokensIn(srv.data), [OK])
  })

  test('nothing is sent while a page of that person is on screen', async () => {
    await srv.api('alice', '/api/focus', { method: 'POST', body: { visible: true } })
    apns.seen.length = 0
    await srv.api('alice', '/api/dev/notice', { method: 'POST', body: { title: 'a', text: 'b' } })
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(apns.seen.length, 0)
    await srv.api('alice', '/api/focus', { method: 'POST', body: { visible: true } })
    // A prompt of macOS has to be pressed at the Mac: it is pushed even with a page in front (REQ-F-777).
    const m = await mac(srv, 'alice', 'host-alice-0001', 'alice-mac')
    try {
      await m.up({ t: 'sysdialog', on: true, at: Date.now(), sids: [] })
      await until(() => apns.seen.length === 1)
      assert.equal(apns.seen[0].body.aps.alert.title, '맥에 시스템 허락 창이 떠 있어요')
    } finally {
      m.close()
    }
    await srv.api('alice', '/api/focus', { method: 'POST', body: { visible: false } })
  })

  test('turning it off, and the same phone signing in as someone else, take the token away', async () => {
    assert.equal((await register('bob', OK)).status, 200)
    assert.equal((await srv.api('alice', `/api/push/apns?token=${OK}`)).json.on, false)
    assert.equal((await srv.api('bob', `/api/push/apns?token=${OK}`)).json.on, true)
    assert.equal((await srv.api('bob', '/api/push/apns', { method: 'POST', body: { token: OK, off: true } })).status, 200)
    assert.equal((await srv.api('bob', `/api/push/apns?token=${OK}`)).json.on, false)
  })

  test('a web push subscription remembers it came from an iPhone', async () => {
    const endpoint = 'https://web.push.apple.com/QGxyz0123456789'
    const r = await srv.api('carol', '/api/push/subscribe', { method: 'POST', body: { endpoint }, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' } })
    assert.equal(r.status, 200)
    const file = fs.readdirSync(path.join(srv.data, 'u')).map((id) => path.join(srv.data, 'u', id, 'push.json')).find((f) => fs.existsSync(f))
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((s) => s.dev), ['iphone'])
    await srv.api('carol', '/api/push/subscribe', { method: 'POST', body: { endpoint, off: true } })
  })

  test('deleting the account deletes its device tokens', async () => {
    await srv.login('dave')
    assert.equal((await register('dave', tok('e5'))).status, 200)
    assert.ok(tokensIn(srv.data).includes(tok('e5')))
    assert.equal((await srv.api('dave', '/api/account/delete', { method: 'POST', body: { login: 'dave' } })).status, 200)
    assert.ok(!tokensIn(srv.data).includes(tok('e5')))
  })

  test('the public demo can neither register nor be sent to', async () => {
    const r = await fetch(`${srv.origin}/api/auth/demo`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: srv.origin, 'x-forwarded-for': '10.8.0.1' }, body: '' })
    const jar = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
    assert.ok(jar)
    const reg = await fetch(`${srv.origin}/api/push/apns`, { method: 'POST', headers: { cookie: jar, origin: srv.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: tok('f7'), env: 'production', device: 'iphone' }) })
    assert.equal(reg.status, 403)
    assert.ok(!tokensIn(srv.data).includes(tok('f7')))
  })
})

describe('앱 알림 without a key', () => {
  let srv, apns
  before(async () => {
    apns = await fakeApns()
    srv = await startServer({ env: { APPLE_TEAM_ID: undefined, APPLE_KEY_ID: undefined, APPLE_PRIVATE_KEY: undefined, APNS_KEY_ID: undefined, APNS_PRIVATE_KEY: undefined, APNS_TEST_ORIGIN: apns.origin, BRIDGE_DEMO: '1' } })
    await srv.login('alice')
  })
  after(async () => {
    await srv?.stop()
    await apns?.close()
  })

  test('devices still register, nothing is sent, and the log says so once', async () => {
    const r = await srv.api('alice', '/api/push/apns', { method: 'POST', body: { token: OK, env: 'production', device: 'iphone' } })
    assert.deepEqual([r.status, r.json.apns], [200, false])
    assert.equal((await srv.api('alice', '/api/push/key')).json.apns, false)
    for (let i = 0; i < 2; i++) await srv.api('alice', '/api/dev/notice', { method: 'POST', body: { title: 'a', text: `b${i}` } })
    await until(() => /앱 알림 건너뜀/.test(srv.log()))
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(srv.log().match(/앱 알림 건너뜀/g).length, 1)
    assert.equal(apns.seen.length, 0)
    assert.deepEqual(tokensIn(srv.data), [OK])
  })
})
