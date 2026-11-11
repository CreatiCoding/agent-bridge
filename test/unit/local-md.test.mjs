// REQ-F-899: the local screen reads Claude's answers with the web page's own Markdown parser.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { OUT, localMdText, srcHash } from '../../scripts/local-md.mjs'

const md = fs.readFileSync(OUT, 'utf8')

test('agent/localui/md.js is made from ui/src/lib/md-parse.ts as it is (run node scripts/local-md.mjs)', () => {
  assert.match(md.split('\n')[0], new RegExp(`sha256 ${srcHash()}\\)`), 'md-parse.ts 를 고친 뒤 node scripts/local-md.mjs, node scripts/sign-agent.mjs')
  const made = localMdText()
  if (made == null) return // ui's esbuild is not installed here; the hash above still ties md.js to its source.
  assert.equal(md, made, 'node scripts/local-md.mjs 로 다시 만드세요')
})

test('md.js gives a plain script the parser: blocks, inline pieces and diffs, never HTML', () => {
  const box = {}
  vm.runInNewContext(`${md}\nthis.CbMd = CbMd`, box)
  const { parse, inlineParts, isDiff, diffLine } = box.CbMd
  const blocks = JSON.parse(JSON.stringify(parse('## 제목\n\n- [x] 끝\n- 남음\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\n```js\nx\n```\n\n<b>hi</b>')))
  assert.deepEqual(
    blocks.map((b) => b.t),
    ['h', 'list', 'table', 'code', 'p'],
  )
  assert.deepEqual(blocks[1].items, [{ text: '끝', depth: 0, check: true }, { text: '남음', depth: 0 }])
  assert.deepEqual(blocks[2].align, ['left', 'right'])
  assert.equal(blocks[4].text, '<b>hi</b>') // HTML stays text
  assert.deepEqual(JSON.parse(JSON.stringify(inlineParts('**굵게** `c` [링크](https://a.b/c) https://x.y/z.'))), [
    { t: 'strong', kids: [{ t: 'text', text: '굵게' }] },
    { t: 'text', text: ' ' },
    { t: 'code', text: 'c' },
    { t: 'text', text: ' ' },
    { t: 'link', text: '링크', href: 'https://a.b/c' },
    { t: 'text', text: ' ' },
    { t: 'link', text: 'https://x.y/z', href: 'https://x.y/z' },
    { t: 'text', text: '.' },
  ])
  // Only http(s) addresses become links.
  assert.ok(inlineParts('[x](javascript:alert(1))').every((p) => p.t !== 'link'))
  assert.equal(isDiff('@@ -1 +1 @@\n-a\n+b'), true)
  assert.equal(diffLine('+b'), 'd-add')
})

test('the local screen loads md.js before app.js', () => {
  const html = fs.readFileSync(new URL('../../agent/localui/index.html', import.meta.url), 'utf8')
  assert.ok(html.indexOf('src="md.js"') > 0 && html.indexOf('src="md.js"') < html.indexOf('src="app.js"'))
})
