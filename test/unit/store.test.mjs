// The session logs kept on the Mac (REQ-S-069) and the statistics worked out there as numbers (REQ-S-070).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventStore, saveLineImages, imageId } from '../../agent/store.mjs'
import { sessionStats, addStats, cleanStats, prLinks } from '../../agent/stats.mjs'
import { startServer } from './server-harness.mjs'
import { mac } from './fake-mac.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cb-store-'))
const SID = 'dddddddd-0000-4000-8000-00000000000d'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

test('EventStore: 순서가 뒤섞이거나 두 번 온 이벤트도 seq 순서로 하나씩, 쪽 나누기·복제', () => {
  const dir = tmp()
  try {
    const st = new EventStore(dir)
    st.append(SID, [{ seq: 3, k: 'text', text: 'c' }, { seq: 4, k: 'card', card: {} }])
    st.append(SID, [{ seq: 1, k: 'user', text: 'a' }, { seq: 2, k: 'text', text: 'b' }])
    st.append(SID, [{ seq: 2, k: 'text', text: 'b' }, { k: 'bad' }])
    assert.deepEqual(st.all(SID).map((e) => e.seq), [1, 2, 3, 4])
    st.append(SID, [{ seq: 5, k: 'react' }])
    assert.equal(st.lastSeq(SID), 5)
    assert.deepEqual(st.page(SID, { limit: 2 }), { events: st.all(SID).slice(-2), more: true })
    assert.deepEqual(st.page(SID, { after: 3 }).events.map((e) => e.seq), [4, 5])
    assert.deepEqual(st.page(SID, { before: 3 }).events.map((e) => e.seq), [1, 2])
    const COPY = 'eeeeeeee-0000-4000-8000-00000000000e'
    st.copy(SID, COPY, 4)
    assert.deepEqual(st.all(COPY).map((e) => e.seq), [1, 2, 3])
    assert.deepEqual(st.list().sort(), [SID, COPY].sort())
    st.remove(SID)
    assert.deepEqual(st.all(SID), [])
    assert.equal(st.append('../x', [{ seq: 1 }]), 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('saveLineImages: transcript 줄의 그림을 서버와 같은 id(sha1.확장자)로 둔다', () => {
  const dir = tmp()
  try {
    const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] }] } })
    assert.equal(saveLineImages(line, dir), 1)
    const id = `${crypto.createHash('sha1').update(Buffer.from(PNG, 'base64')).digest('hex')}.png`
    assert.equal(imageId('image/png', PNG).id, id)
    assert.deepEqual(fs.readdirSync(dir), [id])
    assert.equal(saveLineImages(line, dir), 0, '이미 있으면 다시 쓰지 않음')
    assert.equal(saveLineImages('{"type":"user"}', dir), 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('통계: 맥이 보낸 숫자로 더한 결과가 서버가 기록에서 세던 것과 같다', async () => {
  const H = 3_600_000
  const now = Date.now()
  const base = now - 3 * 86_400_000 - (now % H)
  const ev = []
  let seq = 0
  const add = (at, e) => ev.push({ seq: ++seq, at, ...e })
  add(base, { k: 'user', text: '시작 https://github.com/o/r/pull/7' })
  add(base + 1000, { k: 'status', phase: 'busy' })
  add(base + 2000, { k: 'tool', tool: 't1', name: 'Bash' })
  add(base + 3000, { k: 'card', card: { kind: 'permission' } })
  add(base + 60_000, { k: 'status', phase: 'idle' })
  add(base + H + 5, { k: 'user', text: '다음' })
  add(base + H + 10, { k: 'status', phase: 'busy' })
  add(base + H + 20, { k: 'tool', tool: 't2', name: 'Edit' })
  add(base + H + 40 * 60_000, { k: 'status', phase: 'idle' })
  add(base + 2 * H, { k: 'text', text: 'PR https://github.com/o/r/pull/9 올림' })
  const s = await startServer({ seed: { [`u/dev-alice/s/${SID}/meta.json`]: { id: SID, uid: 'dev-alice', hostId: 'h', cwd: '/w', lines: 0, seq, lastAt: base + 2 * H, createdAt: base }, [`u/dev-alice/s/${SID}/events.jsonl`]: ev.map((e) => `${JSON.stringify(e)}\n`).join('') } })
  try {
    await s.login('alice')
    const got = (await s.api('alice', '/api/stats?days=7')).json
    const mine = addStats([{ stats: cleanStats(JSON.parse(JSON.stringify(sessionStats(ev, now)))), cwd: '/w', id: SID }], 7, now)
    for (const k of ['totals', 'turns', 'tools', 'permissions', 'heat', 'topTools', 'topFolders']) assert.deepEqual(mine[k], got[k], k)
    assert.deepEqual(mine.daily.map((d) => [d.day, d.workMs, d.mine, d.sessions]), got.daily.map((d) => [d.day, d.workMs, d.mine, d.sessions]))
    assert.deepEqual(prLinks(ev), ['https://github.com/o/r/pull/9', 'https://github.com/o/r/pull/7'])
  } finally {
    await s.stop()
  }
})

test('3a: 맥이 기록을 맡을 수 있으면 서버가 있던 기록·그림을 보내고, 새 이벤트도 내려보내며, 받았다는 말을 들을 때까지 다시 보낸다', async () => {
  const A = 'aaaaaaaa-0000-4000-8000-00000000000a'
  const img = `${crypto.createHash('sha1').update(Buffer.from(PNG, 'base64')).digest('hex')}.png`
  const events = Array.from({ length: 1203 }, (_, i) => ({ seq: i + 1, at: 1, k: 'text', text: `줄 ${i + 1}` }))
  events[5] = { seq: 6, at: 1, k: 'user', text: '그림', images: [img] }
  const s = await startServer({
    seed: {
      'hosts.json': { [A]: { uid: 'dev-alice', name: 'mac-a', kind: 'other', home: '/Users/x', lastSeen: 1 } },
      [`u/dev-alice/s/${SID}/meta.json`]: { id: SID, uid: 'dev-alice', hostId: A, cwd: '/w', lines: 0, seq: 1203, lastAt: 1, createdAt: 1 },
      [`u/dev-alice/s/${SID}/events.jsonl`]: events.map((e) => `${JSON.stringify(e)}\n`).join(''),
    },
  })
  let a
  try {
    fs.mkdirSync(path.join(s.data, 'u/dev-alice/img'), { recursive: true })
    fs.writeFileSync(path.join(s.data, 'u/dev-alice/img', img), Buffer.from(PNG, 'base64'))
    await s.login('alice')
    a = await mac(s, 'alice', A, 'mac-a')
    await a.up({ t: 'hello', caps: ['store'], version: '0.2.0', build: 'x', hostId: A, name: 'mac-a', kind: 'other', home: '/Users/x', info: {}, sessions: [] })
    const got = []
    // The first hand-over is not answered: it comes again after the next hello.
    const first = await a.next((m) => m.t === 'log' && m.sid === SID)
    assert.equal(first.events[0].seq, 1)
    got.push(...first.events)
    await a.up({ t: 'hello', caps: ['store'], version: '0.2.0', build: 'x', hostId: A, name: 'mac-a', kind: 'other', home: '/Users/x', info: {}, sessions: [] })
    let pic = null
    for (let i = 0; i < 20 && !pic; i++) {
      const m = await a.next((x) => (x.t === 'log' && x.sid === SID) || x.t === 'putimg')
      if (m.t === 'putimg') pic = m
      else got.push(...m.events)
      await a.up({ t: 'logged', lids: [m.lid] })
    }
    // The one sent again is answered now.
    await a.up({ t: 'logged', lids: [first.lid] })
    const seqs = [...new Set(got.map((e) => e.seq))].sort((x, y) => x - y)
    assert.equal(seqs.length, 1203)
    assert.equal(pic.id, img)
    assert.equal(pic.data, PNG)
    await new Promise((r) => setTimeout(r, 6000))
    const meta = JSON.parse(fs.readFileSync(path.join(s.data, `u/dev-alice/s/${SID}/meta.json`), 'utf8'))
    assert.equal(meta.agentLog, true)
    // A new event goes down too, numbered after the old ones.
    await a.up({ t: 'note', sid: SID, text: '새 줄' })
    const live = await a.next((m) => m.t === 'log' && m.sid === SID && m.events.some((e) => e.k === 'notice'))
    assert.equal(live.events[0].seq, 1204)
    // Numbers from the Mac are kept and never sent to the page.
    await a.up({ t: 'stats', sid: SID, stats: { spans: [[1, 2]], open: null, lastAt: 2, hours: {} }, prs: ['https://github.com/o/r/pull/1', 'javascript:x'] })
    await new Promise((r) => setTimeout(r, 6000))
    const m2 = JSON.parse(fs.readFileSync(path.join(s.data, `u/dev-alice/s/${SID}/meta.json`), 'utf8'))
    assert.deepEqual(m2.prLinks, ['https://github.com/o/r/pull/1'])
    assert.deepEqual(m2.stats.spans, [[1, 2]])
  } finally {
    a?.close()
    await s.stop()
  }
})
