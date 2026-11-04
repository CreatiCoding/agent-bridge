// 짝지은 기기의 익스텐션 (REQ-F-864): off unless turned on on this device for this hash, kept in this browser only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')

test('짝지은 기기는 이 기기에서 켠 것(같은 해시)만 띄운다', () => {
  const host = read('ui/src/lib/ext-host.tsx')
  assert.match(host, /if \(pairedHosts\(\)\.length && !pairedAllowed\(x\)\) return report\(/)
  assert.match(host, /localStorage\.getItem\(pairedKey\(x\.id\)\) === x\.hash/)
  // Turning it on asks first and says what the code can do with this device's keys.
  assert.match(host, /이 기기의 서명 키로 맥에 명령을 보내고/)
  assert.ok(host.indexOf('if (!sure) return false') < host.indexOf('localStorage.setItem(pairedKey(x.id), x.hash)'))
  // The server cannot turn it on: nothing about it is sent or read from /api.
  assert.doesNotMatch(host, /call\([^)]*paired/i)
})

test('설정 → 플러그인: 짝지은 기기에서 동의한 익스텐션에 "이 기기에서도 켜기"', () => {
  const s = read('ui/src/components/ext-panels.tsx')
  assert.match(s, /paired && x\.consented && !x\.loadError \?/)
  assert.match(s, /label=\{`\$\{x\.name\} 이 기기에서도 켜기`\}/)
  assert.match(s, /allowOnPaired\(x, on\)/)
})
