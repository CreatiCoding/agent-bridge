// The terminal program a session runs in (REQ-F-794): zeropty fetched at a fixed hash, or tmux.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { ZEROPTY, zeroptyPaths, zeroptyInstalled, installZeropty, muxOf, pickMux, needsZeropty, muxEnv, targetName } from '../../agent/mux.mjs'

/** A release-shaped archive: <top>/zeropty, zeropty-tty, shim.dylib. */
function fakeRelease(top = 'zp-test-darwin-universal') {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-src-'))
  fs.mkdirSync(path.join(src, top))
  fs.writeFileSync(path.join(src, top, 'zeropty'), '#!/bin/sh\necho "zeropty 9.9.9"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(src, top, 'zeropty-tty'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(src, top, 'shim.dylib'), 'not really a dylib')
  const tgz = path.join(src, 'r.tar.gz')
  execFileSync('/usr/bin/tar', ['-czf', tgz, '-C', src, top])
  const buf = fs.readFileSync(tgz)
  fs.rmSync(src, { recursive: true, force: true })
  return { buf, sha256: crypto.createHash('sha256').update(buf).digest('hex'), top }
}
const fetchOf = (buf, status = 200) => async () => new Response(buf, { status })
const stateDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-state-'))

test('ZEROPTY: 고정 버전과 64자리 SHA-256, 주소는 그 버전의 GitHub 릴리스', () => {
  assert.equal(ZEROPTY.version, '0.1.3')
  assert.match(ZEROPTY.sha256, /^[0-9a-f]{64}$/)
  assert.equal(ZEROPTY.url, `https://github.com/CreatiCoding/zeropty/releases/download/v${ZEROPTY.version}/${ZEROPTY.top}.tar.gz`)
  assert.ok(Object.isFrozen(ZEROPTY))
})

test('installZeropty: 해시가 맞으면 <state>/zeropty/<버전>/ 에 풀고, 다음엔 받지 않는다', async () => {
  const r = fakeRelease()
  const z = { version: '9.9.9', sha256: r.sha256, url: 'https://example.test/z.tgz', top: r.top }
  const dir = stateDir()
  const p = zeroptyPaths(dir, z)
  assert.equal(zeroptyInstalled(p), false)
  assert.deepEqual(await installZeropty(dir, { fetch: fetchOf(r.buf), z }), { ok: true })
  assert.equal(p.dir, path.join(dir, 'zeropty', '9.9.9'))
  assert.equal(zeroptyInstalled(p), true)
  assert.equal(execFileSync(p.bin, ['-V'], { encoding: 'utf8' }).trim(), 'zeropty 9.9.9')
  let fetched = 0
  assert.deepEqual(await installZeropty(dir, { fetch: async () => (fetched++, new Response('')), z }), { ok: true, already: true })
  assert.equal(fetched, 0)
  // Nothing half-made is left beside it.
  assert.deepEqual(fs.readdirSync(path.join(dir, 'zeropty')), ['9.9.9'])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('installZeropty: 해시가 다르면 아무것도 설치하지 않는다', async () => {
  const r = fakeRelease()
  const z = { version: '9.9.9', sha256: 'a'.repeat(64), url: 'https://example.test/z.tgz', top: r.top }
  const dir = stateDir()
  const out = await installZeropty(dir, { fetch: fetchOf(r.buf), z })
  assert.equal(out.ok, false)
  assert.match(out.error, /SHA-256 이 맞지 않음/)
  assert.equal(zeroptyInstalled(zeroptyPaths(dir, z)), false)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'zeropty')), [])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('installZeropty: 받기 실패·묶음에 파일이 없으면 설치하지 않는다', async () => {
  const r = fakeRelease()
  const dir = stateDir()
  const z = { version: '9.9.9', sha256: r.sha256, url: 'https://example.test/z.tgz', top: r.top }
  assert.match((await installZeropty(dir, { fetch: fetchOf('nope', 404), z })).error, /HTTP 404/)
  // Right hash, but the archive's top folder is not the one expected.
  assert.equal((await installZeropty(dir, { fetch: fetchOf(r.buf), z: { ...z, top: 'other' } })).ok, false)
  assert.equal(zeroptyInstalled(zeroptyPaths(dir, z)), false)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'zeropty')), [])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('muxOf: 기록이 없는 세션(zeropty 전에 열린 것)은 tmux', () => {
  assert.equal(muxOf({ tmux: 'cb-1234-abcdabcd' }), 'tmux')
  assert.equal(muxOf({ mux: 'tmux' }), 'tmux')
  assert.equal(muxOf({ mux: 'zeropty' }), 'zeropty')
  assert.equal(muxOf(undefined), 'tmux')
})

test('pickMux: 새 세션은 zeropty 가 준비됐을 때 zeropty, tmux 로 고정했거나 없으면 tmux', () => {
  assert.equal(pickMux({ ready: true }), 'zeropty')
  assert.equal(pickMux({ ready: false }), 'tmux')
  assert.equal(pickMux({ ready: true, force: 'tmux' }), 'tmux')
  assert.equal(pickMux({ ready: false, force: 'tmux' }), 'tmux')
})

test('needsZeropty: tmux 로 고정한 기기는 zeropty 세션이 남아 있을 때만 받는다 (AC-1472)', () => {
  assert.equal(needsZeropty({ sessions: [] }), true)
  assert.equal(needsZeropty({ force: 'tmux', sessions: [] }), false)
  assert.equal(needsZeropty({ force: 'tmux', sessions: [{}, { mux: 'tmux' }] }), false)
  assert.equal(needsZeropty({ force: 'tmux', sessions: [{}, { mux: 'zeropty' }] }), true)
  assert.equal(needsZeropty({ force: 'tmux', sessions: new Map([['a', { mux: 'zeropty' }]]).values() }), true)
})

test('muxEnv: tmux·Claude Code 가 물려주는 변수는 zeropty 서버에 넘기지 않는다', () => {
  const env = muxEnv({ PATH: '/bin', HOME: '/h', TMUX: '/tmp/x,1,0', TMUX_PANE: '%1', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CONFIG_DIR: '/c', ZEROPTY_SOCK: '/s' })
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/c', ZEROPTY_SOCK: '/s' })
})

test('targetName: -t 대상과 new-session -s 이름', () => {
  assert.equal(targetName(['send-keys', '-t', '=cb-1-abc:', 'Enter']), 'cb-1-abc')
  assert.equal(targetName(['has-session', '-t', '=cb-1-abc']), 'cb-1-abc')
  assert.equal(targetName(['new-session', '-d', '-s', 'cb-1-abc', '-x', '220']), 'cb-1-abc')
  assert.equal(targetName(['display-message', '-p', '-t', '=cb-1-abc:', '#{pane_pid}']), 'cb-1-abc')
  assert.equal(targetName(['load-buffer', '-b', 'cb-x', '/f']), '')
})
