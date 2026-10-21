// The answer being written, read off the terminal screen as markdown. The effort hint above the input box is
// skipped (EFFORT_HINT_RE).
/**
 * What Claude is writing right now, read off the terminal. Claude Code writes a block of text to the
 * transcript only when it is finished, so the web app's "쓰는 중" line comes from the screen instead.
 *
 * The screen, bottom up: the input box (a rule line, then a line starting with ❯), above it the spinner line
 * (✻ ✢ ✶ ✳ ✽ · * …) and "⎿  Tip:" lines, above those the block being written: "⏺ " then lines indented two
 * spaces. A "⏺ ToolName(" block with a tool summary or ⎿ under it is a running tool, not text.
 *
 * Capture is `-e` (with SGR colour codes) so the block can be turned back into the markdown Claude actually
 * wrote (15): bold (SGR 1) → `**`, the theme's inline-code colour → backtick, a dim line holding only a
 * language name → a fenced code block up to the next blank line. The whole block is returned, not a
 * 160-character tail — the web app now shows it as the answer, not a two-line activity-box preview.
 */
const RULE_RE = /^\s*[─━]{8,}\s*$/
const SPINNER_RE = /^\s*[✻✢✶✳✽·*⏺]?\s*[✻✢✶✳✽·*]\s+\S.*…/
const TIP_RE = /^\s*⎿\s+Tip:/
/**
 * The effort hint Claude Code draws at the right edge of the line above the input box ("● high · /effort").
 * It is part of the frame, not of the answer. Found by this repository's end-to-end run, where it showed up as the last line of the answer being written.
 */
const EFFORT_HINT_RE = /^\s*\S?\s*(low|medium|high|xhigh|max)\s*·\s*\/effort\s*$/i
const TOOL_HEAD_RE = /^⏺\s+[\w.:-]+\(/
/**
 * Tool calls Claude Code folds into one line. Running: "⏺ Calling claude-in-chrome 3 times, running 2 shell
 * commands…". Done: the same words in the past tense, indented two spaces with no ⏺, in grey. A tool, not text.
 */
const GROUP_WORDS = '(Calling|Called|Running|Ran|Reading|Read|Searching|Searched|Fetching|Fetched|Writing|Wrote|Editing|Edited|Updating|Updated|Listing|Listed)'
const TOOL_GROUP_RE = new RegExp(`^⏺\\s+${GROUP_WORDS}\\s.*(…|\\(ctrl\\+o to expand\\))\\s*$`)
const GROUP_DONE_RE = new RegExp(`^ {2}\\x1b\\[38;5;246m${GROUP_WORDS}\\s`)
/**
 * While a tool runs, the ⏺ in front of it blinks: half the time column 0 is a space drawn in its colour. Seen
 * that way, the tool's line reads as an indented line of the text block above it, which was shown again.
 */
const BLINK_RE = /^\x1b\[[0-9;]*m \x1b\[(?:39|0)?m /
const TOOL_SUMMARY_RE = /^\s*(⎿|Running…|Ran\s|Searched\s|Read\s|Wrote\s|Updated\s|Edited\s|Listed\s|Fetched\s)/

const SGR_RE = /\x1b\[[0-9;]*m/g
/** Claude Code's default theme draws inline code in this 256-colour slot. */
const CODE_FG = '153'
const LANG_LINE_RE = /^[a-z][a-z0-9+#.-]*$/i

export const stripAnsi = (s) => s.replace(SGR_RE, '')

/** One line's text split into runs that share bold/inline-code styling, SGR codes consumed as they're seen. */
function parseSgrLine(line) {
  const segs = []
  let bold = false
  let code = false
  let last = 0
  SGR_RE.lastIndex = 0
  let m
  const push = (text) => {
    if (text) segs.push({ text, bold, code })
  }
  while ((m = SGR_RE.exec(line))) {
    push(line.slice(last, m.index))
    last = SGR_RE.lastIndex
    const codes = m[0].slice(2, -1).split(';').filter(Boolean)
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]
      if (c === '0' || c === '') {
        bold = false
        code = false
      } else if (c === '1') bold = true
      else if (c === '22' || c === '2') bold = false
      else if (c === '38' && codes[i + 1] === '5') {
        code = codes[i + 2] === CODE_FG
        i += 2
      } else if (c === '39') code = false
    }
  }
  push(line.slice(last))
  return segs
}

/** A merged run's own leading/trailing space goes outside the markdown marks (`** text**` reads oddly). */
function wrapRun(text, bold, code) {
  if (!bold && !code) return text
  const lead = /^\s*/.exec(text) [0]
  const trail = /\s*$/.exec(text.slice(lead.length)) [0]
  const core = text.slice(lead.length, text.length - trail.length)
  if (!core) return text
  return lead + (code ? '`' + core + '`' : '**' + core + '**') + trail
}

function lineToMarkdown(line) {
  const segs = parseSgrLine(line)
  let out = ''
  let i = 0
  while (i < segs.length) {
    const s = segs[i]
    let j = i + 1
    let text = s.text
    while (j < segs.length && segs[j].bold === s.bold && segs[j].code === s.code) {
      text += segs[j].text
      j++
    }
    out += wrapRun(text, s.bold, s.code)
    i = j
  }
  return out
}

/** A line that is entirely dim text and looks like a language name (`typescript`, `bash`, …): a fence opener. */
function isDimLangLine(line) {
  const plain = stripAnsi(line).trim()
  if (!LANG_LINE_RE.test(plain)) return undefined
  // Dim is SGR 2, with no SGR 22/1 after it for the visible run.
  const m = /\x1b\[([0-9;]*)m/.exec(line)
  if (!m) return undefined
  const codes = m[1].split(';')
  return codes.includes('2') && !codes.includes('1') ? plain : undefined
}

/**
 * How Claude Code (2.1.305) draws a fenced code block: no fence, no language line, no background, only the block's
 * own two-space indent like the text around it. A block with a language is syntax-coloured with the 16 basic
 * colours (SGR 30–37, 90–97: keywords 34, names 33, comments and numbers 32), which text never uses (links are
 * plain, quotes dim and italic); a block without one is drawn wholly in the inline-code colour (CODE_FG).
 * Returns whether this line looks like that: a basic colour on any visible character, or every visible character
 * in the inline-code colour. Found off a real screen (test/unit/fixtures/preview-code-*.txt).
 */
function looksLikeCode(line) {
  let fg = null
  let basic = false
  let all = true
  let any = false
  let last = 0
  SGR_RE.lastIndex = 0
  const see = (text) => {
    if (!text.trim()) return
    any = true
    if (fg === 'basic') basic = true
    if (fg !== CODE_FG) all = false
  }
  let m
  while ((m = SGR_RE.exec(line))) {
    see(line.slice(last, m.index))
    last = SGR_RE.lastIndex
    const codes = m[0].slice(2, -1).split(';')
    for (let i = 0; i < codes.length; i++) {
      const c = Number(codes[i] || 0)
      if (c === 0 || c === 39) fg = null
      else if (c === 38 && codes[i + 1] === '5') (fg = codes[i + 2]), (i += 2)
      else if (c === 38 && codes[i + 1] === '2') (fg = 'rgb'), (i += 4)
      else if (c === 48) i += codes[i + 1] === '5' ? 2 : codes[i + 1] === '2' ? 4 : 0
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) fg = 'basic'
    }
  }
  see(line.slice(last))
  return any && (basic || all)
}

/**
 * Which of the block's lines are a code block's: every line of a paragraph (lines between blank lines) in which
 * one line looks like code (a `}` or plain line of a coloured block has no colour of its own), and the blank lines
 * between two such paragraphs (a blank line inside the code).
 */
function codeLines(lines) {
  const code = lines.map(() => false)
  const blank = (i) => !stripAnsi(lines[i]).trim()
  let i = 0
  while (i < lines.length) {
    if (blank(i)) {
      i++
      continue
    }
    let j = i
    while (j < lines.length && !blank(j)) j++
    if (lines.slice(i, j).some(looksLikeCode)) for (let k = i; k < j; k++) code[k] = true
    i = j
  }
  for (let k = 0; k < lines.length; k++) {
    if (!blank(k) || code[k]) continue
    let a = k
    while (a >= 0 && blank(a)) a--
    let b = k
    while (b < lines.length && blank(b)) b++
    if (a >= 0 && b < lines.length && code[a] && code[b]) code[k] = true
  }
  return code
}

/** The raw block's lines (bottom-up order already resolved), as one markdown string — fences restored. */
function blockToMarkdown(lines) {
  const out = []
  const code = codeLines(lines)
  let i = 0
  while (i < lines.length) {
    if (code[i]) {
      // As drawn, without colours: the indentation inside the block is the code's own.
      const body = []
      while (i < lines.length && code[i]) body.push(stripAnsi(lines[i++]).replace(/\s+$/, ''))
      out.push('```', ...body, '```')
      continue
    }
    const lang = isDimLangLine(lines[i])
    if (lang !== undefined) {
      const code = []
      let j = i + 1
      while (j < lines.length && stripAnsi(lines[j]).trim() !== '') {
        code.push(stripAnsi(lines[j]))
        j++
      }
      out.push('```' + lang, ...code, '```')
      i = j
      continue
    }
    out.push(lineToMarkdown(lines[i]))
    i++
  }
  return out.join('\n').replace(/\s+$/, '')
}

/** Drop the first `n` *visible* characters of an SGR-coloured line, keeping any escape codes among them live. */
function dropVisiblePrefix(line, n) {
  let i = 0
  let visible = 0
  while (i < line.length && visible < n) {
    const rest = line.slice(i)
    const m = /^\x1b\[[0-9;]*m/.exec(rest)
    if (m) {
      i += m[0].length
      continue
    }
    i++
    visible++
  }
  return line.slice(i)
}

/** Terminal columns a string takes: CJK, Hangul and emoji are two columns, the rest one. */
export function visualWidth(s) {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff)
    w += wide ? 2 : 1
  }
  return w
}

const LIST_RE = /^\s*([-*+]|\d+[.)])\s/
const HEAD_LINE_RE = /^\s*#{1,6}\s/

/**
 * Claude Code wraps a long paragraph at the terminal width, at a space. Put back the breaks that were only the
 * wrap: the next line's first word would NOT have fit on the line above in the text's columns (the terminal's
 * width less the block's two-space indent), so the screen broke the line there, not the writer. A line the
 * writer ended is shorter than that. Code (codeLines, or after an old-style language line), list items,
 * headings and blank lines are never joined. Until 1.308 the width test was the other way round: the short lines
 * the writer ended (code) were joined and a wrapped paragraph was not.
 */
function reflow(raw, width) {
  const out = []
  const code = codeLines(raw)
  let inCode = false
  let prevCode = false
  raw.forEach((line, i) => {
    const plain = stripAnsi(line)
    if (isDimLangLine(line) !== undefined) inCode = true
    else if (!plain.trim()) inCode = false
    const above = out.length ? out[out.length - 1] : undefined
    const word = plain.trimStart().split(' ')[0]
    if (!inCode && !code[i] && !prevCode && above !== undefined && canJoin(stripAnsi(above), plain, width)) {
      // The space the wrap took goes back, unless the word was longer than a whole line and broken inside.
      const sep = /\s$/.test(stripAnsi(above)) || visualWidth(word) >= width - 2 ? '' : ' '
      out[out.length - 1] = above + sep + line
    } else out.push(line)
    prevCode = code[i]
  })
  return out
}

function canJoin(above, next, width) {
  if (!above.trim() || !next.trim()) return false
  if (LIST_RE.test(above) || LIST_RE.test(next) || HEAD_LINE_RE.test(above) || HEAD_LINE_RE.test(next)) return false
  if (above.trimStart().startsWith('```') || next.trimStart().startsWith('```')) return false
  if (/^\s/.test(next)) return false // indented beyond the block's own two spaces: code
  const word = next.trimStart().split(' ')[0]
  return visualWidth(above.trimEnd()) + 1 + visualWidth(word) > width - 2
}

/** The squashed text (no whitespace) of each line, with the same markdown marks removed as the block had. */
const squash = (s) => s.replace(/\s+/g, '')

/**
 * The block's head has scrolled off even the history read: find where the text already shown (`prev`) ends
 * on screen, by its last 40 characters (then 24, 16, 8) with whitespace ignored, and return what comes after
 * it. `undefined` when no anchor is found — the caller keeps `prev` as it is.
 */
function continuation(prev, raw) {
  const plain = raw.map(stripAnsi)
  const parts = plain.map(squash)
  const hay = parts.join('')
  const needle = squash(prev.replace(/\*\*|`/g, '').replace(/^```.*$/gm, ''))
  for (const n of [40, 24, 16, 8]) {
    if (needle.length < n) continue
    const tail = needle.slice(-n)
    const at = hay.lastIndexOf(tail)
    if (at < 0) continue
    const end = at + tail.length
    let acc = 0
    let li = 0
    while (li < parts.length - 1 && acc + parts[li].length < end) acc += parts[li++].length
    // Visible characters of line `li` already covered by the anchor.
    let covered = end - acc
    let cut = 0
    while (cut < plain[li].length && covered > 0) {
      if (!/\s/.test(plain[li] [cut])) covered--
      cut++
    }
    const first = dropVisiblePrefix(raw[li], cut)
    const midLine = first.trim() !== ''
    const body = [first, ...raw.slice(li + 1)]
    return { rest: blockToMarkdown(midLine ? body : body.slice(1)), midLine }
  }
  return undefined
}

/**
 * `screen` is `tmux capture-pane -e` output (SGR colour codes kept), `history` lines above it included. Returns
 * the block's markdown, or `''` when nothing is being written right now (either genuinely idle, or — while
 * still busy — a thinking pause with no text block on screen; callers tell the two apart from the session's own
 * busy/idle state, not from this return value, since the screen looks the same in both cases).
 *
 * `prev` is what the caller last showed for this block. If the block's head has scrolled past what was read,
 * the answer is `prev` plus whatever follows it on screen; with no anchor found, `''` (the caller keeps `prev`).
 */
export function writingPreview(screen, prev = '') {
  const ansiLines = screen.split('\n')
  const lines = ansiLines.map((l) => (BLINK_RE.test(l) ? `⏺${stripAnsi(l).slice(1)}` : stripAnsi(l)))
  // The input box: a rule with a ❯ line right under it, the lowest one on screen.
  let box = -1
  for (let i = lines.length - 2; i >= 0; i--) {
    if (RULE_RE.test(lines[i]) && /^❯/.test(lines[i + 1])) {
      box = i
      break
    }
  }
  if (box < 0) return ''
  const width = visualWidth(lines[box].trim())
  let end = box
  while (end > 0 && (!lines[end - 1].trim() || SPINNER_RE.test(lines[end - 1]) || TIP_RE.test(lines[end - 1]) || EFFORT_HINT_RE.test(lines[end - 1]))) end--
  let start = -1
  for (let i = end - 1; i >= 0; i--) {
    const l = lines[i]
    if (l.startsWith('⏺ ')) {
      if (TOOL_HEAD_RE.test(l) || TOOL_GROUP_RE.test(l)) return ''
      start = i
      break
    }
    if (/^\S/.test(l)) break // another line at column 0 (the prompt, a banner): the head is off the top, or gone
    if (TOOL_SUMMARY_RE.test(l) || GROUP_DONE_RE.test(ansiLines[i])) return ''
  }
  const dropped = []
  const from = start < 0 ? 0 : start
  for (let i = from; i < end; i++) {
    const n = i === start ? 2 : lines[i].startsWith('  ') ? 2 : lines[i].length - lines[i].trimStart().length
    dropped.push(dropVisiblePrefix(ansiLines[i], n))
  }
  if (start < 0) {
    if (!prev) return ''
    const more = continuation(prev, dropped)
    if (!more) return '' // no anchor: a thinking pause, or the screen moved on; the caller keeps what it showed
    if (!more.rest) return prev
    return more.midLine ? prev + more.rest : prev + '\n' + more.rest
  }
  return blockToMarkdown(reflow(dropped, width))
}
