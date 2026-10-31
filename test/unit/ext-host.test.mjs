// 익스텐션 화면 쪽 (REQ-F-827): what the loader does, read from its source (the live check is in the SPEC's AC).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
const host = read('ui/src/lib/ext-host.tsx')

test('불러오기: 동의한 것만, 1.5초까지 기다리고, 최상위 창에서만 해시마다 한 번 묻는다', () => {
  assert.match(host, /if \(loaded\.has\(x\.id\) \|\| x\.loadError \|\| !x\.consented\) return/)
  assert.match(host, /if \(x\.extensionApi > EXT_API\)/)
  assert.match(host, /new Promise\(\(r\) => setTimeout\(r, 1500\)\)/)
  assert.match(host, /if \(!me \|\| window\.top !== window \|\| noExt\(\)\) return/)
  assert.match(host, /localStorage\.getItem\(asked\) === x\.hash/)
  const main = read('ui/src/main.tsx')
  assert.ok(main.indexOf('await startExtensions(me)') < main.indexOf('render(me)\n'), 'loaded before the first drawing with me')
  assert.match(main, /askExtensions\(me\)/)
})

test('?noext=1 은 이 탭(분할 칸 포함)에 남고 ?noext=0 으로 풀린다; 파일이 바뀌면 다시 불러온다', () => {
  assert.match(host, /if \(q === '1'\) sessionStorage\.setItem\('cb-noext', '1'\)/)
  assert.match(host, /if \(q === '0'\) sessionStorage\.removeItem\('cb-noext'\)/)
  assert.match(host, /m\.t === 'ext-reload' && location\.reload\(\)/)
  assert.match(host, /onReconnect\(/)
  assert.match(read('ui/src/lib/store.ts'), /msg\.t === 'ext-event' \|\| msg\.t === 'ext-reload'/)
})

test('bridge 객체: uses 밖은 거절, 모든 /api/ext 요청에 X-Bridge-Ext, 이벤트 after 는 primaryOnly', () => {
  assert.match(host, /extension\.yaml 의 uses\.actions 에 \$\{n\} 가 없어요/)
  assert.match(host, /extension\.yaml 의 uses\.slots 에 \$\{n\} 가 없어요/)
  assert.match(host, /const H = \{ 'X-Bridge-Ext': '1' \}/)
  assert.match(host, /\(!h\.primaryOnly \|\| isPrimary\(\)\)/)
  for (const k of ['React,', 'kit:', 'actions:', 'slots:', 'commands:', 'ui:', 'storage:', 'api:', 'get isPrimary()', 'events:', 'data:', 'i18n:', 'theme:', 'user,', 'useSessions:', 'useCurrent:'])
    assert.ok(host.includes(k), k)
  assert.match(host, /kit: \{ \.\.\.kitAll, Sheet, Markdown \}/)
})

test('ui.sheet 은 history 하나를 넣어 뒤로가기가 시트를 닫고, 내장 시트는 그대로다', () => {
  assert.match(host, /history\.pushState\(\{ \.\.\.history\.state, extSheet: key \}, ''\)/)
  assert.match(host, /if \(top && history\.state\?\.extSheet !== top\.key\) closeSheet\(top\.key, true\)/)
  assert.doesNotMatch(read('ui/src/kit/overlay.tsx'), /pushState/)
})

test('오류: 버스·slot·메뉴 실행의 오류를 그 익스텐션의 이름으로 보고한다(1분에 같은 것 한 번)', () => {
  assert.match(host, /actions\.onNoted\(\(owner, action, what\) => report\(owner, action, new Error\(what\)\)\)/)
  assert.match(host, /onSlotFailed\(/)
  assert.match(host, /Date\.now\(\) - \(reported\.get\(key\) \?\? 0\) < 60_000/)
  assert.match(read('ui/src/components/session-menu.tsx'), /slotFailed\(String\(d\.extId \?\? ''\), 'session\.menu', e\)/)
  assert.match(read('ui/src/lib/slot-view.tsx'), /componentDidCatch\(e: unknown\) \{\s+failed\(this\.props\.owner, 'slot', e\)/)
})

test('언어 파일은 entry 가 어디 있든 익스텐션 폴더의 locales/ 에서 읽는다', () => {
  assert.match(host, /const dir = `\/ext\/\$\{x\.id\}\/\$\{x\.hash\}`/)
  assert.match(host, /fetch\(`\$\{dir\}\/locales\/\$\{lang\}\.json`/)
  assert.doesNotMatch(host, /x\.entry\.slice\(0, x\.entry\.lastIndexOf/)
})
