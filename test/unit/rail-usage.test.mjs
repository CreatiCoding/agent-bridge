// REQ-F-858 (AC-1612): the app rail's Claude and Codex limits come from each runner's latest session.
import test from 'node:test'
import assert from 'node:assert/strict'
import { railUsage } from '../../ui/src/lib/rail-usage.ts'

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
