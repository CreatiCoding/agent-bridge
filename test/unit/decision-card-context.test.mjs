// 카드의 화면 내용 (REQ-F-592, AC-1640): a card with no tool (a codex approval, a Claude Code dialog read off the
// terminal) carries what it asks about as `context`. The web card drew only `tool`, so a codex approval showed
// "Would you like to run the following command?" without the command.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseApproval } from '../../agent/codex.mjs'

const src = readFileSync(new URL('../../ui/src/components/decision-card.tsx', import.meta.url), 'utf8')

test('열린 카드와 닫힌 카드 모두 tool 이 없으면 context 를 <pre> 로 보인다', () => {
  const shown = src.match(/: card\.context \? \(\s*<div className=[^>]*dcard-detail[^>]*>\s*<pre>\{card\.context\}<\/pre>/g) ?? []
  assert.equal(shown.length, 2)
})

test('codex 명령 승인의 명령은 context 에 담긴다', () => {
  const screen = [
    '› 고쳐줘',
    '',
    'Would you like to run the following command?',
    '',
    '  $ sudo launchctl list',
    '',
    '› 1. Yes, proceed (y)',
    "  2. Yes, and don't ask again for commands that start with `sudo launchctl` (p)",
    '  3. No, and tell Codex what to do differently (esc)',
    '',
    '  Press enter to confirm or esc to cancel',
  ].join('\n')
  const a = parseApproval(screen)
  assert.equal(a.question, 'Would you like to run the following command?')
  assert.match(a.context, /\$ sudo launchctl list/)
})
