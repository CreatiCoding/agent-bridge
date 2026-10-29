// 카메라 번역 (REQ-F-808): the iOS app's long-press menu opens a camera screen that reads Japanese and translates it
// on the phone. Swift is not built here (the TestFlight Mac builds it), so this checks the pieces that must agree.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../../', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')

test('아이콘 길게 누르기 메뉴의 카메라 번역이 화면을 열고, 일본어를 기기 안에서 읽고 번역한다 (1.341)', () => {
  const plist = read('ios/Bridge/Info.plist')
  const swift = read('ios/Bridge/JapaneseCamera.swift')
  const app = read('ios/Bridge/BridgeApp.swift')
  // Without a camera reason the app is killed the moment it asks.
  assert.match(plist, /<key>NSCameraUsageDescription<\/key>\s*<string>[^<]+<\/string>/)
  const type = plist.match(/<key>UIApplicationShortcutItemType<\/key>\s*<string>([^<]+)<\/string>/)[1]
  assert.equal(swift.match(/cameraAction = "([^"]+)"/)[1], type)
  assert.match(app, /configurationForConnecting[\s\S]*o\.shortcutItem[\s\S]*delegateClass = SceneDelegate\.self/)
  assert.match(app, /\.fullScreenCover\(isPresented: \$lab\.camera\) \{ CameraScreen\(\) \}/)
  assert.match(swift, /recognitionLanguages = \["ja-JP"\]/)
  assert.match(swift, /recognitionLevel = \.accurate/)
  assert.match(swift, /Configuration\(source: Locale\.Language\(identifier: "ja"\), target: Locale\.Language\(identifier: "ko"\)\)/)
  assert.match(swift, /prepareTranslation\(\)/)
  // Nothing leaves the phone: no network calls in the screen.
  assert.doesNotMatch(swift, /URLSession|URLRequest|https:\/\//)
})
