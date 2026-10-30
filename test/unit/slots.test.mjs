// slot 과 단축키 등록부 (REQ-F-824): where added items go, replace and hide, and keys that cannot be taken twice.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BUILTIN_IDS, hide, register, replace, resolve, SLOTS } from '../../ui/src/lib/slots.ts'
import { keyOf, normKey, registerShortcut, runShortcut, setMac, shortcuts } from '../../ui/src/lib/shortcuts.ts'

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
const ids = (l) => l.map((x) => (typeof x === 'string' ? x : x.id))
const plain = (slot, list) => resolve(slot, list, (b) => (typeof b === 'string' ? null : b), (i) => i)

test('slot 4개와 내장 항목 id 가 설계(§7.1)와 같다', () => {
  assert.deepEqual([...SLOTS], ['composer.actions', 'session.menu', 'session-list.row.badges', 'settings.section'])
  assert.deepEqual([...BUILTIN_IDS['composer.actions']], ['attach', 'chips', 'mic', 'send'])
  assert.deepEqual([...BUILTIN_IDS['session-list.row.badges']], ['state', 'slack', 'delegated'])
  for (const id of ['place', 'resume', 'rename', 'remove', 'group', 'refresh', 'todos', 'compact', 'fork', 'lightfork', 'trim-log', 'move-host', 'move-account', 'move-cwd', 'lock', 'favorite', 'rest', 'log', 'end', 'trash', 'split', 'screen', 'doc'])
    assert.ok(BUILTIN_IDS['session.menu'].includes(id), id)
  assert.throws(() => register('nope', { id: 'x' }), /모르는 slot/)
})

test('아무것도 없으면 내장 목록 그대로(같은 배열)', () => {
  const list = [{ id: 'attach' }, { id: 'send' }]
  assert.equal(plain('composer.actions', list), list)
})

test('order 의 before·after, 없는 id 는 끝, 같은 id 는 거절, 떼면 사라진다', () => {
  const offs = [
    register('composer.actions', { id: 'ask', order: { before: 'send' } }, 'ext-a'),
    register('composer.actions', { id: 'late', order: { after: 'attach' } }, 'ext-b'),
    register('composer.actions', { id: 'far', order: { before: 'nothing' } }, 'ext-b'),
  ]
  assert.deepEqual(ids(plain('composer.actions', [{ id: 'attach' }, { id: 'chips' }, { id: 'send' }])), ['attach', 'late', 'chips', 'ask', 'send', 'far'])
  assert.throws(() => register('composer.actions', { id: 'send' }), /이미 있는 id/)
  assert.throws(() => register('composer.actions', { id: 'ask' }), /이미 있는 id/)
  offs.forEach((f) => f())
  assert.deepEqual(ids(plain('composer.actions', [{ id: 'attach' }, { id: 'send' }])), ['attach', 'send'])
})

test('replace 는 원래 항목을 받아 감싸고(차례로), hide 는 뺀다. 구분선은 자리에 남는다', () => {
  const offs = [
    replace('session.menu', 'end', (orig) => ({ ...orig, label: `${orig.label}!` })),
    replace('session.menu', 'end', (orig) => ({ ...orig, label: `[${orig.label}]`, id: 'renamed' })),
    replace('session.menu', 'log', () => {
      throw new Error('boom')
    }),
    hide('session.menu', 'trash'),
  ]
  const out = plain('session.menu', [{ id: 'log', label: '로그' }, 'sep', { id: 'end', label: '종료' }, { id: 'trash', label: '폴더' }])
  assert.deepEqual(out, [{ id: 'log', label: '로그' }, 'sep', { id: 'end', label: '[종료!]' }])
  offs.forEach((f) => f())
})

test('세션 메뉴: 모든 내장 항목에 id, 페이지 항목도 sessionMenu 안, 결과는 slot 을 지난다', () => {
  const src = read('ui/src/components/session-menu.tsx')
  for (const id of BUILTIN_IDS['session.menu']) assert.match(src, new RegExp(`id: '${id}'`), id)
  assert.match(src, /return slotMenu\(\[/)
  const page = read('ui/src/pages/session-page.tsx')
  assert.doesNotMatch(page, /splitMenu|phoneMenu|screenItem|wideMenu/)
  assert.match(page, /openMenu\(sessionMenu\(s, \{ groups: .*, wide, page: \{ sheet: setSheet/)
})

test('입력칸·행 배지·설정 탭이 slot 을 지난다', () => {
  const c = read('ui/src/components/composer.tsx')
  for (const id of ['attach', 'chips', 'mic', 'send']) assert.match(c, new RegExp(`id: '${id}',\\s+builtin: true`), id)
  assert.match(c, /resolve<Action>\('composer\.actions'/)
  assert.match(c, /useMedia\('\(max-width: 479px\)'\)/)
  assert.match(read('ui/src/components/session-list.tsx'), /resolve<RowBadge>\('session-list\.row\.badges'/)
  assert.match(read('ui/src/pages/settings.tsx'), /resolve<SettingsItem>\('settings\.section'.*\(i\.tab \?\? 'plugins'\) === tab/)
})

test('단축키: 키 표기 하나로, 내장 키는 먼저 잡혀 있어 겹치면 거절', () => {
  setMac(true)
  assert.equal(normKey('Mod+k'), 'Meta+K')
  assert.equal(normKey('shift+alt+1'), 'Alt+Shift+1')
  assert.equal(normKey('Esc'), 'Escape')
  setMac(false)
  assert.equal(normKey('Mod+k'), 'Ctrl+K')
  assert.equal(keyOf({ key: '¡', code: 'Digit1', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }), 'Alt+1')
  assert.equal(keyOf({ key: ' ', code: 'Space', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }), 'Alt+Space')
  const mine = shortcuts().filter((s) => s.builtin)
  for (const id of ['tab-1', 'tab-9', 'voice', 'send', 'stop', 'search']) assert.ok(mine.some((s) => s.id === id), id)
  assert.throws(() => registerShortcut({ id: 'x', title: 'x', keys: 'Alt+3' }), /이미 "같은 그룹의 3번째 세션"/)
  assert.throws(() => registerShortcut({ id: 'x', title: 'x', keys: 'Mod+Enter' }), /이미/)
  assert.throws(() => registerShortcut({ id: 'send', title: 'x' }), /이미 있는 단축키 id/)
  assert.throws(() => registerShortcut({ id: 'x', title: 'x', keys: 'Hyper+X' }), /모르는 수정 키/)
})

test('단축키: 더한 것만 실행하고 when 을 따르며, 한글 조합 중에는 돌지 않는다', () => {
  setMac(false)
  const ran = []
  const off = registerShortcut({ id: 'ask', title: '? 붙여 보내기', keys: 'Mod+Shift+Enter', when: (c) => c.focused === 'composer', run: (c) => ran.push(c.sid) }, 'ext')
  const ev = (o = {}) => ({ key: 'Enter', code: 'Enter', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false, preventDefault() {}, ...o })
  assert.equal(runShortcut(ev(), { route: 'session', sid: 's1', focused: 'other' }), false)
  assert.equal(runShortcut(ev({ isComposing: true }), { route: 'session', sid: 's1', focused: 'composer' }), false)
  assert.equal(runShortcut(ev(), { route: 'session', sid: 's1', focused: 'composer' }), true)
  // The page's own keys are not run from here.
  assert.equal(runShortcut(ev({ shiftKey: false }), { route: 'session', sid: 's1', focused: 'composer' }), false)
  assert.deepEqual(ran, ['s1'])
  off()
  assert.ok(!shortcuts().some((s) => s.id === 'ask'))
})

test('kit: TextField·ICONS·keepFocus 를 연다', () => {
  const kit = read('ui/src/kit/index.tsx')
  assert.match(kit, /export \{ Icon, ICONS, Logo, type IconName \} from '\.\/icons'/)
  assert.match(kit, /export const TextField = forwardRef/)
  assert.match(kit, /keepFocus\?: boolean/)
  assert.match(read('ui/src/kit/icons.tsx'), /export const ICONS: readonly string\[\] = Object\.keys\(PATHS\)/)
  assert.match(read('ui/src/kit/overlay.tsx'), /<TextField autoFocus value=\{value\}/)
})
