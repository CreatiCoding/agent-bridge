// 할 일 도구가 없는 세션 (REQ-F-778 rule 9): the page reopens a session whose Claude has no bridge todos tool before
// asking it for its list. Whether it has one: the tools the agent started it with, or what its transcript showed
// (the server's side, trackTodosTool, is tested in server/keystate_test.go).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

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
  const menu = fs.readFileSync(new URL('../../ui/src/components/session-menu.tsx', import.meta.url), 'utf8')
  const ask = menu.match(/export async function askTodos\([\s\S]*?\n\}/)[0]
  assert.match(ask, /const noTool = s\.state\.alive && !s\.state\.bridgeTools\?\.includes\('mcp__bridge__todos'\) && !s\.sawTodosTool/)
  assert.ok(ask.indexOf("sessionPost(s, 'refresh', { when: later ? 'later' : 'now' })") < ask.indexOf('const text = again ? TODO_REASK : TODO_ASK'))
})

test('a row\'s menu on the list asks for the list too, and the session page shows it once (AC-1416)', () => {
  const menu = fs.readFileSync(new URL('../../ui/src/components/session-menu.tsx', import.meta.url), 'utf8')
  // A row's menu (no page) has its own; the page's comes first among its items (1.358: one sessionMenu for both).
  assert.match(menu, /\.\.\.\(page \? \[\] : \[\{ id: 'todos', label: '할 일 정리', icon: 'list' as const, hint: '지금까지 한 일·남은 일', disabled: !!todoBlocked\(s\), onSelect: \(\) => void askTodos\(s\) \}\]\)/)
  assert.match(menu, /\{ id: 'todos', label: '할 일 정리', icon: 'list', hint: '지금까지 한 일·남은 일', disabled: !!todoBlocked\(s\), onSelect: \(\) => void page\.askTodos\(\) \}/)
  assert.equal(menu.match(/label: '할 일 정리'/g).length, 2)
  const page = fs.readFileSync(new URL('../../ui/src/pages/session-page.tsx', import.meta.url), 'utf8')
  assert.match(page, /sessionMenu\(s, \{ groups: .*, wide, page: \{ sheet: setSheet, askTodos: \(\) => void askTodos\(\)/)
  assert.equal(page.match(/label: '할 일 정리'/g), null)
})

test('the session menu compacts a resting session, as the big-context banner does (AC-1417)', () => {
  const menu = fs.readFileSync(new URL('../../ui/src/components/session-menu.tsx', import.meta.url), 'utf8')
  const item = menu.match(/label: '지금 압축',[\s\S]*?onSelect: \(\) => act\(\(\) => command\(s, 'compact'\)\),/)
  assert.ok(item, 'the item sends the compact command')
  assert.match(item[0], /disabled: !alive \|\| s\.state\.phase !== 'idle'/)
  assert.match(item[0], /'쉬고 있을 때만'/)
})

test('"다시 정리" with a list asks to recheck it against the real state, other sessions included (AC-1367)', () => {
  const src = fs.readFileSync(new URL('../../ui/src/components/session-extras.tsx', import.meta.url), 'utf8')
  const reask = src.match(/export const TODO_REASK = `\$\{TODO_ASK\} (\\`|[^`])*`/)
  assert.ok(reask, 'TODO_REASK starts with TODO_ASK, so its card still matches')
  assert.match(reask[0], /지금 패널의 목록을 그대로 믿지 말고/)
  assert.match(reask[0], /다른 세션/)
  assert.match(reask[0], /origin\/main/)
  const page = fs.readFileSync(new URL('../../ui/src/pages/session-page.tsx', import.meta.url), 'utf8')
  assert.match(page, /askSessionTodos\(s, todoItems\.length > 0, send\)/)
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
