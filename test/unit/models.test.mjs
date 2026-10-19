// The model list made from Claude Code's catalog (the `initialize` answer of Claude Code 2.1.296, trimmed).
import test from 'node:test'
import assert from 'node:assert/strict'
import { modelsFromCatalog } from '../../server/models.mjs'

const catalog = [
  { value: 'default', resolved: 'claude-opus-5-5', name: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { value: 'opus', resolved: 'claude-opus-5-5', name: 'Opus 5.5', description: 'For complex work and everyday tasks' },
  { value: 'fable', resolved: 'claude-fable-5-1', name: 'Fable 5.1', description: 'For your toughest challenges' },
  { value: 'sonnet', resolved: 'claude-sonnet-5-5', name: 'Sonnet 5.5', description: 'Most efficient for simpler tasks' },
  { value: 'haiku', resolved: 'claude-haiku-5-5', name: 'Haiku 5.5', description: 'Fastest for quick answers' },
  { value: 'claude-haiku-4-5-20251001', resolved: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', description: '' },
  { value: 'claude-opus-5', resolved: 'claude-opus-5', name: 'Opus 5', description: '' },
]
const prev = [
  { label: 'Fable 5.1 (1M)', value: 'claude-fable-5-1[1m]' },
  { label: 'Opus 5.5 (1M)', value: 'claude-opus-5-5[1m]' },
  { label: 'Opus plan / Sonnet work', value: 'opusplan' },
  { label: 'Default', value: 'default' },
]

test('the catalog becomes the list: full ids, kept 1M forms, opusplan, Default last', () => {
  assert.deepEqual(modelsFromCatalog(catalog, prev), [
    { label: 'Opus 5.5 (1M)', value: 'claude-opus-5-5[1m]' },
    { label: 'Opus 5.5', value: 'claude-opus-5-5' },
    { label: 'Fable 5.1 (1M)', value: 'claude-fable-5-1[1m]' },
    { label: 'Fable 5.1', value: 'claude-fable-5-1' },
    { label: 'Sonnet 5.5', value: 'claude-sonnet-5-5' },
    { label: 'Haiku 5.5', value: 'claude-haiku-5-5' },
    { label: 'Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
    { label: 'Opus 5', value: 'claude-opus-5' },
    { label: 'Opus plan / Sonnet work', value: 'opusplan' },
    { label: 'Default · Opus 5.5', value: 'default' },
  ])
})

test('a new model in the catalog appears; nothing kept that the catalog dropped, except 1M forms of its models', () => {
  const next = modelsFromCatalog([catalog[0], { value: 'opus', resolved: 'claude-opus-6', name: 'Opus 6', description: '' }, ...catalog.slice(2)], prev)
  assert.equal(next[0].value, 'claude-opus-6')
  assert.ok(!next.some((m) => m.value === 'claude-opus-5-5[1m]'), '목록에서 빠진 모델의 1M 도 빠짐')
  assert.deepEqual(modelsFromCatalog([], []), [{ label: 'Default', value: 'default' }])
})
