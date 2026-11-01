// 세션 정리 기기 줄 (REQ-F-839 rule 1·3, AC-1524): the page groups rows as the server counts the host line, from one
// fixture both read (server/tidy_test.go TestTidyGroups).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tidyGroups, tidyBriefText } from '../../ui/src/lib/tidy-groups.ts'

const fx = JSON.parse(fs.readFileSync(new URL('../fixtures/tidy-groups.json', import.meta.url), 'utf8'))

test('tidyGroups: the same lists as the server counts (shared fixture)', () => {
  const { stop, rest } = tidyGroups(fx.rows)
  assert.deepEqual(stop.map((r) => r.sid), fx.stop)
  assert.deepEqual(rest.map((r) => r.sid), fx.rest)
  // A row is in one list at most: a running session the batch counts is not also offered a rest.
  assert.equal(new Set([...fx.stop, ...fx.rest]).size, fx.stop.length + fx.rest.length)
})

test('tidyBriefText: the three counts the open box heads its lists with', () => {
  assert.equal(tidyBriefText({ stop: 1, rest: 2, files: 3 }), '내릴 세션 1 · 휴면·끝내기 제안 2 · 폴더·기록 제안 3')
  assert.equal(tidyBriefText({ stop: 0, rest: 1, files: 0 }), '내릴 세션 0 · 휴면·끝내기 제안 1 · 폴더·기록 제안 0')
  assert.equal(tidyBriefText({ stop: 0, rest: 0, files: 0 }), '세션 정리: 정리할 것 없음')
})
