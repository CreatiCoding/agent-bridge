// REQ-S-090~095 (docs/TRUST-DESIGN.md): pairing, signed commands, replay, the command table, update floor.
// The device side is done with WebCrypto exactly as the page does (ui/src/lib/trust.ts), so both ends must agree.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Trust, TRUST_CLASS, TRUST_VERSION, TRUST_MIN_SEQ, classOf, rebuild, hashesHold, pairCommit, pairSas, sha256Hex, textMac, updateKeepsTrust, modeOf, BgTracker, b64u, unb64u, SKEW_MS, sealLine, sealOut, sealCard, sealPersonText, sealChosen } from '../../agent/trust.mjs'

const subtle = globalThis.crypto.subtle
const enc = new TextEncoder()
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trust-'))

async function device() {
  const sign = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const dh = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const spub = b64u(new Uint8Array(await subtle.exportKey('raw', sign.publicKey)))
  const dpub = b64u(new Uint8Array(await subtle.exportKey('raw', dh.publicKey)))
  return { sign, dh, spub, dpub }
}
/** The page's pairing (ui/src/lib/trust.ts pair()), with the terminal's confirmation in between. */
async function pair(t, dev, { typed } = {}) {
  const nb = b64u(rand(32))
  const r1 = t.pair1({ c: pairCommit(dev.spub, dev.dpub, nb) }, 'enforce')
  const { sas } = t.pair3({ pid: r1.pid, spub: dev.spub, dpub: dev.dpub, nb, name: '폰\u0007' })
  assert.equal(sas, pairSas(t.hostId, r1.apub, dev.spub, dev.dpub, r1.na, nb))
  fs.writeFileSync(t.p.confirm, JSON.stringify(typed === undefined ? { pid: r1.pid, sas } : { pid: r1.pid, sas: typed }))
  const r4 = t.pair4({ pid: r1.pid })
  if (r4.state !== 'ok') return { r4 }
  // Unwrap K as the page does: ECDH → HKDF → AES-GCM.
  const bits = await subtle.deriveBits({ name: 'ECDH', public: await subtle.importKey('raw', unb64u(r1.apub), { name: 'ECDH', namedCurve: 'P-256' }, false, []) }, dev.dh.privateKey, 256)
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  const wk = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: unb64u(r4.salt), info: enc.encode(`bt-wrap|${t.hostId}`) }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
  const w = unb64u(r4.keys.find((k) => k.kid === r4.kid).wrap)
  const k = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: w.subarray(0, 12), additionalData: enc.encode(`bt-wrap|${t.hostId}|${r4.kid}`) }, wk, w.subarray(12)))
  return { r4, k, sas }
}
let seq = 0
async function signed(t, dev, cmd, i, { ts = Date.now(), n = ++seq, h = t.hostId } = {}) {
  const { deviceIdOf } = await import('../../agent/trust.mjs')
  const p = JSON.stringify({ v: 1, h, d: deviceIdOf(dev.spub, dev.dpub), ts, n, t: cmd.t, i })
  const s = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, dev.sign.privateKey, enc.encode(p)))
  return { ...cmd, auth: { p, s: b64u(s) } }
}
const open = (dir) => {
  const t = new Trust({ stateDir: dir, hostId: 'host-a' })
  t.ensure()
  fs.writeFileSync(t.p.window, JSON.stringify({ until: Date.now() + 60_000 }))
  return t
}

test('every agent command is placed in TRUST_CLASS (a new one fails here until it is)', () => {
  const src = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('const commands = {'), src.indexOf('\n}\n', src.indexOf('const commands = {')))
  const names = [...body.matchAll(/^ {2}(?:async )?([a-zA-Z]+)\(\{?/gm)].map((m) => m[1])
  assert.ok(names.length > 50, `commands 를 읽지 못함 (${names.length})`)
  const missing = names.filter((n) => !(n in TRUST_CLASS))
  assert.deepEqual(missing, [], `TRUST_CLASS 에 없는 명령: ${missing.join(', ')}`)
  assert.equal(classOf({ t: 'nope' }), 'off', '모르는 명령은 끔')
  assert.equal(classOf({ t: 'disk', op: 'scan' }), 'free')
  assert.equal(classOf({ t: 'disk', op: 'trash' }).i.includes('paths'), true)
  assert.equal(classOf({ t: 'account', op: 'login' }), 'off')
  assert.equal(classOf({ t: 'trust', op: 'remove' }).always, true)
})

test('pairing: the page and the Mac agree, a wrong number pairs nothing, no window takes nothing', async () => {
  const dir = tmp()
  const t = open(dir)
  const dev = await device()
  const bad = await pair(t, dev, { typed: '000000' })
  assert.notEqual(bad.r4.state, 'ok')
  assert.equal(t.devices().length, 0)
  const good = await pair(t, dev)
  assert.equal(good.r4.state, 'ok')
  assert.equal(good.k.length, 32)
  assert.deepEqual(Buffer.from(good.k), t.keyOf(good.r4.kid), '기기가 푼 K 가 맥의 K 와 같음')
  assert.equal(t.devices()[0].name, '폰', '이름의 제어 문자는 지움')
  assert.equal(fs.existsSync(t.p.window), false, '짝지으면 창이 닫힘')
  assert.throws(() => t.pair1({ c: b64u(rand(32)) }, 'enforce'), /짝짓기 창/)
  fs.writeFileSync(t.p.window, JSON.stringify({ until: Date.now() + 60_000 }))
  assert.throws(() => t.pair1({ c: b64u(rand(32)) }, 'off'), /off/)
})

test('pairing: values that differ from the commitment are refused', async () => {
  const t = open(tmp())
  const dev = await device()
  const other = await device()
  const nb = b64u(rand(32))
  const r1 = t.pair1({ c: pairCommit(dev.spub, dev.dpub, nb) }, 'warn')
  assert.throws(() => t.pair3({ pid: r1.pid, spub: other.spub, dpub: other.dpub, nb, name: 'x' }), /약속/)
})

test('signed commands: right, wrong host, wrong command, unpaired, stale, replayed', async () => {
  const t = open(tmp())
  const dev = await device()
  await pair(t, dev)
  const ok = await signed(t, dev, { t: 'esc', sid: 's1' }, { sid: 's1' })
  assert.equal(t.verify(ok).ok, true)
  assert.match(t.verify(ok).why, /이미 쓴/, '같은 서명 두 번')
  assert.match(t.verify(await signed(t, dev, { t: 'esc' }, {}, { h: 'host-b' })).why, /다른 맥/)
  const x = await signed(t, dev, { t: 'esc' }, {})
  assert.match(t.verify({ ...x, t: 'close' }).why, /다른 명령/)
  assert.match(t.verify(await signed(t, await device(), { t: 'esc' }, {})).why, /짝짓지 않은/)
  assert.match(t.verify(await signed(t, dev, { t: 'esc' }, {}, { ts: Date.now() - SKEW_MS - 5000 })).why, /시각/)
  const y = await signed(t, dev, { t: 'esc' }, {})
  assert.match(t.verify({ ...y, auth: { ...y.auth, s: b64u(rand(64)) } }).why, /맞지 않음/)
  assert.match(t.verify({ t: 'esc' }).why, /서명 없음/)
  // An older number than one already taken and forgotten is still refused (the floor).
  const r = JSON.parse(fs.readFileSync(t.p.replay, 'utf8'))
  const id = Object.keys(r)[0]
  r[id].floor = 10_000
  fs.writeFileSync(t.p.replay, JSON.stringify(r))
  assert.match(t.verify(await signed(t, dev, { t: 'esc' }, {}, { n: 9_999 })).why, /이미 쓴/)
})

test('a command is rebuilt from what was signed: the server cannot add to it', () => {
  const rule = classOf({ t: 'new' })
  const out = rebuild({ t: 'new', reqId: 'r', sid: 'abc12345', prompt: 'p', cwd: '/evil', sysPrompt: 'do evil', mode: 'auto', autoPush: true }, rule, { cwd: '/good', mode: 'default', promptH: sha256Hex('p') })
  assert.deepEqual(out, { t: 'new', reqId: 'r', sid: 'abc12345', prompt: 'p', cwd: '/good', mode: 'default', promptH: sha256Hex('p') })
  const open_ = rebuild({ t: 'open', sid: 's', folder: { repos: [{ dir: '.', origin: 'x' }] }, transcript: 't', cwd: '/x' }, classOf({ t: 'open' }), { sid: 's' })
  assert.deepEqual(open_, { t: 'open', sid: 's' })
  const fork = rebuild({ t: 'fork', sid: 's', newSid: 'n', launch: { mode: 'auto' }, sysPrompt: 'x' }, classOf({ t: 'fork' }), { sid: 's' })
  assert.deepEqual(fork, { t: 'fork', sid: 's', newSid: 'n' })
})

test('text and pictures are bound by their hash', () => {
  const data = Buffer.from('png bytes').toString('base64')
  const sha1 = (b) => require_('crypto').createHash('sha1').update(b).digest('hex')
  const id = `${sha1(Buffer.from('png bytes'))}.png`
  const i = { sid: 's', textH: sha256Hex('hi'), imgs: [id] }
  assert.equal(hashesHold({ t: 'send', text: 'hi', files: [{ id, data }] }, i), true)
  assert.equal(hashesHold({ t: 'send', text: 'hi!', files: [{ id, data }] }, i), false, '글이 바뀜(훅이 고친 글)')
  assert.equal(hashesHold({ t: 'send', text: 'hi', files: [{ id, data: Buffer.from('other').toString('base64') }] }, i), false, '그림 바꿔치기')
  assert.equal(hashesHold({ t: 'send', text: 'hi', files: [] }, i), false)
})
const require_ = (m) => (m === 'crypto' ? globalThis.process.getBuiltinModule('node:crypto') : null)

test('sealing: a piece from the page opens, one from the Mac or another session does not', async () => {
  const t = open(tmp())
  const dev = await device()
  await pair(t, dev)
  const u = t.seal('hello', 'u', 's1')
  assert.equal(t.openText(`/compact ${u}`, 's1'), '/compact hello')
  assert.equal(t.openText(u, 's2'), null, '다른 세션')
  assert.equal(t.openText(t.seal('hello', 'm', 's1'), 's1'), null, '맥이 봉인한 것을 글로 받지 않음')
  const mid = u.length >> 1
  assert.equal(t.openText(`${u.slice(0, mid)}${u[mid] === 'A' ? 'B' : 'A'}${u.slice(mid + 1)}`, 's1'), null, '고친 조각')
})

test('removing a device makes a new key; the HMAC a correction names is under a kid', async () => {
  const t = open(tmp())
  const a = await device()
  const { r4 } = await pair(t, a)
  fs.writeFileSync(t.p.window, JSON.stringify({ until: Date.now() + 60_000 }))
  const b = await device()
  await pair(t, b)
  const before = r4.kid
  assert.equal(t.remove(t.devices()[0].id), true)
  const k = t.contentKeys()
  assert.notEqual(k.current, before)
  assert.ok(k.keys[before], '예전 키는 남김')
  assert.equal(textMac(t.keyOf(k.current), 'x'), textMac(t.keyOf(k.current), 'x'))
  assert.notEqual(textMac(t.keyOf(k.current), 'x'), textMac(t.keyOf(before), 'x'))
})

test('mode: none written with devices paired is enforce; updates must keep trust', () => {
  assert.equal(modeOf({}, 0), 'off')
  assert.equal(modeOf({}, 1), 'enforce')
  assert.equal(modeOf({ trust: 'weird' }, 1), 'enforce')
  assert.equal(modeOf({ trust: 'warn' }, 1), 'warn')
  const ok = { 'trust.mjs': `export const TRUST_VERSION = ${TRUST_VERSION}\n` }
  assert.equal(updateKeepsTrust(ok, TRUST_MIN_SEQ + 1, 0), null)
  assert.match(updateKeepsTrust({}, TRUST_MIN_SEQ + 1, 0), /trust\.mjs/)
  assert.match(updateKeepsTrust({ 'trust.mjs': 'export const TRUST_VERSION = 0' }, TRUST_MIN_SEQ + 1, 0), /trust 판/)
  assert.match(updateKeepsTrust(ok, TRUST_MIN_SEQ, 0), /순번/)
  assert.match(updateKeepsTrust(ok, TRUST_MIN_SEQ + 5, TRUST_MIN_SEQ + 9), /순번/)
})

test('background work is counted from the transcript, not told by the server', () => {
  const b = new BgTracker()
  b.line(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } }] } }))
  b.line(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Command running in background with ID: bash_1.' }] } }))
  assert.equal(b.running().length, 1)
  assert.equal(b.running()[0].label, 'npm run dev')
  b.line(JSON.stringify({ type: 'user', message: { content: '<task-notification><tool-use-id>tu1</tool-use-id><status>completed</status></task-notification>' } }))
  assert.equal(b.running().length, 0)
})

// ---------- 1.394: what leaves the Mac, sealed (REQ-S-095) ----------

/** The page's opening (ui/src/lib/trust.ts openPiece): AES-GCM under K, AAD bt1|host|kid. */
async function pageOpen(k, hostId, text) {
  const key = await subtle.importKey('raw', k, 'AES-GCM', false, ['decrypt'])
  let out = text
  for (const m of [...text.matchAll(/⟦bt1:([0-9a-f]{8}):([A-Za-z0-9_-]+)⟧/g)]) {
    const b = unb64u(m[2])
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12), additionalData: enc.encode(`bt1|${hostId}|${m[1]}`) }, key, b.subarray(12))
    out = out.replace(m[0], JSON.parse(new TextDecoder().decode(plain)).v)
  }
  return out
}

test('sealing is chosen at the terminal: off unless trustSeal is true, and only with a mode and a device', async () => {
  assert.equal(sealChosen({}), false)
  assert.equal(sealChosen({ trustSeal: 'yes' }), false)
  assert.equal(sealChosen({ trustSeal: true }), true)
  const t = open(tmp())
  assert.equal(t.info('enforce', true).seal, false, '기기 없음')
  await pair(t, await device())
  assert.equal(t.info('enforce', true).seal, true)
  assert.equal(t.info('off', true).seal, false, '모드 off')
  assert.equal(t.info('enforce', false).seal, false, '고르지 않음')
})

test('a transcript line: words sealed, structure and pictures plain, the echo marked; the page opens it back', async () => {
  const t = open(tmp())
  const { k } = await pair(t, await device())
  const seal = t.sealer()
  const answer = JSON.stringify({ type: 'assistant', uuid: 'u1', sessionId: 's1', timestamp: 'T', message: { role: 'assistant', model: 'claude-x', id: 'm1', type: 'message', content: [{ type: 'text', text: '비밀 답' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat secret.txt', run_in_background: true } }] } })
  const out = JSON.parse(sealLine(answer, seal))
  assert.equal(out.type, 'assistant')
  assert.equal(out.message.model, 'claude-x')
  assert.equal(out.message.content[1].name, 'Bash')
  assert.equal(out.message.content[1].input.run_in_background, true)
  assert.doesNotMatch(JSON.stringify(out), /비밀 답|secret\.txt/)
  assert.equal(await pageOpen(k, 'host-a', out.message.content[0].text), '비밀 답')
  assert.equal(await pageOpen(k, 'host-a', out.message.content[1].input.command), 'cat secret.txt')
  // A person's line: the server's tags stay, the words go sealed; the line that is what the page said is marked.
  const said = JSON.stringify({ type: 'user', uuid: 'u2', message: { role: 'user', content: '<system-reminder>몰래</system-reminder>\n내가 쓴 글\n[Image #1]' } })
  const o2 = JSON.parse(sealLine(said, seal, (x) => x.includes('내가 쓴 글')))
  assert.equal(o2.bridgeEcho, true)
  assert.match(o2.message.content, /^<system-reminder>⟦bt1:[^⟧]+⟧<\/system-reminder>\n?⟦bt1:[^⟧]+⟧\[Image #1\]$/)
  assert.equal(await pageOpen(k, 'host-a', o2.message.content), '<system-reminder>몰래</system-reminder>\n내가 쓴 글\n[Image #1]')
  assert.equal(JSON.parse(sealLine(said, seal, () => false)).bridgeEcho, undefined)
  // Pictures stay plain (R5): the server asks the Mac for them by their bytes.
  const pic = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0' } }] } })
  assert.equal(JSON.parse(sealLine(pic, seal)).message.content[0].source.data, 'iVBORw0')
  // What the bridge typed keeps its start: the server tells it from what the person said.
  assert.match(sealPersonText('[정정] 방금 보낸 글', seal), /^\[정정\] ⟦bt1:/)
})

test('messages: words sealed field by field, a card as one piece holding its id', async () => {
  const t = open(tmp())
  const { k } = await pair(t, await device())
  const seal = t.sealer()
  const sc = sealOut({ t: 'screen', sid: 's1', reqId: 'r', text: '터미널 화면' }, seal)
  assert.equal(sc.reqId, 'r')
  assert.equal(await pageOpen(k, 'host-a', sc.text), '터미널 화면')
  const st = sealOut({ t: 'status', sid: 's1', phase: 'busy', held: [{ id: 'h1', text: '붙잡은 글' }], tool: { name: 'Bash', title: 'rm -rf x' } }, seal)
  assert.equal(st.phase, 'busy')
  assert.equal(st.held[0].id, 'h1')
  assert.doesNotMatch(JSON.stringify(st), /붙잡은 글|rm -rf/)
  const card = { id: 'c1', kind: 'permission', open: true, at: 1, title: 'Bash 실행?', context: 'rm -rf /', options: [{ n: 1, label: '예' }, { n: 2, label: '아니오' }] }
  const c = sealOut({ t: 'card', sid: 's1', card }, seal).card
  assert.deepEqual(c.options, [{ n: 1, label: '🔒' }, { n: 2, label: '🔒' }])
  assert.equal(c.id, 'c1')
  assert.equal(c.title, '🔒')
  assert.doesNotMatch(JSON.stringify(c), /rm -rf|Bash 실행/)
  const w = JSON.parse(await pageOpen(k, 'host-a', c.sealed))
  assert.equal(w.id, 'c1', '덩어리 안의 id: 다른 카드로 옮기면 화면이 버튼을 그리지 않음')
  assert.equal(w.options[1].label, '아니오')
  assert.deepEqual(sealCard({ id: 'c2', open: false, result: '허용' }, seal), { id: 'c2', open: false, result: '허용' }, '닫힘 알림은 그대로')
  const hello = { t: 'hello', hostId: 'host-a' }
  assert.deepEqual(sealOut(hello, seal), hello, '메타데이터는 평문')
})

test('the conversation list binds id, folder and title in one sealed piece (1.412, AC-1594)', async () => {
  const t = open(tmp())
  const { k } = await pair(t, await device())
  const seal = t.sealer()
  const conv = '2036d65e-db17-4844-b869-87abb5082a1a'
  const r = sealOut({ t: 'recent', reqId: 'r', ok: true, home: '/Users/u', conversations: [{ conv, cwd: '/Users/u/p', title: '배포 고치기', first: '첫 글', last: '끝 글', mtime: 1, size: 2, active: false, exists: true }] }, seal)
  const c = r.conversations[0]
  assert.equal(c.conv, conv, '목록의 칸은 그대로(서버가 읽는 값)')
  assert.doesNotMatch(JSON.stringify(r), /배포 고치기|첫 글|끝 글/)
  assert.deepEqual(JSON.parse(await pageOpen(k, 'host-a', c.bound)), { conv, cwd: '/Users/u/p', title: '배포 고치기', first: '첫 글' })
})

test('agent adopt refuses a server sid that is a path or already open while trust is on (1.412, AC-1593)', () => {
  const src = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('  async adopt({'), src.indexOf('  async account({'))
  const first = body.slice(0, body.indexOf('conv))) throw'))
  assert.match(first, /trustOn\(\) && \(!safeConvId\(sid\) \|\| sessions\.has\(sid\)\)/, '첫 검사, new·open 과 같음')
  assert.ok(TRUST_VERSION >= 6, '고친 판보다 낮은 trust 로 내려가지 않게')
})

test('adopt is signed by its conversation and folder; what the server adds is dropped (AC-1586)', () => {
  const rule = classOf({ t: 'adopt' })
  assert.deepEqual(rule.i, ['conv', 'cwd'])
  assert.deepEqual(rule.keep, ['sid'])
  const cmd = { t: 'adopt', reqId: 'r1', sid: 's1', conv: 'server-conv', cwd: '/server', sysPrompt: 'evil', routing: { x: 1 }, autoPush: true }
  assert.deepEqual(rebuild(cmd, rule, { conv: 'c', cwd: '~/p' }), { t: 'adopt', reqId: 'r1', sid: 's1', conv: 'c', cwd: '~/p' })
})

test('agent adopt checks the signed folder and a live claude in every account folder (AC-1586)', () => {
  const src = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('  async adopt({'), src.indexOf('  async account({'))
  assert.match(body, /\bsigned\b[\s\S]*conversationInfo\(file[\s\S]*realpathSync/, '서명된 가져오기는 기록의 cwd 와 맞춰 봄')
  assert.match(body, /convLive\(dir, conv\)/)
  assert.doesNotMatch(body, /isLinked\(account\) && \(convLive/, '연결한 폴더만이 아니라 모든 폴더에서 검사')
})
