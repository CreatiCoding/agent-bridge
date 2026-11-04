// Session runners (REQ-F-851): the runner registry, and the codex runner's pure parts — its command line, its
// rollout turned into Claude Code's transcript lines, and its screen read for turns, approvals and the input box.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CAPS, CLAUDE, can, isClaude, pickRunner, runnerBrief, runnerIdOf } from '../../agent/runners.mjs'
import { CODEX, codexArgs, codexBoxHas, codexHome, codexIdle, convertLine, findNewRollout, findRollout, hiddenUserText, parseApproval, rolloutId, syncMirror, toolUse, trustDialog, turnOpenAt, slashEchoes, slashOutput, codexPager, codexPicker, listRollouts, rolloutInfo } from '../../agent/codex.mjs'

const ID = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b'

test('a session with no runner, or claude, is Claude Code and can do everything', () => {
  assert.equal(runnerIdOf({}), 'claude')
  assert.equal(runnerIdOf({ runner: 'claude' }), 'claude')
  assert.equal(runnerIdOf({ runner: 'codex' }), 'codex')
  assert.ok(isClaude({}))
  for (const cap of CAPS) assert.ok(can({}, cap, {}), cap)
  assert.deepEqual([...CLAUDE.caps], [...CAPS])
})

test('another runner can do only what it says, and nothing once its Mac no longer has it', () => {
  const runners = { codex: CODEX }
  assert.ok(can({ runner: 'codex' }, 'cards', runners))
  for (const cap of ['fork', 'model', 'move', 'compact', 'trim', 'autoAllow', 'bridgeTools', 'btw', 'skills']) assert.equal(can({ runner: 'codex' }, cap, runners), false, cap)
  assert.equal(can({ runner: 'codex' }, 'cards', {}), false)
  for (const cap of CODEX.caps) assert.ok(CAPS.includes(cap), cap)
})

test('a new session names a runner this Mac has, or gets Claude Code', () => {
  assert.equal(pickRunner(undefined, ['claude']), 'claude')
  assert.equal(pickRunner('', ['claude']), 'claude')
  assert.equal(pickRunner('codex', ['claude', 'codex']), 'codex')
  assert.equal(pickRunner('codex', ['claude']), null)
  assert.equal(pickRunner('../x', ['claude', '../x']), null)
  assert.equal(pickRunner({}, ['claude']), null)
  assert.deepEqual(runnerBrief(CODEX, '0.166.0'), { id: 'codex', name: 'Codex', version: '0.166.0', caps: ['cards'] })
  assert.equal('version' in runnerBrief(CLAUDE), false)
})

test('codex starts with its own process, the folder trusted for this run, and nothing that turns approvals off', () => {
  const a = codexArgs({ model: 'gpt-5', cwd: '/w/a "b"', prompt: '안녕 --yolo' })
  assert.deepEqual(a.slice(0, 3), ['--no-daemon', '-c', 'check_for_update_on_startup=false'])
  assert.ok(a.includes('projects."/w/a \\"b\\"".trust_level="trusted"'))
  assert.deepEqual(a.slice(-3), ['-m', 'gpt-5', '안녕 --yolo'])
  const flat = a.join(' ')
  for (const no of ['--dangerously-bypass-approvals-and-sandbox', '--full-auto', 'approval_policy', 'sandbox_mode']) assert.ok(!flat.includes(no), no)
  assert.deepEqual(codexArgs({ resume: ID }).slice(0, 2), ['resume', ID])
  assert.throws(() => codexArgs({ resume: '../../etc' }), /올바르지/)
  assert.ok(!codexArgs({ model: 'a b; rm' }).includes('-m'))
})

test('codex home: CODEX_HOME when it is absolute, else ~/.codex; rollout ids from file names', () => {
  assert.equal(codexHome({ CODEX_HOME: '/x/c' }, '/h'), '/x/c')
  assert.equal(codexHome({ CODEX_HOME: 'rel' }, '/h'), '/h/.codex')
  assert.equal(codexHome({}, '/h'), '/h/.codex')
  assert.equal(rolloutId(`/a/rollout-2026-11-03T01-12-13-${ID}.jsonl`), ID)
  assert.equal(rolloutId('/a/rollout-x.jsonl'), null)
})

const sid = 'sess-1'
const conv = (lines) => {
  const st = {}
  return lines.map((o, i) => convertLine(o, { sid, off: i * 100, st }))
}

test('a rollout becomes Claude Code transcript lines: what was said, tools and their results, the model', () => {
  const r = conv([
    { type: 'session_meta', payload: { id: ID, cwd: '/w' } },
    { type: 'turn_context', payload: { model: 'gpt-5-codex' } },
    { type: 'event_msg', timestamp: '2026-11-03T00:00:00Z', payload: { type: 'task_started' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/w</cwd>\n</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /w\n…' }] } },
    { type: 'response_item', timestamp: '2026-11-03T00:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '고쳐 줘' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: ['ls', '-a'], justification: '보기' }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: { content: 'a\nb', success: false } } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '다 했어요' }] } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ])
  const lines = r.flatMap((x) => x.lines)
  const signals = r.flatMap((x) => x.signals)
  assert.deepEqual(signals, ['begin', 'end'])
  assert.equal(lines.length, 4)
  assert.deepEqual(lines[0].message, { role: 'user', content: '고쳐 줘' })
  assert.equal(lines[0].timestamp, '2026-11-03T00:00:01Z')
  assert.equal(lines[0].sessionId, sid)
  assert.deepEqual(lines[1].message.content[0], { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls -a', description: '보기' } })
  assert.equal(lines[1].message.model, 'gpt-5-codex')
  assert.deepEqual(lines[2].message.content[0], { type: 'tool_result', tool_use_id: 'c1', content: 'a\nb', is_error: true })
  assert.deepEqual(lines[3].message.content, [{ type: 'text', text: '다 했어요' }])
  // The same rollout line always gets the same id: a mirror made again numbers lines the same way.
  assert.equal(conv([{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] } }])[0].lines[0].uuid, conv([{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'y' }] } }])[0].lines[0].uuid)
})

test('codex tools as the tools the page draws: a patch is an Edit, a plan is the to-do list', () => {
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: src/b.ts\n+x\n*** End Patch'
  const e = toolUse('apply_patch', { input: patch }, 'p1')
  assert.equal(e.name, 'Edit')
  assert.equal(e.input.file_path, 'src/a.ts')
  assert.deepEqual(e.input.files, ['src/a.ts', 'src/b.ts'])
  const t = toolUse('update_plan', JSON.stringify({ plan: [{ step: '하나', status: 'completed' }, { step: '둘', status: 'weird' }] }), 'u1')
  assert.equal(t.name, 'TodoWrite')
  assert.deepEqual(t.input.todos.map((x) => x.status), ['completed', 'pending'])
  assert.equal(toolUse('mcp__x', 'not json', 'm').input.input, 'not json')
  assert.ok(hiddenUserText('<user_instructions>\nx\n</user_instructions>'))
  assert.ok(!hiddenUserText('<b>굵게</b> 해 줘 그리고 더'))
})

test('an error event is a line of its own; an aborted turn closes the turn', () => {
  const r = conv([{ type: 'event_msg', payload: { type: 'error', message: 'rate limited' } }, { type: 'event_msg', payload: { type: 'turn_aborted' } }])
  assert.equal(r[0].lines[0].message.model, '<synthetic>')
  assert.match(r[0].lines[0].message.content[0].text, /rate limited/)
  assert.deepEqual(r[1].signals, ['aborted'])
  assert.equal(turnOpenAt(['begin', 'end', 'begin']), true)
  assert.equal(turnOpenAt(['begin', 'aborted']), false)
  assert.equal(turnOpenAt([]), false)
})

test('the mirror follows the rollout by whole lines, and is made again when it is gone or the rollout shrank', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-codex-'))
  try {
    const rollout = path.join(dir, 'r.jsonl')
    const mirror = path.join(dir, 'm', 'mirror.jsonl')
    const user = (t) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] } })
    const start = JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })
    const done = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })
    fs.writeFileSync(rollout, `${start}\n${user('하나')}\n${user('반쪽')}`)
    const state = {}
    let r = syncMirror({ rollout, mirror, sid, state })
    assert.deepEqual(r, { signals: ['begin'], rebuilt: true })
    assert.equal(fs.readFileSync(mirror, 'utf8').trim().split('\n').length, 1)
    fs.appendFileSync(rollout, `\n${done}\n`)
    r = syncMirror({ rollout, mirror, sid, state })
    assert.deepEqual(r, { signals: ['end'], rebuilt: false })
    const two = fs.readFileSync(mirror, 'utf8')
    assert.equal(two.trim().split('\n').length, 2)
    assert.deepEqual(syncMirror({ rollout, mirror, sid, state }), { signals: [], rebuilt: false })
    // Made again from the start gives the same lines.
    fs.rmSync(mirror)
    r = syncMirror({ rollout, mirror, sid, state })
    assert.equal(r.rebuilt, true)
    assert.deepEqual(r.signals, [])
    assert.equal(fs.readFileSync(mirror, 'utf8'), two)
    assert.equal(syncMirror({ rollout: path.join(dir, 'none'), mirror, sid, state: {} }).missing, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the rollout of a codex just started is found by folder, time and origin; one by id anywhere', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-codex-root-'))
  try {
    const now = new Date()
    const day = path.join(root, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
    fs.mkdirSync(day, { recursive: true })
    const write = (id, meta) => fs.writeFileSync(path.join(day, `rollout-2026-11-03T01-02-03-${id}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/w', timestamp: now.toISOString(), originator: 'codex-tui', ...meta } })}\n`)
    const other = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5c'
    const forked = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5d'
    write(ID, {})
    write(other, { cwd: '/elsewhere' })
    write(forked, { forked_from_id: ID })
    const since = Date.now() - 1000
    assert.equal(findNewRollout({ root, cwd: '/w', since, taken: new Set() })?.id, ID)
    assert.equal(findNewRollout({ root, cwd: '/w', since, taken: new Set([ID]) }), null)
    assert.equal(findNewRollout({ root, cwd: '/w', since: Date.now() + 60_000, taken: new Set() }), null)
    assert.equal(path.basename(findRollout(root, other)), `rollout-2026-11-03T01-02-03-${other}.jsonl`)
    assert.equal(findRollout(root, '../x'), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

const APPROVAL = `› RUNCMD 명령 실행해 줘

• Running echo hello-from-fake > out.txt


  Would you like to run the following command?

  Environment: local

  Reason: 시험용 명령입니다

  $ echo hello-from-fake > out.txt


› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`echo hello-from-fake > out.txt\` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
`

test("codex's approval question is read with its options and the key each one takes", () => {
  const a = parseApproval(APPROVAL)
  assert.equal(a.question, 'Would you like to run the following command?')
  assert.match(a.context, /\$ echo hello-from-fake/)
  assert.deepEqual(a.options.map((o) => [o.n, o.key, o.selected]), [[1, 'y', true], [2, 'p', false], [3, 'Escape', false]])
  assert.equal(codexIdle(APPROVAL), null)
  // Without its footer it is the conversation, not a question.
  assert.equal(parseApproval(APPROVAL.replace('Press enter to confirm or esc to cancel', '')), null)
})

test('the screen: idle with an empty box, working, the folder trust question, text left in the box', () => {
  const idle = '› 안녕\n• echo: 안녕\n  Worked for <1s • 1:13 AM\n› Ask Codex to do anything\n  fake-model default · ~/w\n'
  assert.equal(codexIdle(idle), 'idle')
  assert.equal(codexIdle('› \n'), 'idle')
  const working = '› WAIT\n• Working (5s • esc to interrupt)\n› Ask Codex to do anything\n'
  assert.equal(codexIdle(working), null)
  const trust = '  Trust this folder? Codex can read, edit, and run files here.\n\n› 1. Trust and continue\n  2. Back\n'
  assert.ok(trustDialog(trust))
  assert.equal(codexIdle(`${trust}› Ask Codex to do anything\n`), null)
  assert.ok(codexBoxHas('• 답\n› 보낸 글 첫 줄\n  둘째 줄\n', '보낸 글 첫'))
  assert.ok(!codexBoxHas(idle, '보낸 글'))
  assert.ok(!codexBoxHas('› 보낸 글\n• Working (2s • esc to interrupt)\n', '보낸 글'))
})

// Screens as codex 0.166 draws them in a 220x80 tmux terminal (REQ-F-852), cut down.
const STATUS_SCREEN = `/status

  >_ OpenAI Codex (v0.166.0)

  Model:               fake-model (reasoning low, summaries auto)
  Directory:           ~/w
  Token usage:         0 total  (0 input + 0 output)

/mcp

🔌  MCP Tools

  • docs: connected (3 tools)



› Ask Codex to do anything

  fake-model default · ~/w
  ? for shortcuts
`
const PICKER = `\u203a hi\n\n• hello\n\n\n\n\n  Select Model and Effort\n\n\n\u203a 1. fake-model (current)  The one in use.\n  2. other-model            Another.\n\u2193\n  enter select \u00b7 esc back\n`
const PAGER = `/ D I F F / / / / / / / / / /\n\`/diff\` \u2014 _not inside a git repository_\n~\n~\n${'\u2500'.repeat(40)} 100% \u2500\n \u2191/\u2193 to scroll \u00b7 pgup/pgdn to page \u00b7 home/end to jump\n q close\n`

test('a slash command: what codex printed under its echo, and the pager or picker it left open', () => {
  assert.equal(slashEchoes(STATUS_SCREEN, '/status'), 1)
  assert.equal(slashEchoes(STATUS_SCREEN, '/diff'), 0)
  assert.equal(slashOutput(STATUS_SCREEN, '/mcp'), '🔌  MCP Tools\n\n  • docs: connected (3 tools)')
  assert.match(slashOutput(STATUS_SCREEN, '/status'), /^  >_ OpenAI Codex[\s\S]*Token usage:[\s\S]*• docs: connected/)
  assert.equal(slashOutput(STATUS_SCREEN.replace(/› Ask Codex.*\n/, ''), '/mcp'), null)
  assert.equal(slashOutput(STATUS_SCREEN, '/model'), null)
  assert.equal(codexPager(STATUS_SCREEN), null)
  assert.equal(codexPicker(STATUS_SCREEN), null)
  assert.deepEqual(codexPager(PAGER), { text: '`/diff` — _not inside a git repository_', more: false })
  assert.equal(codexPager(PAGER.replace('100%', '42%')).more, true)
  assert.equal(codexPicker(PAGER), null)
  assert.equal(codexPicker(PICKER).text, '  Select Model and Effort\n\n› 1. fake-model (current)  The one in use.\n  2. other-model            Another.')
  assert.equal(codexPager(PICKER), null)
  assert.equal(slashOutput(PICKER, '/model'), null)
  // An approval question is a card, never a picker to close.
  assert.equal(codexPicker(APPROVAL), null)
  // A long page is cut, so the note keeps its closing fence.
  assert.ok(slashOutput(`/x\n${'y'.repeat(5000)}\n› \n`, '/x').length <= 1602)
})

test('the Mac\'s codex conversations for 맥의 대화 가져오기: listed newest first, read for folder and words (1.413, AC-1595)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-adopt-'))
  const day = path.join(root, '2026', '11', '03')
  fs.mkdirSync(day, { recursive: true })
  const A = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a50'
  const B = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a51'
  const C = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a52'
  const meta = (id, src) => JSON.stringify({ timestamp: '2026-11-03T01:00:00Z', type: 'session_meta', payload: { id, cwd: '/Users/u/p', timestamp: '2026-11-03T01:00:00Z', originator: 'codex_vscode', thread_source: src, base_instructions: { text: 'x'.repeat(100_000) } } })
  const msg = (role, kind, text) => JSON.stringify({ timestamp: '2026-11-03T01:00:01Z', type: 'response_item', payload: { type: 'message', role, content: [{ type: kind, text }] } })
  const fa = path.join(day, `rollout-2026-11-03T01-00-00-${A}.jsonl`)
  const fb = path.join(day, `rollout-2026-11-03T02-00-00-${B}.jsonl`)
  fs.writeFileSync(fa, [meta(A, 'user'), msg('user', 'input_text', '<environment_context>x</environment_context>'), msg('user', 'input_text', '배포  고쳐 줘'), msg('assistant', 'output_text', '네'), msg('user', 'input_text', '끝 말')].join('\n') + '\n')
  fs.writeFileSync(fb, [meta(B, 'subagent'), msg('user', 'input_text', '안쪽')].join('\n') + '\n')
  fs.writeFileSync(path.join(day, `rollout-2026-11-03T03-00-00-${C}.jsonl`), '')
  fs.utimesSync(fa, new Date(2_000_000_000_000), new Date(2_000_000_000_000))
  fs.utimesSync(fb, new Date(1_000_000_000_000), new Date(1_000_000_000_000))
  const list = listRollouts(root)
  assert.deepEqual(list.map((r) => r.id), [A, B], '크기 0 은 빠지고 최신순')
  const a = rolloutInfo(fa, fs.statSync(fa).size)
  assert.deepEqual(a, { id: A, cwd: '/Users/u/p', user: true, first: '배포 고쳐 줘', last: '끝 말' })
  assert.equal(rolloutInfo(fb, fs.statSync(fb).size).user, false)
  assert.deepEqual(listRollouts(path.join(root, 'none')), [])
})
