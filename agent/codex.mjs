// The OpenAI Codex CLI as a session runner (REQ-F-851, docs/RUNNER-DESIGN.md). Codex keeps each conversation in a
// rollout file, `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, one JSON object a line
// ({timestamp, type, payload}). The agent reads only those files: never codex's login (auth.json) or its settings
// (config.toml). It turns them into lines of Claude Code's transcript shape in a copy of its own (the mirror), so the
// server, the page, sealing and line numbering read a codex conversation the way they read any other. The conversion
// is a pure function of the rollout: the same file always gives the same mirror, so the mirror can be made again from
// the start at any time (an agent that restarts does).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { riskyCall, bridgeSelfCall } from './guard.mjs'

export const CODEX = Object.freeze({ id: 'codex', name: 'Codex', caps: Object.freeze(['cards', 'autoAllow']) })

/** Where codex keeps its conversations: $CODEX_HOME (as the agent was started with), else ~/.codex. */
export const codexHome = (env = process.env, home = os.homedir()) => (env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(home, '.codex'))
export const sessionsRoot = (env, home) => path.join(codexHome(env, home), 'sessions')

/** Codex's conversation ids (UUID, v7 these days): the only thing put in a file name or on a command line. */
export const CODEX_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ROLLOUT_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})\.jsonl$/

/** The id in a rollout file's name, or null. */
export function rolloutId(file) {
  const m = ROLLOUT_RE.exec(path.basename(String(file)))
  return m && CODEX_ID_RE.test(m[1]) ? m[1] : null
}

// ---------- the command ----------

/** Model names codex takes (`-m`): letters, digits and . _ - only. */
export const CODEX_MODEL_RE = /^[\w.-]{1,60}$/

/**
 * The sandbox and approval mode a codex session starts with (REQ-F-854), as one string `<sandbox>:<approval>[:net]`.
 * Either part may be empty: codex's own default (config.toml) for it, as before 1.414. '' is both defaults.
 * danger-full-access and --dangerously-bypass-… are never taken. `:net` (network in the sandbox) only with workspace-write.
 */
export const CODEX_SANDBOXES = Object.freeze(['read-only', 'workspace-write'])
// codex-cli 0.166 lists only these two for -a (`untrusted` is not one of its values any more).
export const CODEX_APPROVALS = Object.freeze(['on-request', 'never'])

/** The mode string read: { sandbox, approval, network }, or null when it is not one. */
export function parseCodexMode(v) {
  if (v == null || v === '') return { sandbox: '', approval: '', network: false }
  if (typeof v !== 'string') return null
  const m = /^([a-z-]*):([a-z-]*)(:net)?$/.exec(v)
  if (!m) return null
  const [, sandbox, approval, net] = m
  if (sandbox && !CODEX_SANDBOXES.includes(sandbox)) return null
  if (approval && !CODEX_APPROVALS.includes(approval)) return null
  if (net && sandbox !== 'workspace-write') return null
  return { sandbox, approval, network: !!net }
}

/** The mode as it is kept: '' for both defaults. */
export const codexModeStr = (m) => (!m || (!m.sandbox && !m.approval) ? '' : `${m.sandbox}:${m.approval}${m.network && m.sandbox === 'workspace-write' ? ':net' : ''}`)

/**
 * The arguments codex starts with. `resume`: the conversation id to go on with (`codex resume <id>`). The folder is the
 * terminal's (tmux -c), not an argument. Nothing here comes from the server unchecked: the id and the model are
 * checked by shape, the prompt is one argument, and the sandbox and approval are only the ones parseCodexMode takes
 * (never danger-full-access or the bypass flag).
 * @param {{ resume?: string|null, model?: string, prompt?: string, instructions?: string, mode?: string }} o
 */
export function codexArgs({ resume = null, model, prompt, instructions, cwd, mode } = {}) {
  const out = []
  if (resume) {
    if (!CODEX_ID_RE.test(resume)) throw new Error('codex 대화 id 가 올바르지 않아요')
    out.push('resume', resume)
  }
  // Its own process, not a client of codex's background daemon: closing the session's terminal ends its work, as with
  // claude (with the daemon a turn went on after the terminal was gone). No update check at start.
  out.push('--no-daemon', '-c', 'check_for_update_on_startup=false')
  // The folder the session was asked for is trusted for this run only (config.toml is not written), as claude's folder
  // trust is answered for a bridge session: its question comes seconds after the input box, and what is typed then is lost.
  if (cwd) out.push('-c', `projects.${JSON.stringify(String(cwd))}.trust_level="trusted"`)
  if (model && CODEX_MODEL_RE.test(model)) out.push('-m', model)
  // The sandbox and approval asked for (REQ-F-854); none is codex's default. A resume takes them too, so a conversation
  // another tool wrote as workspace-write opens in the mode chosen here, not codex's default.
  if (mode) {
    const m = parseCodexMode(mode)
    if (!m) throw new Error('codex 샌드박스·승인 모드가 올바르지 않아요')
    if (m.sandbox) out.push('-s', m.sandbox)
    if (m.approval) out.push('-a', m.approval)
    if (m.network) out.push('-c', 'sandbox_workspace_write.network_access=true')
  }
  // The bridge's instructions to the model, as developer instructions for this run only (config.toml is not touched).
  if (instructions) out.push('-c', `developer_instructions=${JSON.stringify(String(instructions))}`)
  if (prompt) out.push(String(prompt))
  return out
}

// ---------- finding the rollout ----------

/** The rollout files of the last `days` days, newest folder first. */
function recentFiles(root, days = 2, now = Date.now()) {
  const out = []
  const seen = new Set()
  for (let d = 0; d <= days; d++) {
    const t = new Date(now - d * 86_400_000)
    // Codex names the day folder by local time.
    const dir = path.join(root, String(t.getFullYear()), String(t.getMonth() + 1).padStart(2, '0'), String(t.getDate()).padStart(2, '0'))
    if (seen.has(dir)) continue
    seen.add(dir)
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {}
    for (const n of names) if (ROLLOUT_RE.test(n)) out.push(path.join(dir, n))
  }
  return out
}

/** A rollout's first line, if it is its session_meta: { id, cwd, at }. */
export function rolloutMeta(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    // session_meta carries codex's base instructions: it can be well past 64 KB.
    const buf = Buffer.alloc(512 * 1024)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    const end = buf.subarray(0, n).indexOf(0x0a)
    const o = JSON.parse(buf.subarray(0, end < 0 ? n : end).toString('utf8'))
    if (o?.type !== 'session_meta') return null
    const p = o.payload ?? {}
    return { id: String(p.id ?? p.session_id ?? ''), cwd: String(p.cwd ?? ''), at: Date.parse(p.timestamp ?? o.timestamp) || 0, originator: String(p.originator ?? ''), threadSource: String(p.thread_source ?? 'user'), forked: !!(p.forked_from_id || p.history_base) }
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/**
 * The rollout a codex that this agent just started is writing: one made in the session's folder after it started,
 * that no other session has. Codex picks its own id (it takes none from outside), so the file is found, not named.
 * @param {{ root: string, cwd: string, since: number, taken: Set<string> }} o
 */
export function findNewRollout({ root, cwd, since, taken }) {
  let best = null
  for (const f of recentFiles(root, 1)) {
    const id = rolloutId(f)
    if (!id || taken.has(id)) continue
    let st
    try {
      st = fs.statSync(f)
    } catch {
      continue
    }
    if (st.birthtimeMs < since - 2000 && st.mtimeMs < since) continue
    const m = rolloutMeta(f)
    // The terminal codex's own thread: not one it starts for itself (a title) or a fork.
    if (!m || m.id !== id || m.cwd !== cwd || m.at < since - 2000 || m.originator !== 'codex-tui' || m.threadSource !== 'user' || m.forked) continue
    if (!best || m.at < best.at) best = { file: f, id, at: m.at }
  }
  return best
}

/** The rollout of a conversation id on this Mac, or null. */
export function findRollout(root, id) {
  if (!CODEX_ID_RE.test(String(id))) return null
  const want = `-${id}.jsonl`
  let years = []
  try {
    years = fs.readdirSync(root).filter((y) => /^\d{4}$/.test(y)).sort().reverse()
  } catch {
    return null
  }
  for (const y of years) {
    for (const m of safeList(path.join(root, y)).filter((x) => /^\d{2}$/.test(x)).sort().reverse()) {
      for (const d of safeList(path.join(root, y, m)).filter((x) => /^\d{2}$/.test(x)).sort().reverse()) {
        const hit = safeList(path.join(root, y, m, d)).find((n) => n.endsWith(want) && ROLLOUT_RE.test(n))
        if (hit) return path.join(root, y, m, d, hit)
      }
    }
  }
  return null
}
/**
 * Every rollout on this Mac (the 맥의 대화 가져오기 list, REQ-F-853): { id, file, mtime, size }, newest written first.
 * Only names and stat are read here; a resumed conversation keeps writing its first day's file, so every day is looked at.
 */
export function listRollouts(root) {
  const out = []
  for (const y of safeList(root).filter((x) => /^\d{4}$/.test(x)))
    for (const m of safeList(path.join(root, y)).filter((x) => /^\d{2}$/.test(x)))
      for (const d of safeList(path.join(root, y, m)).filter((x) => /^\d{2}$/.test(x)))
        for (const n of safeList(path.join(root, y, m, d))) {
          const id = rolloutId(n)
          if (!id) continue
          const file = path.join(root, y, m, d, n)
          try {
            const st = fs.statSync(file)
            if (st.isFile() && st.size > 0) out.push({ id, file, mtime: st.mtimeMs, size: st.size })
          } catch {}
        }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/**
 * What the list shows of a rollout: its folder (session_meta), and the first and last thing the person said. Only the
 * start and the end of the file are read. `user`: a conversation a person had (not a thread codex started for itself).
 */
export function rolloutInfo(file, size) {
  const meta = rolloutMeta(file)
  const read = (from, len) => {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(Math.max(0, Math.min(len, size - from)))
      const n = fs.readSync(fd, buf, 0, buf.length, from)
      return buf.subarray(0, n).toString('utf8').split('\n')
    } finally {
      fs.closeSync(fd)
    }
  }
  const said = (l) => {
    let o
    try {
      o = JSON.parse(l)
    } catch {
      return ''
    }
    const p = o?.payload
    if (o?.type !== 'response_item' || p?.type !== 'message' || p.role !== 'user') return ''
    const t = textOf(p.content, 'input_text')
    return !t.trim() || hiddenUserText(t) ? '' : t.replace(/\s+/g, ' ').trim().slice(0, 160)
  }
  let head = []
  let tail = []
  try {
    head = read(0, 512 * 1024)
    tail = size > 512 * 1024 ? read(size - 65536, 65536).slice(1) : []
  } catch {}
  const all = [...head, ...tail]
  return {
    id: meta?.id ?? '',
    cwd: meta?.cwd ?? '',
    user: !!meta && meta.threadSource === 'user',
    first: head.map(said).find(Boolean) ?? '',
    last: [...all].reverse().map(said).find(Boolean) ?? '',
  }
}

const safeList = (dir) => {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

// ---------- rollout → Claude Code's transcript lines ----------

/** What codex puts in the conversation for the model, not said by anyone: never shown. */
const WRAPPED_RE = /^\s*<([a-z][a-z0-9_-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>\s*$/
const HIDDEN_HEAD_RE = /^\s*(# AGENTS\.md instructions|<environment_context>|<user_instructions>|<turn_aborted>|<skills_instructions>|<permissions instructions>)/
export const hiddenUserText = (t) => WRAPPED_RE.test(t) || HIDDEN_HEAD_RE.test(t)

/** A stable id for a mirror line: the same rollout line always gets the same one. */
const lineId = (sid, off, i) => {
  const h = crypto.createHash('sha256').update(`${sid}:${off}:${i}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

const textOf = (content, kind) =>
  (Array.isArray(content) ? content : [])
    .filter((c) => c && c.type === kind && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')

const parseArgs = (s) => {
  if (s && typeof s === 'object') return s
  try {
    const v = JSON.parse(String(s ?? ''))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { input: String(s ?? '') }
  } catch {
    return { input: String(s ?? '') }
  }
}

/** The files an apply_patch touches, from its `*** … File: path` lines. */
export function patchFiles(patch) {
  return [...String(patch ?? '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim())
}

/** A codex tool call as Claude Code's tool_use: the page already knows how to draw these. */
export function toolUse(name, rawArgs, id) {
  const a = parseArgs(rawArgs)
  const shell = (cmd) => ({ type: 'tool_use', id, name: 'Bash', input: { command: Array.isArray(cmd) ? cmd.join(' ') : String(cmd ?? ''), ...(a.justification ? { description: String(a.justification) } : {}) } })
  if (['exec_command', 'shell', 'shell_command', 'container.exec', 'local_shell'].includes(name)) return shell(a.cmd ?? a.command)
  if (name === 'apply_patch') {
    const patch = typeof a.input === 'string' ? a.input : String(a.patch ?? '')
    const files = patchFiles(patch)
    return { type: 'tool_use', id, name: 'Edit', input: { file_path: files[0] ?? '', ...(files.length > 1 ? { files } : {}), patch } }
  }
  if (name === 'update_plan' && Array.isArray(a.plan)) {
    const todos = a.plan.slice(0, 100).map((p) => ({ content: String(p?.step ?? ''), status: ['pending', 'in_progress', 'completed'].includes(p?.status) ? p.status : 'pending', activeForm: String(p?.step ?? '') }))
    return { type: 'tool_use', id, name: 'TodoWrite', input: { todos } }
  }
  return { type: 'tool_use', id, name: String(name || 'tool').slice(0, 80), input: a }
}

const outputOf = (o) => {
  if (typeof o === 'string') return { text: o, error: false }
  if (o && typeof o === 'object') return { text: typeof o.content === 'string' ? o.content : JSON.stringify(o.content ?? o), error: o.success === false }
  return { text: '', error: false }
}

/**
 * A token_count event → the session's usage, the shape Claude Code's status line gives (REQ-F-855): context from the
 * last call's tokens over the model's window, the 5-hour and weekly limits from rate_limits (each told apart by its
 * window_minutes; resets_at is in seconds). A part the event leaves out (rate_limits null) keeps what `prev` had.
 */
export function codexUsage(p, prev = null) {
  const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null)
  const u = { context: null, window: null, fiveHour: null, week: null, cost: null, fiveHourResetsAt: null, weekResetsAt: null, ...(prev ?? {}) }
  const info = p?.info
  const win = Number(info?.model_context_window) || 0
  const used = Number(info?.last_token_usage?.total_tokens)
  if (win > 0) u.window = win
  if (win > 0 && Number.isFinite(used) && used >= 0) u.context = Math.min(100, Math.round((used / win) * 100))
  const rl = p?.rate_limits
  if (rl && typeof rl === 'object') {
    for (const [k, l] of [['primary', rl.primary], ['secondary', rl.secondary]]) {
      if (!l || typeof l !== 'object' || pct(l.used_percent) == null) continue
      const m = Number(l.window_minutes)
      const week = m ? m >= 24 * 60 : k === 'secondary'
      const at = Number(l.resets_at) * 1000 || null
      if (week) Object.assign(u, { week: pct(l.used_percent), weekResetsAt: at })
      else Object.assign(u, { fiveHour: pct(l.used_percent), fiveHourResetsAt: at })
    }
  }
  return u
}

/**
 * One rollout line → what it gives: Claude Code transcript lines (objects) and turn signals ('begin', 'end').
 * `st` carries what earlier lines said (the model in use) and is changed in place.
 * @param {object} o the parsed rollout line
 * @param {{ sid: string, off: number, st: { model?: string } }} c
 */
export function convertLine(o, { sid, off, st }) {
  const out = []
  const signals = []
  const at = typeof o?.timestamp === 'string' ? o.timestamp : undefined
  const p = o?.payload ?? {}
  const base = (i) => ({ uuid: lineId(sid, off, i), timestamp: at, sessionId: sid })
  const user = (content) => out.push({ type: 'user', ...base(out.length), message: { role: 'user', content } })
  const assistant = (content, model = st.model || 'codex') => out.push({ type: 'assistant', ...base(out.length), message: { role: 'assistant', model, content } })
  if (o?.type === 'turn_context' && typeof p.model === 'string') st.model = p.model.slice(0, 60)
  if (o?.type === 'event_msg') {
    if (p.type === 'task_started' || p.type === 'turn_started') signals.push('begin')
    else if (p.type === 'task_complete' || p.type === 'turn_complete') signals.push('end')
    else if (p.type === 'turn_aborted') signals.push('aborted')
    else if (p.type === 'token_count') st.usage = codexUsage(p, st.usage)
    else if (p.type === 'error' && typeof p.message === 'string') assistant([{ type: 'text', text: `⚠️ codex: ${p.message.slice(0, 2000)}` }], '<synthetic>')
  }
  if (o?.type === 'response_item') {
    if (p.type === 'message' && p.role === 'user') {
      const t = textOf(p.content, 'input_text')
      if (t.trim() && !hiddenUserText(t)) user(t)
    } else if (p.type === 'message' && p.role === 'assistant') {
      const t = textOf(p.content, 'output_text')
      if (t.trim()) assistant([{ type: 'text', text: t }])
    } else if ((p.type === 'function_call' || p.type === 'custom_tool_call') && p.call_id) {
      assistant([toolUse(p.name, p.type === 'custom_tool_call' ? { input: p.input } : p.arguments, String(p.call_id))])
    } else if (p.type === 'local_shell_call' && p.call_id) {
      assistant([toolUse('local_shell', { command: p.action?.command }, String(p.call_id))])
    } else if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && p.call_id) {
      const r = outputOf(p.output)
      user([{ type: 'tool_result', tool_use_id: String(p.call_id), content: r.text, ...(r.error ? { is_error: true } : {}) }])
    } else if (p.type === 'web_search_call') {
      // Done when it is written: its result is part of the answer that follows.
      const id = `ws-${lineId(sid, off, 9)}`
      const q = p.action?.query ?? p.action?.queries?.[0] ?? ''
      assistant([{ type: 'tool_use', id, name: 'WebSearch', input: { query: String(q) } }])
      user([{ type: 'tool_result', tool_use_id: id, content: String(q) }])
    }
  }
  return { lines: out, signals }
}

/**
 * Brings the mirror up to date with the rollout. `state` is the session's: { off } is how far the rollout has been
 * read (bytes), { st } what conversion carries. With no `off` yet (a new agent, a mirror that is gone, a rollout that
 * shrank) the mirror is made again from the start, into a temporary file renamed over it. Only whole lines are read.
 * Returns the turn signals of the lines read now, and whether the mirror was made again (whose signals tell only
 * whether a turn is open at its end).
 * @param {{ rollout: string, mirror: string, sid: string, state: { off?: number, st?: object } }} o
 */
export function syncMirror({ rollout, mirror, sid, state }) {
  let size
  try {
    size = fs.statSync(rollout).size
  } catch {
    return { signals: [], rebuilt: false, missing: true }
  }
  const rebuild = state.off == null || size < state.off || !fs.existsSync(mirror)
  if (rebuild) Object.assign(state, { off: 0, st: {} })
  if (size === state.off) return { signals: [], rebuilt: false }
  const fd = fs.openSync(rollout, 'r')
  const signals = []
  const parts = []
  try {
    let pos = state.off
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(size - pos, 8 * 1024 * 1024))
      const n = fs.readSync(fd, buf, 0, buf.length, pos)
      const end = buf.subarray(0, n).lastIndexOf(0x0a)
      if (end < 0) break
      let at = 0
      for (const raw of buf.subarray(0, end).toString('utf8').split('\n')) {
        const off = pos + at
        at += Buffer.byteLength(raw) + 1
        if (!raw.trim()) continue
        let o
        try {
          o = JSON.parse(raw)
        } catch {
          continue
        }
        const r = convertLine(o, { sid, off, st: (state.st ??= {}) })
        for (const l of r.lines) parts.push(JSON.stringify(l))
        signals.push(...r.signals)
      }
      pos += end + 1
      if (end + 1 < n && n === buf.length) continue
      if (end + 1 < n) break
    }
    state.off = pos
  } finally {
    fs.closeSync(fd)
  }
  const text = parts.length ? `${parts.join('\n')}\n` : ''
  if (rebuild) {
    fs.mkdirSync(path.dirname(mirror), { recursive: true, mode: 0o700 })
    const tmp = `${mirror}.${process.pid}.tmp`
    fs.writeFileSync(tmp, text, { mode: 0o600 })
    fs.renameSync(tmp, mirror)
    return { signals: turnOpenAt(signals) ? ['begin'] : [], rebuilt: true }
  }
  if (text) fs.appendFileSync(mirror, text, { mode: 0o600 })
  return { signals, rebuilt: false }
}

/** Whether the last turn signal leaves a turn open. */
export const turnOpenAt = (signals) => {
  for (let i = signals.length - 1; i >= 0; i--) if (signals[i] !== 'begin') return false
  else return true
  return false
}

// ---------- the screen ----------

/** Codex says it is working on the line above its input box: "• Working (12s • esc to interrupt)". */
export const CODEX_WORKING_RE = /\((?:\d+[hms]\s*)+[^)]*esc to interrupt\)|^\s*[•◦]\s+\S.*\(\d+s\b/m
/** The input box, empty: "› Ask Codex to do anything" (the placeholder) or a bare "›" as the last prompt line. */
const EMPTY_BOX_RE = /^\s*›\s*(Ask Codex to do anything|Implement \{feature\}|Find and fix a bug in @filename|Explain this codebase|Summarize recent commits|Write tests for @filename|Improve documentation in @filename|Run \/review on my current changes|Use \/skills to list available skills)?\s*$/m

/** 'idle' when codex waits with nothing typed and nothing running; null otherwise. */
export function codexIdle(screen) {
  return EMPTY_BOX_RE.test(screen) && !CODEX_WORKING_RE.test(screen) && !parseApproval(screen) && !trustDialog(screen) ? 'idle' : null
}

/** The folder trust question codex asks the first time it runs in a folder. */
export const trustDialog = (screen) => /Trust this folder\?/.test(screen) && /^\s*›?\s*1\.\s+Trust and continue/m.test(screen)

/** Whether `head` (the start of what was typed) is still in the input box: the last "›" line and the lines under it. */
export function codexBoxHas(screen, head) {
  if (!head) return false
  const lines = screen.split('\n')
  const i = lines.findLastIndex((l) => /^\s*›\s/.test(l))
  if (i < 0) return false
  return lines.slice(i, i + 6).join('\n').includes(head) && !CODEX_WORKING_RE.test(lines.slice(i).join('\n'))
}

// ---------- slash commands ----------
// Codex draws what a slash command shows (/status, /mcp, …) only on its screen: nothing of it goes into the rollout,
// so the page would see no answer. Some commands open a full-screen pager (/diff: "q close") or a picker (/model:
// "enter select · esc back") that stays open and takes whatever is typed next. The agent reads these off the screen.

/** A note holds 2,000 characters (the server cuts there): what a command showed is cut first, so the note stays whole. */
const SLASH_MAX = 1600
const tidy = (lines) => {
  const out = []
  for (const l of lines.map((x) => x.replace(/\s+$/, ''))) if (l || (out.length && out[out.length - 1])) out.push(l)
  while (out.length && !out[out.length - 1]) out.pop()
  const text = out.join('\n')
  return text.length > SLASH_MAX ? `${text.slice(0, SLASH_MAX)}\n…` : text
}
/** The last few lines with something on them: where codex puts a view's key hints. */
const footer = (lines, n = 4) => lines.filter((l) => l.trim()).slice(-n)

/** How many times `cmd` stands alone on a line, as codex echoes a slash command into its history. */
export const slashEchoes = (screen, cmd) => screen.split('\n').filter((l) => l.trimEnd() === String(cmd).trim()).length

/**
 * What a slash command printed into codex's history: the lines under its last echo, down to the input box (the last
 * "›" line). Null while the echo or the box below it is not on screen.
 */
export function slashOutput(screen, cmd) {
  const lines = screen.split('\n')
  const box = lines.findLastIndex((l) => /^\s*›(\s|$)/.test(l))
  if (box < 0) return null
  const echo = lines.slice(0, box).findLastIndex((l) => l.trimEnd() === String(cmd).trim())
  if (echo < 0) return null
  return tidy(lines.slice(echo + 1, box))
}

/** Codex's full-screen pager (/diff and the like): the page on screen without its title and key hints, and whether there is more. */
export function codexPager(screen) {
  const lines = screen.split('\n')
  const foot = footer(lines)
  if (!foot.some((l) => /^\s*q close\s*$/.test(l)) || !foot.some((l) => /to scroll/.test(l))) return null
  const rule = lines.findLastIndex((l) => /^─{8,}.*%/.test(l.trim()))
  const body = lines.slice(0, rule < 0 ? lines.length : rule).filter((l) => !/^~\s*$/.test(l))
  if (body.length && /^\/(?: \S)+ \//.test(body[0])) body.shift()
  const pct = rule < 0 ? null : /(\d+)%/.exec(lines[rule])?.[1]
  return { text: tidy(body), more: pct != null && Number(pct) < 100 }
}

/** A picker codex opened in place of the input box (/model, /permissions …): its lines up to a wide gap. */
export function codexPicker(screen) {
  if (parseApproval(screen) || trustDialog(screen)) return null
  const lines = screen.split('\n')
  const foot = footer(lines, 2)
  if (!foot.some((l) => /\benter (?:to )?select\b/i.test(l) || /\besc (?:to )?(?:go )?back\b/i.test(l))) return null
  const at = lines.findLastIndex((l) => l === foot[foot.length - 1])
  const body = []
  let blanks = 0
  for (let i = at - 1; i >= 0 && body.length < 30; i--) {
    if (!lines[i].trim()) {
      if (++blanks >= 3) break
    } else blanks = 0
    body.unshift(lines[i])
  }
  return { text: tidy(body.filter((l) => !/^\s*[↑↓]\s*$/.test(l))) }
}

/**
 * Codex's approval question ("Would you like to run the following command?", "… make the following edits?", …) with
 * its options. Each option ends with the key that picks it — "(y)", "(p)", "(esc)" — and that key, not a number, is
 * what answering presses. Null when no such question is on screen.
 */
export function parseApproval(screen) {
  const lines = screen.split('\n')
  const foot = lines.findLastIndex((l) => /Press enter to confirm or esc to cancel/i.test(l))
  if (foot < 0) return null
  const opts = []
  let first = -1
  for (let i = foot - 1; i >= 0 && i >= foot - 12; i--) {
    const m = /^\s*(›\s*)?(\d+)\.\s+(.*?)\s*\(([a-z]|esc)\)\s*$/i.exec(lines[i])
    if (m) {
      opts.unshift({ n: Number(m[2]), label: m[3], key: m[4].toLowerCase() === 'esc' ? 'Escape' : m[4].toLowerCase(), selected: !!m[1] })
      first = i
    } else if (opts.length && lines[i].trim()) break
  }
  if (!opts.length) return null
  // The question sits above the command, which can run to any length (a heredoc script): look up to the last thing
  // the person typed into the history ("› …"), not a fixed number of lines.
  let q = -1
  let typed = -1
  for (let i = first - 1; i >= 0; i--) {
    if (/^\s*(Would you like|Do you want|Allow)\b.*\?\s*$/.test(lines[i])) {
      q = i
      break
    }
    if (/^\s*›\s/.test(lines[i])) {
      typed = i
      break
    }
  }
  // A command too long for the screen pushes the question off its top: the footer and the keyed options are enough
  // to know codex waits for an answer, so the card says so and shows what is still on screen.
  const top = q >= 0 ? q : Math.max(typed, first - APPROVAL_CONTEXT_LINES - 1, -1)
  const question = q >= 0 ? lines[q].trim() : APPROVAL_UNKNOWN
  const context = lines
    .slice(top + 1, first)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
  return { question, context, options: opts }
}

/** The card's title when codex's question line is not on screen (a command longer than the terminal). */
export const APPROVAL_UNKNOWN = 'Codex 가 터미널에서 승인을 기다려요'
/** How many lines above the options the card shows as context when the question line is not on screen. */
const APPROVAL_CONTEXT_LINES = 30

/**
 * What 전부 허용 answers a codex approval with (REQ-F-856): the option that allows this once ("Yes, proceed"), never
 * one that allows from then on ("don't ask again") nor a refusal; null when there is none. `tools` are the calls the
 * risk check (guard.mjs riskyCall) reads: a command is the one after "$ " with its lines; an edit is every file it names
 * as an Edit (so a shell start file or a secret is judged as the file it is, 1.420) plus the whole text as a command.
 * `unknown` says why the kind or the targets could not be read for sure: 안전한 전부 허용 then asks (1.420).
 */
export function codexAutoAnswer(a) {
  if (!a) return null
  const yes = a.options.find((o) => o.key !== 'Escape' && /^yes\b/i.test(o.label) && !/don'?t ask|always|session/i.test(o.label))
  if (!yes) return null
  const lines = a.context.split('\n')
  const at = lines.findIndex((l) => l.startsWith('$ '))
  const whole = { name: 'Bash', input: { command: `${a.question}\n${a.context}` } }
  if (at >= 0) {
    const tool = { name: 'Bash', input: { command: lines.slice(at).join('\n').slice(2) } }
    return { option: yes, tool, tools: [tool], unknown: null }
  }
  if (/\bedits?\b|\bpatch\b/i.test(a.question)) {
    const files = codexEditFiles(a.context)
    const tools = [whole, ...files.map((f) => ({ name: 'Edit', input: { file_path: f } }))]
    return { option: yes, tool: whole, tools, unknown: files.length ? null : '대상 파일을 알 수 없는 수정' }
  }
  return { option: yes, tool: whole, tools: [whole], unknown: '종류를 알 수 없는 승인' }
}

/**
 * Every word of an edit approval that may be a file: one with a "/", a dot file (".zshrc") or a name with an
 * extension. Words of the diff itself may come along too; they only make the check ask more, never less.
 */
export function codexEditFiles(text) {
  const out = new Set()
  for (let w of String(text ?? '').split(/[\s'"`()[\]{},;]+/)) {
    w = w.replace(/^[+\-*•└├│>]+/, '').replace(/[:.]+$/, '')
    if (!w || /^[a-z][a-z0-9+.-]*:\/\//i.test(w)) continue
    if (w.includes('/') || /^\.[\w-][\w.-]*$/.test(w) || /^[\w@+-]+(\.[\w-]+)+$/.test(w)) out.add(w)
  }
  return [...out]
}

/**
 * Why 전부 허용 must ask about this approval in the mode the session is in now, or null to answer it (REQ-F-856):
 * 전부 허용 asks only for what is the Mac terminal's own (bridgeSelfCall); 안전한 전부 허용 also for a question pushed
 * off the screen, an approval whose kind or files are not known, and a risky call. 'off' when 전부 허용 is not on.
 * Judged again right before the key, with the mode as it is then (1.420).
 */
export function codexAutoRisk(a, pick, { autoAllow, allowAll, cwd = '', home = '' }) {
  if (!autoAllow) return 'off'
  const first = (f) => pick.tools.map(f).find(Boolean) ?? null
  if (allowAll) return first(bridgeSelfCall)
  if (a.question === APPROVAL_UNKNOWN) return '화면에 다 보이지 않는 명령'
  return pick.unknown ?? first((t) => riskyCall(t, { cwd, home }))
}

/**
 * One approval as a whole (question, context, option labels): the same string only while the very same window is on
 * screen. 전부 허용 compares it again right before it sends its key (REQ-F-856 rule 6); null for no approval.
 */
export const codexApprovalSig = (a) => (a ? `codex|${a.question}|${a.context}|${a.options.map((o) => o.label).join('|')}` : null)
