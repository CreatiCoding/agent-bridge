// The terminal program a session runs in (REQ-F-794): zeropty fetched at a fixed hash, or tmux.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { ZEROPTY, ZEROPTY_RELEASES, zeroptyFor, zeroptyPaths, zeroptyInstalled, installZeropty, muxOf, pickMux, needsZeropty, muxEnv, targetName, zeroptySock, legacyZeroptySock, sockOf, zeroptyEnv, SOCK_MAX } from '../../agent/mux.mjs'

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

test('ZEROPTY: 시스템마다 고정 버전과 64자리 SHA-256, 주소는 그 버전의 GitHub 릴리스', () => {
  // 시험이 도는 시스템(macOS 맥, Linux CI)과 상관없이 표 전체를 본다.
  assert.equal(ZEROPTY_RELEASES.darwin.version, '0.1.3')
  assert.equal(ZEROPTY_RELEASES['linux-x64'].version, '0.1.6')
  for (const z of Object.values(ZEROPTY_RELEASES)) {
    assert.match(z.sha256, /^[0-9a-f]{64}$/)
    assert.equal(z.url, `https://github.com/CreatiCoding/zeropty/releases/download/v${z.version}/${z.top}.tar.gz`)
    assert.ok(Object.isFrozen(z))
  }
  assert.equal(zeroptyFor('darwin', 'arm64'), ZEROPTY_RELEASES.darwin)
  assert.equal(zeroptyFor('linux', 'x64'), ZEROPTY_RELEASES['linux-x64'])
  assert.equal(zeroptyFor('linux', 'arm64'), null)
  assert.equal(ZEROPTY, zeroptyFor(process.platform, process.arch))
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
  // ZEROPTY_SOCK too (REQ-F-841): each command names its own socket with zeroptyEnv.
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/c' })
})

test('targetName: -t 대상과 new-session -s 이름', () => {
  assert.equal(targetName(['send-keys', '-t', '=cb-1-abc:', 'Enter']), 'cb-1-abc')
  assert.equal(targetName(['has-session', '-t', '=cb-1-abc']), 'cb-1-abc')
  assert.equal(targetName(['new-session', '-d', '-s', 'cb-1-abc', '-x', '220']), 'cb-1-abc')
  assert.equal(targetName(['display-message', '-p', '-t', '=cb-1-abc:', '#{pane_pid}']), 'cb-1-abc')
  assert.equal(targetName(['load-buffer', '-b', 'cb-x', '/f']), '')
})

// ---------- the bridge's own socket (REQ-F-841) ----------

test('zeroptySock (AC-1520): <state>/zeropty/bridge.sock, under /tmp when too long for a socket', () => {
  assert.equal(zeroptySock('/Users/a/.claude-bridge', { platform: 'darwin', uid: 501 }), '/Users/a/.claude-bridge/zeropty/bridge.sock')
  const tail = '/zeropty/bridge.sock'
  for (const [platform, max] of [['darwin', 103], ['linux', 107]]) {
    assert.equal(SOCK_MAX[platform], max)
    const at = '/' + 'x'.repeat(max - tail.length - 1)
    assert.equal(Buffer.byteLength(at + tail), max)
    assert.equal(zeroptySock(at, { platform, uid: 501 }), at + tail, `${platform}: 정확히 ${max} 바이트`)
    assert.equal(zeroptySock(at + 'y', { platform, uid: 501 }), '/tmp/cb-zeropty-501/bridge.sock', `${platform}: ${max + 1} 바이트`)
  }
  // Korean folder names count in bytes, not characters.
  const ko = '/Users/a/' + '가'.repeat(30)
  assert.ok(Buffer.byteLength(ko + tail) > 103)
  assert.equal(zeroptySock(ko, { platform: 'darwin', uid: 7 }), '/tmp/cb-zeropty-7/bridge.sock')
})

test('legacyZeroptySock·sockOf·zeroptyEnv (AC-1520): old sessions stay on the old socket, every command names one', () => {
  assert.equal(legacyZeroptySock({}, '/Users/a'), '/Users/a/.zeropty/mux.sock')
  assert.equal(legacyZeroptySock({ ZEROPTY_SOCK: '/t/s.sock' }, '/Users/a'), '/t/s.sock')
  assert.equal(sockOf({ mux: 'zeropty' }, '/old.sock'), '/old.sock', 'zsock 없는 세션은 옛 소켓')
  assert.equal(sockOf({ mux: 'zeropty', zsock: '/new.sock' }, '/old.sock'), '/new.sock')
  assert.equal(sockOf({ mux: 'zeropty', zsock: '' }, '/old.sock'), '/old.sock')
  assert.deepEqual(zeroptyEnv({ A: '1', ZEROPTY_SOCK: '/x' }, '/new.sock'), { A: '1', ZEROPTY_SOCK: '/new.sock' })
  assert.equal(muxEnv({ ZEROPTY_SOCK: '/x', PATH: '/bin' }).ZEROPTY_SOCK, undefined)
})

test('agent (AC-1521): zeropty only through muxProgram with its socket; sessions never get ZEROPTY_SOCK', () => {
  const src = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  // Every place the zeropty binary is run: muxProgram (muxAt, tmux, tmuxRaw go through it) and its version.
  const uses = src.split('\n').filter((l) => /ZP\.bin/.test(l))
  assert.equal(uses.length, 2, uses.join('\n'))
  assert.match(uses[0], /muxProgram = .*zeroptyEnv\(ZP_ENV, zeroptyNames\.get\(name\)\)/)
  assert.match(uses[1], /run\(ZP\.bin, \['-V'\]\)/)
  assert.equal((src.match(/execFile\(m\.bin/g) ?? []).length, 2, 'muxAt 과 tmuxRaw 만')
  assert.match(src, /const clean = 'unset ZEROPTY_SOCK /)
  assert.match(src, /`unset CLAUDECODE ZEROPTY_SOCK; \$\{ttyPrefix\(mux\)\}\$\{shq\(CLAUDE_BIN\)\} auth login/)
  assert.match(src, /s\.mux === 'zeropty' && s\.zsock \? \{ zsock: s\.zsock \}/)
  assert.match(src, /zeroptyNames\.set\(s\.tmux, sockOf\(s, ZP_LEGACY\)\)/)
  assert.match(src, /if \(s\.mux === 'zeropty'\) s\.zsock = ZP_SOCK/)
  assert.doesNotMatch(src, /kill-server/, '에이전트는 어떤 zeropty 서버도 끄지 않는다')
})

// A real zeropty, in an empty HOME: nothing of the person's is touched.
const realZp = (() => {
  if (!ZEROPTY) return null
  const bin = path.join(os.homedir(), '.claude-bridge', 'zeropty', ZEROPTY.version, 'zeropty')
  try {
    fs.accessSync(bin, fs.constants.X_OK)
    return bin
  } catch {
    return null
  }
})()

test('kill-server without a socket (AC-1522): does not reach the bridge socket, did reach the default one', { skip: realZp ? false : 'zeropty 가 받아져 있지 않음' }, () => {
  const home = fs.mkdtempSync(path.join('/tmp', 'zpk-'))
  const own = path.join(home, 'b', 'bridge.sock')
  fs.mkdirSync(path.dirname(own), { mode: 0o700 })
  const base = { PATH: process.env.PATH, HOME: home, TMPDIR: home }
  const zp = (env, ...argv) => {
    try {
      execFileSync(realZp, argv, { env, stdio: 'ignore', timeout: 20_000 })
      return true
    } catch {
      return false
    }
  }
  const ownEnv = { ...base, ZEROPTY_SOCK: own }
  try {
    assert.ok(zp(ownEnv, 'new-session', '-d', '-s', 'bridge', 'sleep 120'))
    assert.ok(zp(base, 'new-session', '-d', '-s', 'other', 'sleep 120'), '기본 소켓에도 세션')
    zp(base, 'kill-server')
    assert.ok(zp(ownEnv, 'has-session', '-t', '=bridge'), '전용 소켓의 세션은 살아 있다')
    assert.ok(!zp(base, 'has-session', '-t', '=other'), '기본 소켓의 세션은 끝났다')
  } finally {
    zp(ownEnv, 'kill-server')
    zp(base, 'kill-server')
    fs.rmSync(home, { recursive: true, force: true })
  }
})
