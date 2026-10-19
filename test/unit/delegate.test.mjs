// 다른 맥에 맡기기 (REQ-F-760): two Macs played by this test through the bridge tab's routes, a session on one
// handing work to the other through the bridge MCP server's requests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './server-harness.mjs'
import { mac } from './fake-mac.mjs'
import { handle, TOOLS } from '../../agent/mcp.mjs'
import fs from 'node:fs'
import path from 'node:path'

/** Every group in the prefs.json files the server wrote under its data folder. */
const groupsOf = (data) =>
  fs.readdirSync(data, { recursive: true }).filter((f) => path.basename(String(f)) === 'prefs.json').flatMap((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(data, String(f)), 'utf8')).groups ?? [] } catch { return [] }
  })
async function waitFor(fn, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const v = fn()
    if (v) return v
  }
  throw new Error('timed out')
}

test('MCP 서버: initialize·tools/list·tools/call, 알림에는 답하지 않는다 (1.196)', async () => {
  assert.equal((await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).result.protocolVersion, '2025-06-18')
  assert.deepEqual((await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.map((t) => t.name), ['hosts', 'delegate', 'delegate_status', 'delegate_send', 'delegate_stop', 'todos'])
  assert.equal(TOOLS.length, 6)
  const ok = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hosts', arguments: {} } }, async () => [{ name: 'b' }])
  assert.match(ok.result.content[0].text, /"name": "b"/)
  const bad = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delegate', arguments: {} } }, async () => {
    throw new Error('그런 맥이 없어요')
  })
  assert.equal(bad.result.isError, true)
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  assert.equal((await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } })).error.code, -32602)
})

test('할 일 도구: 에이전트에 묻지 않고 맥 안에서 답한다 (REQ-F-778)', async () => {
  const call = (args) => handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'todos', arguments: args } })
  const ok = await call({ todos: [{ content: '고치기', status: 'completed' }, { content: '배포', status: 'pending' }] })
  assert.equal(ok.result.isError, undefined)
  assert.equal(ok.result.content[0].text, '할 일 2개 중 1개 완료로 패널에 보였어요.')
  assert.equal((await call({ todos: [] })).result.content[0].text, '할 일 패널을 비웠어요.')
  assert.equal((await call({})).result.isError, true)
})

test('다른 맥에 맡기기: 답을 기다려 받고, 한 단계만, 허용 정책을 따라가며, 끄면 거절, 닫으면 같이 닫힌다 (1.196)', async () => {
  const s = await startServer()
  const A = 'aaaaaaaa-0000-4000-8000-00000000000a'
  const B = 'bbbbbbbb-0000-4000-8000-00000000000b'
  let a, b
  try {
    await s.login('alice')
    a = await mac(s, 'alice', A, 'mac-a')
    b = await mac(s, 'alice', B, 'mac-b')
    // The session on A that hands work over.
    const started = s.api('alice', '/api/sessions', { method: 'POST', body: { hostId: A, cwd: '~', prompt: '시작' } })
    await a.answerNew()
    const parent = (await started).json.id
    const ask = async (op, args) => {
      const areq = `r-${Math.random()}`
      await a.up({ t: 'delegate', areq, sid: parent, op, args })
      return a.next((m) => m.t === 'delegated' && m.areq === areq, 15000)
    }
    const hosts = await ask('hosts', {})
    assert.equal(hosts.ok, true)
    assert.deepEqual(hosts.result.map((h) => [h.name, h.online, h.takesWork, h.thisMac]), [['mac-a', true, true, true], ['mac-b', true, true, false]])
    // Handed over and waited on: B starts a session with the task, works, and answers.
    const areq = 'r-delegate'
    await a.up({ t: 'delegate', areq, sid: parent, op: 'delegate', args: { host: 'MAC-B', task: '빌드해 줘', timeout_s: 20 } })
    const opened = await b.answerNew()
    assert.equal(opened.prompt, '빌드해 줘')
    assert.equal(opened.mode, 'default')
    // No cwd: a new folder under the default folder, made when it starts (1.206).
    assert.match(opened.cwd, /^~\/bridge\/works\/기타\/\d{4}-[0-9a-f]{6}$/)
    assert.equal(opened.create, true)
    const child = opened.sid
    // It goes in the group "Bridge 맡긴 세션", made at the top since there was none (1.252).
    const grouped = await waitFor(() => groupsOf(s.data).find((g) => g.name === 'Bridge 맡긴 세션' && g.items.includes(child)))
    assert.equal(grouped.parent, undefined)
    assert.ok(!groupsOf(s.data).some((g) => g.items.includes(parent)))
    await b.up({ t: 'status', sid: child, alive: true, phase: 'busy' })
    await b.up({ t: 'lines', sid: child, from: 0, lines: [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '원인을 볼게요' }] } })] })
    // Idle for a moment between tool calls is not the end of the turn.
    await b.up({ t: 'status', sid: child, alive: true, phase: 'idle' })
    await new Promise((r) => setTimeout(r, 1500))
    await b.up({ t: 'status', sid: child, alive: true, phase: 'busy' })
    await b.up({ t: 'lines', sid: child, from: 1, lines: [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '빌드했어요' }] } })] })
    await b.up({ t: 'status', sid: child, alive: true, phase: 'idle' })
    const done = await a.next((m) => m.t === 'delegated' && m.areq === areq, 15000)
    assert.equal(done.ok, true, done.error)
    assert.equal(done.result.state, 'done')
    assert.equal(done.result.answer, '빌드했어요')
    assert.equal(done.result.host, 'mac-b')
    assert.equal(done.result.id, child)
    // Said by the session that handed it over: told apart from what the person types, even when a page claims it (1.207).
    assert.equal((await s.api('alice', `/api/sessions/${child}/send`, { method: 'POST', body: { text: '내가 직접', via: 'delegate' } })).status, 200)
    assert.equal((await ask('delegate_send', { id: child, text: '테스트도', wait: false })).ok, true)
    const said = (await s.api('alice', `/api/sessions/${child}/events`)).json.events.filter((e) => e.k === 'user')
    assert.deepEqual(said.map((e) => [e.text, e.via]), [['빌드해 줘', 'delegate'], ['내가 직접', 'web'], ['테스트도', 'delegate']])
    // Handed another: it joins the same group, no second one is made (1.252).
    const second = ask('delegate', { host: 'mac-b', task: '둘째', wait: false })
    const child2 = (await b.answerNew()).sid
    assert.equal((await second).ok, true)
    await waitFor(() => groupsOf(s.data).some((g) => g.items.includes(child2)))
    assert.deepEqual(groupsOf(s.data).filter((g) => g.name === 'Bridge 맡긴 세션').map((g) => g.items), [[child, child2]])
    // One level only.
    const areq2 = 'r-again'
    await b.up({ t: 'delegate', areq: areq2, sid: child, op: 'delegate', args: { host: 'mac-a', task: 'x' } })
    const again = await b.next((m) => m.t === 'delegated' && m.areq === areq2)
    assert.equal(again.ok, false)
    assert.match(again.error, /다시 맡길 수 없어요/)
    // Another Mac's session cannot speak for this one.
    const areq3 = 'r-spoof'
    await b.up({ t: 'delegate', areq: areq3, sid: parent, op: 'hosts', args: {} })
    assert.equal((await b.next((m) => m.t === 'delegated' && m.areq === areq3)).ok, false)
    // 전부 허용 on the session that handed it over reaches the one it handed to.
    assert.equal((await s.api('alice', `/api/sessions/${parent}/settings`, { method: 'POST', body: { autoAllow: true } })).status, 200)
    const set = await b.next((m) => m.t === 'set' && m.sid === child && 'autoAllow' in m)
    assert.equal(set.autoAllow, true)
    // Turned off on B: refused.
    assert.equal((await s.api('alice', `/api/hosts/${B}/delegate`, { method: 'POST', body: { on: false } })).status, 200)
    const off = await ask('delegate', { host: 'mac-b', task: 'y' })
    assert.equal(off.ok, false)
    assert.match(off.error, /꺼져 있어요/)
    assert.equal((await ask('hosts', {})).result.find((h) => h.name === 'mac-b').takesWork, false)
    // Closing the session that handed it over closes the one it handed to.
    assert.equal((await s.api('alice', `/api/sessions/${parent}/close`, { method: 'POST', body: {} })).status, 200)
    await b.next((m) => m.t === 'close' && m.sid === child)
  } finally {
    a?.close()
    b?.close()
    await s.stop()
  }
})

test('맡긴 세션의 턴이 끝나면 맡긴 세션에 답이 글로 간다, 기다리는 호출이 있으면 안 간다 (1.236, 1.241)', async () => {
  const s = await startServer()
  const A = 'aaaaaaaa-0000-4000-8000-00000000001a'
  const B = 'bbbbbbbb-0000-4000-8000-00000000001b'
  let a, b
  try {
    await s.login('alice')
    a = await mac(s, 'alice', A, 'mac-a')
    b = await mac(s, 'alice', B, 'mac-b')
    const started = s.api('alice', '/api/sessions', { method: 'POST', body: { hostId: A, cwd: '~', prompt: '시작' } })
    await a.answerNew()
    const parent = (await started).json.id
    await a.up({ t: 'status', sid: parent, alive: true, phase: 'idle' })
    const ask = async (op, args) => {
      const areq = `r-${Math.random()}`
      await a.up({ t: 'delegate', areq, sid: parent, op, args })
      return a.next((m) => m.t === 'delegated' && m.areq === areq, 15000)
    }
    // Not waited on: the call returns at once, and the end of the turn comes back as a message.
    const pending = ask('delegate', { host: 'mac-b', task: '배포해 줘', wait: false })
    const opened = await b.answerNew()
    const child = opened.sid
    assert.equal((await pending).result.state, 'working')
    await b.up({ t: 'status', sid: child, alive: true, phase: 'busy' })
    // As a real Mac does: the end of the turn first, the transcript line with the answer a moment later.
    await b.up({ t: 'status', sid: child, alive: true, phase: 'idle' })
    await new Promise((r) => setTimeout(r, 6000))
    await b.up({ t: 'lines', sid: child, from: 0, lines: [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '배포했어요' }] } })] })
    const sent = await a.next((m) => m.t === 'send' && m.sid === parent, 15000)
    assert.match(sent.text, /^↪ mac-b 에 맡긴 세션의 턴이 끝났어요 \(id [0-9a-f-]{36}, "배포해 줘"\)\n\n배포했어요$/)
    assert.ok(sent.text.includes(child))
    const said = (await s.api('alice', `/api/sessions/${parent}/events`)).json.events.filter((e) => e.k === 'user')
    assert.deepEqual(said.at(-1).via, 'delegated')
    // A page cannot pass itself off as that answer.
    assert.equal((await s.api('alice', `/api/sessions/${parent}/send`, { method: 'POST', body: { text: '나', via: 'delegated' } })).status, 200)
    assert.equal((await s.api('alice', `/api/sessions/${parent}/events`)).json.events.filter((e) => e.k === 'user').at(-1).via, 'web')
    // Waited on: the call gets the answer, and no message follows.
    const areq = 'r-wait'
    await a.up({ t: 'delegate', areq, sid: parent, op: 'delegate_status', args: { id: child, wait: true, timeout_s: 20 } })
    await b.up({ t: 'status', sid: child, alive: true, phase: 'busy' })
    await b.up({ t: 'lines', sid: child, from: 1, lines: [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '고쳤어요' }] } })] })
    await b.up({ t: 'status', sid: child, alive: true, phase: 'idle' })
    const waited = await a.next((m) => m.t === 'delegated' && m.areq === areq, 15000)
    assert.equal(waited.result.answer, '고쳤어요')
    await assert.rejects(a.next((m) => m.t === 'send' && m.sid === parent && /고쳤어요/.test(m.text), 7000))
  } finally {
    a?.close()
    b?.close()
    await s.stop()
  }
})
