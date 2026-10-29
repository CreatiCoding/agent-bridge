// `node agent.mjs start` (REQ-F-813): what cron, Raycast or a login item calls. It starts one agent in the
// background and exits 0, and does nothing when one already runs. Run for real in a throwaway home.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'

const AGENT = new URL('../../agent/agent.mjs', import.meta.url).pathname

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

function home(port, more = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-start-'))
  const state = path.join(dir, 'state')
  fs.mkdirSync(state)
  fs.writeFileSync(path.join(state, 'agent.json'), JSON.stringify({ site: 'http://127.0.0.1:9', kind: 'server', name: 't', mux: 'tmux', port, noAutoUpdate: true, chrome: false, ...more }))
  // HOME too: the agent writes Claude Code's hook settings under it.
  const env = { ...process.env, HOME: dir, CLAUDE_BRIDGE_HOME: state, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), CLAUDE_BRIDGE_SKIP_TOOL_PROMPT: '1' }
  const run = (...args) => spawnSync(process.execPath, [AGENT, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
  return { dir, state, run }
}

const ping = (port) => fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json(), () => null)

test('start: one agent in the background, a second start does nothing, the child never moves to another port', async (t) => {
  const port = await freePort()
  const h = home(port)
  let pid = 0
  t.after(() => {
    try {
      if (pid) process.kill(pid)
    } catch {}
  })
  const first = h.run('start')
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /백그라운드로 띄웠습니다/)
  pid = Number(fs.readFileSync(path.join(h.state, 'agent.pid'), 'utf8'))
  assert.equal((await ping(port))?.agent, 'claude-bridge')
  assert.equal(fs.statSync(path.join(h.state, 'detached.log')).mode & 0o777, 0o600)

  const second = h.run('start')
  assert.equal(second.status, 0)
  assert.match(second.stdout, /이미 켜져 있습니다/)
  assert.equal(Number(fs.readFileSync(path.join(h.state, 'agent.pid'), 'utf8')), pid, '두 번째 에이전트가 없음')

  const beside = h.run('--no-open', '--detached')
  assert.equal(beside.status, 1)
  assert.match(beside.stderr, /이미 쓰고 있어 끝냅니다/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.state, 'agent.json'), 'utf8')).port, port, '옆 포트로 옮기지 않음')
  // Not in a terminal: no launchEnv is saved (it is taken from the last run in a terminal).
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.state, 'agent.json'), 'utf8')).launchEnv, undefined)
  // The checks are printed once they ran (a few seconds after the agent answers).
  let logText = ''
  for (let i = 0; i < 40 && !/실행 방식: `start` 로 실행/.test(logText); i++) {
    await new Promise((r) => setTimeout(r, 250))
    logText = fs.readFileSync(path.join(h.state, 'detached.log'), 'utf8')
  }
  assert.match(logText, /실행 방식: `start` 로 실행/)
})

test('--detached without tmux and claude on PATH: the checks say the PATH is why', async (t) => {
  const port = await freePort()
  const h = home(port)
  t.after(() => {
    try {
      process.kill(Number(fs.readFileSync(path.join(h.state, 'agent.pid'), 'utf8')))
    } catch {}
  })
  // A PATH like cron's, without the tools: only node's own folder.
  const env = { ...process.env, HOME: h.dir, CLAUDE_BRIDGE_HOME: h.state, CLAUDE_CONFIG_DIR: path.join(h.dir, '.claude'), CLAUDE_BRIDGE_SKIP_TOOL_PROMPT: '1', PATH: path.dirname(process.execPath) }
  const log = path.join(h.state, 'detached.log')
  const fd = fs.openSync(log, 'a', 0o600)
  const child = spawn(process.execPath, [AGENT, '--no-open', '--detached'], { env, stdio: ['ignore', fd, fd] })
  fs.closeSync(fd)
  t.after(() => child.kill())
  let text = ''
  for (let i = 0; i < 60 && !/`start` 의 PATH/.test(text); i++) {
    await new Promise((r) => setTimeout(r, 250))
    text = fs.readFileSync(log, 'utf8')
  }
  assert.match(text, /`start` 의 PATH.*claude/)
  assert.match(text, /부른 쪽\(cron·Raycast\)의 PATH/)
})

test('start: a service file means the service starts the agent', async (t) => {
  const h = home(await freePort())
  // Should this fail and start an agent after all, it does not outlive the test.
  t.after(() => {
    try {
      process.kill(Number(fs.readFileSync(path.join(h.state, 'agent.pid'), 'utf8')))
    } catch {}
  })
  // The unit path the agent uses on Linux (XDG_CONFIG_HOME unset: ~/.config).
  const unit = path.join(h.dir, '.config/systemd/user')
  fs.mkdirSync(unit, { recursive: true })
  fs.writeFileSync(path.join(unit, 'dev.claude-bridge.agent.service'), '')
  const r = h.run('start')
  if (process.platform !== 'linux') return
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /서비스가 에이전트를 띄웁니다/)
  assert.equal(fs.existsSync(path.join(h.state, 'detached.log')), false)
})

test('--supervisor: none is kept in agent.json, auto takes it out, anything else is refused', async () => {
  const h = home(await freePort())
  const bad = h.run('--supervisor', 'yes', 'doctor')
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /none 또는 auto/)
  const src = fs.readFileSync(AGENT, 'utf8')
  assert.match(src, /if \(supervisorArg === 'none'\) config\.supervisor = 'none'/)
  assert.match(src, /config\.supervisor === 'none' && fs\.existsSync\(SERVICE_FILE\)/, '서비스가 있으면 점검이 경고')
})
