// 모델 라우팅 (REQ-F-834, AC-1512): what the agent adds to claude while it is on, and that nothing is added while off.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { cleanRouting, routingAgents, routingPrompt, routingShell, sessionPrompt, ROUTING_WORKERS } from '../../agent/guard.mjs'

const ON = { on: true, subagentModel: 'sonnet', workers: { checker: { model: 'haiku', effort: 'low' } } }

test('off adds nothing: no agents, no variable, no rule', () => {
  for (const r of [undefined, null, {}, { on: false, workers: { checker: { model: 'opus' } } }, { on: 'true' }]) {
    assert.equal(cleanRouting(r), null)
    assert.equal(routingAgents(r), null)
    assert.equal(routingPrompt(r), '')
    assert.deepEqual(routingShell(r, '/x/a.json'), { prefix: '', args: '' })
  }
  assert.equal(sessionPrompt('BRIDGE', { sysPrompt: '기본' }), 'BRIDGE\n\n기본')
})

test('on: every worker with its model, effort, tools and a description that says what not to hand down', () => {
  const a = routingAgents(ON)
  assert.deepEqual(Object.keys(a), ['checker', 'Explore', 'researcher', 'ops-runner', 'doc-writer', 'reviewer'])
  assert.deepEqual(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, `${v.model}/${v.effort}`])), { checker: 'haiku/low', Explore: 'haiku/medium', researcher: 'sonnet/medium', 'ops-runner': 'sonnet/low', 'doc-writer': 'sonnet/medium', reviewer: 'opus/medium' })
  for (const v of Object.values(a)) {
    assert.match(v.description, /Do not use it for judgment calls/)
    assert.match(v.prompt, /\*\*\*/)
    assert.ok(Array.isArray(v.tools) && v.tools.length)
  }
  assert.ok(!a.checker.tools.includes('Write') && !a.checker.tools.includes('Edit'))
  assert.match(a.checker.prompt, /Never write, edit, delete, restart/)
  assert.ok(a.researcher.tools.includes('WebSearch'))
})

test('a value that is not as expected falls back to the default and never reaches the shell', () => {
  const c = cleanRouting({ on: true, subagentModel: "x'; rm -rf ~", workers: { checker: { model: '$(id)', effort: 'huge' }, Explore: { model: 'sonnet', effort: 'high' } } })
  assert.equal(c.subagentModel, 'sonnet')
  assert.deepEqual(c.workers.checker, { model: 'haiku', effort: 'low' })
  assert.deepEqual(c.workers.Explore, { model: 'sonnet', effort: 'high' })
})

test('the rule goes into the system prompt after the person\'s own prompt', () => {
  const p = sessionPrompt('BRIDGE', { sysPrompt: '기본', routing: ON })
  assert.ok(p.startsWith('BRIDGE\n\n기본\n\n[Model routing]'))
  assert.match(p, /checker \(haiku\)/)
  assert.match(p, /When unsure, opus/)
  assert.match(p, /general-purpose, give it a model/)
})

test('the shell passes the agents JSON whole and exports the subagent model (quoting safe)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt 'q"))
  try {
    const file = path.join(dir, "a b'.agents.json")
    const agents = routingAgents({ ...ON, workers: { ...ON.workers, reviewer: { model: 'opus', effort: 'high' } } })
    // A description with quotes and $() must arrive as written.
    agents.checker.description += ` it's "$(whoami)" \`x\``
    fs.writeFileSync(file, JSON.stringify(agents))
    const sh = routingShell(ON, file)
    // Stand-in for claude: prints its arguments and the variable.
    const script = `${sh.prefix}node -e 'console.log(JSON.stringify({argv: process.argv.slice(1), sub: process.env.CLAUDE_CODE_SUBAGENT_MODEL}))' --${sh.args} --model opus`
    const out = JSON.parse(execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' }))
    assert.equal(out.sub, 'sonnet')
    // node -e takes the `--` itself.
    assert.equal(out.argv[0], '--agents')
    assert.deepEqual(JSON.parse(out.argv[1]), agents)
    assert.deepEqual(out.argv.slice(2), ['--model', 'opus'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the agent starts claude with routing, keeps it with the session and takes it on every start command', () => {
  const src = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  assert.match(src, /\$\{routing\.prefix\}\$\{ttyPrefix\(s\.mux\)\}\$\{CLAUDE_BIN\}/)
  assert.match(src, /--append-system-prompt "\$\(cat \$\{shq\(promptFile\)\}\)"\$\{routing\.args\}/)
  assert.match(src, /\.\.\.\(s\.routing \? \{ routing: s\.routing \} : \{\}\)/)
  for (const cmd of ['new', 'open', 'refresh', 'fork', 'lightfork', 'adopt']) assert.match(src, new RegExp(`async ${cmd}\\(\\{[^)]*\\brouting\\b`), cmd)
  assert.equal(ROUTING_WORKERS.length, 6)
})
