// 앱에서 백그라운드 대화 (REQ-F-912)·다이내믹 아일랜드 (REQ-F-913): the page asks for the audio session only inside
// the iOS app, puts back what was there, and tells only the app.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { holdAudioSession, inIosApp, tellTalk } from '../../ui/src/lib/native.ts'

const APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 AgentBridge/1.4 (459000)'
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1'
const withNavigator = (nav, fn) => {
  const was = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true })
  try {
    fn()
  } finally {
    if (was) Object.defineProperty(globalThis, 'navigator', was)
    else delete globalThis.navigator
  }
}

test('AC-1810 audioSession: 앱 안에서만 play-and-record 로 두고 끝나면 되돌린다. Safari·지원 없음은 건드리지 않는다', () => {
  withNavigator({ userAgent: APP, audioSession: { type: 'auto' } }, () => {
    assert.equal(inIosApp(), true)
    const back = holdAudioSession()
    assert.equal(navigator.audioSession.type, 'play-and-record')
    back()
    assert.equal(navigator.audioSession.type, 'auto')
  })
  withNavigator({ userAgent: SAFARI, audioSession: { type: 'auto' } }, () => {
    assert.equal(inIosApp(), false)
    holdAudioSession()
    assert.equal(navigator.audioSession.type, 'auto')
  })
  withNavigator({ userAgent: APP }, () => assert.doesNotThrow(() => holdAudioSession()()))
})

test('AC-1811 대화 상태는 앱의 talk 핸들러로만 가고, 없으면 조용히 넘어간다', () => {
  const got = []
  tellTalk({ op: 'start', phase: 'listening', title: 'x' }, { webkit: { messageHandlers: { talk: { postMessage: (m) => got.push(m) } } } })
  tellTalk({ op: 'end' }, { webkit: { messageHandlers: { talk: { postMessage: (m) => got.push(m) } } } })
  assert.deepEqual(got, [{ op: 'start', phase: 'listening', title: 'x' }, { op: 'end' }])
  assert.doesNotThrow(() => tellTalk({ op: 'end' }, {}))
})
