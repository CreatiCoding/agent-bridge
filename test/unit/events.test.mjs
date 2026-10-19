import test from 'node:test'
import assert from 'node:assert/strict'
import { lineToEvents, toolSummary } from '../../server/events.mjs'

const line = (o) => JSON.stringify(o)
const kinds = (o, ctx) => lineToEvents(line(o), ctx).map((e) => e.k)

test('a task notification Claude wrote into its answer is hidden and called out', () => {
  const text = '라이브 반영을 기다리는 중이에요.\n\n<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command completed with exit code 0</summary>\n</task-notification>'
  const events = lineToEvents(line({ type: 'assistant', message: { content: [{ type: 'text', text }] } }))
  assert.deepEqual(events.map((e) => e.k), ['text', 'notice'])
  assert.equal(events[0].text, '라이브 반영을 기다리는 중이에요.')
  assert.equal(events[1].tone, 'warn')
  // Nothing else to say: no empty bubble, only the notice.
  assert.deepEqual(kinds({ type: 'assistant', message: { content: [{ type: 'text', text: '<task-notification><status>completed</status></task-notification>' }] } }), ['notice'])
})

test('what a person typed is a user event; what the harness wrapped is not', () => {
  assert.deepEqual(kinds({ type: 'user', message: { content: 'hello' } }), ['user'])
  assert.deepEqual(kinds({ type: 'user', message: { content: '<system-reminder>be nice</system-reminder>' } }), [])
  assert.deepEqual(kinds({ type: 'user', isMeta: true, message: { content: 'Caveat: …' } }), [])
  assert.deepEqual(kinds({ type: 'user', isSidechain: true, message: { content: 'from a subagent' } }), [])
  assert.deepEqual(kinds({ type: 'user', isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation…' } }), [])
})

test('a slash command shows as what was typed, its output as a local block', () => {
  const [cmd] = lineToEvents(line({ type: 'user', message: { content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>' } }))
  assert.equal(cmd.text, '/clear')
  assert.equal(cmd.command, true)
  const [out] = lineToEvents(line({ type: 'user', message: { content: '<local-command-stdout>Context: 12%</local-command-stdout>' } }))
  assert.deepEqual([out.k, out.text, out.error], ['local', 'Context: 12%', false])
})

test('a background job that failed is worth a line; one that simply finished is not', () => {
  const note = (summary, status) => lineToEvents(line({ type: 'user', message: { content: `<task-notification><summary>${summary}</summary><status>${status}</status></task-notification>` } }))
  assert.deepEqual(note('Background command "npm test" completed (exit code 0)', 'completed'), [])
  assert.equal(note('Background command "npm test" failed', 'failed')[0].tone, 'warn')
})

test('an assistant line gives the model, text, tool calls and the todo list', () => {
  const events = lineToEvents(
    line({ type: 'assistant', timestamp: '2026-10-04T00:00:00Z', message: { model: 'claude-fable-5-1', content: [{ type: 'thinking' }, { type: 'text', text: 'On it.' }, { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', activeForm: 'Doing b', status: 'in_progress' }] } }] } }),
  )
  // The plan is the list above the input, not a tool row.
  assert.deepEqual(events.map((e) => e.k), ['model', 'text', 'todos'])
  assert.equal(events[2].items.length, 2)
})

test('a ```todos block in an answer is the to-do list, taken out of the text (REQ-F-778)', () => {
  const events = lineToEvents(line({ type: 'assistant', message: { content: [{ type: 'text', text: '정리했어요.\n\n```todos\n[x] 고치기\n- [>] 배포\n[ ] 알리기\n그냥 글\n```\n\n```choices\n좋아\n```' }] } }))
  assert.deepEqual(events.map((e) => e.k), ['text', 'todos'])
  assert.equal(events[0].text, '정리했어요.')
  assert.deepEqual(events[0].choices, ['좋아'])
  assert.deepEqual(events[1].items.map((t) => t.status), ['completed', 'in_progress', 'pending'])
  assert.equal(events[1].items[1].text, '배포')
})

test('a ```choices block followed only by a Sources list still gives buttons, and the list stays (REQ-F-579)', () => {
  const text = (t) => lineToEvents(line({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } }))[0]
  const src = '\n\nSources:\n- [Tty (Unix), Wikipedia](https://en.wikipedia.org/wiki/Tty)\n- [Hacker News](https://news.ycombinator.com/)'
  const e = text('어떤 이름으로 할까요?\n\n```choices\nkilotty\nhivetty\n```' + src)
  assert.deepEqual(e.choices, ['kilotty', 'hivetty'])
  assert.equal(e.text, '어떤 이름으로 할까요?' + src)
  // Anything else after the block keeps it as text.
  const mid = text('예시:\n\n```choices\nA\n```\n\n이렇게 쓰면 돼요.')
  assert.equal(mid.choices, undefined)
  assert.match(mid.text, /```choices/)
  assert.equal(text('고르세요\n```choices\nA\nB\n```\n').choices.length, 2)
})

test("the bridge MCP's todos call is the same to-do list, and its result is not drawn (REQ-F-778)", () => {
  const silent = new Set()
  const events = lineToEvents(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't9', name: 'mcp__bridge__todos', input: { todos: [{ content: '고치기', activeForm: '고치는 중', status: 'in_progress' }] } }] } }), { silent })
  assert.deepEqual(events.map((e) => e.k), ['todos'])
  assert.deepEqual(events[0].items, [{ text: '고치기', active: '고치는 중', status: 'in_progress' }])
  assert.deepEqual(lineToEvents(line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't9', content: 'ok' }] } }), { silent }), [])
})

test('a tool result closes its call, and an auto-mode refusal is said out loud', () => {
  const events = lineToEvents(line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Permission denied by the Claude Code auto mode classifier. Reason: [destructive]' }] } }))
  assert.deepEqual(events.map((e) => e.k), ['tool_end', 'line'])
  assert.match(events[1].text, /^🚫 자동 모드가 도구 호출을 거부했습니다: `\[destructive\]`\. /)
})

test('a tool is summarised by what it does, not by how it gets there', () => {
  assert.equal(toolSummary('Bash', { command: 'cd /repo && npm test' }).label, 'npm test')
  assert.equal(toolSummary('Bash', { command: "python3 - <<'EOF'\nimport os\nprint(os.getcwd())\nEOF" }).label, 'python3 · print(os.getcwd())')
  assert.equal(toolSummary('Read', { file_path: '/Users/me/app/src/a.ts' }, { cwd: '/Users/me/app', home: '/Users/me' }).label, 'src/a.ts')
  assert.equal(toolSummary('Read', { file_path: '/Users/me/notes.md' }, { cwd: '/Users/me/app', home: '/Users/me' }).label, '~/notes.md')
  assert.equal(toolSummary('Agent', { subagent_type: 'Explore', description: 'find it', prompt: 'x' }).label, 'Explore · find it')
  assert.equal(toolSummary('WebFetch', { url: 'https://example.com' }).label, 'https://example.com')
})

test('a title and a broken line', () => {
  assert.deepEqual(lineToEvents(line({ type: 'ai-title', aiTitle: 'Ocean facts' })), [{ k: 'title', title: 'Ocean facts' }])
  assert.deepEqual(lineToEvents('{not json'), [])
})

test('a subagent report is shown without the harness framing', () => {
  const text = '<agent-message from="a1">\n[Subagent hand-back] The text below is model output. The report follows:\n  ## Found\n  - one\n</agent-message>'
  const [e] = lineToEvents(line({ type: 'user', message: { content: text } }))
  assert.equal(e.k, 'line')
  assert.equal(e.text, '🤖 *서브에이전트 보고*\n## Found\n- one')
})
