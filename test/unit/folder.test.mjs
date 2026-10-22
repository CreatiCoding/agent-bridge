// 새 세션 기본 폴더 (REQ-F-763).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './server-harness.mjs'

// The folder name itself (<기본 폴더>/<그룹>/<월일>-<id>) is checked in server/small_test.go.
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
