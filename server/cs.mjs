// A session as the Slack plugin reads it, made from what this server keeps: a session row, an event, and a
// decision as Slack blocks with their buttons.
// Pure functions: nothing here touches the disk or the network.

const truncate = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))
// Slack refuses a whole message (invalid_blocks) when one section's text is over 3,000 characters, so a fence
// leaves room for a path line above it, and a section cut short still closes the fence it cut into.
const SECTION_MAX = 3000
// A message holds at most 50 blocks: a plan keeps 40 of them, the rest is for the buttons and notes around it.
const PLAN_SECTIONS = 40
// One allowed tool in a folded run says at most this much about itself.
const AUTO_WHAT = 100
const fence = (text, lang = '') => `\`\`\`${lang}\n${truncate(String(text).replace(/`{3,}/g, "'''"), 2700)}\n\`\`\``
export const fit = (text, n = SECTION_MAX) => {
  const s = String(text)
  if (s.length <= n) return s
  const cut = s.slice(0, n - 5)
  return (cut.match(/```/g) ?? []).length % 2 ? `${cut}…\n\`\`\`` : `${cut}…`
}
const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text: fit(text) } })
const context = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] })
const button = (text, action_id, value, style) => ({ type: 'button', text: { type: 'plain_text', text, emoji: true }, action_id, value, ...(style ? { style } : {}) })

/** A session's thread key in Slack's form (`seconds.micros`), derived once from when it was made and its id. */
export function threadOf(meta) {
  const tail = String(parseInt(meta.id.replace(/-/g, '').slice(0, 8), 16) % 1_000_000).padStart(6, '0')
  return `${Math.floor(meta.createdAt / 1000)}.${tail}`
}

export const WAITING = { '권한 요청': '권한 대기', 질문: '질문 대기', '플랜 승인': '플랜 승인 대기', '지시 대기': '지시 대기', '터미널 확인': '터미널 확인 대기' }
const TOOL_EMOJI = { Bash: '⚙️', Edit: '✏️', Write: '📝', Read: '📖', Grep: '🔍', Glob: '🔍', Agent: '🤖', Task: '🤖', TodoWrite: '📋', Skill: '🧩', WebFetch: '🌐', WebSearch: '🌐', NotebookEdit: '✏️' }

/** What "항상 허용" would write into the settings, as far as it can be told from the tool call (§4.3.15). */
function rulePreview(tool) {
  const i = tool?.input ?? {}
  if (tool?.name === 'Bash') {
    const cmd = String(i.command ?? '').trim()
    if (!cmd || /[|;&`$\n]/.test(cmd)) return null
    const [a, b] = cmd.split(/\s+/)
    return `Bash(${a}${['git', 'npm', 'yarn', 'pnpm', 'docker', 'kubectl', 'gh', 'make', 'cargo', 'go', 'pip', 'brew'].includes(a) && b && !b.startsWith('-') ? ` ${b}` : ''}:*)`
  }
  if (['Edit', 'Write', 'Read'].includes(tool?.name)) return `${tool.name}(${i.file_path ?? '…'})`
  if (tool?.name === 'WebFetch') {
    try {
      return `WebFetch(domain:${new URL(i.url).host})`
    } catch {
      return null
    }
  }
  return String(tool?.name ?? '').startsWith('mcp__') ? tool.name : null
}

/** The part of a permission card that says what would run or change. */
function permissionDetail(card) {
  const i = card.tool?.input
  const name = card.tool?.name
  if (!i) return card.context ? [section(fence(truncate(card.context, 2500)))] : []
  if (name === 'Edit' && typeof i.old_string === 'string') return [section(`\`${i.file_path}\`${i.replace_all ? ' _(모두 바꾸기)_' : ''}\n${fence([...i.old_string.split('\n').map((l) => `- ${l}`), ...String(i.new_string ?? '').split('\n').map((l) => `+ ${l}`)].join('\n'), 'diff')}`)]
  if (name === 'Write' && typeof i.content === 'string') {
    const lines = i.content.split('\n')
    return [section(`\`${i.file_path}\` · ${lines.length}줄${lines.length > 20 ? ' (앞 20줄)' : ''}\n${fence(lines.slice(0, 20).join('\n'))}`)]
  }
  if (name === 'Bash' && typeof i.command === 'string') return [section(fence(i.command, 'bash'))]
  return card.context ? [section(fence(truncate(card.context, 2500)))] : [section(fence(truncate(JSON.stringify(i, null, 1), 2500)))]
}

/**
 * A decision the terminal waits for, as the Slack message to post: the text, and the blocks
 * with their buttons. A button's value is `<pid>:card <card id> <option>`, which the action handler turns back
 * into a press on that option — only if that card is still the open one and the option is on screen.
 * @returns {{ text: string, blocks: object[] }}
 */
export function cardMessage(card, pid) {
  const val = (n) => `${pid}:card ${card.id} ${n}`
  const opt = (kind) => (card.options ?? []).find((o) => o.kind === kind)
  if (card.kind === 'permission') {
    const name = card.tool?.name ?? '도구'
    const allow = opt('allow-once')
    const always = opt('allow-always')
    const deny = opt('deny')
    const rule = always ? rulePreview(card.tool) : null
    const desc = card.tool?.input?.description ?? card.description ?? card.title ?? ''
    return {
      text: `🔐 권한 요청 · ${name}`,
      blocks: [
        section(`🔐 *${name}* 권한 요청\n${truncate(desc, 500)}`),
        ...permissionDetail(card),
        ...(rule ? [context(`항상 허용을 누르면 \`${rule}\` 규칙이 기록됩니다 (예상)`)] : []),
        { type: 'actions', block_id: `perm_${pid}_${card.id}`, elements: [...(allow ? [button('허용', 'perm_allow', val(allow.n), 'primary')] : []), ...(always ? [button('항상 허용', 'perm_always', val(always.n))] : []), ...(deny ? [button('거부', 'perm_deny', val(deny.n), 'danger')] : [])] },
      ],
    }
  }
  if (card.kind === 'stuck') {
    const text = '⏸️ 작업이 중단된 채 다음 지시를 기다리고 있습니다. 이어서 하려면 *계속해* 를 누르거나 새 지시를 쓰세요.'
    return { text, blocks: [section(text), { type: 'actions', block_id: `stuck_${pid}`, elements: [button('▶️ 계속해', 'ctl_btn', `${pid}:continue`, 'primary'), button('🖥 화면', 'ctl_btn', `${pid}:screen`)] }] }
  }
  if (card.kind === 'keyed') {
    const options = (card.options ?? []).slice(0, 5)
    return {
      text: `⌨️ *터미널이 입력을 기다립니다*\n${card.title ?? ''}`,
      blocks: [
        section(`⌨️ *터미널이 입력을 기다립니다*\n${truncate(card.title ?? '', 500)}`),
        ...(card.description ? [section(fence(truncate(card.description, 1500)))] : []),
        ...(card.footer ? [context(truncate(card.footer, 300))] : []),
        { type: 'actions', block_id: `dlg_key_${pid}`, elements: [...options.map((o, k) => button(truncate(o.label, 75), 'dlg_key', val(o.n), k === (card.selected ?? 0) ? 'primary' : undefined)), button('취소 (Esc)', 'dlg_key', `${pid}:card ${card.id} esc`)] },
      ],
    }
  }
  const options = (card.options ?? []).slice(0, 20)
  const dropped = (card.options ?? []).length - options.length
  const buttons = { type: 'actions', block_id: `dlg_q0_${pid}`, elements: options.map((o, k) => button(truncate(`${o.n}. ${o.label}`, 75), 'dlg_answer', val(o.n), card.kind === 'plan' && k === 0 ? 'primary' : undefined)) }
  const described = options.filter((o) => o.description)
  if (card.kind === 'plan') {
    const plan = String(card.plan ?? '')
    // Fixed wording, matched to the screen's options by what each says (their order and number
    // differ between Claude Code versions); an option that matches none keeps its own label.
    const fixed = [[/auto-accept|auto mode/i, '✅ 승인 · 편집 자동 승인'], [/manually approve/i, '✅ 승인 · 편집 수동 승인'], [/^no\b|keep planning/i, '✏️ 아니오 · 계속 계획']]
    const named = options.map((o) => ({ o, label: fixed.find(([re]) => re.test(o.label))?.[1] }))
    const unique = (l) => named.filter((x) => x.label === l).length === 1
    buttons.elements = [...named.map(({ o, label }, k) => button(label && unique(label) ? label : truncate(`${o.n}. ${o.label}`, 75), 'dlg_answer', val(o.n), k === 0 ? 'primary' : undefined)), button('🖥 화면', 'ctl_btn', `${pid}:screen`)]
    return {
      text: '📋 플랜 승인을 기다립니다',
      blocks: [section('📋 *플랜 승인을 기다립니다.* 위에 스트리밍된 내용이 플랜입니다.'), ...Array.from({ length: Math.min(PLAN_SECTIONS, Math.ceil(plan.length / 2900)) }, (_, k) => section(plan.slice(k * 2900, (k + 1) * 2900))), ...(plan.length > PLAN_SECTIONS * 2900 ? [context('플랜이 길어 뒷부분은 생략했습니다 — 화면으로 확인하세요.')] : []), buttons, ...(described.length ? [context(truncate(described.map((o) => `${o.n}. ${o.description}`).join(' · '), 300))] : [])],
    }
  }
  // AskUserQuestion, and any numbered dialog nobody has taught this server about.
  const intro = [card.context, card.description].filter(Boolean).join('\n')
  return {
    text: card.kind === 'question' ? '❓ Claude가 선택을 기다립니다' : '❓ 터미널이 선택을 기다립니다',
    blocks: [
      section(card.kind === 'question' ? '❓ *Claude가 선택을 기다립니다*' : '❓ *터미널이 선택을 기다립니다*'),
      ...(intro ? [card.context ? section(`${fence(truncate(card.context, 2500))}${card.description ? `\n${card.description}` : ''}`.slice(0, 2900)) : context(truncate(intro, 500))] : []),
      section(`*${card.header ? `[${card.header}] ` : ''}${truncate(card.title ?? '', 500)}*${card.multi ? ' _(복수 선택: 번호를 차례로 누른 뒤 확정)_' : ''}`),
      card.multi ? { ...buttons, elements: [...buttons.elements, button('확정 (Enter)', 'dlg_answer', `${pid}:card ${card.id} enter`, 'primary')] } : buttons,
      ...(described.length ? [context(truncate(described.map((o) => `${o.n}. ${o.description}`).join(' · '), 300))] : []),
      ...(dropped > 0 ? [context(`선택지 ${dropped}개는 너무 많아 생략했습니다 — 화면으로 확인하세요.`)] : []),
    ],
  }
}

/** An answered card folds to one line: a check or a deny mark, and what was chosen. */
export function foldedMessage(card, result) {
  const r = result || '답함'
  const denied = /^(거부|취소|확인 창이 이미|이미 닫힌 창|세션이 끝남)/.test(r)
  // The tool first for a permission, the chosen label for a question.
  const text =
    card?.kind === 'permission' && card.tool?.name ? `${denied ? '⛔' : '✅'} ${card.tool.name} · ${r}`
    : /^선택: /.test(r) ? `☑️ 선택: *${r.slice(4)}*`
    : r === '메시지로 답함' ? '💬 메시지로 답함'
    : card?.kind === 'keyed' ? `⌨️ ${r}`
    : `${denied ? '⛔' : '✅'} ${r}${card?.title && card.kind !== 'stuck' ? ` · ${truncate(card.title, 80)}` : ''}`
  return { text, blocks: [section(text)] }
}

/** What 전부 허용 allowed, as the one line it leaves: a tool row with what was allowed underneath. */
export function autoAllowMessage(card) {
  const name = card.tool?.name ?? '터미널 확인 창'
  const text = `⚡ 자동 허용 · *${name}*${card.tool?.input?.description ? ` · ${truncate(card.tool.input.description, 200)}` : ''}`
  return { text: `⚡ 자동 허용 · ${name}`, blocks: [section(text), ...permissionDetail(card)] }
}

/**
 * What 전부 허용 allowed, as one short line for a run of them (the Slack plugin folds a run into one message):
 * the tool and a few words on what it did, never the command or the change itself.
 */
export function autoLine(card) {
  // An MCP tool by its server and tool, not the whole mcp__server__tool name.
  const raw = card.tool?.name ?? '터미널 확인 창'
  const name = raw.startsWith('mcp__') ? raw.split('__').slice(1).join(' ') : raw
  const i = card.tool?.input ?? {}
  const one = (s) => truncate(String(s).trim().split('\n')[0], AUTO_WHAT)
  const base = (p) => String(p).split('/').filter(Boolean).pop() ?? String(p)
  let host = ''
  try {
    host = i.url ? new URL(i.url).host : ''
  } catch {}
  const what =
    i.description ? one(i.description)
    : i.file_path ? base(i.file_path)
    : i.notebook_path ? base(i.notebook_path)
    : host || (i.pattern ? one(i.pattern) : i.query ? one(i.query) : i.skill ? one(i.skill) : '')
  // desc: the line says what was done in words; otherwise it only names a file, a host or a pattern.
  return { name, what, desc: !!i.description }
}

const image = (ctx) => (id) => {
  const info = ctx.image?.(id) ?? {}
  return { id, type: { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[id.split('.').pop()] ?? 'image/png', bytes: info.bytes ?? 0, src: `/api/img/${id}`, ...(info.w && info.h ? { w: info.w, h: info.h } : {}), ...(info.name ? { name: info.name } : {}) }
}

/**
 * One stored event as the Slack plugin reads it. One in, one out, with the same `seq`: the reader counts
 * on the numbers being consecutive.
 * @param {object} e a stored event (`k`, `seq`, `at`, …)
 * @param {{ pid: number, cards: Map<string, object> }} ctx the session's pid, and its cards seen so far (a fold needs the card it folds)
 */
export function toCsEvent(e, ctx) {
  const base = { seq: e.seq, at: e.at }
  switch (e.k) {
    case 'user':
      return { ...base, type: 'user', ts: e.id ?? `u${e.seq}`, text: e.text ?? '', via: e.via ?? 'terminal', ...(e.images?.length ? { images: e.images.map(image(ctx)) } : {}) }
    case 'text':
      return { ...base, type: 'text', ts: `t${e.seq}`, text: e.text, ...(e.choices ? { choices: e.choices } : {}) }
    case 'tool':
      return { ...base, type: 'tool', id: e.tool, name: e.name, title: `${TOOL_EMOJI[e.name] ?? '🔧'} ${e.name}${e.label ? ` ${e.label}` : ''}`, ...(e.detail ? { detail: e.detail } : {}) }
    case 'tool_end':
      return { ...base, type: 'tool_end', id: e.tool, ok: !e.error, output: e.text ?? '', ...(e.images?.length ? { images: e.images.map(image(ctx)) } : {}) }
    case 'todos':
      return { ...base, type: 'todos', todos: (e.items ?? []).map((t) => ({ content: t.text, status: t.status, activeForm: t.active })) }
    case 'local':
      return { ...base, type: 'msg', ts: `l${e.seq}`, text: `${e.error ? '⚠️ 명령 오류\n' : ''}${fence(e.text)}` }
    case 'held': {
      // The messages the Mac is holding, as one card: made, changed as the number changes, taken away when none.
      const ts = `held-${e.id}`
      if (!e.n) return { ...base, type: 'msg_delete', ts }
      const text = `🕓 메시지 ${e.n}개를 붙잡고 있습니다. 실행 중인 도구가 끝나면 전달합니다.`
      return { ...base, type: e.first ? 'msg' : 'msg_update', ts, text, blocks: [section(`${text}\n_지금 보내면 실행 중인 작업을 끊고 바로 전달합니다 (터미널의 Ctrl+Enter)._`), { type: 'actions', block_id: `held_${ctx.pid}`, elements: [button('⚡ 지금 보내기', 'ctl_btn', `${ctx.pid}:sendnow`, 'primary'), button('취소', 'ctl_btn', `${ctx.pid}:dropheld`)] }] }
    }
    case 'line':
      // A line the server itself says in the conversation, posted in the thread like any other.
      return { ...base, type: 'msg', ts: `m${e.seq}`, text: e.text, ...(e.blocks ? { blocks: e.blocks } : {}) }
    case 'notice':
      return { ...base, type: 'notice', text: e.text, icon: e.icon ?? (e.tone === 'warn' ? 'alert' : 'bell') }
    case 'end':
      return { ...base, type: 'end', why: e.text ?? '종료' }
    case 'status':
      return { ...base, type: 'status', state: e.phase, ...(e.waiting ? { waiting: e.waiting } : {}) }
    case 'react':
      return { ...base, type: 'react', ts: e.id, name: e.name, on: !!e.on }
    case 'side':
      return { ...base, type: e.update ? 'msg_update' : 'msg', ts: e.id, text: `옆길 질문 · 대화에는 남지 않아요 — ${truncate(e.q, 120)}\n${e.answer ? '```' + truncate(e.answer.replace(/```/g, "'''"), 3800) + '```' : (e.error ?? '답을 기다리는 중…')}` }
    case 'card': {
      ctx.cards.set(e.card.id, e.card)
      if (e.card.auto) return { ...base, type: 'msg', ts: e.card.id, ...autoAllowMessage(e.card), auto: autoLine(e.card) }
      return { ...base, type: 'msg', ts: e.card.id, ...cardMessage(e.card, ctx.pid) }
    }
    case 'card_end':
      return { ...base, type: 'msg_update', ts: e.id, ...foldedMessage(ctx.cards.get(e.id), e.result) }
    default:
      // A kind this page has no row for still takes its number.
      return { ...base, type: 'status', state: 'idle' }
  }
}

const mbOf = (bytes) => Math.round(bytes / 1e5) / 10

/**
 * A session as one row of the Slack plugin's list, plus which Mac it is on under `bridge`.
 * @param {object} meta the session as this server keeps it
 * @param {{ thread: string, pid: number, host?: object, online: boolean }} at
 */
export function toCsSession(meta, at) {
  const st = meta.state ?? {}
  const reachable = at.online && st.alive && !meta.moving
  const state = meta.moving ? 'starting' : !reachable ? 'ended' : (st.phase ?? 'idle')
  const card = meta.card?.open && meta.card.kind === 'permission' ? meta.card : null
  const u = st.usage ?? {}
  return {
    pid: at.pid,
    thread: at.thread,
    cwd: meta.cwd,
    title: meta.title || undefined,
    state,
    ...(state === 'waiting' ? { waiting: WAITING[st.waiting] ?? '터미널 확인 대기', ...(st.waitingSince ? { waitingSince: st.waitingSince } : {}) } : {}),
    model: meta.launchModel || meta.model || undefined,
    effort: st.effort || undefined,
    permissionMode: st.mode || undefined,
    contextLabel: st.context || undefined,
    context: u.context != null ? `${u.context}%` : st.context || undefined,
    ...(u.window ? { contextWindow: { size: u.window, used: Math.round(((u.context ?? 0) / 100) * u.window / 1000) * 1000 } } : {}),
    ...(u.fiveHour != null || u.week != null ? { usage: { ...(u.fiveHour != null ? { fiveHour: u.fiveHourResetsAt && u.fiveHourResetsAt < Date.now() ? 0 : u.fiveHour } : {}), ...(u.week != null ? { sevenDay: u.weekResetsAt && u.weekResetsAt < Date.now() ? 0 : u.week } : {}), ...(u.fiveHourResetsAt ? { fiveHourResetsAt: u.fiveHourResetsAt } : {}), ...(u.weekResetsAt ? { sevenDayResetsAt: u.weekResetsAt } : {}) } } : {}),
    ...(st.size ? { transcriptMb: mbOf(st.size) } : {}),
    startedAt: meta.createdAt,
    held: st.held?.length ?? 0,
    canKeys: reachable,
    autoAllow: !!(st.autoAllow || meta.autoAllow),
    ...(st.refreshAfter ? { refreshAfter: true } : {}),
    ...(meta.resting ? { resting: true } : {}),
    ...(state === 'busy' && (st.running?.length || st.tool?.title) ? { running: st.running?.length ? st.running : [st.tool.title] } : {}),
    ...(state === 'busy' && meta.coding ? { coding: true } : {}),
    ...(meta.reviewLoop && state !== 'ended' ? { reviewLoop: true } : {}),
    ...(st.sessionMd != null ? { sessionMd: { bytes: st.sessionMd, max: st.mdMax ?? 20000 } } : {}),
    ...(st.plugins?.length ? { plugins: st.plugins } : {}),
    ...(st.quietSince && state === 'busy' ? { quietMs: Date.now() - st.quietSince } : {}),
    ...(meta.bg?.length && state !== 'busy' ? { background: meta.bg.map((t) => t.label ?? t.kind ?? '작업') } : {}),
    ...(card ? { permission: { ts: card.id, ...cardMessage(card, at.pid) } } : {}),
    lastSeq: meta.seq ?? 0,
    lastAt: meta.lastAt ?? meta.createdAt,
    ...(meta.preview ? { preview: meta.preview } : {}),
    ...(meta.last ? { last: { text: truncate(meta.last, 200), mine: !!meta.lastMine } } : {}),
    // Which Mac it is on, and whether that Mac can be reached.
    bridge: { id: meta.id, hostId: meta.hostId, host: at.host?.name ?? '', online: at.online, alive: !!st.alive, moving: meta.moving?.to ?? null, prevHostId: meta.prevHostId ?? null, switched: meta.moves?.at(-1)?.sourceOnline === false, syncedAt: meta.syncedAt, autoPush: meta.autoPush, home: meta.home },
  }
}
