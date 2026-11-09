// The ```choices block at the end of an answer (REQ-F-136), taken out the way the server does (server/events.go
// extractChoices). The page needs it too: a sealing Mac's answer reaches the server as one sealed piece, so the
// server cannot see the block, and only the page that opens the piece can turn it into buttons.

const CHOICES_RE = /\n?```choices\n([\s\S]*?)\n```[ \t]*(?=\n|$)/g
const SOURCES_HEAD_RE = /^(#{1,6}\s*)?(\*\*)?(sources|references|출처|참고(\s*자료)?)(\*\*)?\s*:?\s*(\*\*)?$/i
const SOURCE_ITEM_RE = /^\s*([-*+]|\d+\.)\s+.*https?:\/\//

/** A tail that is only a sources list (a heading, then link items): it may follow the choices block. */
function sourcesOnly(tail: string): boolean {
  const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length <= 1 || !SOURCES_HEAD_RE.test(lines[0])) return false
  return lines.slice(1).every((l) => SOURCE_ITEM_RE.test(l))
}

/** The answer without its last choices block, and the block's options (at most 6), or the text as it is and null. */
export function extractChoices(text: string): { text: string; choices: string[] | null } {
  const m = [...text.matchAll(CHOICES_RE)].pop()
  if (!m) return { text, choices: null }
  const start = m.index!
  const tail = text.slice(start + m[0].length)
  if (tail.trim() && !sourcesOnly(tail)) return { text, choices: null }
  const choices = m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 6)
  if (!choices.length) return { text, choices: null }
  const before = text.slice(0, start).replace(/\s+$/, '')
  return { text: tail.trim() ? `${before}\n\n${tail.trim()}` : before, choices }
}

/**
 * A timeline text item whose words were sealed, after opening: its choices taken out here, since the server saw
 * only the piece. An item the server already read (plain, or choices given) stays as it came.
 */
export function choicesAfterOpen<T extends Record<string, unknown>>(sealed: Record<string, unknown>, opened: T): T {
  if (sealed.k !== 'text' || typeof sealed.text !== 'string' || !sealed.text.includes('⟦bt')) return opened
  if (Array.isArray(opened.choices) || typeof opened.text !== 'string') return opened
  const { text, choices } = extractChoices(opened.text)
  return choices ? { ...opened, text, choices } : opened
}
