// What a Claude Code terminal screen says about the session, read from its text.
import fs from 'node:fs'

const INTERRUPTED_RE = /Interrupted\s*[·•]\s*What should Claude do instead\?/i
/** The prompt box with nothing typed and no work indicator: Claude is simply waiting. */
const EMPTY_PROMPT_RE = /^\s*❯\s*$/m
// `esc to interrupt` is the familiar hint; newer Claude Code also shows only a spinner line
// (`✽ Flibbertigibbeting… (13m 20s · ↓ 14.5k tokens)`) while a long tool call runs, with no hint text at all.
export const WORKING_RE = /esc to interrupt|^\s*[✻✢✶✳✽✦*·]\s+\S+…\s*\(\d/im

/**
 * 'interrupted': the turn was stopped and Claude waits for the next instruction. 'idle': an empty prompt and
 * nothing running. null: neither can be told from the screen alone.
 *
 * "Interrupted" is only a state while it is the last thing said. Once new output follows it, the line is
 * history, not a stuck session.
 */
export function stuckState(screen) {
  const lines = screen.split('\n')
  const last = lines.reduce((acc, l, i) => (INTERRUPTED_RE.test(l) ? i : acc), -1)
  // Below the input box is the status area (the mode, hints, and a status line that can say anything): not output.
  const box = lines.findLastIndex((l) => /^\s*[─━]{8,}\s*$/.test(l))
  const trailing = lines.slice(last + 1, box > last ? box : undefined)
  const nothingAfter = last >= 0 && trailing.every((l) => !l.trim() || /^\s*❯/.test(l) || /^[\s─▔━═_╌╍│|]+$/.test(l) || /for shortcuts|to cycle|for agents|\/effort|mode on|bypass/i.test(l))
  if (nothingAfter && !WORKING_RE.test(screen)) return 'interrupted'
  if (EMPTY_PROMPT_RE.test(screen) && !WORKING_RE.test(screen)) return 'idle'
  return null
}

/**
 * Whether typed text is sitting in Claude Code's input box, unsent. The box is the last pair of horizontal rules
 * on the screen; a `❯` line anywhere else (a message Claude Code holds in its queue while it works, or an
 * earlier prompt in the scrollback) is not the box, and pressing Enter for it does nothing but repeat forever.
 */
export function inputBoxHas(screen, head) {
  if (!head) return false
  const lines = screen.split('\n')
  const rules = []
  lines.forEach((l, i) => {
    if (/^[\s─━]*[─━]{20,}[\s─━]*$/.test(l)) rules.push(i)
  })
  if (rules.length < 2) return false
  const box = lines.slice(rules.at(-2) + 1, rules.at(-1))
  return box.some((l) => /^\s*❯\s*\S/.test(l) && l.includes(head))
}

/** Effort as Claude Code prints it: the startup header ("… with low effort") or the /effort hint ("low · /effort"). */
export function detectEffort(screen) {
  const m = /\bwith (low|medium|high|xhigh|max) effort\b/i.exec(screen) ?? /\b(low|medium|high|xhigh|max)\s*·\s*\/effort/i.exec(screen)
  return m ? m[1].toLowerCase() : null
}

/**
 * The permission mode Claude Code shows in its status line: the lines under the input box (after the last
 * horizontal rule), or the last few lines when there is no rule. Only there: the conversation above can hold the
 * same words (a session reading this very file printed "accept edits on" in its scrollback), and reading the
 * whole screen took that for the mode, so switching to manual for 전부 허용 never seemed to happen.
 */
export function detectPermissionMode(screen) {
  const lines = String(screen).split('\n')
  const lastRule = lines.findLastIndex((l) => /^[\s─━]*[─━]{20,}[\s─━]*$/.test(l))
  const foot = (lastRule >= 0 ? lines.slice(lastRule + 1) : lines.slice(-4)).join('\n')
  if (/auto mode on/i.test(foot)) return 'auto'
  if (/accept edits on/i.test(foot)) return 'acceptEdits'
  if (/plan mode on/i.test(foot)) return 'plan'
  if (/bypass(ing)? permissions/i.test(foot)) return 'bypassPermissions'
  if (/manual mode on/i.test(foot)) return 'default'
  return null
}

/** How full the context is, as a short label ("42%", "80k/200k"), when the screen says. */
export function detectContext(screen) {
  // "Context left until auto-compact: 12%" says what is left. A rule allowing only 10 characters between
  // "left" and the number is exceeded by that very sentence and reads 12% left as 12% used; 30 here.
  let m = /context\s+(?:left|remaining|남음)[^\d\n]{0,30}(\d{1,3})\s*%/i.exec(screen)
  if (m && Number(m[1]) <= 100) return `${100 - Number(m[1])}%`
  m = /context[^\n]*?(\d{1,3})\s*%\s*(?:used|사용)?/i.exec(screen) ?? /(\d{1,3})\s*%\s*(?:of\s+)?context/i.exec(screen)
  if (m && Number(m[1]) <= 100) return `${Number(m[1])}%`
  m = /(\d+(?:\.\d+)?)k\s*\/\s*(\d+(?:\.\d+)?)k/i.exec(screen)
  if (m && Number(m[2]) > 0) return `${m[1]}k/${m[2]}k`
  return null
}

/** The last lines that say something, without borders, tips and key hints. */
export function screenDigest(screen, n = 12) {
  return screen
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l && !/^[\s─▔━═_╌╍│|└┘┌┐├┤┬┴┼.-]*$/.test(l) && !/\bTip:/i.test(l) && !/shift\+tab to cycle|esc to interrupt|for agents|to manage|\? for shortcuts/i.test(l) && !/^\s*[❯>]\s*$/.test(l) && !/tmux detected|scroll with PgUp/i.test(l))
    .slice(-n)
    .join('\n')
}

/**
 * How long a transcript has not been written to, in ms (Infinity when it cannot be read). A turn the transcript
 * calls open but that stopped (a dialog's key cut the request off, 2026-10-25) writes nothing more.
 */
export function transcriptQuietMs(file, now = Date.now()) {
  try {
    return now - fs.statSync(file).mtimeMs
  } catch {
    return Infinity
  }
}
/** How long the screen may sit idle on a turn the transcript still calls open before it is closed anyway. */
export const TURN_STALE_MS = 60_000

/**
 * Whether a turn is still open, read from the transcript alone, for the moment a screen-only judgement (the
 * input box looks idle) would otherwise close it. The screen can read as idle while Claude Code is between
 * steps, so the last thing actually written settles it: a tool call with no result yet, or a result/message
 * Claude has not answered, means the turn is open; a final piece of text means the turn really is done.
 */
export function transcriptTurnLooksOpen(file, tailBytes = 262_144) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.statSync(file).size
    const start = Math.max(0, size - tailBytes)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim())
    // A tail that does not start at byte 0 may begin mid-record; that partial line is dropped.
    if (start > 0 && lines.length) lines.shift()
    let last
    for (const line of lines) {
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry.isSidechain) continue
      const content = entry.message?.content
      if (entry.type === 'assistant' && Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) last = 'text'
          else if (block.type === 'tool_use') last = 'tool_use'
        }
      } else if (entry.type === 'user') last = 'pending'
    }
    return last === 'tool_use' || last === 'pending'
  } catch {
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/**
 * Whether Claude Code wrote `text` down as a prompt at or after `since` (ms): the transcript is what it took, so a
 * message found there arrived, even when its UserPromptSubmit hook never reached the agent.
 */
export function transcriptHasPrompt(file, text, since, tailBytes = 262_144) {
  const want = normalizeMessage(text).slice(0, 200)
  if (!want) return false
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.statSync(file).size
    const start = Math.max(0, size - tailBytes)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('"user"')) continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry.type !== 'user' || entry.isSidechain || !(Date.parse(entry.timestamp) >= since)) continue
      const c = entry.message?.content
      const said = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : ''
      if (normalizeMessage(said).includes(want)) return true
    }
    return false
  } catch {
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** A message as it reads once it has gone through Claude Code and come back: placeholders and spacing removed. */
export function normalizeMessage(text) {
  return String(text ?? '')
    .replace(/<\/?pasted_content\b[^>]*>/g, '')
    .replace(/\[Image #\d+\]/g, '')
    .replace(/\[(?:Image|File) attached: [^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The note Claude wrote right before the tool call it is about to make, read off the terminal (REQ-F-710). When a
 * PreToolUse hook runs, that answer is not in the transcript yet (an interactive session writes it once the call is
 * done), but it is on screen: the last "⏺" block above the spinner, minus the call's own lines (its description,
 * its "⎿" lines, a "⏺ Tool(…)" header). '' when there is no such note.
 */
/**
 * A "⏺" line Claude Code draws for a tool, not for Claude's words: a call's head, one word or a few
 * ("⏺ Bash(…)", "⏺ Web Search(…)", "⏺ Creating worktree(…)"), or a line saying what is under way or done,
 * which ends with "…" or folds ("⏺ Running 1 shell command…", "⏺ Making 1 scratchpad edit +49, running 1 shell
 * command…", "⏺ Calling claude-in-chrome 2 times…", "⏺ Read 3 files (ctrl+o to expand)"). Read as notes, these
 * turned back calls whose note was Korean.
 */
const toolLine = (l) => /^⏺ [A-Z][\w-]*(?: [\w-]+){0,3}\(/.test(l) || /^⏺ [\w-]+ - .*\(MCP\)/.test(l) || /…\s*$/.test(l) || /\(ctrl\+o to expand\)\s*$/.test(l)
/** A "⏺" line Claude Code writes about work in the background ("⏺ Background command "…" completed (exit code 0)"). */
const noticeLine = (l) => /^⏺ (?:Background command|Agent|Task|Monitor|Workflow|Shell)\b/.test(l) || /\(exit code -?\d+\)\s*$/.test(l)
/** Calls already done, folded into one line with no "⏺" ("  Ran 1 shell command", "  Searched for 1 pattern, read 1 file"). */
const groupLine = (l) => /^ {2}(?:Ran|Read|Searched|Wrote|Edited|Updated|Created|Called|Fetched|Listed|Made|Found|Loaded|Used)\b/.test(l)

export function screenNote(screen, tool = {}) {
  const lines = String(screen).split('\n')
  // Above the spinner ("running PreToolUse hook") or, failing that, above the input box.
  let end = lines.findLastIndex((l) => /running PreToolUse hook/.test(l))
  if (end < 0) end = lines.findLastIndex((l) => /^[─━]{20,}/.test(l.trim()))
  if (end < 0) end = lines.length
  const skip = [tool.description, tool.command].filter((x) => typeof x === 'string' && x.trim()).map((x) => x.replace(/\s+/g, ' ').trim())
  // The call being made is the last "⏺" line. Its note is the "⏺" block right on top of it; anything else in
  // between (an earlier call's "⎿" lines, a folded group, the prompt) means nothing was written before this call,
  // and the "⏺" further up is older text or a notice, not this call's note.
  const head = lines.findLastIndex((l, i) => i < end && /^⏺ /.test(l))
  if (head < 0) return ''
  let start = -1
  const drawn = toolLine(lines[head])
  if (drawn) {
    for (let i = head - 1; i >= 0; i--) {
      const l = lines[i]
      if (/^⏺ /.test(l)) {
        if (!toolLine(l) && !noticeLine(l)) start = i
        break
      }
      if (/^❯ /.test(l) || /^\s*⎿/.test(l) || groupLine(l)) break
    }
    end = head
  } else {
    // The call's head is not drawn (yet, or in the older layout where the note is followed by the call's
    // description and "⎿ $ …"). Only then is the last "⏺" this call's note; calls under it mean it is older.
    if (noticeLine(lines[head])) return ''
    for (let i = head + 1; i < end; i++) if (groupLine(lines[i]) || /^\s*⎿/.test(lines[i]) && !/^\s*⎿\s+\$ /.test(lines[i])) return ''
    start = head
  }
  if (start < 0) return ''
  const out = []
  for (let i = start; i < end; i++) {
    const l = lines[i].replace(/^⏺ /, '').trim()
    // Without the call's head, a blank line ends the note (below it is the spinner).
    if (!l) {
      if (drawn) continue
      break
    }
    if (/^⎿/.test(l) || /^⏺ /.test(lines[i]) && i > start) break
    if (skip.some((x) => l === x || x.startsWith(l))) continue
    out.push(l)
  }
  return out.join(' ').trim()
}

/**
 * Whether a short note is in English where the reader reads Korean (REQ-F-710): code fences, backticks, URLs, paths
 * and file names are not counted; any Hangul left means it is not; otherwise four or more Latin words mean it is.
 */
export function mostlyEnglish(text) {
  const t = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\S*\/\S*/g, ' ')
    .replace(/\b[\w.-]+\.(mjs|cjs|js|ts|tsx|jsx|md|json|css|html|sh|py|yml|yaml|txt)\b/g, ' ')
  if (/[가-힣]/.test(t)) return false
  return (t.match(/[A-Za-z]{2,}/g) ?? []).length >= 4
}

/**
 * How big a session's hand-over file (SESSION.md) may be when a light copy pastes it into the new session: a tenth
 * of the context window in bytes, 20 KB (200k) to 100 KB (1M). The window comes from the status line, else from a
 * `[1m]` model name; unknown is 20 KB.
 */
export function mdMaxOf(s) {
  const window = Number(s?.usage?.window) || (/\[1m\]/i.test(String(s?.model ?? '')) ? 1_000_000 : 0)
  return window ? Math.min(100_000, Math.max(20_000, Math.round(window / 10))) : 20_000
}

/**
 * Whether macOS shows one of its own alerts, the kind a privacy (TCC) prompt is drawn as ("node would like to
 * access files in your Downloads folder"). Those are windows of UserNotificationCenter above the normal layer;
 * a session waiting on one stops until someone at the Mac answers it. `windows` is CGWindowListCopyWindowInfo's
 * on-screen list, reduced to { o: owner, l: layer, b: bounds }. Reading it needs no permission.
 */
export function sysDialogOpen(windows) {
  return (Array.isArray(windows) ? windows : []).some((w) => w?.o === 'UserNotificationCenter' && Number(w.l) > 0 && Number(w.b?.Width) >= 100 && Number(w.b?.Height) >= 60)
}
