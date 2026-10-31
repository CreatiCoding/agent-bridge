// A bridge stream that drops and comes back within the grace (REQ-F-831) does not show the Mac as disconnected and
// leaves no warning; one that stays away does, and a tab that says goodbye shows as gone at once.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './server-harness.mjs'
import { mac } from './fake-mac.mjs'

const A = 'aaaaaaaa-0000-4000-8000-0000000000a7'
const B = 'bbbbbbbb-0000-4000-8000-0000000000b7'
const hello = (hostId, name) => ({ t: 'hello', caps: ['store'], version: '0.2.0', build: 'x', hostId, name, kind: 'other', home: '/Users/x', info: {}, sessions: [] })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('연동 스트림이 잠깐 끊겼다 다시 붙으면 끊김으로 보이지 않고, 유예가 지나면·작별하면 끊김', async () => {
  const s = await startServer({ env: { BRIDGE_LINK_GRACE_MS: '1500' } })
  try {
    await s.login('alice')
    const a = await mac(s, 'alice', A, 'mac-a')
    await a.up(hello(A, 'mac-a'))
    const shown = async (id) => (await s.api('alice', `/api/hosts/${id}/status`)).json.host.online
    const warns = async (id) => (await s.api('alice', `/api/hosts/${id}/logs?level=warn`)).json.entries.filter((e) => e.area === 'link').map((e) => e.text)
    const infos = async (id) => (await s.api('alice', `/api/hosts/${id}/logs`)).json.entries.filter((e) => e.area === 'link').map((e) => e.text)
    const reopen = async (m, id) => {
      const r = await fetch(`${s.origin}/api/bridge/stream?hostId=${id}&conn=${m.conn}`, { headers: { cookie: s.jar('alice') } })
      assert.equal(r.status, 200)
      const reader = r.body.getReader()
      const first = new TextDecoder().decode((await reader.read()).value)
      return { reader, first }
    }

    // The stream drops: still shown as connected, nothing logged as a disconnect yet.
    await a.close()
    await sleep(300)
    assert.equal(await shown(A), true, '끊긴 직후에도 연결로 보임')
    assert.deepEqual(await warns(A), [])

    // Back within the grace: a short drop in the log, never a warning.
    const back = await reopen(a, A)
    await sleep(200)
    assert.equal(await shown(A), true)
    assert.deepEqual(await warns(A), [])
    assert.ok((await infos(A)).some((t) => /^연동 페이지가 \d+\.\d초 끊겼다가 다시 연결됨$/.test(t)), JSON.stringify(await infos(A)))

    // The page is told to reconnect in 1 s, not EventSource's 3 s.
    const again = await reopen(a, A)
    assert.match(again.first + new TextDecoder().decode((await again.reader.read()).value ?? new Uint8Array()), /retry: 1000/)
    await back.reader.cancel().catch(() => {})

    // Away past the grace: shown as disconnected and logged once.
    await again.reader.cancel().catch(() => {})
    await sleep(400)
    assert.equal(await shown(A), true, '유예 안에서는 연결로 보임')
    await sleep(1800)
    assert.equal(await shown(A), false, '유예가 지나면 끊김')
    assert.deepEqual(await warns(A), ['연동 페이지와의 연결이 끊김'])

    // A tab that says goodbye is gone at once, without the grace.
    const b = await mac(s, 'alice', B, 'mac-b')
    await b.up(hello(B, 'mac-b'))
    assert.equal(await shown(B), true)
    const bye = await s.api('alice', '/api/bridge/bye', { method: 'POST', body: { hostId: B, conn: b.conn } })
    assert.equal(bye.status, 200)
    await sleep(300)
    assert.equal(await shown(B), false, '작별한 탭은 바로 끊김')
    assert.ok((await warns(B)).includes('연동 페이지와의 연결이 끊김'))
  } finally {
    await s.stop()
  }
})
