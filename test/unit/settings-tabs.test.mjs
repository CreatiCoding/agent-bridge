// 설정 탭 줄 (REQ-F-711 1b, AC-1638): the row never scrolls up and down. A 1 px overflow (tabs reaching into the
// row's border with margin-bottom: -1px) made it a vertical scroll box, and on an iPhone a drag on the tabs moved
// them down inside the row and left their names cut in half.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../../ui/src/styles.css', import.meta.url), 'utf8')
const rules = (sel) => {
  const out = []
  for (let at = css.indexOf(`${sel} {`); at >= 0; at = css.indexOf(`${sel} {`, at + 1)) {
    if (/[\w-]/.test(css[at - 1] ?? '')) continue
    out.push(css.slice(at, css.indexOf('}', at)))
  }
  assert.ok(out.length, `${sel} 규칙이 있다`)
  return out
}

test('탭 줄은 위아래로 스크롤되지 않는다', () => {
  const [base] = rules('.page-tabs')
  assert.match(base, /overflow-y:\s*hidden/)
  assert.match(base, /overscroll-behavior:\s*contain/)
  // The line under the row is a shadow, not a border the tabs overlap.
  assert.doesNotMatch(base, /border-bottom/)
  assert.match(base, /box-shadow:\s*inset 0 -1px 0 var\(--line\)/)
})

test('탭은 줄 밖으로 1 px 도 나가지 않는다', () => {
  for (const r of rules('.page-tab')) assert.doesNotMatch(r, /margin-bottom:\s*-/)
})

test('폰에서는 탭 줄이 스크롤 상자가 아니다', () => {
  const phone = rules('.page-tabs').find((r) => /gap:\s*0/.test(r))
  assert.ok(phone, '폰 규칙이 있다')
  assert.match(phone, /overflow:\s*hidden/)
})
