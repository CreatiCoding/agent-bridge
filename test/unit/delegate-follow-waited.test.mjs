// 다른 맥에 맡기기 (REQ-F-760, 1.236·1.390): 기다리는 호출
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withDelegateRig, SETTLE, QUIET, sleep } from './delegate-follow-rig.mjs'

test('맡긴 세션의 턴이 끝나면 맡긴 세션에 답이 글로 간다, 기다리는 호출이 있으면 안 간다 (1.236, 1.241): 기다리는 호출이 답을 받으면 글은 가지 않고 닫힌다', () => withDelegateRig(async ({ a, b, parent, ask }) => {
  // Waited on: the call gets the answer, no message follows, and it closes too.
  const pending2 = ask('delegate', { host: 'mac-b', task: '고쳐 줘', wait: false })
  const child2 = (await b.answerNew()).sid
  await pending2
  const areq = 'r-wait'
  await a.up({ t: 'delegate', areq, sid: parent, op: 'delegate_status', args: { id: child2, wait: true, timeout_s: 20 } })
  await b.up({ t: 'status', sid: child2, alive: true, phase: 'busy' })
  await b.up({ t: 'lines', sid: child2, from: 0, lines: [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '고쳤어요' }] } })] })
  await b.up({ t: 'status', sid: child2, alive: true, phase: 'idle' })
  const waited = await a.next((m) => m.t === 'delegated' && m.areq === areq, 15000)
  assert.equal(waited.result.answer, '고쳤어요')
  await b.next((m) => m.t === 'close' && m.sid === child2)
  await assert.rejects(a.next((m) => m.t === 'send' && m.sid === parent && /고쳤어요/.test(m.text), QUIET))
}))
