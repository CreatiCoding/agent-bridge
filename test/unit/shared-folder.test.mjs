// 공유 디스크 (REQ-F-883, AC-1664): the shared folder must already be on this Mac, and the new folder under it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sharedRootCheck, sharedMake, sharedInside } from '../../agent/guard.mjs'

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-shared-')))
const expandHome = (p) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p)

test('AC-1664: a shared folder that is here passes, one not mounted is refused, never made', () => {
  fs.mkdirSync(path.join(home, 'disk/bridge'), { recursive: true })
  assert.doesNotThrow(() => sharedRootCheck('~/disk/bridge', '~/disk/bridge/기타/1108-a3f9c2', expandHome))
  assert.doesNotThrow(() => sharedRootCheck('~/disk/bridge/', '~/disk/bridge', expandHome))
  assert.throws(() => sharedRootCheck('~/gone/bridge', '~/gone/bridge/기타/1108-a3f9c2', expandHome), /공유 폴더가 이 맥에 없어요/)
  assert.equal(fs.existsSync(path.join(home, 'gone')), false)
  fs.writeFileSync(path.join(home, 'file'), '')
  assert.throws(() => sharedRootCheck('~/file', '~/file/x', expandHome), /공유 폴더가 이 맥에 없어요/)
})

test('AC-1664: the folder must be under the shared folder', () => {
  fs.mkdirSync(path.join(home, 'disk/bridge'), { recursive: true })
  assert.throws(() => sharedRootCheck('~/disk/bridge', '~/elsewhere/x', expandHome), /공유 폴더 밖/)
  assert.throws(() => sharedRootCheck('~/disk/bridge', '~/disk/bridge-other/x', expandHome), /공유 폴더 밖/)
  assert.throws(() => sharedRootCheck('~/disk/bridge', '~/disk/bridge/../escape', expandHome), /공유 폴더 밖/)
  assert.throws(() => sharedRootCheck('relative', 'relative/x', expandHome), /\/ 또는 ~/)
})

// 1.476: compared by real paths, so a link on the way cannot take the new folder outside the shared folder.
test('AC-1673: a link under the shared folder that leads outside is refused before anything is made', () => {
  fs.mkdirSync(path.join(home, 'disk2/shared'), { recursive: true })
  fs.mkdirSync(path.join(home, 'disk2/outside'), { recursive: true })
  fs.symlinkSync(path.join(home, 'disk2/outside'), path.join(home, 'disk2/shared/group'))
  assert.throws(() => sharedRootCheck('~/disk2/shared', '~/disk2/shared/group/new-session', expandHome), /공유 폴더 밖/)
  assert.equal(fs.existsSync(path.join(home, 'disk2/outside/new-session')), false)
  // A folder that is already there and is a link outside: refused too.
  fs.symlinkSync(path.join(home, 'disk2/outside'), path.join(home, 'disk2/shared/old'))
  assert.throws(() => sharedRootCheck('~/disk2/shared', '~/disk2/shared/old', expandHome), /공유 폴더 밖/)
  // A link to nothing on the way is refused (making through it would land where it points).
  fs.symlinkSync(path.join(home, 'disk2/nowhere'), path.join(home, 'disk2/shared/dangling'))
  assert.throws(() => sharedRootCheck('~/disk2/shared', '~/disk2/shared/dangling/x', expandHome), /링크/)
})

test('AC-1673: a link inside, and a shared folder that is itself a link, pass; the real root comes back', () => {
  fs.mkdirSync(path.join(home, 'disk3/real/a'), { recursive: true })
  fs.symlinkSync(path.join(home, 'disk3/real'), path.join(home, 'disk3/mount'))
  fs.symlinkSync(path.join(home, 'disk3/real/a'), path.join(home, 'disk3/real/b'))
  const real = sharedRootCheck('~/disk3/mount', '~/disk3/mount/b/new', expandHome)
  assert.equal(real, fs.realpathSync.native(path.join(home, 'disk3/real')))
  sharedMake(real, path.join(home, 'disk3/mount/b/new/deep'))
  assert.equal(fs.statSync(path.join(home, 'disk3/real/a/new/deep')).isDirectory(), true)
  assert.equal(sharedInside(real, path.join(home, 'disk3/mount/b/new')), path.join(real, 'a/new'))
})

test('AC-1673: a folder swapped for a link after the check is caught while making and before the start', () => {
  fs.mkdirSync(path.join(home, 'disk4/shared/group'), { recursive: true })
  fs.mkdirSync(path.join(home, 'disk4/outside'), { recursive: true })
  const real = sharedRootCheck('~/disk4/shared', '~/disk4/shared/group/s1', expandHome)
  fs.rmdirSync(path.join(home, 'disk4/shared/group'))
  fs.symlinkSync(path.join(home, 'disk4/outside'), path.join(home, 'disk4/shared/group'))
  assert.throws(() => sharedMake(real, path.join(home, 'disk4/shared/group/s1')), /공유 폴더 밖/)
  assert.equal(fs.existsSync(path.join(home, 'disk4/outside/s1')), false)
  assert.throws(() => sharedInside(real, path.join(home, 'disk4/shared/group')), /공유 폴더 밖/)
})
