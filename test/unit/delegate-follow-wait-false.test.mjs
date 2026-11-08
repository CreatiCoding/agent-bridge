// 다른 맥에 맡기기 (REQ-F-760, 1.236·1.241·1.390): 기다리지 않은 호출
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withDelegateRig, SETTLE, QUIET, sleep } from './delegate-follow-rig.mjs'

test('맡긴 세션의 턴이 끝나면 맡긴 세션에 답이 글로 간다, 기다리는 호출이 있으면 안 간다 (1.236, 1.241): 기다리지 않은 호출은 턴 끝을 글로 받는다', () => withDelegateRig(async ({ s, a, b, parent, ask }) => {
  // Not waited on: the call returns at once, and the end of the turn comes back as a message.
  const pending = ask('delegate', { host: 'mac-b', task: '배포해 줘', wait: false })
  const opened = await b.answerNew()
  const child = opened.sid
  assert.equal((await pending).result.state, 'working')
  await b.up({ t: 'status', sid: child, alive: true, phase: 'busy' })
  // As a real Mac does: the end of the turn first, the transcript line with the answer a moment later (after a settle).
  await b.up({ t: 'status', sid: child, alive: true, phase: 'idle' })
  await sleep(SETTLE * 2)
  await b.up({ t: 'lines', sid: child, from: 0, lines: [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '배포했어요' }] } })] })
  const sent = await a.next((m) => m.t === 'send' && m.sid === parent, 15000)
  assert.match(sent.text, /^↪ mac-b 에 맡긴 세션의 턴이 끝났어요 \(id [0-9a-f-]{36}, "배포해 줘"\)\n\n배포했어요$/)
  assert.ok(sent.text.includes(child))
  const said = (await s.api('alice', `/api/sessions/${parent}/events`)).json.events.filter((e) => e.k === 'user')
  assert.deepEqual(said.at(-1).via, 'delegated')
  // A page cannot pass itself off as that answer.
  assert.equal((await s.api('alice', `/api/sessions/${parent}/send`, { method: 'POST', body: { text: '나', via: 'delegated' } })).status, 200)
  assert.equal((await s.api('alice', `/api/sessions/${parent}/events`)).json.events.filter((e) => e.k === 'user').at(-1).via, 'web')
  // That message handed the answer over: the session closes by itself (1.390).
  await b.next((m) => m.t === 'close' && m.sid === child)
}))
