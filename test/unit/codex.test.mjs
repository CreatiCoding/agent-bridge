// Session runners (REQ-F-851): the runner registry, and the codex runner's pure parts — its command line, its
// rollout turned into Claude Code's transcript lines, and its screen read for turns, approvals and the input box.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CAPS, CLAUDE, can, isClaude, pickRunner, runnerBrief, runnerIdOf } from '../../agent/runners.mjs'
import { CODEX, codexArgs, parseCodexMode, codexModeStr, codexBoxHas, codexHome, codexIdle, convertLine, codexUsage, codexAutoAnswer, codexAutoRisk, codexEditFiles, codexMcpArgs, codexApprovalSig, parseMcpApproval, codexQuestion, codexOptionKind, MCP_APPROVAL_UNKNOWN, findNewRollout, findRollout, hiddenUserText, parseApproval, APPROVAL_UNKNOWN, rolloutId, syncMirror, toolUse, trustDialog, turnOpenAt, slashEchoes, slashOutput, codexPager, codexPicker, listRollouts, rolloutInfo } from '../../agent/codex.mjs'

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
  for (const cap of ['fork', 'model', 'mode', 'move', 'compact', 'trim', 'bridgeTools', 'btw', 'skills']) assert.equal(can({ runner: 'codex' }, cap, runners), false, cap)
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
  assert.deepEqual(runnerBrief(CODEX, '0.166.0'), { id: 'codex', name: 'Codex', version: '0.166.0', caps: ['cards', 'autoAllow'] })
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

test('codex sandbox and approval: only the modes asked for, never full access or the bypass (1.414, AC-1597)', () => {
  assert.deepEqual(parseCodexMode(''), { sandbox: '', approval: '', network: false })
  assert.deepEqual(parseCodexMode('workspace-write:on-request:net'), { sandbox: 'workspace-write', approval: 'on-request', network: true })
  assert.deepEqual(parseCodexMode(':never'), { sandbox: '', approval: 'never', network: false })
  for (const bad of ['danger-full-access:never', 'read-only::net', ':untrusted', 'x', 'read-only', 'workspace-write:never:net:x', 1]) assert.equal(parseCodexMode(bad), null, String(bad))
  assert.equal(codexModeStr(parseCodexMode(':')), '', '둘 다 기본이면 빈 값')
  const a = codexArgs({ resume: ID, mode: 'workspace-write:never:net' })
  assert.deepEqual(a.slice(0, 2), ['resume', ID])
  const flat = a.join(' ')
  assert.ok(flat.includes('-s workspace-write -a never -c sandbox_workspace_write.network_access=true'), flat)
  assert.deepEqual(codexArgs({ mode: 'read-only:' }).slice(-2), ['-s', 'read-only'])
  assert.ok(!codexArgs({}).includes('-s') && !codexArgs({}).includes('-a'), '고르지 않으면 codex 기본값')
  assert.throws(() => codexArgs({ mode: 'danger-full-access:never' }), /모드/)
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

// Codex 0.166's MCP elicitation form (tui mcp_server_elicitation snapshots) for an mcp_tool_call_approval.
const MCP_APPROVAL = `› 캘린더에 일정 넣어 줘

• Calling calendar.create_event

  Field 1/1
  Allow the calendar MCP server to run tool "create_event"?

  Calendar: primary
  Title: Roadmap review

  › 1. Allow                   Run the tool and continue
    2. Allow for this session  Run the tool and remember this choice for this session
    3. Always allow            Run the tool and remember this choice for future tool calls
    4. Cancel                  Cancel this tool call



  enter to submit | esc to cancel
`

test("an MCP tool call's approval (mcp_tool_call_approval) is read apart from the command approval (REQ-F-859)", () => {
  assert.equal(parseApproval(MCP_APPROVAL), null)
  const a = parseMcpApproval(MCP_APPROVAL)
  assert.equal(a.kind, 'mcp')
  assert.equal(a.question, 'Allow the calendar MCP server to run tool "create_event"?')
  assert.equal(a.context, 'Calendar: primary\nTitle: Roadmap review')
  assert.deepEqual(a.options.map((o) => [o.n, o.label, o.key, o.selected]), [[1, 'Allow', '1', true], [2, 'Allow for this session', '2', false], [3, 'Always allow', '3', false], [4, 'Cancel', '4', false]])
  assert.equal(a.options[0].description, 'Run the tool and continue')
  assert.deepEqual(a.options.map((o) => codexOptionKind(o.label)), ['allow-once', 'allow-session', 'allow-always', 'deny'])
  assert.deepEqual(codexQuestion(MCP_APPROVAL), a)
  assert.deepEqual(codexQuestion(APPROVAL), parseApproval(APPROVAL))
  // Waiting for it is not idle, nor a picker.
  assert.equal(codexIdle(`${MCP_APPROVAL}\n›`), null)
  assert.equal(codexPicker(MCP_APPROVAL), null)
  // Without its footer or its "Field" line it is the conversation.
  assert.equal(parseMcpApproval(MCP_APPROVAL.replace('enter to submit | esc to cancel', '')), null)
  assert.equal(parseMcpApproval(MCP_APPROVAL.replace('Field 1/1', '')), null)
})

// REQ-F-859 rule 6 (AC-1633, 1.449): 전부 허용 answers an MCP tool call's approval as Claude's mcp__ call is answered.
test('전부 허용은 MCP 도구 승인을 "Allow"(한 번)로 답하고, 위험한 인자·다른 양식은 카드로 둔다', () => {
  const a = parseMcpApproval(MCP_APPROVAL)
  const pick = codexAutoAnswer(a)
  assert.equal(pick.option.key, '1')
  assert.equal(pick.option.label, 'Allow')
  assert.deepEqual(pick.tool, { name: 'mcp__calendar__create_event', input: { calendar: 'primary', title: 'Roadmap review' } })
  const safe = { autoAllow: true, allowAll: false, cwd: '/Users/example/proj', home: '/Users/example' }
  assert.equal(codexAutoRisk(a, pick, safe), null)
  assert.equal(codexAutoRisk(a, pick, { ...safe, allowAll: true }), null)
  assert.equal(codexAutoRisk(a, pick, { ...safe, autoAllow: false }), 'off')
  // A Slack message, the reported case: answered under 안전한 전부 허용.
  const slack = { ...a, question: 'Allow the slack MCP server to run tool "slack_post_message"?', context: 'Channel id: C123\nText: 배포 끝났어요' }
  assert.equal(codexAutoRisk(slack, codexAutoAnswer(slack), safe), null)
  // An argument that names a secret file: asked, as Claude's riskyCall asks it.
  const secret = { ...a, question: 'Allow the files MCP server to run tool "read_file"?', context: 'Path: /Users/example/.ssh/id_ed25519' }
  assert.equal(codexAutoRisk(secret, codexAutoAnswer(secret), safe), '비밀 파일')
  // Never "for this session" nor "Always allow": with no plain Allow nothing is answered.
  assert.equal(codexAutoAnswer({ ...a, options: a.options.filter((o) => o.label !== 'Allow') }), null)
  // A server's own question, a field to type into, a question off screen: the card.
  const bool = parseMcpApproval(`  Field 1/1\n  Allow this request?\n\n  › 1. True\n    2. False\n\n  enter to submit | esc to cancel\n`)
  assert.equal(codexAutoAnswer(bool), null)
  assert.equal(codexAutoAnswer(parseMcpApproval(`  Field 1/1\n\n  › 1. Allow   Run\n\n  enter to submit | esc to cancel\n`)), null)
})

// 1.454: an argument codex wrapped onto the next line ("Path:" then the path under it) was read as an empty path, so
// a secret file slipped past 안전한 전부 허용. Read off the screen by the real parser, judged by the real risk check.
test('줄바꿈·여러 줄·잘린 MCP 인자는 비밀 파일 검사를 피하지 못하고, 확실히 못 읽으면 묻는다 (1.454)', () => {
  const safe = { autoAllow: true, allowAll: false, cwd: '/Users/example/proj', home: '/Users/example' }
  const screen = (args) => MCP_APPROVAL.replace('create_event"?', 'read_file"?').replace('calendar MCP', 'files MCP').replace('  Calendar: primary\n  Title: Roadmap review', args)
  const judge = (args) => {
    const a = parseMcpApproval(screen(args))
    const pick = codexAutoAnswer(a)
    assert.ok(pick, args)
    return codexAutoRisk(a, pick, safe)
  }
  // The reported case: the path on the line under its key.
  assert.equal(judge('  Path:\n    /Users/example/.ssh/id_ed25519'), '비밀 파일')
  // A path cut in two by the terminal, a secret under a key other than "path", one among several lines.
  assert.notEqual(judge('  Path: /Users/example/\n    .ssh/id_ed25519'), null)
  assert.equal(judge('  Source: /Users/example/.ssh/id_ed25519'), '비밀 파일')
  assert.equal(judge('  Files: README.md\n    /Users/example/proj/.env'), '비밀 파일')
  assert.equal(judge('  Query: cat ~/.ssh/id_rsa'), '비밀 파일')
  // Not read for sure, though nothing risky shows: asked.
  assert.equal(judge('  Path:\n    /Users/example/proj/notes.md'), '여러 줄로 나뉜 MCP 인자')
  assert.equal(judge('  Path: /Users/example/proj/very/long/…'), '잘린 MCP 인자')
  assert.equal(judge('  Path:'), '여러 줄로 나뉜 MCP 인자')
  assert.equal(judge('  Path: a.md\n  Path: b.md'), '같은 이름이 두 번 나온 MCP 인자')
  // Plain one-line arguments still go through; the wrapped value is still joined to its key for the card.
  assert.equal(judge('  Path: /Users/example/proj/notes.md\n  Url: https://example.com/a'), null)
  assert.equal(judge(''), null)
  assert.deepEqual(codexMcpArgs('Path:\n/Users/example/.ssh/id_ed25519'), { input: { path: '/Users/example/.ssh/id_ed25519' }, unsure: '여러 줄로 나뉜 MCP 인자' })
  assert.deepEqual(codexMcpArgs('Channel id: C123\nText: 배포 끝났어요'), { input: { channel_id: 'C123', text: '배포 끝났어요' }, unsure: null })
  // 전부 허용 (not the safe one) still only stops the Mac terminal's own calls, as before.
  const a = parseMcpApproval(screen('  Path:\n    /Users/example/.ssh/id_ed25519'))
  assert.equal(codexAutoRisk(a, codexAutoAnswer(a), { ...safe, allowAll: true }), null)
})

test('an MCP form without a cancel option gets esc as its cancel, and a field to type into still waits (REQ-F-859)', () => {
  const bool = `  Field 1/1 (1 required unanswered)\n  Allow this request?\n\n  Confirm\n  Approve the pending action.\n  › 1. True\n    2. False\n\n  enter to submit | esc to cancel\n`
  const b = parseMcpApproval(bool)
  assert.equal(b.question, 'Allow this request?')
  assert.deepEqual(b.options.map((o) => [o.label, o.key, codexOptionKind(o.label)]), [['True', '1', 'allow-once'], ['False', '2', 'deny'], ['Cancel', 'Escape', 'deny']])
  const typed = `  Field 1/1 (1 required unanswered)\n  Enter a name\n\n  Name\n\n  › Type your answer\n\n  ⌃x enter to submit | esc to cancel\n`
  const t = parseMcpApproval(typed)
  assert.equal(t.question, 'Enter a name')
  assert.equal(t.context, 'Name')
  assert.deepEqual(t.options.map((o) => o.key), ['Escape'])
  const blank = parseMcpApproval(`  Field 1/1\n\n  › 1. Allow   Run\n\n  enter to submit | esc to cancel\n`)
  assert.equal(blank.question, MCP_APPROVAL_UNKNOWN)
})

test('a multi-line command (heredoc) still makes an approval card, and a question pushed off the screen too (1.417, AC-1603)', () => {
  const script = Array.from({ length: 14 }, (_, i) => `  const step${i} = await page.run(${i})`).join('\n')
  const long = `› 링크의 대화를 확인해 줘

• Explored

  Would you like to run the following command?

  Environment: local

  Reason: 샌드박스에서 브라우저 실행이 차단됐어요. 브라우저 실행을 허용할까요?

  $ ego-browser nodejs <<'EOF'
${script}
  EOF


› 1. Yes, proceed (y)
  2. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
`
  const a = parseApproval(long)
  assert.equal(a.question, 'Would you like to run the following command?')
  assert.match(a.context, /^Environment: local/)
  assert.match(a.context, /step13/)
  assert.deepEqual(a.options.map((o) => o.key), ['y', 'Escape'])
  assert.equal(codexIdle(long), null)
  // The command scrolled the question off the top: still a card, titled as a wait, with what is left on screen.
  const cut = long.split('\n').slice(10).join('\n')
  const b = parseApproval(cut)
  assert.equal(b.question, APPROVAL_UNKNOWN)
  assert.match(b.context, /EOF/)
  assert.deepEqual(b.options.map((o) => o.key), ['y', 'Escape'])
  // Same screen, same card (the answer checks the question and context again).
  assert.deepEqual(parseApproval(cut), b)
  // Nothing from before the last thing typed joins the context.
  assert.doesNotMatch(parseApproval(`› 이전 요청\n${cut}`).context, /이전 요청/)
})

test('an option wrapped over several lines keeps every option, and one cut by the top is not guessed (1.423, AC-1611)', () => {
  const head = `  Would you like to run the following command?\n\n  $ rg -n 'x' /private/tmp/a\n\n\n`
  const foot = `\n  Press enter to confirm or esc to cancel\n`
  const wrapped = `${head}› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`rg -n 'x'
     /private/tmp/a\` (p)
  3. No, and tell Codex what to do differently (esc)
${foot}`
  const a = parseApproval(wrapped)
  assert.deepEqual(a.options.map((o) => [o.n, o.key, o.selected]), [[1, 'y', true], [2, 'p', false], [3, 'Escape', false]])
  assert.equal(a.options[1].label, "Yes, and don't ask again for commands that start with `rg -n 'x' /private/tmp/a`")
  assert.equal(a.question, 'Would you like to run the following command?')
  assert.doesNotMatch(a.context, /Yes, proceed/)
  // 전부 허용 still picks the one-time yes, never the wrapped "don't ask again".
  assert.equal(codexAutoAnswer(a).option.key, 'y')
  // Only the key on the next line.
  const keyAlone = `${head}› 1. Yes, proceed (y)\n  2. Yes, and don't ask again for commands that start with \`rg\`\n     (p)\n  3. No (esc)\n${foot}`
  assert.deepEqual(parseApproval(keyAlone).options.map((o) => o.key), ['y', 'p', 'Escape'])
  // More than 12 lines of options.
  const tall = Array.from({ length: 14 }, (_, i) => `     /private/tmp/part${i}`).join('\n')
  const big = `${head}› 1. Yes, proceed (y)\n  2. Yes, and don't ask again for commands that start with \`rg\n${tall}\` (p)\n  3. No (esc)\n${foot}`
  assert.deepEqual(parseApproval(big).options.map((o) => o.key), ['y', 'p', 'Escape'])
  // The screen's top cut option 1 in the middle: what is left of it is not made into an option.
  const cut = `     proceed (y)\n  2. Yes, and don't ask again for commands that start with \`rg\`\n     (p)\n  3. No (esc)\n${foot}`
  assert.deepEqual(parseApproval(cut).options.map((o) => [o.n, o.key]), [[2, 'p'], [3, 'Escape']])
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

// REQ-F-855 (AC-1602): codex's token_count lines give the gauges Claude Code's status line gives.
test('codex token_count → 컨텍스트·5시간·주간 게이지', () => {
  const p = {
    type: 'token_count',
    info: { total_token_usage: { total_tokens: 16569 }, last_token_usage: { total_tokens: 25840 }, model_context_window: 258400 },
    rate_limits: { primary: { used_percent: 1.0, window_minutes: 300, resets_at: 1766909198 }, secondary: { used_percent: 42.4, window_minutes: 10080, resets_at: 1767495998 }, plan_type: null },
  }
  const u = codexUsage(p)
  assert.deepEqual(u, { context: 10, window: 258400, fiveHour: 1, week: 42, cost: null, fiveHourResetsAt: 1766909198000, weekResetsAt: 1767495998000 })
  // rate_limits null (an older codex, or a call without them): the limits seen before are kept.
  const v = codexUsage({ type: 'token_count', info: { last_token_usage: { total_tokens: 129200 }, model_context_window: 258400 }, rate_limits: null }, u)
  assert.equal(v.context, 50)
  assert.equal(v.week, 42)
  const st = {}
  convertLine({ type: 'event_msg', payload: p }, { sid: 's', off: 0, st })
  assert.equal(st.usage.fiveHour, 1)
})

// REQ-F-856 (AC-1604): 전부 허용 answers codex's approval with "yes, once", and the risk check reads its command.
test('codex 승인 창에 전부 허용이 고르는 답과 위험 판정에 넘기는 명령', () => {
  assert.ok(can({ runner: 'codex' }, 'autoAllow', { codex: CODEX }))
  const a = parseApproval(APPROVAL)
  const r = codexAutoAnswer(a)
  assert.equal(r.option.key, 'y')
  assert.deepEqual(r.tool, { name: 'Bash', input: { command: 'echo hello-from-fake > out.txt' } })
  // Only a "don't ask again" yes, or no yes at all: nothing is answered.
  assert.equal(codexAutoAnswer({ question: 'Allow?', context: '', options: [{ n: 1, label: "Yes, and don't ask again", key: 'a' }, { n: 2, label: 'No', key: 'Escape' }] }), null)
  // No "$ " line (edits): the whole question goes to the risk check, and every file it names as an Edit.
  const e = codexAutoAnswer({ question: 'Would you like to make the following edits?', context: '.env', options: [{ n: 1, label: 'Yes, proceed', key: 'y' }] })
  assert.match(e.tool.input.command, /\.env/)
  assert.ok(e.tools.some((t) => t.name === 'Edit' && t.input.file_path === '.env'))
  assert.equal(codexAutoAnswer(null), null)
})

// REQ-F-856 rule 6 (AC-1605): 전부 허용 sends its key only while the very same window is still on screen.
test('codex 승인 창의 sig 는 같은 창일 때만 같다', () => {
  const a = parseApproval(APPROVAL)
  assert.equal(codexApprovalSig(parseApproval(APPROVAL)), codexApprovalSig(a))
  assert.notEqual(codexApprovalSig({ ...a, context: a.context.replace('hello-from-fake', 'rm -rf ~') }), codexApprovalSig(a))
  assert.notEqual(codexApprovalSig({ ...a, options: a.options.slice(1) }), codexApprovalSig(a))
  assert.equal(codexApprovalSig(null), null)
})

// REQ-F-856 rule 7 (AC-1606, 1.420): an edit is judged as edits of the files it names, and what is not known asks.
test('codex 수정 승인은 대상 파일로 판정하고, 모르면 묻는다', () => {
  const opts = [{ n: 1, label: 'Yes, proceed', key: 'y' }, { n: 2, label: 'No', key: 'Escape' }]
  const safe = { autoAllow: true, allowAll: false, cwd: '/Users/example/proj', home: '/Users/example' }
  const rc = { question: 'Would you like to make the following edits?', context: '/Users/example/.zshrc (+1 -0)\n1 +echo startup-hook', options: opts }
  const pick = codexAutoAnswer(rc)
  assert.ok(pick.tools.some((t) => t.name === 'Edit' && t.input.file_path === '/Users/example/.zshrc'))
  assert.equal(codexAutoRisk(rc, pick, safe), '셸 시작 파일 바꾸기')
  // Relative, with tree marks around it.
  assert.deepEqual(codexEditFiles('└ .zshrc (+1 -0)'), ['.zshrc'])
  // A file of the session: answered.
  const ok = { ...rc, context: 'src/app.ts (+2 -1)\n3 +const x = 1' }
  assert.equal(codexAutoRisk(ok, codexAutoAnswer(ok), safe), null)
  // No file to be seen: not answered under 안전한 전부 허용.
  const blind = { ...rc, context: '1 +echo startup-hook' }
  assert.equal(codexAutoRisk(blind, codexAutoAnswer(blind), safe), '대상 파일을 알 수 없는 수정')
  // Neither a command nor an edit: asked.
  const other = { question: 'Allow Codex to do something?', context: 'something', options: opts }
  assert.equal(codexAutoRisk(other, codexAutoAnswer(other), safe), '종류를 알 수 없는 승인')
})

// REQ-F-856 rule 6 (AC-1606, 1.420): the mode is judged again right before the key, as it is then.
test('codex 전부 허용은 키 직전의 모드로 다시 판정한다', () => {
  const opts = [{ n: 1, label: 'Yes, proceed', key: 'y' }]
  const rc = { question: 'Would you like to make the following edits?', context: '~/.zshrc (+1 -0)', options: opts }
  const pick = codexAutoAnswer(rc)
  // 전부 허용 answers it; switched to 안전한 전부 허용 it asks; turned off nothing is sent.
  assert.equal(codexAutoRisk(rc, pick, { autoAllow: true, allowAll: true }), null)
  assert.equal(codexAutoRisk(rc, pick, { autoAllow: true, allowAll: false }), '셸 시작 파일 바꾸기')
  assert.equal(codexAutoRisk(rc, pick, { autoAllow: false, allowAll: false }), 'off')
  const cmd = codexAutoAnswer(parseApproval(APPROVAL))
  assert.equal(codexAutoRisk(parseApproval(APPROVAL), cmd, { autoAllow: false, allowAll: true }), 'off')
  // autoAllowCodex asks codexAutoRisk again after it reads the screen and before it sends the key.
  const src = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('async function autoAllowCodex('), src.indexOf('/** A card\'s answer on a codex terminal'))
  const cap = body.indexOf('term.capture(')
  const again = body.indexOf('judge()', cap)
  assert.ok(cap > 0 && again > cap && again < body.indexOf('term.sendKeys('))
})
