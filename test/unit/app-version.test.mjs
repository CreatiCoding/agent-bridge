// 앱 버전 (REQ-F-765): the iOS app puts its version in the User-Agent and 설정 → 이 기기 reads it back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../../', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')

test('iOS 앱이 User-Agent 에 AgentBridge/<버전> (<빌드>) 를 붙이고, 화면이 그것을 읽는다 (1.211)', () => {
  const swift = read('ios/Bridge/BridgeApp.swift')
  assert.match(swift, /applicationNameForUserAgent = \[c\.applicationNameForUserAgent \?\? "Mobile\/15E148", "AgentBridge\/\\\(version\) \(\\\(build\)\)"\]/)
  assert.match(swift, /"CFBundleShortVersionString"/)
  assert.match(swift, /"CFBundleVersion"/)
  const src = read('ui/src/lib/app-version.ts')
  const re = new RegExp(src.match(/ua\.match\(\/(.+)\/\)/)[1])
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 AgentBridge/1.0 (299)'
  assert.deepEqual(ua.match(re).slice(1), ['1.0', '299'])
  assert.equal('Mozilla/5.0 (iPhone; CPU iPhone OS 26_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'.match(re), null)
  assert.match(read('ui/src/pages/settings.tsx'), /appVersion\(\)/)
})

// 1.343: in the app, a long press on a session row showed WebKit's blank link preview instead of the page's menu.
test('iOS 앱 웹뷰는 링크 미리보기를 끄고, 길게 누르기는 페이지 메뉴가 받는다 (1.343)', () => {
  assert.match(read('ios/Bridge/BridgeApp.swift'), /v\.allowsLinkPreview = false/)
  assert.match(read('ui/src/components/session-list.tsx'), /longPressed\.current = true/)
})
