// REQ-F-862: codex's exec program and answer drawn as what they do.
import test from 'node:test'
import assert from 'node:assert/strict'
import { codexExecFace, codexExecOutput, execCalls, execMeta, jsonTokens, prettyJson, readString, shellTokens } from '../../ui/src/lib/tool-view.ts'

const inp = (code) => JSON.stringify({ input: code })

test('exec_command program → Bash with its command, workdir and reason', () => {
  const code = `text(await tools.exec_command({cmd:"rg -n 'style|css' /tmp/a/ui/src/lib/ext*.ts | head -30\\n sed -n '65,80p' /tmp/a/x.go","workdir":"/tmp/a",justification:"보기","max_output_tokens":1000}));\n`
  const f = codexExecFace('exec', inp(code))
  assert.equal(f.name, 'Bash')
  assert.equal(f.label, "rg -n 'style|css' /tmp/a/ui/src/lib/ext*.ts | head -30")
  const i = JSON.parse(f.input)
  assert.equal(i.command, "rg -n 'style|css' /tmp/a/ui/src/lib/ext*.ts | head -30\n sed -n '65,80p' /tmp/a/x.go")
  assert.equal(i.workdir, '/tmp/a')
  assert.equal(i.description, '보기')
})

test('several commands, an argv list and other tools', () => {
  const two = codexExecFace('exec', inp(`text(await tools.exec_command({cmd:"ls"}));\ntext(await tools.exec_command({cmd:["bash","-lc","git status"]}));`))
  assert.equal(two.name, 'Bash')
  assert.equal(two.label, 'ls (+1)')
  assert.equal(JSON.parse(two.input).command, 'ls\ngit status')
  const mixed = codexExecFace('exec', inp(`text(await tools.exec_command({cmd:"ls"})); text(await tools.view_image({path:"/a.png"}))`))
  assert.equal(mixed.name, 'exec')
  assert.equal(mixed.label, 'exec_command · view_image')
  assert.equal(mixed.lang, 'js')
  assert.equal(codexExecFace('Bash', inp('x')), null)
  assert.equal(codexExecFace('exec', 'not json'), null)
})

test('apply_patch program → Edit diff with its files', () => {
  const patch = '*** Begin Patch\n*** Update File: /tmp/a/x.ts\n@@\n-a\n+b\n*** Add File: /tmp/a/y.ts\n+c\n*** End Patch'
  const f = codexExecFace('exec', inp(`text(await tools.apply_patch(${JSON.stringify(patch)}))`))
  assert.equal(f.name, 'Edit')
  assert.equal(f.label, '/tmp/a/x.ts (+1)')
  assert.equal(f.detail, patch)
  assert.equal(f.lang, 'diff')
  assert.deepEqual(JSON.parse(f.input).files, ['/tmp/a/x.ts', '/tmp/a/y.ts'])
})

test('string literals: escapes, other quotes, unclosed', () => {
  const lit = '"a\\"b\\n\\u00e9\\x41"'
  assert.deepEqual(readString(lit, 0), { value: 'a"b\n\u00e9A', end: lit.length })
  assert.equal(readString(`'it\\'s'`, 0).value, "it's")
  assert.equal(readString('`x`', 0).value, 'x')
  assert.equal(readString('`${x}`', 0), null)
  assert.equal(readString('"open', 0), null)
  assert.deepEqual(execCalls('tools.exec_command({ "cmd": "pwd" })'), [{ fn: 'exec_command', cmd: 'pwd' }])
})

test('exec answer → the command output, exit code and time', () => {
  const inner = JSON.stringify({ chunk_id: 'c8e217', wall_time_seconds: 0.035864792, exit_code: 0, original_token_count: 453, output: '/tmp/a/server/ext.go:37:\tEXT\n' })
  const raw = JSON.stringify([
    { type: 'input_text', text: 'Script completed\nWall time 0.4 seconds\nOutput:\n' },
    { type: 'input_text', text: inner },
  ])
  const o = codexExecOutput(raw)
  assert.equal(o.text, '/tmp/a/server/ext.go:37:\tEXT')
  assert.equal(o.exit, 0)
  assert.ok(Math.abs(o.secs - 0.0359) < 0.001)
  assert.equal(execMeta(o), 'exit 0 · 0.04 s')
  const failed = codexExecOutput(JSON.stringify([{ type: 'input_text', text: 'Script completed\nOutput:\n' }, { type: 'input_text', text: JSON.stringify({ exit_code: 2, output: 'no' }) }]))
  assert.equal(failed.exit, 2)
  assert.equal(codexExecOutput('plain text'), null)
  assert.equal(codexExecOutput('[1,2]'), null)
})

test('highlight tokens keep the text whole', () => {
  const cmd = `cd ~/a && rg -n "x|y" src/ | head -3 # note\nFOO=1 make $T 2>&1`
  const t = shellTokens(cmd)
  assert.equal(t.map((x) => x.t).join(''), cmd)
  assert.deepEqual(t.filter((x) => x.k === 'cmd').map((x) => x.t), ['cd', 'rg', 'head', 'make'])
  assert.ok(t.some((x) => x.k === 'flag' && x.t === '-n'))
  assert.ok(t.some((x) => x.k === 'str' && x.t === '"x|y"'))
  assert.ok(t.some((x) => x.k === 'com'))
  const j = prettyJson('{"a":1,"b":[true,"s"]}')
  assert.equal(j, '{\n  "a": 1,\n  "b": [\n    true,\n    "s"\n  ]\n}')
  const jt = jsonTokens(j)
  assert.equal(jt.map((x) => x.t).join(''), j)
  assert.deepEqual(jt.filter((x) => x.k === 'key').map((x) => x.t), ['"a"', '"b"'])
  assert.equal(prettyJson('nope'), null)
})

test('toolFace: an exec row as Bash with its output; the same row gives the same object; others untouched', async () => {
  const { toolFace } = await import('../../ui/src/lib/tool-view.ts')
  const out = JSON.stringify([{ type: 'input_text', text: 'Script completed\nOutput:\n' }, { type: 'input_text', text: JSON.stringify({ exit_code: 1, wall_time_seconds: 2.5, output: 'boom\n' }) }])
  const row = { name: 'exec', label: '🔒…', input: JSON.stringify({ input: 'text(await tools.exec_command({cmd:"make"}))' }), done: true, output: out }
  const f = toolFace(row)
  assert.equal(f.name, 'Bash')
  assert.equal(f.label, 'make')
  assert.equal(f.output, 'boom')
  assert.equal(f.meta, 'exit 1 · 2.5 s')
  assert.equal(f.error, true)
  assert.equal(toolFace(row), f)
  const running = toolFace({ ...row, done: false, output: undefined })
  assert.equal(running.name, 'Bash')
  assert.equal(running.meta, undefined)
  const bash = { name: 'Bash', label: 'ls', input: '{"command":"ls"}', done: true, output: '[]' }
  assert.equal(toolFace(bash), bash)
})
