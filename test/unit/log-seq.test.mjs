// A session's log keeps one number per event and one row per item (REQ-F-062): during a deploy the server being
// replaced and its successor both write the same log for a few seconds, and the page drew repeats from it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startServer } from './server-harness.mjs'
import { mac } from './fake-mac.mjs'
import { emptyFold, fold } from '../../ui/src/lib/timeline.ts'

test('a server that started from an older meta.json counts on from the Mac\'s last number (1.277)', async () => {
  const srv = await startServer()
  let m
  try {
    await srv.login('alice')
    m = await mac(srv, 'alice', 'host-alice-0001', 'alice-mac')
    const started = srv.api('alice', '/api/sessions', { method: 'POST', body: { hostId: 'host-alice-0001', cwd: '~/x' } })
    await m.answerNew()
    const sid = (await started).json.id
    await m.up({ t: 'note', sid, text: '하나' })
    const seqs = async () => (await srv.api('alice', `/api/sessions/${sid}/events`)).json.events.map((e) => e.seq)
    const mine = (await seqs()).at(-1)
    // The server being replaced numbered three more that this one never saw; the Mac kept them and says so.
    await m.up({ t: 'hello', caps: [], name: 'alice-mac', sessions: [{ id: sid, cwd: '/Users/x', alive: true, seq: mine + 3 }] })
    await m.up({ t: 'note', sid, text: '둘' })
    const after = await seqs()
    assert.equal(after.at(-1), mine + 4)
    assert.equal(new Set(after).size, after.length, '같은 번호가 두 번 없음')
    assert.ok(!fs.existsSync(path.join(srv.data, 'u/dev-alice/s', sid, 'events.jsonl')), '서버는 기록 파일을 쓰지 않음')
  } finally {
    m?.close()
    await srv.stop()
  }
})

test('a tool call logged twice is one row', () => {
  const ev = (seq, e) => ({ seq, at: seq, ...e })
  const f = fold(emptyFold(), [
    ev(1, { k: 'tool', tool: 't1', name: 'Bash', label: 'ls' }),
    ev(2, { k: 'tool_end', tool: 't1', error: false, text: 'a' }),
    ev(3, { k: 'tool', tool: 't1', name: 'Bash', label: 'ls' }),
    ev(4, { k: 'tool_end', tool: 't1', error: false, text: 'a' }),
    ev(5, { k: 'user', id: 'u1', text: '안녕' }),
    ev(6, { k: 'user', id: 'u1', text: '안녕' }),
  ])
  assert.deepEqual(f.items.map((i) => i.key), ['x:t1', 'u:u1'])
  assert.equal(f.items[0].done, true)
  // The same again, folded on top of what is there (a later batch).
  const g = fold(f, [ev(7, { k: 'tool', tool: 't1', name: 'Bash', label: 'ls' })])
  assert.equal(g.items.length, 2)
})
