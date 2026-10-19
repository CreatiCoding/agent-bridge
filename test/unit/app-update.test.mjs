// 앱 업데이트 안내 (REQ-F-781): the operator's Mac tells the newest TestFlight build, the app's page asks to update.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { startServer } from './server-harness.mjs'
import { mac } from './fake-mac.mjs'
import { APP_UPDATE_SNOOZE_MS, APP_UPDATE_WAIT_MS, appVersion, TESTFLIGHT_URL, updateDue } from '../../ui/src/lib/app-version.ts'

const root = new URL('../../', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')

test('에이전트: testflight result 의 올림 줄만 읽는다(실패 줄은 무시) (1.263)', () => {
  const src = read('agent/agent.mjs')
  const body = src.match(/function testflightUpload\(text\) \{\n([\s\S]*?)\n\}/)[1]
  const parse = new Function('text', body)
  const at = new Date(2026, 9, 18, 17, 5, 9).getTime()
  assert.deepEqual(parse('2026-10-18 17:05:09 올림 abc1234 build 412\n'), { build: 412, at })
  assert.equal(parse('2026-10-18 17:05:09 실패 abc1234 build 412 (로그: /x/log)\n'), null)
  assert.equal(parse(''), null)
  assert.match(src, /emit\(\{ t: 'testflight', \.\.\.v \}\)/)
  // Told again at each welcome, so a new server hears it.
  assert.match(src, /testflightSent = ''\n    reportTestflight\(\)/)
})

test('서버: 운영자 맥이 알린 최신 빌드만 받고, 더 낮은 빌드·잘못된 값은 무시한다 (1.263)', async () => {
  const s = await startServer()
  try {
    await s.login('boss')
    await s.login('alice')
    const at = Date.now() - 3600_000
    const a = await mac(s, 'alice', 'aaaaaaaa-0000-4000-8000-00000000000a', 'mac-a')
    await a.up({ t: 'testflight', build: 999, at })
    assert.equal((await s.api('alice', '/api/me')).json.appBuild, undefined, '운영자가 아닌 맥의 값은 받지 않음')
    const b = await mac(s, 'boss', 'bbbbbbbb-0000-4000-8000-00000000000b', 'mac-b')
    await b.up({ t: 'testflight', build: 412, at })
    assert.deepEqual((await s.api('alice', '/api/me')).json.appBuild, { build: 412, at })
    await b.up({ t: 'testflight', build: 400, at: at + 1000 }, { t: 'testflight', build: 'x', at }, { t: 'testflight', build: 500, at: Date.now() + 3 * 86_400_000 })
    assert.deepEqual((await s.api('boss', '/api/me')).json.appBuild, { build: 412, at }, '더 낮은 빌드·잘못된 값은 무시')
    await b.up({ t: 'testflight', build: 413, at: at + 5000 })
    assert.deepEqual((await s.api('boss', '/api/me')).json.appBuild, { build: 413, at: at + 5000 })
    assert.deepEqual(JSON.parse(readFileSync(`${s.data}/app-build.json`, 'utf8')), { build: 413, at: at + 5000 })
    a.close()
    b.close()
  } finally {
    await s.stop()
  }
})

test('화면: 앱 안에서, 30분 지난 더 새 빌드만, 미룬 빌드는 하루 동안 묻지 않는다 (1.263)', () => {
  const now = Date.UTC(2026, 9, 18, 9)
  const app = appVersion('Mozilla/5.0 (iPhone; CPU iPhone OS 26_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 AgentBridge/1.0 (400)')
  const old = { build: 412, at: now - APP_UPDATE_WAIT_MS }
  assert.equal(updateDue(app, old, now, null), 412)
  assert.equal(updateDue(null, old, now, null), null, '브라우저')
  assert.equal(updateDue(app, undefined, now, null), null, '최신 빌드 모름(데모 포함)')
  assert.equal(updateDue(app, { build: 400, at: 0 }, now, null), null, '같은 빌드')
  assert.equal(updateDue(app, { build: 412, at: now - APP_UPDATE_WAIT_MS + 1 }, now, null), null, '올린 지 30분 전')
  assert.equal(updateDue(app, old, now, { build: 412, until: now + APP_UPDATE_SNOOZE_MS }), null, '나중에')
  assert.equal(updateDue(app, old, now + APP_UPDATE_SNOOZE_MS, { build: 412, until: now + APP_UPDATE_SNOOZE_MS }), 412, '하루 지나면 다시')
  assert.equal(updateDue(app, { build: 413, at: old.at }, now, { build: 412, until: now + APP_UPDATE_SNOOZE_MS }), 413, '더 새 빌드는 다시')
  assert.equal(TESTFLIGHT_URL, 'itms-beta://beta.itunes.apple.com/v1/app/6823927425')
  const appTsx = read('ui/src/app.tsx')
  // A pane of 분할 화면 (REQ-F-786) leaves it to the page around it, so it is asked once.
  assert.match(appTsx, /if \(!me \|\| me\.demo \|\| nudged \|\| inPane\) return/)
  assert.match(appTsx, /ok: 'TestFlight 열기', cancel: '나중에'/)
})
