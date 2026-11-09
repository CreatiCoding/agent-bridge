// 봉인한 맥의 답 끝 choices 블록 (REQ-F-136, AC-1718): the server sees one sealed piece, so the page takes the
// block out after opening it, by the server's rule (server/events.go extractChoices).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractChoices, choicesAfterOpen } from '../../ui/src/lib/choices.ts'

const PIECE = '⟦bt1:0123abcd:' + 'A'.repeat(40) + '⟧'

test('끝의 choices 블록을 버튼 목록으로 뽑는다', () => {
  assert.deepEqual(extractChoices('어떻게 할까요?\n\n```choices\n예\n아니요\n```'), { text: '어떻게 할까요?', choices: ['예', '아니요'] })
})

test('choices 뒤에 출처 목록만 있으면 뽑고 출처는 남긴다', () => {
  const t = '답.\n\n```choices\n예\n```\n\n출처:\n- [a](https://a.example)'
  assert.deepEqual(extractChoices(t), { text: '답.\n\n출처:\n- [a](https://a.example)', choices: ['예'] })
})

test('choices 뒤에 다른 글이 있으면 그대로 둔다', () => {
  const t = '```choices\n예\n```\n\n그리고 더'
  assert.deepEqual(extractChoices(t), { text: t, choices: null })
})

test('빈 줄은 빼고 최대 6개', () => {
  const r = extractChoices('```choices\n1\n\n2\n3\n4\n5\n6\n7\n```')
  assert.deepEqual(r.choices, ['1', '2', '3', '4', '5', '6'])
})

test('마지막 choices 블록만 쓴다', () => {
  const r = extractChoices('```choices\nA\n```\n\n```choices\nB\n```')
  assert.deepEqual(r, { text: '```choices\nA\n```', choices: ['B'] })
})

test('봉인된 text 항목은 푼 뒤 choices 를 뽑는다', () => {
  const opened = { k: 'text', text: '고를까요?\n\n```choices\n예\n아니요\n```' }
  assert.deepEqual(choicesAfterOpen({ k: 'text', text: PIECE }, opened), { k: 'text', text: '고를까요?', choices: ['예', '아니요'] })
})

test('평문 항목·서버가 이미 뽑은 항목·다른 종류는 건드리지 않는다', () => {
  const t = '```choices\n예\n```'
  assert.deepEqual(choicesAfterOpen({ k: 'text', text: t }, { k: 'text', text: t }), { k: 'text', text: t })
  const given = { k: 'text', text: t, choices: ['x'] }
  assert.deepEqual(choicesAfterOpen({ k: 'text', text: PIECE, choices: ['x'] }, given), given)
  assert.deepEqual(choicesAfterOpen({ k: 'line', text: PIECE }, { k: 'line', text: t }), { k: 'line', text: t })
})
