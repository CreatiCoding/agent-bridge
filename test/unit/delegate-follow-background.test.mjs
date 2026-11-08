// 다른 맥에 맡기기 (REQ-F-760, 1.391): 백그라운드 작업이 남은 턴
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withDelegateRig, SETTLE, QUIET, sleep } from './delegate-follow-rig.mjs'

test('맡긴 세션의 턴이 끝나면 맡긴 세션에 답이 글로 간다, 기다리는 호출이 있으면 안 간다 (1.236, 1.241): 백그라운드 작업이 남은 턴은 전하되 닫지 않는다 (1.391)', () => withDelegateRig(async ({ s, a, b, parent, ask }) => {
  // 1.391: a turn that ends with background work running ("CI 기다리는 중") is passed on but not closed; the turn the
  // work wakes it for closes it.
  const pending4 = ask('delegate', { host: 'mac-b', task: 'CI 봐 줘', wait: false })
  const child4 = (await b.answerNew()).sid
  await pending4
  const line = (o) => JSON.stringify(o)
  await b.up({ t: 'status', sid: child4, alive: true, phase: 'busy' })
  await b.up({ t: 'lines', sid: child4, from: 0, lines: [
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'gh run watch', run_in_background: true } }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Command running in background with ID: bq1. Output is being written to: /tmp/q' }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'CI 기다리는 중 ⏳' }] } }),
  ] })
  await b.up({ t: 'status', sid: child4, alive: true, phase: 'idle' })
  const mid = await a.next((m) => m.t === 'send' && m.sid === parent && /CI 기다리는 중/.test(m.text), 15000)
  assert.match(mid.text, /\n\n\(백그라운드 작업이 남아 아직 닫지 않았어요\)$/)
  await assert.rejects(b.next((m) => m.t === 'close' && m.sid === child4, QUIET))
  const ev4 = (await s.api('alice', `/api/sessions/${child4}/events`)).json.events
  assert.ok(ev4.some((e) => e.k === 'notice' && /백그라운드 작업이 남아 아직 닫지 않았어요/.test(e.text)))
  // The command ends; Claude is woken by it, answers, and ends the turn: now it closes.
  await b.up({ t: 'status', sid: child4, alive: true, phase: 'busy' })
  await b.up({ t: 'lines', sid: child4, from: 3, lines: [
    line({ type: 'user', message: { content: '<task-notification><task-id>bq1</task-id><tool-use-id>tu1</tool-use-id><status>completed</status></task-notification>' } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'CI 통과, 배포 끝' }] } }),
  ] })
  await b.up({ t: 'status', sid: child4, alive: true, phase: 'idle' })
  const fin = await a.next((m) => m.t === 'send' && m.sid === parent && /CI 통과, 배포 끝/.test(m.text), 15000)
  assert.ok(!/아직 닫지 않았어요/.test(fin.text))
  await b.next((m) => m.t === 'close' && m.sid === child4, 15000)
}))
