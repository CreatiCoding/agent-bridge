import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prSummary } from '../../server/prview.mjs'

test('the pull request block of the statistics counts what falls in the window', () => {
  const now = Date.parse('2026-10-05T00:00:00Z')
  const prs = [
    { url: 'u1', createdAt: '2026-10-01T00:00:00Z', mergedAt: '2026-10-01T02:00:00Z', additions: 10, deletions: 2 },
    { url: 'u2', createdAt: '2026-10-03T00:00:00Z', mergedAt: '2026-10-04T00:00:00Z', additions: 5, deletions: 1 },
    { url: 'u3', createdAt: '2026-10-04T12:00:00Z' },
    { url: 'old', createdAt: '2026-08-01T00:00:00Z', mergedAt: '2026-08-02T00:00:00Z', additions: 99, deletions: 99 },
  ]
  const s = prSummary(prs, now, 7)
  assert.deepEqual([s.merged, s.created, s.additions, s.deletions], [2, 3, 15, 3])
  assert.equal(s.medianMergeMs, 24 * 3600_000)
  assert.equal(s.recent[0].url, 'u3')
  assert.equal(prSummary(prs, now, 1).merged, 1)
})
