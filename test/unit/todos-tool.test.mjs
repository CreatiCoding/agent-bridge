// 할 일 도구가 없는 세션 (REQ-F-778 rule 9): the page reopens a session whose Claude has no bridge todos tool before
// asking it for its list. Whether it has one: the tools the agent started it with, or what its transcript showed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('the transcript tells a session has the todos tool only when it was offered or called (AC-1354)', () => {
  const src = fs.readFileSync(new URL('../../server/server.mjs', import.meta.url), 'utf8')
  const body = src.match(/function trackTodosTool\(meta, line\) \{[\s\S]*?\n\}/)[0]
  const trackTodosTool = new Function(`${body}; return trackTodosTool`)()
  const seen = (...lines) => {
    const meta = {}
    for (const l of lines) trackTodosTool(meta, typeof l === 'string' ? l : JSON.stringify(l))
    return !!meta.sawTodosTool
  }
  // The request "지금까지 한 일로 정리" names the tool: that is not the tool.
  assert.equal(seen({ type: 'user', message: { content: '`mcp__bridge__todos` 도구가 있으면 그 도구로 보내고' } }), false)
  assert.equal(seen({ type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: ['mcp__bridge__hosts', 'mcp__bridge__delegate'] } }), false)
  assert.equal(seen('not json mcp__bridge__todos'), false)
  assert.equal(seen({ type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: ['mcp__bridge__hosts', 'mcp__bridge__todos'] } }), true)
  assert.equal(seen({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__bridge__todos', input: { todos: [] } }] } }), true)
  assert.match(src, /function trackBackground\(meta, line\) \{\n  trackTodosTool\(meta, line\)/)
  assert.match(src, /bridgeTools: Array\.isArray\(msg\.bridgeTools\)/)
})

test('the agent remembers the bridge tools a session started with and reports them (AC-1354)', () => {
  const src = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  assert.match(src, /import \{ TOOLS as BRIDGE_TOOLS \} from '\.\/mcp\.mjs'/)
  assert.match(src, /s\.bridgeTools = BRIDGE_TOOLS\.map\(\(t\) => t\.name\)/)
  assert.match(src, /bridgeTools: s\.bridgeTools \?\? null,/)
  assert.match(src, /\.\.\.\(s\.bridgeTools \? \{ bridgeTools: s\.bridgeTools \} : \{\}\)/)
})

test('the page reopens a session without the tool before asking, after its work when it works (AC-1354)', () => {
  const src = fs.readFileSync(new URL('../../ui/src/pages/session-page.tsx', import.meta.url), 'utf8')
  assert.match(src, /const noTodosTool = s\.state\.alive && !s\.state\.bridgeTools\?\.includes\('mcp__bridge__todos'\) && !s\.sawTodosTool/)
  const ask = src.match(/const askTodos = async \(\) => \{[\s\S]*?\n {2}\}/)[0]
  assert.ok(ask.indexOf("sessionPost(s, 'refresh', { when: later ? 'later' : 'now' })") < ask.indexOf('send(todoItems.length ? TODO_REASK : TODO_ASK)'))
})

test('"다시 정리" with a list asks to recheck it against the real state, other sessions included (AC-1367)', () => {
  const src = fs.readFileSync(new URL('../../ui/src/components/session-extras.tsx', import.meta.url), 'utf8')
  const reask = src.match(/export const TODO_REASK = `\$\{TODO_ASK\} (\\`|[^`])*`/)
  assert.ok(reask, 'TODO_REASK starts with TODO_ASK, so its card still matches')
  assert.match(reask[0], /지금 패널의 목록을 그대로 믿지 말고/)
  assert.match(reask[0], /다른 세션/)
  assert.match(reask[0], /origin\/main/)
  const page = fs.readFileSync(new URL('../../ui/src/pages/session-page.tsx', import.meta.url), 'utf8')
  assert.match(page, /send\(todoItems\.length \? TODO_REASK : TODO_ASK\)/)
})

test('a new list without the done items keeps them; an empty list still clears (AC-1374)', async () => {
  const { emptyFold, fold } = await import('../../ui/src/lib/timeline.ts')
  const ev = (seq, items) => ({ seq, at: seq, k: 'todos', items: items.map(([status, text]) => ({ text, active: '', status })) })
  const first = ev(1, [['completed', '**세션 목록** 둘러보기'], ['completed', '메시지 보내기'], ['in_progress', '할 일 패널'], ['pending', '베타 심사']])
  // Only the work left, one done item rewritten with another note.
  const f = fold(emptyFold(), [first, ev(2, [['completed', '세션 목록 둘러보기 (확인)'], ['in_progress', '할 일 패널'], ['pending', '베타 심사']])])
  assert.deepEqual(f.todos.map((t) => [t.status, t.text]), [['completed', '세션 목록 둘러보기 (확인)'], ['in_progress', '할 일 패널'], ['pending', '베타 심사'], ['completed', '메시지 보내기']])
  // A pending item Claude dropped stays dropped.
  const g = fold(f, [ev(3, [['in_progress', '할 일 패널']])])
  assert.deepEqual(g.todos.map((t) => t.text), ['할 일 패널', '세션 목록 둘러보기 (확인)', '메시지 보내기'])
  assert.deepEqual(fold(g, [ev(4, [])]).todos, [])
  const reask = fs.readFileSync(new URL('../../ui/src/components/session-extras.tsx', import.meta.url), 'utf8')
  assert.match(reask, /이미 완료인 항목도 목록에 그대로 넣어 보내 주세요/)
})
