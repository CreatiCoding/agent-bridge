// 새 세션 기본 폴더 (REQ-F-763).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanFolderBase, defaultFolder, folderPart } from '../../server/folder.mjs'
import { startServer } from './server-harness.mjs'

test('기본 폴더: <기본 폴더>/<그룹>/<월일>-<id>, 그룹 이름은 폴더 하나로 (1.206)', () => {
  const at = new Date(2026, 9, 7)
  assert.equal(defaultFolder({ base: '~/bridge/works', noGroup: '기타', group: '개발' }, at, 'a3f9c2'), '~/bridge/works/개발/1007-a3f9c2')
  assert.equal(defaultFolder({ base: '', noGroup: '', group: '' }, at, 'a3f9c2'), '~/bridge/works/기타/1007-a3f9c2')
  assert.equal(defaultFolder({ base: '/Users/x/w/', noGroup: '잡일', group: undefined }, at, '000000'), '/Users/x/w/잡일/1007-000000')
  assert.match(defaultFolder({}), /^~\/bridge\/works\/기타\/\d{4}-[0-9a-f]{6}$/)
  assert.equal(folderPart('앱 / 웹:서버'), '앱-웹-서버')
  assert.equal(folderPart('../..'), '')
  assert.equal(folderPart('.숨김'), '숨김')
  assert.equal(cleanFolderBase('~/a/'), '~/a')
  for (const bad of ['a/b', '~/../etc', '../x', '~/a\nb', `~/${'a'.repeat(200)}`]) assert.equal(cleanFolderBase(bad), '', bad)
})

test('기본 폴더 설정: /api/prefs/launch 에 저장되고, 잘못된 값은 거절 (1.206)', async () => {
  const s = await startServer()
  try {
    await s.login('alice')
    const first = await s.api('alice', '/api/prefs/launch')
    assert.equal(first.json.folderBase, '~/bridge/works')
    assert.equal(first.json.folderNoGroup, '기타')
    const saved = await s.api('alice', '/api/prefs/launch', { method: 'POST', body: { folderBase: '~/work/', folderNoGroup: '잡 일' } })
    assert.equal(saved.status, 200)
    assert.equal(saved.json.folderBase, '~/work')
    assert.equal(saved.json.folderNoGroup, '잡-일')
    assert.equal((await s.api('alice', '/api/prefs/launch', { method: 'POST', body: { folderBase: '~/../etc' } })).status, 400)
    assert.equal((await s.api('alice', '/api/prefs/launch')).json.folderBase, '~/work')
  } finally {
    await s.stop()
  }
})
