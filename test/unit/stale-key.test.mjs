// A browser of this Mac that was closed while the agent key changed comes back with the retired key. The agent knows
// that key by its print only, never hands it the new key, and opens the link page in that same browser instead.
// What the server passes on of the key state (AC-1333) is tested in server/keystate_test.go.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { keyPrint, retireKey, RETIRED_KEYS_MAX, browserApp, keyRotateDue, KEY_ROTATE_MS, noteRekey, noteTook, rekeyResult, KEY_LOG_MAX } from '../../agent/guard.mjs'

test('retired keys are kept as prints, newest first, without repeats, at most RETIRED_KEYS_MAX', () => {
  assert.equal(keyPrint('a'), keyPrint('a'))
  assert.notEqual(keyPrint('a'), keyPrint('b'))
  assert.ok(!keyPrint('secret-key').includes('secret'))
  let p = retireKey(undefined, 'k1')
  p = retireKey(p, 'k2')
  p = retireKey(p, 'k1')
  assert.deepEqual(p, [keyPrint('k1'), keyPrint('k2')])
  for (let i = 0; i < 10; i++) p = retireKey(p, `x${i}`)
  assert.equal(p.length, RETIRED_KEYS_MAX)
  assert.equal(p[0], keyPrint('x9'))
  assert.deepEqual(retireKey(p, ''), p)
})

test('the browser a request came from, for `open -b`; never the headless browser', () => {
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)'
  assert.equal(browserApp(`${mac} Chrome/141.0.0.0 Safari/537.36`), 'com.google.Chrome')
  assert.equal(browserApp(`${mac} Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0`), 'com.microsoft.edgemac')
  assert.equal(browserApp(`${mac} Version/26.0 Safari/605.1.15`), 'com.apple.Safari')
  assert.equal(browserApp('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0'), 'org.mozilla.firefox')
  assert.equal(browserApp(`${mac} HeadlessChrome/141.0.0.0 Safari/537.36`), null)
  assert.equal(browserApp('Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) Version/26.0 Mobile Safari/604.1'), null)
  assert.equal(browserApp('curl/8.7.1'), null)
  assert.equal(browserApp(undefined), null)
})

test('agent.mjs reopens the link page only for a retired key, and keeps the old key of an earlier change', () => {
  const src = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  assert.match(src, /if \(key && \(config\.retiredKeys \?\? \[\]\)\.includes\(keyPrint\(key\)\)\) \{\n\s*if \(url\.searchParams\.get\('bg'\) === '1' && config\.background\) restartBgForKey\(\)\n\s*else reopenLink\(req\.headers\['user-agent'\], key\)\n\s*\}\n\s*return res\.writeHead\(401/)
  // Never while a tab is linked, and once per retired key and browser (1.330: a stale tab piled up link pages).
  assert.match(src, /const once = `\$\{app\} \$\{keyPrint\(key\)\}`\n\s*if \(client \|\| reopened\.has\(once\) \|\| Date\.now\(\) - \(reopened\.get\(app\) \?\? 0\) < REOPEN_MS\) return/)
  // The relay reads the stored key again on each reconnect, for a tab that missed the storage event.
  assert.match(fs.readFileSync(new URL('../../web/relay.js', import.meta.url), 'utf8'), /function connectAgent\(takeover\) \{\n\s*agentStream\?\.close\(\)\n(\s*\/\/.*\n)*\s*const now = agentInfo\(\)\n\s*if \(now\?\.key\) Object\.assign\(agent, now\)/)
  // The headless browser is started again at most once per REOPEN_MS (REQ-S-081 ④).
  assert.match(src, /function restartBgForKey\(\) \{\n\s*if \(Date\.now\(\) - \(reopened\.get\('headless'\) \?\? 0\) < REOPEN_MS\) return/)
  assert.match(src, /config\.retiredKeys = retireKey\(config\.retiredKeys, config\.key\)/)
  assert.match(src, /if \(config\.oldKey\?\.key && /)
})

test('agent.mjs reports the key state in health without the key itself', () => {
  const src = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  const body = src.match(/const keyState = \(\) => \(\{[\s\S]*?\n\}\)/)[0]
  assert.doesNotMatch(body, /config\.key\b|oldKey\.key|retiredKeys\)/)
  assert.match(src, /keyState: keyState\(\),/)
  assert.match(src, /clientOldKey = !same\(config\.key\)/)
})

test('the key changes by itself after a day, only while the linked tab can take it on the current key (REQ-S-083)', () => {
  const now = 10 * KEY_ROTATE_MS
  const due = (o) => keyRotateDue({ now, keyAt: now - KEY_ROTATE_MS, oldUntil: null, linked: 'current', rekey: true, ...o })
  assert.equal(due({}), true)
  assert.equal(due({ keyAt: now - KEY_ROTATE_MS + 60_000 }), false, '하루가 안 됨')
  assert.equal(due({ keyAt: undefined }), true, 'keyAt 없는 옛 키')
  assert.equal(due({ rekey: false }), false, '새 키를 못 받는 옛 릴레이')
  assert.equal(due({ linked: 'old' }), false, '이전 키로 붙은 탭')
  assert.equal(due({ linked: null }), false, '연동 탭 없음')
  assert.equal(due({ oldUntil: now + 1000 }), false, '이전 키 유예 중')
  assert.equal(due({ oldUntil: now - 1000 }), true)
  const src = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  assert.match(src, /setInterval\(autoRotateKey, KEY_ROTATE_CHECK_MS\)/)
  assert.match(src, /keyGen: KEY_GEN, keyAt: Date\.now\(\) \}/)
})

test('key changes are remembered with when a tab took the new key (REQ-S-084)', () => {
  let l = noteRekey(undefined, 1000, 'auto')
  assert.deepEqual(l, [{ at: 1000, why: 'auto', took: null }])
  for (let i = 0; i < 6; i++) l = noteRekey(l, 2000 + i, 'site')
  assert.equal(l.length, KEY_LOG_MAX)
  assert.equal(l[0].at, 2005)
  const t = noteTook(l, 3000)
  assert.equal(t[0].took, 3000)
  assert.equal(t[1].took, null)
  assert.equal(noteTook(t, 4000), t, '한 번만')
  assert.equal(noteTook(undefined, 1), undefined)
  assert.equal(rekeyResult(t[0], 9e9, 900_000), 'took')
  assert.equal(rekeyResult({ at: 0, took: null }, 1000, 900_000), 'waiting')
  assert.equal(rekeyResult({ at: 0, took: null }, 900_000, 900_000), 'missed')
  const src = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  assert.match(src, /if \(same\(config\.key\)\) \{\n\s*const kl = noteTook\(config\.keyLog, Date\.now\(\)\)/)
  assert.match(src, /config\.keyLog = noteRekey\(config\.keyLog, config\.keyAt, why\)/)
})
