// The rules that read a Claude Code terminal. Screens are written out as they are drawn, so a change in what
// Claude Code draws shows up here as a failing example rather than as a session that sits unanswered.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDialog, parseKeyedDialog, classifyOption, isProceedDialog, promptHoldsFocus, detectKnown, cursorKeys, DialogDriver } from '../../agent/dialog.mjs'
import { writingPreview, visualWidth } from '../../agent/preview.mjs'
import { mainColumn, splitColumn } from '../../agent/split.mjs'
import { stuckState, inputBoxHas, detectPermissionMode, detectEffort, detectContext, normalizeMessage, transcriptHasPrompt, WORKING_RE, mdMaxOf } from '../../agent/screen.mjs'

const RULE = '─'.repeat(60)
const PROCEED = `
 Bash command

   touch made-by-bridge.txt
   Create a file

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for touch commands in /tmp/work
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No, and tell Claude what to do differently (esc)
`

test('a tool confirmation is read with its question, context and options', () => {
  const d = parseDialog(PROCEED)
  assert.equal(d.question, 'Do you want to proceed?')
  assert.deepEqual(d.options.map((o) => o.n), [1, 2, 3, 4])
  assert.equal(d.selected, 0)
  assert.match(d.context, /touch made-by-bridge\.txt/)
  assert.equal(isProceedDialog(d), true)
})

test('options are classified by what answering them means', () => {
  assert.equal(classifyOption('Yes'), 'allow-once')
  assert.equal(classifyOption("Yes, and don't ask again for touch commands in /tmp/work"), 'allow-always')
  // Claude Code prints a curly apostrophe.
  assert.equal(classifyOption('Yes, and don’t ask again for: python3 /tmp/x.py'), 'allow-always')
  assert.equal(classifyOption('Yes, allow reading from src/ from this project'), 'allow-always')
  assert.equal(classifyOption('Yes, allow all actions on example.com for this session'), 'allow-session')
  assert.equal(classifyOption('No, and tell Claude what to do differently (esc)'), 'deny')
  // Not an allow of this action: these change the mode for everything that follows.
  assert.equal(classifyOption('Yes, allow all edits during this session (shift+tab)'), 'other')
  assert.equal(classifyOption('Yes, and switch to auto mode · auto mode handles these prompts for you'), 'other')
  assert.equal(classifyOption('Type something.'), 'other')
})

test('a question is a numbered dialog but not a confirmation', () => {
  const d = parseDialog(`
 ☐ Color

 Which color?

 ❯ 1. Red
      Choose red
   2. Blue
      Choose blue
   3. Type something.

 Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`)
  assert.equal(d.question, 'Which color?')
  assert.equal(d.options[0].description, 'Choose red')
  assert.equal(isProceedDialog(d), false)
})

test('a numbered list the person sent, drawn back in the conversation, is not a dialog', () => {
  // Right after it was sent: the end-of-turn line above it, the working line under it.
  const sent = `
⏺ 끝났습니다.

✻ Churned for 13m 28s · done 5:27 PM

❯ 1. 우측 알림 아이콘이 깨지잖아.
  2. 그리고 화면에서 보여주는 정보 중에서 겹치는 정보들은 좀 스킵해서 눈이 안아프게 할 수는 없어?

✢ Thinking… (esc to interrupt)

${RULE}
❯
${RULE}
`
  assert.equal(parseDialog(sent), null)
  // Later: the answer goes on under it.
  assert.equal(parseDialog(`
❯ 1. 우측 알림 아이콘이 깨지잖아.
  2. 겹치는 정보는 스킵해 줘

⏺ 둘 다 고칠게요.
`), null)
  // Under the previous answer, with nothing between.
  assert.equal(parseDialog(`
⏺ 어떻게 할까요?

❯ 1. 이렇게
  2. 저렇게
`), null)
  // A real one under the conversation is still read: its question is right above its options.
  assert.equal(parseDialog(`
⏺ Bash(touch x)

${PROCEED}`).question, 'Do you want to proceed?')
  // A list sent earlier is still on screen above a live dialog: the dialog at the bottom is the one read.
  const both = parseDialog(`
✻ Sautéed for 2s · done 5:32 PM

❯ 1. 첫째 항목을 기억해.
  2. 둘째 항목도 기억해.

⏺ LISTED

⏺ Bash(touch echo-check.txt)
${PROCEED}`)
  assert.equal(both.question, 'Do you want to proceed?')
  assert.equal(both.options[0].label, 'Yes')
  assert.equal(both.selected, 0)
})

test('one numbered line, or the prompt itself, is not a dialog', () => {
  assert.equal(parseDialog('❯ 1. only one'), null)
  assert.equal(parseDialog(`${RULE}\n❯ 1. first thing to do\n${RULE}`), null)
})

test('a split screen is read from its left part: the panel on the right does not join the dialog', () => {
  const left = [
    '⏺ 테스트를 돌립니다.',
    '',
    '  Running 1 shell command…',
    '─'.repeat(60),
    ' Bash command',
    ' node --test test/unit/slack.test.mjs',
    ' This command requires approval',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and don’t ask again for: node --test',
    '   3. Yes, and switch to auto mode · auto mode handles these prompts for you',
    '   4. No',
    '',
    ' Esc to cancel · Tab to amend',
  ]
  const right = (i) => `${1410 + i} +    // when it is connected, else the folder set for that Mac`
  const pad = (l) => l + ' '.repeat(Math.max(0, 80 - visualWidth(l)))
  const screen = left.map((l, i) => `${pad(l)}│${right(i)}`).join('\n')
  assert.equal(splitColumn(screen), 80)
  const d = parseDialog(mainColumn(screen))
  assert.equal(d.question, 'Do you want to proceed?')
  assert.deepEqual(d.options.map((o) => classifyOption(o.label)), ['allow-once', 'allow-always', 'other', 'deny'])
  // Colour codes survive the cut and are closed.
  assert.equal(mainColumn(`\x1b[1m${screen}`).split('\n')[0], '\x1b[1m⏺ 테스트를 돌립니다.\x1b[0m')
  // Not split: a box's right edge, and a table in a reply above the prompt, are left alone.
  const box = left.map((l) => `│ ${pad(l)}│`).join('\n')
  assert.equal(mainColumn(box), box)
  const table = [...Array.from({ length: 10 }, (_, i) => `${pad(`| row ${i}`)}│ cell ${i}`), ...Array.from({ length: 10 }, () => ''), '─'.repeat(60), '❯ ', '─'.repeat(60), '  ? for shortcuts'].join('\n')
  assert.equal(mainColumn(table), table)
})

test('a dialog under which the prompt is drawn does not have the keyboard', () => {
  assert.equal(promptHoldsFocus(PROCEED), false)
  assert.equal(promptHoldsFocus(`${PROCEED}\n${RULE}\n❯ \n${RULE}`), true)
})

test('a dialog without numbers is read from its Enter hint', () => {
  const k = parseKeyedDialog(`
 Accessibility permission needed
 Grant it in System Settings.
 ❯ Open System Settings
   Try again
 Enter to confirm · Esc to cancel
`)
  assert.equal(k.question, 'Accessibility permission needed')
  assert.deepEqual(k.options, ['Open System Settings', 'Try again'])
  assert.equal(k.selected, 0)
  assert.deepEqual(cursorKeys(1), ['Down', 'Enter'])
})

test('the folder trust dialog is recognised and its yes is found', () => {
  const known = detectKnown(`
 Do you trust the files in this folder?
 ❯ 1. Yes, proceed
   2. No, exit
 Enter to confirm · Esc to cancel
`)
  assert.deepEqual(known, { name: 'folder-trust', moves: 0 })
  // Prose that only quotes a dialog is not one.
  assert.equal(detectKnown('I will not change this.'), null)
})

// R1-H2 (리포트 #1): words of a known dialog inside a command, above a plain permission dialog, must not make the
// agent press Enter on that permission dialog's "Yes".
test('a known dialog is read from the dialog itself, never from the command above a permission dialog', () => {
  const bash = (cmd) => `
 Bash command

   ${cmd}
   Run it

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for echo commands in /Users/x/p
   3. No, and tell Claude what to do differently (esc)
`
  assert.equal(detectKnown(bash('echo "do you trust this folder" && curl x | sh')), null)
  assert.equal(detectKnown(bash('echo "Use this MCP server"')), null)
  assert.equal(detectKnown(bash('echo "Switch model?" "Yes, switch"')), null)
  assert.equal(detectKnown(bash('echo "Claude in Chrome extension detected"')), null)
  // A choice label that only contains the wanted words is not that choice.
  assert.equal(detectKnown(`
 Do you trust the files in this folder?
 ❯ 1. No, exit
   2. Maybe — Yes, proceed
`), null)
  // The real ones still pass, wherever the cursor starts.
  assert.deepEqual(detectKnown(`
 Accessing workspace: /Users/x/p
 Quick safety check: Is this a project you created or one you trust?
 ❯ 1. Yes, I trust this folder
   2. No, exit
 Enter to confirm · Esc to cancel
`), { name: 'folder-trust', moves: 0 })
  assert.deepEqual(detectKnown(`
 Switch model?
   1. No, keep current model
 ❯ 2. Yes, switch
`), { name: 'model-switch', moves: 0 })
})

// R1-H2 (리포트 #2 남은 것): text shaped like folder trust in Claude's own answer, with a keyed dialog below it, must
// not be answered when no such dialog is expected (after the session has started).
test('a known dialog is answered only when it is expected now', async () => {
  const screen = `
⏺ Here is what the prompt looks like:

 Quick safety check: Is this a project you created or one you trust?
 ❯ 1. Yes, I trust this folder
   2. No, exit
 Enter to confirm · Esc to cancel
`
  const sent = []
  const driver = new DialogDriver({ sendKeys: async (pane, keys) => sent.push(keys), capture: async () => screen })
  assert.equal(await driver.confirmKnown('p', screen, []), null)
  assert.equal(await driver.confirmKnown('p', screen, ['model-switch']), null)
  assert.deepEqual(sent, [])
  // While the session starts (allow null) it is answered as before.
  assert.equal(await driver.confirmKnown('p', screen, null), 'folder-trust')
  assert.deepEqual(sent, [['Enter']])
})

// R1-M1 (리포트 #1): a project's MCP server is the person's call, shown as a card, not accepted by the agent.
test('a project MCP server consent is not answered by the agent', () => {
  assert.equal(detectKnown(`
 New MCP server found in .mcp.json: evil

 ❯ 1. Use this and all future MCP servers in this project
   2. Use this MCP server
   3. Continue without using this MCP server
 Enter to confirm · Esc to cancel
`), null)
})

test('interrupted is a state only while it is the last thing said', () => {
  const box = `${RULE}\n❯ \n${RULE}\n  ⏸ manual mode on`
  assert.equal(stuckState(`⏺ 1. The ocean\n  ⎿  Interrupted · What should Claude do instead?\n${box}`), 'interrupted')
  assert.equal(stuckState(`  ⎿  Interrupted · What should Claude do instead?\n❯ next\n⏺ working on it\n✻ Thinking… (3s · esc to interrupt)\n${box}`), null)
  assert.equal(stuckState(`⏺ done\n${box}`), 'idle')
  // A status line under the input box can say anything; it is not something said after the interruption.
  assert.equal(stuckState(`  ⎿  Interrupted · What should Claude do instead?\n${RULE}\n❯ \n${RULE}\n  Fable 5.1 · $0 · ctx 4%\n  ⏸ manual mode on`), 'interrupted')
  assert.ok(WORKING_RE.test('✽ Flibbertigibbeting… (13m 20s · ↓ 14.5k tokens)'))
})

test('typed text is in the input box only between the last two rules', () => {
  assert.equal(inputBoxHas(`❯ hello there\n⏺ hi\n${RULE}\n❯ \n${RULE}`, 'hello there'), false)
  assert.equal(inputBoxHas(`⏺ hi\n${RULE}\n❯ hello there\n${RULE}`, 'hello there'), true)
})

test('mode, effort and context are read off the status lines', () => {
  assert.equal(detectPermissionMode('  ⏵⏵ auto mode on (shift+tab to cycle)'), 'auto')
  assert.equal(detectPermissionMode('  ⏸ manual mode on · ? for shortcuts'), 'default')
  // The same words in the conversation above the input box are not the mode.
  const talk = ['⏺ Read agent/screen.mjs', "  if (/accept edits on/i.test(screen)) return 'acceptEdits'", "  if (/auto mode on/i.test(screen)) return 'auto'", RULE, '❯ ', RULE, '  ⏸ manual mode on · ? for shortcuts'].join('\n')
  assert.equal(detectPermissionMode(talk), 'default')
  assert.equal(detectPermissionMode(['⏺ the status line says "plan mode on"', RULE, '❯ ', RULE, '  ⏵⏵ accept edits on (shift+tab to cycle)'].join('\n')), 'acceptEdits')
  assert.equal(detectEffort('Fable 5.1 with high effort · Claude Max'), 'high')
  assert.equal(detectContext('Context left until auto-compact: 12%'), '88%')
  assert.equal(normalizeMessage('look  at\n[Image #1] this'), 'look at this')
})

test('the answer being written is read back as markdown, without the frame around it', () => {
  const screen = ['❯ list facts', '', '⏺ 1. The \x1b[1mocean\x1b[22m covers 71 percent.', '  2. It holds `water`.', '', `${' '.repeat(40)}\x1b[38;5;246m● high · /effort\x1b[39m`, RULE, '❯ ', RULE, '  ⏵⏵ auto mode on · esc to interrupt'].join('\n')
  assert.equal(writingPreview(screen), '1. The **ocean** covers 71 percent.\n2. It holds `water`.')
  // A running tool is not text being written.
  assert.equal(writingPreview(['⏺ Bash(sleep 5)', '  ⎿  Running…', RULE, '❯ ', RULE].join('\n')), '')
  // A folded group of tool calls under the text is a tool too, also in the half of the blink where its ⏺ is a space.
  const said = ['⏺ 기존 채널에 봇을 초대할게요', '']
  for (const head of ['\x1b[38;5;246m⏺\x1b[39m', '\x1b[38;5;246m \x1b[39m']) {
    assert.equal(writingPreview([...said, `${head} Calling claude-in-chrome \x1b[1m3\x1b[0m times, running \x1b[1m2\x1b[0m shell commands…`, '', RULE, '❯ ', RULE].join('\n')), '')
    assert.equal(writingPreview([...said, `${head} Bash(sleep 5)`, '  ⎿  Running…', RULE, '❯ ', RULE].join('\n')), '')
  }
  assert.equal(writingPreview([...said, '⏺ Read 2 files (ctrl+o to expand)', '', RULE, '❯ ', RULE].join('\n')), '')
  assert.equal(writingPreview([...said, '  \x1b[38;5;246mCalled claude-in-chrome \x1b[1m9\x1b[0m\x1b[38;5;246m times \x1b[39m', '', RULE, '❯ ', RULE].join('\n')), '')
  // Text that only starts with such a word is still text.
  assert.equal(writingPreview(['⏺ Reading the logs, the cause is the blink.', '', RULE, '❯ ', RULE].join('\n')), 'Reading the logs, the cause is the blink.')
})

test('SESSION.md limit: a tenth of the context window, 20 KB to 100 KB', () => {
  assert.equal(mdMaxOf({ usage: { window: 200_000 } }), 20_000)
  assert.equal(mdMaxOf({ usage: { window: 1_000_000 } }), 100_000)
  assert.equal(mdMaxOf({ usage: { window: 500_000 } }), 50_000)
  assert.equal(mdMaxOf({ usage: { window: 100_000 } }), 20_000)
  assert.equal(mdMaxOf({ usage: { window: 2_000_000 } }), 100_000)
  // Window not known yet: from the model name, else the small one.
  assert.equal(mdMaxOf({ model: 'claude-opus-5-5[1m]' }), 100_000)
  assert.equal(mdMaxOf({ model: 'claude-haiku-4-5-20251001' }), 20_000)
  assert.equal(mdMaxOf({}), 20_000)
})

test('a message already in the transcript is not sent again (1.181)', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-tx-')), 't.jsonl')
  const at = Date.parse('2026-10-15T01:00:23Z')
  const row = (o) => JSON.stringify(o)
  fs.writeFileSync(file, [
    row({ type: 'user', timestamp: '2026-10-15T01:00:10Z', message: { role: 'user', content: 'old words' } }),
    row({ type: 'user', isSidechain: true, timestamp: '2026-10-15T01:00:24Z', message: { role: 'user', content: 'side words' } }),
    row({ type: 'assistant', timestamp: '2026-10-15T01:00:24Z', message: { role: 'assistant', content: [{ type: 'text', text: 'reply words' }] } }),
    row({ type: 'user', timestamp: '2026-10-15T01:00:23.5Z', message: { role: 'user', content: [{ type: 'text', text: '생각보다 잘 되는 것 같다' }] } }),
    '{broken',
  ].join('\n'))
  assert.equal(transcriptHasPrompt(file, '생각보다 잘 되는 것 같다', at), true)
  assert.equal(transcriptHasPrompt(file, 'old words', at), false)
  assert.equal(transcriptHasPrompt(file, 'side words', at), false)
  assert.equal(transcriptHasPrompt(file, 'reply words', at), false)
  assert.equal(transcriptHasPrompt(file, '', at), false)
  assert.equal(transcriptHasPrompt(file + '.none', 'old words', 0), false)
  assert.equal(transcriptHasPrompt(file, 'old words', 0), true)
})

// "11/compact …": in 전부 허용 a hook's allow closed the dialog while a card's answer was being pressed, the digit
// landed in the input box, and the closed dialog read as "answered", so the digit stayed and went out with the next
// message. The digit is taken back, and the answer is "gone".
test('a digit pressed after the dialog closed by itself is taken back, not counted as an answer', async () => {
  let screen = PROCEED
  const sent = []
  const driver = new DialogDriver({
    sendKeys: async (pane, keys) => {
      sent.push(keys)
      // The hook already allowed: the dialog is gone and the digit is typed into the prompt.
      if (keys[0] === '1') screen = `⏺ Bash(touch made-by-bridge.txt)\n${RULE}\n❯ 1\n${RULE}\n  ⏸ manual mode on`
      if (keys[0] === 'BSpace') screen = `⏺ Bash(touch made-by-bridge.txt)\n${RULE}\n❯ \n${RULE}\n  ⏸ manual mode on`
    },
    capture: async () => screen,
  })
  assert.equal(await driver.answerNumber('p', '1'), 'gone')
  assert.deepEqual(sent, [['1'], ['BSpace']])
})

test('the fullscreen offer under a sent message is read as its own dialog and declined (2026-10-25)', () => {
  // As a delegated session on Linux drew it: the banner, the message it was sent (with a numbered list), then the
  // offer. Its bullet list sits right above its options, and its `·` is not a working line.
  const screen = `
 ▐▛███▜▌   Claude Code v2.1.310
▝▜█████▛▘  Opus 5.5 with medium effort · Claude Max

❯ 이 서버의 디스크 사용 현황을 조사해서 보고해 주세요.
  확인할 것:
  1. df -h
  2. docker system df

${RULE}
  Try the new fullscreen renderer?

  · Flicker-free output — fixes the flashing you see during long responses
  · Mouse support — click to move your cursor or expand results
  · Selected text auto-copies to your clipboard

  ❯ 1. Yes, try it
    2. Not now

  Enter to confirm · Esc to cancel
`
  const d = parseDialog(screen)
  assert.deepEqual(d.options.map((o) => o.label), ['Yes, try it', 'Not now'])
  assert.match(d.context, /Try the new fullscreen renderer\?/)
  // Not the message: the cursor nearest the key hints is the dialog's.
  assert.deepEqual(parseKeyedDialog(screen).options, ['1. Yes, try it', '2. Not now'])
  assert.deepEqual(detectKnown(screen), { name: 'fullscreen-upsell', moves: 1 })
  // A working line with `·` still ends a sent list: `· Pondering…` above `❯ 1.` is the conversation.
  assert.equal(parseDialog(`
· Pondering… (esc to interrupt)

❯ 1. 이렇게
  2. 저렇게
`), null)
})
