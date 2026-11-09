// REQ-F-891 rule 13 (AC-1716): the runner a session switches to reads the conversation the other one left, from a file
// the Mac makes; nothing is asked of the runner it leaves (it may have no tokens left).
import test from 'node:test'
import assert from 'node:assert/strict'
import { switchDigest, switchHead, SWITCH_MSG, SWITCH_TOTAL, SWITCH_FIRST } from '../../agent/mcp.mjs'

const user = (text, extra = {}) => JSON.stringify({ type: 'user', timestamp: '2026-11-09T10:00:00.000Z', message: { role: 'user', content: text }, ...extra })
const said = (content) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-09T10:01:00.000Z', message: { role: 'assistant', content } })

test('switchDigest: the words, the tool calls by name and target, no tool output', () => {
  const text = [
    user('로그인 버튼 고쳐 줘. main 에 바로 push 하지 마'),
    said([{ type: 'text', text: '보고 있어요' }, { type: 'tool_use', name: 'Bash', input: { command: 'git status --short' } }]),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'SECRET OUTPUT' }] } }),
    user('<system-reminder>무시</system-reminder>'),
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: '곁가지' }] } }),
    user('지금까지 요약', { isCompactSummary: true }),
    said([{ type: 'text', text: '고쳤어요' }]),
    'not json',
  ].join('\n')
  const d = switchDigest(text, { runnerName: 'Codex', sid: 'abcdef12-0000', now: new Date('2026-11-09T00:00:00Z') })
  assert.equal(d.total, 4)
  assert.equal(d.count, 4)
  assert.ok(d.text.startsWith('<!-- claude-bridge: 실행기 전환 기록 · 세션 abcdef12'))
  assert.match(d.text, /--- 사람 · 2026-11-09 10:00\n로그인 버튼 고쳐 줘\. main 에 바로 push 하지 마/)
  assert.match(d.text, /--- Codex · 2026-11-09 10:01\n보고 있어요\n\[도구: Bash\] git status --short/)
  assert.match(d.text, /--- 압축 요약/)
  assert.doesNotMatch(d.text, /SECRET OUTPUT|무시|곁가지/)
  // Oldest first.
  assert.ok(d.text.indexOf('로그인 버튼') < d.text.indexOf('고쳤어요'))
})

test('switchDigest: nothing to read gives no file', () => {
  assert.deepEqual(switchDigest(''), { text: '', count: 0, total: 0 })
  assert.deepEqual(switchDigest(user('<system-reminder>x</system-reminder>')), { text: '', count: 0, total: 0 })
})

test('switchDigest: a long conversation keeps the first requests and the newest, and says what it left out', () => {
  const lines = []
  for (let i = 0; i < 200; i++) lines.push(user(`요청 ${i} ${'가'.repeat(500)}`), said([{ type: 'text', text: `답 ${i} ${'나'.repeat(3000)}` }]))
  const d = switchDigest(lines.join('\n'), { runnerName: 'Claude Code' })
  assert.equal(d.total, 400)
  assert.ok(d.count < 400)
  assert.ok(d.text.length < SWITCH_TOTAL + 20_000)
  for (let i = 0; i < SWITCH_FIRST; i++) assert.match(d.text, new RegExp(`요청 ${i} `))
  // Every request fits in the people's share here; the oldest answers go first.
  assert.match(d.text, /요청 100 /)
  assert.match(d.text, /답 199 /)
  assert.doesNotMatch(d.text, /답 0 /)
  assert.match(d.text, /… \(메시지 \d+개 생략\)/)
})

test('switchDigest: one long message is cut', () => {
  const d = switchDigest(said([{ type: 'text', text: 'x'.repeat(SWITCH_MSG + 500) }]), { runnerName: 'Codex' })
  assert.match(d.text, new RegExp(`${SWITCH_MSG + 500}자 중 앞부분`))
})

test('switchHead: names the file and both runners, keeps the folder, and says when it resumes', () => {
  const h = switchHead({ fromName: 'Codex', toName: 'Claude Code', file: 'SESSION-abcdef12-switch.md', count: 10, total: 12 })
  assert.match(h, /`SESSION-abcdef12-switch\.md`/)
  assert.match(h, /Codex 로 작업했고, 같은 폴더에서 이제 Claude Code 로/)
  assert.match(h, /메시지 12개 중 10개/)
  assert.match(h, /되돌리거나 지우지 말고/)
  assert.match(h, /worktree/)
  assert.doesNotMatch(h, /예전에/)
  assert.match(switchHead({ fromName: 'Codex', toName: 'Claude Code', file: 'f', count: 1, total: 1, resumed: true }), /예전에 Claude Code 로 돌던 때/)
})
