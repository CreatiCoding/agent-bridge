// The language guard's test of a note (REQ-F-710).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mostlyEnglish, screenNote } from '../../agent/screen.mjs'

// The terminal at the moment a PreToolUse hook ran, captured on 2026-10-10 (Claude Code, Haiku 4.5).
const SCREEN = [
  '▝▜██████▀  Haiku 4.5 · Claude Max',
  '❯ Run the Bash tool now with the command: echo guard-one. In the same message, right before that tool call, write',
  '  run, reply with exactly LANG_DONE.',
  "⏺ I'm about to run a simple echo command that prints guard-one.",
  '  Echo the string guard-one to verify command execution',
  '  ⎿  $ echo guard-one',
  '✶ Honking… (running PreToolUse hook · 4s · ↓ 206 tokens · thinking)',
  '─'.repeat(60),
  '❯ ',
  '─'.repeat(60),
  '  ⏵⏵ accept edits on (shift+tab to cycle)',
].join('\n')

test('the note before a tool call is read off the screen, without the call’s own lines', () => {
  assert.equal(screenNote(SCREEN, { description: 'Echo the string guard-one to verify command execution', command: 'echo guard-one' }), "I'm about to run a simple echo command that prints guard-one.")
  // A call with nothing written before it: the block above is the person's prompt.
  const bare = SCREEN.replace(/⏺ I'm about[^\n]*\n/, '⏺ Bash(echo guard-one)\n')
  assert.equal(screenNote(bare, { description: 'Echo the string guard-one to verify command execution', command: 'echo guard-one' }), '')
  // A Korean note passes the check.
  assert.equal(mostlyEnglish(screenNote(SCREEN.replace("I'm about to run a simple echo command that prints guard-one.", 'guard-one 을 출력하는 echo 를 실행합니다.'), { description: 'Echo the string guard-one to verify command execution' })), false)
})

test('the lines Claude Code draws for tools are not notes', () => {
  // The lines that turned back calls on 2026-10-11 although the note before them was Korean.
  const korean = '⏺ 세 속성을 달아 보겠습니다. worktree 를 만듭니다.'
  for (const line of [
    '⏺ Running 1 shell command…                                                        ',
    '⏺ Making 1 scratchpad edit +49, running 1 shell command…',
    '⏺ Calling claude-in-chrome 2 times…',
    '⏺ Web Search("iOS 26 Safari form accessory bar remove contenteditable PWA")',
    '⏺ Creating worktree(ios-accessory)',
    '⏺ Read 3 files (ctrl+o to expand)',
  ]) {
    const screen = ['❯ 시도해봐', korean, '', line, '  ⎿  …', '✶ Honking… (running PreToolUse hook · 1s)', '─'.repeat(60)].join('\n')
    assert.equal(screenNote(screen), '세 속성을 달아 보겠습니다. worktree 를 만듭니다.', line.trim())
  }
  // With nothing written before, a tool's line is still not a note.
  assert.equal(screenNote(['❯ 해줘', '⏺ Running 1 shell command…', '✶ x (running PreToolUse hook · 1s)'].join('\n')), '')
})

test('with nothing written before a call, older text and notices above it are not its note', () => {
  // The screen as Claude Code drew it on 2026-10-18 while a PreToolUse hook ran (no "running PreToolUse hook" line).
  const tail = ['', '⏺ Running 1 shell command…', '  ⎿  $ grep -n "" "$f" | tail -25', '', '· Thundering… (2m 33s · ↓ 3.5k tokens)', '─'.repeat(60), '❯ ', '─'.repeat(60)]
  const korean = '⏺ 훅이 도는 순간의 화면을 직접 잡아서 보고 있어요 🔍'
  const english = '⏺ Let me look at the screen at the moment the hook runs, so I can pin down why it misreads.'
  // A note right above the call is read, in either language.
  assert.equal(screenNote(['  Ran 1 shell command', '  ⎿  Allowed by PermissionRequest hook', '', korean, ...tail].join('\n')), '훅이 도는 순간의 화면을 직접 잡아서 보고 있어요 🔍')
  assert.equal(mostlyEnglish(screenNote(['  Searched for 1 pattern, read 1 file', '', english, ...tail].join('\n'))), true)
  // No note: above the call is an earlier call (folded, or with its output), a notice, or older English text.
  for (const above of [
    [english, '', '  Ran 1 shell command', '  ⎿  Allowed by PermissionRequest hook'],
    [english, '', '  Searched for 1 pattern, read 1 file, ran 7 shell commands'],
    [english, '', '⏺ 운영 health 확인', '  ⎿  $ curl -s https://example.test/api/health', '  ⎿  {"ok":true,"version":"0.2.0","github":true,"instance":"7a78f9478d80","originSet":true}'],
    [english, '', '⏺ Background command "e2e run" completed (exit code 0)'],
    [english, '', '⏺ playwright - Click (MCP)(element: "Sign in button", ref: "e12")', '  ⎿  ### Ran Playwright code'],
  ]) assert.equal(screenNote([...above, ...tail].join('\n')), '', above.at(-1))
  // The call not drawn yet: the last block is this call's note, unless calls are already under it.
  assert.equal(screenNote(['❯ 해줘', korean, '', '· x', '─'.repeat(60)].join('\n')), '훅이 도는 순간의 화면을 직접 잡아서 보고 있어요 🔍')
  assert.equal(screenNote(['❯ 해줘', english, '', '  Ran 1 shell command', '', '· x', '─'.repeat(60)].join('\n')), '')
  assert.equal(screenNote(['❯ 해줘', '⏺ Background command "x" failed with exit code 1 (exit code 1)', '· x', '─'.repeat(60)].join('\n')), '')
})

test('a note in English is caught; Korean, code and paths are not', () => {
  // The notes that slipped through on 2026-10-10.
  assert.equal(mostlyEnglish("Works. SPEC: finding where the session page's input is specified."), true)
  assert.equal(mostlyEnglish('The other session took REQ-F-707/AC-1147 and SPEC 1.34 meanwhile. Renumbering mine:'), true)
  assert.equal(mostlyEnglish('Now the edits.'), false, '단어 셋 이하는 두지 않음')
  assert.equal(mostlyEnglish('빌드 통과. 실제 브라우저에서 확인합니다.'), false)
  assert.equal(mostlyEnglish('SPEC 1.29 에 적고 build 를 다시 돌립니다.'), false, '한글이 섞이면 통과')
  assert.equal(mostlyEnglish('`git pull --rebase origin main` 뒤 `git push origin HEAD:main`'), false)
  assert.equal(mostlyEnglish('```js\nconst a = run(command, options)\n```'), false, '코드 블록만 있으면 통과')
  assert.equal(mostlyEnglish('/Users/creco/projects/claude-bridge/ui/src/components/timeline-view.tsx'), false, '경로만 있으면 통과')
  assert.equal(mostlyEnglish('docs/SPEC.md server/server.mjs ui/src/app.tsx'), false, '파일 이름만 있으면 통과')
  assert.equal(mostlyEnglish(''), false)
})
