// R1-L5 (리포트 #1): the server gives up root once the data folder is the node user's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chownTree, dropRoot } from '../../server/drop-root.mjs'

test('every path not owned by the user is handed over, and a failure is counted', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-own-'))
  fs.mkdirSync(path.join(d, 'u/a'), { recursive: true })
  fs.writeFileSync(path.join(d, 'u/a/x.json'), '{}')
  const seen = []
  assert.equal(chownTree(d, 4242, 4242, (p) => seen.push(path.relative(d, p))), 0)
  assert.deepEqual(seen.sort(), ['', 'u', 'u/a', 'u/a/x.json'])
  assert.equal(chownTree(d, 4242, 4242, () => { throw new Error('EPERM') }), 4)
  fs.rmSync(d, { recursive: true, force: true })
})

test('root is given up only when everything was handed over', () => {
  const calls = []
  const proc = (uid) => ({ getuid: () => uid, setgroups: (g) => calls.push(['groups', g]), setgid: (g) => calls.push(['gid', g]), setuid: (u) => calls.push(['uid', u]) })
  assert.equal(dropRoot('/nope', { env: {}, proc: proc(501) }), 'root 아님')
  assert.equal(dropRoot('/nope', { env: { BRIDGE_RUN_AS_ROOT: '1' }, proc: proc(0) }), 'BRIDGE_RUN_AS_ROOT=1 이라 root 로 둠')
  assert.deepEqual(calls, [])
  // A folder that does not exist has nothing to hand over: root is dropped.
  assert.match(dropRoot(path.join(os.tmpdir(), 'cb-none-xyz'), { env: {}, proc: proc(0) }), /node\(1000\)/)
  assert.deepEqual(calls, [['groups', [1000]], ['gid', 1000], ['uid', 1000]])
})

// R1-L6 (리포트 #4 남은 것): files made before 1.159 kept 0644.
test('existing data files become 0600 and folders 0700, links are left alone', async () => {
  const { tightenTree } = await import('../../server/drop-root.mjs')
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-perm-'))
  fs.mkdirSync(path.join(d, 'u/a'), { recursive: true, mode: 0o755 })
  fs.writeFileSync(path.join(d, 'u/a/events.jsonl'), '{}\n', { mode: 0o644 })
  fs.symlinkSync('/etc/hosts', path.join(d, 'u/link'))
  assert.ok(tightenTree(d) >= 3)
  assert.equal(fs.statSync(path.join(d, 'u/a/events.jsonl')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(d, 'u/a')).mode & 0o777, 0o700)
  assert.equal(fs.lstatSync(path.join(d, 'u/link')).isSymbolicLink(), true)
  assert.notEqual(fs.statSync('/etc/hosts').mode & 0o777, 0o600, '링크가 가리키는 파일은 그대로')
  assert.equal(tightenTree(d), 0)
  fs.rmSync(d, { recursive: true, force: true })
})
