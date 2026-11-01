// 세션 정리 자동 다시 계산 (REQ-F-839 rule 8, AC-1523): a burst of actions gives one run, an action during a run one
// more after it, never two at once.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRecalc } from '../../ui/src/lib/recalc.ts'

/** Timers driven by hand: `advance(ms)` runs what comes due, in order. */
function fakeTimers() {
  let now = 0
  let seq = 0
  const due = new Map()
  return {
    timers: {
      set: (fn, ms) => (due.set(++seq, { at: now + ms, fn }), seq),
      clear: (h) => due.delete(h),
    },
    async advance(ms) {
      const end = now + ms
      for (;;) {
        const next = [...due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        due.delete(next[0])
        now = next[1].at
        next[1].fn()
        await new Promise((r) => setImmediate(r))
      }
      now = end
    },
    pending: () => due.size,
  }
}

/** A run that stays open until `finish()`. */
function gatedRun() {
  const r = { calls: 0, open: 0, maxOpen: 0, gate: null, fail: false }
  r.run = () => {
    r.calls++
    r.open++
    r.maxOpen = Math.max(r.maxOpen, r.open)
    return new Promise((resolve, reject) => {
      r.gate = () => {
        r.open--
        r.gate = null
        if (r.fail) reject(new Error('x'))
        else resolve()
      }
    })
  }
  r.finish = async () => {
    r.gate?.()
    await new Promise((x) => setImmediate(x))
  }
  return r
}

test('createRecalc: three actions 500 ms apart give one run, 1,500 ms after the last', async () => {
  const t = fakeTimers()
  const r = gatedRun()
  const rc = createRecalc(r.run, 1500, t.timers)
  rc.kick()
  await t.advance(500)
  rc.kick()
  await t.advance(500)
  rc.kick()
  await t.advance(1499)
  assert.equal(r.calls, 0, '마지막 동작 뒤 1,499 ms 에는 아직')
  assert.ok(rc.busy())
  await t.advance(1)
  assert.equal(r.calls, 1, '정확히 1,500 ms 에 한 번')
  await r.finish()
  await t.advance(10_000)
  assert.equal(r.calls, 1)
  assert.equal(rc.busy(), false)
})

test('createRecalc: actions during a run give exactly one more after it, never two at once', async () => {
  const t = fakeTimers()
  const r = gatedRun()
  const rc = createRecalc(r.run, 1500, t.timers)
  rc.kick()
  await t.advance(1500)
  assert.equal(r.calls, 1)
  rc.kick()
  rc.kick()
  await t.advance(5000)
  assert.equal(r.calls, 1, '도는 중에는 새로 돌지 않음')
  assert.equal(t.pending(), 0)
  await r.finish()
  await t.advance(1499)
  assert.equal(r.calls, 1)
  await t.advance(1)
  assert.equal(r.calls, 2, '끝난 뒤 1,500 ms 에 한 번 더')
  await r.finish()
  await t.advance(10_000)
  assert.equal(r.calls, 2)
  assert.equal(r.maxOpen, 1)
})

test('createRecalc: a failed run does not stop the next; stop() drops what is waiting', async () => {
  const t = fakeTimers()
  const r = gatedRun()
  const rc = createRecalc(r.run, 1500, t.timers)
  r.fail = true
  rc.kick()
  await t.advance(1500)
  await r.finish()
  assert.equal(rc.busy(), false)
  r.fail = false
  rc.kick()
  await t.advance(1500)
  assert.equal(r.calls, 2, '실패한 뒤에도 다음 동작에 돈다')
  await r.finish()
  rc.kick()
  rc.stop()
  await t.advance(10_000)
  assert.equal(r.calls, 2, '멈추면 걸린 계산은 돌지 않는다')
  rc.kick()
  await t.advance(10_000)
  assert.equal(r.calls, 2)
})
