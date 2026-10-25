// 디스크 관리 (REQ-F-801): which caches the page may clear, what may be moved to the Trash, and that only a host's
// owner reaches it. The agent decides; the page only names a cache id or a path inside the home folder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diskCaches, diskTrashable, guardedDirs, trashDir, duBytes } from '../../agent/guard.mjs'
import { startServer } from './server-harness.mjs'
import { mac } from './fake-mac.mjs'

const H = '/Users/u'

test('diskCaches: fixed places inside the home folder, the Trash last and marked irreversible', () => {
  for (const platform of ['darwin', 'linux']) {
    const list = diskCaches(H, platform)
    assert.ok(list.length >= 8)
    for (const c of list) for (const p of c.paths) assert.ok(p.startsWith(`${H}/`), p)
    assert.equal(list.at(-1).id, 'trash')
    assert.equal(list.filter((c) => c.irreversible).length, 1)
    assert.equal(new Set(list.map((c) => c.id)).size, list.length)
  }
  assert.ok(diskCaches(H, 'darwin').some((c) => c.id === 'xcode-derived'))
  assert.ok(!diskCaches(H, 'linux').some((c) => c.id === 'xcode-derived'))
  assert.equal(diskCaches(H, 'linux').find((c) => c.id === 'go-build').paths[0], `${H}/.cache/go-build`)
  assert.equal(diskCaches(H, 'darwin').find((c) => c.id === 'go-mod').how, 'readonly')
})

test('diskTrashable: inside the home folder, two levels down, never secrets, guarded folders, the agent or a session', () => {
  const o = { home: H, keep: [`${H}/.claude`, `${H}/.claude-bridge`], sessions: [`${H}/projects/app`], platform: 'darwin' }
  assert.equal(diskTrashable(`${H}/projects/old`, o), null)
  assert.equal(diskTrashable(`${H}/projects/old/node_modules`, o), null)
  assert.equal(diskTrashable(`${H}/Library/Caches/com.app`, o), null, '~/Library/Caches 안은 됨')
  assert.match(diskTrashable(H, o), /홈 폴더 안만/)
  assert.match(diskTrashable('/etc/hosts', o), /홈 폴더 안만/)
  assert.match(diskTrashable(`${H}/../x/y`, o), /홈 폴더 안만/)
  assert.match(diskTrashable(`${H}/projects`, o), /홈 바로 아래/)
  assert.match(diskTrashable(`${H}/.ssh/id_rsa`, o), /설정·비밀값/)
  assert.match(diskTrashable(`${H}/Library/Preferences/x.plist`, o), /설정·비밀값/)
  assert.match(diskTrashable(`${H}/Library/Caches`, o), /설정·비밀값/)
  assert.match(diskTrashable(`${H}/.Trash/x`, o), /휴지통 안/)
  assert.match(diskTrashable(`${H}/Documents/a`, o), /macOS 가 지키는/)
  assert.match(diskTrashable(`${H}/.claude/projects`, o), /에이전트·Claude/)
  assert.match(diskTrashable(`${H}/projects/app`, o), /열린 세션/)
  assert.match(diskTrashable(`${H}/projects/app`, { ...o, sessions: [`${H}/projects/app/sub`] }), /열린 세션/)
  assert.equal(diskTrashable(`${H}/Documents/a`, { ...o, platform: 'linux' }), null, 'Linux 에는 macOS 보호 폴더 없음')
  assert.match(diskTrashable(`${H}/.local/share/Trash/files/x`, { ...o, platform: 'linux' }), /휴지통 안/)
  assert.equal(trashDir(H, 'linux'), `${H}/.local/share/Trash/files`)
  assert.ok(guardedDirs(H, 'darwin').includes(`${H}/Library/Mail`))
  assert.deepEqual(guardedDirs(H, 'linux'), [])
  assert.equal(duBytes('12\t/x\n'), 12 * 1024)
  assert.equal(duBytes(''), null)
})

test('서버: 기기 주인만, 정해진 동작만, 답에서 reqId 를 빼고 돌려줌', async () => {
  const srv = await startServer()
  try {
    await srv.login('alice')
    await srv.login('bob')
    await srv.login('boss')
    const id = 'aaaaaaaa-0000-4000-8000-0000000000d1'
    const m = await mac(srv, 'alice', id, 'disk')
    const call = srv.api('alice', `/api/hosts/${id}/disk`, { method: 'POST', body: { op: 'scan', path: '~/projects', extra: 'x' } })
    const cmd = await m.next((x) => x.t === 'disk')
    assert.equal(cmd.op, 'scan')
    assert.equal(cmd.path, '~/projects')
    assert.equal(cmd.extra, undefined)
    await m.up({ t: 'disk', reqId: cmd.reqId, ok: true, path: '~/projects', items: [] })
    const r = await call
    assert.equal(r.status, 200)
    assert.deepEqual(r.json, { ok: true, path: '~/projects', items: [] })
    assert.equal((await srv.api('alice', `/api/hosts/${id}/disk`, { method: 'POST', body: { op: 'rm' } })).status, 400)
    for (const who of ['bob', 'boss']) assert.ok([403, 404].includes((await srv.api(who, `/api/hosts/${id}/disk`, { method: 'POST', body: { op: 'info' } })).status), who)
    m.close()
  } finally {
    await srv.stop()
  }
})
