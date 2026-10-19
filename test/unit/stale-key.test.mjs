// A browser of this Mac that was closed while the agent key changed comes back with the retired key. The agent knows
// that key by its print only, never hands it the new key, and opens the link page in that same browser instead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { keyPrint, retireKey, RETIRED_KEYS_MAX, browserApp } from '../../agent/guard.mjs'

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
  assert.match(src, /if \(key && \(config\.retiredKeys \?\? \[\]\)\.includes\(keyPrint\(key\)\)\) reopenLink\(req\.headers\['user-agent'\]\)\n\s*return res\.writeHead\(401/)
  assert.match(src, /config\.retiredKeys = retireKey\(config\.retiredKeys, config\.key\)/)
  assert.match(src, /if \(config\.oldKey\?\.key && /)
})

test('the server passes on only the known key-state fields: no key or key print gets through (AC-1333)', () => {
  const src = fs.readFileSync(new URL('../../server/server.mjs', import.meta.url), 'utf8')
  const body = src.match(/function cleanKeyState\(k\) \{[\s\S]*?\n\}/)[0]
  const cleanKeyState = new Function(`${body}; return cleanKeyState`)()
  const now = Date.now()
  const out = cleanKeyState({ gen: 2, latest: 2, at: now, oldUntil: null, retired: 1, linked: 'current', stale: { at: now, app: 'com.google.Chrome', key: 'K' }, reopen: { at: now, app: 'com.google.Chrome', ok: true }, key: 'SECRET', print: 'abc' })
  assert.deepEqual(out, { gen: 2, latest: 2, at: now, oldUntil: null, retired: 1, linked: 'current', stale: { at: now, app: 'com.google.Chrome' }, reopen: { at: now, app: 'com.google.Chrome', ok: true } })
  assert.equal(cleanKeyState(null), null)
  assert.equal(cleanKeyState({ linked: 'x', stale: { at: 'no' }, reopen: { at: now, app: '<script>' } }).linked, null)
  assert.equal(cleanKeyState({ stale: { at: 'no' } }).stale, null)
  assert.equal(cleanKeyState({ reopen: { at: now, app: '<script>' } }).reopen.app, null)
  assert.match(src, /key: cleanKeyState\(st\.health\?\.keyState\)/)
})

test('agent.mjs reports the key state in health without the key itself', () => {
  const src = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  const body = src.match(/const keyState = \(\) => \(\{[\s\S]*?\n\}\)/)[0]
  assert.doesNotMatch(body, /config\.key\b|oldKey\.key|retiredKeys\)/)
  assert.match(src, /keyState: keyState\(\),/)
  assert.match(src, /clientOldKey = !same\(config\.key\)/)
})
