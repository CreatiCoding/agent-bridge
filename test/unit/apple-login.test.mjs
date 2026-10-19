// Apple로 로그인 (REQ-F-772): the identity token check on its own (signature, issuer, audience, expiry, nonce), the
// client secret for Apple's token and revoke calls, and the whole sign-in against a real server.mjs with its own test
// keys standing in for Apple's.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startServer } from './server-harness.mjs'
import { AppleTokenError, appleClient, appleIds, isAppleLogin, sha256hex, verifyIdentityToken } from '../../server/apple.mjs'

const AUD = 'dev.creco.bridge'
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const JWKS = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] }
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function token(claims = {}, { key = privateKey, head = { alg: 'RS256', kid: 'k1' } } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const data = `${enc(head)}.${enc({ iss: 'https://appleid.apple.com', aud: AUD, sub: '001234.abcdef', iat: now, exp: now + 600, nonce: 'N', email: 'x@privaterelay.appleid.com', ...claims })}`
  return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`
}
const keyOf = async (kid) => (kid === 'k1' ? publicKey : null)
const check = (t, nonce = 'N') => verifyIdentityToken(t, { audience: AUD, nonce, keyOf })

describe('identity token', () => {
  test('a good token gives its claims', async () => {
    const c = await check(token())
    assert.equal(c.sub, '001234.abcdef')
  })
  for (const [what, t, nonce] of [
    ['another key’s signature', () => token({}, { key: other.privateKey })],
    ['a changed payload', () => { const [h, , s] = token().split('.'); return `${h}.${enc({ iss: 'https://appleid.apple.com', aud: AUD, sub: 'someone-else', exp: 9e9, nonce: 'N' })}.${s}` }],
    ['alg none', () => `${enc({ alg: 'none', kid: 'k1' })}.${enc({ iss: 'https://appleid.apple.com', aud: AUD, sub: 's', exp: 9e9, nonce: 'N' })}.`],
    ['an unknown kid', () => token({}, { head: { alg: 'RS256', kid: 'k9' } })],
    ['another issuer', () => token({ iss: 'https://evil.example' })],
    ['another app', () => token({ aud: 'com.other.app' })],
    ['an old token', () => token({ exp: Math.floor(Date.now() / 1000) - 5 })],
    ['another nonce', () => token({ nonce: 'M' })],
    ['no nonce', () => token({ nonce: undefined })],
    ['not a JWT', () => 'abc'],
  ]) {
    test(`refused: ${what}`, async () => {
      await assert.rejects(check(t(), nonce), AppleTokenError)
    })
  }
})

test('Apple names never look like a GitHub name', () => {
  const { uid, login } = appleIds('001234.abcdef')
  assert.match(uid, /^ap[0-9a-f]{24}$/)
  assert.ok(isAppleLogin(login))
  assert.ok(!/^[a-z0-9-]+$/.test(login))
  assert.ok(!isAppleLogin('apple-0123456789'))
})

test('client secret is an ES256 JWT for Apple, and revoke sends the refresh token', async () => {
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const sent = []
  const c = appleClient({ teamId: 'TEAM', keyId: 'KEY', clientId: AUD, privateKey: ec.privateKey.export({ format: 'pem', type: 'pkcs8' }), post: async (url, f) => (sent.push({ url, f }), { ok: true, json: { refresh_token: 'R' } }) })
  assert.equal(await c.refreshToken('CODE'), 'R')
  assert.equal(await c.revoke('R'), true)
  assert.equal(sent[1].url, 'https://appleid.apple.com/auth/revoke')
  assert.deepEqual([sent[1].f.token, sent[1].f.token_type_hint, sent[1].f.client_id], ['R', 'refresh_token', AUD])
  const [h, p, s] = sent[1].f.client_secret.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY' })
  assert.deepEqual((({ iss, aud, sub }) => ({ iss, aud, sub }))(JSON.parse(Buffer.from(p, 'base64url'))), { iss: 'TEAM', aud: 'https://appleid.apple.com', sub: AUD })
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')))
  assert.equal(appleClient({ teamId: '', keyId: 'KEY', clientId: AUD, privateKey: 'x' }), null)
})

describe('Apple로 로그인 against the server', () => {
  let srv
  before(async () => {
    srv = await startServer({ env: { APPLE_TEST_JWKS: JSON.stringify(JWKS) } })
    await srv.login('boss')
  })
  after(() => srv?.stop())

  const APP_UA = 'Mozilla/5.0 (iPhone) Mobile/15E148 AgentBridge/1.0 (300)'
  /** A nonce from the server: its cookie and the hash the app puts in its request. */
  async function nonce() {
    const r = await fetch(`${srv.origin}/api/auth/apple/nonce`, { method: 'POST', headers: { origin: srv.origin, 'content-type': 'application/json' }, body: '{}' })
    assert.equal(r.status, 200)
    return { jar: r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), hash: (await r.json()).nonce }
  }
  const signIn = (jar, fields) =>
    fetch(`${srv.origin}/api/auth/apple`, { method: 'POST', redirect: 'manual', headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, body: new URLSearchParams(fields) })

  test('the sign-in page shows the Apple button in the app only, above GitHub', async () => {
    const app = await (await fetch(`${srv.origin}/`, { headers: { 'user-agent': APP_UA } })).text()
    assert.ok(app.indexOf('id="apple-login"') > 0 && app.indexOf('id="apple-login"') < app.indexOf('/api/auth/github'))
    assert.ok(!(await (await fetch(`${srv.origin}/`, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Safari' } })).text()).includes('apple-login'))
  })

  test('a nonce from another site is refused', async () => {
    const r = await fetch(`${srv.origin}/api/auth/apple/nonce`, { method: 'POST', headers: { origin: 'https://evil.example' } })
    assert.equal(r.status, 403)
  })

  test('a bad token, or one for another nonce, gets 401', async () => {
    const n = await nonce()
    assert.equal((await signIn(n.jar, { token: token({ nonce: n.hash }, { key: other.privateKey }) })).status, 401)
    const m = await nonce()
    assert.equal((await signIn(m.jar, { token: token({ nonce: 'not-this-one' }) })).status, 401)
    assert.equal((await signIn('', { token: token({ nonce: m.hash }) })).status, 401)
    assert.equal((await signIn(m.jar, { token: token({ nonce: m.hash, aud: 'com.other' }) })).status, 401)
  })

  test('first sign-in waits for an operator even with GITHUB_ALLOWED_LOGINS=*, then gets in, never as an operator', async () => {
    const n = await nonce()
    const r = await signIn(n.jar, { token: token({ nonce: n.hash }), name: '홍길동' })
    assert.equal(r.status, 403)
    const pageText = await r.text()
    assert.match(pageText, /승인을 기다리는 중/)
    assert.match(pageText, /Apple 계정 <b>홍길동<\/b>/)
    const { login } = appleIds('001234.abcdef')
    const list = await srv.api('boss', '/api/admin/access')
    const row = list.json.entries.find((e) => e.login === login)
    assert.equal(row?.name, '홍길동')
    assert.equal(row.status, 'pending')
    assert.equal((await srv.api('boss', '/api/admin/access', { method: 'POST', body: { login, status: 'allowed' } })).status, 200)

    const again = await nonce()
    const t = token({ nonce: again.hash })
    const ok = await signIn(again.jar, { token: t })
    assert.equal(ok.status, 302)
    const jar = ok.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => c.startsWith('cb=')).join('; ')
    assert.ok(jar)
    const me = await (await fetch(`${srv.origin}/api/me`, { headers: { cookie: jar } })).json()
    assert.deepEqual([me.user.login, me.user.name, me.user.apple, me.admin], [login, '홍길동', true, false])

    // The same nonce (and token) once more is refused.
    assert.equal((await signIn(again.jar, { token: t })).status, 401)

    // 계정 삭제: an Apple account types 삭제, not its name; without a key the revoke is skipped and said so.
    const del = (b) => fetch(`${srv.origin}/api/account/delete`, { method: 'POST', headers: { cookie: jar, origin: srv.origin, 'content-type': 'application/json' }, body: JSON.stringify(b) })
    assert.equal((await del({ login })).status, 400)
    assert.equal((await del({ login: '삭제' })).status, 200)
    assert.equal((await fetch(`${srv.origin}/api/me`, { headers: { cookie: jar } })).status, 401)
    assert.match(srv.log(), /Apple 토큰 취소 건너뜀 \(APPLE_PRIVATE_KEY 없음\)/)
  })

  test('the checks hold with the real hash of a nonce', () => {
    assert.equal(sha256hex('a'), crypto.createHash('sha256').update('a').digest('hex'))
  })
})
