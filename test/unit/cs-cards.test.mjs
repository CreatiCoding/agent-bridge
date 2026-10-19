import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cardMessage, foldedMessage } from '../../server/cs.mjs'

const labels = (m) => m.blocks.find((b) => b.type === 'actions').elements.map((e) => e.text.text)

test('a plan card uses the fixed wording, matched by what each option says, not by its place', () => {
  const card = { id: 'c1', kind: 'plan', plan: 'do it', options: [{ n: 1, label: 'Yes, clear context and auto-accept edits' }, { n: 2, label: 'Yes, and manually approve edits' }, { n: 3, label: 'No, keep planning' }] }
  assert.deepEqual(labels(cardMessage(card, 1001)), ['✅ 승인 · 편집 자동 승인', '✅ 승인 · 편집 수동 승인', '✏️ 아니오 · 계속 계획', '🖥 화면'])
  // Two options that both read as "auto": neither gets the fixed label, so the person sees which is which.
  const two = { ...card, options: [{ n: 1, label: 'Yes, and auto-accept edits' }, { n: 2, label: 'Yes, and switch to auto mode' }, { n: 3, label: 'No, keep planning' }] }
  assert.deepEqual(labels(cardMessage(two, 1001)), ['1. Yes, and auto-accept edits', '2. Yes, and switch to auto mode', '✏️ 아니오 · 계속 계획', '🖥 화면'])
  assert.equal(cardMessage(card, 1001).blocks.find((b) => b.type === 'actions').elements[1].value, '1001:card c1 2')
})

test('a question card shows its header, and a multi-select one has a confirm button', () => {
  const card = { id: 'q1', kind: 'question', title: 'Which?', header: 'Size', multi: true, options: [{ n: 1, label: 'S' }, { n: 2, label: 'L' }] }
  const m = cardMessage(card, 7)
  assert.ok(m.blocks.some((b) => b.text?.text?.startsWith('*[Size] Which?*') && b.text.text.includes('복수 선택')))
  assert.deepEqual(labels(m), ['1. S', '2. L', '확정 (Enter)'])
})

test('answered cards fold to one line', () => {
  assert.equal(foldedMessage({ kind: 'permission', tool: { name: 'Bash' } }, '허용').text, '✅ Bash · 허용')
  assert.equal(foldedMessage({ kind: 'permission', tool: { name: 'Bash' } }, '거부').text, '⛔ Bash · 거부')
  assert.equal(foldedMessage({ kind: 'question', title: 'Which?' }, '선택: Blue').text, '☑️ 선택: *Blue*')
  assert.equal(foldedMessage({ kind: 'question' }, '메시지로 답함').text, '💬 메시지로 답함')
  assert.equal(foldedMessage({ kind: 'keyed' }, '이미 닫힌 창').text, '⌨️ 이미 닫힌 창')
})

test('a card stays inside what Slack takes: a section is 3,000 characters at most, a cut fence is closed', async () => {
  const { cardMessage, autoAllowMessage, autoLine, fit } = await import('../../server/cs.mjs')
  const sections = (m) => m.blocks.filter((b) => b.type === 'section').map((b) => b.text.text)
  const long = 'echo ' + 'x'.repeat(5000)
  const bash = { id: 'c1', kind: 'permission', tool: { name: 'Bash', input: { command: long } }, options: [{ n: 1, kind: 'allow-once', label: 'Yes' }] }
  const edit = { id: 'c2', kind: 'permission', tool: { name: 'Edit', input: { file_path: '/a/b.ts', old_string: 'a\n'.repeat(3000), new_string: 'b\n'.repeat(3000) } }, options: [] }
  for (const m of [cardMessage(bash, 1), cardMessage(edit, 1), autoAllowMessage(bash), autoAllowMessage(edit)])
    for (const t of sections(m)) {
      assert.ok(t.length <= 3000, `섹션 ${t.length}자`)
      assert.equal((t.match(/```/g) ?? []).length % 2, 0, '코드 블록이 닫혀 있음')
    }
  assert.equal(fit('```\n' + 'y'.repeat(4000)).endsWith('…\n```'), true)
  assert.equal(fit('z'.repeat(4000)).length, 2996)
  const plan = cardMessage({ id: 'p', kind: 'plan', plan: 'p'.repeat(200000), options: [{ n: 1, label: 'Yes, auto-accept' }] }, 1)
  assert.ok(plan.blocks.length <= 50, `블록 ${plan.blocks.length}개`)
  // The line a run keeps says what was done in a few words, never the command or the change.
  assert.deepEqual(autoLine({ tool: { name: 'Bash', input: { command: 'rm -rf ~/x', description: '작업 폴더 정리' } } }), { name: 'Bash', what: '작업 폴더 정리', desc: true })
  assert.deepEqual(autoLine({ tool: { name: 'Bash', input: { command: 'rm -rf ~/x' } } }), { name: 'Bash', what: '', desc: false })
  assert.deepEqual(autoLine({ tool: { name: 'Edit', input: edit.tool.input } }), { name: 'Edit', what: 'b.ts', desc: false })
  assert.deepEqual(autoLine({ tool: { name: 'WebFetch', input: { url: 'https://docs.slack.dev/a?token=1' } } }), { name: 'WebFetch', what: 'docs.slack.dev', desc: false })
  assert.equal(autoLine({ tool: { name: 'mcp__dokploy__application-one', input: {} } }).name, 'dokploy application-one')
  assert.equal(autoLine({ tool: { name: 'Bash', input: { description: 'd'.repeat(500) } } }).what.length, 100)
})
