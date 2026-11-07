// REQ-F-879: a touch device opens an answer's link in the in-app browser sheet (reading mode, localhost through the
// preview); a computer, a new tab.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { imageUrl, localPort, opensInApp, readerImg, throughPreview } from '../../ui/src/lib/in-app.ts'

const base = 'https://bridge.example/s/abc'

test('a touch device takes answers and the pages’ links into the sheet', () => {
  for (const from of ['markdown', 'report', 'guide', 'settings']) assert.equal(opensInApp('https://example.com/a', from, true, base), true, from)
  assert.equal(opensInApp('https://github.com/o/r', 'markdown', true, base), true)
  assert.equal(opensInApp('http://localhost:3000/x', 'markdown', true, base), true)
  assert.equal(opensInApp('/api/reports/r1/img/a.png', 'report', true, base), true)
})

test('a computer, a login, a PR, the sheet’s own button and this site’s pages go to the browser', () => {
  assert.equal(opensInApp('https://example.com/a', 'markdown', false, base), false)
  for (const from of ['accounts', 'pr', 'slack', 'preview', 'inapp']) assert.equal(opensInApp('https://example.com/a', from, true, base), false, from)
  assert.equal(opensInApp('mailto:a@b.c', 'markdown', true, base), false)
  assert.equal(opensInApp('/settings', 'settings', true, base), false)
})

test('a picture shows as one picture: this site’s directly, another’s through the server', () => {
  assert.equal(imageUrl('/api/reports/r1/img/a.png', base), '/api/reports/r1/img/a.png')
  assert.equal(imageUrl('https://cdn.example/a.JPG?w=1', base), readerImg('https://cdn.example/a.JPG?w=1'))
  assert.equal(readerImg('https://cdn.example/a b.png'), '/api/read/img?u=https%3A%2F%2Fcdn.example%2Fa%20b.png')
  assert.equal(imageUrl('https://example.com/post', base), null)
})

test('a localhost link: its port, and its path on the preview root', () => {
  assert.equal(localPort('http://localhost:5173/a?b=1'), 5173)
  assert.equal(localPort('http://127.0.0.1/'), 80)
  assert.equal(localPort('https://example.com:5173/'), null)
  assert.equal(throughPreview('https://p.example/t/tok/', 'http://localhost:5173/docs/a?b=1#c'), 'https://p.example/t/tok/docs/a?b=1#c')
})

test('link.open’s default asks the sheet before a new tab; the sheet draws data, never the page’s HTML', () => {
  const src = readFileSync(new URL('../../ui/src/lib/builtin-actions.tsx', import.meta.url), 'utf8')
  assert.match(src, /else if \(opensInApp\(url, from\)\) openInApp\(url\)\s*\n\s*else window\.open\(url, '_blank', 'noopener'\)/)
  const sheet = readFileSync(new URL('../../ui/src/components/link-sheet.tsx', import.meta.url), 'utf8')
  assert.match(sheet, /openLink\(outside, 'inapp'\)/)
  assert.match(sheet, /\/api\/read\?u=/)
  assert.doesNotMatch(sheet, /dangerouslySetInnerHTML|innerHTML/)
  // The only frame is the localhost preview.
  assert.equal((sheet.match(/<iframe/g) ?? []).length, 1)
  assert.match(sheet, /kind: 'frame', src: throughPreview\(/)
})
