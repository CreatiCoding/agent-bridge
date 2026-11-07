// Codex 세션의 그림 보여 주기와 오지 않은 그림 (REQ-F-872, AC-1632): codex is told to name a picture by its path
// (the page draws a path it names), and a sent picture that does not come is asked again, then drawn as a tile.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
const agent = read('agent/agent.mjs')
const view = read('ui/src/components/timeline-view.tsx')
const css = read('ui/src/styles.css')

const codexPrompt = () => {
  const m = /const CODEX_PROMPT = '((?:[^'\\]|\\.)*)'/.exec(agent)
  assert.ok(m, 'CODEX_PROMPT 가 있다')
  return m[1].replace(/\\'/g, "'")
}

test('codex 에게 그림은 절대 경로로 보이라고 알린다', () => {
  const p = codexPrompt()
  assert.match(p, /cannot attach files/)
  assert.match(p, /absolute path/)
  assert.match(p, /`\/tmp\/shot\.png`/)
  assert.match(p, /\/tmp/)
})

test('안내의 예시 경로를 페이지가 그림으로 알아본다', () => {
  const m = /const LOCAL_IMG_RE = \/(.+)\/gi\n/.exec(view)
  assert.ok(m, 'LOCAL_IMG_RE 가 있다')
  const re = new RegExp(m[1], 'gi')
  const found = [...'그림은 `/tmp/shot.png` 이에요'.matchAll(re)].map((x) => x[1])
  assert.deepEqual(found, ['/tmp/shot.png'])
  const ko = [...'비교: /tmp/RN-빌드-쇼핑제외-비교.png'.matchAll(re)].map((x) => x[1])
  assert.deepEqual(ko, ['/tmp/RN-빌드-쇼핑제외-비교.png'])
})

test('오지 않은 그림은 3초·10초 뒤 두 번 다시 묻고, 그래도 안 오면 다시 버튼이 있는 칸', () => {
  const at = view.indexOf('function Thumb(')
  assert.ok(at >= 0)
  const body = view.slice(at, view.indexOf('const THUMB_RETRY_MS', at))
  assert.match(body, /onError=/)
  assert.match(body, /setTimeout\(\(\) => setTries\(tries \+ 1\), THUMB_RETRY_MS\[tries\]\)/)
  assert.match(body, /\?r=\$\{tries\}/)
  assert.match(body, /thumb-gone/)
  assert.match(body, /그림을 불러오지 못했어요/)
  assert.match(view, /const THUMB_RETRY_MS = \[3000, 10000\]/)
  assert.ok(css.includes('\n.thumb-gone {'))
})
