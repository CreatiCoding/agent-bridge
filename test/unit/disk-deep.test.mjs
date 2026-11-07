// REQ-F-885 깊게 찾기 and REQ-F-886 the bridge MCP disk tools: what is judged on the Mac, what the tools offer, and
// that the removing ops stay signed for a Mac that does not trust the server.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cloneWhy, openClones, dockerLeftovers, ignoredDirs, userXDir, CLONE_QUIET_MS, CLONE_DIR_RE } from '../../agent/guard.mjs'
import { classOf } from '../../agent/trust.mjs'
import { TOOLS, handle } from '../../agent/mcp.mjs'
import { startServer } from './server-harness.mjs'
import { mac } from './fake-mac.mjs'

const X = '/private/var/folders/js/abc/X'

test('AC-1669 a clone goes only when no app has it open and it is over an hour old', () => {
  const now = 10 * CLONE_QUIET_MS
  assert.equal(cloneWhy({ inUse: true, mtimeMs: 0, now }), '실행 중인 앱이 쓰는 중')
  assert.equal(cloneWhy({ inUse: false, mtimeMs: now - CLONE_QUIET_MS + 1, now }), '최근 1시간 안에 생김')
  assert.equal(cloneWhy({ inUse: false, mtimeMs: now - CLONE_QUIET_MS, now }), null)
  assert.equal(cloneWhy({ inUse: false, mtimeMs: NaN, now }), '최근 1시간 안에 생김', '시각을 모르면 남김')
  assert.equal(userXDir('/var/folders/js/abc/T/'), '/var/folders/js/abc/X')
  assert.ok(CLONE_DIR_RE.test('com.google.Chrome.code_sign_clone'))
  assert.ok(!CLONE_DIR_RE.test('../etc'))
})

test('AC-1669 the clones open now are read from lsof by their real path', () => {
  const out = [
    'p123',
    `n${X}/com.google.Chrome.code_sign_clone/code_sign_clone.LIqYaf/Google Chrome.app/Contents/MacOS/Google Chrome`,
    `n${X}/com.google.Chrome.code_sign_clone`,
    `n/var/folders/js/abc/X/com.google.Chrome.code_sign_clone/code_sign_clone.Other/x`,
    `n${X}/other.folder/code_sign_clone.Nope/x`,
  ].join('\n')
  assert.deepEqual([...openClones(out, X)], ['com.google.Chrome.code_sign_clone/code_sign_clone.LIqYaf'])
})

test('AC-1670 only failed containers with nothing mounted are Docker leftovers', () => {
  const row = (o) => JSON.stringify({ ID: 'abc123def456', Names: 'n', Image: 'i', Size: '205MB', Mounts: '', State: 'exited', Status: 'Exited (1) 23 hours ago', ...o })
  const lines = [
    row({}),
    row({ ID: 'bbb123def456', Status: 'Exited (137) 2 weeks ago' }),
    row({ ID: 'ccc123def456', Status: 'Exited (0) 2 days ago' }),
    row({ ID: 'ddd123def456', Mounts: 'pgdata' }),
    row({ ID: 'eee123def456', State: 'running', Status: 'Up 5 days' }),
    row({ ID: '--rm; x' }),
    'not json',
  ].join('\n')
  assert.deepEqual(dockerLeftovers(lines).map((c) => c.id), ['abc123def456', 'bbb123def456'])
})

test('AC-1670 git-ignored folders come without their slash, never .git or outside the repository', () => {
  assert.deepEqual(ignoredDirs('node_modules/\n.env\ntests/.artifacts/\n../up/\n.git/\nsub/.git/x/\n'), ['node_modules', 'tests/.artifacts'])
  assert.equal(ignoredDirs(Array.from({ length: 300 }, (_, i) => `d${i}/`).join('\n')).length, 200)
})

test('AC-1671 the bridge MCP offers disk_hosts · disk_look · disk_clean, and look cannot ask to remove', async () => {
  const look = TOOLS.find((t) => t.name === 'disk_look')
  const clean = TOOLS.find((t) => t.name === 'disk_clean')
  assert.ok(TOOLS.some((t) => t.name === 'disk_hosts'))
  assert.deepEqual(look.inputSchema.properties.op.enum, ['info', 'scan', 'worktrees', 'probe'])
  assert.deepEqual(clean.inputSchema.properties.op.enum, ['clean', 'trash', 'prune', 'clones', 'docker'])
  const asked = []
  const r = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'disk_look', arguments: { host: 'h1', op: 'probe' } } }, async (name, args) => (asked.push([name, args]), { ok: 1 }))
  assert.deepEqual(asked, [['disk_look', { host: 'h1', op: 'probe' }]])
  assert.equal(r.result.isError, undefined)
})

test('AC-1671 probe is free; clones and docker are signed like clean on a Mac that does not trust the server', () => {
  assert.equal(classOf({ t: 'disk', op: 'probe' }), 'free')
  for (const op of ['clones', 'docker']) assert.deepEqual(classOf({ t: 'disk', op }), { i: ['op', 'id', 'path', 'paths'] })
})

test('AC-1671 an operator\'s own session reaches another person\'s Mac only while the owner\'s grant lasts', async () => {
  const srv = await startServer({ env: { BRIDGE_ADMIN_LOGINS: 'boss' } })
  let a, b
  try {
    for (const who of ['alice', 'boss']) await srv.login(who)
    const A = 'aaaaaaaa-0000-4000-8000-0000000000e1'
    const B = 'bbbbbbbb-0000-4000-8000-0000000000e2'
    a = await mac(srv, 'alice', A, 'alice-mac')
    b = await mac(srv, 'boss', B, 'boss-mac')
    const started = srv.api('boss', '/api/sessions', { method: 'POST', body: { hostId: B, cwd: '~', prompt: '디스크' } })
    await b.answerNew()
    const sid = (await started).json.id
    const ask = async (op, args) => {
      const areq = `r-${Math.random()}`
      await b.up({ t: 'delegate', areq, sid, op, args })
      return b.next((m) => m.t === 'delegated' && m.areq === areq, 15000)
    }
    const help = (who, op, login) => srv.api(who, `/api/hosts/${A}/disk-help`, { method: 'POST', body: { op, ...(login ? { login } : {}) } })
    assert.deepEqual((await ask('disk_hosts', {})).result.map((h) => [h.name, h.own]), [['boss-mac', true]], '허용 전엔 자기 기기만')
    assert.equal((await ask('disk_look', { host: A, op: 'info' })).ok, false, '허용 전')
    assert.equal((await help('boss', 'ask')).status, 200)
    assert.equal((await help('alice', 'grant', 'boss')).status, 200)
    const listed = (await ask('disk_hosts', {})).result.find((h) => h.id === A)
    assert.equal(listed.owner, 'alice')
    assert.equal(listed.own, false)
    assert.equal((await ask('disk_look', { host: A, op: 'clean', id: 'npm' })).ok, false, 'look 으로는 지우지 못함')
    assert.equal((await ask('disk_clean', { host: A, op: 'scan' })).ok, false, 'clean 으로는 보기만 못함')
    const pending = ask('disk_look', { host: A, op: 'probe', extra: 'x' })
    const cmd = await a.next((x) => x.t === 'disk')
    assert.equal(cmd.op, 'probe')
    assert.equal(cmd.extra, undefined)
    await a.up({ t: 'disk', reqId: cmd.reqId, ok: true, gap: 1 })
    const got = await pending
    assert.equal(got.ok, true)
    assert.equal(got.result.gap, 1)
    assert.equal((await help('alice', 'end')).status, 200)
    assert.equal((await ask('disk_look', { host: A, op: 'info' })).ok, false, '거둔 뒤')
    assert.deepEqual((await ask('disk_hosts', {})).result.map((h) => h.id), [B])
  } finally {
    a?.close()
    b?.close()
    await srv.stop()
  }
})
