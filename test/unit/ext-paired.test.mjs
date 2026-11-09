// 짝지은 기기의 익스텐션 (REQ-F-864): off unless turned on on this device for this hash, kept in this browser only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')

test('짝지은 기기는 이 기기에서 켠 것(같은 해시)만 띄운다', () => {
  const host = read('ui/src/lib/ext-host.tsx')
  assert.match(host, /if \(pairedHosts\(\)\.length && !pairedAllowed\(x\)\) return report\(/)
  assert.match(host, /localStorage\.getItem\(pairedKey\(x\.id\)\) === x\.hash/)
  // Turning it on asks first and says what the code can do with this device's keys.
  assert.match(host, /이 기기의 서명 키로 맥에 명령을 보내고/)
  const allow = host.slice(host.indexOf('export async function allowOnPaired'))
  assert.ok(allow.indexOf('if (!sure) return false') < allow.indexOf('localStorage.setItem(pairedKey(x.id), x.hash)'))
  // The server cannot turn it on: nothing about it is sent or read from /api.
  assert.doesNotMatch(host, /call\([^)]*paired/i)
})

test('설정 → 플러그인: 짝지은 기기에서 동의한 익스텐션에 "이 기기에서도 켜기"', () => {
  const s = read('ui/src/components/ext-panels.tsx')
  assert.match(s, /paired && x\.consented && !x\.loadError \?/)
  assert.match(s, /label=\{`\$\{x\.name\} 이 기기에서도 켜기`\}/)
  assert.match(s, /allowOnPaired\(x, on\)/)
})

test('코드가 바뀌어도 이 기기에서 계속 켜기 (AC-1720)', () => {
  const host = read('ui/src/lib/ext-host.tsx')
  // Kept in this browser only, after a warning; the server neither sets nor reads it.
  assert.match(host, /const keepKey = \(id: string\) => `cb-ext-paired-keep-\$\{id\}`/)
  assert.match(host, /코드가 바뀌어도 이 기기에서 계속 켤까요\?/)
  const keep = host.slice(host.indexOf('export async function keepOnPaired'))
  assert.ok(keep.indexOf('if (!sure) return false') < keep.indexOf('localStorage.setItem(keepKey(x.id)'))
  assert.match(keep, /danger: true/)
  assert.doesNotMatch(host, /call\([^)]*keep/i)
  // On with the keep even when the hash differs; turning the device switch off clears both.
  assert.match(host, /localStorage\.getItem\(pairedKey\(x\.id\)\) !== null && localStorage\.getItem\(keepKey\(x\.id\)\) !== null/)
  assert.match(host, /localStorage\.removeItem\(pairedKey\(x\.id\)\), localStorage\.removeItem\(keepKey\(x\.id\)\)/)
  // The first load after a change says which files changed, then remembers the new hash.
  assert.match(host, /if \(pairedHosts\(\)\.length\) noteChanged\(x\)/)
  assert.match(host, /의 코드가 바뀌어 새 코드로 띄웠어요/)
  const s = read('ui/src/components/ext-panels.tsx')
  assert.match(s, /label=\{`\$\{x\.name\} 코드가 바뀌어도 이 기기에서 계속 켜기`\}/)
  assert.match(s, /keepOnPaired\(x, on\)/)
})

test('filesChanged: 바뀜·새로·지움', async () => {
  // The same logic as ext-host.tsx filesChanged, checked against its source so the two stay one.
  const host = read('ui/src/lib/ext-host.tsx')
  const src = host.slice(host.indexOf('export function filesChanged'), host.indexOf('function namesOf'))
  const fn = new Function(`${src.replace('export function', 'function').replace(/: Record<string, string>/g, '')}; return filesChanged`)()
  assert.deepEqual(fn({ 'a.js': '1', 'b.js': '2', 'c.js': '3' }, { 'a.js': '1', 'b.js': '9', 'd.js': '4' }), { changed: ['b.js'], added: ['d.js'], removed: ['c.js'] })
  assert.deepEqual(fn({}, { 'a.js': '1' }), { changed: [], added: ['a.js'], removed: [] })
})
