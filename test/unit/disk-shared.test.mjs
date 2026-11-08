// REQ-F-888 공유 디스크 보기: the shared disk's line in the disk info, read by a child process (SHARED_PROBE_SCRIPT),
// and how a network mount is told from a local one on Linux (statfs type) and macOS (mount).
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SHARED_PROBE_SCRIPT, sharedDiskOf, fsTypeKind, macMountKind } from '../../agent/guard.mjs'

const probe = (p) => JSON.parse(execFileSync(process.execPath, ['-e', SHARED_PROBE_SCRIPT, p, os.homedir()], { encoding: 'utf8' }))

test('no shared path set: no shared line', () => {
  assert.equal(sharedDiskOf(undefined, null), null)
  assert.equal(sharedDiskOf('', { dir: true }), null)
})

test('a path that is not there is not connected, not an error', () => {
  const where = path.join(os.tmpdir(), `cb-shared-missing-${process.pid}`, 'works')
  const s = sharedDiskOf(where, probe(where))
  assert.deepEqual(s, { path: where, mounted: false, disk: null, kind: null, sameAsHome: false, why: '경로가 없어요' })
})

test('a file is not a folder: not connected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-shared-'))
  const f = path.join(dir, 'f')
  fs.writeFileSync(f, 'x')
  const s = sharedDiskOf(f, probe(f))
  assert.equal(s.mounted, false)
  assert.equal(s.why, '폴더가 아니에요')
  fs.rmSync(dir, { recursive: true })
})

test('no answer in time: not connected', () => {
  assert.deepEqual(sharedDiskOf('/mnt/m3', null), { path: '/mnt/m3', mounted: false, disk: null, kind: null, sameAsHome: false, why: '응답이 없어요(시간 초과)' })
})

test('a folder that is there: connected, with its disk like diskUse', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-shared-'))
  const p = probe(dir)
  const s = sharedDiskOf(dir, p, 'local')
  assert.equal(s.mounted, true)
  assert.equal(s.kind, 'local')
  const st = fs.statfsSync(dir)
  assert.equal(s.disk.total, st.blocks * st.bsize)
  assert.ok(s.disk.avail > 0 && s.disk.used >= 0 && s.disk.pct >= 0 && s.disk.pct <= 100)
  assert.equal(s.sameAsHome, fs.statSync(dir).dev === fs.statSync(os.homedir()).dev)
  fs.rmSync(dir, { recursive: true })
})

test('the same device as the home folder is said so', () => {
  const st = { type: 0xef53, bsize: 4096, blocks: 1000, bfree: 400, bavail: 300 }
  assert.equal(sharedDiskOf('/srv/x', { dir: true, dev: 7, homeDev: 7, st }, 'local').sameAsHome, true)
  assert.equal(sharedDiskOf('/srv/x', { dir: true, dev: 8, homeDev: 7, st }, 'local').sameAsHome, false)
  assert.equal(sharedDiskOf('/srv/x', { dir: true, dev: 8, homeDev: 7, st }, 'odd').kind, null)
})

test('Linux statfs type: CIFS, SMB2, NFS are network; ext4, btrfs local; fuse unknown', () => {
  assert.equal(fsTypeKind(0xff534d42), 'network')
  assert.equal(fsTypeKind(0xfe534d42), 'network')
  assert.equal(fsTypeKind(0x6969), 'network')
  assert.equal(fsTypeKind(-11317950), 'network') // 0xFF534D42 read as a signed 32-bit number
  assert.equal(fsTypeKind(0xef53), 'local')
  assert.equal(fsTypeKind(0x9123683e), 'local')
  assert.equal(fsTypeKind(0x65735546), null)
  assert.equal(fsTypeKind(undefined), null)
  assert.equal(fsTypeKind(1.5), null)
})

test('macOS mount: the longest mount point that holds the path decides', () => {
  const out = [
    '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
    '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)',
    '/dev/disk5s1 on /Volumes/M3 (apfs, local, nodev, nosuid, journaled, noowners)',
    '//creco@macmini._smb._tcp.local/works on /Volumes/works (smbfs, nodev, nosuid, mounted by creco)',
    'nas:/export on /Volumes/My NAS (nfs, nodev, nosuid)',
    'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)',
  ].join('\n')
  assert.equal(macMountKind(out, '/Volumes/M3/bridge/works'), 'local')
  assert.equal(macMountKind(out, '/Volumes/M3x/a'), 'local') // under / only
  assert.equal(macMountKind(out, '/Volumes/works/bridge'), 'network')
  assert.equal(macMountKind(out, '/Volumes/My NAS/a'), 'network')
  assert.equal(macMountKind(out, '/System/Volumes/Data/home/x'), null)
  assert.equal(macMountKind('', '/Volumes/M3'), null)
  assert.equal(macMountKind(out, 'relative'), null)
})

test('new session: the shared-disk switch is on unless turned off on this device (REQ-F-883, 1.484)', () => {
  const src = fs.readFileSync(new URL('../../ui/src/pages/new-session.tsx', import.meta.url), 'utf8')
  assert.match(src, /getPref<boolean>\('newShared', true\) !== false/)
  assert.match(src, /setPref\('newShared', on\)/)
  assert.match(src, /const useShared = auto && onShared && !!sharedBase/)
})
