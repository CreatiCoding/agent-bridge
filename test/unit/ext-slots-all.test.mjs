// 화면 전체의 slot (REQ-F-865): every slot is drawn somewhere, the server takes the same names, items must have
// the shape their kind needs, and an extension's create fields never reach the server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { register, SLOT_KIND, SLOTS } from '../../ui/src/lib/slots.ts'

const ROOT = new URL('../../', import.meta.url).pathname
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')
const walk = (d) => readdirSync(path.join(ROOT, d)).flatMap((n) => (statSync(path.join(ROOT, d, n)).isDirectory() ? walk(`${d}/${n}`) : [`${d}/${n}`]))

test('slot 43개, 서버가 받는 이름과 같다', () => {
  assert.equal(SLOTS.length, 43)
  const go = /EXT_SLOTS\s+= \[\]string\{([^}]*)\}/.exec(read('server/ext.go'))[1]
  assert.deepEqual(go.split(',').map((x) => x.trim().replace(/"/g, '')), [...SLOTS])
})

test('모든 slot 이 화면 어딘가에서 그려진다', () => {
  const src = walk('ui/src')
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('lib/slots.ts') && !f.endsWith('lib/ext-api-check.ts'))
    .map(read)
    .join('\n')
  for (const n of SLOTS) assert.ok(src.includes(`'${n}'`) || src.includes(`"${n}"`), n)
})

test('공개 타입이 모든 slot 의 컨텍스트·항목·내장 id 를 싣는다', () => {
  const d = read('extensions/agent-bridge-ext.d.ts')
  for (const n of SLOTS) assert.ok(d.split(`'${n}':`).length - 1 >= 3, n)
  assert.match(d, /supported: \(slot: string\) => boolean/)
  assert.match(d, /version: \{ extensionApi: number; slots: \{ name: SlotName; kind: SlotKind \}\[\] \}/)
})

test('종류마다 필요한 칸이 없으면 등록할 때 거절한다', () => {
  assert.throws(() => register('session.header.actions', { id: 'a', label: 'x' }), /label·icon·run/)
  assert.throws(() => register('composer.status', { id: 'a' }), /render/)
  assert.throws(() => register('notification.items', { id: 'a' }), /title/)
  assert.throws(() => register('app.routes', { id: 'Bad Id', title: 't', render() {} }), /id\(/)
  assert.throws(() => register('settings.tabs', { id: 'x', render() {} }), /label·render/)
  assert.throws(() => register('session.panel', { id: 'p', label: 'Slack', render() {} }), /label·icon·render/)
  const offs = [
    register('session.header.actions', { id: 'a', label: 'x', icon: 'doc', run() {} }, 'ext'),
    register('composer.status', { id: 'a', render: () => null }, 'ext'),
    register('app.routes', { id: 'notes', title: 't', render: () => null }, 'ext'),
    register('session.panel', { id: 'thread', label: 'Slack', icon: 'doc', render: () => null }, 'ext'),
  ]
  offs.forEach((f) => f())
  for (const [n, k] of Object.entries(SLOT_KIND)) assert.ok(['own', 'action', 'menu', 'section', 'badge', 'data', 'panel'].includes(k), n)
})

test('새 세션의 익스텐션 값(ext)은 서버로 가지 않는다', () => {
  assert.match(read('ui/src/lib/builtin-actions.tsx'), /setDefault\('session\.create', async \(\{ ext: _ext, \.\.\.body \}\) =>/)
  assert.match(read('ui/src/pages/new-session.tsx'), /const wrong = createFieldError\(extValues, draft\)/)
})

test('익스텐션 화면·설정 탭 주소를 서버와 화면이 함께 안다', () => {
  assert.match(read('server/httputil.go'), /x\/\[a-z\]\[a-z0-9-\]\{1,31\}\/\[a-z0-9\]\[a-z0-9-\]\{0,31\}/)
  const r = read('ui/src/lib/router.ts')
  assert.match(r, /name: 'ext', ext: m\[1\], page: m\[2\]/)
  assert.match(r, /name: 'settings', ext: \{ ext: m\[1\], id: m\[2\] \}/)
})

test('세션 보조 패널(session.panel): 넓으면 도크, 좁으면 시트, 열린 것과 폭을 이 기기에 둔다', () => {
  assert.equal(SLOT_KIND['session.panel'], 'panel')
  const p = read('ui/src/components/session-panel.tsx')
  assert.match(p, /PANEL_DOCK = '\(min-width: 960px\)'/)
  assert.match(p, /PANEL_MIN = 260/)
  assert.match(p, /PANEL_MAX = 720/)
  assert.match(p, /<Sheet open onClose=\{close\}/)
  assert.match(p, /setPref\('extPanel'/)
  assert.match(p, /extPanelW\./)
  assert.match(p, /role="separator"/)
  const page = read('ui/src/pages/session-page.tsx')
  assert.match(page, /<PanelToggle panels=\{panels\} \/>/)
  assert.match(page, /<SessionPanel panels=\{panels\} ctx=\{slotCtx\}/)
})
