// 휴면은 claude 를 내린다 (REQ-F-501, 1.396): a Mac played by this test through the bridge tab's routes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './server-harness.mjs'
import { mac } from './fake-mac.mjs'
import { DAY_MS, idleStopWhy, restAct, restStoppedText } from '../../agent/guard.mjs'

const NOW = Date.parse('2026-11-02T12:00:00Z')

/** The first whole state a page gets on its stream. */
async function stateOf(s, who) {
  await new Promise((r) => setTimeout(r, 150)) // what was just sent up is applied
  const res = await fetch(`${s.origin}/api/classic/stream`, { headers: { cookie: s.jar(who) } })
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    for (const end = Date.now() + 5000; Date.now() < end; ) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      for (const line of buf.split('\n')) {
        if (!line.startsWith('data: ')) continue
        try {
          const m = JSON.parse(line.slice(6))
          if (m.t === 'state' && Array.isArray(m.sessions)) return m
        } catch {}
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  throw new Error('state 가 오지 않음')
}

test('휴면 (AC-1545~AC-1547, AC-1549): claude 를 내리고, 일하는 중이면 막고, 깨우면 같은 대화로 다시 띄운다', async () => {
  const s = await startServer()
  const H = 'aaaaaaaa-0000-4000-8000-0000000000c1'
  let m
  try {
    await s.login('alice')
    m = await mac(s, 'alice', H, 'mac')
    const started = s.api('alice', '/api/sessions', { method: 'POST', body: { hostId: H, cwd: '~', prompt: '시작' } })
    await m.answerNew()
    const sid = (await started).json.id
    const set = (body) => s.api('alice', `/api/sessions/${sid}/settings`, { method: 'POST', body })
    const meta = async () => (await stateOf(s, 'alice')).sessions?.find((x) => x.id === sid)
    await m.up({ t: 'status', sid, alive: true, phase: 'busy' })

    // Working: the Mac says why, nothing changes (AC-1546).
    const busy = set({ resting: true })
    const ask1 = await m.next((x) => x.t === 'tidyStop')
    assert.deepEqual(ask1.sids, [sid])
    assert.equal(ask1.rest, true)
    assert.equal(ask1.holds[sid].locked, false)
    await m.up({ t: 'tidyStop', reqId: ask1.reqId, ok: true, results: [{ sid, ok: false, error: '작업 중' }] })
    const r1 = await busy
    assert.equal(r1.status, 409)
    assert.equal(r1.json.error, '작업 중이라 지금은 휴면할 수 없어요. 턴이 끝난 뒤에 해 주세요')
    assert.equal((await meta())?.resting ?? false, false)

    // Idle: stopped, marked, not ended (AC-1545).
    await m.up({ t: 'status', sid, alive: true, phase: 'idle' })
    const idle = set({ resting: true })
    const ask2 = await m.next((x) => x.t === 'tidyStop')
    await m.up({ t: 'tidyStop', reqId: ask2.reqId, ok: true, results: [{ sid, ok: true }] })
    assert.equal((await idle).status, 200)
    await m.up({ t: 'status', sid, alive: false, phase: 'ended' })
    let row = await meta()
    assert.equal(row.resting, true)
    assert.ok(!row.closed, '끝난 세션이 아님')

    // Woken: claude starts again on the same conversation, in the background (AC-1547).
    assert.equal((await set({ resting: false })).status, 200)
    const open = await m.next((x) => x.t === 'open')
    assert.equal(open.sid, sid)
    assert.equal(open.conv, sid, '같은 대화로 resume')
    assert.equal(open.local, true)
    await m.up({ t: 'opened', reqId: open.reqId, sid, ok: true, cwd: '/Users/x' })
    await m.up({ t: 'status', sid, alive: true, phase: 'idle' })
    row = await meta()
    assert.equal(row.resting ?? false, false)

    // Down already: only the mark, the Mac is not asked (AC-1549).
    await m.up({ t: 'status', sid, alive: false, phase: 'ended' })
    assert.equal((await set({ resting: true })).status, 200)
    assert.equal((await meta()).resting, true)
    await assert.rejects(m.next((x) => x.t === 'tidyStop', 500))

    // A light copy done: the original's claude goes too; held, it is only marked (AC-1550).
    for (const [answer, down] of [[{ ok: true }, true], [{ ok: false, error: '작업 중' }, false]]) {
      await set({ resting: false })
      const reopen = await m.next((x) => x.t === 'open')
      await m.up({ t: 'opened', reqId: reopen.reqId, sid, ok: true, cwd: '/Users/x' })
      await m.up({ t: 'status', sid, alive: true, phase: 'idle' })
      await new Promise((r) => setTimeout(r, 200))
      assert.equal((await s.api('alice', `/api/sessions/${sid}/do`, { method: 'POST', body: { cmd: 'lightfork', arg: down ? '' : 'shrink' } })).status, 200)
      const lf = await m.next((x) => x.t === 'lightfork')
      await m.up({ t: 'opened', reqId: lf.reqId, sid: lf.newSid, ok: true, cwd: '/Users/x' })
      const stop = await m.next((x) => x.t === 'tidyStop')
      assert.deepEqual(stop.sids, [sid])
      assert.equal(stop.rest, true)
      await m.up({ t: 'tidyStop', reqId: stop.reqId, ok: true, results: [{ sid, ...answer }] })
      if (down) await m.up({ t: 'status', sid, alive: false, phase: 'ended' })
      assert.equal((await meta()).resting, true, down ? '내리고 휴면' : '막혀도 휴면 표시')
    }
  } finally {
    m?.close()
    await s.stop()
  }
})

test('휴면 (AC-1546·AC-1548): 손으로 내리기는 일하는 세션을 막고, 휴면 세션은 다시 휴면·끝내기 제안에 오르지 않는다', () => {
  const base = { alive: true, lastHumanAt: NOW - DAY_MS, favorite: true, keepAlive: true }
  // By hand: the days, the favourite and the pin do not count; the work does.
  assert.equal(idleStopWhy(base, NOW, { mode: 'off' }, true).act, 'stop')
  for (const [k, why] of [['turn', '작업 중'], ['waiting', '확인을 기다리는 중'], ['delegate', '맡긴 일을 기다리는 중'], ['reportAuto', '자동 대응 중'], ['changing', '바뀌는 중']]) {
    assert.deepEqual(idleStopWhy({ ...base, [k]: true }, NOW, { mode: 'auto' }, true), { act: null, why, stopAt: null }, k)
  }
  assert.equal(idleStopWhy({ ...base, alive: false }, NOW, { mode: 'auto' }, true).why, '이미 claude 가 내려가 있어요')
  // Rested and down: not rested again; offered to be closed only at 30 days, never closed by itself.
  const p = { mode: 'auto', restDays: 7, closeSuggestDays: 30 }
  assert.deepEqual(restAct({ alive: false, resting: true, lastHumanAt: NOW - 8 * DAY_MS }, NOW, p), { rest: false, close: false })
  assert.match(restStoppedText, /^💤 휴면으로 두어 claude 를 내렸어요\. 대화와 폴더는 남고, 열면 이어서 시작해요\.$/)
})
