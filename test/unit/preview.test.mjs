// R1-M6 (리포트 #1): the local preview proxy, without a server: a pretend Mac answers its `http` command.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPreview } from '../../server/preview.mjs'

function setup({ closed = new Set() } = {}) {
  const used = []
  const asked = []
  const p = createPreview({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cb-prev-')),
    origin: 'https://bridge.test',
    port: 0,
    ask: async (h, cmd) => (asked.push(cmd), { ok: true, status: 200, headers: [['content-type', 'text/html']], body: Buffer.from('<p>app</p>').toString('base64') }),
    toHost: () => true,
    canUse: (uid, hostId, sid) => (used.push(sid), closed.has(sid) ? '세션이 끝났어요' : null),
  })
  return { p, used, asked }
}
const request = (url, headers = {}) => Object.assign((async function* () {})(), { url, method: 'GET', headers: { host: 'lp.bridge.test', ...headers } })
const response = () => {
  const r = { status: 0, headers: {}, body: '' }
  r.writeHead = (s, h = {}) => ((r.status = s), (r.headers = h), r)
  r.end = (b) => ((r.body = b ? String(b) : ''), r)
  return r
}

test("a preview page does not hand its address (with the token) to other sites as a Referer", async () => {
  const { p } = setup()
  const token = p.mint({ uid: 'u1', hostId: 'h1', port: 5173, sid: 's1' })
  const res = response()
  await p.handle(request(`/t/${token}/`), res)
  assert.equal(res.status, 200)
  assert.equal(res.headers['referrer-policy'], 'same-origin')
})

test('a preview address works only while its session does', async () => {
  const { p, used } = setup({ closed: new Set(['s-gone']) })
  const live = response()
  await p.handle(request(`/t/${p.mint({ uid: 'u1', hostId: 'h1', port: 5173, sid: 's1' })}/`), live)
  assert.equal(live.status, 200)
  assert.deepEqual(used, ['s1'])
  const gone = response()
  await p.handle(request(`/t/${p.mint({ uid: 'u1', hostId: 'h1', port: 5173, sid: 's-gone' })}/`), gone)
  assert.equal(gone.status, 503)
})

test("a preview's WebSocket is refused unless it comes from the preview origin", async () => {
  const { p } = setup()
  const token = p.mint({ uid: 'u1', hostId: 'h1', port: 5173, sid: 's1' })
  const sock = () => {
    const s = { wrote: '', destroyed: false, on() {}, end: (x) => (s.wrote += x ?? ''), write: (x) => (s.wrote += x), destroy: () => (s.destroyed = true) }
    return s
  }
  const ws = (origin) => request(`/t/${token}/`, { upgrade: 'websocket', 'sec-websocket-key': 'abc', ...(origin ? { origin } : {}) })
  const evil = sock()
  await p.upgrade(ws('https://evil.test'), evil, Buffer.alloc(0))
  assert.match(evil.wrote, /^HTTP\/1\.1 403/)
  const none = sock()
  await p.upgrade(ws(null), none, Buffer.alloc(0))
  assert.match(none.wrote, /^HTTP\/1\.1 403/)
})

// R3-L1 (리포트 #3): the hand-over secret a passed-on request carries must not reach the previewed local app.
test('the hand-over header is not passed on to a previewed app', async () => {
  const { p, asked } = setup()
  const res = response()
  await p.handle(request(`/t/${p.mint({ uid: 'u1', hostId: 'h1', port: 5173, sid: 's1' })}/`, { 'x-bridge-handover': 'secret' }), res)
  assert.equal(res.status, 200)
  assert.equal(asked[0].headers['x-bridge-handover'], undefined)
})

// R1-M6 (리포트 #1 나머지): each session's previews on one origin of a pool, so previews of different sessions do not
// share storage and cookies.
test('previews go to a pool of origins by session, and a token works only on its own origin', async () => {
  const { poolCandidates } = await import('../../server/preview.mjs')
  assert.deepEqual(poolCandidates('https://bridge.example.com', {}).slice(0, 2), ['https://lp1-bridge.example.com', 'https://lp2-bridge.example.com'])
  assert.deepEqual(poolCandidates('http://localhost:4300', {}), [])
  const reach = new Set(['https://lp3-bridge.test', 'https://lp5-bridge.test'])
  const p = createPreview({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cb-pool-')), origin: 'https://bridge.test', port: 0, ask: async () => ({ ok: true, status: 200, headers: [['content-type', 'text/html']], body: '' }), toHost: () => true, canUse: () => null, probe: async (o) => reach.has(o) })
  // Before the pool is known: the main origin, as before.
  assert.match(p.url({ uid: 'u1', hostId: 'h1', port: 1, sid: 's-a' }), /^https:\/\/lp\.bridge\.test\/t\//)
  assert.deepEqual(await p.probePool(), ['https://lp3-bridge.test', 'https://lp5-bridge.test'])
  const hosts = new Set(Array.from({ length: 20 }, (_, i) => new URL(p.url({ uid: 'u1', hostId: 'h1', port: 1, sid: `s-${i}` })).host))
  assert.deepEqual([...hosts].sort(), ['lp3-bridge.test', 'lp5-bridge.test'], '세션들이 묶음 안에서 나뉨')
  const u = new URL(p.url({ uid: 'u1', hostId: 'h1', port: 1, sid: 's-x' }))
  assert.equal(new URL(p.url({ uid: 'u1', hostId: 'h1', port: 2, sid: 's-x' })).host, u.host, '같은 세션은 같은 출처')
  const on = (host) => {
    const res = response()
    return p.handle(Object.assign((async function* () {})(), { url: u.pathname, method: 'GET', headers: { host } }), res).then(() => res.status)
  }
  assert.equal(await on(u.host), 200)
  assert.equal(await on('lp.bridge.test'), 403, '다른 출처에서는 그 토큰이 통하지 않음')
  const other = [...hosts].find((h) => h !== u.host)
  assert.equal(await on(other), 403)
  // R5-L3: the probe's answer is for its one-time number only; nothing without one.
  const robots = async (q) => {
    const res = response()
    await p.handle(Object.assign((async function* () {})(), { url: `/robots.txt${q}`, method: 'GET', headers: { host: u.host } }), res)
    return res.headers['x-bridge-preview']
  }
  assert.equal(await robots(''), undefined)
  const a1 = await robots(`?n=${'a'.repeat(24)}`)
  const a2 = await robots(`?n=${'b'.repeat(24)}`)
  assert.ok(a1 && a2 && a1 !== a2)
})

// R5 의 R1-M6, R7-M2: sessions are given origins no other session holds; a token works only while its session holds
// the origin it names; the hold outlives a restart.
test('recent sessions get different origins, a token dies with its hold, and holds outlive a restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-give-'))
  let clock = 1_000_000
  const make = () => createPreview({ dataDir, origin: 'https://bridge.test', port: 0, ask: async () => ({ ok: true, status: 200, headers: [], body: '' }), toHost: () => true, canUse: () => null, probe: async (o) => /lp[1-3]-/.test(o), now: () => clock })
  const p = make()
  await p.probePool()
  const tick = () => (clock += 120_000)
  const link = (sid) => (tick(), new URL(p.url({ uid: 'u', hostId: 'h', port: 1, sid })))
  const status = async (q, u) => {
    const res = response()
    await q.handle(Object.assign((async function* () {})(), { url: u.pathname, method: 'GET', headers: { host: u.host } }), res)
    return res.status
  }
  const [a, b, c] = [link('a'), link('b'), link('c')]
  assert.equal(new Set([a.host, b.host, c.host]).size, 3, '세 세션이 세 출처')
  assert.equal(link('a').host, a.host, '같은 세션은 같은 출처')
  tick()
  assert.equal(await status(p, c), 200, 'c 를 씀')
  // b is now the one used longest ago: d takes b's origin, and b's address stops working there.
  const d = link('d')
  assert.equal(d.host, b.host)
  assert.equal(await status(p, b), 403, '넘겨준 출처에서 옛 토큰은 안 통함')
  assert.equal(await status(p, d), 200)
  // A restart over the same data keeps the holds (written a moment later).
  await new Promise((r) => setTimeout(r, 1200))
  const q = make()
  await q.probePool()
  assert.equal(await status(q, d), 200, '재시작 뒤에도 d 의 주소')
  assert.equal(await status(q, b), 403)
  tick()
  assert.equal(new URL(q.url({ uid: 'u', hostId: 'h', port: 1, sid: 'a' })).host, a.host, '재시작 뒤에도 a 는 같은 출처')
})

// R7-L2 (리포트 #7): the probe's answer is bound to the host it was asked as.
test("a preview origin's probe answer differs per host for the same number", async () => {
  const p = createPreview({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cb-host-')), origin: 'https://bridge.test', port: 0, ask: async () => ({}), toHost: () => true, canUse: () => null, probe: async () => true })
  const ask = async (host) => {
    const res = response()
    await p.handle(Object.assign((async function* () {})(), { url: `/robots.txt?n=${'c'.repeat(24)}`, method: 'GET', headers: { host } }), res)
    return res.headers['x-bridge-preview']
  }
  const main = await ask('lp.bridge.test')
  const one = await ask('lp1-bridge.test')
  assert.ok(main && one && main !== one)
})

// R8-L1 (리포트 #8): two servers over one data folder (a deploy) each wrote their own holds over the other's.
test("two servers over one data folder keep each other's holds", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-two-'))
  const make = () => createPreview({ dataDir, origin: 'https://bridge.test', port: 0, ask: async () => ({ ok: true, status: 200, headers: [], body: '' }), toHost: () => true, canUse: () => null, probe: async (o) => /lp[1-3]-/.test(o) })
  const oldOne = make()
  const newOne = make()
  await oldOne.probePool()
  await newOne.probePool()
  const a = new URL(oldOne.url({ uid: 'u', hostId: 'h', port: 1, sid: 'sA' }))
  await new Promise((r) => setTimeout(r, 1200))
  newOne.url({ uid: 'u', hostId: 'h', port: 1, sid: 'sB' })
  await new Promise((r) => setTimeout(r, 1200))
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'preview-given.json'), 'utf8'))
  assert.ok(saved.sA && saved.sB, '두 서버의 배정이 모두 남음')
  const third = make()
  await third.probePool()
  const res = response()
  await third.handle(Object.assign((async function* () {})(), { url: a.pathname, method: 'GET', headers: { host: a.host } }), res)
  assert.equal(res.status, 200, '옛 서버가 준 주소가 다음 서버에서도 통함')
})

// R9-M1 (리포트 #9): merging with the file before a save brought an evicted hold back, and the evicted session's old
// address worked again a second later, sharing the origin with the session that took it.
test("an evicted session's address stays dead after the holds are saved again", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-evict-'))
  let clock = 1_000_000
  const p = createPreview({ dataDir, origin: 'https://bridge.test', port: 0, ask: async () => ({ ok: true, status: 200, headers: [], body: '' }), toHost: () => true, canUse: () => null, probe: async (o) => /lp[1-3]-/.test(o), now: () => clock })
  await p.probePool()
  const link = (sid) => ((clock += 120_000), new URL(p.url({ uid: 'u', hostId: 'h', port: 1, sid })))
  const status = async (u) => {
    const res = response()
    await p.handle(Object.assign((async function* () {})(), { url: u.pathname, method: 'GET', headers: { host: u.host } }), res)
    return res.status
  }
  const [, b] = [link('a'), link('b'), link('c')]
  await new Promise((r) => setTimeout(r, 1300))
  link('a')
  link('c')
  const d = link('d')
  assert.equal(d.host, b.host)
  assert.equal(await status(b), 403)
  await new Promise((r) => setTimeout(r, 1300))
  assert.equal(await status(b), 403, '다음 저장 뒤에도 쫓겨난 주소는 안 통함')
  assert.equal(await status(d), 200)
})

// R10-L2 (리포트 #10): with two servers serving at once, a use of the old address through the one that did not know
// of the eviction must not undo the tombstone in the merge.
test('a tombstone is undone only by giving the session an origin again, not by a use elsewhere', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-tomb-'))
  let clock = 1_000_000
  const make = () => createPreview({ dataDir, origin: 'https://bridge.test', port: 0, ask: async () => ({ ok: true, status: 200, headers: [], body: '' }), toHost: () => true, canUse: () => null, probe: async (o) => /lp[1-3]-/.test(o), now: () => clock })
  const one = make()
  await one.probePool()
  const link = (q, sid) => ((clock += 120_000), new URL(q.url({ uid: 'u', hostId: 'h', port: 1, sid })))
  const status = async (q, u) => {
    const res = response()
    await q.handle(Object.assign((async function* () {})(), { url: u.pathname, method: 'GET', headers: { host: u.host } }), res)
    return res.status
  }
  const [, b] = [link(one, 'a'), link(one, 'b'), link(one, 'c')]
  await new Promise((r) => setTimeout(r, 1300))
  // A second server reads the holds now (b still holds), then the first evicts b for d.
  const two = make()
  await two.probePool()
  link(one, 'a')
  link(one, 'c')
  link(one, 'd')
  await new Promise((r) => setTimeout(r, 1300))
  // The second, not knowing, lets b's old address through once and saves.
  clock += 120_000
  assert.equal(await status(two, b), 200)
  await new Promise((r) => setTimeout(r, 1300))
  const three = make()
  await three.probePool()
  assert.equal(await status(three, b), 403, '사용만으로는 묘비가 되살아나지 않음')
})
