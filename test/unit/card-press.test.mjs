// A press on a decision card that seemed ignored (REQ-F-876, AC-1653): the answer's request could stall with no end on
// a phone whose link was down, and the card said nothing while it waited.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ANSWER_WAIT_MS, CARD_LINK_DOWN_MS, LATE, pressNote, withDeadline } from '../../ui/src/lib/card-press.ts'

const NOW = 5_000_000

test('withDeadline: 제때 오면 그 값, 늦으면 LATE', async () => {
  assert.equal(await withDeadline(Promise.resolve(7), 50), 7)
  assert.equal(await withDeadline(new Promise(() => {}), 20), LATE)
  assert.equal(ANSWER_WAIT_MS, 12_000)
})

test('pressNote: 연결이 3초 넘게 끊기면 그것부터, 아니면 보낸 답, 없으면 null', () => {
  const base = { sent: null, link: 'live', downSince: null, now: NOW }
  assert.equal(pressNote(base), null)
  assert.match(pressNote({ ...base, sent: 'Yes, proceed' }), /^보냈어요 \(Yes, proceed\) · 맥이 누르는 중$/)
  assert.match(pressNote({ ...base, sent: 'Yes', link: 'retrying', downSince: NOW - CARD_LINK_DOWN_MS }), /페이지 연결이 끊겨/)
  assert.equal(pressNote({ ...base, link: 'retrying', downSince: NOW - CARD_LINK_DOWN_MS + 1 }), null)
})

test('결정 카드는 답 요청을 withDeadline 으로 감싸고 늦으면 버튼을 다시 푼다', () => {
  const src = readFileSync(new URL('../../ui/src/components/decision-card.tsx', import.meta.url), 'utf8')
  assert.match(src, /withDeadline\(\s*act\(\(\) => dispatch\('permission\.answer'/)
  assert.match(src, /if \(r === LATE\) \{\s*last\.current = 0/)
  assert.match(src, /pressNote\(/)
})
