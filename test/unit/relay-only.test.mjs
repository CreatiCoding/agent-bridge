// The server passes conversations through and keeps none (REQ-S-069, 3b): the log and the pictures are asked of the
// session's Mac, a Mac that is away shows nothing from here, and a move carries the transcript and the log from one
// Mac to the other through memory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { startServer } from './server-harness.mjs'
import { mac } from './fake-mac.mjs'

const A = 'aaaaaaaa-0000-4000-8000-0000000000a1'
const B = 'bbbbbbbb-0000-4000-8000-0000000000b1'
const Z = 'cccccccc-0000-4000-8000-0000000000c1'
const SID = 'dddddddd-0000-4000-8000-0000000000d1'
const AWAY = 'eeeeeeee-0000-4000-8000-0000000000e1'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const IMG = `${crypto.createHash('sha1').update(Buffer.from(PNG, 'base64')).digest('hex')}.png`
const host = (name) => ({ uid: 'dev-alice', name, kind: 'other', home: '/Users/x', lastSeen: 1 })
const meta = (id, hostId) => ({ id, uid: 'dev-alice', hostId, cwd: '/w', lines: 0, seq: 3, lastAt: 1, createdAt: 1, agentLog: true, moves: [] })
const hello = (hostId, name, sessions = []) => ({ t: 'hello', caps: ['store'], version: '0.2.0', build: 'x', hostId, name, kind: 'other', home: '/Users/x', info: {}, sessions })

test('3b: 서버는 대화 사본·그림을 쓰지 않고, 기록·그림은 맥에 묻고, 맥이 없으면 409, 옮기기는 메모리로 지나간다', async () => {
  const s = await startServer({
    seed: {
      'hosts.json': { [A]: host('mac-a'), [B]: host('mac-b'), [Z]: host('mac-z') },
      [`u/dev-alice/s/${SID}/meta.json`]: meta(SID, A),
      [`u/dev-alice/s/${AWAY}/meta.json`]: meta(AWAY, Z),
    },
  })
  let a
  let b
  try {
    await s.login('alice')
    a = await mac(s, 'alice', A, 'mac-a')
    b = await mac(s, 'alice', B, 'mac-b')
    await a.up(hello(A, 'mac-a', [{ id: SID, cwd: '/w', alive: true, conv: SID, seq: 3 }]))
    await b.up(hello(B, 'mac-b'))

    // A transcript line with a picture: read into an event and let go.
    const line = JSON.stringify({ type: 'user', uuid: '11111111-1111-4111-8111-111111111111', message: { role: 'user', content: [{ type: 'text', text: '이거 봐' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] } })
    await a.up({ t: 'lines', sid: SID, from: 0, lines: [line] })
    const down = await a.next((m) => m.t === 'log' && m.sid === SID)
    assert.equal(down.events[0].seq, 4)
    assert.deepEqual(down.events[0].images, [IMG])
    const sdir = path.join(s.data, 'u/dev-alice/s', SID)
    assert.ok(!fs.readdirSync(sdir).some((f) => /^transcript|^events/.test(f)), '대화 사본·기록 파일 없음')
    assert.ok(!fs.existsSync(path.join(s.data, 'u/dev-alice/img', IMG)), '그림 파일 없음')

    // The page's log comes from the Mac, with what it has not said it kept yet.
    const page = s.api('alice', `/api/sessions/${SID}/events`)
    const ask = await a.next((m) => m.t === 'events' && m.sid === SID)
    await a.up({ t: 'events', reqId: ask.reqId, ok: true, events: [1, 2, 3].map((seq) => ({ seq, at: 1, k: 'text', text: `줄 ${seq}` })), more: false, last: 3 })
    const got = await page
    assert.equal(got.status, 200)
    assert.deepEqual(got.json.events.map((e) => e.seq), [1, 2, 3, 4])
    assert.equal(got.json.last, 4)

    // A picture: from the Mac, passed on.
    const pic = fetch(`${s.origin}/api/img/${IMG}`, { headers: { cookie: s.jar('alice') } })
    const askImg = await a.next((m) => m.t === 'img' && m.id === IMG)
    await a.up({ t: 'img', reqId: askImg.reqId, ok: true, type: 'image/png', data: PNG })
    const picRes = await pic
    assert.equal(picRes.status, 200)
    assert.equal(Buffer.from(await picRes.arrayBuffer()).toString('base64'), PNG)

    // A Mac that is away: nothing from here.
    const away = await s.api('alice', `/api/sessions/${AWAY}/events`)
    assert.equal(away.status, 409)
    assert.equal(away.json.offline, true)
    // And a session on it cannot be moved: the server has no copy to move from.
    const stuck = await s.api('alice', `/api/sessions/${AWAY}/move`, { method: 'POST', body: { hostId: A } })
    assert.equal(stuck.status, 409)
    assert.match(stuck.json.error, /연결돼 있지 않아 옮길 수 없어요/)

    // A move to another Mac: the transcript and the log pass through memory.
    const moving = s.api('alice', `/api/sessions/${SID}/move`, { method: 'POST', body: { hostId: B } })
    const flush = await a.next((m) => m.t === 'flush' && m.sid === SID)
    await a.up({ t: 'flushed', reqId: flush.reqId, ok: true })
    const exp = await a.next((m) => m.t === 'export' && m.sid === SID)
    assert.equal(exp.from, 0)
    await a.up({ t: 'export', reqId: exp.reqId, ok: true, data: Buffer.from(`${line}\n`).toString('base64'), size: line.length + 1, done: true })
    const open = await b.next((m) => m.t === 'open' && m.sid === SID)
    assert.equal(open.local, undefined)
    const copy = await fetch(`${s.origin}/api/bridge/transcript?sid=${SID}&hostId=${B}&conn=${b.conn}`, { headers: { cookie: s.jar('alice') } })
    assert.equal(copy.status, 200)
    assert.equal(await copy.text(), `${line}\n`)
    await b.up({ t: 'opened', reqId: open.reqId, ok: true, cwd: '/w', warnings: [] })
    const carry = await a.next((m) => m.t === 'events' && m.sid === SID && m.after === 0)
    await a.up({ t: 'events', reqId: carry.reqId, ok: true, events: [1, 2, 3, 4].map((seq) => ({ seq, at: 1, k: 'text', text: `줄 ${seq}` })), more: false, last: 4 })
    const landed = await b.next((m) => m.t === 'log' && m.sid === SID && m.events.length === 4)
    await b.up({ t: 'logged', lids: [landed.lid] })
    const moved = await moving
    assert.equal(moved.status, 200)
    // The notice of the move is logged on the Mac the session is on now.
    const notice = await b.next((m) => m.t === 'log' && m.sid === SID && m.events.some((e) => e.k === 'notice'))
    assert.equal(notice.events[0].seq, 5)
    await a.next((m) => m.t === 'release' && m.sid === SID)
    // Gone from memory once the move is over: nothing to hand out.
    const after = await fetch(`${s.origin}/api/bridge/transcript?sid=${SID}&hostId=${B}&conn=${b.conn}`, { headers: { cookie: s.jar('alice') } })
    assert.equal(after.status, 409)
    assert.ok(!fs.readdirSync(sdir).some((f) => /^transcript|^events/.test(f)))
  } finally {
    a?.close()
    b?.close()
    await s.stop()
  }
})
