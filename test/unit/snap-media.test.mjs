import test from 'node:test'
import assert from 'node:assert/strict'
import { evalMedia } from '../../ui/src/lib/snap-media.ts'

const mm = (q) => q === '(prefers-color-scheme: light)' || q === '(hover: hover)'

test('AC-1834 스냅샷 @media 는 그린 폭으로 답한다', () => {
  const at = (t, w, h = 900) => evalMedia(t, w, h, mm)
  assert.equal(at('(min-width: 1012px)', 1280), true)
  assert.equal(at('(min-width: 1012px)', 412), false)
  assert.equal(at('screen and (max-width: 767px)', 412), true)
  assert.equal(at('screen and (max-width: 767px)', 1280), false)
  assert.equal(at('only screen and (min-width: 48em)', 800), true)
  assert.equal(at('(min-width: 544px) and (max-width: 1011.98px)', 800), true)
  assert.equal(at('(min-width: 544px) and (max-width: 1011.98px)', 1280), false)
  assert.equal(at('(width >= 768px)', 1280), true)
  assert.equal(at('(400px < width <= 900px)', 412), true)
  assert.equal(at('(400px < width <= 900px)', 1280), false)
  assert.equal(at('print and (min-width: 10px)', 1280), false)
  assert.equal(at('not all and (max-width: 600px)', 1280), true)
  assert.equal(at('(orientation: landscape)', 1280, 900), true)
  assert.equal(at('(max-width: 600px), (min-width: 1200px)', 1280), true)
  assert.equal(at('(min-width: 768px) and (prefers-color-scheme: light)', 1280), true)
  assert.equal(at('(min-width: 768px) and (hover: none)', 1280), false)
  assert.equal(at('(min-width: 768px) or (max-width: 100px)', 412), false)
  // Not about size, or not read here: left to the browser.
  assert.equal(at('(prefers-color-scheme: dark)', 1280), null)
  assert.equal(at('(min-width: calc(100px + 1em))', 1280), null)
  assert.equal(at('tv and (min-width: 10px)', 1280), null)
})
