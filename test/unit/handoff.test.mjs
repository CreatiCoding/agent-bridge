// REQ-F-857 (AC-1609): the hand-over summary is read back out of the Claude Code session's answer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { HANDOFF_ASK, HANDOFF_ASK_HEAD, HANDOFF_HEAD, handoffAsk, handoffAskHead, handoffHead, handoffOf, isHandoffAsk, otherRunner, summaryAfterAsk } from '../../ui/src/lib/handoff.ts'

test('handoffOf: the last handoff block, or null', () => {
  assert.equal(handoffOf('확인했어요.\n\n```handoff\n## 목표\nA\n```\n'), '## 목표\nA')
  assert.equal(handoffOf('```handoff\n첫\n```\n고쳐서\n```handoff\n둘\n```'), '둘')
  // An answer cut before its closing fence still gives what it wrote.
  assert.equal(handoffOf('```handoff\n## 남은 작업\n- x'), '## 남은 작업\n- x')
  assert.equal(handoffOf('블록 없음'), null)
  assert.equal(handoffOf('```handoff\n\n```'), null)
})

test('the request asks for every part the person listed, and the Codex head keeps the folder as it is', () => {
  assert.ok(HANDOFF_ASK.startsWith(HANDOFF_ASK_HEAD))
  for (const part of ['목표', '요구사항', '결정 사항', '변경 파일', '검증 결과', '남은 작업']) assert.ok(HANDOFF_ASK.includes(`## ${part}`), part)
  assert.match(HANDOFF_ASK, /고치지 말고/)
  assert.match(HANDOFF_HEAD, /되돌리거나 지우지 말고/)
  assert.match(HANDOFF_HEAD, /worktree/)
})

const ev = (seq, e) => ({ seq, at: seq, ...e })
test('summaryAfterAsk: the answers after the last request', () => {
  assert.deepEqual(summaryAfterAsk([ev(1, { k: 'user', text: '다른 일' }), ev(2, { k: 'text', text: '```handoff\n옛\n```' })]), { asked: false, summary: null, last: false, block: false })
  const asked = [ev(1, { k: 'user', text: HANDOFF_ASK }), ev(2, { k: 'tool', tool: 't', name: 'Bash', label: 'git status' }), ev(3, { k: 'text', text: '보고 있어요' })]
  // Words without a block yet: the last words, until a block comes.
  assert.deepEqual(summaryAfterAsk(asked), { asked: true, summary: '보고 있어요', last: true, block: false })
  const done = [...asked, ev(4, { k: 'text', text: '정리했어요\n```handoff\n## 목표\n새\n```' })]
  assert.deepEqual(summaryAfterAsk(done), { asked: true, summary: '## 목표\n새', last: true, block: true })
  // Asked something after it: the summary is old.
  assert.equal(summaryAfterAsk([...done, ev(5, { k: 'user', text: '하나 더 고쳐 줘' })]).last, false)
  // A newer request counts, not an older answer.
  assert.deepEqual(summaryAfterAsk([...done, ev(5, { k: 'user', text: HANDOFF_ASK })]), { asked: true, summary: null, last: true, block: false })
})

// REQ-F-891 (AC-1699): the switch texts go both ways, and a request of the sheet before it is still found.
test('실행기 전환: the request and head name the runners, both ways', () => {
  assert.equal(otherRunner('claude'), 'codex')
  assert.equal(otherRunner('codex'), 'claude')
  assert.match(handoffAskHead('claude'), /Claude Code 가 이어서/)
  assert.ok(handoffAsk('claude').startsWith(handoffAskHead('claude')))
  for (const to of ['claude', 'codex']) assert.ok(isHandoffAsk(handoffAsk(to)), to)
  // The request of the sheet that started a new Codex session (REQ-F-857), still in older conversations.
  assert.ok(isHandoffAsk('이 작업을 같은 폴더의 Codex 세션이 이어서 하도록 인계 요약을 써 주세요. 받는 쪽은…'))
  assert.ok(!isHandoffAsk('인계 요약을 써 주세요'))
  const back = handoffHead('codex', 'claude', true)
  assert.match(back, /Codex 로 작업했고/)
  assert.match(back, /이제 Claude Code 로 바뀌었어요/)
  assert.match(back, /예전에 Claude Code 로 돌던 때/)
  assert.doesNotMatch(handoffHead('claude', 'codex'), /예전에/)
  const asked = [ev(1, { k: 'user', text: handoffAsk('claude') }), ev(2, { k: 'text', text: '```handoff\n## 목표\nC\n```' })]
  assert.deepEqual(summaryAfterAsk(asked), { asked: true, summary: '## 목표\nC', last: true, block: true })
})
