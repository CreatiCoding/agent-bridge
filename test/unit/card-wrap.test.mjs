// 카드 선택지의 긴 글 (REQ-F-871, AC-1630): a long command in an option wraps inside the card, and iOS does not
// enlarge the text of that option.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../../ui/src/styles.css', import.meta.url), 'utf8')
const rule = (sel) => {
  const at = css.indexOf(`\n${sel} {`)
  assert.ok(at >= 0, `${sel} 규칙이 있다`)
  return css.slice(at, css.indexOf('}', at))
}

test('iOS 글자 자동 확대를 끈다', () => {
  const r = rule('html')
  assert.match(r, /-webkit-text-size-adjust:\s*100%/)
  assert.match(r, /\btext-size-adjust:\s*100%/)
})

test('선택지의 글은 칸 안에서 줄바꿈된다', () => {
  assert.match(rule('.opt'), /min-width:\s*0/)
  const at = css.indexOf('.opt > span,\n.opt small {')
  assert.ok(at >= 0)
  assert.match(css.slice(at, css.indexOf('}', at)), /overflow-wrap:\s*anywhere/)
})

test('카드 제목·설명도 긴 단어를 끊는다', () => {
  assert.match(rule('.dcard-title'), /overflow-wrap:\s*anywhere/)
  assert.match(rule('.dcard-desc'), /overflow-wrap:\s*anywhere/)
})
