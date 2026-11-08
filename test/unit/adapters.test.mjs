// 로컬 어댑터 (REQ-F-893, AC-1704·AC-1705): the agent's side. Which adapters are read, what a call answers, and that
// a write's request id never runs twice (at once, again, after the agent started again).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Adapters, readAdapters } from '../../agent/adapters.mjs'

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-adapters-'))
  return dir
}
// An adapter that counts its runs in runs.txt and answers with the request.
function install(dir, name, conf, script) {
  const d = path.join(dir, 'adapters', name)
  fs.mkdirSync(d, { recursive: true, mode: 0o755 })
  fs.chmodSync(d, 0o755)
  fs.writeFileSync(path.join(d, 'adapter.json'), JSON.stringify(conf), { mode: 0o644 })
  if (script) fs.writeFileSync(path.join(d, 'a.mjs'), script, { mode: 0o644 })
  return d
}
const COUNTING = `import fs from 'node:fs'
const req = JSON.parse(fs.readFileSync(0, 'utf8'))
fs.appendFileSync('runs.txt', req.requestId + '\\n')
const wait = Number(req.input?.wait ?? 0)
if (wait) await new Promise((r) => setTimeout(r, wait))
if (req.input?.fail) { process.stderr.write('slack said no\\n'); process.exit(3) }
if (req.input?.big) process.stdout.write('"' + 'x'.repeat(600 * 1024) + '"')
else if (req.input?.junk) process.stdout.write('not json')
else process.stdout.write(JSON.stringify({ action: req.action, access: req.access, input: req.input, session: req.session }))
`
const conf = { ext: 'slack', command: [process.execPath, 'a.mjs'], actions: { 'thread.read': 'read', 'thread.reply': 'write' }, timeoutMs: 1500 }
const runs = (d) => (fs.existsSync(path.join(d, 'runs.txt')) ? fs.readFileSync(path.join(d, 'runs.txt'), 'utf8').split('\n').filter(Boolean) : [])

test('AC-1704 adapters: what is read and what is refused', () => {
  const dir = home()
  install(dir, 'slack', conf, COUNTING)
  install(dir, 'Bad_Name', conf)
  install(dir, 'nojson', { ext: 'xx' })
  const loose = install(dir, 'loose', conf)
  fs.chmodSync(path.join(loose, 'adapter.json'), 0o666)
  install(dir, 'noactions', { ...conf, actions: { 'thread.read': 'exec' } })
  const { adapters, problems } = readAdapters(dir)
  assert.deepEqual(adapters.map((a) => a.name), ['slack'])
  assert.equal(adapters[0].timeoutMs, 1500)
  const why = Object.fromEntries(problems.map((p) => [p.name, p.error]))
  assert.match(why.Bad_Name, /폴더 이름/)
  assert.match(why.nojson, /command/)
  assert.match(why.loose, /다른 사용자가 고칠 수/)
  assert.match(why.noactions, /actions/)
  assert.deepEqual(readAdapters(path.join(dir, 'none')), { adapters: [], problems: [] })
  const a = new Adapters({ stateDir: dir })
  assert.deepEqual(a.list('slack').actions, { 'thread.read': 'read', 'thread.reply': 'write' })
  assert.deepEqual(a.list('other').actions, {})
})

test('AC-1704 adapters: a call runs the command with the request on stdin', async () => {
  const dir = home()
  const d = install(dir, 'slack', conf, COUNTING)
  const a = new Adapters({ stateDir: dir })
  const r = await a.call({ ext: 'slack', action: 'thread.read', access: 'read', input: { ts: '1' }, requestId: 'read-0001', sid: 's1', cwd: '/w' })
  assert.equal(r.state, 'done')
  assert.deepEqual(r.result, { action: 'thread.read', access: 'read', input: { ts: '1' }, session: { id: 's1', cwd: '/w' } })
  // Refused before anything runs.
  assert.equal((await a.call({ ext: 'slack', action: 'thread.reply', access: 'read', requestId: 'read-0002' })).code, 'access')
  assert.equal((await a.call({ ext: 'slack', action: 'thread.gone', access: 'read', requestId: 'read-0003' })).code, 'not-installed')
  assert.equal((await a.call({ ext: 'other', action: 'thread.read', access: 'read', requestId: 'read-0004' })).code, 'not-installed')
  assert.equal((await a.call({ ext: 'slack', action: 'thread.read', access: 'read', requestId: 'x' })).code, 'bad-request')
  assert.equal((await a.call({ ext: 'slack', action: 'thread.read', access: 'read', requestId: 'read-0005', input: 'x'.repeat(70_000) })).code, 'too-large')
  assert.equal(runs(d).length, 1)
  // A failing adapter says why; a read that takes too long or says too much failed (a read did nothing).
  const f = await a.call({ ext: 'slack', action: 'thread.read', access: 'read', input: { fail: 1 }, requestId: 'read-0006' })
  assert.equal(f.state, 'failed')
  assert.match(f.error, /3 로 끝났어요: slack said no/)
  assert.equal((await a.call({ ext: 'slack', action: 'thread.read', access: 'read', input: { wait: 5000 }, requestId: 'read-0007' })).code, 'timeout')
  assert.equal((await a.call({ ext: 'slack', action: 'thread.read', access: 'read', input: { big: 1 }, requestId: 'read-0008' })).code, 'too-large')
  const j = await a.call({ ext: 'slack', action: 'thread.read', access: 'read', input: { junk: 1 }, requestId: 'read-0009' })
  assert.deepEqual([j.state, j.code], ['failed', 'bad-output'])
})

test('AC-1705 adapters: a write request id runs once — at once, again, after a restart', async () => {
  const dir = home()
  const d = install(dir, 'slack', conf, COUNTING)
  const a = new Adapters({ stateDir: dir })
  const call = (requestId, input = { text: 'hi' }) => a.call({ ext: 'slack', action: 'thread.reply', access: 'write', input, requestId, sid: 's1' })
  // The same id twice at once (a resend while the first runs): one run, the same outcome twice.
  const [x, y] = await Promise.all([call('write-0001', { text: 'hi', wait: 300 }), call('write-0001', { text: 'hi', wait: 300 })])
  assert.equal(x.state, 'done')
  assert.equal(y.state, 'done')
  assert.equal(y.replayed, true)
  // Again later: the kept outcome, not a run.
  const z = await call('write-0001')
  assert.deepEqual([z.state, z.replayed, z.result.input.text], ['done', true, 'hi'])
  assert.deepEqual(runs(d), ['write-0001'])
  // The same id for another action is refused.
  assert.equal((await a.call({ ext: 'slack', action: 'thread.read', access: 'read', requestId: 'write-0001' })).code, 'request-reused')
  // Another extension's id space is its own.
  assert.equal(a.status('other', 'write-0001').state, 'none')
  assert.equal(a.status('slack', 'write-0001').state, 'done')
  assert.equal(a.status('slack', 'never-sent').state, 'none')
  // A write cut short (timeout) may have done its work: unknown, and never run again.
  const t = await call('write-0002', { text: 'slow', wait: 5000 })
  assert.deepEqual([t.state, t.code], ['unknown', 'timeout'])
  assert.equal((await call('write-0002', { text: 'slow' })).state, 'unknown')
  // A failed write stays failed for its id.
  assert.equal((await call('write-0003', { fail: 1 })).state, 'failed')
  assert.equal((await call('write-0003')).state, 'failed')
  assert.deepEqual(runs(d), ['write-0001', 'write-0002', 'write-0003'])

  // A new agent (restart) reads the journal: done stays done, and a write that was running when the old one
  // stopped answers unknown and does not run.
  const journal = JSON.parse(fs.readFileSync(path.join(dir, 'adapters-journal.json'), 'utf8'))
  journal['slack|write-0004'] = { ext: 'slack', action: 'thread.reply', access: 'write', state: 'running', at: Date.now(), boot: 'old-agent' }
  fs.writeFileSync(path.join(dir, 'adapters-journal.json'), JSON.stringify(journal))
  const b = new Adapters({ stateDir: dir })
  assert.equal((await b.call({ ext: 'slack', action: 'thread.reply', access: 'write', input: { text: 'hi' }, requestId: 'write-0001' })).replayed, true)
  const u = await b.call({ ext: 'slack', action: 'thread.reply', access: 'write', input: { text: 'hi' }, requestId: 'write-0004' })
  assert.equal(u.state, 'unknown')
  assert.match(u.error, /다시 시작/)
  assert.equal(b.status('slack', 'write-0004').state, 'unknown')
  assert.deepEqual(runs(d), ['write-0001', 'write-0002', 'write-0003'])
  assert.equal(fs.statSync(path.join(dir, 'adapters-journal.json')).mode & 0o777, 0o600)
})
