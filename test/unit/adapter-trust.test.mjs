// 로컬 어댑터 서명·봉인 (REQ-S-101, AC-1708·AC-1709): a call reaches an adapter on a Mac in trust enforce only as a
// paired device signed it — extension, session, action, read or write, request id and the hash of its input — and
// its outcome leaves sealed in one piece bound to that call. The server cannot change, move or replay a call, and a
// write never runs twice (again, after a restart, after status said it never came).
// The device side is WebCrypto as the page does it (ui/src/lib/trust.ts sign, adapterSigned).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Trust, classOf, rebuild, hashesHold, pairCommit, sha256Hex, b64u, deviceIdOf, sealWith, openWith, sealOut } from '../../agent/trust.mjs'
import { Adapters, adapterInput, CLOSED_MS } from '../../agent/adapters.mjs'

const subtle = globalThis.crypto.subtle
const enc = new TextEncoder()
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))

async function device() {
  const sign = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const dh = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  return { sign, spub: b64u(new Uint8Array(await subtle.exportKey('raw', sign.publicKey))), dpub: b64u(new Uint8Array(await subtle.exportKey('raw', dh.publicKey))) }
}
function pairIn(t, dev) {
  fs.writeFileSync(t.p.window, JSON.stringify({ until: Date.now() + 60_000 }))
  const nb = b64u(rand(32))
  const r1 = t.pair1({ c: pairCommit(dev.spub, dev.dpub, nb) }, 'enforce')
  const { sas } = t.pair3({ pid: r1.pid, spub: dev.spub, dpub: dev.dpub, nb, name: '폰' })
  fs.writeFileSync(t.p.confirm, JSON.stringify({ pid: r1.pid, sas }))
  assert.equal(t.pair4({ pid: r1.pid }).state, 'ok')
}
let seq = 0
async function signWith(dev, p) {
  const s = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, dev.sign.privateKey, enc.encode(p)))
  return { p, s: b64u(s) }
}

/** What the page sends for one call (adapterSigned): inputJ sealed for the session, the signature over it all. */
async function pageCall(t, dev, c, { h = t.hostId, sealFor = c.sid } = {}) {
  const k = t.contentKeys()
  const inputJ = sealWith(t.keyOf(k.current), k.current, t.hostId, JSON.stringify(c.input ?? null), 'u', sealFor)
  const i = { op: 'call', ext: c.ext, sid: c.sid, action: c.action, access: c.access, requestId: c.requestId, inputH: sha256Hex(inputJ) }
  const p = JSON.stringify({ v: 1, h, d: deviceIdOf(dev.spub, dev.dpub), ts: Date.now(), n: ++seq, t: 'adapter', i })
  // What the server makes of it (ext_adapter.go): op call, the fields again, inputJ as it came, the auth attached.
  return { t: 'adapter', op: 'call', reqId: 'r1', ext: c.ext, sid: c.sid, action: c.action, access: c.access, requestId: c.requestId, inputJ, auth: await signWith(dev, p) }
}

/** agent.mjs trustGate in enforce, from the same pieces: the command to run, or {refused}. */
function gate(t, cmd) {
  const rule = classOf(cmd)
  if (rule === 'free') return cmd
  if (rule === 'off') return { refused: '이 모드에서 쓸 수 없는 동작' }
  let v = t.verify(cmd)
  if (v.ok && !hashesHold(cmd, v.i)) v = { ok: false, why: '서명한 글·그림과 다름' }
  if (!v.ok) return { refused: v.why }
  return { ...rebuild(cmd, rule, v.i), signed: v.dev.id }
}
/** agent.mjs adapter(): the input from inputJ (opened for the signed session), then the run. */
async function run(t, a, cmd) {
  const got = adapterInput(cmd, (x) => {
    const o = t.openText(x, cmd.sid)
    if (o === null) throw new Error('봉인된 글을 열지 못했어요')
    return o
  })
  if (got.error) return { state: 'refused', code: 'bad-input', error: got.error }
  return a.call({ ext: cmd.ext, action: cmd.action, access: cmd.access, input: got.input, requestId: cmd.requestId, sid: cmd.sid })
}

const SCRIPT = `import fs from 'node:fs'
const req = JSON.parse(fs.readFileSync(0, 'utf8'))
fs.appendFileSync('runs.txt', req.requestId + ' ' + JSON.stringify(req.input) + '\\n')
if (req.input?.fail) { process.stderr.write('token xoxb-secret refused\\n'); process.exit(2) }
process.stdout.write(JSON.stringify({ posted: req.input, session: req.session.id }))
`
function mac() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-adapter-trust-'))
  const d = path.join(dir, 'adapters', 'slack')
  fs.mkdirSync(d, { recursive: true })
  fs.chmodSync(path.join(dir, 'adapters'), 0o755)
  fs.chmodSync(d, 0o755)
  fs.writeFileSync(path.join(d, 'adapter.json'), JSON.stringify({ ext: 'slack', command: [process.execPath, 'a.mjs'], actions: { 'thread.read': 'read', 'thread.reply': 'write' } }), { mode: 0o644 })
  fs.writeFileSync(path.join(d, 'a.mjs'), SCRIPT, { mode: 0o644 })
  const t = new Trust({ stateDir: dir, hostId: 'host-a' })
  t.ensure()
  return { dir, t, runs: () => (fs.existsSync(path.join(d, 'runs.txt')) ? fs.readFileSync(path.join(d, 'runs.txt'), 'utf8').split('\n').filter(Boolean) : []) }
}
const W = { ext: 'slack', sid: 's1', action: 'thread.reply', access: 'write', input: { text: '배포 완료' } }

test('AC-1708 a signed call runs as signed; a wrong signature, changed input, another session or Mac is refused', async () => {
  const { dir, t, runs } = mac()
  const dev = await device()
  pairIn(t, dev)
  const a = new Adapters({ stateDir: dir })
  assert.equal(classOf({ t: 'adapter', op: 'list' }), 'free')
  assert.equal(classOf({ t: 'adapter', op: 'status' }), 'free')
  assert.equal(classOf({ t: 'adapter' }), 'off', 'op 없는 실행은 enforce 에서 거절')

  // 정상 서명: what the server added (a plain input, another session, read instead of write) is dropped.
  const cmd = await pageCall(t, dev, { ...W, requestId: 'req-good-0001' })
  const out = gate(t, { ...cmd, input: { text: '서버가 바꾼 글' }, sid: 's9', access: 'read', action: 'thread.read', requestId: 'req-other-001' })
  assert.equal(out.refused, undefined, out.refused)
  assert.equal(out.input, undefined, '서버의 평문 input 은 버림')
  assert.deepEqual([out.sid, out.action, out.access, out.requestId, out.ext], ['s1', 'thread.reply', 'write', 'req-good-0001', 'slack'])
  const r = await run(t, a, out)
  assert.equal(r.state, 'done')
  assert.deepEqual(r.result, { posted: { text: '배포 완료' }, session: 's1' })

  // 잘못된 서명
  const bad = await pageCall(t, dev, { ...W, requestId: 'req-bad-00001' })
  bad.auth = { ...bad.auth, s: b64u(rand(64)) }
  assert.equal(gate(t, bad).refused, '서명이 맞지 않음')
  // 입력 변조: another input (even one sealed with the right key) does not match the signed hash.
  const k = t.contentKeys()
  const tampered = await pageCall(t, dev, { ...W, requestId: 'req-tamper-01' })
  tampered.inputJ = sealWith(t.keyOf(k.current), k.current, t.hostId, JSON.stringify({ text: '다른 글' }), 'u', 's1')
  assert.equal(gate(t, tampered).refused, '서명한 글·그림과 다름')
  const plain = await pageCall(t, dev, { ...W, requestId: 'req-tamper-02' })
  plain.inputJ = JSON.stringify({ text: '배포 완료' })
  assert.equal(gate(t, plain).refused, '서명한 글·그림과 다름', '같은 내용의 평문으로 바꿔도 거절')
  // 다른 기기(맥) 대상
  assert.equal(gate(t, await pageCall(t, dev, { ...W, requestId: 'req-host-b-01' }, { h: 'host-b' })).refused, '다른 맥의 서명')
  // 다른 세션: input sealed for s2 under a signature for s1 does not open for s1.
  const moved = gate(t, await pageCall(t, dev, { ...W, requestId: 'req-moved-001' }, { sealFor: 's2' }))
  assert.equal(moved.refused, undefined)
  const mr = await run(t, a, moved)
  assert.equal(mr.state, 'refused')
  assert.equal(mr.code, 'bad-input')
  // 다른 명령의 서명
  const other = await pageCall(t, dev, { ...W, requestId: 'req-op-00001' })
  assert.equal(gate(t, { ...other, t: 'send', text: 'x' }).refused, '다른 명령의 서명', '어댑터 서명을 다른 명령에 못 씀')
  assert.equal(runs().length, 1, '실행은 정상 서명 한 번뿐')
})

test('AC-1709 replay, restart and status: a write never runs twice; none closes the id', async () => {
  const { dir, t, runs } = mac()
  const dev = await device()
  pairIn(t, dev)
  let a = new Adapters({ stateDir: dir })
  const cmd = await pageCall(t, dev, { ...W, requestId: 'req-once-0001' })
  const first = await run(t, a, gate(t, cmd))
  assert.equal(first.state, 'done')
  // 재전송: the same signature again, now and after the agent started again (replay.json, adapters-journal.json).
  assert.equal(gate(t, cmd).refused, '이미 쓴 서명')
  const t2 = new Trust({ stateDir: dir, hostId: 'host-a' })
  assert.equal(gate(t2, cmd).refused, '이미 쓴 서명', '재시작해도 같은 서명은 거절')
  // A new signature for the same request id (the person asked again): answered from the journal, not run.
  a = new Adapters({ stateDir: dir })
  const again = await run(t2, a, gate(t2, await pageCall(t2, dev, { ...W, requestId: 'req-once-0001' })))
  assert.equal(again.state, 'done')
  assert.equal(again.replayed, true)
  assert.equal(runs().length, 1)

  // Stopped halfway (the agent died while it ran): unknown, never run again.
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'adapters-journal.json'), 'utf8'))
  j['slack|req-cut-00001'] = { ext: 'slack', action: 'thread.reply', access: 'write', state: 'running', at: Date.now(), boot: 'old' }
  fs.writeFileSync(path.join(dir, 'adapters-journal.json'), JSON.stringify(j))
  a = new Adapters({ stateDir: dir })
  assert.equal(a.status('slack', 'req-cut-00001').state, 'unknown')
  const cut = await run(t2, a, gate(t2, await pageCall(t2, dev, { ...W, requestId: 'req-cut-00001' })))
  assert.equal(cut.state, 'unknown')
  assert.equal(runs().length, 1)

  // status none closes the id: a call the server held back is refused when it comes, even after a restart.
  const held = await pageCall(t2, dev, { ...W, requestId: 'req-held-0001' })
  const st = a.status('slack', 'req-held-0001')
  assert.equal(st.state, 'none')
  assert.ok(Number.isFinite(st.at))
  a = new Adapters({ stateDir: dir })
  const late = await run(t2, a, gate(t2, held))
  assert.equal(late.state, 'refused')
  assert.equal(late.code, 'request-closed')
  assert.equal(a.status('slack', 'req-held-0001').state, 'none')
  assert.equal(runs().length, 1)

  // Closed ids never push out what ran, and are forgotten after CLOSED_MS.
  for (let n = 0; n < 600; n++) a.status('slack', `req-spam-${String(n).padStart(5, '0')}`)
  assert.equal(new Adapters({ stateDir: dir }).status('slack', 'req-once-0001').state, 'done', '닫힌 id 가 실행 기록을 밀어내지 않음')
  let now = Date.now()
  const b = new Adapters({ stateDir: dir, now: () => now })
  now += CLOSED_MS + 1000
  b.save()
  assert.equal(Object.values(b.journal).filter((e) => e.state === 'closed').length, 0)
})

test('AC-1709 what leaves the Mac is sealed: result, error and stderr in one piece bound to the call', async () => {
  const { dir, t } = mac()
  const dev = await device()
  pairIn(t, dev)
  const a = new Adapters({ stateDir: dir })
  const seal = t.sealer()
  const opened = (m) => {
    const o = openWith((kid) => t.keyOf(kid), t.hostId, m.sealed)
    assert.equal(o.d, 'm')
    return JSON.parse(o.v)
  }
  const tag = { t: 'adapter', reqId: 'r1', ext: 'slack', sid: 's1' }
  // call: done
  const r = await run(t, a, gate(t, await pageCall(t, dev, { ...W, requestId: 'req-seal-0001' })))
  const m = sealOut({ ...tag, requestId: 'req-seal-0001', ok: true, ...r }, seal)
  assert.equal(m.result, undefined, '평문 결과 없음')
  assert.ok(!JSON.stringify(m).includes('배포 완료'))
  assert.deepEqual(opened(m), { kind: 'adapter', ext: 'slack', requestId: 'req-seal-0001', sid: 's1', state: 'done', result: { posted: { text: '배포 완료' }, session: 's1' } })
  // call: failed, with the adapter's stderr in the error
  const f = await run(t, a, gate(t, await pageCall(t, dev, { ...W, action: 'thread.read', access: 'read', input: { fail: 1 }, requestId: 'req-seal-0002' })))
  assert.match(f.error, /xoxb-secret/)
  const fm = sealOut({ ...tag, requestId: 'req-seal-0002', ok: true, ...f }, seal)
  assert.ok(!JSON.stringify(fm).includes('xoxb-secret'), 'stderr 는 봉인')
  assert.equal(fm.state, 'failed')
  assert.match(opened(fm).error, /xoxb-secret/)
  // status: the stored result and a replay are sealed the same way
  const sm = sealOut({ t: 'adapter', reqId: 'r2', ext: 'slack', requestId: 'req-seal-0001', ok: true, ...a.status('slack', 'req-seal-0001') }, seal)
  assert.equal(opened(sm).result.posted.text, '배포 완료')
  assert.equal(sm.result, undefined)
  const again = await run(t, a, gate(t, await pageCall(t, dev, { ...W, requestId: 'req-seal-0001' })))
  const rm = sealOut({ ...tag, requestId: 'req-seal-0001', ok: true, ...again }, seal)
  assert.equal(opened(rm).replayed, true)
  assert.equal(rm.result, undefined)
  // list: the problems' words sealed, the action names plain (the server filters by them)
  const lm = sealOut({ ...tag, ok: true, actions: { 'thread.read': 'read' }, problems: [{ name: 'x', error: '/Users/me/secret 경로' }] }, seal)
  assert.ok(!JSON.stringify(lm).includes('secret'))
  assert.deepEqual(lm.actions, { 'thread.read': 'read' })
})
