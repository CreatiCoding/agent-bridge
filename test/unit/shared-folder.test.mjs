// 공유 디스크 (REQ-F-883, AC-1664): the shared folder must already be on this Mac, and the new folder under it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sharedRootCheck } from '../../agent/guard.mjs'

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
