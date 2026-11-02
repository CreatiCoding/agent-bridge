// 조용한 답 (REQ-F-850, docs/MESSAGE-HOOK-DESIGN.md): the server marks one of Claude's answers quiet (`quiet` on
// the event: an agreed extension's id, or "mac" for a sealing Mac's own ends) and keeps the "새 답" dot and the
// notifications back for it. The page folds exactly what the server marked, so the two never disagree.
import { dispatch, setDefault, type MessageArgs } from './actions'

export interface QuietRule {
  ext: string
  suffix: string
  label: string
}

let rules: QuietRule[] = []
const names = new Map<string, string>([['mac', '이 맥의 설정']])
/** The rules of the extensions this person agreed to themselves (quietAgreed), in the server's order. */
export function setQuietRules(list: { id: string; name: string; quietAgreed?: boolean; loadError?: string; quiet?: { suffix: string; label: string }[] }[]) {
  rules = []
  for (const x of list) {
    names.set(x.id, x.name)
    if (!x.quietAgreed || x.loadError) continue
    for (const q of x.quiet ?? []) rules.push({ ext: x.id, suffix: q.suffix, label: q.label })
  }
}
export const extName = (id: string) => names.get(id) ?? id

/** The fold an answer's mark asks for: a sealing Mac's own, or an extension this person still agrees to. */
export function quietFor(mark?: string | null, text = ''): MessageArgs['quiet'] {
  if (!mark) return null
  if (mark === 'mac') return { ext: 'mac', name: extName('mac'), label: '' }
  const t = text.replace(/[ \t\r\n]+$/, '')
  const mine = rules.filter((r) => r.ext === mark)
  if (!mine.length) return null
  const r = mine.find((x) => t.endsWith(x.suffix)) ?? mine[0]
  return { ext: mark, name: extName(mark), label: r.label }
}

// ---------- message.render (REQ-F-850) ----------

setDefault('message.render', ({ text, quiet }) => (quiet ? { hide: true as const, reason: quiet.label } : { text }))

/** What the page draws for an answer, after the handlers, held to the rules a handler cannot change (REQ-F-850 §4). */
export interface Shown {
  /** Folded to one line (until opened). */
  folded: boolean
  reason: string
  /** The words to draw when shown or opened. */
  text: string
  /** Changed from the answer's own words (the page then offers them). */
  changed: boolean
  /** The extensions that folded or changed it, by name. */
  by: string[]
}

export function messageShown(a: MessageArgs): Shown {
  let v: unknown
  try {
    v = dispatch('message.render', a)
  } catch {
    v = null
  }
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  const by = Array.isArray(o.by) ? o.by.filter((x): x is string => typeof x === 'string').map(extName) : []
  const said = typeof o.text === 'string' ? o.text : a.text
  const hide = o.hide === true
  // A rule's fold stays a fold: the notifications already said nothing of it, so the page does not show it big.
  const folded = hide || !!a.quiet
  const reason = (typeof o.reason === 'string' && o.reason.trim() ? o.reason : a.quiet?.label ?? '').slice(0, 80)
  const names = a.quiet && !by.includes(a.quiet.name) ? [a.quiet.name, ...by] : by
  return { folded, reason, text: said, changed: said !== a.text, by: folded ? names : by }
}
