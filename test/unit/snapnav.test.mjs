// REQ-F-906, REQ-S-110 (1.526): moving inside the snapshot sheet (which link moves it), the Mac's kept drawings on its
// disk, and a snapshot in pieces each sealed on its own, checked piece by piece and as a whole.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { linkKind, privateHost } from '../../ui/src/lib/snapshot-page.ts'
import { SnapAssembler, BROKEN } from '../../ui/src/lib/snap-pieces.ts'
import { SnapCache, snapCacheOf, snapKey, snapPayload, snapUnpayload, snapPieces, SNAP_PIECE, SNAP_PIECES_MAX, diskCaches, egoSnapshotScript, EGO_MARK_JS_CLICKS, DAY_MS } from '../../agent/guard.mjs'
import { TRUST_CLASS, rebuild, sealOut } from '../../agent/trust.mjs'

// A tiny element: what linkKind reads (localName, attributes, parent).
function el(tag, attrs = {}, parent = null) {
  return {
    localName: tag,
    parentElement: parent,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    hasAttribute: (k) => k in attrs,
  }
}
const page = 'https://example.com/a?x=1'
const own = ['https://bridge.example', 'https://lp.bridge.example']

test('AC-1777: a link that surely goes to another page moves the sheet; a #place scrolls', () => {
  assert.equal(linkKind(el('a', { href: 'https://example.com/b' }), page, own), 'nav')
  assert.equal(linkKind(el('a', { href: '/b' }), page, own), 'nav')
  assert.equal(linkKind(el('a', { href: 'b?y=2' }), page, own), 'nav')
  assert.equal(linkKind(el('area', { href: 'https://other.example/' }), page, own), 'nav')
  assert.equal(linkKind(el('a', { href: 'http://example.org/' }), page, own), 'nav')
  // The same page with a #place: scrolled to, never asked for.
  assert.equal(linkKind(el('a', { href: '#top' }), page, own), 'frag')
  assert.equal(linkKind(el('a', { href: 'https://example.com/a?x=1#s2' }), page, own), 'frag')
  // A link inside an ordinary box is still a link.
  const nav = el('nav', { class: 'menu' }, el('div', {}))
  assert.equal(linkKind(el('a', { href: '/c' }, nav), page, own), 'nav')
})

test('AC-1777: what is not surely a page stays as it was', () => {
  const no = (a) => assert.equal(linkKind(a, page, own), null, JSON.stringify(a.getAttribute('href')))
  for (const href of ['', '#', 'javascript:alert(1)', ' JaVa\tscript:x', 'mailto:a@b.c', 'tel:1', 'data:text/html,x', 'https://example.com/a?x=1#'])
    no(el('a', { href }))
  no(el('a', {}))
  no(el('div', { href: '/b' }))
  for (const extra of [{ role: 'button' }, { role: 'tab' }, { role: 'menuitem' }, { role: 'switch' }, { role: 'option' }, { 'aria-expanded': 'false' }, { 'aria-haspopup': 'true' }, { 'aria-controls': 'm1' }, { download: '' }, { 'data-cb-js-click': '' }])
    no(el('a', { href: '/b', ...extra }))
  // Around it, too.
  no(el('a', { href: '/b' }, el('li', {}, el('ul', { role: 'menuitem' }))))
  no(el('a', { href: '/b' }, el('div', { 'aria-expanded': 'true' })))
  // This site, its previews, this Mac and its network.
  for (const href of ['https://bridge.example/api/me', 'https://lp.bridge.example/', 'http://localhost:3000/', 'http://127.0.0.1/', 'http://127.9.9.9/', 'http://[::1]:8080/', 'http://10.1.2.3/', 'http://172.16.0.1/', 'http://172.31.255.255/', 'http://192.168.0.10/', 'http://169.254.169.254/latest', 'http://printer.local/', 'http://0.0.0.0/', 'http://[::ffff:127.0.0.1]/', 'http://[fe80::1]/', 'http://[fd12::1]/', 'http://2130706433/', 'http://0x7f.1/'])
    no(el('a', { href }))
})

test('AC-1777: privateHost', () => {
  for (const h of ['localhost', 'a.localhost', 'x.local', '10.0.0.1', '172.16.5.5', '192.168.1.1', '169.254.0.1', '127.0.0.1', '[::1]', '[::ffff:7f00:1]', '[fe80::1]', '[fc00::1]', '100.64.0.1', '0.0.0.0']) assert.equal(privateHost(h), true, h)
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '192.169.0.1', '[2001:db8::1]', 'local.example.com']) assert.equal(privateHost(h), false, h)
})

const draw = { url: 'https://example.com/b', asked: 'https://example.com/a', html: '<!DOCTYPE html><html><head><style>p{color:red}</style></head><body><p>안녕 😀 "quoted" \\ back</p></body></html>', images: { 'https://example.com/i.png': 'data:image/png;base64,AAAA' }, css: { 'https://example.com/s.css': '.a{}' }, big: { 'https://example.com/big.png': [640, 480] }, width: 412, via: 'ego', at: 1_790_000_000_000 }

test('AC-1778: the payload goes out and comes back as it was', () => {
  const p = snapPayload(draw)
  const back = snapUnpayload(p)
  assert.equal(back.html, draw.html)
  assert.deepEqual(back.images, draw.images)
  assert.deepEqual(back.head.css, draw.css)
  assert.equal(back.head.url, draw.url)
  assert.equal(back.head.asked, draw.asked)
  assert.equal(back.head.at, draw.at)
  // The page's style sheets come before its HTML, the pictures last: the first piece can be drawn.
  assert.ok(p.indexOf('.a{}') < p.indexOf('<!DOCTYPE'))
  assert.ok(p.indexOf('data:image/png') > p.indexOf('</html>'))
})

const sid = 'sess-1'
const rid = 'rid-0123456789'
// Pieces as the phone opens them (the seal itself is the trust tests' and the e2e's).
const piecesOf = (gen, s = draw, size = 40) => snapPieces({ sid, rid, gen, payload: snapPayload(s), size })

test('AC-1779: two drawings in pieces come back whole; the first piece is drawn at once', async () => {
  const kept = { ...draw, html: draw.html.replace('안녕', '예전') }
  const g0 = piecesOf(0, kept)
  const g1 = piecesOf(1)
  assert.ok(g0.length > 3 && g1.length > 3)
  for (const [i, p] of g1.entries()) {
    const q = JSON.parse(p)
    assert.deepEqual([q.kind, q.sid, q.rid, q.gen, q.n, q.of], ['snappart', sid, rid, 1, i, g1.length])
    assert.equal(typeof q.hash === 'string', i === g1.length - 1, 'the hash in the last piece only')
  }
  const a = new SnapAssembler(sid, rid, true)
  const seen = []
  for (const p of [...g0, ...g1]) {
    const d = await a.add(p)
    if (d) seen.push(d)
  }
  // Each drawing: once as soon as its head line is in (the start of its HTML), once whole.
  assert.deepEqual(seen.map((d) => [d.gen, d.complete]), [[0, false], [0, true], [1, false], [1, true]])
  assert.equal(seen[1].html, kept.html)
  assert.equal(seen[3].html, draw.html)
  assert.deepEqual(seen[3].images, draw.images)
  assert.equal(seen[3].at, draw.at)
  assert.equal(seen[3].sealed, true)
  assert.ok(draw.html.startsWith(seen[2].html.slice(0, 5)) && seen[2].images && Object.keys(seen[2].images).length === 0)
  // With the default size, a 2 MB page goes in about 256 KB pieces.
  const big = { ...draw, html: '<p>' + 'x'.repeat(2 * 1024 * 1024) + '</p>' }
  const ps = snapPieces({ sid, rid, gen: 1, payload: snapPayload(big) })
  assert.equal(ps.length, Math.ceil(snapPayload(big).length / SNAP_PIECE))
  assert.ok(ps.length >= 8 && ps.every((p) => JSON.parse(p).body.length <= SNAP_PIECE))
  const b = new SnapAssembler(sid, rid, false)
  let first = null
  let last = null
  for (const p of ps) {
    const d = await b.add(p)
    if (d && !first) first = d
    if (d) last = d
  }
  assert.equal(first.complete, false, 'drawn from the first piece')
  assert.equal(last.html, big.html)
  // Too many pieces is refused at the Mac.
  assert.throws(() => snapPieces({ sid, rid, gen: 1, payload: 'x'.repeat(SNAP_PIECE * SNAP_PIECES_MAX + 1) }), /너무 커서/)
})

test('AC-1779: a piece changed, dropped, repeated, moved or of another request breaks the whole', async () => {
  const g1 = piecesOf(1)
  const run = async (list) => {
    const a = new SnapAssembler(sid, rid, true)
    for (const p of list) await a.add(p)
    return a
  }
  const broken = async (list, why) => assert.rejects(run(list), (e) => e.message.startsWith(BROKEN), why)
  const edit = (i, f) => g1.map((p, j) => (j === i ? JSON.stringify(f(JSON.parse(p))) : p))
  await broken(edit(2, (q) => ({ ...q, body: q.body.replace(/./, 'Z') })), 'a changed body (the hash)')
  await broken(g1.filter((_, j) => j !== 2), 'a dropped piece')
  await broken([g1[0], g1[1], g1[1], ...g1.slice(2)], 'a repeated piece')
  await broken([g1[0], g1[2], g1[1], ...g1.slice(3)], 'two pieces swapped')
  await broken(edit(1, (q) => ({ ...q, rid: 'rid-other-000000' })), 'another request')
  await broken(edit(1, (q) => ({ ...q, sid: 'sess-2' })), 'another session')
  await broken(edit(1, (q) => ({ ...q, of: q.of + 1 })), 'a count that changes')
  await broken(edit(g1.length - 1, (q) => ({ ...q, hash: '0'.repeat(64) })), 'a wrong hash')
  await broken(edit(g1.length - 1, (q) => { const { hash, ...rest } = q; return rest }), 'no hash')
  await broken(['not json'], 'not a piece')
  // A drawing after one that did not end, or back to an earlier one.
  const g0 = piecesOf(0)
  await broken([...g0.slice(0, 2), ...g1], 'the kept drawing cut short')
  await broken([...g1, ...g0], 'the kept drawing after the new one')
  // The whole thing in order is fine.
  const a = await run(g1)
  assert.ok(a.done.has(1))
})

test('AC-1780: kept drawings: 0700 folder, 0600 files, by hash, alias for the address asked, written whole', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snapc-')), 'cache', 'snapshots')
  let now = 1_800_000_000_000
  const c = new SnapCache(dir, { days: 7, mb: 200, now: () => now })
  assert.equal(c.get('https://example.com/a'), null)
  c.put('https://example.com/a', draw)
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  const names = fs.readdirSync(dir).sort()
  assert.deepEqual(names, [`${snapKey('https://example.com/a')}.alias`, `${snapKey('https://example.com/b')}.json`].sort())
  for (const n of names) assert.equal(fs.statSync(path.join(dir, n)).mode & 0o777, 0o600, n)
  // No address in a name.
  assert.ok(names.every((n) => /^[0-9a-f]{64}\.(json|alias)$/.test(n)))
  for (const u of ['https://example.com/a', 'https://example.com/b']) {
    const v = c.get(u)
    assert.equal(v.html, draw.html)
    assert.equal(v.url, draw.url)
    assert.equal(v.at, now)
    assert.deepEqual(v.images, draw.images)
  }
  // Nothing half written is left; a left-over temporary file goes after an hour.
  fs.writeFileSync(path.join(dir, `${snapKey('x')}.json.tmp-1-ab`), '{', { mode: 0o600 })
  now += 2 * 3_600_000
  c.prune()
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')).length, 0)
  // Past its days: not shown, and gone (with its alias).
  now += 8 * DAY_MS
  assert.equal(c.get('https://example.com/a'), null)
  c.prune()
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('AC-1780: past its size, the least lately shown go first; off with snapshotCache: false; on the disk page', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapc-'))
  let now = 1_800_000_000_000
  const big = (i) => ({ ...draw, url: `https://example.com/p${i}`, html: 'y'.repeat(400 * 1024) })
  const c = new SnapCache(dir, { days: 7, mb: 1, now: () => now })
  c.put('https://example.com/p1', big(1))
  now += 1000
  c.put('https://example.com/p2', big(2))
  now += 1000
  assert.ok(c.get('https://example.com/p1'), 'p1 shown again: now the most lately')
  now += 1000
  c.put('https://example.com/p3', big(3))
  assert.ok(c.get('https://example.com/p1'))
  assert.equal(c.get('https://example.com/p2'), null, 'the least lately shown went')
  assert.ok(c.get('https://example.com/p3'))
  assert.deepEqual(snapCacheOf({}), { days: 7, mb: 200 })
  assert.deepEqual(snapCacheOf({ snapshotCache: { days: 2, mb: 50 } }), { days: 2, mb: 50 })
  assert.deepEqual(snapCacheOf({ snapshotCache: { days: -1, mb: 'x' } }), { days: 7, mb: 200 })
  assert.equal(snapCacheOf({ snapshotCache: false }), null)
  const home = '/Users/me'
  const d = diskCaches(home, 'darwin').find((x) => x.id === 'snapshots')
  assert.deepEqual(d.paths, ['/Users/me/.claude-bridge/cache/snapshots'])
  assert.equal(d.how, 'contents')
  assert.deepEqual(diskCaches(home, 'linux', '/srv/cb').find((x) => x.id === 'snapshots').paths, ['/srv/cb/cache/snapshots'])
})

test('AC-1781: ego marks links with a click handler of their own; parts and rid pass the trust rebuild', () => {
  const s = egoSnapshotScript({ name: 'cb-snapshot-x', url: 'https://example.com/', budgetMs: 1000, gotoMs: 1000 })
  assert.ok(s.includes('DOMDebugger.getEventListeners') && s.includes('data-cb-js-click') && s.includes('await markJsClicks(page)'))
  assert.ok(s.indexOf('markJsClicks(page)') < s.indexOf('page.evaluate('), 'marked before the DOM is read')
  // It is a script ego can run.
  assert.doesNotThrow(() => new Function(`return async (taskSpace) => { ${s} }`))
  assert.doesNotThrow(() => new Function(`return ${EGO_MARK_JS_CLICKS}`))
  assert.deepEqual(TRUST_CLASS.snapshot, { i: ['sid', 'url'], keep: ['parts', 'rid'] })
  const sealedUrl = '⟦bt1:0123abcd:' + 'A'.repeat(40) + '⟧'
  assert.deepEqual(rebuild({ t: 'snapshot', reqId: 'r1', sid: 'evil', url: 'https://evil/', parts: 1, rid: 'rid-0123456789', html: 'x' }, TRUST_CLASS.snapshot, { sid: 's1', url: sealedUrl }), { t: 'snapshot', reqId: 'r1', parts: 1, rid: 'rid-0123456789', sid: 's1', url: sealedUrl })
})

test('AC-1779: a sealed piece stays under the server’s 1 MiB even of quotes or Korean; big goes sealed in a whole answer', () => {
  for (const fill of ['"', '한', '\\"제목\\":\\"안녕하세요\\",']) {
    const p = snapPieces({ sid, rid, gen: 1, payload: snapPayload({ ...draw, html: fill.repeat(Math.ceil((SNAP_PIECE * 2) / fill.length)) }) })[0]
    // As trust.sealWith seals it: JSON of {d, s, v}, UTF-8, AES-GCM (+28 bytes), base64url, in ⟦bt1:…⟧.
    const inner = Buffer.byteLength(JSON.stringify({ d: 'm', s: sid, v: p }), 'utf8') + 28
    assert.ok(Math.ceil((inner * 4) / 3) + 20 < 1 << 20, `${fill}: ${inner}`)
  }
  const m = sealOut({ t: 'snapshot', reqId: 'r1', sid: 's1', ok: true, url: 'https://good/', html: '<p>x</p>', big: { 'https://good/secret.png': [1, 1] } }, (v, s) => `⟦${s}:${v}⟧`)
  assert.equal(m.big, undefined)
  assert.deepEqual(JSON.parse(m.sealed.slice(4, -1)).big, { 'https://good/secret.png': [1, 1] })
})
