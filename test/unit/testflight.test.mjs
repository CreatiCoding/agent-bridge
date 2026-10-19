// TestFlight 자동 올리기 (REQ-F-762): the script parses, and the build number it sets reaches the app.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = new URL('../../', import.meta.url)

test('scripts/testflight.sh: bash 문법, 빌드 번호는 CURRENT_PROJECT_VERSION 으로 앱에 들어간다 (1.204)', () => {
  execFileSync('bash', ['-n', new URL('scripts/testflight.sh', root).pathname])
  const plist = readFileSync(new URL('ios/Bridge/Info.plist', root), 'utf8')
  assert.match(plist, /<key>CFBundleVersion<\/key>\s*<string>\$\(CURRENT_PROJECT_VERSION\)<\/string>/)
  // App Store Connect rejects a display or bundle name another app already uses (ITMS-90129, 1.210).
  assert.match(plist, /<key>CFBundleDisplayName<\/key>\s*<string>Agent Bridge<\/string>/)
  assert.match(plist, /<key>CFBundleName<\/key>\s*<string>Agent Bridge<\/string>/)
  const sh = readFileSync(new URL('scripts/testflight.sh', root), 'utf8')
  assert.match(sh, /CURRENT_PROJECT_VERSION="\$build"/)
  assert.match(sh, /^main "\$@"$/m)
  assert.match(sh, /DEVELOPER_DIR=\/Applications\/Xcode\.app\/Contents\/Developer/)
})

test('scripts/testflight.sh: 끝나면 lock 을 지우고, 주인 없는 lock 은 이어받는다 (1.205)', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'tf-'))
  const dir = path.join(home, '.claude-bridge', 'testflight')
  // A clone with a change in it stops right after taking the lock, so no git or xcodebuild runs.
  const repo = path.join(home, 'repo')
  mkdirSync(path.join(repo, 'scripts'), { recursive: true })
  copyFileSync(new URL('scripts/testflight.sh', root), path.join(repo, 'scripts', 'testflight.sh'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  writeFileSync(path.join(repo, 'dirty'), 'x')
  // A lock left by a run that is gone.
  mkdirSync(path.join(dir, 'lock'), { recursive: true })
  const run = () => spawnSync('bash', [path.join(repo, 'scripts', 'testflight.sh')], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
  const r = run()
  assert.equal(r.status, 1)
  assert.match(r.stderr, /고친 파일이 있어 멈춰요/)
  assert.equal(existsSync(path.join(dir, 'lock')), false)
  assert.match(readFileSync(path.join(dir, 'log'), 'utf8'), /남은 lock 을 이어받아요 \(pid 없음\)/)
  // A lock whose run is alive is left alone.
  mkdirSync(path.join(dir, 'lock'))
  writeFileSync(path.join(dir, 'lock', 'pid'), String(process.pid))
  assert.match(run().stdout, /이미 돌고 있어요/)
  assert.equal(existsSync(path.join(dir, 'lock', 'pid')), true)
})

// 1.293: squashing the history made the commit count 1, and App Store Connect refuses a lower build number.
test('scripts/testflight.sh: 빌드 번호는 커밋 수가 아니라 2026 년부터 지난 분, 지난번보다 늘 크다 (1.293)', () => {
  const sh = readFileSync(new URL('scripts/testflight.sh', root), 'utf8')
  assert.doesNotMatch(sh, /rev-list --count/)
  assert.match(sh, /echo "\$build" > "\$dir\/build"/)
  const calc = sh.slice(sh.indexOf('  local build out prev'), sh.indexOf('fi', sh.indexOf('build=$((prev + 1))')) + 2)
  const run = (dir) => Number(execFileSync('bash', ['-c', `dir='${dir}'\n${calc.replace('local ', '')}\necho "$build"`], { encoding: 'utf8' }).trim())
  const now = Math.floor((Date.now() / 1000 - 1767225600) / 60)
  const empty = mkdtempSync(path.join(tmpdir(), 'cb-tf-'))
  assert.ok(Math.abs(run(empty) - now) <= 1)
  const old = mkdtempSync(path.join(tmpdir(), 'cb-tf-'))
  writeFileSync(path.join(old, 'result'), '2026-10-18 21:00:00 올림 abc1234 build 383\n')
  assert.ok(run(old) > 383)
  const ahead = mkdtempSync(path.join(tmpdir(), 'cb-tf-'))
  writeFileSync(path.join(ahead, 'build'), '9000000\n')
  assert.equal(run(ahead), 9000001)
  writeFileSync(path.join(ahead, 'result'), '2026-10-18 21:00:00 올림 abc1234 build 9500000\n')
  assert.equal(run(ahead), 9000001, 'build 파일이 있으면 그것을 본다')
  assert.ok(run(empty) < 1e7, '서버의 앱 빌드 한도(REQ-F-781) 아래')
})
