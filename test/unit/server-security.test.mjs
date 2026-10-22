// Findings of review report #1 that only show through the server's HTTP API, checked against the real server.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startServer } from './server-harness.mjs'

const NOW = Date.now()
const session = (id, extra) => ({ id, uid: 'dev-alice', hostId: 'h-alice', title: `비밀 제목 ${id}`, cwd: `/Users/alice/secret-${id}`, preview: `비밀 첫 메시지 ${id}`, createdAt: NOW, lastAt: NOW, updatedAt: NOW, seq: 0, lines: 0, ...extra })
const LOCK = { salt: 'x', hash: 'y', at: NOW }

let srv
before(async () => {
  srv = await startServer({
    seed: {
      'hosts.json': { 'h-alice': { uid: 'dev-alice', name: 'alice-mac', home: '/Users/alice', lastSeen: NOW } },
      'u/dev-alice/s/s-locked-ended/meta.json': session('s-locked-ended', { closed: true, lock: LOCK }),
      'u/dev-alice/s/s-open/meta.json': session('s-open', {}),
      'u/dev-alice/hosts/h-alice.log': `${JSON.stringify({ ts: NOW, level: 'error', area: 'open', text: '세션을 열지 못함: ENOENT /Users/alice/secret-project/app.js ~/work/x · ~/my secret folder/y · $HOME/.claude-bridge/z' })}\n`,
      'u/dev-alice/s/s-locked-open/meta.json': session('s-locked-open', { lock: { salt: '00'.repeat(16), hash: '11'.repeat(32), at: NOW } }),
    },
  })
  await srv.login('alice')
  await srv.login('boss')
})
after(() => srv?.stop())

// R1-M5: an operator looking at someone else's Mac saw their sessions' titles and folders.
test("an operator sees someone else's Mac without their sessions' words", async () => {
  const mine = await srv.api('alice', '/api/hosts/h-alice/status')
  assert.equal(mine.status, 200)
  assert.equal(mine.json.sessions.find((s) => s.id === 's-open').title, '비밀 제목 s-open')
  const op = await srv.api('boss', '/api/hosts/h-alice/status')
  assert.equal(op.status, 200)
  const s = op.json.sessions.find((x) => x.id === 's-open')
  assert.ok(s, 'the operator still sees the session is there')
  assert.doesNotMatch(op.text, /비밀|secret-/)
  assert.deepEqual(s.state.held, [])
})

// R1-M2: the Slack link connected on a GET; now only this site's own form post does.
test('the Slack link page connects only on a form post from this site', async () => {
  const form = { 'content-type': 'application/x-www-form-urlencoded' }
  const post = (headers) => fetch(`${srv.origin}/api/plugins/slack/link`, { method: 'POST', redirect: 'manual', headers: { cookie: srv.jar('alice'), ...form, ...headers }, body: 'code=x' })
  assert.equal((await post({})).status, 403, 'Origin 없는 폼')
  assert.equal((await post({ origin: 'https://evil.test' })).status, 403, '다른 출처의 폼')
  assert.equal((await post({ origin: srv.origin })).status, 200)
  // Any other route still takes JSON only.
  assert.equal((await fetch(`${srv.origin}/api/reports`, { method: 'POST', headers: { cookie: srv.jar('alice'), ...form, origin: srv.origin }, body: 'text=x' })).status, 415)
})

// R1-M4: the rate limit keyed on the first X-Forwarded-For value, which the client picks. Unlocking a session is
// now also counted per session, whatever address the attempts claim.
test('password attempts on a locked session are limited per session, not per claimed address', async () => {
  let last = 0
  for (let i = 0; i < 11; i++) {
    last = (await srv.api('alice', '/api/sessions/s-locked-open/unlock', { method: 'POST', body: { proof: '0'.repeat(64) }, headers: { 'x-forwarded-for': `10.0.0.${i}` } })).status
  }
  assert.equal(last, 429)
})

test('locking and unlocking still work with the password check off the event loop', async () => {
  const proof = 'ab'.repeat(32)
  const locked = await srv.api('alice', '/api/sessions/s-open/lock', { method: 'POST', body: { proof } })
  assert.equal(locked.status, 200)
  assert.ok(locked.json.token)
  assert.equal((await srv.api('alice', '/api/sessions/s-open/unlock', { method: 'POST', body: { proof: 'cd'.repeat(32) } })).status, 403)
  const open = await srv.api('alice', '/api/sessions/s-open/unlock', { method: 'POST', body: { proof } })
  assert.equal(open.status, 200)
  assert.ok(open.json.token)
})

// R1-L13: any https address was taken as a push subscription, and the server posted there.
test('push subscriptions are taken only for browser push services', async () => {
  const sub = (endpoint) => srv.api('alice', '/api/push/subscribe', { method: 'POST', body: { endpoint } })
  assert.equal((await sub('https://evil.test/collect/abcdef')).status, 400)
  assert.equal((await sub('https://fcm.googleapis.com.evil.test/x/abcdef')).status, 400)
  assert.equal((await sub('https://fcm.googleapis.com/fcm/send/abcdef')).status, 200)
  assert.equal((await sub('https://web.push.apple.com/QWERTYUIOP')).status, 200)
  // R1-L6: what the server writes is for its own user only.
  const file = path.join(srv.data, 'u', 'dev-alice', 'push.json')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

// R1-L14: a QR sign-in link switched whoever opened it to its account, even someone signed in as another.
test('a QR sign-in link asks before switching an account that is already signed in', async () => {
  const made = await srv.api('boss', '/api/qr', { method: 'POST', body: {} })
  const link = made.json.url.replace(/^https?:\/\/[^/]+/, srv.origin)
  const look = await fetch(link, { redirect: 'manual', headers: { cookie: srv.jar('alice') } })
  assert.equal(look.status, 200)
  assert.match(await look.text(), /다른 계정으로 로그인할까요/)
  assert.equal((await srv.api('alice', '/api/me')).json.user.login, 'alice', '보기만 해서는 바뀌지 않음')
  assert.equal((await fetch(link, { method: 'POST', redirect: 'manual', headers: { cookie: srv.jar('alice'), origin: 'https://evil.test' } })).status, 403)
  const yes = await fetch(link, { method: 'POST', redirect: 'manual', headers: { cookie: srv.jar('alice'), origin: srv.origin } })
  assert.equal(yes.status, 302)
  assert.match(yes.headers.get('set-cookie') ?? '', /cb=/)
})

// R1-L16: a public server (GitHub sign-in on) took its own origin from the request's Host and X-Forwarded-Proto.
test('a public server does not start without BRIDGE_ORIGIN', async () => {
  const { spawnSync } = await import('node:child_process')
  const os = await import('node:os')
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-origin-'))
  const env = { ...process.env, HOME: data, BRIDGE_DATA: data, PORT: '0', GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'y' }
  delete env.BRIDGE_ORIGIN
  delete env.CLAUDECODE
  const { serverBin, ROOT } = await import('./server-bin.mjs')
  env.BRIDGE_ROOT = ROOT
  const r = spawnSync(serverBin(), [], { env, timeout: 10_000, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /BRIDGE_ORIGIN/)
  fs.rmSync(data, { recursive: true, force: true })
})

// R1-L14 (리포트 #3 남은 것): a browser that is signed out was signed in by a GET of someone's QR link.
test('a QR sign-in link asks a signed-out browser too, and signs in only on a form post', async () => {
  const made = await srv.api('boss', '/api/qr', { method: 'POST', body: {} })
  const link = made.json.url.replace(/^https?:\/\/[^/]+/, srv.origin)
  const look = await fetch(link, { redirect: 'manual' })
  assert.equal(look.status, 200)
  assert.equal(look.headers.get('set-cookie'), null, '열기만 해서는 로그인되지 않음')
  assert.match(await look.text(), /boss 로 로그인할까요/)
  const yes = await fetch(link, { method: 'POST', redirect: 'manual', headers: { origin: srv.origin } })
  assert.equal(yes.status, 302)
  assert.match(yes.headers.get('set-cookie') ?? '', /cb=/)
})

// R1-M5 (리포트 #6·#7 남은 것): error lines name folders; an operator reading someone else's Mac sees none.
test("an operator reading someone else's host log sees no paths", async () => {
  const mine = await srv.api('alice', '/api/hosts/h-alice/logs')
  assert.match(mine.text, /secret-project/)
  const op = await srv.api('boss', '/api/hosts/h-alice/logs')
  assert.equal(op.status, 200)
  assert.doesNotMatch(op.text, /secret-project|\/Users\/alice|~\/work|secret folder|\.claude-bridge/)
  assert.match(op.text, /\(경로\)/)
})

// R8-L3 (리포트 #8): an operator saw the Mac's home folder in the host detail.
test("an operator does not see the home folder of someone else's Mac", async () => {
  assert.equal((await srv.api('alice', '/api/hosts/h-alice/status')).json.host.home, '/Users/alice')
  const op = await srv.api('boss', '/api/hosts/h-alice/status')
  assert.equal(op.json.host.home, '')
})

// R7-M1 (리포트 #8 남은 것): a deploy whose agent seq went back from what this data already handed out sends no update.
test('a server whose agent signature went back in seq says so and sends no update', async () => {
  const back = await startServer({ seed: { 'agent-seq.json': { max: 9_999_999_999 } } })
  try {
    await back.login('boss')
    const h = (await back.api('boss', '/api/admin/overview')).json.server
    assert.equal(h.agentSigned, false)
    assert.equal(h.agentSeqBack, true)
    assert.match(back.log(), /순번\(\d+\)이 전에 내보낸 것/)
  } finally {
    await back.stop()
  }
  assert.equal((await srv.api('boss', '/api/admin/overview')).json.server.agentSigned, true)
})

// Public 공개 전 점검: /api/health says only that a server is up and which one (REQ-S-079).
test('/api/health is ok, version and instance only; how the server runs is for the operator', async () => {
  assert.deepEqual(Object.keys(await (await fetch(`${srv.origin}/api/health`)).json()).sort(), ['instance', 'ok', 'version'])
  const s = (await srv.api('boss', '/api/admin/overview')).json.server
  assert.equal(s.originSet, true)
  assert.equal(typeof s.root, 'boolean')
  assert.equal((await srv.api('alice', '/api/admin/overview')).status, 403)
})

// R9-L2 (리포트 #9): an unreadable agent-seq.json was taken for a first deploy; the max is written once the server is up.
test('an unreadable seq file is kept aside and said, and nothing is recorded before an update is sent', async () => {
  const s = await startServer({ seed: { 'agent-seq.json': 'not json' } })
  try {
    assert.match(s.log(), /agent-seq\.json\.broken/)
    assert.ok(fs.existsSync(path.join(s.data, 'agent-seq.json.broken')))
    await s.login('boss')
    assert.equal((await s.api('boss', '/api/admin/overview')).json.server.agentSigned, true)
    // R10-I1: recorded only when an update is first sent to a Mac, not on start.
    assert.equal(fs.existsSync(path.join(s.data, 'agent-seq.json')), false)
  } finally {
    await s.stop()
  }
})
