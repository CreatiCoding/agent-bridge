// Codex's `exec` tool (REQ-F-862): newer codex runs its shell commands and patches as a small JavaScript program,
// `text(await tools.exec_command({cmd:"…"}))`, and answers with a JSON list of text parts whose last one is the
// command's own JSON ({exit_code, wall_time_seconds, output}). Drawn as written, both were unreadable. Here the
// program becomes what it does (a Bash command, an Edit patch) and the answer becomes the command's output.
// Pure functions: also run by the unit tests under Node.

export type ExecCall = { fn: string; cmd?: string; workdir?: string; why?: string; patch?: string }
export type ToolFace = { name: string; label: string; detail?: string; input?: string; lang?: string }
export type ExecOutput = { text: string; exit?: number; secs?: number }

const SHELL = ['exec_command', 'shell', 'shell_command', 'local_shell', 'container.exec']
const ESC: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' }

/** A JS string literal ("…", '…' or `…`) starting at `i`: its value and where it ends, or null. */
export function readString(src: string, i: number): { value: string; end: number } | null {
  const q = src[i]
  if (q !== '"' && q !== "'" && q !== '`') return null
  let out = ''
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j]
    if (c === q) return { value: out, end: j + 1 }
    if (q === '`' && c === '$' && src[j + 1] === '{') return null
    if (c !== '\\') {
      out += c
      continue
    }
    const n = src[++j]
    if (n === undefined) return null
    if (n === 'u' && src[j + 1] === '{') {
      const k = src.indexOf('}', j)
      if (k < 0) return null
      out += String.fromCodePoint(parseInt(src.slice(j + 2, k), 16) || 0xfffd)
      j = k
    } else if (n === 'u' || n === 'x') {
      const len = n === 'u' ? 4 : 2
      const hex = src.slice(j + 1, j + 1 + len)
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) return null
      out += String.fromCharCode(parseInt(hex, 16))
      j += len
    } else if (n === '\n') {
      // A line continuation adds nothing.
    } else out += ESC[n] ?? n
  }
  return null
}

/** A string, or a list of strings (["bash","-lc","…"] → the script), at `i`. */
function readCmd(src: string, i: number): string | undefined {
  const s = readString(src, i)
  if (s) return s.value
  if (src[i] !== '[') return undefined
  const parts: string[] = []
  let j = i + 1
  while (j < src.length) {
    while (/[\s,]/.test(src[j] ?? '')) j++
    if (src[j] === ']' || j >= src.length) break
    const p = readString(src, j)
    if (!p) return undefined
    parts.push(p.value)
    j = p.end
  }
  const sh = parts.findIndex((p) => p === '-lc' || p === '-c')
  return sh > 0 && /(^|\/)(ba|z|da)?sh$/.test(parts[0]) && parts[sh + 1] !== undefined ? parts.slice(sh + 1).join(' ') : parts.join(' ')
}

/** The `tools.*(…)` calls a codex exec program makes, with what each was given. */
export function execCalls(code: string): ExecCall[] {
  const out: ExecCall[] = []
  const re = /\btools\.([A-Za-z_][\w.]*)\s*\(\s*/g
  const starts = [...code.matchAll(re)]
  starts.forEach((m, n) => {
    const fn = m[1]
    const at = (m.index ?? 0) + m[0].length
    const end = n + 1 < starts.length ? (starts[n + 1].index ?? code.length) : code.length
    const c: ExecCall = { fn }
    const s = readString(code, at)
    if (s) {
      if (fn === 'apply_patch') c.patch = s.value
      else c.cmd = s.value
    } else if (code[at] === '{') {
      const body = code.slice(at, end)
      const key = (names: string) => {
        const k = new RegExp(`[{,\\s]["']?(?:${names})["']?\\s*:\\s*`).exec(body)
        return k ? readCmd(body, k.index + k[0].length) : undefined
      }
      const cmd = key('cmd|command')
      const workdir = key('workdir|cwd')
      const why = key('justification|description')
      const patch = key('input|patch')
      if (cmd !== undefined) c.cmd = cmd
      if (workdir) c.workdir = workdir
      if (why) c.why = why
      if (fn === 'apply_patch' && patch !== undefined) c.patch = patch
    }
    out.push(c)
  })
  return out
}

/** The files an apply_patch touches, from its `*** … File: path` lines. */
export const patchFiles = (patch: string) => [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim())

const firstLine = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('//')) ?? ''
const more = (n: number) => (n > 1 ? ` (+${n - 1})` : '')

/**
 * A codex `exec` call as what it does. `input` is the call's input as the page received it (JSON with the program
 * under `input`). Null when it is not one (another tool, input that is not JSON, a program that cannot be read).
 */
export function codexExecFace(name: string, input: string | undefined): ToolFace | null {
  if (name !== 'exec' || !input) return null
  let code = ''
  try {
    const o = JSON.parse(input) as Record<string, unknown>
    const v = o?.input ?? o?.code ?? o?.script
    if (typeof v === 'string') code = v
  } catch {
    return null
  }
  if (!code.trim()) return null
  const calls = execCalls(code)
  const shell = calls.length > 0 && calls.every((c) => SHELL.includes(c.fn) && c.cmd !== undefined)
  if (shell) {
    const command = calls.map((c) => c.cmd).join('\n')
    const why = calls.find((c) => c.why)?.why
    const workdir = calls.find((c) => c.workdir)?.workdir
    const i: Record<string, string> = { command }
    if (why) i.description = why
    if (workdir) i.workdir = workdir
    return { name: 'Bash', label: firstLine(calls[0].cmd!) + more(calls.length), detail: command, input: JSON.stringify(i) }
  }
  const patch = calls.length > 0 && calls.every((c) => c.fn === 'apply_patch' && c.patch !== undefined)
  if (patch) {
    const text = calls.map((c) => c.patch).join('\n')
    const files = patchFiles(text)
    return { name: 'Edit', label: (files[0] ?? 'apply_patch') + more(files.length), detail: text, input: JSON.stringify({ file_path: files[0] ?? '', ...(files.length > 1 ? { files } : {}), patch: text }), lang: 'diff' }
  }
  const fns = [...new Set(calls.map((c) => c.fn))]
  return { name: 'exec', label: fns.length ? fns.join(' · ') : firstLine(code), detail: code, input, lang: 'js' }
}

/** Codex exec's answer → the command's output, its exit code and time. Null when it is not that shape. */
export function codexExecOutput(text: string | undefined): ExecOutput | null {
  if (!text || text[0] !== '[') return null
  let parts: unknown
  try {
    parts = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(parts) || !parts.length || !parts.every((p) => p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string')) return null
  const outs: string[] = []
  const plain: string[] = []
  let exit: number | undefined
  let secs: number | undefined
  let script: number | undefined
  for (const p of parts as { text: string }[]) {
    let o: Record<string, unknown> | null = null
    try {
      const v = JSON.parse(p.text)
      if (v && typeof v === 'object' && !Array.isArray(v)) o = v
    } catch {}
    if (o && ('output' in o || 'exit_code' in o)) {
      if (typeof o.output === 'string') outs.push(o.output)
      if (typeof o.exit_code === 'number' && (exit === undefined || o.exit_code !== 0)) exit = o.exit_code
      if (typeof o.wall_time_seconds === 'number') secs = (secs ?? 0) + o.wall_time_seconds
      continue
    }
    const w = /^Script (?:completed|failed)[^\n]*\n(?:Wall time ([\d.]+) seconds\n)?(?:Output:\n)?/.exec(p.text)
    if (w) {
      if (w[1]) script = Number(w[1])
      const rest = p.text.slice(w[0].length)
      if (rest.trim()) plain.push(rest)
      if (/^Script failed/.test(p.text) && exit === undefined) exit = 1
    } else if (p.text.trim()) plain.push(p.text)
  }
  // The command's own time when it gave one, else the whole program's.
  secs ??= script
  return { text: [...plain, ...outs].join('\n').replace(/\n+$/, ''), ...(exit !== undefined ? { exit } : {}), ...(secs !== undefined ? { secs } : {}) }
}

type ToolLike = { name: string; label: string; detail?: string; input?: string; output?: string; error?: boolean; done: boolean; lang?: string; exec?: true; meta?: string }
const faced = new WeakMap<object, unknown>()

/**
 * A tool row as drawn: a codex exec call becomes what it does and its answer the command's output; any other row
 * is itself. The same row gives the same object back, so rows that did not change are not drawn again.
 */
export function toolFace<T extends ToolLike>(it: T): T {
  const hit = faced.get(it) as T | undefined
  if (hit) return hit
  const face = codexExecFace(it.name, it.input)
  let out = it
  if (face) {
    out = { ...it, ...face, exec: true }
    const o = it.done ? codexExecOutput(it.output) : null
    if (o) out = { ...out, output: o.text, meta: execMeta(o), error: !!it.error || (o.exit !== undefined && o.exit !== 0) }
  }
  faced.set(it, out)
  return out
}

/** "exit 0 · 0.04 s" for a row's result line. */
export function execMeta(o: { exit?: number; secs?: number }) {
  const parts: string[] = []
  if (o.exit !== undefined) parts.push(`exit ${o.exit}`)
  if (o.secs !== undefined) parts.push(o.secs < 10 ? `${o.secs.toFixed(o.secs < 1 ? 2 : 1)} s` : `${Math.round(o.secs)} s`)
  return parts.join(' · ')
}

// ---------- highlighting (tokens only; the page draws them) ----------

export type Tok = { t: string; k?: 'cmd' | 'flag' | 'str' | 'op' | 'var' | 'key' | 'num' | 'lit' | 'com' }

/** A shell command as tokens: each command's first word, flags, quoted strings, $vars, operators, comments. */
export function shellTokens(src: string): Tok[] {
  const out: Tok[] = []
  const re = /(#[^\n]*)|('(?:[^'\\]|\\.)*'?|"(?:[^"\\]|\\.)*"?)|(\$\{?[\w@*#?!-]+\}?)|(\|\||&&|[|;&]|>>?|<<?|2>&1|\n)|(\s+)|([^\s'"|;&<>$]+|.)/g
  let head = true
  for (const m of src.matchAll(re)) {
    const [t, com, str, v, op, ws] = m
    if (com) out.push({ t, k: 'com' })
    else if (str) (out.push({ t, k: 'str' }), (head = false))
    else if (v) (out.push({ t, k: 'var' }), (head = false))
    else if (op) (out.push({ t, k: 'op' }), (head = true))
    else if (ws) out.push({ t })
    else if (head && !/=/.test(t)) (out.push({ t, k: 'cmd' }), (head = false))
    else if (/^-/.test(t)) out.push({ t, k: 'flag' })
    else out.push({ t })
  }
  return out
}

/**
 * A codex approval's screen text (a card's context) as tokens: "Label:" heads before the command, then everything
 * from the first "$ " line on as one shell command, the same split the agent judges it by (agent/codex.mjs
 * codexAutoAnswer). Those lines are the terminal's wraps, cut mid-word ("/run/a-" + "b.sock"), so a line break inside
 * the command does not start a new command: the words are found as if it were a space, then cut from the real text.
 */
export function approvalTokens(context: string): Tok[] {
  const lines = context.split('\n')
  const at = lines.findIndex((l) => l.startsWith('$ '))
  const out: Tok[] = []
  for (const [i, l] of (at < 0 ? lines : lines.slice(0, at)).entries()) {
    const m = /^([A-Z][\w ]{0,30}:)(\s.*|)$/.exec(l)
    if (m) out.push({ t: m[1], k: 'key' }, { t: m[2] })
    else out.push({ t: l })
    if (at >= 0 || i < lines.length - 1) out.push({ t: '\n' })
  }
  if (at < 0) return out
  const cmd = lines.slice(at).join('\n').slice(2)
  out.push({ t: '$ ', k: 'op' })
  let pos = 0
  for (const tok of shellTokens(cmd.replace(/\n/g, ' '))) {
    out.push({ ...tok, t: cmd.slice(pos, pos + tok.t.length) })
    pos += tok.t.length
  }
  return out
}

/** JSON text as tokens: keys, strings, numbers, true/false/null. */
export function jsonTokens(src: string): Tok[] {
  const out: Tok[] = []
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([^"\d\w-]+|.)/g
  for (const m of src.matchAll(re)) {
    if (m[1] !== undefined) {
      out.push({ t: m[1], k: m[2] ? 'key' : 'str' })
      if (m[2]) out.push({ t: m[2] })
    } else if (m[3] !== undefined) out.push({ t: m[3], k: 'num' })
    else if (m[4] !== undefined) out.push({ t: m[4], k: 'lit' })
    else out.push({ t: m[0] })
  }
  return out
}

/** JS (a codex exec program) as tokens: strings, comments, numbers, keywords. */
export function jsTokens(src: string): Tok[] {
  const out: Tok[] = []
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d+(?:\.\d+)?)\b|\b(await|async|const|let|var|return|if|else|for|of|in|new|function|true|false|null|undefined)\b|(\btools\.[\w.]+)|([\s\S])/g
  for (const m of src.matchAll(re)) {
    if (m[1]) out.push({ t: m[1], k: 'com' })
    else if (m[2]) out.push({ t: m[2], k: 'str' })
    else if (m[3]) out.push({ t: m[3], k: 'num' })
    else if (m[4]) out.push({ t: m[4], k: 'lit' })
    else if (m[5]) out.push({ t: m[5], k: 'cmd' })
    else {
      const last = out.at(-1)
      if (last && !last.k) last.t += m[6]
      else out.push({ t: m[6] })
    }
  }
  return out
}

/** Pretty JSON when `s` is a JSON object or list, else null. */
export function prettyJson(s: string | undefined): string | null {
  const t = s?.trim()
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null
  try {
    const v = JSON.parse(t)
    return v && typeof v === 'object' ? JSON.stringify(v, null, 2) : null
  } catch {
    return null
  }
}
