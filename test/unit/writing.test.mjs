// 쓰는 중인 글 (REQ-F-137, AC-1717): a choices block never shows as a code block, and a preview outlives no turn.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writingShown } from '../../ui/src/lib/writing.ts'

test('끝난 choices 블록은 쓰는 중인 글에서 뺀다', () => {
  assert.equal(writingShown('답이에요.\n\n```choices\n예\n아니요\n```', 'busy'), '답이에요.')
})

test('아직 쓰는 중인(닫히지 않은) choices 블록도 뺀다', () => {
  assert.equal(writingShown('답이에요.\n\n```choices\n예\n아니', 'busy'), '답이에요.')
})

test('choices 블록만 남으면 아무것도 보이지 않는다', () => {
  assert.equal(writingShown('```choices\n예\n```', 'busy'), '')
})

test('다른 코드 블록은 그대로 둔다', () => {
  const t = '보세요.\n\n```ts\nconst a = 1\n```'
  assert.equal(writingShown(t, 'busy'), t)
})

test('턴이 없으면(쉼·끝남) 남은 글을 보이지 않는다', () => {
  assert.equal(writingShown('답이에요.', 'idle'), '')
  assert.equal(writingShown('답이에요.', 'ended'), '')
  assert.equal(writingShown('답이에요.', 'waiting'), '답이에요.')
  assert.equal(writingShown('답이에요.', undefined), '답이에요.')
})
