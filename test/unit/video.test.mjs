// 영상 보내기 (REQ-F-761): the page sends a video as it is, the message names it, and the Mac's bridge tab fetches it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './server-harness.mjs'
import { mac } from './fake-mac.mjs'

test('영상: 같은 출처·영상 형식만 받고, 메시지에 실려 맥으로 가며, 연동 탭이 받아 간다 (1.201)', async () => {
  const s = await startServer()
  const A = 'aaaaaaaa-0000-4000-8000-00000000000a'
  let a
  try {
    await s.login('alice')
    a = await mac(s, 'alice', A, 'mac-a')
    const started = s.api('alice', '/api/sessions', { method: 'POST', body: { hostId: A, cwd: '~', prompt: '시작' } })
    await a.answerNew()
    const sid = (await started).json.id
    const bytes = Buffer.from('fake mp4 bytes')
    const up = (headers, body = bytes) => fetch(`${s.origin}/api/sessions/${sid}/upload?name=${encodeURIComponent('화면 녹화.mov')}`, { method: 'POST', headers: { cookie: s.jar('alice'), ...headers }, body })
    assert.equal((await up({ 'content-type': 'video/quicktime' })).status, 403, '출처 없이는 거절')
    assert.equal((await up({ 'content-type': 'text/plain', origin: s.origin })).status, 415)
    assert.equal((await up({ 'content-type': 'video/quicktime', origin: s.origin }, Buffer.alloc(0))).status, 400)
    const ok = await up({ 'content-type': 'video/quicktime', origin: s.origin })
    assert.equal(ok.status, 200)
    const j = await ok.json()
    assert.match(j.id, /^[0-9a-f]{40}\.mov$/)
    assert.equal(j.name, '화면 녹화.mov')
    assert.equal(j.size, bytes.length)
    // Someone else's id, or one that is not there, is refused; a real one goes with the message.
    assert.equal((await s.api('alice', `/api/sessions/${sid}/say`, { method: 'POST', body: { text: '봐 줘', videos: [{ id: `${'0'.repeat(40)}.mov` }] } })).status, 400)
    assert.equal((await s.api('alice', `/api/sessions/${sid}/say`, { method: 'POST', body: { text: '봐 줘', videos: [{ id: j.id }] } })).status, 200)
    const send = await a.next((m) => m.t === 'send' && m.sid === sid)
    assert.equal(send.text, '봐 줘')
    assert.deepEqual(send.videos, [{ id: j.id, name: '화면 녹화.mov', type: 'video/quicktime', size: bytes.length }])
    // The bridge tab fetches it with its connection; nobody else's tab can.
    const conn = (await s.api('alice', '/api/bridge/hello', { method: 'POST', body: { hostId: A, name: 'mac-a' } })).json.conn
    const got = await fetch(`${s.origin}/api/bridge/upload?${new URLSearchParams({ id: j.id, hostId: A, conn })}`, { headers: { cookie: s.jar('alice') } })
    assert.equal(got.status, 200)
    assert.equal(got.headers.get('content-type'), 'video/quicktime')
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes)
    assert.equal((await fetch(`${s.origin}/api/bridge/upload?${new URLSearchParams({ id: j.id, hostId: A, conn: 'nope' })}`, { headers: { cookie: s.jar('alice') } })).status, 409)
  } finally {
    a?.close()
    await s.stop()
  }
})
// The video line from the Mac ("🎬 이름") is checked in server/events_test.go.
