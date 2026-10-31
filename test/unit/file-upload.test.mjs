// 파일 보내기 (REQ-F-830): any file, not only pictures and videos, goes up as it is and reaches the Mac like a video.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './server-harness.mjs'
import { mac } from './fake-mac.mjs'
import { lineToEvents } from '../../server/events.mjs'

test('파일: octet-stream 으로 올리면 .bin id 로 받고, 메시지에 📎 로 남고 맥에 형식과 함께 간다. 제보는 영상만 (1.369)', async () => {
  const s = await startServer()
  const A = 'aaaaaaaa-0000-4000-8000-00000000000a'
  let a
  try {
    await s.login('alice')
    a = await mac(s, 'alice', A, 'mac-a')
    const started = s.api('alice', '/api/sessions', { method: 'POST', body: { hostId: A, cwd: '~', prompt: '시작' } })
    await a.answerNew()
    const sid = (await started).json.id
    const bytes = Buffer.from('%PDF-1.7 fake')
    const up = (where, headers, body = bytes) => fetch(`${s.origin}${where}?name=${encodeURIComponent('보고서.pdf')}`, { method: 'POST', headers: { cookie: s.jar('alice'), ...headers }, body })
    assert.equal((await up(`/api/sessions/${sid}/upload`, { 'content-type': 'application/octet-stream' })).status, 403, '출처 없이는 거절')
    assert.equal((await up(`/api/sessions/${sid}/upload`, { 'content-type': 'application/octet-stream', origin: s.origin }, Buffer.alloc(0))).status, 400)
    // A report shows its videos in <video>: it takes no other file.
    assert.equal((await up('/api/reports/upload', { 'content-type': 'application/octet-stream', origin: s.origin })).status, 415)
    const ok = await up(`/api/sessions/${sid}/upload`, { 'content-type': 'application/octet-stream', origin: s.origin })
    assert.equal(ok.status, 200)
    const j = await ok.json()
    assert.match(j.id, /^[0-9a-f]{40}\.bin$/)
    assert.equal(j.name, '보고서.pdf')
    assert.equal((await s.api('alice', `/api/sessions/${sid}/say`, { method: 'POST', body: { text: '읽어 줘', videos: [{ id: j.id }] } })).status, 200)
    const send = await a.next((m) => m.t === 'send' && m.sid === sid)
    assert.equal(send.text, '읽어 줘')
    assert.deepEqual(send.videos, [{ id: j.id, name: '보고서.pdf', type: 'application/octet-stream', size: bytes.length }])
    const conn = (await s.api('alice', '/api/bridge/hello', { method: 'POST', body: { hostId: A, name: 'mac-a' } })).json.conn
    const got = await fetch(`${s.origin}/api/bridge/upload?${new URLSearchParams({ id: j.id, hostId: A, conn })}`, { headers: { cookie: s.jar('alice') } })
    assert.equal(got.status, 200)
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes)
  } finally {
    a?.close()
    await s.stop()
  }
})

test('파일: 맥에서 돌아온 [Attached file: …] 줄은 "📎 이름" 으로 보인다 (1.369)', () => {
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: '읽어 줘\n[Attached file: /Users/me/.claude-bridge/images/0123abcd-보고서.pdf]' } })
  const [e] = lineToEvents(line)
  assert.equal(e.k, 'user')
  assert.equal(e.text, '읽어 줘\n📎 보고서.pdf')
})
