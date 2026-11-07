// A pressed option on a decision card that looked switched off (REQ-F-877, AC-1654): on a phone the tapped option kept
// :hover, whose near-clear colour covered the primary option's accent (dark text on dark grey in dark mode), and an
// option locked while its answer travelled looked the same as before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../../ui/src/styles.css', import.meta.url), 'utf8')
const card = readFileSync(new URL('../../ui/src/components/decision-card.tsx', import.meta.url), 'utf8')

/** The rules of the top level of the sheet, outside any @media block. */
function topLevel(src) {
  let depth = 0
  let out = ''
  let media = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '@' && depth === 0 && src.startsWith('@media', i)) media = 1
    if (c === '{') {
      if (media === 1 && depth === 0) media = 2
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0 && media === 2) {
        media = 0
        continue
      }
    }
    if (!media) out += c
  }
  return out
}

test('선택지의 :hover 는 마우스가 있는 기기에서만 (휴대폰에서 눌린 뒤 남지 않음)', () => {
  const top = topLevel(css)
  assert.doesNotMatch(top, /\.opt[^{}]*:hover/, '최상위에 .opt …:hover 규칙이 없다')
  assert.match(css, /@media \(hover: hover\) \{\s*\.opt:not\(\.primary\):hover:not\(:disabled\)/)
})

test('답이 가는 동안 다른 선택지는 흐려지고 누른 선택지는 또렷하게 스피너를 보인다', () => {
  assert.match(css, /\.opt:disabled \{\s*opacity: 0\.5;/)
  assert.match(css, /\.opt\.pressing:disabled \{\s*opacity: 1;/)
  assert.match(card, /busy === String\(o\.n\) \? ' pressing' : ''/)
  assert.match(card, /busy === String\(o\.n\) \? <Spinner size=\{14\} \/> : null/)
})
