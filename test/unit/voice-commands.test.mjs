// 음성 명령 (REQ-F-789): the pane at the start of a phrase, 전송 and 리셋 at its end; nothing else is a command.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { voiceCommand } from '../../ui/src/lib/voice-commands.ts'

test('맨 앞의 칸 이름: 첫/두/세 번째·둘째·N번·N번째, 세션·칸, 붙는 말과 쉼표를 뺀다', () => {
  assert.deepEqual(voiceCommand('두 번째 세션, README 정리해 줘', 3), { pane: 2, text: 'README 정리해 줘', end: null })
  assert.deepEqual(voiceCommand('첫번째 세션 테스트 돌려', 3), { pane: 1, text: '테스트 돌려', end: null })
  assert.deepEqual(voiceCommand('세 번째 칸에 이거 봐 줘', 3), { pane: 3, text: '이거 봐 줘', end: null })
  assert.deepEqual(voiceCommand('2번 세션으로 넘겨', 3), { pane: 2, text: '넘겨', end: null })
  assert.deepEqual(voiceCommand('3번째 칸. 좋아', 3), { pane: 3, text: '좋아', end: null })
  assert.deepEqual(voiceCommand('둘째 세션 확인', 2), { pane: 2, text: '확인', end: null })
})

test('칸 이름은 맨 앞에서만, 있는 칸만, 분할이 아니면 그냥 글', () => {
  assert.equal(voiceCommand('그건 두 번째 세션에서 해', 3).pane, null)
  assert.deepEqual(voiceCommand('세 번째 세션 봐', 2), { pane: null, text: '세 번째 세션 봐', end: null })
  assert.deepEqual(voiceCommand('두 번째 세션 정리', 0), { pane: null, text: '두 번째 세션 정리', end: null })
  // "이번" (this time) is never a pane.
  assert.equal(voiceCommand('이번 세션은 끝났어', 3).pane, null)
})

test('맨 끝의 전송·리셋: 뒤 문장 부호와 해/해 줘를 빼고, 다른 자리면 글', () => {
  assert.deepEqual(voiceCommand('README 정리해 줘 전송', 3), { pane: null, text: 'README 정리해 줘', end: 'send' })
  assert.deepEqual(voiceCommand('좋아요. 전송.', 0), { pane: null, text: '좋아요.', end: 'send' })
  assert.deepEqual(voiceCommand('전송해 줘', 0), { pane: null, text: '', end: 'send' })
  assert.deepEqual(voiceCommand('아니 다 틀렸어 리셋', 0), { pane: null, text: '아니 다 틀렸어', end: 'reset' })
  assert.deepEqual(voiceCommand('리셋!', 0), { pane: null, text: '', end: 'reset' })
  assert.deepEqual(voiceCommand('전송 버튼을 고쳐 줘', 0), { pane: null, text: '전송 버튼을 고쳐 줘', end: null })
  assert.deepEqual(voiceCommand('파일 전송', 0).end, 'send')
  assert.deepEqual(voiceCommand('데이터전송', 0), { pane: null, text: '데이터전송', end: null })
})

test('혼자 말한 비슷한 낱말: 자모 하나 차이나 실제로 잘못 쓴 말은 명령, 긴 말 속이나 먼 말은 글 (1.282)', () => {
  for (const w of ['천송', '전성', '정송', '순종', '전송.', '천송!']) assert.equal(voiceCommand(w, 0).end, 'send', w)
  for (const w of ['리셧', '니셋', '리스트', '리스트.']) assert.equal(voiceCommand(w, 0).end, 'reset', w)
  assert.equal(voiceCommand('천송', 0).text, '')
  // Not alone, or too far: words.
  assert.deepEqual(voiceCommand('그거 안 해도 될 거 같다 전성', 0), { pane: null, text: '그거 안 해도 될 거 같다 전성', end: null })
  assert.equal(voiceCommand('한정', 0).end, null)
  assert.equal(voiceCommand('전화', 0).end, null)
  assert.equal(voiceCommand('리스트 보여 줘', 0).end, null)
  assert.equal(voiceCommand('17.', 0).end, null)
  // After a pane, the word alone still counts.
  assert.deepEqual(voiceCommand('두 번째 세션 천송', 3), { pane: 2, text: '', end: 'send' })
})

test('둘 다: 칸으로 옮기고 그 칸에서 보낸다', () => {
  assert.deepEqual(voiceCommand('두 번째 세션 README 정리해 줘 전송', 3), { pane: 2, text: 'README 정리해 줘', end: 'send' })
  assert.deepEqual(voiceCommand('1번 칸 리셋', 3), { pane: 1, text: '', end: 'reset' })
})
