// 단축키 등록부 (REQ-F-824): every key the page answers to has one entry here, so an added shortcut cannot take a key
// the page already uses. The page's own keys keep their handlers where they are (the box's Enter waits for the IME,
// ⌥1-9 reads the key's place); they are listed here to hold their keys. Added ones are run by runShortcut.

export interface ShortcutCtx {
  route: string
  sid?: string
  focused: 'composer' | 'timeline' | 'other'
  /** The box's composer.actions context, while it has the focus. */
  composer?: unknown
}
export interface Shortcut {
  id: string
  title: string
  /** "Mod+K", "Alt+1", "Ctrl+Shift+Space", "Escape": Mod is ⌘ on a Mac and Ctrl elsewhere. */
  keys?: string | string[]
  when?: (ctx: ShortcutCtx) => boolean
  run?: (ctx: ShortcutCtx) => void
}

let mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
/** For tests: which platform Mod means. */
export const setMac = (on: boolean) => void (mac = on)

const MODS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const
/** One spelling for a key: modifiers in a fixed order, the key by its name (letters upper case). */
export function normKey(k: string) {
  const parts = k.split('+').map((p) => p.trim())
  const main = parts.pop() ?? ''
  const mods = new Set(parts.map((p) => ({ mod: mac ? 'Meta' : 'Ctrl', cmd: 'Meta', command: 'Meta', option: 'Alt', opt: 'Alt', control: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' })[p.toLowerCase()] ?? p))
  for (const m of mods) if (!(MODS as readonly string[]).includes(m)) throw new Error(`모르는 수정 키예요: ${m}`)
  const name = main.length === 1 ? main.toUpperCase() : main === 'Esc' ? 'Escape' : main
  if (!name) throw new Error('키가 비어 있어요')
  return [...MODS.filter((m) => mods.has(m)), name].join('+')
}
/** The key a keydown is, spelled as normKey spells it. Letters and digits by their place (⌥1 is ¡ on a Mac). */
export function keyOf(e: { key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }) {
  const c = e.code ?? ''
  const name = /^Key([A-Z])$/.exec(c)?.[1] ?? /^Digit(\d)$/.exec(c)?.[1] ?? (c === 'Space' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key)
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', name].filter(Boolean).join('+')
}

/** The page's own keys (each also Ctrl on a Mac where the page takes either). */
export const BUILTIN_SHORTCUTS: Shortcut[] = [
  ...Array.from({ length: 9 }, (_, i) => ({ id: `tab-${i + 1}`, title: `같은 그룹의 ${i + 1}번째 세션`, keys: `Alt+${i + 1}` })),
  { id: 'session-prev', title: '목록의 이전 세션', keys: 'Alt+ArrowUp' },
  { id: 'session-next', title: '목록의 다음 세션', keys: 'Alt+ArrowDown' },
  { id: 'search', title: '세션 찾기', keys: ['Meta+K', 'Ctrl+K'] },
  { id: 'sidebar', title: '목록 접기·펴기', keys: ['Meta+\\', 'Ctrl+\\'] },
  { id: 'voice', title: '음성 모드 켜기·끄기', keys: ['Alt+Space', 'Ctrl+Shift+Space'] },
  { id: 'send', title: '보내기 (입력칸, 음성 모드)', keys: ['Enter', 'Meta+Enter', 'Ctrl+Enter'] },
  { id: 'stop', title: '중단 (입력칸이 빌 때), 닫기', keys: 'Escape' },
]

const list: { s: Shortcut; keys: string[]; owner: string; builtin: boolean }[] = []
const take = (s: Shortcut, owner: string, builtin: boolean) => {
  if (!s || typeof s.id !== 'string' || !s.id || typeof s.title !== 'string') throw new Error('단축키에는 id 와 title 이 있어야 해요')
  if (list.some((x) => x.s.id === s.id)) throw new Error(`이미 있는 단축키 id 예요: ${s.id}`)
  const keys = (s.keys == null ? [] : Array.isArray(s.keys) ? s.keys : [s.keys]).map(normKey)
  for (const k of keys) {
    const had = list.find((x) => x.keys.includes(k))
    if (had) throw new Error(`${k} 는 이미 "${had.s.title}" 의 키예요`)
  }
  const e = { s, keys, owner, builtin }
  list.push(e)
  return () => {
    const i = list.indexOf(e)
    if (i >= 0) list.splice(i, 1)
  }
}
for (const s of BUILTIN_SHORTCUTS) take(s, '', true)

/** Adds a shortcut (or a command with no key, run from elsewhere). Taken keys and ids are refused. */
export const registerShortcut = (s: Shortcut, owner = '') => take(s, owner, false)
/** Every shortcut, the page's first, with its keys as normKey spells them. */
export const shortcuts = () => list.map((x) => ({ id: x.s.id, title: x.s.title, keys: x.keys, owner: x.owner, builtin: x.builtin }))

/** Runs the added shortcut a keydown is, if any (true when one ran). Not while a Korean syllable is being made. */
export function runShortcut(e: KeyboardEvent | { key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; isComposing?: boolean; preventDefault: () => void }, ctx: ShortcutCtx) {
  if (e.isComposing) return false
  const k = keyOf(e)
  const x = list.find((y) => !y.builtin && y.keys.includes(k))
  if (!x || !x.s.run || (x.s.when && !x.s.when(ctx))) return false
  e.preventDefault()
  try {
    x.s.run(ctx)
  } catch (err) {
    console.warn(`[shortcuts] ${x.s.id}${x.owner ? ` (${x.owner})` : ''}: ${err instanceof Error ? err.message : err}`)
  }
  return true
}
