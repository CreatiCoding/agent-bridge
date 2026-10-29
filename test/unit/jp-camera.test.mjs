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
  // 1.344: prepareTranslation returns before the pack is downloaded; translating then waited on the system sheet.
  assert.match(swift, /prepareTranslation\(\)[\s\S]*while await LanguageAvailability\(\)\.status\([^)]*\)[^{]*!= \.installed[\s\S]*언어 받는 중[\s\S]*for await lines in texts\.stream/)
  // 1.345: a download that does not end gets a hint and 다시 받기 after 60 s.
  assert.match(swift, /let late = waited >= 60/)
  assert.match(swift, /Button\("다시 받기"\)[\s\S]*config\.invalidate\(\)/)
  // Nothing leaves the phone: no network calls in the screen.
  assert.doesNotMatch(swift, /URLSession|URLRequest|https:\/\//)
})
