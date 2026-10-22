// The answer being written, as agent/preview.mjs reads it off the screen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// The preview proxy itself (server/preview.go) is checked in server/preview_test.go.

// The answer being written (agent/preview.mjs), read off real screens of Claude Code 2.1.305 (`capture-pane -p -e`,
// 220 columns) in fixtures/. A code block is drawn without fence or background: only its colours tell it apart.
import { writingPreview } from '../../agent/preview.mjs'
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

test('a code block in the answer being written keeps its lines (preview-code-js: mid-answer)', () => {
  const md = writingPreview(fixture('preview-code-js.txt'))
  // Before 1.308 the short code lines were joined: "return a + b; }" and "결과 출력console.log(add(1, 2));".
  assert.doesNotMatch(md, /return a \+ b; *\}/)
  assert.doesNotMatch(md, /출력console/)
  const code = /```\n([\s\S]*?)\n```/.exec(md)?.[1]
  assert.equal(
    code,
    [
      '// 두 개의 숫자를 받아서 더한 결과를 반환하는 함수',
      'function add(a, b) {',
      '  // 두 매개변수를 더하고 결과를 반환',
      '  return a + b;',
      '}',
      '',
      '// add 함수를 호출하여 1과 2를 더하고 결과 출력',
      'console.log(add(1, 2));',
      '',
      '// add 함수를 호출하여 3과 4를 더하고 결과 출력',
      'console.log(add(3, 4));',
    ].join('\n'),
  )
  // The paragraph the screen wrapped at 218 columns is one paragraph again, the space the wrap took put back.
  const para = md.split('\n\n')[0]
  assert.equal(para.includes('\n'), false)
  assert.match(para, /전달된 두 개의 숫자/)
  assert.match(para, /출력값의 관계를/)
  assert.match(para, /^자바스크립트에서 .* 핵심적인 기초가 됩니다\.$/)
})

test('text that is not code is not taken for code, and a plain code block is code (preview-code-kinds: mid-answer)', () => {
  const md = writingPreview(fixture('preview-code-kinds.txt'))
  assert.equal(
    md,
    [
      '**Heading**',
      '',
      'See the docs (https://example.com/docs) and https://example.org now, with **bold**, italic and `inline` words.',
      '',
      '▎ a quoted line',
      '',
      '- item one',
      '- item two',
      '',
      '```',
      'plain text block line one',
      'line two',
      '',
      'def f(x):',
      '    return x',
      '```',
      '',
      'Done.',
    ].join('\n'),
  )
})

test('lines the writer ended are not joined; a line the screen wrapped is', () => {
  const RULE = '─'.repeat(40)
  const screen = (...block) => [`⏺ ${block[0]}`, ...block.slice(1).map((l) => `  ${l}`), '', RULE, '❯ ', RULE].join('\n')
  // 38 text columns: "short line" + " next" fits, so the break was the writer's.
  assert.equal(writingPreview(screen('short line', 'next line')), 'short line\nnext line')
  const full = 'aaaa bbbb cccc dddd eeee ffff gggg hhh'
  assert.equal(full.length, 38)
  assert.equal(writingPreview(screen(full, 'iiii end')), `${full} iiii end`)
})
