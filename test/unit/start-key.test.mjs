// 새 세션 화면의 시작 키 (REQ-F-875): the form's answer lost on the way left it up, and a second press started the
// same session twice (2026-11-06). The same startKey now gets the session the first press made.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './server-harness.mjs'
import { mac } from './fake-mac.mjs'

test('시작 키: 만드는 중에 또 누르면 409, 만든 뒤에 또 누르면 그 세션, 맥에는 new 가 한 번만 (AC-1652)', async () => {
  const s = await startServer()
  const A = 'aaaaaaaa-0000-4000-8000-00000000000a'
  let a
  try {
    await s.login('alice')
    a = await mac(s, 'alice', A, 'mac-a')
    const body = { hostId: A, cwd: '~', prompt: '잠귀 조사해서 리포트 발행해', startKey: 'k-1' }
    const first = s.api('alice', '/api/sessions', { method: 'POST', body })
    const asked = await a.next((m) => m.t === 'new')
    // The Mac has not answered yet: the same key again is refused, not started.
    const during = await s.api('alice', '/api/sessions', { method: 'POST', body })
    assert.equal(during.status, 409)
    assert.match(during.json.error, /시작하는 중/)
    await a.up({ t: 'opened', reqId: asked.reqId, sid: asked.sid, ok: true, cwd: '/Users/x' })
    const sid = (await first).json.id
    assert.equal(sid, asked.sid)
    // The answer was lost and the form pressed again: the session already made, nothing sent to the Mac.
    const again = await s.api('alice', '/api/sessions', { method: 'POST', body })
    assert.equal(again.status, 200)
    assert.equal(again.json.id, sid)
    await assert.rejects(a.next((m) => m.t === 'new', 500))
    // Another key (the words changed, or another start) is another session.
    const other = s.api('alice', '/api/sessions', { method: 'POST', body: { ...body, startKey: 'k-2' } })
    const m2 = await a.answerNew()
    assert.equal((await other).json.id, m2.sid)
    assert.notEqual(m2.sid, sid)
  } finally {
    a?.close()
    await s.stop()
  }
})
