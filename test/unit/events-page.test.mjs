// REQ-F-868 (AC-1627): an events answer that cannot be read is a failed read with a clear sentence,
// never "undefined is not an object (evaluating 'u of t')" from fold.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')

test('a JSON answer whose body cannot be read is an ApiError, not an empty object', () => {
  const src = read('ui/src/lib/api.ts')
  assert.doesNotMatch(src, /res\.json\(\)\.catch\(\(\) => \(\{\}\)\)/)
  assert.match(src, /res\.json\(\)\.catch\(\(\) => unread\)/)
  assert.match(src, /if \(rawBody === unread\) throw new ApiError\([^)]*'서버 답을 다 받지 못했어요\. 다시 시도해 주세요'\)/)
})

test('the session log checks each events page is a list before folding it', () => {
  const src = read('ui/src/lib/session-log.ts')
  assert.match(src, /if \(!Array\.isArray\(page\?\.events\)\) throw new Error\('대화 기록을 읽지 못했어요\. 다시 시도해 주세요'\)/)
  // Every events request goes through the checked reader.
  assert.equal((src.match(/get<EventsPage>\(/g) ?? []).length, 1)
  assert.equal((src.match(/await getPage\(`\/api\/sessions\/\$\{sid\}\/events/g) ?? []).length, 3)
})

test('the server answers an empty legacy log with [], not null', () => {
  assert.match(read('server/api3.go'), /if page == nil \{\n\t\tpage = \[\]any\{\}/)
})
