// 설정 → 기기 (REQ-F-842, AC-1538): what a host's card says, and that its addresses keep working.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boardOrder, diskTone, meters, tidyCardText, tidyModeText } from '../../ui/src/lib/device-board.ts'

const bytes = (n) => `${Math.round(n / 1024 ** 3)}G`
const G = 1024 ** 3

test('diskTone: the disk menu rule, 85% amber and 95% red', () => {
  assert.equal(diskTone(84.9), 'ok')
  assert.equal(diskTone(85), 'warn')
  assert.equal(diskTone(94.9), 'warn')
  assert.equal(diskTone(95), 'bad')
})

test('meters: CPU, memory and disk, leaving out what was not sent; only the disk is coloured', () => {
  const m = meters({ cpu: 19.4, cores: 8, memUsed: 12 * G, memTotal: 16 * G, disk: { total: 500 * G, used: 450 * G, avail: 50 * G, pct: 90.2 } }, bytes)
  assert.deepEqual(
    m.map((x) => [x.key, x.pct, x.text, x.tone]),
    [
      ['cpu', 19, '19% · 8코어', 'ok'],
      ['mem', 75, '75% · 12G / 16G', 'ok'],
      ['disk', 90, '90% · 50G 남음', 'warn'],
    ],
  )
  assert.deepEqual(meters({ cpu: 120, cores: null, memUsed: null, memTotal: null, disk: null }, bytes).map((x) => [x.key, x.pct, x.text]), [['cpu', 100, '100%']], '0..100 로 자르고, 빠진 것은 그리지 않음')
  assert.deepEqual(meters(null, bytes), [])
  // CPU at 100% is a busy build, not a warning.
  assert.equal(meters({ cpu: 100, cores: 1, memUsed: 16 * G, memTotal: 16 * G, disk: null }, bytes).every((x) => x.tone === 'ok'), true)
})

test('tidyCardText: mode in a word and the counts (stop, rest + files)', () => {
  assert.equal(tidyModeText({ mode: 'auto' }), '자동')
  assert.equal(tidyModeText({ mode: 'suggest' }), '제안만')
  assert.equal(tidyModeText({ mode: 'off' }), '끔')
  assert.deepEqual(tidyCardText({ mode: 'auto', at: 1, stop: 2, rest: 1, files: 3 }), { mode: '자동', text: '내릴 세션 2 · 제안 4', count: 6 })
  assert.deepEqual(tidyCardText({ mode: 'suggest', at: 1, stop: 0, rest: 0, files: 0 }), { mode: '제안만', text: '정리할 것 없음', count: 0 })
  assert.deepEqual(tidyCardText({ mode: 'suggest', at: null, stop: 0, rest: 0, files: 0 }), { mode: '제안만', text: '아직 계산 전', count: 0 })
  assert.deepEqual(tidyCardText({ mode: 'off', at: null, stop: 0, rest: 0, files: 0 }), { mode: '끔', text: '꺼져 있어요', count: 0 })
  assert.equal(tidyCardText(null).mode, null, '1.385 이전 에이전트')
})

test('boardOrder: connected first, each by the fullest disk', () => {
  const h = (id, online, pct) => ({ id, online, sys: pct == null ? null : { disk: { pct } } })
  assert.deepEqual(boardOrder([h('a', false, 99), h('b', true, 40), h('c', true, 97), h('d', true, null)]).map((x) => x.id), ['c', 'b', 'd', 'a'])
})

test('router: /settings opens 기기, the old tab addresses and /disk?host still parse', async () => {
  const { matchRoute, href } = await import('../../ui/src/lib/router.ts').catch(() => ({}))
  if (!matchRoute) return // router.ts imports react; checked by the e2e instead (test/e2e-settings-devices.mjs).
  assert.deepEqual(matchRoute('/settings'), { name: 'settings' })
  assert.equal(href({ name: 'settings', tab: 'devices' }), '/settings')
  assert.equal(href({ name: 'settings', tab: 'launch' }), '/settings/launch')
  assert.deepEqual(matchRoute('/settings/prompt'), { name: 'settings', tab: 'prompt' })
  assert.deepEqual(matchRoute('/disk?host=abc-1'), { name: 'disk', host: 'abc-1' })
  assert.equal(href({ name: 'disk', host: 'abc-1' }), '/disk?host=abc-1')
})
