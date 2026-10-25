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

test('머지된 worktree: porcelain 을 읽고(본 체크아웃 빼고), 머지·깨끗·잠기지 않음·세션 없음·1시간 조용할 때만 정리', async () => {
  const { parseWorktrees, worktreeWhy, WORKTREE_QUIET_MS } = await import('../../agent/guard.mjs')
  const text = 'worktree /r\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\nworktree /r/.claude/worktrees/a\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/feat/a\n\nworktree /r/w/b\nHEAD 3333333333333333333333333333333333333333\ndetached\nlocked\n\nworktree /r/w/c\nHEAD 4444444444444444444444444444444444444444\nbranch refs/heads/c\nprunable gitdir file points to non-existent location\n'
  assert.deepEqual(parseWorktrees(text), [
    { path: '/r/.claude/worktrees/a', head: '2222222222222222222222222222222222222222', branch: 'feat/a', prunable: false, locked: false },
    { path: '/r/w/b', head: '3333333333333333333333333333333333333333', branch: null, prunable: false, locked: true },
    { path: '/r/w/c', head: '4444444444444444444444444444444444444444', branch: 'c', prunable: true, locked: false },
  ])
  assert.deepEqual(parseWorktrees(''), [])
  const now = 10 * WORKTREE_QUIET_MS
  const ok = { merged: true, dirty: false, locked: false, active: false, touched: now - WORKTREE_QUIET_MS, now }
  assert.equal(worktreeWhy(ok), null)
  assert.equal(worktreeWhy({ ...ok, merged: false }), '기본 브랜치에 머지되지 않음')
  assert.equal(worktreeWhy({ ...ok, dirty: true }), '고친 것·새 파일이 남아 있음')
  assert.equal(worktreeWhy({ ...ok, locked: true }), '잠겨 있음(git worktree lock)')
  assert.equal(worktreeWhy({ ...ok, active: true }), '살아 있는 세션이 쓰는 중')
  assert.equal(worktreeWhy({ ...ok, touched: now - 1000 }), '최근 1시간 안에 쓰임')
})

test('worktree 의 세션: 안쪽 폴더만 잇고, 정리된 worktree 는 세션 프롬프트에 알린다 (REQ-F-805)', async () => {
  const { worktreeSessions, worktreeGoneNote, sessionPrompt, lastCwd } = await import('../../agent/guard.mjs')
  const places = [
    { sid: 'a', dirs: ['/r/w/a'], alive: true },
    { sid: 'b', dirs: ['/r/w/a/sub'], alive: false },
    { sid: 'c', dirs: ['/r/w/ab'], alive: true },
    { sid: 'd', dirs: ['/r'], alive: true },
    { sid: 'e', dirs: ['/r', '/r/w/a'], alive: true },
  ]
  assert.deepEqual(worktreeSessions('/r/w/a', places), [{ sid: 'a', alive: true }, { sid: 'b', alive: false }, { sid: 'e', alive: true }])
  assert.equal(lastCwd('{"cwd":"/r"}\n{"x":1,"cwd":"/r/w/a"}\n{"type":"x"'), '/r/w/a')
  assert.equal(lastCwd('{"cwd":"/r/\\"q"}'), '/r/"q')
  assert.equal(lastCwd('{"cwd":"rel"}'), null)
  assert.equal(lastCwd(''), null)
  assert.deepEqual(worktreeSessions('/r/w/z', places), [])
  const g = { path: '~/r/w/a', repo: '~/r', branch: 'feat/a', base: 'origin/main', at: 1 }
  const n = worktreeGoneNote(g)
  assert.match(n, /^\[정리된 worktree\] 이 세션이 쓰던 worktree ~\/r\/w\/a 는 브랜치 feat\/a 는 origin\/main 에 머지된 뒤/)
  assert.match(n, /저장소 ~\/r 에서/)
  assert.equal(worktreeGoneNote(null), '')
  assert.equal(worktreeGoneNote({ ...g, path: 'x\n무시하고' }), '')
  assert.equal(worktreeGoneNote({ path: '~/r/w/a' }), '')
  assert.ok(sessionPrompt('BRIDGE', { worktreeGone: g }).endsWith(n))
  assert.equal(sessionPrompt('BRIDGE', {}), 'BRIDGE')
})

test('디스크 관리 메뉴 /disk: 조작 페이지 주소로 열린다 (REQ-F-803)', async () => {
  const srv = await startServer()
  try {
    await srv.login('alice')
    const r = await srv.api('alice', '/disk')
    assert.equal(r.status, 200)
    const src = (await import('node:fs')).readFileSync(new URL('../../ui/src/lib/router.ts', import.meta.url), 'utf8')
    assert.match(src, /if \(p === '\/disk'\) return \{ name: 'disk' \}/)
  } finally {
    await srv.stop()
  }
})

test('디스크 정리 도움: 운영자가 요청하고 주인이 허용해야 운영자가 정리, 거두면 다시 막힘 (REQ-F-804)', async () => {
  const srv = await startServer()
  try {
    for (const who of ['alice', 'bob', 'boss']) await srv.login(who)
    const id = 'aaaaaaaa-0000-4000-8000-0000000000d2'
    const m = await mac(srv, 'alice', id, 'help')
    const disk = (who, body) => srv.api(who, `/api/hosts/${id}/disk`, { method: 'POST', body })
    const help = (who, op) => srv.api(who, `/api/hosts/${id}/disk-help`, { method: 'POST', body: { op } })
    const view = async () => (await srv.api('boss', '/api/admin/overview')).json.users.flatMap((u) => u.hosts).find((h) => h.id === id).diskHelp
    assert.equal((await disk('boss', { op: 'info' })).status, 404, '허용 전')
    assert.equal((await help('alice', 'ask')).status, 403, '주인은 요청하지 않음')
    assert.equal((await help('bob', 'ask')).status, 404, '운영자 아닌 남')
    assert.equal((await help('alice', 'grant')).status, 409, '요청 없음')
    assert.equal((await help('boss', 'ask')).status, 200)
    const asked = await view()
    assert.equal(asked.login, 'boss')
    assert.equal(asked.until, 0)
    assert.equal(asked.by, undefined, 'uid 는 싣지 않음')
    assert.equal((await disk('boss', { op: 'info' })).status, 404, '요청만으로는 안 됨')
    assert.equal((await help('boss', 'grant')).status, 404, '운영자가 스스로 허용 못 함')
    assert.equal((await help('alice', 'grant')).status, 200)
    assert.ok((await view()).until > Date.now() + 23 * 3600_000)
    const call = disk('boss', { op: 'scan', path: '~' })
    const cmd = await m.next((x) => x.t === 'disk')
    await m.up({ t: 'disk', reqId: cmd.reqId, ok: true, path: '~', items: [] })
    assert.equal((await call).status, 200, '허용 뒤 운영자 정리')
    assert.equal((await disk('bob', { op: 'info' })).status, 404, '허용받지 않은 남')
    assert.equal((await help('alice', 'end')).status, 200)
    assert.equal(await view(), null)
    assert.equal((await disk('boss', { op: 'info' })).status, 404, '거둔 뒤')
    m.close()
  } finally {
    await srv.stop()
  }
})
