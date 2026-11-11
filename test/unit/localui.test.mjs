// The local screen (REQ-F-843~845, REQ-S-096~098, docs/LOCAL-UI-DESIGN.md): its signed bundles, staged → installed,
// never back to an older one, rolled back to the builtin when it breaks, and the one-time tickets and tokens.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { LocalUi, makeBundle, parseBundle, docOf, signDoc, docSigned, verify, localUiOf, hostOk, originOk, SIG_PREFIX, BOOT_MS, FILE_HEADERS, LOCALUI_API, localFiles, pictureExt, fileName, LOCAL_FILES_MAX, LOCAL_FILE_MAX, LOCAL_SEND_MAX, LOCAL_BODY_MAX } from '../../agent/localui.mjs'
import { DOC, SIG, BUNDLE } from '../../agent/localbundle.mjs'
import { localBundleText } from '../../scripts/sign-agent.mjs'
import { manifestOf } from '../../agent/guard.mjs'
import { TRUST_CLASS } from '../../agent/trust.mjs'
import { bridgeSelfCall, riskyCall } from '../../agent/guard.mjs'

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const KEYS = [publicKey.export({ type: 'spki', format: 'der' }).toString('base64')]
const page = (n) => makeBundle({ 'index.html': `<!doctype html><p>${n}</p>`, 'app.js': `console.log(${JSON.stringify(n)})` })
const signed = (bundle, seq, key = privateKey) => {
  const doc = docOf(bundle, seq)
  return { doc, sig: signDoc(doc, key), bundle }
}
const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cb-localui-'))
const make = (opts = {}) => {
  let t = 1_000_000
  const ui = new LocalUi({ dir: dirOf(), builtin: signed(page('builtin'), 100), keys: KEYS, now: () => t, ...opts })
  ui.clock = (ms) => (t += ms)
  return ui
}
const text = (ui) => ui.active().files.get('index.html').body.toString()

test('agent/localbundle.mjs is agent/localui/ as it is, signed with a trusted key (run node scripts/sign-agent.mjs)', () => {
  assert.equal(BUNDLE, localBundleText(), 'agent/localui/ 를 고친 뒤 node scripts/sign-agent.mjs 로 다시 서명하세요')
  const r = verify({ doc: DOC, sig: SIG, bundle: BUNDLE })
  assert.ok(r.ok, r.why)
  assert.ok(r.files.has('index.html') && r.files.has('app.js'))
})

test('a signature is over the exact document bytes, and does not read as an agent-update signature or the other way', () => {
  const b = signed(page('a'), 5)
  assert.ok(docSigned(b.doc, b.sig, KEYS))
  assert.equal(docSigned(b.doc.replace('"seq":5', '"seq":6'), b.sig, KEYS), false)
  assert.equal(docSigned(` ${b.doc}`, b.sig, KEYS), false)
  const stranger = crypto.generateKeyPairSync('ed25519').privateKey
  assert.equal(docSigned(b.doc, signDoc(b.doc, stranger), KEYS), false, '믿지 않는 키')
  // Domain separation: the agent manifest's own prefix differs, so one signature cannot pass as the other.
  const m = manifestOf({ 'agent.mjs': 'x' }, 5)
  assert.ok(!m.startsWith(SIG_PREFIX) && !SIG_PREFIX.startsWith('claude-bridge-agent'))
  assert.equal(docSigned(m.slice(SIG_PREFIX.length), crypto.sign(null, Buffer.from(m), privateKey).toString('base64'), KEYS), m.startsWith(SIG_PREFIX))
})

test('verify: the bundle must be the one the document names, and a bundle of files it serves', () => {
  const b = signed(page('a'), 5)
  assert.ok(verify(b, { keys: KEYS }).ok)
  assert.match(verify({ ...b, bundle: page('b') }, { keys: KEYS }).why, /해시/)
  assert.match(verify({ ...b, sig: '' }, { keys: KEYS }).why, /서명/)
  assert.match(verify(signed(page('a'), 5), { keys: KEYS, api: LOCALUI_API + 1 }).why, /api/)
  const evil = JSON.stringify({ format: 'cb-bundle', v: 1, name: 'localui', api: LOCALUI_API, files: { '../x.html': { type: 'text/html; charset=utf-8', data: '' } } })
  assert.match(verify(signed(evil, 5), { keys: KEYS }).why, /올바르지/)
  const noIndex = makeBundle({ 'app.js': 'x' })
  assert.match(verify(signed(noIndex, 5), { keys: KEYS }).why, /index\.html/)
  const wrongType = JSON.stringify({ format: 'cb-bundle', v: 1, name: 'localui', api: LOCALUI_API, files: { 'index.html': { type: 'text/javascript; charset=utf-8', data: '' } } })
  assert.ok(parseBundle(wrongType) instanceof Error)
  assert.throws(() => makeBundle({ 'a/b.js': 'x' }))
})

test('the builtin is served from the start; a newer signed remote bundle is staged, checked again and put in place', () => {
  const ui = make()
  assert.equal(ui.active().source, 'builtin')
  assert.match(text(ui), /builtin/)
  const r = ui.offer(signed(page('v2'), 200))
  assert.equal(r.result, 'installed')
  const a = ui.active()
  assert.equal(a.source, 'remote')
  assert.equal(a.seq, 200)
  assert.match(text(ui), /v2/)
  const m = ui.manifest()
  assert.equal(m.current, a.version)
  assert.equal(m.staged, null)
  assert.equal(m.floor, 200)
  assert.equal(fs.statSync(ui.fileOf(a.version)).mode & 0o777, 0o600)
  assert.equal(ui.offer(signed(page('v2'), 200)).result, 'same')
})

test('never back: a bundle signed before what this Mac has or ships, an unsigned one, or one by another key is refused', () => {
  const ui = make()
  assert.equal(ui.offer(signed(page('old'), 50)).result, 'old', 'builtin 보다 오래됨')
  assert.equal(ui.offer(signed(page('v3'), 300)).result, 'installed')
  assert.equal(ui.offer(signed(page('v2'), 200)).result, 'old', '지금 것보다 오래됨')
  const stranger = crypto.generateKeyPairSync('ed25519').privateKey
  assert.equal(ui.offer(signed(page('v4'), 400, stranger)).result, 'verify_failed')
  assert.equal(ui.offer({ ...signed(page('v4'), 400), bundle: page('other') }).result, 'verify_failed')
  assert.match(text(ui), /v3/)
})

test('a remote bundle changed on disk fails its check when it loads: back to the builtin, and it is not taken again', () => {
  const ui = make()
  const v2 = signed(page('v2'), 200)
  ui.offer(v2)
  const ver = ui.active().version
  fs.writeFileSync(ui.fileOf(ver), page('tampered'))
  ui.loaded = null
  assert.equal(ui.active().source, 'builtin')
  assert.ok(ui.manifest().bad.includes(ver))
  assert.equal(ui.offer(v2).result, 'bad')
})

test('a page that never says it came up is rolled back to the builtin (not to an older remote one) after BOOT_MS', () => {
  const ui = make()
  ui.offer(signed(page('v2'), 200))
  ui.offer(signed(page('v3'), 300))
  const v3 = ui.active()
  assert.equal(v3.seq, 300)
  ui.served(v3)
  ui.clock(BOOT_MS - 1)
  ui.tick()
  assert.equal(ui.active().seq, 300)
  ui.clock(2)
  ui.tick()
  assert.equal(ui.active().source, 'builtin', '자동 롤백은 builtin 으로만')
  // And the same bundle is not put back by the server sending it again (its seq is at the floor).
  assert.equal(ui.offer(signed(page('v3'), 300)).result, 'old')
})

test('a page that came up keeps its bundle; booted is only for the bundle on trial', () => {
  const ui = make()
  ui.offer(signed(page('v2'), 200))
  const a = ui.active()
  ui.served(a)
  assert.equal(ui.booted('nope'), false)
  assert.equal(ui.booted(a.version), true)
  ui.clock(BOOT_MS * 2)
  ui.tick()
  assert.equal(ui.active().source, 'remote')
  assert.equal(ui.booted(a.version), false, '이미 확인됨')
})

test('local rollback at the terminal goes to the previous remote bundle when it is newer than the builtin', () => {
  const ui = make()
  ui.offer(signed(page('v2'), 200))
  ui.offer(signed(page('v3'), 300))
  assert.equal(ui.rollback('test', { manual: true }).to, ui.active().version)
  assert.match(text(ui), /v2/)
  assert.equal(ui.rollback('test', { manual: true }).to, 'builtin')
  assert.equal(ui.active().source, 'builtin')
  assert.equal(ui.rollback('test', { manual: true }).result, 'previous_bundle_not_exists')
})

test('an agent update that brings a newer builtin retires an older remote bundle', () => {
  const dir = dirOf()
  const a = new LocalUi({ dir, builtin: signed(page('b1'), 100), keys: KEYS })
  a.offer(signed(page('r2'), 200))
  assert.equal(a.active().source, 'remote')
  const b = new LocalUi({ dir, builtin: signed(page('b3'), 300), keys: KEYS })
  assert.equal(b.active().source, 'builtin')
  assert.match(b.active().files.get('index.html').body.toString(), /b3/)
})

test('an unsigned builtin is not served at all', () => {
  const ui = new LocalUi({ dir: dirOf(), builtin: { ...signed(page('x'), 1), sig: 'AAAA' }, keys: KEYS, log: () => {} })
  assert.equal(ui.active(), null)
})

test('a ticket opens one sign-in, once, within five minutes; a token lasts its hours', () => {
  const ui = make()
  const t = ui.newTicket()
  assert.match(t, /^[A-Za-z0-9_-]{43}$/)
  assert.ok(!fs.readFileSync(ui.ticketsPath, 'utf8').includes(t), '입장권은 해시로만')
  assert.equal(ui.takeTicket(t), true)
  assert.equal(ui.takeTicket(t), false, '한 번만')
  const late = ui.newTicket()
  ui.clock(5 * 60_000 + 1)
  assert.equal(ui.takeTicket(late), false, '5분 뒤')
  assert.equal(ui.takeTicket('x'), false)
  const { token, exp } = ui.issue(12)
  assert.equal(exp - ui.now(), 12 * 3600_000)
  assert.ok(ui.tokenOk(token))
  assert.ok(!ui.tokenOk(token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))))
  ui.clock(12 * 3600_000 + 1)
  assert.ok(!ui.tokenOk(token), '만료')
  const t2 = ui.issue(1).token
  ui.drop(t2)
  assert.ok(!ui.tokenOk(t2), '로그아웃')
  const t3 = ui.issue(1).token
  ui.dropAll()
  assert.ok(!ui.tokenOk(t3), 'local off')
})

test('requests: this Mac\'s own loopback address and port only, and a page of its own origin', () => {
  assert.ok(hostOk('127.0.0.1:4317', 4317) && hostOk('localhost:4317', 4317))
  for (const h of ['evil.example:4317', '127.0.0.1:4318', '127.0.0.1', undefined, '0.0.0.0:4317']) assert.ok(!hostOk(h, 4317), String(h))
  assert.ok(originOk(undefined, 4317) && originOk('http://127.0.0.1:4317', 4317))
  for (const o of ['null', 'https://bridge.example', 'http://127.0.0.1:3000', 'http://evil.example:4317']) assert.ok(!originOk(o, 4317), o)
  assert.match(FILE_HEADERS['Content-Security-Policy'], /script-src 'self'/)
  assert.match(FILE_HEADERS['Content-Security-Policy'], /frame-ancestors 'none'/)
})

test('agent.json localUi: on and taking remote bundles unless turned off, 12-hour sign-ins', () => {
  assert.deepEqual(localUiOf({}), { on: true, ota: true, sessionHours: 12 })
  assert.deepEqual(localUiOf({ localUi: { on: false, ota: false, sessionHours: 1000 } }), { on: false, ota: false, sessionHours: 168 })
})

test('the bundle command is placed in the trust table, checked by its own signature like update', () => {
  assert.equal(TRUST_CLASS.localui, 'free')
})

test('a session asks before touching the Mac-terminal-only files or commands, even under allowAll', () => {
  const bash = (command) => ({ name: 'Bash', input: { command } })
  assert.ok(bridgeSelfCall(bash('node ~/.claude-bridge/agent.mjs local open --no-open')))
  assert.ok(bridgeSelfCall(bash('cat ~/.claude-bridge/localui/tickets.json')))
  assert.ok(bridgeSelfCall(bash('node ~/.claude-bridge/agent.mjs trust mode off')))
  assert.ok(bridgeSelfCall({ name: 'Write', input: { file_path: '/Users/me/.claude-bridge/trust/confirm.json' } }))
  assert.ok(riskyCall(bash('node agent.mjs local')))
  assert.equal(bridgeSelfCall(bash('node agent.mjs doctor')), null)
  assert.equal(bridgeSelfCall(bash('echo local')), null)
})

// REQ-F-898 (1.517): the local screen starts sessions, closes them, sends files and shows the conversation.
test('api 2: a bundle made for the page of 1.516 (api 1) is not served by this agent', () => {
  assert.equal(LOCALUI_API, 2)
  const old = makeBundle({ 'index.html': '<p>old</p>' }, 1)
  assert.match(String(parseBundle(old)), /다른 api 의 묶음\(1\)/)
  const doc = docOf(old, 500, 1)
  assert.equal(verify({ doc, sig: signDoc(doc, privateKey), bundle: old }, { keys: KEYS }).ok, false)
  assert.equal(JSON.parse(DOC).api, LOCALUI_API, 'localbundle.mjs 를 다시 서명하세요(node scripts/sign-agent.mjs)')
})

test('files with a message: a picture is told by its bytes, other files keep a plain name, and the limits hold', () => {
  const png = Buffer.from('89504e470d0a1a0a0000', 'hex')
  const jpg = Buffer.from('ffd8ffe000104a464946', 'hex')
  const gif = Buffer.from('GIF89a....', 'latin1')
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])
  assert.deepEqual([png, jpg, gif, webp].map(pictureExt), ['png', 'jpg', 'gif', 'webp'])
  // A name or type that says picture does not make one.
  assert.equal(pictureExt(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), '')
  const b64 = (b) => Buffer.from(b).toString('base64')
  const r = localFiles([{ name: 'shot.png', data: b64(png) }, { name: '../../etc/passwd', data: b64('x') }, { name: '.env', data: b64('A=1') }, { name: '보고서 (1).pdf', data: b64('%PDF') }])
  assert.equal(r.error, undefined)
  assert.deepEqual(r.files.map((f) => [f.picture, f.name]), [['png', 'shot.png'], ['', 'passwd'], ['', 'env'], ['', '보고서 _1_.pdf']])
  assert.equal(fileName(''), 'file')
  assert.equal(fileName('a/b\\c.txt'), 'c.txt')
  assert.equal(fileName('x'.repeat(300)).length, 120)
  assert.deepEqual(localFiles(undefined), { files: [] })
  assert.match(localFiles('x').error, /목록/)
  assert.match(localFiles(Array(LOCAL_FILES_MAX + 1).fill({ name: 'a', data: b64('a') })).error, /4개까지/)
  assert.match(localFiles([{ name: 'a', data: '***' }]).error, /올바르지/)
  assert.match(localFiles([{ name: 'a', data: '' }]).error, /빈 파일/)
  assert.equal(localFiles([{ name: 'a', data: b64(Buffer.alloc(LOCAL_FILE_MAX)) }]).error, undefined)
  assert.match(localFiles([{ name: 'a', data: b64(Buffer.alloc(LOCAL_FILE_MAX + 1)) }]).error, /8 MB/)
  // Four files at the limit fit in a send's body as base64 (and JSON around them); every other request stays small.
  assert.ok(Math.ceil((LOCAL_FILE_MAX * LOCAL_FILES_MAX) / 3) * 4 + 64 * 1024 < LOCAL_SEND_MAX)
  assert.equal(LOCAL_BODY_MAX, 64 * 1024)
})
