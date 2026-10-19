// Turns Claude Code transcript lines (JSONL) into the events the control page draws.
const MAX_TEXT = 40_000
const MAX_TOOL = 6_000

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const shortenHome = (p, home) => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p)

function resultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((c) => (c.type === 'text' && c.text ? c.text : c.type === 'image' ? '[그림]' : '')).filter(Boolean).join('\n')
}

/** Wrappers the harness puts around a user turn. None of them is something a person typed. */
const ENVELOPE_RE = /^\s*<(channel|task-notification|system-reminder|agent-message|local-command-[a-z-]+|command-name|command-message|command-args|bash-input|bash-stdout|bash-stderr)\b/i
/** What a local command (`/model`, `/context`, `!ls`) printed: stored as a user entry in a stdout/stderr envelope. */
const LOCAL_OUTPUT_RE = /<(?:local-command|bash)-(stdout|stderr)>([\s\S]*?)<\/(?:local-command|bash)-\1>/g
const ATTACHED_RE = /\n?\[(?:Image|File) attached: [^\]]*?([0-9a-f]{40}\.[a-z0-9]{1,5})\]/g
/** A video the page sent (REQ-F-761), saved on the Mac as `<8 hex>-<name>`: shown as "🎬 <name>". */
const VIDEO_RE = /\[Video attached: [^\]\n]*?\/(?:[0-9a-f]{8}-)?([^/\]\n]+)\](?: \([^)\n]*\))?/g
const ROUTINE_RE = /^(Agent .* finished|Background command .* completed \(exit code 0\))$/i
const DENIED_RE = /denied by the Claude Code auto mode classifier\.?\s*(?:Reason:\s*)?(\[[^\]]+\])?/i
/** A task notification Claude wrote into its own answer: it imitates the harness, nothing finished. */
const FAKE_NOTIFICATION_RE = /\s*<task-notification>[\s\S]*?<\/task-notification>/g

/**
 * A trailing ```choices fenced block: up to 6 short options the person picks instead of typing. Only at the very
 * end of an answer; one in the middle is part of the text.
 */
const CHOICES_RE = /\n?```choices\n([\s\S]*?)\n```\s*$/
export function extractChoices(text) {
  const m = CHOICES_RE.exec(text)
  if (!m) return { text }
  const choices = m[1].split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 6)
  if (!choices.length) return { text }
  return { text: text.slice(0, m.index).replace(/\s+$/, ''), choices }
}

/**
 * A ```todos fenced block (REQ-F-778): the to-do list from a session started without the bridge MCP's todos tool,
 * asked for by the page's "지금까지 한 일로 정리". One item a line: `[x]` done, `[>]` doing, `[ ]` to do. The last
 * such block counts; every one is taken out of the text.
 */
const TODOS_RE = /\n?```todos\n([\s\S]*?)\n```[ \t]*/g
const TODO_LINE_RE = /^\s*(?:[-*]\s*)?\[([ xX>])\]\s+(.+?)\s*$/
const TODO_STATUS = { ' ': 'pending', x: 'completed', X: 'completed', '>': 'in_progress' }
export function extractTodos(text) {
  let items = null
  const rest = text.replace(TODOS_RE, (_, body) => {
    const found = body.split('\n').map((l) => TODO_LINE_RE.exec(l)).filter(Boolean).slice(0, 100)
    items = found.map((m) => ({ text: m[2], active: '', status: TODO_STATUS[m[1]] }))
    return '\n'
  })
  return items ? { text: rest.replace(/\n{3,}/g, '\n\n').trim(), todos: items } : { text }
}

/** A script opener: a heredoc, or a line that ends inside a quote. What it runs is on the following lines. */
const HEREDOC_RE = /<<-?\s*['"]?\w+['"]?\s*$/
const PREAMBLE_RE = /^(#|import\s|from\s+\S+\s+import\s|require\(|use\s|set\s+-|'''|""")/

function bashSummary(command) {
  const lines = String(command ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i]
    // `cd somewhere &&` in front says where, not what.
    for (let m; (m = /^cd\s+\S+\s*(&&|;)\s*/.exec(l)); ) l = l.slice(m[0].length)
    if (!l || /^cd\s+\S+$/.test(l)) continue
    const quotes = (l.match(/["']/g) ?? []).length
    const opener = HEREDOC_RE.test(l) || (/["']$/.test(l) && quotes % 2 === 1)
    if (!opener) return l
    const interpreter = l.replace(HEREDOC_RE, '').replace(/["'][^"']*$/, '').trim().replace(/\s-(c|e)?$/, '')
    const rest = lines.slice(i + 1).filter((x) => !/^\w+$/.test(x) || x.length > 12)
    return `${interpreter} · ${rest.find((x) => !PREAMBLE_RE.test(x)) ?? rest[0] ?? ''}`.replace(/ · $/, '')
  }
  return lines[0] ?? ''
}

/**
 * The one line that says what a tool call is doing, and the longer text behind it.
 * @returns {{ label: string, detail?: string }}
 */
export function toolSummary(name, input, ctx = {}) {
  const i = input && typeof input === 'object' ? input : {}
  const rel = (p) => {
    const s = String(p ?? '')
    return ctx.cwd && s.startsWith(`${ctx.cwd}/`) ? s.slice(ctx.cwd.length + 1) : shortenHome(s, ctx.home)
  }
  let label = ''
  let detail = ''
  if (name === 'Bash') (label = bashSummary(i.command)), (detail = String(i.command ?? ''))
  else if (['Edit', 'Write', 'Read', 'NotebookEdit', 'MultiEdit'].includes(name)) label = rel(i.file_path ?? i.notebook_path)
  else if (name === 'Grep' || name === 'Glob') label = String(i.pattern ?? '')
  else if (name === 'Task' || name === 'Agent') (label = [i.subagent_type, i.description].map((x) => String(x ?? '').trim()).filter(Boolean).join(' · ')), (detail = String(i.prompt ?? i.description ?? ''))
  else if (name === 'TodoWrite') {
    const todos = Array.isArray(i.todos) ? i.todos : []
    const done = todos.filter((t) => t.status === 'completed').length
    const now = todos.find((t) => t.status === 'in_progress')
    label = now ? `${now.activeForm ?? now.content} (${done}/${todos.length})` : `${done}/${todos.length} 완료`
  } else if (name === 'Skill') label = String(i.skill ?? '')
  else if (name === 'WebFetch') label = String(i.url ?? '')
  else if (name === 'WebSearch') (label = String(i.query ?? '')), (detail = label)
  else label = String(Object.values(i).find((v) => typeof v === 'string') ?? '').split('\n')[0]
  detail = detail.trim()
  return { label: truncate(label.replace(/`/g, "'"), 110), ...(detail.includes('\n') || detail.length > 80 ? { detail: truncate(detail, 1500) } : {}) }
}

/**
 * @param {string} line one transcript line
 * @param {{ cwd?: string, home?: string }} [ctx] the session's folder, to show paths the short way
 * @returns {Array<object>} events without a seq; the caller numbers them. `k` is one of
 *   user · text · tool · tool_end · todos · local · notice · title · model
 */
export function lineToEvents(line, ctx = {}) {
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return []
  }
  if (o.isSidechain) return []
  if (o.type === 'ai-title' && typeof o.aiTitle === 'string') return [{ k: 'title', title: o.aiTitle.slice(0, 80) }]
  // The summary Claude Code writes after compacting is a user line nobody typed; the agent already says it compacted.
  if (o.isMeta || o.isCompactSummary || !o.message) return []
  const at = o.timestamp ? Date.parse(o.timestamp) : null
  const out = []
  const push = (e) => out.push({ at, ...e })
  const content = o.message.content
  /** A picture a tool returned or a person pasted: kept by the caller, referred to by its id. */
  const pictures = (blocks) => (Array.isArray(blocks) && ctx.image ? blocks.filter((c) => c.type === 'image' && c.source?.type === 'base64' && typeof c.source.data === 'string').map((c) => ctx.image(String(c.source.media_type ?? 'image/png'), c.source.data)).filter(Boolean) : [])
  const userText = (text, images = []) => {
    const local = [...text.matchAll(LOCAL_OUTPUT_RE)]
    if (local.length) return local.forEach((m) => m[2].trim() && push({ k: 'local', text: truncate(m[2].replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim(), 3500), error: m[1] === 'stderr' }))
    const env = ENVELOPE_RE.exec(text)
    if (!env) {
      if (/^Caveat: /.test(text)) return
      // Claude Code writes this line itself when a turn is cut off: nobody typed it.
      if (/^\[Request interrupted by user(?: for tool use)?\]$/.test(text.trim())) return
      // What the page attached reads "[Image attached: <path>]" by the time it comes back: the picture is shown
      // from the server's own copy (the file name is its id), the line is not.
      const attached = [...text.matchAll(ATTACHED_RE)].map((m) => m[1])
      const said = text.replace(ATTACHED_RE, '').replace(/\[Image #\d+\]/g, '').replace(VIDEO_RE, (_, name) => `🎬 ${name}`).trim()
      const all = [...attached, ...images]
      if (said || all.length) push({ k: 'user', text: truncate(said, MAX_TEXT), ...(all.length ? { images: all } : {}) })
      return
    }
    const kind = env[1].toLowerCase()
    if (kind === 'agent-message') {
      // A finished subagent's report, without the harness's framing around it and its two-space indent.
      const body = text.replace(/^\s*<agent-message\b[^>]*>\s*|\s*<\/agent-message>\s*$/gi, '').replace(/^\s*\[Subagent hand-back\][\s\S]*?The report follows:\s*\n/i, '').replace(/^[ \t]*\[harness:[^\]]*\][ \t]*\n?/gim, '')
      const lines = body.split('\n')
      const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)[0].length))
      const report = lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n').trim()
      if (report) push({ k: 'line', text: `🤖 *서브에이전트 보고*\n${report.length > 6000 ? `${report.slice(0, 6000)}\n\n_… 이하 생략. 전체는 터미널 기록에 있습니다._` : report}` })
      return
    }
    if (kind === 'command-name' || kind === 'command-message') {
      // A slash command typed in the terminal or sent from the page: show it as what was typed.
      const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim()
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim()
      if (cmd) push({ k: 'user', text: `${cmd.startsWith('/') ? cmd : `/${cmd}`}${args ? ` ${args}` : ''}`, command: true })
    } else if (kind === 'bash-input') {
      const cmd = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(text)?.[1]?.trim()
      if (cmd) push({ k: 'user', text: `!${cmd}`, command: true })
    } else if (kind === 'task-notification') {
      const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim()
      const status = /<status>([\s\S]*?)<\/status>/.exec(text)?.[1]?.trim()
      const failed = !!status && status !== 'completed'
      // A background job that simply finished is routine; one that failed is worth a line.
      if (summary && !(ROUTINE_RE.test(summary) && !failed)) push({ k: 'notice', text: failed ? `${summary} (${status})` : summary, tone: failed ? 'warn' : 'info' })
    }
  }
  if (o.type === 'user') {
    if (typeof content === 'string') userText(content)
    else if (Array.isArray(content)) {
      // Pictures pasted in the terminal sit beside the text block they belong to.
      const pasted = pictures(content)
      let used = false
      for (const c of content) {
        if (c.type === 'text' && typeof c.text === 'string') (userText(c.text, used ? [] : pasted), (used = true))
        else if (c.type === 'tool_result') {
          if (ctx.silent?.delete(String(c.tool_use_id))) continue
          const text = resultText(c.content)
          const images = pictures(c.content)
          push({ k: 'tool_end', tool: String(c.tool_use_id), error: c.is_error === true, text: truncate(text, MAX_TOOL), ...(images.length ? { images } : {}) })
          const denied = c.is_error === true && DENIED_RE.exec(text)
          // Auto mode refused the call. There is no dialog to press, which the session does not always say.
          if (denied) push({ k: 'line', text: `🚫 자동 모드가 도구 호출을 거부했습니다: \`${denied[1] ?? '이유 없음'}\`. 누를 확인 창은 없습니다. 이 작업이 필요하면 설정에서 권한 모드를 바꾸거나(⚙️ 설정 → 권한 모드) 다른 방법으로 지시하세요.` })
        }
      }
    }
  } else if (o.type === 'assistant' && Array.isArray(content)) {
    if (typeof o.message.model === 'string' && o.message.model && o.message.model !== '<synthetic>') out.push({ k: 'model', model: o.message.model })
    for (const c of content) {
      if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        const said = c.text.replace(FAKE_NOTIFICATION_RE, '')
        const faked = said !== c.text
        const listed = extractTodos(said)
        const { text, choices } = extractChoices(listed.text)
        if (text.trim() || choices) push({ k: 'text', text: truncate(text, MAX_TEXT), ...(choices ? { choices } : {}) })
        if (listed.todos) push({ k: 'todos', items: listed.todos })
        if (faked) push({ k: 'notice', text: 'Claude 가 답 글에 직접 쓴 작업 알림을 숨겼어요. 실제로 끝난 작업이 아니에요.', tone: 'warn' })
      }
      else if (c.type === 'tool_use') {
        const name = String(c.name)
        // The plan is its own thing on the page (the to-do panel, REQ-F-778), not a tool row. The bridge MCP's own
        // tool takes the same input as Claude Code's TodoWrite.
        const plan = name === 'TodoWrite' || name === 'mcp__bridge__todos'
        if (!plan) push({ k: 'tool', tool: String(c.id), name: name.replace(/^mcp__/, ''), ...toolSummary(name, c.input, ctx), input: truncate(JSON.stringify(c.input ?? {}, null, 1), MAX_TOOL) })
        else ctx.silent?.add(String(c.id))
        if (plan && Array.isArray(c.input?.todos)) push({ k: 'todos', items: c.input.todos.slice(0, 100).map((t) => ({ text: String(t.content ?? ''), active: String(t.activeForm ?? ''), status: String(t.status ?? 'pending') })) })
      }
    }
  }
  return out
}
