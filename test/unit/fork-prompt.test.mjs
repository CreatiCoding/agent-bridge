// A copy made while the original works is told that work stays the original's (REQ-F-401, AC-1347).
import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionPrompt } from '../../agent/guard.mjs'

test('a copy of a working session is told the original keeps its work', () => {
  const p = sessionPrompt('BRIDGE', { sysPrompt: '한국어로 답한다', forkOf: 'f117bdae' })
  assert.ok(p.startsWith('BRIDGE\n\n한국어로 답한다\n\n[복제된 세션]'))
  assert.match(p, /f117bdae 세션이 일하던 도중에 복제/)
  assert.match(p, /원본 세션이 계속 맡고/)
})

test('any other session gets only the bridge prompt and its own', () => {
  assert.equal(sessionPrompt('BRIDGE', { sysPrompt: '  기본  ' }), 'BRIDGE\n\n기본')
  assert.equal(sessionPrompt('BRIDGE', { sysPrompt: '' }), 'BRIDGE')
  assert.equal(sessionPrompt('BRIDGE', { forkOf: 'x; rm -rf' }), 'BRIDGE')
})
