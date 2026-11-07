// REQ-F-882: Claude 로 정리 후보 찾기 starts a session in the home folder that asks before it deletes anything.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DISK_PROMPT, diskSession } from '../../ui/src/lib/disk-prompt.ts'

test('AC-1662 the session starts in the home folder, asking for each permission, with the cleanup prompt', () => {
  const b = diskSession('h1', 'k1')
  assert.deepEqual(b, { hostId: 'h1', cwd: '~', prompt: DISK_PROMPT, title: '디스크 정리', startKey: 'k1', mode: 'default', create: false })
})

test('AC-1662 the prompt reports candidates first and deletes only what was approved', () => {
  assert.match(DISK_PROMPT, /지우기 전에 후보부터 보고하고, 내가 승인한 범위만 지운다/)
  assert.match(DISK_PROMPT, /재부팅은 제안만 한다/)
  assert.match(DISK_PROMPT, /~\/\.claude-bridge/)
  assert.ok(DISK_PROMPT.length < 100_000)
})
