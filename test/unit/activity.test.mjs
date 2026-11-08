// The session page's status line while a turn runs (REQ-F-874): what it says, and its two times.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACTIVITY_QUIET_MS, activityLine, lastActivityAt, lastSeen, NO_UPDATE, toolRunningIn } from '../../ui/src/lib/activity.ts'
import { COMPACTING_RE } from '../../agent/screen.mjs'

const NOW = 10_000_000
const base = { now: NOW, phase: 'busy', turnAt: NOW - 8 * 60_000, waiting: null, waitingSince: null, tool: null, compacting: false, hooks: true, hostOnline: true, link: 'live', downSince: null, lastItemAt: 0 }
const line = (o) => activityLine({ ...base, ...o })

test('턴이 없으면 상태줄도 없다', () => {
  assert.equal(line({ phase: 'idle' }), null)
  assert.equal(line({ phase: 'ended' }), null)
})

test('Codex 처럼 훅이 없고 머리말도 없으면 "생각하는 중" 대신 "작업 중 · 상태 업데이트 없음" (AC-1649)', () => {
  assert.equal(line({ hooks: false }).label, '작업 중 · 상태 업데이트 없음')
  assert.equal(line({ hooks: true }).label, '생각하는 중')
  // A header Codex streams is shown by the page itself (label null), as before.
  assert.equal(line({ hooks: false, tool: { name: '', title: 'Planning the filter', at: NOW - 1000 } }).label, null)
})

test('전체 시간과 마지막 활동 이후 시간을 따로 낸다 (AC-1650)', () => {
  const l = line({ lastItemAt: NOW - 5 * 60_000 })
  assert.equal(l.total, 8 * 60_000)
  assert.equal(l.quiet, 5 * 60_000)
  // Something moved within the minute: only the whole time.
  assert.equal(line({ lastItemAt: NOW - 10_000 }).quiet, null)
  // Nothing at all since the turn began: quiet counts from its start.
  assert.equal(line({}).quiet, 8 * 60_000)
  // A Codex header that just changed is activity too.
  assert.equal(line({ hooks: false, tool: { name: '', title: 'x', at: NOW - 2000 } }).quiet, null)
  assert.equal(lastActivityAt({ turnAt: 5, tool: { name: 'Bash', title: null, at: 9 }, waitingSince: null, lastItemAt: 7 }), 9)
  assert.ok(ACTIVITY_QUIET_MS >= 30_000)
})

test('승인 대기·압축·연결 끊김을 따로 말한다 (AC-1651)', () => {
  const w = line({ phase: 'waiting', waiting: '권한 요청', waitingSince: NOW - 120_000 })
  assert.equal(w.label, '승인 대기 중')
  assert.equal(w.total, 120_000)
  assert.equal(w.quiet, null)
  assert.equal(line({ phase: 'waiting', waiting: '지시 대기', waitingSince: NOW }).label, '다음 지시 대기 중')
  assert.equal(line({ compacting: true }).label, '컨텍스트 압축 중')
  assert.equal(line({ hostOnline: false }).label, '맥 연결 끊김 · 상태 확인 불가')
  assert.equal(line({ link: 'retrying', downSince: NOW - 20_000 }).label, '연결 끊김 · 다시 연결하는 중')
  // A reconnect of a few seconds says nothing.
  assert.equal(line({ link: 'retrying', downSince: NOW - 2_000 }).label, '생각하는 중')
})

test('COMPACTING_RE: 압축 중인 작업 줄만 (Claude Code·Codex)', () => {
  assert.ok(COMPACTING_RE.test('✻ Compacting conversation… (esc to interrupt · ctrl+t to show todos)\n❯ \n'))
  assert.ok(COMPACTING_RE.test('• Compacting… (12s • esc to interrupt)\n'))
  assert.ok(!COMPACTING_RE.test('⏺ Compacting the log is done (3 files)\n'))
  assert.ok(!COMPACTING_RE.test('Compacting conversation (later)\n'))
  assert.ok(!COMPACTING_RE.test('✻ Thinking… (12s · esc to interrupt)\n'))
})

test('Codex 처럼 훅이 없어도 이 턴의 도는 도구 줄이 있으면 "도구 실행 중" (AC-1692)', () => {
  const T = NOW - 60_000
  const items = [
    { t: 'user', at: T },
    { t: 'tool', at: T + 1000, name: 'Bash', label: 'npm test', done: false },
  ]
  assert.equal(toolRunningIn(items, T), true)
  assert.equal(line({ hooks: false, toolRunning: true }).label, '도구 실행 중')
  // Ahead of a Codex header: the command is what is going on now.
  assert.equal(line({ hooks: false, toolRunning: true, tool: { name: '', title: 'Planning', at: NOW } }).label, '도구 실행 중')
  // Done, or from an earlier turn: not running.
  assert.equal(toolRunningIn([{ t: 'tool', at: T - 5000, done: false }, { t: 'user', at: T }], T), false)
  assert.equal(toolRunningIn([{ t: 'user', at: T }, { t: 'tool', at: T + 1, done: true }], T), false)
  // Claude Code's hooks already say it (tool.name): unchanged.
  assert.equal(line({ hooks: true, toolRunning: true }).label, '생각하는 중')
  assert.equal(line({ hooks: false }).label, NO_UPDATE)
})

test('마지막 활동이 무엇이었는지: 이 턴의 마지막 도구·생각·답, 더 늦은 Codex 머리말 (AC-1693)', () => {
  const T = NOW - 600_000
  const items = [
    { t: 'text', at: T - 9000, text: '지난 턴' },
    { t: 'user', at: T },
    { t: 'thinking', at: T + 1000, text: '**Inspecting the config**\n\nRead it first.' },
    { t: 'tool', at: T + 2000, name: 'Bash', label: 'ls -la', done: true },
    { t: 'note', at: T + 3000, text: '알림' },
  ]
  assert.deepEqual(lastSeen(items, T), { what: 'Bash · ls -la', at: T + 2000 })
  assert.deepEqual(lastSeen(items.slice(0, 3), T), { what: '생각 · Inspecting the config', at: T + 1000 })
  assert.deepEqual(lastSeen([...items, { t: 'text', at: T + 4000, text: '\n고쳤어요. 이제 됩니다' }], T), { what: '답 · 고쳤어요. 이제 됩니다', at: T + 4000 })
  // A Codex header that changed later is what it was last doing.
  assert.deepEqual(lastSeen(items, T, { name: '', title: 'Running tests', at: T + 5000 }), { what: 'Running tests', at: T + 5000 })
  assert.deepEqual(lastSeen(items, T, { name: '', title: 'Old header', at: T + 500 }), { what: 'Bash · ls -la', at: T + 2000 })
  // Nothing this turn yet (the last turn's answer does not count).
  assert.equal(lastSeen(items.slice(0, 2), T), null)
  assert.ok(lastSeen([{ t: 'user', at: T }, { t: 'tool', at: T + 1, name: 'Bash', label: 'x'.repeat(200) }], T).what.length <= 60)
})
