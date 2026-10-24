// A Linux host (REQ-F-798): the systemd unit the agent writes, zeropty where there is no build for the system, and the
// sign-in address for a host with no browser of its own, which only a headless browser can use.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { systemdUnit, siteLogin } from '../../agent/guard.mjs'
import { ZEROPTY_RELEASES, zeroptyFor, zeroptyPaths, zeroptyInstalled, installZeropty } from '../../agent/mux.mjs'
import { startServer } from './server-harness.mjs'

const unit = (o = {}) => systemdUnit({ node: '/home/u/.claude-bridge/node/bin/node', self: '/home/u/.claude-bridge/agent.mjs', home: '/home/u', log: '/home/u/.claude-bridge/service.log', env: { PATH: '/usr/bin:/bin', HOME: '/home/u' }, ...o })

test('systemd 유닛: 다시 띄우기는 늘, 재시작해도 에이전트만 끝나고 터미널·브라우저는 남는다', () => {
  const u = unit()
  assert.match(u, /^ExecStart="\/home\/u\/\.claude-bridge\/node\/bin\/node" "\/home\/u\/\.claude-bridge\/agent\.mjs" --service$/m)
  assert.match(u, /^Restart=always$/m)
  assert.match(u, /^KillMode=process$/m)
  assert.match(u, /^Environment="PATH=\/usr\/bin:\/bin"$/m)
  assert.match(u, /^StandardOutput=append:\/home\/u\/\.claude-bridge\/service\.log$/m)
  assert.match(u, /^WantedBy=default\.target$/m)
})

test('systemd 유닛: %·$·따옴표는 systemd 가 읽는 대로 막고, 줄바꿈과 이상한 변수 이름은 쓰지 않는다', () => {
  const u = unit({ node: '/opt/a "b"/$X/100%/node', env: { PATH: '/p%h:/q"r', LANG: 'en_US.UTF-8' } })
  assert.match(u, /^ExecStart="\/opt\/a \\"b\\"\/\$\$X\/100%%\/node" /m)
  assert.match(u, /^Environment="PATH=\/p%%h:\/q\\"r"$/m)
  assert.throws(() => unit({ env: { PATH: '/a\nExecStartPre=/bin/evil' } }), /줄바꿈/)
  assert.throws(() => unit({ home: '/home/u\n[Service]' }), /줄바꿈/)
  assert.throws(() => unit({ env: { 'A B': 'x' } }), /환경 변수 이름/)
})

test('zeropty: macOS 와 Linux x86_64 판이 있고, 판이 없는 시스템은 받지도 설치됐다고 하지도 않는다', async () => {
  assert.equal(zeroptyFor('darwin', 'arm64'), ZEROPTY_RELEASES.darwin)
  assert.equal(zeroptyFor('darwin', 'x64'), ZEROPTY_RELEASES.darwin)
  assert.equal(zeroptyFor('linux', 'x64'), ZEROPTY_RELEASES['linux-x64'])
  assert.equal(ZEROPTY_RELEASES['linux-x64'].shim, 'shim.so')
  assert.equal(zeroptyFor('linux', 'arm64'), null)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-none-'))
  assert.equal(zeroptyInstalled(zeroptyPaths(dir, null)), false)
  let fetched = 0
  const r = await installZeropty(dir, { z: null, fetch: async () => (fetched++, new Response('')) })
  assert.equal(r.ok, false)
  assert.equal(r.unsupported, true)
  assert.equal(fetched, 0)
  assert.deepEqual(fs.readdirSync(dir), [])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('zeropty: 판마다 정한 shim 파일(shim.so)을 보고 설치한다', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-so-'))
  const top = 'zp-test-linux-x86_64'
  fs.mkdirSync(path.join(src, top))
  fs.writeFileSync(path.join(src, top, 'zeropty'), '#!/bin/sh\necho "zeropty 9.9.9"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(src, top, 'zeropty-tty'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(src, top, 'shim.so'), 'not really a library')
  execFileSync('/usr/bin/tar', ['-czf', path.join(src, 'r.tgz'), '-C', src, top])
  const buf = fs.readFileSync(path.join(src, 'r.tgz'))
  const z = { version: '9.9.9', sha256: crypto.createHash('sha256').update(buf).digest('hex'), url: 'https://example.test/z.tgz', top, shim: 'shim.so' }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-state-'))
  assert.deepEqual(await installZeropty(dir, { z, fetch: async () => new Response(buf) }), { ok: true })
  const p = zeroptyPaths(dir, z)
  assert.equal(p.shim, path.join(dir, 'zeropty', '9.9.9', 'shim.so'))
  assert.equal(zeroptyInstalled(p), true)
  // The same archive read as a macOS one (shim.dylib) is not an install.
  assert.equal(zeroptyInstalled(zeroptyPaths(dir, { ...z, shim: 'shim.dylib' })), false)
  for (const d of [src, dir]) fs.rmSync(d, { recursive: true, force: true })
})

test('headless 명령: 이 사이트의 QR 로그인 주소만 받는다', () => {
  assert.equal(siteLogin('https://b.test/api/auth/qr/abc', 'https://b.test'), 'https://b.test/api/auth/qr/abc')
  assert.equal(siteLogin('https://evil.test/api/auth/qr/abc', 'https://b.test'), null)
  assert.equal(siteLogin('https://b.test/api/auth/github', 'https://b.test'), null)
})

test('서버용 로그인 주소: 보통 브라우저는 안내만 보고(코드는 남음), 헤드리스 브라우저만 로그인해 /bridge 로 간다', async () => {
  const srv = await startServer()
  try {
    await srv.login('alice')
    const made = await srv.api('alice', '/api/qr', { method: 'POST', body: { headless: true } })
    assert.equal(made.status, 200)
    const code = new URL(made.json.url).pathname
    const desktop = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
    const looked = await fetch(`${srv.origin}${code}`, { redirect: 'manual', headers: { 'user-agent': desktop } })
    assert.equal(looked.status, 200)
    assert.match(await looked.text(), /서버에 붙여 넣는 주소예요/)
    assert.equal(looked.headers.getSetCookie().length, 0, '보통 브라우저는 로그인되지 않음')
    // A form post from an ordinary browser does not get past it either.
    const posted = await fetch(`${srv.origin}${code}`, { method: 'POST', redirect: 'manual', headers: { 'user-agent': desktop, origin: srv.origin } })
    assert.equal(posted.headers.getSetCookie().length, 0)
    const headless = await fetch(`${srv.origin}${code}`, { redirect: 'manual', headers: { 'user-agent': desktop.replace('Chrome/', 'HeadlessChrome/') } })
    assert.equal(headless.status, 302)
    assert.equal(new URL(headless.headers.get('location'), srv.origin).pathname, '/bridge')
    assert.ok(headless.headers.getSetCookie().length > 0, '헤드리스 브라우저는 로그인됨')
    const again = await fetch(`${srv.origin}${code}`, { redirect: 'manual', headers: { 'user-agent': 'HeadlessChrome/155' } })
    assert.equal(again.status, 410, '한 번만')
    // The phone QR code is as before: it asks first.
    const qr = await srv.api('alice', '/api/qr', { method: 'POST', body: {} })
    const ask = await fetch(qr.json.url.replace(/^https?:\/\/[^/]+/, srv.origin), { redirect: 'manual', headers: { 'user-agent': 'HeadlessChrome/155' } })
    assert.equal(ask.status, 200)
    assert.doesNotMatch(await ask.text(), /서버에 붙여 넣는/)
  } finally {
    await srv.stop()
  }
})
