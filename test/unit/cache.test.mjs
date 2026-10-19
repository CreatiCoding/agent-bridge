import test from 'node:test'
import assert from 'node:assert/strict'
import { cacheStatus, countLine, emptyCache, EVENTS_MAX } from '../../agent/cache.mjs'

const T0 = Date.parse('2026-10-18T00:00:00Z')
const call = (id, { read = 0, write = 0, input = 1, output = 10, at = T0, model = 'claude-opus-5-5', side = false } = {}) =>
  JSON.stringify({ type: 'assistant', isSidechain: side, timestamp: new Date(at).toISOString(), message: { id, model, usage: { cache_read_input_tokens: read, cache_creation_input_tokens: write, input_tokens: input, output_tokens: output } } })

test('one answer written as several lines is counted once', () => {
  const c = emptyCache()
  for (const l of [call('a', { read: 100, write: 5 }), call('a', { read: 100, write: 5 }), call('b', { read: 200 })]) countLine(c, l)
  assert.equal(c.calls, 2)
  assert.equal(c.read, 300)
  assert.equal(c.write, 5)
  assert.equal(c.ctx, 201)
})

test('subagent calls, synthetic answers and other lines are not counted', () => {
  const c = emptyCache()
  countLine(c, call('a', { read: 100, side: true }))
  countLine(c, call('b', { read: 100, model: '<synthetic>' }))
  countLine(c, JSON.stringify({ type: 'user', message: { content: 'the word "usage" and "assistant"' } }))
  countLine(c, '{not json "usage" "assistant"')
  assert.equal(cacheStatus(c), null)
})

test('a rewrite is named by what came before it', () => {
  const c = emptyCache()
  countLine(c, call('1', { write: 40_000 }))
  countLine(c, call('2', { read: 40_000, write: 2_000, at: T0 + 60_000 }))
  countLine(c, call('3', { write: 50_000, at: T0 + 60_000 + 3_700_000 }))
  countLine(c, call('4', { write: 50_000, at: T0 + 60_000 + 3_700_000 + 600_000 }))
  countLine(c, call('5', { write: 50_000, at: T0 + 60_000 + 3_700_000 + 610_000, model: 'claude-fable-5-1' }))
  countLine(c, JSON.stringify({ type: 'system', subtype: 'compact_boundary' }))
  countLine(c, call('6', { write: 31_000, read: 1_000, at: T0 + 60_000 + 3_700_000 + 620_000, model: 'claude-fable-5-1' }))
  countLine(c, call('7', { write: 20_000, at: T0 + 60_000 + 3_700_000 + 630_000, model: 'claude-fable-5-1' }))
  assert.deepEqual(
    c.events.map((e) => e.kind),
    ['start', 'cold', 'idle', 'model', 'compact'],
  )
  assert.equal(c.events[1].gap, 3_700_000)
})

test('only the latest events are kept, and the share read from the cache is a percentage', () => {
  const c = emptyCache()
  for (let i = 0; i < EVENTS_MAX + 3; i++) countLine(c, call(String(i), { write: 40_000, at: T0 + i * 4_000_000 }))
  assert.equal(c.events.length, EVENTS_MAX)
  const d = emptyCache()
  countLine(d, call('a', { read: 900, write: 99, input: 1 }))
  assert.equal(cacheStatus(d).hit, 90)
})

test('a compaction sets the context to what it left, not the last call before it (AC-1341)', () => {
  const c = emptyCache()
  countLine(c, call('a', { read: 470_000, write: 100 }))
  assert.equal(c.ctx, 470_101)
  countLine(c, JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 470_000, postTokens: 20_047 } }))
  assert.equal(cacheStatus(c).ctx, 20_047)
  countLine(c, JSON.stringify({ type: 'user', isCompactSummary: true, message: { content: 'summary' } }))
  assert.equal(c.ctx, 20_047)
  countLine(c, JSON.stringify({ type: 'system', subtype: 'compact_boundary' }))
  assert.equal(c.ctx, 0)
  countLine(c, call('b', { read: 0, write: 25_000 }))
  assert.equal(c.ctx, 25_001)
})
