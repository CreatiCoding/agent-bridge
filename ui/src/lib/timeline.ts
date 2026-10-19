// A session's log folded into what the conversation shows: an event that finishes or marks an earlier one
// (a tool's result, a card's answer, a reaction on a message) changes that item instead of adding a row.
import type { Card, Ev, Todo } from './types'

export type Item =
  | { t: 'user'; key: string; seq: number; at: number; id: string; text: string; images: string[]; via?: string; command?: boolean; marks: string[] }
  | { t: 'text'; key: string; seq: number; at: number; text: string; choices?: string[] }
  | { t: 'tool'; key: string; seq: number; at: number; id: string; name: string; label: string; detail?: string; input?: string; done: boolean; error?: boolean; output?: string; images?: string[] }
  | { t: 'card'; key: string; seq: number; at: number; card: Card; result?: string; closed: boolean }
  | { t: 'held'; key: string; seq: number; at: number; id: string; n: number }
  | { t: 'side'; key: string; seq: number; at: number; id: string; q: string; answer?: string; error?: string }
  | { t: 'note'; key: string; seq: number; at: number; text: string; tone: 'info' | 'warn' | 'error' | 'end' | 'local'; error?: boolean; actions?: NoteAction[] }

/** A button the server put on a line (as a block of buttons): its value is `<pid>:<command> [argument]`. */
export interface NoteAction {
  label: string
  cmd: string
  arg: string
  primary: boolean
}

function actionsOf(blocks: unknown): NoteAction[] | undefined {
  if (!Array.isArray(blocks)) return undefined
  const out: NoteAction[] = []
  for (const b of blocks as { type?: string; elements?: { type?: string; text?: { text?: string }; value?: string; style?: string }[] }[]) {
    if (b?.type !== 'actions') continue
    for (const e of b.elements ?? []) {
      const m = /^\d+:([a-z]+)\s*(.*)$/.exec(String(e.value ?? ''))
      if (e.type === 'button' && m) out.push({ label: String(e.text?.text ?? m[1]), cmd: m[1], arg: m[2], primary: e.style === 'primary' })
    }
  }
  return out.length ? out : undefined
}

export interface Folded {
  items: Item[]
  todos: Todo[] | null
  /** The highest seq applied. */
  last: number
}

export const emptyFold = (): Folded => ({ items: [], todos: null, last: 0 })

/** A to-do's words without the marks Claude adds or drops when it rewrites the list: bold, code, the closing (note). */
export const todoKey = (text: string) =>
  text
    .replace(/[*`]/g, '')
    .replace(/\s*\([^()]*\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * A new list replaces the last one (REQ-F-778 rule 3a), but Claude often sends only the work left, which wiped the
 * done items from the panel. Those stay, after the new list; an empty list still clears it.
 */
function keepDone(prev: Todo[] | null, next: Todo[]): Todo[] {
  if (!prev?.length || !next.length) return next
  const have = new Set(next.map((t) => todoKey(t.text)))
  const kept = prev.filter((t) => t.status === 'completed' && !have.has(todoKey(t.text)))
  return kept.length ? [...next, ...kept] : next
}

/** Apply events (in seq order, possibly repeating ones already applied) to a folded log. Returns a new object. */
export function fold(prev: Folded, events: Ev[]): Folded {
  let items = prev.items
  let todos = prev.todos
  let last = prev.last
  // Built once per batch, on its first add or update.
  let byKey: Map<string, number> | null = null
  const index = () => (byKey ??= new Map(items.map((it, i) => [it.key, i])))
  let copied = false
  const writable = () => {
    if (!copied) (items = items.slice()), (copied = true)
    return items
  }
  // One row per key: a log can hold the same tool call twice (written by two servers during a deploy), and two
  // rows under one React key are never removed again, so every redraw added copies and pushed the reader's place down.
  const add = (it: Item) => {
    if (index().has(it.key)) return
    writable().push(it)
    byKey?.set(it.key, items.length - 1)
  }
  const update = (key: string, f: (it: Item) => Item) => {
    const i = index().get(key)
    if (i === undefined) return false
    writable()[i] = f(items[i])
    return true
  }

  for (const e of events) {
    if (e.seq <= last) continue
    last = e.seq
    const base = { seq: e.seq, at: e.at }
    switch (e.k) {
      case 'user': {
        const id = e.id ?? `u${e.seq}`
        add({ t: 'user', key: `u:${id}`, ...base, id, text: e.text, images: e.images ?? [], via: e.via, command: e.command, marks: [] })
        break
      }
      case 'text':
        add({ t: 'text', key: `t:${e.seq}`, ...base, text: e.text, choices: e.choices })
        break
      case 'tool':
        add({ t: 'tool', key: `x:${e.tool}`, ...base, id: e.tool, name: e.name, label: e.label, detail: e.detail, input: e.input, done: false })
        break
      case 'tool_end':
        update(`x:${e.tool}`, (it) => ({ ...(it as Extract<Item, { t: 'tool' }>), done: true, error: e.error, output: e.text, images: e.images }))
        break
      case 'todos':
        todos = keepDone(todos, e.items)
        break
      case 'card': {
        const c = e.card
        // An automatic allow arrives already answered: one quiet line.
        if (!update(`c:${c.id}`, (it) => ({ ...(it as Extract<Item, { t: 'card' }>), card: { ...(it as Extract<Item, { t: 'card' }>).card, ...c } })))
          add({ t: 'card', key: `c:${c.id}`, ...base, card: c, closed: !c.open, result: c.result })
        break
      }
      case 'card_end':
        update(`c:${e.id}`, (it) => ({ ...(it as Extract<Item, { t: 'card' }>), closed: true, result: e.result }))
        break
      case 'react':
        update(`u:${e.id}`, (it) => {
          const u = it as Extract<Item, { t: 'user' }>
          const marks = u.marks.filter((m) => m !== e.name)
          return { ...u, marks: e.on ? [...marks, e.name] : marks }
        })
        break
      case 'held':
        if (!update(`h:${e.id}`, (it) => ({ ...(it as Extract<Item, { t: 'held' }>), n: e.n }))) add({ t: 'held', key: `h:${e.id}`, ...base, id: e.id, n: e.n })
        break
      case 'side':
        if (!update(`s:${e.id}`, (it) => ({ ...(it as Extract<Item, { t: 'side' }>), answer: e.answer, error: e.error })))
          add({ t: 'side', key: `s:${e.id}`, ...base, id: e.id, q: e.q, answer: e.answer, error: e.error })
        break
      case 'local':
        add({ t: 'note', key: `n:${e.seq}`, ...base, text: e.text, tone: 'local', error: e.error })
        break
      case 'notice':
        add({ t: 'note', key: `n:${e.seq}`, ...base, text: e.text, tone: e.tone === 'warn' ? 'warn' : 'info' })
        break
      case 'line':
        add({ t: 'note', key: `n:${e.seq}`, ...base, text: e.text, tone: 'info', actions: actionsOf(e.blocks) })
        break
      case 'end':
        add({ t: 'note', key: `n:${e.seq}`, ...base, text: e.text ? `세션 끝남 · ${e.text}` : '세션 끝남', tone: 'end' })
        break
      default:
        // title, model, status: facts about the session, shown elsewhere.
        break
    }
  }
  if (items === prev.items && todos === prev.todos && last === prev.last) return prev
  return { items, todos, last }
}

/** The open card of a session, if its log shows one still waiting. */
export function openCard(f: Folded): Card | null {
  for (let i = f.items.length - 1; i >= 0; i--) {
    const it = f.items[i]
    if (it.t === 'card') return it.closed ? null : it.card
  }
  return null
}
