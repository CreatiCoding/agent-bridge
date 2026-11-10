// 세션 찾기 보안 (REQ-S-102, AC-1729·AC-1730·AC-1731): the page's own code (ui/src/lib/trust.ts, paired for real with
// the Mac's Trust) against a server that lies. Which Mac gets the words is decided by this device's pairings, never
// by what the server says of a Mac; a paired Mac never gets the words plain, and refuses them plain while sealing;
// a paired Mac's findings count only as its sealed pieces, opened with its own key, for this very search (fn).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { Trust, classOf, rebuild, hashesHold, sealOut, convfindRefusal, onlySealed, sha256Hex } from '../../agent/trust.mjs'

// What the server lists (hosts, sessions): the page reads it through store.getStore, which the server fills.
const listed = { hosts: [], sessions: [] }
globalThis.__findListed = listed
registerHooks({
  resolve(spec, ctx, next) {
    if (ctx.parentURL?.endsWith('/ui/src/lib/trust.ts')) {
      if (spec === './store') return { url: 'data:text/javascript,export const getStore = () => ({ state: globalThis.__findListed })', shortCircuit: true }
      if (spec === './choices') return next('./choices.ts', ctx)
    }
    return next(spec, ctx)
  },
})
const page = await import('../../ui/src/lib/trust.ts')

const WORDS = '비밀 프로젝트 코드네임'
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'find-trust-'))
function mac(hostId) {
  const t = new Trust({ stateDir: tmp(), hostId })
  t.ensure()
  return t
}
/** This page pairs with the Mac as a person would (startPairing, the six digits typed at the Mac's terminal). */
async function pairWith(t) {
  fs.writeFileSync(t.p.window, JSON.stringify({ until: Date.now() + 60_000 }))
  let pid = ''
  const ask = async (b) => {
    if (b.op === 'pair1') {
      const r = t.pair1({ c: b.c }, 'enforce')
      pid = r.pid
      return r
    }
    if (b.op === 'pair3') return t.pair3(b)
    if (b.op === 'pair4') return t.pair4(b)
    throw new Error(b.op)
  }
  const p = await page.startPairing(t.hostId, '시험 기기', ask)
  fs.writeFileSync(t.p.confirm, JSON.stringify({ pid, sas: p.sas }))
  assert.equal(await p.poll(), 'ok')
}
const tokensOf = (auth) => (auth ? JSON.parse(Buffer.from(auth, 'base64url').toString('utf8')) : [])
/** agent.mjs trustGate in enforce: the command to run, or {refused}. */
function gate(t, cmd) {
  const rule = classOf(cmd)
  let v = t.verify(cmd)
  if (v.ok && !hashesHold(cmd, v.i)) v = { ok: false, why: '서명한 글·그림과 다름' }
  if (!v.ok) return { refused: v.why }
  return { ...rebuild(cmd, rule, v.i), signed: v.dev.id }
}
/** What the server makes of the request for one Mac (server/find.go), with the token meant for it attached. */
function toMac(body, auth, hostId) {
  const tok = tokensOf(auth).find((x) => JSON.parse(x.p).h === hostId)
  return { t: 'convfind', op: body.mode, reqId: 'r1', q: body.qh?.[hostId] ?? body.q, closed: [], skip: [], ...(body.fn ? { fn: body.fn } : {}), ...(tok ? { auth: tok } : {}) }
}

const A = mac('host-a') // paired with this page, sealing
const C = mac('host-c') // paired with this page too
const B = 'host-b' // the person's other Mac, not paired with this page
await pairWith(A)
await pairWith(C)
const SID = '11111111-2222-4333-8444-555555555555'
const SID_B = '22222222-2222-4333-8444-555555555555'

test('H1: a paired Mac gets the words sealed, never plain — whatever the server says of it (AC-1729)', async () => {
  // The server lists A as not sealing and adds a Mac of its own: the page does not ask it.
  listed.hosts = [{ id: 'host-a', trust: { seal: false } }, { id: B, trust: { seal: false } }, { id: 'host-c' }]
  const t = await page.findTargets(listed.hosts.map((h) => h.id))
  assert.deepEqual(t.sealed.sort(), ['host-a', 'host-c'])
  assert.deepEqual(t.plain, [B])
  assert.equal(t.direct, false, '짝지은 맥이 있으면 평문 찾기는 따로, 사람이 고를 때만')
  const { body, fn } = await page.findSealedBody('text', WORDS, t.sealed)
  const flat = JSON.stringify(body)
  assert.equal(body.q, undefined, '봉인 찾기에는 평문 글이 없음')
  assert.doesNotMatch(flat, new RegExp(WORDS))
  assert.ok(onlySealed(body.qh['host-a']) && onlySealed(body.qh['host-c']))
  assert.deepEqual(body.hosts.sort(), ['host-a', 'host-c'])
  assert.ok(fn.length >= 16 && body.fn === fn)
  // Signed for each paired Mac with the hash of its own piece and the search's number.
  const auth = await page.authHeader('POST', '/api/find', body)
  const toks = tokensOf(auth).map((x) => JSON.parse(x.p))
  assert.deepEqual(toks.map((x) => [x.h, x.t]).sort(), [['host-a', 'convfind'], ['host-c', 'convfind']])
  const ta = toks.find((x) => x.h === 'host-a')
  assert.deepEqual(ta.i, { op: 'text', qH: sha256Hex(body.qh['host-a']), fn })
  // A gets its piece, opens it, and takes the search.
  const cmd = gate(A, toMac(body, auth, 'host-a'))
  assert.equal(cmd.refused, undefined, cmd.refused)
  assert.equal(convfindRefusal(cmd, true), null)
  assert.equal(A.openText(cmd.q, ''), WORDS)
  assert.equal(cmd.fn, fn)
  // A's piece does not open at C (bound to A), so the server cannot hand it on.
  assert.equal(C.openText(body.qh['host-a'], ''), null)
})

test('H1: the plain words go only to the Macs this page is not paired with, by themselves (AC-1729)', async () => {
  listed.hosts = [{ id: 'host-a', trust: { seal: false } }, { id: B }]
  const plain = await page.findPlainBody('text', WORDS, ['host-a', B])
  assert.deepEqual(plain, { mode: 'text', q: WORDS, hosts: [B] }, '짝지은 맥은 평문 찾기에서 빠짐')
  await assert.rejects(page.findPlainBody('text', WORDS), /짝짓지 않은 맥만/, '짝지은 맥이 있으면 받을 맥을 꼭 정함')
  await assert.rejects(page.findPlainBody('text', WORDS, []), /짝짓지 않은 맥만/, '빈 목록도 정한 것이 아님')
  await assert.rejects(page.findPlainBody('text', WORDS, ['host-a']), /짝짓지 않은 맥만/, '짝지은 맥만 남으면 보내지 않음')
  assert.equal(await page.authHeader('POST', '/api/find', plain), null, '평문 찾기는 서명하지 않음')
  // The server leaves the paired Macs out of the list: the search does not turn plain by itself (AC-1740).
  for (const listedNow of [[B], []]) {
    const t = await page.findTargets(listedNow)
    assert.equal(t.direct, false, '짝지은 맥이 있는 기기는 평문 찾기를 바로 보내지 않음')
    assert.equal(t.missing, true, '짝지은 맥이 목록에 없음을 알림')
    assert.deepEqual(t.plain, listedNow)
  }
  assert.equal((await page.findTargets(['host-a', B])).missing, false)
})

test('H1: a sealing Mac refuses plain words, and an unsigned search, even if the server sends them (AC-1729)', async () => {
  const piece = (await page.findSealedBody('text', WORDS, ['host-a'])).body.qh['host-a']
  assert.match(convfindRefusal({ q: WORDS, signed: 'd1' }, true), /평문 검색어는 받지 않아요/)
  assert.match(convfindRefusal({ q: `${WORDS} ${piece}`, signed: 'd1' }, true), /평문 검색어는 받지 않아요/, '조각 옆의 평문도')
  assert.match(convfindRefusal({ q: piece }, true), /서명한 찾기만/)
  assert.equal(convfindRefusal({ q: piece, signed: 'd1' }, true), null)
  assert.equal(convfindRefusal({ q: WORDS }, false), null, '봉인하지 않는 맥은 그대로')
  // A plain search signed as if by the page does not even pass the gate: the page never signs one.
  const plain = await page.findPlainBody('text', WORDS, [B])
  const cmd = gate(A, toMac(plain, null, 'host-a'))
  assert.ok(cmd.refused, '서명 없음')
})

/** A's answer to a search, sealed as it leaves (agent convfind → sealOut). */
const answerOf = (t, cmd, hits, extra = {}) => sealOut({ t: 'convfind', reqId: 'r1', op: cmd.op, ok: true, qh: sha256Hex(A.openText(cmd.q, '')).slice(0, 16), fn: cmd.fn, hits, ...extra }, t.sealer())

test('M1·L2: a paired Mac counts only as its own sealed pieces for this very search (AC-1730)', async () => {
  listed.hosts = [{ id: 'host-a' }, { id: B }, { id: 'host-c' }]
  const { body, fn } = await page.findSealedBody('text', WORDS, ['host-a', 'host-c'])
  const auth = await page.authHeader('POST', '/api/find', body)
  const cmd = gate(A, toMac(body, auth, 'host-a'))
  const r = answerOf(A, cmd, [{ sid: SID, at: 5, n: 2, snips: [`…${WORDS} 문맥…`] }])
  assert.doesNotMatch(JSON.stringify(r), new RegExp(WORDS), '평문으로 나가지 않음')
  const qh = await page.findQh(WORDS)
  const want = { op: 'text', qh, fn }
  const hit = r.hits[0]
  assert.deepEqual(await page.findOpen('host-a', want, hit), { n: 2, snips: [`…${WORDS} 문맥…`], why: undefined, rank: undefined })
  // L2: the same piece for another search (an old answer the server replays) is dropped.
  assert.equal(await page.findOpen('host-a', { ...want, fn: 'another-search' }, hit), null)
  // L2: moved to another paired Mac's row it does not open with that Mac's key.
  assert.equal(await page.findOpen('host-c', want, hit), null)
  // Moved to another session's row.
  assert.equal(await page.findOpen('host-a', want, { ...hit, sid: SID_B }), null)
  // Moved to a Mac this page is not paired with: a sealed row from there is not shown either.
  assert.equal(await page.findOpen(B, want, hit), null)
  // M1: a plain row for a paired Mac (the server says it does not seal, and makes up the context) is never believed.
  assert.equal(await page.findOpen('host-a', want, { sid: SID, n: 9, snips: ['서버가 지어낸 문맥'] }), null)
  // Another kind of search.
  assert.equal(await page.findOpen('host-a', { ...want, op: 'ai' }, hit), null)
  // A Mac this page is not paired with: its plain row as it came (the screen names that Mac).
  assert.deepEqual(await page.findOpen(B, { op: 'text', qh: '', fn: '' }, { sid: SID_B, n: 1, snips: ['평문'] }), { n: 1, snips: ['평문'], why: undefined })
})

test('a sealed error from a paired Mac is opened for the screen, never shown as a piece (AC-1730)', async () => {
  const seal = A.sealer()
  const e = sealOut({ t: 'convfind', reqId: 'r1', op: 'ai', ok: false, error: 'AI 가 답하지 못했어요' }, seal)
  assert.match(e.error, /^⟦bt1:/)
  assert.equal(await page.findText('host-a', e.error), 'AI 가 답하지 못했어요')
  assert.equal(await page.findText('host-c', e.error), page.LOCKED, '다른 맥의 키로는 열리지 않음')
  assert.equal(await page.findText(B, '연결 안 됨'), '연결 안 됨')
})

test('L3: AI picks leave in session id order, the ranking only inside the pieces (AC-1731)', async () => {
  const { body, fn } = await page.findSealedBody('ai', WORDS, ['host-a'])
  const auth = await page.authHeader('POST', '/api/find', body)
  const cmd = gate(A, toMac(body, auth, 'host-a'))
  const r = sealOut({ t: 'convfind', reqId: 'r1', op: 'ai', ok: true, qh: await page.findQh(WORDS), fn: cmd.fn, picks: [{ sid: SID_B, why: '첫째' }, { sid: SID, why: '둘째' }] }, A.sealer())
  assert.deepEqual(r.picks.map((p) => p.sid), [SID, SID_B])
  const want = { op: 'ai', qh: await page.findQh(WORDS), fn }
  assert.equal((await page.findOpen('host-a', want, r.picks[0])).rank, 1)
  assert.equal((await page.findOpen('host-a', want, r.picks[1])).rank, 0)
})
