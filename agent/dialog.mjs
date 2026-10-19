// Reads and presses Claude Code's terminal confirmation dialogs. An option that switches the permission mode is
// never read as a plain allow.
/**
 * Terminal dialogs: reading them, deciding who answers, and answering safely.
 *
 * Every keystroke that answers a dialog goes through {@link DialogDriver}. That
 * is the point of this module: pressing a number is only safe if that option is
 * on screen right now. When the check was missing, a tap on a stale Slack
 * button typed its digit into the prompt and sent "1" to the session as a
 * message. The driver makes that impossible by construction.
 */

/**
 * Dialogs we answer without asking, because the user already made the decision
 * (model switch) or there is nobody at the terminal to accept a startup prompt.
 * Anything not listed is shown to the user as buttons instead.
 */
const KNOWN = [
  // `present` is matched against the drawn dialog only (its question, description and choices), never the whole
  // screen, and `choose` against the start of a choice: a command that merely quotes these words above a
  // permission dialog must not get that dialog answered (R1-H2).
  { name: 'folder-trust', present: /trust this folder|trust the files in this folder/i, choose: /^Yes, (I trust|proceed)/i },
  { name: 'dev-channels', present: /I am using this for local development/i, choose: /^I am using this for local development/i },
  // A project's MCP server (`.mcp.json`) is not here: whether to run it is the person's call, so it is shown as a
  // card like any other dialog (R1-M1).
  // `/model` mid-conversation asks before dropping the prompt cache. The user already chose, so say yes.
  { name: 'model-switch', present: /Switch model\?/i, choose: /^Yes, switch/i },
  // Startup, when the Chrome extension is installed and `--chrome` was not passed (QA runs). The launcher
  // passes `--chrome` for real sessions, so this only shows up where browser tools are meant to stay off.
  // Found by the QA sweep on 2026-09-23: the session sat here and never attached.
  { name: 'chrome-extension', present: /Claude in Chrome extension detected/i, choose: /^No, keep browser tools off/i },
]

const SEPARATOR_RE = /^[\s─▔━═_╌╍-]+$/
const OPTION_RE = /^\s*(❯\s*)?(\d+)\.\s+(.*\S)\s*$/
/** How far apart two options may sit; each carries a few lines of explanation. */
const MAX_OPTION_GAP = 6
/**
 * The tab strip Claude Code draws above a multi-question dialog
 * ("← ☐ 규칙 충돌 ☐ 진입 방식 ✔ Submit →"). It sits right where the question
 * would be, so without skipping it the card asks the wrong thing.
 */
const DIALOG_CHROME_RE = /^[←→]|[☐☑✔]\s*\S|Enter to (select|confirm)|Tab\/Arrow/
/**
 * The key hints under a dialog with no numbers. The running status line also
 * mentions Esc ("esc to interrupt"), so requiring an Enter hint is what keeps a
 * working session from reading as a question.
 */
const KEYED_FOOTER_RE = /(?:Enter|↵)\s+to\s+(?:continue|confirm|select|submit|proceed|accept)/i

/**
 * Recognize any numbered dialog Claude Code draws (❯ on one of `1. …` lines),
 * whether or not we know what it is. The normal prompt line (`❯ text`) has no
 * numbered options, so it never matches.
 */
export function parseDialog(screen) {
  const lines = screen.split('\n')
  // Options are not always adjacent: Claude Code prints an explanation under
  // each one, so `1.` and `2.` can be several lines apart. Walk the numbered
  // lines instead, keeping those that continue the sequence.
  const numbered = lines.flatMap((l, i) => {
    const m = OPTION_RE.exec(l)
    return m ? [{ i, n: Number(m[2]), label: m[3].trim() }] : []
  })
  /** The options around a `❯` line, or null when they are not a dialog. */
  const runAt = (at) => {
    const run = [numbered[at]]
    for (let k = at - 1; k >= 0; k--) {
      const prev = numbered[k]
      if (prev.n !== run[0].n - 1 || run[0].i - prev.i > MAX_OPTION_GAP) break
      run.unshift(prev)
    }
    for (let k = at + 1; k < numbered.length; k++) {
      const next = numbered[k]
      if (next.n !== run[run.length - 1].n + 1 || next.i - run[run.length - 1].i > MAX_OPTION_GAP) break
      run.push(next)
    }
    return run.length >= 2 && !isEchoedPrompt(lines, run) ? run : null
  }
  // A live dialog is drawn at the bottom; a list the person sent may still be on screen above it. So the
  // `❯ 1.` lines are tried from the bottom up, and the first that is a dialog is the one.
  let at = -1
  let run = null
  for (let k = numbered.length - 1; k >= 0 && !run; k--) {
    if (!/^\s*❯/.test(lines[numbered[k].i])) continue
    run = runAt(k)
    if (run) at = k
  }
  if (!run) return null

  const options = run.map((o, k) => ({
    n: o.n,
    label: o.label,
    description: describeOption(lines, o.i, run[k + 1]?.i ?? o.i + MAX_OPTION_GAP),
  }))

  // Up to 24 lines above the options, to the dialog's top border (a rule) or a conversation line (⏺ ❯),
  // split into paragraphs at blank lines. The paragraph next to the options starts with the question.
  const lo = run[0].i
  const paras = [[]]
  for (let i = lo - 1, seen = 0; i >= 0 && seen < 24; i--, seen++) {
    const raw = lines[i]
    // Only a side border is taken off the left; the indentation under it is kept.
    const l = raw.replace(/^\s*[│|]\s?/, '').replace(/[\s│|]+$/, '')
    if (/^\s*[⏺❯●]/.test(raw) || (SEPARATOR_RE.test(l.trim()) && l.trim()) || /^[╭╰┌└]/.test(l.trim())) break
    if (!l.trim()) {
      if (paras[0].length) paras.unshift([])
      continue
    }
    if (DIALOG_CHROME_RE.test(l.trim())) continue
    paras[0].unshift(l)
  }
  const kept = paras.filter((p) => p.length)
  const own = kept.at(-1) ?? []
  // Keep relative indentation (a command under its heading), drop the margin all of them share.
  const ctx = kept.slice(0, -1)
  const pad = Math.min(...ctx.flat().map((x) => /^\s*/.exec(x) [0].length))
  const context = ctx.map((p) => p.map((x) => x.slice(pad)).join('\n')).join('\n\n')
  return {
    question: own[0]?.trim() ?? '터미널이 선택을 기다립니다',
    description: own.slice(1).map((x) => x.trim()).join('\n') || undefined,
    ...(context ? { context } : {}),
    options,
    selected: at - numbered.indexOf(run[0]),
  }
}

/**
 * A message the person sent, as Claude Code draws it back in the conversation: `❯ 1. first` with `  2. second`
 * under it looks exactly like a dialog's options. It is not one when
 * - the conversation goes on below it (a `⏺` line: a live dialog is drawn at the bottom, output never follows it), or
 * - the line just above it (blank lines skipped) is not a question but conversation: the previous answer (`⏺`), the
 *   end-of-turn line (`✻ Churned for 13m 28s · done 5:27 PM`), a working line (`✢ Thinking…`) or another message (`❯`).
 * Found 2026-10-10: a two-point list sent from the page became a "터미널 확인" card with the list as buttons.
 */
const TURN_LINE_RE = /^\s*[✻✶✳✢✽✺·*⏺●❯]/
function isEchoedPrompt(lines, run) {
  const last = run[run.length - 1].i
  if (lines.slice(last + 1).some((l) => /^\s*[⏺●]\s/.test(l))) return true
  for (let i = run[0].i - 1; i >= 0; i--) {
    const l = lines[i].replace(/^\s*[│|]\s?/, '')
    if (!l.trim()) continue
    return TURN_LINE_RE.test(l)
  }
  return false
}

/**
 * Is the prompt input drawn underneath the dialog? Claude Code does that when the
 * dialog belongs to a background agent while the main loop is mid-turn: the box is
 * on screen, but keystrokes go to the prompt. A digit pressed then is typed there
 * and sent to the session as the message "1", and the dialog never gets its answer.
 */
export function promptHoldsFocus(screen) {
  const lines = screen.split('\n')
  let lastOption = -1
  lines.forEach((l, i) => {
    if (OPTION_RE.test(l)) lastOption = i
  })
  if (lastOption < 0) return false
  return lines.slice(lastOption + 1).some((l) => /^\s*❯/.test(l) && !OPTION_RE.test(l))
}

/** A dialog with no numbered options, driven by arrows and Enter. */

/**
 * Claude Code also draws dialogs with no numbers — checkbox forms like "Teach
 * auto mode about your environment?", answered with arrows and Enter.
 * {@link parseDialog} cannot see those, so the session would sit there with
 * nothing actionable in Slack. Recognize them by the key hints they print.
 */
export function parseKeyedDialog(screen) {
  const lines = screen.split('\n')
  const foot = lines.findIndex((l) => KEYED_FOOTER_RE.test(l))
  if (foot < 0) return null
  // The prompt line is `❯ ` with nothing on it; a dialog's cursor sits on a choice.
  const cursor = lines.findIndex((l, i) => i < foot && /^\s*❯\s*\S/.test(l))
  if (cursor < 0) return null

  // Every non-blank, non-separator line from the cursor down to the footer is a choice — the cursor's own
  // line plus whichever others sit alongside it (e.g. "❯ Open System Settings" / "Try again"); only the
  // first ever had the ❯, which is exactly what made every choice past it unreachable before this.
  const options = []
  let selected = 0
  for (let i = cursor; i < foot; i++) {
    const raw = lines[i]
    if (SEPARATOR_RE.test(raw.trim())) continue
    const isCursor = /^\s*❯\s*\S/.test(raw)
    const label = raw.replace(/^\s*❯?\s*/, '').trim()
    if (!label) continue
    if (isCursor) selected = options.length
    options.push(label)
  }
  if (!options.length) return null

  const body = []
  for (let i = cursor - 1; i >= 0 && body.length < 12; i--) {
    const l = lines[i].replace(/^[\s│|]+/, '').replace(/[\s│|]+$/, '').trim()
    if (SEPARATOR_RE.test(l)) break
    if (l) body.unshift(l)
  }
  if (!body.length) return null
  return { question: body[0], body: body.slice(1).join('\n') || undefined, footer: lines[foot].trim(), options, selected }
}

/** The indented lines under an option, joined; empty when there are none. */
function describeOption(lines, from, until) {
  const body = []
  for (let i = from + 1; i < Math.min(until, lines.length); i++) {
    const l = lines[i].trim()
    if (!l || SEPARATOR_RE.test(l) || OPTION_RE.test(lines[i])) break
    body.push(l)
  }
  return body.join(' ') || undefined
}

/** A tool's permission dialog ("Do you want to proceed?", "… make this edit …"): never one of {@link KNOWN}. */
const TOOL_PERMISSION_RE = /^Do you want to\b/i

/**
 * A dialog we may answer on the user's behalf, with how many Down (positive) or
 * Up (negative) presses reach the option we want. Null unless such a dialog is
 * actually drawn and the option we want is one of its choices.
 */
export function detectKnown(screen) {
  const numbered = parseDialog(screen)
  const dialog = numbered ?? parseKeyedDialog(screen)
  if (!dialog || TOOL_PERMISSION_RE.test(dialog.question ?? '')) return null
  const labels = numbered ? numbered.options.map((o) => o.label) : dialog.options
  const words = [dialog.question, dialog.description, dialog.body, ...labels].filter(Boolean).join('\n')
  for (const d of KNOWN) {
    if (!d.present.test(words)) continue
    const target = labels.findIndex((l) => d.choose.test(l))
    return target < 0 ? null : { name: d.name, moves: target - dialog.selected }
  }
  return null
}

/** Keys that move the ❯ cursor onto a detected dialog's option and confirm it. */
export function cursorKeys(moves) {
  const keys = []
  for (let i = 0; i < Math.abs(moves); i++) keys.push(moves > 0 ? 'Down' : 'Up')
  keys.push('Enter')
  return keys
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** How long to wait for a dialog that a hook announced but the terminal has not drawn yet. */
const APPEAR_TIMEOUT_MS = 900
const POLL_MS = 300
/** Claude Code needs a moment between the digit and Enter. */
const KEY_GAP_MS = 300

/** 'unfocused': the dialog is up but the prompt has the keyboard, so nothing was pressed. */

/** 'no-dialog' is normal (nothing to answer); 'no-option' means we saw the dialog but could not answer it. */

/** Broader than a one-time yes: answering this also covers future calls. */
const ALWAYS_RE = /don['’]?t ask again|always allow|항상/i
/** "Yes, allow reading from /X from this project" — still broader than one time. */
const PROJECT_WIDE_RE = /\b(project|directory|folder)\b/i
/**
 * Allowed only until this Claude process ends: Claude in Chrome's "Allow all actions on <site> for this session".
 * Not "allow all edits during this session (shift+tab)": that switches the session to acceptEdits, which outlives
 * 전부 허용 being turned off.
 */
const SESSION_RE = /\bactions on\b.*\bfor this session\b/i
const MODE_SWITCH_RE = /\bedits?\b|shift\s*\+\s*tab/i
const DENY_RE = /^(no|deny|cancel|reject)\b/i
const YES_RE = /^(yes|proceed|allow|continue)\b/i

/**
 * What answering this option means. Order matters: "Don't ask again for Bash"
 * reads as a deny if you only look at the leading word, but it is the broadest
 * allow there is, so the always-check runs first.
 */
export function classifyOption(label) {
  if (ALWAYS_RE.test(label)) return 'allow-always'
  if (DENY_RE.test(label)) return 'deny'
  // "Yes, allow all edits during this session (shift+tab)" switches the session to acceptEdits: not an allow of
  // this action at all. Other, so nothing picks it by kind (it was only safe by coming after a plain "Yes").
  if (MODE_SWITCH_RE.test(label) && /\b(all|during|session)\b|shift\s*\+\s*tab/i.test(label)) return 'other'
  // "Yes, and switch to auto mode": a yes that also changes how every later request is handled. Found by this
  // repository's end-to-end run.
  if (/\bswitch to\b.*\bmode\b/i.test(label)) return 'other'
  if (YES_RE.test(label)) return PROJECT_WIDE_RE.test(label) ? 'allow-always' : SESSION_RE.test(label) ? 'allow-session' : 'allow-once'
  return 'other'
}

/**
 * Is this the yes/no confirmation that gates a tool call, as opposed to an
 * AskUserQuestion or some other numbered list? A permission verdict may only
 * drive this kind, otherwise an unrelated dialog could be answered by accident.
 */
export function isProceedDialog(d) {
  const kinds = d.options.map((o) => classifyOption(o.label))
  return kinds.includes('deny') && kinds.some((k) => k === 'allow-once' || k === 'allow-session' || k === 'allow-always')
}

/**
 * Reads and answers terminal dialogs. Holds the only code in the app that
 * presses dialog keys, so "is that option actually on screen?" is asked once.
 */
export class DialogDriver {
  tmux
  log

  constructor(tmux, log = () => {}) {
    this.tmux = tmux
    this.log = log
  }

  async read(pane) {
    try {
      return parseDialog(await this.tmux.capture(pane))
    } catch (err) {
      this.log(`dialog read failed: ${err}`)
      return null
    }
  }

  /** Wait briefly for a dialog to be drawn; hooks can outrun the terminal. */
  async waitForDialog(pane, timeoutMs = APPEAR_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs
    let dialog = await this.read(pane)
    while (!dialog && Date.now() < deadline) {
      await sleep(POLL_MS)
      dialog = await this.read(pane)
    }
    return dialog
  }

  /**
   * Press an option by its number, but only if the dialog on screen offers it.
   * A stale button (its dialog already answered or gone) reports 'gone' and
   * sends nothing, so the digit can never land in the prompt as a message.
   */
  async answerNumber(pane, n) {
    const dialog = await this.waitForDialog(pane)
    if (!dialog || !dialog.options.some((o) => String(o.n) === n)) return 'gone'
    if (await this.press(pane, n)) return 'answered'
    // Not pressed: the prompt held the keys, or the dialog was closed by something else while pressing.
    return parseDialog(await this.tmux.capture(pane)) ? 'unfocused' : 'gone'
  }

  /** Press the first option whose label matches, if any. Returns the number pressed. */
  async answerMatching(pane, match, timeoutMs = APPEAR_TIMEOUT_MS) {
    const dialog = await this.waitForDialog(pane, timeoutMs)
    const hit = dialog?.options.find((o) => match.test(o.label))
    if (!hit) return null
    return (await this.press(pane, String(hit.n))) ? hit.n : null
  }

  /**
   * Answer the yes/no dialog that gates a tool call. Does nothing unless the
   * screen actually holds such a dialog, so a verdict for one request can never
   * answer an unrelated prompt that happens to be up.
   */
  /**
   * `auto` is 전부 허용: the widest allow that ends with the session ("for this session") when there is one,
   * else once. Never an option that is written into the settings ("don't ask again", "always", a whole project).
   */
  async answerProceed(pane, behavior, timeoutMs = 0) {
    // Default to a single capture: a verdict answers the dialog that is up *now*.
    // Waiting would let a verdict for one request answer the next request's dialog.
    const dialog = timeoutMs > 0 ? await this.waitForDialog(pane, timeoutMs) : await this.read(pane)
    if (!dialog || !isProceedDialog(dialog)) return 'no-dialog'
    const want = behavior === 'always' ? ['allow-always'] : behavior === 'allow' ? ['allow-once'] : behavior === 'auto' ? ['allow-session', 'allow-once'] : ['deny']
    const pick = want.map((k) => dialog.options.find((o) => classifyOption(o.label) === k)).find(Boolean)
    if (!pick) return 'no-option'
    return (await this.press(pane, String(pick.n))) ? 'answered' : 'unfocused'
  }

  /**
   * Answer a dialog we recognize, without involving the user. Returns its name,
   * or null when the screen holds no known dialog.
   */
  async confirmKnown(pane, screen, allow = null) {
    // detectKnown only answers a dialog that is drawn now, numbered or not (Claude Code draws folder trust
    // without numbers), and only when the choice it wants is one of that dialog's own. `allow`, when given, is the
    // names expected right now: text shaped like one of these dialogs in Claude's own answer is not one (R1-H2).
    const known = detectKnown(screen)
    if (!known || (allow && !allow.includes(known.name))) return null
    await this.tmux.sendKeys(pane, cursorKeys(known.moves))
    return known.name
  }

  /**
   * Press a digit, then Enter. Resolves false, having sent nothing that reaches the
   * session, when the prompt rather than the dialog has the keyboard.
   */
          async press(pane, n) {
    if (promptHoldsFocus(await this.tmux.capture(pane))) {
      this.log(`dialog on ${pane} is up but the prompt has focus; not pressing ${n}`)
      return false
    }
    const before = parseDialog(await this.tmux.capture(pane))?.question
    await this.tmux.sendKeys(pane, [n])
    await sleep(KEY_GAP_MS)
    const after = await this.tmux.capture(pane)
    // The digit alone can be the whole answer: one of several questions moves on to the next at once, and an
    // Enter after it would answer that next question with whatever line it starts on.
    // The digit landed in the prompt: take it back. Looked at before "the dialog moved on", because a dialog that
    // something else closed in the meantime (a hook's allow in 전부 허용) also moved on, and the digit left in the
    // input box was then sent in front of the next message ("11/compact …").
    const typed = after.split('\n').some((l) => new RegExp(`^\\s*❯\\s*${n}\\s*$`).test(l))
    if (typed) {
      await this.tmux.sendKeys(pane, ['BSpace'])
      this.log(`digit ${n} landed in the prompt on ${pane}; erased it`)
      return false
    }
    const now = parseDialog(after)
    if (before && (!now || now.question !== before)) return true
    await this.tmux.sendKeys(pane, ['Enter'])
    return true
  }
}

