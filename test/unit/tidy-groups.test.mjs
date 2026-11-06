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

// AC-1634: the 세션 정리 page names rows by their session, the path or id only under it.
test('tidyRowName·tidyRowSub: a session name first, the folder name when none, path and id below', async () => {
  const { tidyRowName, tidyRowSub, shortPath } = await import('../../ui/src/lib/tidy-groups.ts')
  assert.equal(tidyRowName({ title: '결제 화면 고치기', sid: 'abcdef123456' }), '결제 화면 고치기')
  assert.equal(tidyRowName({ name: '새 이름', path: '~/bridge/works/a/1106-029fb3' }), '새 이름')
  assert.equal(tidyRowName({ path: '~/bridge/works/a/1106-029fb3' }), '1106-029fb3')
  assert.equal(tidyRowName({ path: '~/.claude/projects/x/3f2a.jsonl' }), '3f2a')
  assert.equal(tidyRowName({ title: '  ', sid: 'abcdef123456' }), 'abcdef12')
  assert.equal(tidyRowName({ cwd: '/Users/u/works/1104-noname', sid: 'abcdef123456' }), '1104-noname', '이름 없는 세션은 id 가 아니라 폴더 이름')
  assert.equal(tidyRowSub({ cwd: '/Users/u/bridge/works/a/b', sid: 'abcdef123456' }), '…/works/a/b · abcdef12')
  assert.equal(tidyRowSub({ path: '~/a' }), '~/a')
  assert.equal(shortPath('/a/b/c/d', 2), '…/c/d')
  assert.equal(shortPath(''), '')
})
