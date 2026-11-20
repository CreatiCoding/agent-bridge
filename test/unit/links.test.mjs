// 사이트와 로컬 서버에 함께 연동 (REQ-F-924, REQ-S-113): which server a message goes to, that transcript lines reach
// the site only sealed and the local server only plain, each server every line once and in order whatever rewinds the
// other asks for, and what one server takes of the marks the other gets.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SEALED_LINES, newLink, resetLink, primaryOf, routeOf, refusedFor, marksStep } from '../../agent/localfull.mjs'
import { sealLine } from '../../agent/trust.mjs'

const SRC = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
/** One top-level function of agent.mjs, as written. */
const fnSrc = (head) => {
  const a = SRC.indexOf(head)
  assert.ok(a >= 0, head)
  return SRC.slice(a, SRC.indexOf('\n}\n', a) + 2)
}

test('AC-1838: an answer goes back to the server that asked, an ask for one server to one, the rest to all', () => {
  const site = newLink('site')
  const local = newLink('local')
  site.welcomed = local.welcomed = true
  const both = [site, local]
  assert.deepEqual(routeOf({ t: 'status', sid: 's' }, null, both), both, '상태는 둘 다')
  assert.deepEqual(routeOf({ t: 'status', sid: 's' }, local, both), both, '명령 중에 나온 상태도 둘 다')
  assert.deepEqual(routeOf({ t: 'events', reqId: 'r1' }, local, both), [local], '답은 물어본 쪽만')
  assert.deepEqual(routeOf({ t: 'events', reqId: 0 }, site, both), [site], 'reqId 0 도 답')
  assert.deepEqual(routeOf({ t: 'pong', ts: 1 }, local, both), [local], 'pong 은 물어본 쪽만')
  assert.deepEqual(routeOf({ t: 'marks', list: [] }, site, both), [site], 'marks 답은 보낸 쪽만')
  assert.deepEqual(routeOf({ t: 'events', reqId: 'r1' }, local, [site]), [], '물어본 쪽이 끊겼으면 아무에게도')
  assert.deepEqual(routeOf({ t: 'delegate', areq: 'a' }, null, both), [site], '맡기기는 사이트 하나만')
  assert.deepEqual(routeOf({ t: 'tidyAsk' }, null, both), [site], '정리 요청도 하나만')
  site.welcomed = false
  assert.deepEqual(routeOf({ t: 'delegate', areq: 'a' }, null, both), [local], '사이트가 아직이면 로컬')
  site.welcomed = true
  assert.deepEqual(routeOf({ t: 'snappart', snap: 'r9', sid: 's', plain: {} }, local, both), [local], '스냅샷 조각은 요청한 쪽만(snap)')
  assert.deepEqual(routeOf({ t: 'error', sid: 's', message: 'x' }, local, both), [local], '명령의 오류는 보낸 쪽만')
  assert.deepEqual(routeOf({ t: 'error', sid: 's', message: 'x' }, null, both), both, '명령 밖의 오류는 둘 다')
  site.hidden.add('sess-0007')
  assert.deepEqual(routeOf({ t: 'delegate', areq: 'a', sid: 'sess-0007' }, null, both), [local], '사이트가 숨긴 세션의 맡기기는 로컬로')
  local.hidden.add('sess-0007')
  assert.deepEqual(routeOf({ t: 'delegate', areq: 'a', sid: 'sess-0007' }, null, both), [], '둘 다 숨겼으면 아무에게도')
  assert.equal(primaryOf([]), null)
  assert.deepEqual(routeOf({ t: 'status' }, null, []), [])
  resetLink(local)
  assert.equal(local.welcomed, false)
})

test('AC-1838: nothing about a hidden session, and no unsealed lines to a link that seals', () => {
  const site = newLink('site')
  site.hidden.add('sess-0001')
  assert.equal(refusedFor({ t: 'status', sid: 'sess-0001' }, site, false), 'hidden')
  assert.equal(refusedFor({ t: 'status', sid: 'sess-0002' }, site, false), null)
  assert.equal(refusedFor({ t: 'lines', sid: 'sess-0002', lines: ['x'] }, site, true), 'lines-not-sealed')
  assert.equal(refusedFor({ t: 'lines', sid: 'sess-0002', lines: ['x'], [SEALED_LINES]: true }, site, true), null)
  assert.equal(refusedFor({ t: 'lines', sid: 'sess-0002', lines: ['x'] }, site, false), null, '봉인하지 않는 쪽은 평문')
  assert.equal(JSON.stringify({ t: 'lines', [SEALED_LINES]: true }), '{"t":"lines"}', '표시는 밖으로 나가지 않음')
  assert.equal(refusedFor({ t: 'snappart', sid: 'sess-0002', snap: 'r', plain: { html: '<p>' } }, site, true), 'snapshot-not-sealed', '평문 스냅샷 조각은 봉인하는 쪽에 안 감')
  assert.equal(refusedFor({ t: 'snappart', sid: 'sess-0002', snap: 'r', sealed: 'x' }, site, true), null)
  assert.equal(refusedFor({ t: 'snappart', sid: 'sess-0002', snap: 'r', plain: {} }, site, false), null)
})

test('AC-1839: marks taken from one server are what the other gets', () => {
  const now = 1_000_000
  const mine = { 'sess-0001': { at: 100, favorite: false, title: '' }, 'sess-0002': { at: 500, favorite: true, title: 'b' } }
  const step = marksStep(mine, [{ sid: 'sess-0001', at: 200, favorite: true, title: '새 이름' }, { sid: 'sess-0002', at: 300, favorite: false, title: '' }], now)
  assert.deepEqual(step.took, [{ sid: 'sess-0001', at: 200, favorite: true, title: '새 이름' }])
  assert.deepEqual(step.send, [{ sid: 'sess-0002', at: 500, favorite: true, title: 'b' }])
  assert.deepEqual(marksStep(mine, [{ sid: 'sess-0001', at: 100 }], now).took, [], '같은 시각은 아무것도')
})

/**
 * The agent's own tail, emitTo and rewind, run against a transcript file with two linked servers: the site seals, the
 * local server does not. Each fake server keeps lines only when `from` is its count, and asks for a resync otherwise
 * (as linesFromAgent does).
 */
function rig({ sealer = (t) => `⟦S:${Buffer.from(t).toString('base64')}⟧`, siteSeals = true, chunk = 300, lineBase } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-links-'))
  const file = path.join(dir, 't.jsonl')
  fs.writeFileSync(file, '')
  const site = newLink('site')
  const local = newLink('local')
  const outs = { site: [], local: [] }
  const servers = { site: { have: [], resyncs: 0, msgs: [] }, local: { have: [], resyncs: 0, msgs: [] } }
  const errors = []
  const links = [site, local]
  const sealsFor = (l) => l.kind === 'site' && siteSeals
  const outOf = (l) => ({ write: (x) => outs[l.kind].push(x) })
  const keys = { sealer }
  const trust = { sealer: () => keys.sealer }
  const log = (level, area, text) => level === 'error' && errors.push(text)
  const stats = { sent: 0 }
  const emitTo = new Function('outOf', 'sealsFor', 'refusedFor', 'log', 'trust', 'sealOut', 'stats', 'hideKeys', 'ownKeys', 'deliver', `${fnSrc('function emitTo(link, msg) {').replace('out.write(', 'deliver(link, m), out.write(')}\nreturn emitTo`)(outOf, sealsFor, refusedFor, log, trust, (m) => m, stats, (x) => x, () => [], (link, m) => servers[link.kind].msgs.push(m))
  const rewind = new Function(`${fnSrc('function rewind(s, link, serverLines) {')}\nreturn rewind`)()
  const tail = new Function('isClaude', 'codexSync', 'transcriptPath', 'fs', 'emptyCache', 'linked', 'sealsFor', 'trust', 'log', 'trustEchoOf', 'SEALED_LINES', 'emitTo', 'countLine', 'BgTracker', 'saveLineImages', 'IMAGES_DIR', 'sealLine', 'trustSeen', 'MAX_CHUNK', 'saveSessions', `${fnSrc('function tail(sid, s) {')}\nreturn tail`)(
    () => true,
    () => {},
    () => file,
    fs,
    () => ({}),
    () => links,
    sealsFor,
    trust,
    log,
    () => () => false,
    SEALED_LINES,
    emitTo,
    () => {},
    class {
      line() {}
    },
    () => {},
    dir,
    sealLine,
    { quiet: [] },
    chunk,
    () => {},
  )
  const s = lineBase ? { lineBase } : {}
  /** What each fake server does with what came: keep in order, or ask again from its count. */
  const serve = () => {
    for (const k of ['site', 'local']) {
      const srv = servers[k]
      for (const m of srv.msgs.splice(0)) {
        if (m.t !== 'lines') continue
        // As linesFromAgent: a gap (the file starts later) is counted on from; anything else is asked again.
        if (m.from !== srv.have.length && m.gap === true && m.from > srv.have.length) while (srv.have.length < m.from) srv.have.push(null)
        if (m.from !== srv.have.length) {
          srv.resyncs++
          rewind(s, k === 'site' ? site : local, srv.have.length)
          continue
        }
        srv.have.push(...m.lines)
      }
    }
  }
  return { file, site, local, servers, outs, errors, s, keys, tail: () => (tail('sess-0001', s), serve()), rewind: (l, n) => rewind(s, l, n), done: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

const lineOf = (i) => JSON.stringify({ type: i % 3 ? 'assistant' : 'user', message: { role: i % 3 ? 'assistant' : 'user', content: [{ type: 'text', text: `줄 ${i} ${'가'.repeat(i % 40)}` }] }, uuid: `u-${i}` })

test('AC-1840: the site gets every line sealed, the local server every line plain, once each and in order, whatever rewinds come', () => {
  let seed = 7
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
  for (let round = 0; round < 25; round++) {
    const r = rig({ chunk: 150 + rnd(400) })
    try {
      const all = []
      let lost = 0
      for (let step = 0; step < 30; step++) {
        const add = rnd(6)
        for (let i = 0; i < add; i++) all.push(lineOf(all.length))
        if (add) fs.appendFileSync(r.file, all.slice(all.length - add).map((l) => `${l}\n`).join(''))
        // A server that linked again says how many it has (welcome), or one asks from fewer than it has (a lost write).
        const pick = rnd(10)
        if (pick === 0) r.rewind(r.site, r.servers.site.have.length)
        if (pick === 1) r.rewind(r.local, r.servers.local.have.length)
        if (pick === 2) (lost++, r.rewind(r.local, (r.servers.local.have.length = Math.max(0, r.servers.local.have.length - rnd(4)))))
        r.tail()
        r.tail()
      }
      r.tail()
      r.tail()
      assert.deepEqual(r.servers.local.have, all, `round ${round}: 로컬은 평문 그대로, 한 번씩, 차례대로`)
      assert.deepEqual(
        r.servers.site.have,
        all.map((l) => sealLine(l, (t) => `⟦S:${Buffer.from(t).toString('base64')}⟧`)),
        `round ${round}: 사이트는 모두 봉인돼서, 한 번씩, 차례대로`,
      )
      for (const w of r.outs.site) for (const l of JSON.parse(w.slice(6)).lines ?? []) assert.ok(!/줄 \d/.test(l), '사이트로 간 글에 평문 없음')
      assert.deepEqual(r.errors, [])
      // One server's rewind never makes the other ask again: it is sent nothing it has.
      assert.equal(r.servers.site.resyncs, 0, `round ${round}: 로컬이 되감아도 사이트는 다시 묻지 않음`)
      assert.ok(r.servers.local.resyncs <= lost, `round ${round}: 로컬은 잃은 만큼만 다시 물음 (${r.servers.local.resyncs} ≤ ${lost})`)
    } finally {
      r.done()
    }
  }
})

test('AC-1840: a site that seals with no key here gets no line; a hidden session nothing; the local server all of it', () => {
  const r = rig({ sealer: null })
  try {
    fs.appendFileSync(r.file, `${lineOf(0)}\n${lineOf(1)}\n`)
    r.tail()
    assert.deepEqual(r.servers.site.have, [])
    assert.equal(r.outs.site.length, 0)
    assert.deepEqual(r.servers.local.have, [lineOf(0), lineOf(1)])
    assert.ok(r.errors.some((e) => /봉인 열쇠가 없어/.test(e)))
  } finally {
    r.done()
  }
  const h = rig()
  try {
    h.local.hidden.add('sess-0001')
    fs.appendFileSync(h.file, `${lineOf(0)}\n`)
    h.tail()
    assert.equal(h.outs.local.length, 0, '숨긴 세션은 로컬에 안 감')
    assert.equal(h.servers.site.have.length, 1)
  } finally {
    h.done()
  }
})

test('AC-1840: emitTo never writes unsealed lines to the site, whoever sends them', () => {
  const r = rig()
  try {
    const emitTo = new Function('outOf', 'sealsFor', 'refusedFor', 'log', 'trust', 'sealOut', 'stats', 'hideKeys', 'ownKeys', `${fnSrc('function emitTo(link, msg) {')}\nreturn emitTo`)
    const wrote = []
    const errs = []
    const send = emitTo(() => ({ write: (x) => wrote.push(x) }), (l) => l.kind === 'site', refusedFor, (lv, a, t) => errs.push(t), { sealer: () => null }, (m) => m, { sent: 0 }, (x) => x, () => [])
    send(r.site, { t: 'lines', sid: 'sess-0001', from: 0, lines: ['평문'] })
    assert.deepEqual(wrote, [])
    assert.equal(errs.length, 1)
    send(r.local, { t: 'lines', sid: 'sess-0001', from: 0, lines: ['평문'] })
    assert.equal(wrote.length, 1, '로컬은 평문')
  } finally {
    r.done()
  }
})

test('AC-1841: the agent runs each command as its link, and every other place takes the link from there', () => {
  // emit goes through routeOf with the link whose command runs; one server's welcome, resync, kept lids and logs are its own.
  assert.match(fnSrc('function emit(msg) {'), /for \(const l of routeOf\(msg, origin\(\), linked\(\)\)\) emitTo\(l, msg\)/)
  assert.match(SRC, /welcome\(\{ sessions: known, partial \}\) \{\n\s*const link = hereLink\(\)/)
  assert.match(SRC, /if \(s\) rewind\(s, hereLink\(\), lines\)/)
  assert.match(SRC, /if \(typeof lid === 'string'\) hereLink\(\)\.kept\.push\(lid\)/)
  assert.ok(!/\bevStore\(\)/.test(SRC), '옛 evStore 없음')
  assert.ok(!/\bkeptLids\b/.test(SRC), '옛 keptLids 없음')
  const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n')
  assert.ok(!/\bwelcomed\b/.test(code.replace(/\b(l|link|siteLink|localLink)\.welcomed\b/g, '').replace(/welcomed: false/g, '')), '옛 전역 welcomed 없음')
  // A tab of the site is turned away only when the local server took its place (on), never with both.
  assert.match(SRC, /if \(siteBlocked\(\)\) return res\.end\('data: \{"t":"busy","local":true\}\\n\\n'\)/)
  // Sealing: only the site's link seals; what goes to both (accounts' folders, a quit runner's screen) by the site's.
  assert.match(SRC, /const sealsFor = \(link\) => link\?\.kind === 'site' && !siteBlocked\(\) && trust\.sealing\(trustMode\(\)\) && trustSeen\.seal/)
  assert.match(SRC, /\.\.\.\(siteSeals\(\) \? \{\} : \{ dir: tilde\(a\.dir\) \}\)/)
})

test('AC-1840: a file that starts later than a new server\'s lines (trimmed) is sent from there with gap, not asked again forever', () => {
  const r = rig({ lineBase: 3 })
  try {
    fs.appendFileSync(r.file, `${lineOf(3)}\n${lineOf(4)}\n`)
    // Both welcome: the site has the lines up to the file's first, the new local server none.
    r.servers.site.have.push(null, null, null)
    r.rewind(r.site, 3)
    r.rewind(r.local, 0)
    r.tail()
    r.tail()
    assert.deepEqual(r.servers.local.have, [null, null, null, lineOf(3), lineOf(4)], '로컬은 3번부터 받고 앞은 비워 둠')
    assert.equal(r.servers.local.resyncs, 0, '끝없이 다시 묻지 않음')
    assert.equal(r.servers.site.have.length, 5)
  } finally {
    r.done()
  }
})

test('AC-1840: lines held back while the site had no key to seal are asked for again when it has one, never skipped as a gap', () => {
  const r = rig({ sealer: null })
  try {
    fs.appendFileSync(r.file, `${lineOf(0)}\n${lineOf(1)}\n`)
    r.tail()
    assert.deepEqual(r.servers.site.have, [])
    r.keys.sealer = (t) => `⟦S:${Buffer.from(t).toString('base64')}⟧`
    fs.appendFileSync(r.file, `${lineOf(2)}\n`)
    for (let i = 0; i < 4; i++) r.tail()
    assert.equal(r.servers.site.have.length, 3, '빠진 줄 없이 3줄')
    assert.ok(r.servers.site.have.every((l) => l && !/줄 \d/.test(l)), '모두 봉인')
    assert.deepEqual(r.servers.local.have, [lineOf(0), lineOf(1), lineOf(2)])
  } finally {
    r.done()
  }
})

test('AC-1841: a session both servers say is not theirs is let go, never in enforce; one opened again through one is told to the other', () => {
  const site = newLink('site')
  const local = newLink('local')
  site.welcomed = local.welcomed = true
  const released = []
  let enforce = false
  const letGo = new Function('siteLink', 'localLink', 'enforcing', 'via', 'commands', 'log', `${fnSrc('function letGo(link, sid) {')}\nreturn letGo`)(site, local, () => enforce, { run: (_, f) => f() }, { release: ({ sid }) => released.push(sid) }, () => {})
  letGo(local, 'sess-0001')
  assert.deepEqual(released, [], '한쪽만 숨기면 그대로')
  letGo(site, 'sess-0001')
  assert.deepEqual(released, ['sess-0001'], '둘 다면 내려놓음')
  enforce = true
  letGo(local, 'sess-0002')
  letGo(site, 'sess-0002')
  assert.deepEqual(released, ['sess-0001'], 'enforce 에서는 서버 말로 내려놓지 않음')
  // knownBy: a resume through the site of one the local server hides as ended.
  const sessions = new Map([['sess-0003', {}]])
  local.hidden.add('sess-0003')
  local.known.add('sess-0003')
  const knownBy = new Function('lf', 'sessions', 'siteLink', 'localLink', `${fnSrc('function knownBy(link, sid, started) {')}\nreturn knownBy`)({ active: true, both: true }, sessions, site, local)
  knownBy(site, 'sess-0003', false)
  assert.ok(site.known.has('sess-0003') && local.hidden.has('sess-0003'), '명령만으로는 다른 쪽을 바꾸지 않음')
  knownBy(site, 'sess-0003', true)
  assert.ok(!local.hidden.has('sess-0003') && !local.known.has('sess-0003'), '다시 열면 다른 쪽에 다시 알림')
  assert.ok(sessions.get('sess-0003').reopenFor.has('local'), 'reopen 표시')
  // Ended through the local screen (still known there, not hidden: no hello between), then resumed through the site.
  sessions.set('sess-0004', {})
  local.known.add('sess-0004')
  knownBy(site, 'sess-0004', true)
  assert.ok(!local.known.has('sess-0004') && sessions.get('sess-0004').reopenFor.has('local'), '숨기지 않았어도 다시 알림')
  // Resumed through the site while the local server was not linked (not welcomed): marked for it all the same.
  sessions.set('sess-0006', {})
  local.welcomed = false
  knownBy(site, 'sess-0006', true)
  assert.ok(sessions.get('sess-0006').reopenFor.has('local'), '연동 안 된 쪽도 다시 열 표시')
  local.welcomed = true
  assert.match(SRC, /if \(s\.reopenFor\?\.has\(link\.kind\)\) link\.known\.delete\(sid\)\n\s*else letGo\(link, sid\)/)
  // A session that ends is known by no server any more.
  const forget = new Function('siteLink', 'localLink', `${fnSrc('function forgetLinked(sid) {')}\nreturn forgetLinked`)(site, local)
  site.known.add('sess-0005')
  local.asked.add('sess-0005')
  forget('sess-0005')
  assert.ok(!site.known.has('sess-0005') && !local.asked.has('sess-0005'))
  assert.match(SRC.slice(SRC.indexOf('  async release({ sid }) {'), SRC.indexOf('  async setting({')), /sessions\.delete\(sid\)\n\s*forgetLinked\(sid\)/)
  // In enforce the site's word that a session is not its own hides nothing (its lines go on, as with the site alone).
  assert.match(SRC, /if \(lf\.active && lf\.both && !\(enforcing\(\) && link\.kind === 'site'\)\) \{\n(\s*\/\/.*\n)*\s*if \(s\.reopenFor/)
  assert.match(SRC.slice(SRC.indexOf('  async close({ sid, dropDir }) {'), SRC.indexOf('  async release({ sid }) {')), /sessions\.delete\(sid\)\n\s*forgetLinked\(sid\)/)
})

test('AC-1841: an exposure result goes once to each linked server, also one that links later', () => {
  const site = newLink('site')
  const local = newLink('local')
  const sent = []
  const links = [local]
  const exposure = { last: { os: 1 } }
  const send = new Function('exposure', 'linked', 'emitTo', `${fnSrc('function sendExposure() {')}\nreturn sendExposure`)(exposure, () => links, (l, m) => sent.push(l.kind))
  send()
  links.push(site)
  send()
  send()
  assert.deepEqual(sent, ['local', 'site'])
  exposure.last = { os: 2 }
  send()
  assert.deepEqual(sent, ['local', 'site', 'local', 'site'])
})
