// REQ-F-858 (AC-1612): the app rail's Claude and Codex limits come from each runner's latest session.
import test from 'node:test'
import assert from 'node:assert/strict'
import { railUsage, untilReset } from '../../ui/src/lib/rail-usage.ts'

const usage = (fiveHour, week, extra = {}) => ({ context: 10, window: null, fiveHour, week, cost: null, fiveHourResetsAt: null, weekResetsAt: null, ...extra })
const sess = (id, updatedAt, runner, u) => ({ id, updatedAt, title: id, preview: '', ...(runner ? { runner } : {}), state: { usage: u } })

test('railUsage: the latest session per runner, Claude first, runners without limits left out', () => {
  const now = 1_000_000
  const list = railUsage(
    [sess('old', 1, undefined, usage(90, 50)), sess('new', 5, 'claude', usage(12, 40)), sess('cx', 3, 'codex', usage(7, null)), sess('ctx-only', 9, undefined, usage(null, null))],
    now,
  )
  assert.deepEqual(
    list.map((r) => [r.id, r.fiveHour?.pct ?? null, r.week?.pct ?? null, r.from]),
    [
      ['claude', 12, 40, 'new'],
      ['codex', 7, null, 'cx'],
    ],
  )
  assert.deepEqual(railUsage([sess('a', 1, 'claude', usage(null, null))], now), [])
})

test('railUsage: a limit past its reset time is shown as full again (0)', () => {
  const now = 1_000_000
  const [r] = railUsage([sess('a', 1, undefined, usage(80, 60, { fiveHourResetsAt: now - 1, weekResetsAt: now + 1 }))], now)
  assert.equal(r.fiveHour.pct, 0)
  assert.equal(r.week.pct, 60)
  assert.equal(r.week.resetsAt, now + 1)
})

// AC-1615: a quiet session keeps an old, lower snapshot; the touched-last session is not the measured-last one.
test('railUsage: in the current window the highest value wins, not the latest-updated session', () => {
  const now = 1_000_000_000
  const week = now + 3 * 86_400_000
  const [r] = railUsage(
    [
      sess('fresh-touch', 9, 'claude', usage(null, 70, { weekResetsAt: week + 60_000 })),
      sess('measured', 2, 'claude', usage(null, 84, { weekResetsAt: week })),
    ],
    now,
  )
  assert.equal(r.week.pct, 84)
  assert.equal(r.from, 'measured')
})

test('railUsage: a value from a past window loses to the current window even when higher', () => {
  const now = 1_000_000_000
  const [r] = railUsage(
    [sess('old', 9, 'claude', usage(90, 90, { fiveHourResetsAt: now - 1, weekResetsAt: now - 1 })), sess('new', 1, 'claude', usage(5, 20, { fiveHourResetsAt: now + 3_600_000, weekResetsAt: now + 86_400_000 }))],
    now,
  )
  assert.equal(r.fiveHour.pct, 5)
  assert.equal(r.week.pct, 20)
})

test('untilReset: minutes, hours, days, nothing once past', () => {
  const now = 1_000_000
  assert.equal(untilReset(now + 30 * 60_000, now), '30분')
  assert.equal(untilReset(now + 3 * 3_600_000, now), '3시간')
  assert.equal(untilReset(now + 2 * 86_400_000, now), '2일')
  assert.equal(untilReset(now - 1, now), '')
  assert.equal(untilReset(null, now), '')
})
