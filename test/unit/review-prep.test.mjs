// Before the App Store beta review: the privacy policy is readable signed out (REQ-F-767), the people-facing name is
// Agent Bridge (REQ-F-768), and an account waiting for approval sees what to do instead of a dead end (REQ-F-769).
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './server-harness.mjs'
import { readFileSync } from 'node:fs'
import { pendingPage, APP_NAME, SOURCE_URL } from '../../server/pages.mjs'

describe('signed-out pages', () => {
  let srv
  before(async () => (srv = await startServer({ env: { GITHUB_ALLOWED_LOGINS: '' } })))
  after(() => srv.stop())

  test('/privacy is served without signing in, in Korean and English, with the third parties', async () => {
    const r = await fetch(`${srv.origin}/privacy`, { redirect: 'manual' })
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /text\/html/)
    const t = await r.text()
    for (const s of ['개인정보 처리방침', 'Privacy Policy', 'GitHub', 'Anthropic', 'Apple', APP_NAME, '녹음은 맥 밖으로 나가지 않습니다', '제1조(개인정보의 처리 목적)', '제7조(개인정보의 국외 이전)', '제15조(개인정보 처리방침의 변경)', '1833-6972', '서버는 세션의 대화를 저장하지 않고', '제보는 문제 해결을 위하여 운영자가 사용하는 AI 도구로 처리될 수 있습니다']) assert.ok(t.includes(s), s)
    for (const s of ['Anthropic, PBC', '(제7조)', 'Claude, by Anthropic', 'settings and pictures']) assert.ok(!t.includes(s), s)
    // 1.267: the Korean text is a formal policy in 합니다체, as Korean apps write it (개인정보 보호법 제30조).
    const ko = t.slice(0, t.indexOf('id="en"'))
    assert.ok(!/(해요|예요)\./.test(ko), 'no 해요체 sentence in the Korean text')
    // 1.231: speech is turned into words on the Mac only; no outside AI gets the recording.
    assert.ok(!/openai/i.test(t))
  })

  test('/support is served without signing in, with the guide, the questions, the contact and the policy (REQ-F-783)', async () => {
    const r = await fetch(`${srv.origin}/support`, { redirect: 'manual' })
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /text\/html/)
    const t = await r.text()
    for (const s of ['<title>지원 · Agent Bridge</title>', 'href="/guide"', '이 기기로 앱 알림', 'TestFlight', '계정 삭제', 'mailto:nodejsdeveloper@kakao.com', 'href="/privacy"', 'English summary', 'Claude 는 Anthropic 의 상표', 'prefers-color-scheme:dark']) assert.ok(t.includes(s), s)
    // The source link (REQ-F-791) is an address in href, not words people read.
    assert.ok(t.includes('>소스 코드 · Source</a>'))
    assert.ok(!t.replaceAll(SOURCE_URL, '').includes('claude-bridge'))
    assert.ok(!t.includes('<script'))
  })

  test('the sign-in page is titled Agent Bridge, links the policy and says it is not Anthropic’s', async () => {
    const t = await (await fetch(`${srv.origin}/`)).text()
    assert.match(t, /<title>Agent Bridge<\/title>/)
    assert.match(t, /<h1>Agent Bridge<\/h1>/)
    assert.ok(t.includes('href="/privacy"'))
    assert.ok(t.includes('href="/support"'))
    assert.ok(t.includes('Claude 는 Anthropic 의 상표'))
  })

  test('the web app manifest carries the people-facing name', async () => {
    const m = await (await fetch(`${srv.origin}/manifest.webmanifest`)).json()
    assert.equal(m.name, 'Agent Bridge')
  })
})

// 1.289: AGPL-3.0, the official text at the root and the license field in both package.json (REQ-M-008, AC-1059).
test('the repository is licensed AGPL-3.0-only', () => {
  const lines = readFileSync(new URL('../../LICENSE', import.meta.url), 'utf8').split('\n')
  assert.equal(lines[0].trim(), 'GNU AFFERO GENERAL PUBLIC LICENSE')
  assert.equal(lines[1].trim(), 'Version 3, 19 November 2007')
  for (const p of ['../../package.json', '../../ui/package.json']) assert.equal(JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')).license, 'AGPL-3.0-only', p)
})

// 1.232: words people read name no `claude-bridge`; a command to paste keeps the real path (REQ-F-768 rule 4).
test('screens people read say 에이전트 폴더 instead of the claude-bridge folder', () => {
  const read = (f) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8')
  for (const f of ['ui/src/pages/guide.tsx', 'ui/src/pages/voice-settings.tsx', 'ui/src/pages/accounts.tsx', 'ui/src/pages/admin.tsx', 'server/demo.mjs']) assert.ok(!read(f).includes('claude-bridge'), f)
  // Slack keeps only the bot's handle (`@claude-bridge`) and its manifest name, which existing bots already carry.
  const slack = read('server/plugins/slack.mjs').replace(/@claude-bridge|name: 'claude-bridge'|display_name: 'claude-bridge'/g, '')
  assert.ok(!slack.includes('claude-bridge'))
})

describe('waiting for approval', () => {
  test('says what this is, what it needs, what happens once allowed, and what to do meanwhile', () => {
    const t = pendingPage({ login: 'alice', demo: false })
    for (const s of ['승인을 기다리는 중', 'alice', '맥', '에이전트', '운영자의 승인', '승인되면', '그동안 할 수 있는 것', 'href="/guide"', 'href="/privacy"', 'href="/api/auth/github"']) assert.ok(t.includes(s), s)
  })

  test('offers the public demo as a button when 데모 모드 is on, and none when it is off', () => {
    const on = pendingPage({ login: 'alice', demo: true })
    assert.ok(on.includes('<form method="post" action="/api/auth/demo"'))
    assert.ok(on.includes('데모로 둘러보기'))
    assert.ok(!pendingPage({ login: 'alice', demo: false }).includes('/api/auth/demo'))
  })

  test('the login is escaped', () => {
    const t = pendingPage({ login: '<b>x</b>', demo: false })
    assert.ok(!t.includes('<b><b>x'))
    assert.ok(t.includes('&#60;b&#62;x'))
  })
})
