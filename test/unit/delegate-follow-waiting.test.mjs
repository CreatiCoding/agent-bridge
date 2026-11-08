// 다른 맥에 맡기기 (REQ-F-760, 1.390): 사람을 기다리는 세션
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withDelegateRig, SETTLE, QUIET, sleep } from './delegate-follow-rig.mjs'

test('맡긴 세션의 턴이 끝나면 맡긴 세션에 답이 글로 간다, 기다리는 호출이 있으면 안 간다 (1.236, 1.241): 사람을 기다리는 세션은 닫지 않는다', () => withDelegateRig(async ({ b, ask }) => {
  // A session waiting on the person is not closed: nothing was handed over.
  const pending3 = ask('delegate', { host: 'mac-b', task: '물어봐', wait: false })
  const child3 = (await b.answerNew()).sid
  await pending3
  await b.up({ t: 'status', sid: child3, alive: true, phase: 'waiting' })
  await assert.rejects(b.next((m) => m.t === 'close' && m.sid === child3, QUIET))
}))
