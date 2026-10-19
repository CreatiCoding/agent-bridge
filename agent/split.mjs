// Claude Code can split its screen: the conversation on the left, a panel (a diff, the changed files) on the
// right, with a `│` column between them. Everything the agent reads off the screen (dialogs, the mode, the
// context gauge, what Claude is writing) is in the left part. Read whole, the panel's text ran into a dialog's
// option labels: "1. Yes | 1413 + // … the folder set for" read as an allow for the whole folder, so
// 전부 허용 found no plain yes to press and asked the person instead.

import { visualWidth } from './preview.mjs'

const SGR_RE = /^\x1b\[[0-9;:]*[A-Za-z]/
const DIVIDER = '│'

/** Each visible character of a line with the terminal column it starts at, skipping colour codes. */
function cells(line) {
  const out = []
  let col = 0
  let i = 0
  while (i < line.length) {
    const m = SGR_RE.exec(line.slice(i))
    if (m) {
      i += m[0].length
      continue
    }
    const ch = String.fromCodePoint(line.codePointAt(i))
    out.push({ ch, col, at: i })
    col += visualWidth(ch)
    i += ch.length
  }
  return out
}

/**
 * The column of the divider of a split screen, or -1. A column counts when `│` sits there on at least half of
 * the screen's non-blank lines and on most of its bottom ten (where the prompt and dialogs are), with text to
 * its right on some of them, and it is not near either edge. A box's right edge has nothing to its right, and a
 * table in a reply does not reach down through the prompt.
 */
export function splitColumn(screen) {
  const lines = String(screen).split('\n').map(cells).filter((c) => c.some((x) => x.ch.trim()))
  if (lines.length < 12) return -1
  const width = Math.max(...lines.map((c) => (c.length ? c[c.length - 1].col + 1 : 0)))
  const at = (c, col) => c.find((x) => x.col === col)?.ch === DIVIDER
  const counts = new Map()
  for (const c of lines) for (const x of c) if (x.ch === DIVIDER && x.col >= 30 && x.col <= width - 10) counts.set(x.col, (counts.get(x.col) ?? 0) + 1)
  const bottom = lines.slice(-10)
  for (const [col, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    if (n < lines.length / 2) break
    if (bottom.filter((c) => at(c, col)).length < bottom.length * 0.7) continue
    const textRight = lines.filter((c) => at(c, col) && c.some((x) => x.col > col && x.ch.trim())).length
    if (textRight >= 3) return col
  }
  return -1
}

/** The screen without the right-hand panel of a split screen (unchanged when it is not split). Keeps colour codes. */
export function mainColumn(screen) {
  const col = splitColumn(screen)
  if (col < 0) return screen
  return String(screen)
    .split('\n')
    .map((line) => {
      const cut = cells(line).find((x) => x.col >= col)
      if (!cut) return line
      const left = line.slice(0, cut.at).replace(/[ \t]+$/, '')
      return /\x1b\[/.test(left) ? left + '\x1b[0m' : left
    })
    .join('\n')
}
