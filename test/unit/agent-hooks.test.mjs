// agent.json hooks (REQ-F-821): a command the Mac's owner names runs after a session starts, closes or ends a turn,
// with the event on stdin and no shell. A wrong entry is skipped and shown by the checks.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { hookList, runHook, AGENT_HOOKS } from '../../agent/guard.mjs'

const AGENT = new URL('../../agent/agent.mjs', import.meta.url).pathname
const home = (p) => (p === '~' || p.startsWith('~/') ? path.join('/home/me', p.slice(1)) : p)

test('hookList: the three names, absolute commands or ~/…, the rest said', () => {
  assert.deepEqual(AGENT_HOOKS, ['session.create.after', 'session.close.after', 'session.done.after'])
  assert.deepEqual(hookList(undefined, home), { out: {}, bad: [] })
  const { out, bad } = hookList({ 'session.create.after': [{ run: '~/bin/on-start' }, { run: 'relative' }], 'session.done.after': [{ run: '/usr/local/bin/x' }], 'session.open.after': [{ run: '/x' }], 'session.close.after': 'nope' }, home)
  assert.deepEqual(out, { 'session.create.after': ['/home/me/bin/on-start'], 'session.done.after': ['/usr/local/bin/x'] })
  assert.equal(bad.length, 3)
  assert.match(bad.join('|'), /모르는 훅 session.open.after/)
  assert.match(bad.join('|'), /session.create.after 의 run 은 명령의 절대 경로/)
  assert.match(hookList([], home).bad[0], /모양이어야/)
})

test('runHook: the body on stdin, no shell, a failure and a timeout reported', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hooks-'))
  const out = path.join(dir, 'got.json')
  const ok = path.join(dir, 'ok')
  fs.writeFileSync(ok, `#!/bin/sh\ncat > ${out}\n`, { mode: 0o755 })
  const body = JSON.stringify({ name: 'session.done', at: 1, session: { id: 's1', cwd: '/w; rm -rf /', host: 'h' } })
  const fails = []
  runHook(ok, body, dir, (why) => fails.push(why))
  for (let i = 0; i < 100 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 20))
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(fs.readFileSync(out, 'utf8'), body, '셸 없이 본문 그대로')
  const bad = path.join(dir, 'bad')
  fs.writeFileSync(bad, '#!/bin/sh\nexit 3\n', { mode: 0o755 })
  const slow = path.join(dir, 'slow')
  fs.writeFileSync(slow, '#!/bin/sh\nsleep 5\n', { mode: 0o755 })
  const why = (run, ms) => new Promise((r) => runHook(run, body, dir, r, ms))
  assert.equal(await why(bad), '3')
  assert.equal(await why(path.join(dir, 'missing')), 'ENOENT')
  assert.equal(await why(slow, 100), '시간 초과')
  assert.deepEqual(fails, [])
})

test('the checks show the hooks: wrong entries and commands that cannot run warn', async (t) => {
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hooks-'))
  const state = path.join(dir, 'state')
  fs.mkdirSync(state)
  fs.writeFileSync(path.join(state, 'agent.json'), JSON.stringify({ site: 'http://127.0.0.1:9', kind: 'server', name: 't', mux: 'tmux', port, noAutoUpdate: true, chrome: false, hooks: { 'session.done.after': [{ run: '~/nothing-here' }], 'turn.after': [] } }))
  const env = { ...process.env, HOME: dir, CLAUDE_BRIDGE_HOME: state, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), CLAUDE_BRIDGE_SKIP_TOOL_PROMPT: '1' }
  const log = path.join(state, 'detached.log')
  const fd = fs.openSync(log, 'a', 0o600)
  const child = spawn(process.execPath, [AGENT, '--no-open', '--detached'], { env, stdio: ['ignore', fd, fd] })
  fs.closeSync(fd)
  t.after(() => child.kill())
  let text = ''
  for (let i = 0; i < 60 && !/모르는 훅/.test(text); i++) {
    await new Promise((r) => setTimeout(r, 250))
    text = fs.readFileSync(log, 'utf8')
  }
  assert.match(text, /모르는 훅 turn\.after/)
  assert.match(text, new RegExp(`실행할 수 없는 명령: ${path.join(dir, 'nothing-here').replace(/[.]/g, '\\.')}`))
})
