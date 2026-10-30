// slot (REQ-F-824): the places on the page where items can be added, wrapped, replaced or hidden. The page's own
// items sit in the same slot under their ids (the built-in items, listed where each slot is drawn); what is added
// here goes before or after one of them. Nothing here knows about React: each place draws what resolve() gives.

export const SLOTS = ['composer.actions', 'session.menu', 'session-list.row.badges', 'settings.section'] as const
export type SlotName = (typeof SLOTS)[number]

/** The page's own items of each slot, by id: what order, replace and hide may name (§7.1). */
export const BUILTIN_IDS: Record<SlotName, readonly string[]> = {
  'composer.actions': ['attach', 'chips', 'mic', 'send'],
  'session.menu': [
    // page only (place "page")
    'split', 'split-add', 'split-full', 'split-leave', 'same-group', 'copy-path', 'screen', 'todos', 'doc',
    // a closed session
    'place', 'resume', 'rename', 'remove',
    // an open one
    'group', 'refresh', 'compact', 'fork', 'lightfork', 'trim-log', 'move-host', 'move-account', 'move-cwd', 'lock', 'favorite', 'rest', 'log', 'end', 'trash',
  ],
  'session-list.row.badges': ['state', 'slack', 'delegated'],
  'settings.section': [],
}

export interface SlotItem {
  id: string
  /** Where it goes among the page's items; at the end when the id named is not there. */
  order?: { before?: string; after?: string }
  [k: string]: unknown
}
type Replace = (orig: SlotItem) => SlotItem

interface Reg<T> {
  owner: string
  v: T
}
const added = new Map<SlotName, Reg<SlotItem>[]>()
const replaced = new Map<SlotName, Reg<{ id: string; f: Replace }>[]>()
const hidden = new Map<SlotName, Reg<string>[]>()

let version = 0
const watchers = new Set<() => void>()
export const slotsVersion = () => version
export function watchSlots(f: () => void) {
  watchers.add(f)
  return () => void watchers.delete(f)
}
const changed = () => {
  version++
  for (const f of watchers) f()
}

const check = (slot: string) => {
  if (!(SLOTS as readonly string[]).includes(slot)) throw new Error(`모르는 slot 이에요: ${slot}`)
}
function put<T>(m: Map<SlotName, Reg<T>[]>, slot: SlotName, r: Reg<T>) {
  m.set(slot, [...(m.get(slot) ?? []), r])
  changed()
  return () => {
    m.set(
      slot,
      (m.get(slot) ?? []).filter((x) => x !== r),
    )
    changed()
  }
}

/** Adds an item. Its id must not be one of the page's or another added item's. */
export function register(slot: SlotName, item: SlotItem, owner = '') {
  check(slot)
  if (!item || typeof item.id !== 'string' || !item.id) throw new Error('slot 항목에는 id 가 있어야 해요')
  if (BUILTIN_IDS[slot].includes(item.id) || (added.get(slot) ?? []).some((r) => r.v.id === item.id)) throw new Error(`${slot} 에 이미 있는 id 예요: ${item.id}`)
  // extId: whose item it is, for the error boundary that reports a failing render to its extension.
  return put(added, slot, { owner, v: owner ? { ...item, extId: owner } : item })
}
/** Wraps or replaces an item (the page's or an added one): f gets what it is now. */
export function replace(slot: SlotName, id: string, f: Replace, owner = '') {
  check(slot)
  return put(replaced, slot, { owner, v: { id, f } })
}
export function hide(slot: SlotName, id: string, owner = '') {
  check(slot)
  return put(hidden, slot, { owner, v: id })
}

/**
 * The slot's items as drawn: the page's (`builtin`, each turned into a slot item and back by `to`/`from`), the
 * added ones put in place, replacements applied in the order they came, hidden ones left out. Entries that are not
 * items (a separator) stay where they are. A replacement that throws is skipped (the item stays as it was) and logged.
 */
export function resolve<T>(slot: SlotName, builtin: T[], to: (b: T) => SlotItem | null, from: (i: SlotItem, builtin: boolean) => T): T[] {
  type E = { item: SlotItem | null; raw: T; builtin: boolean }
  const list: E[] = builtin.map((b) => ({ item: to(b), raw: b, builtin: true }))
  const ext = added.get(slot) ?? []
  const reps = replaced.get(slot) ?? []
  const gone = new Set((hidden.get(slot) ?? []).map((r) => r.v))
  if (!ext.length && !reps.length && !gone.size) return builtin
  for (const { v } of ext) {
    const at = (id?: string) => (id ? list.findIndex((e) => e.item?.id === id) : -1)
    const before = at(v.order?.before)
    const after = at(v.order?.after)
    const e: E = { item: v, raw: undefined as T, builtin: false }
    if (before >= 0) list.splice(before, 0, e)
    else if (after >= 0) list.splice(after + 1, 0, e)
    else list.push(e)
  }
  const out: T[] = []
  for (const e of list) {
    if (!e.item) {
      out.push(e.raw)
      continue
    }
    if (gone.has(e.item.id)) continue
    let item = e.item
    let changedHere = false
    for (const { owner, v } of reps)
      if (v.id === e.item.id)
        try {
          item = { ...v.f(item), id: e.item.id }
          changedHere = true
        } catch (err) {
          console.warn(`[slots] ${slot}/${e.item.id}${owner ? ` (${owner})` : ''}: ${err instanceof Error ? err.message : err}`)
        }
    out.push(e.builtin && !changedHere ? e.raw : from(item, e.builtin))
  }
  return out
}
