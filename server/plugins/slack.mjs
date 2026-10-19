// The Slack plugin: one person's sessions, in one Slack channel kept for them, through that person's own Slack app.
// A session is worked on in one place at a time: the bridge or Slack. One started by a message at the top of the
// channel is in Slack; one is moved there with the session menu (Slack 으로 옮기기) and back with the button in
// its thread (브릿지로 옮기기). While a session is in Slack it is a thread: what the session says is posted
// to it, a reply in it is sent to the session, a decision card is posted as blocks and its buttons answer it. While it is in the bridge, the thread only says where it went.
//
// Nothing here knows the server. It is given `host` (plugins.mjs) and talks to Slack with fetch and one Socket
// Mode WebSocket, so there is no public URL to set up and nothing to install.

const API = () => (process.env.SLACK_API_URL || 'https://slack.com/api').replace(/\/+$/, '')
const truncate = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// A message's markdown_text takes at most 12,000 characters; a piece stays well under it.
const MD_MAX = 10000
// Slack's own escaping for text it reads as mrkdwn.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// A run of 전부 허용 lines (one message) holds at most this many, in at most this many characters (a section takes 3,000).
const AUTO_RUN_MAX = 30
const AUTO_LIST_MAX = 2800
// A line that gathers the same tool on several files stops growing at this length.
const AUTO_LINE_MAX = 200
// How long the run's message waits before it is rewritten with the lines that came since.
const AUTO_EDIT_MS = () => Number(process.env.SLACK_AUTO_EDIT_MS) || 3000
// A line is one allowed tool, or a row of the same tool on files (Write a.ts, b.ts) or the same thing done again.
export const lineOf = (it) => `• *${esc(it.name)}*${it.n > it.whats.length && it.n > 1 ? ` ×${it.n}` : ''}${it.whats.length ? ` ${esc(it.whats.join(', '))}` : ''}`
export const listOf = (items) => items.map(lineOf).join('\n')
/** The run's items with one more tool: onto the last line when it is the same tool on another file, or the same thing again. */
export function withTool(items, { name, what, desc }) {
  const last = items.at(-1)
  if (last?.name === name) {
    if (last.desc === desc && last.whats.length <= 1 && (last.whats[0] ?? '') === what) return [...items.slice(0, -1), { ...last, n: last.n + 1 }]
    if (!desc && !last.desc && last.n === last.whats.length && what && !last.whats.includes(what)) {
      const grown = { ...last, n: last.n + 1, whats: [...last.whats, what] }
      if (lineOf(grown).length <= AUTO_LINE_MAX) return [...items.slice(0, -1), grown]
    }
  }
  return [...items, { name, desc, n: 1, whats: what ? [what] : [] }]
}
// Methods that only read take form fields, not a JSON body.
const FORM = new Set(['chat.getPermalink', 'users.conversations', 'conversations.info', 'users.info'])
/** Where Slack keeps the files people attach. The bot token goes to no other host (R1-L15). */
const FILES_HOST = 'files.slack.com'
const onFilesHost = (u) => {
  try {
    const x = new URL(u)
    return x.protocol === 'https:' && x.hostname === FILES_HOST
  } catch {
    return false
  }
}

/** One Web API call, waiting out a rate limit up to three times. */
async function call(method, args, token) {
  for (let attempt = 0; ; attempt++) {
    const form = FORM.has(method)
    const body = form ? new URLSearchParams(Object.entries(args ?? {}).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)])).toString() : JSON.stringify(args ?? {})
    const r = await fetch(`${API()}/${method}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8' }, body })
    if (r.status === 429 && attempt < 3) {
      await sleep((Number(r.headers.get('retry-after')) || 1) * 1000)
      continue
    }
    const j = await r.json().catch(() => ({ ok: false, error: `http_${r.status}` }))
    if (!j.ok) throw new Error(`${method}: ${j.error}`)
    return j
  }
}
const button = (text, action_id, value, more = {}) => ({ type: 'button', text: { type: 'plain_text', text, emoji: true }, action_id, value, ...more })

/** The app a person makes once: api.slack.com/apps → Create New App → From a manifest. */
const MANIFEST = {
  display_information: { name: 'claude-bridge' },
  features: { bot_user: { display_name: 'claude-bridge', always_online: true } },
  oauth_config: { scopes: { bot: ['chat:write', 'channels:history', 'groups:history', 'channels:read', 'groups:read', 'files:read', 'reactions:write'] } },
  settings: {
    event_subscriptions: { bot_events: ['message.channels', 'message.groups'] },
    interactivity: { is_enabled: true },
    socket_mode_enabled: true,
  },
}
/** Slack's new-app window with the manifest already in it: pick the workspace and press Create. */
const MANIFEST_URL = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(MANIFEST))}`

/**
 * Markdown as a session writes it → Slack's mrkdwn, for where Slack takes nothing else (context blocks, and a
 * message Slack would not take as markdown_text). Code is left alone. Slack only sees *bold* at a word's edge,
 * so a zero-width space goes around it ("**통과**했고" stays bold), and inline code inside the bold stays in it.
 */
export function toMrkdwn(text) {
  return String(text)
    .split(/(```[\s\S]*?```)/)
    .map((part, i) => {
      if (i % 2) return part.replace(/^```[a-zA-Z0-9_-]+\n/, '```\n')
      const codes = []
      return part
        .replace(/`[^`\n]*`/g, (c) => `\u0000${codes.push(c) - 1}\u0000`)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/^#{1,6}\s+(.+)$/gm, '\u200b*$1*\u200b')
        .replace(/\*\*([^*\n]+?)\*\*/g, '\u200b*$1*\u200b')
        .replace(/!?\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
        .replace(/^(\s*)[-*]\s+/gm, '$1• ')
        .replace(/\u0000(\d+)\u0000/g, (_, k) => codes[k])
    })
    .join('')
}

/** Slack takes about 4000 characters in a message: longer text goes in pieces, cut at a line where it can. */
export function pieces(text, max = 3500) {
  const out = []
  let rest = String(text)
  while (rest.length > max) {
    const cut = rest.lastIndexOf('\n', max)
    const at = cut > max / 2 ? cut : max
    out.push(rest.slice(0, at))
    rest = rest.slice(at).replace(/^\n/, '')
  }
  if (rest.trim()) out.push(rest)
  return out
}

export default {
  id: 'slack',
  name: 'Slack',
  about: '세션을 Slack 전용 채널에서 이어서 할 수 있어요. 한 세션은 한 번에 한 곳(브릿지 또는 Slack)에서만 작업해요. 세션 메뉴의 "Slack 으로 옮기기"로 보내고, Slack 스레드의 "브릿지로 옮기기"로 가져와요. 채널에 새 글을 쓰면 Slack 에서 작업하는 새 세션이 떠요. 내 Slack 앱과 내 채널을 써요.',
  fields: [
    { key: 'botToken', label: 'Bot 토큰', placeholder: 'xoxb-…', secret: true, required: true, prefix: 'xoxb-' },
    { key: 'appToken', label: 'App 토큰 (Socket Mode)', placeholder: 'xapp-…', secret: true, required: true, prefix: 'xapp-' },
    { key: 'channel', label: '전용 채널', placeholder: 'C0123ABCD', required: true, pick: '채널 고르기' },
    // `places`: JSON {main: hostId, dirs: {hostId: folder}}, set with buttons (기기마다 폴더, 기본 기기).
    { key: 'places', label: '기기별로 새 세션을 띄울 곳', kind: 'places', max: 4000 },
    { key: 'cwd', label: '기기별 폴더가 없을 때 쓸 폴더 (비우면 홈)', placeholder: '~/projects' },
  ],
  // The guide the settings window shows: each step says where to click and what to bring back.
  help: [
    {
      title: '1. Slack 앱 만들기 (1분)',
      text: '아래 링크를 열면 매니페스트가 채워진 새 앱 창이 떠요. 워크스페이스를 고르고 Next → Create 를 누릅니다. 권한과 Socket Mode 설정이 매니페스트에 다 들어 있어서 따로 켤 것은 없습니다. 창이 비어 있으면 From a manifest 를 고르고 JSON 탭에 복사한 매니페스트를 붙여 넣습니다.',
      link: { label: '매니페스트 채운 새 앱 창 열기', url: MANIFEST_URL },
      copy: { label: '앱 매니페스트 복사', text: JSON.stringify(MANIFEST, null, 2) },
    },
    {
      title: '2. 워크스페이스에 설치하고 Bot 토큰 받기',
      text: '왼쪽 메뉴의 Install App → Install to Workspace → 허용. 설치가 끝나면 보이는 Bot User OAuth Token (xoxb- 로 시작) 을 복사해 위의 "Bot 토큰" 칸에 넣습니다. 나중에 다시 보려면 OAuth & Permissions 에 있습니다.',
    },
    {
      title: '3. App 토큰 만들기',
      text: '왼쪽 메뉴의 Basic Information → 아래로 내려 App-Level Tokens → Generate Token and Scopes. 이름은 아무거나(예: socket), Add Scope 에서 connections:write 를 고르고 Generate. 나온 토큰 (xapp- 로 시작) 을 "App 토큰" 칸에 넣습니다.',
    },
    {
      title: '4. 전용 채널 만들고 봇 부르기',
      text: 'Slack 에서 Agent Bridge 만 쓰는 채널을 하나 만듭니다(혼자 쓰는 비공개 채널을 권합니다). 다른 봇이나 대화가 있는 채널은 피하세요: 채널 맨 위에 쓴 글은 모두 새 세션이 됩니다. 채널에 아래 명령을 보내 봇을 부릅니다.',
      copy: { label: '초대 명령 복사', text: '/invite @claude-bridge' },
    },
    {
      title: '5. 전용 채널 고르고 켜기',
      text: '"전용 채널" 칸 옆의 "채널 고르기" 를 누르면 봇이 들어간 채널이 나옵니다. 4단계의 채널을 고르고 "저장하고 켜기" 를 누릅니다. 봇이 들어간 채널이 하나뿐이면 비워 두고 눌러도 그 채널로 정해집니다. 목록이 안 나오면 채널 이름을 눌러 채널 정보 맨 아래의 채널 ID (C 로 시작) 를 복사해 직접 넣어도 됩니다. 상태가 "켜짐" 이 되면 연결된 것입니다.',
    },
    {
      title: '6. 내 Slack 계정 연결하기',
      text: '채널에 아무 글이나 한 번 씁니다. 봇이 나에게만 보이는 연결 링크를 줍니다. 이 사이트에 로그인한 브라우저에서 그 링크를 열면 끝입니다. 링크를 열지 않은 Slack 계정은 채널에 있어도 세션을 조작할 수 없습니다.',
    },
    {
      title: '7. 브릿지와 Slack 오가기',
      text: '한 세션은 한 번에 한 곳에서만 작업합니다. 브릿지의 세션 메뉴에서 "Slack 으로 옮기기" 를 누르면 전용 채널에 그 세션의 스레드가 생기고(있으면 그 스레드를 이어 씁니다), 브릿지 화면은 읽기 전용이 됩니다. 스레드의 "브릿지로 옮기기" 를 누르면 브릿지에서 이어서 쓰고, 스레드에는 브릿지로 가는 링크가 남습니다. 어느 쪽에서 나눈 대화든 브릿지의 세션 화면에 모두 남습니다.',
    },
    {
      title: '안 될 때',
      text: '"토큰을 받지 않았어요": 두 토큰이 서로 바뀌지 않았는지(xoxb- 는 Bot, xapp- 는 App) 확인합니다. "채널 고르기" 가 권한이 없다고 하면: 예전 매니페스트로 만든 앱입니다. OAuth & Permissions 에서 channels:read, groups:read 를 더하고 앱을 다시 설치합니다. 켜짐인데 반응이 없으면: 봇이 그 채널에 들어와 있는지 확인합니다. 새 세션이 안 뜨면: 맥의 에이전트가 연결돼 있어야 합니다.',
    },
  ],
  // The part of the setup an AI that drives a browser (or has Slack tools) can do: the app and the channel.
  // Tokens are left to the person: such an AI should not read or type secrets, and they go into this site only.
  prompt: {
    label: 'AI 에게 Slack 쪽 준비 맡기기',
    about: '브라우저를 조작할 수 있는 AI(Claude in Chrome 등)에게 주면 앱 만들기, 설치 준비, 전용 채널 만들기와 봇 초대까지 해요. 토큰 두 개를 복사해 넣는 것만 직접 하면 돼요. Slack 에 로그인된 브라우저여야 해요.',
    text: `Agent Bridge 를 Slack 에 연결하려고 해. Slack 쪽 준비를 내 브라우저로 대신 해 줘. 단계마다 끝나면 한 줄로 알려 줘.

지킬 것
- 토큰은 다루지 마. 화면에 xoxb-, xapp- 로 시작하는 값이 보여도 읽거나 옮겨 적거나 어디에 넣지 마. 토큰은 내가 직접 복사해.
- 권한 허용(Allow) 화면, 워크스페이스 고르기처럼 내가 정할 것이 나오면 멈추고 나에게 물어.
- 다른 앱의 설정을 바꾸거나, 앱·채널을 지우거나, 다른 사람을 초대하지 마. 메시지는 3단계의 초대 명령만 보내.

1. 앱 만들기: 아래 링크를 연다. 매니페스트가 채워진 새 앱 창이 뜬다. 워크스페이스를 고르고(여러 개면 나에게 묻는다) Next → Create 를 누른다.
   ${MANIFEST_URL}
   창이 비어 있으면 "From a manifest" 를 고르고 JSON 탭의 내용을 지운 뒤 아래 매니페스트를 붙여 넣는다.
${JSON.stringify(MANIFEST)}

2. 설치와 App 토큰 만들기: 왼쪽 메뉴 Install App → Install to Workspace 를 누르고, 허용 화면에서 멈춰 내가 누르게 한다. 그다음 Basic Information → App-Level Tokens → Generate Token and Scopes 에서 이름 socket, 범위 connections:write 로 Generate 한다. 만든 토큰 창은 닫지 말고 그대로 둔다.

3. 전용 채널: Agent Bridge 만 쓰는 비공개 채널을 만든다. 이름은 agent-bridge 를 제안하고 나에게 확인받는다(이미 있으면 다른 이름을 묻는다). 다른 대화가 있는 채널은 쓰지 않는다. 그 채널에 "/invite @claude-bridge" 를 보내 봇을 부른다.

4. 끝나면 앱 이름, 워크스페이스, 채널 이름을 알려 주고 내가 할 일을 이대로 적어 줘:
   - Bot 토큰(xoxb-): 앱 설정 → OAuth & Permissions → Bot User OAuth Token 복사
   - App 토큰(xapp-): 앱 설정 → Basic Information → App-Level Tokens → socket 복사
   - {origin}/guide 의 Slack 단계에서 "토큰 넣기" 를 눌러 두 토큰을 붙여 넣고, "채널 고르기" 로 3단계의 채널을 고른 뒤 "저장하고 켜기"
   - 채널에 아무 글이나 한 번 써서 봇이 주는 연결 링크를 열기`,
  },

  /** The channels the bot is in, for "채널 고르기": asked with the bot token being typed or the one saved. */
  async choices(config, key) {
    if (key !== 'channel') return []
    if (!config.botToken) throw new Error('Bot 토큰을 먼저 넣어 주세요')
    const out = []
    let cursor = ''
    try {
      for (let page = 0; page < 10; page++) {
        const r = await call('users.conversations', { types: 'public_channel,private_channel', exclude_archived: true, limit: 200, cursor }, config.botToken)
        for (const c of r.channels ?? []) out.push({ value: c.id, label: `#${c.name}`, hint: `${c.is_private ? '비공개' : '공개'} · ${c.id}` })
        cursor = r.response_metadata?.next_cursor ?? ''
        if (!cursor) break
      }
    } catch (e) {
      if (/missing_scope/.test(e.message)) throw new Error('Slack 앱에 channels:read, groups:read 권한이 없어요. OAuth & Permissions 에서 두 권한을 더하고 앱을 다시 설치하거나, 채널 ID 를 직접 넣어 주세요')
      if (/invalid_auth|not_authed|token_revoked|account_inactive/.test(e.message)) throw new Error(`Slack 이 Bot 토큰을 받지 않았어요 (${e.message})`)
      throw e
    }
    if (!out.length) throw new Error('봇이 들어간 채널이 없어요. 전용 채널에서 /invite @claude-bridge 를 보낸 뒤 다시 눌러 주세요')
    return out.sort((a, b) => a.label.localeCompare(b.label))
  },

  /**
   * @param config what the person filled in
   * @param host   { state, save(), log(), origin, code(), sessions(), find(thread), seat(thread) → {where, link},
   *                 summary(thread), seatUrl(thread, url), moveTo(thread, 'web'|'slack'), send(thread, text, images),
   *                 command(value), start({ prompt, cwd }) }
   */
  async start(config, host) {
    const st = host.state
    st.threads ??= {} // session thread → Slack thread ts
    st.msgs ??= {} // session message (a card) → Slack message ts
    st.users ??= [] // Slack members who may drive the sessions
    st.seatMsg ??= {} // session thread → the message in its Slack thread that carries the move button
    const bySlack = () => Object.fromEntries(Object.entries(st.threads).map(([k, v]) => [v, k]))
    const here = (thread) => host.seat?.(thread)?.where === 'slack'
    const pending = new Map() // link code → Slack member
    let status = { state: 'connecting', note: 'Slack 에 연결하는 중' }
    let stopped = false
    let ws = null
    let botUser = ''
    // The channel by name on the plugin card; asked once, the id stands in until then or if Slack will not say.
    let channelName = ''
    const where = () => (channelName ? `#${channelName}` : config.channel)

    const slack = (method, args, token = config.botToken) => call(method, args, token)
    // One thing at a time, in order: a card must not be posted before the text that led to it.
    let queue = Promise.resolve()
    const queued = (fn) => {
      const p = queue.then(fn)
      queue = p.catch((e) => host.log(`slack: ${e.message}`))
      return p
    }
    const inOrder = (fn) => queued(fn).catch(() => {})
    // Slack takes at most 50 blocks in a message and refuses the whole message past that.
    const post = (thread_ts, text, blocks) => slack('chat.postMessage', { channel: config.channel, thread_ts, text: truncate(text, 3900), ...(blocks ? { blocks: blocks.slice(0, 50) } : {}), unfurl_links: false })
    // What a session says goes as markdown_text: Slack reads its Markdown (bold next to Korean, code in bold,
    // tables) as written. If Slack will not take that, the same piece goes as mrkdwn, and so does what follows for a while.
    // A refusal is remembered for 10 minutes, so one bad moment does not turn it off for good.
    let mdRefused = 0
    const postMd = async (thread_ts, md) => {
      if (Date.now() - mdRefused > 600_000)
        try {
          return await slack('chat.postMessage', { channel: config.channel, thread_ts, markdown_text: md, unfurl_links: false })
        } catch (e) {
          mdRefused = Date.now()
          host.log(`slack: markdown_text 를 받지 않아 mrkdwn 으로 보냄 (${e.message})`)
        }
      let r
      for (const p of pieces(toMrkdwn(md))) r = await post(thread_ts, p)
      return r
    }
    const whisper = (user, thread_ts, text, blocks) => slack('chat.postEphemeral', { channel: config.channel, user, thread_ts, text, ...(blocks ? { blocks } : {}) }).catch(() => {})
    const permalink = (ts) => slack('chat.getPermalink', { channel: config.channel, message_ts: ts }).then((r) => r.permalink ?? null, () => null)
    const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text: truncate(text, 2900) } })
    const toWeb = (thread) => button('브릿지로 옮기기', 'seat_web', thread, { style: 'primary', ...(host.seat?.(thread)?.link ? { url: host.seat(thread).link } : {}) })
    const toSlack = (thread) => button('Slack 으로 가져오기', 'seat_slack', thread)

    /** The message that says where a session is, with the button that moves it; the one before loses its button. */
    async function seatMessage(thread, root, text, btn) {
      const old = st.seatMsg[thread]
      if (old) await slack('chat.update', { channel: config.channel, ts: old.ts, text: truncate(old.text, 3900), blocks: [section(old.text)] }).catch(() => {})
      const r = await post(root, text, [section(text), { type: 'actions', block_id: 'bridge_seat', elements: [btn] }])
      st.seatMsg[thread] = { ts: r.ts, text }
      host.save()
      return r.ts
    }

    /** The Slack thread of a session; made with a head when the session has none yet. */
    async function threadOf(thread) {
      if (st.threads[thread]) return st.threads[thread]
      const s = host.find(thread)
      const head = `*${truncate(s?.title || s?.name || s?.preview || '새 세션', 80)}*\n${[s?.bridge?.host, s?.cwd].filter(Boolean).join(' · ')}`
      const r = await post(undefined, head)
      st.threads[thread] = r.ts
      host.save()
      return r.ts
    }

    // What 전부 허용 allowed comes as a run of one-liners: the run is one message, rewritten as it grows, so the
    // thread is not buried under them. It ends at anything else posted in the thread, and before it would pass
    // what one message may hold (a section's 3,000 characters), so no line of it is ever dropped.
    const runs = new Map() // session thread → { ts, items, total, counts, sent, timer }
    const runText = (run) => `⚡ 자동 허용 ${run.total}개`
    const runBlocks = (run) => [
      section(truncate(`${runText(run)} · ${[...run.counts].map(([n, c]) => (c > 1 ? `${n} ${c}` : n)).join(' · ')}`, 300)),
      section(listOf(run.items)),
    ]
    const edit = async (run) => {
      if (stopped || run.sent === run.total) return
      run.sent = run.total
      await slack('chat.update', { channel: config.channel, ts: run.ts, text: runText(run), blocks: runBlocks(run) })
    }
    /** In the queue: the run is over; what it took since its last edit is written before anything else goes out. */
    async function endRun(thread) {
      const run = runs.get(thread)
      if (!run) return
      runs.delete(thread)
      clearTimeout(run.timer)
      await edit(run)
    }
    /** In the queue: one more allowed tool, onto the open run or a new one. */
    async function allowed(thread, ev) {
      const tool = { name: ev.auto?.name ?? '터미널 확인 창', what: ev.auto?.what ?? '', desc: !!ev.auto?.desc }
      let run = runs.get(thread)
      const items = run && withTool(run.items, tool)
      if (run && (items.length > AUTO_RUN_MAX || listOf(items).length > AUTO_LIST_MAX)) {
        await endRun(thread)
        run = null
      }
      if (run) {
        run.items = items
        run.total++
        run.counts.set(tool.name, (run.counts.get(tool.name) ?? 0) + 1)
        // Edits are spaced out: chat.update is limited per app, and every session in Slack shares it.
        run.timer ??= setTimeout(() => ((run.timer = null), inOrder(() => edit(run))), AUTO_EDIT_MS())
        return
      }
      run = { ts: null, items: withTool([], tool), total: 1, counts: new Map([[tool.name, 1]]), sent: 1, timer: null }
      const r = await post(await threadOf(thread), runText(run), runBlocks(run))
      run.ts = r.ts
      runs.set(thread, run)
    }

    /** What a session did, in the Slack shape (server/cs.mjs). Only a session in Slack is posted. */
    function onEvent(thread, ev) {
      if (stopped) return
      // A card already in the thread is kept true wherever it was answered.
      if (ev.type === 'msg_update')
        return void inOrder(async () => {
          const ts = st.msgs[ev.ts]
          if (ts) await slack('chat.update', { channel: config.channel, ts, text: truncate(ev.text, 3900), blocks: (ev.blocks ?? []).slice(0, 50) })
        })
      if (!here(thread)) return
      if (ev.type === 'msg' && ev.auto && !ev.ephemeral) return void inOrder(() => allowed(thread, ev))
      if ((ev.type === 'user' && ev.via !== 'slack' && ev.text) || (ev.type === 'text' && ev.text) || (ev.type === 'msg' && !ev.ephemeral) || (ev.type === 'notice' && ev.text) || ev.type === 'end') inOrder(() => endRun(thread))
      if (ev.type === 'user' && ev.via !== 'slack' && ev.text) inOrder(async () => post(await threadOf(thread), `💬 ${ev.text}`, [{ type: 'context', elements: [{ type: 'mrkdwn', text: `💬 Slack 밖에서 보냄: ${truncate(toMrkdwn(ev.text), 2800)}` }] }]))
      else if (ev.type === 'text' && ev.text)
        inOrder(async () => {
          const ts = await threadOf(thread)
          for (const p of pieces(ev.text, MD_MAX)) await postMd(ts, p)
        })
      else if (ev.type === 'msg' && !ev.ephemeral)
        inOrder(async () => {
          const r = await post(await threadOf(thread), ev.text, ev.blocks)
          st.msgs[ev.ts] = r.ts
          // Kept for the cards still open and a while after; not for ever.
          for (const k of Object.keys(st.msgs).slice(0, -300)) delete st.msgs[k]
          host.save()
        })
      else if (ev.type === 'notice' && ev.text) inOrder(async () => post(await threadOf(thread), ev.text, [{ type: 'context', elements: [{ type: 'mrkdwn', text: truncate(toMrkdwn(ev.text), 2900) }] }]))
      else if (ev.type === 'end') inOrder(async () => st.threads[thread] && post(st.threads[thread], `세션이 끝났어요 (${ev.why ?? '종료'})`))
    }

    /** From the bridge into Slack: the session's thread (made now if it has none) says where the earlier talk is. */
    function moveIn(thread) {
      return queued(async () => {
        await endRun(thread).catch(() => {})
        const s = host.summary?.(thread) ?? {}
        const lines = [
          '🔀 *Slack 으로 옮겼어요.* 이제 이 스레드에 답하면 세션에 전달돼요.',
          s.link ? `이전 대화: <${s.link}|브릿지에서 보기>` : '',
          s.last ? `마지막 답:\n>${truncate(toMrkdwn(s.last), 700).replace(/\n/g, '\n>')}` : '',
        ].filter(Boolean)
        let root = st.threads[thread]
        let ts
        if (root) ts = await seatMessage(thread, root, lines.join('\n'), toWeb(thread))
        else {
          // A new thread: its first message is the head and carries the button.
          const head = `*${truncate(s.title || '세션', 80)}*${s.host || s.cwd ? `\n${[s.host, s.cwd].filter(Boolean).join(' · ')}` : ''}`
          ts = root = await seatMessage(thread, undefined, `${head}\n${lines.join('\n')}`, toWeb(thread))
          st.threads[thread] = root
          host.save()
        }
        return { url: (await permalink(ts)) ?? (await permalink(root)) }
      })
    }

    /** From Slack to the bridge: the thread keeps a way to the session's page and a way back. */
    function moveOut(thread) {
      const link = host.seat?.(thread)?.link
      inOrder(async () => {
        await endRun(thread).catch(() => {})
        const root = st.threads[thread]
        if (!root) return
        await seatMessage(thread, root, `🌐 *브릿지로 옮겼어요.* 이어서 하려면 ${link ? `<${link}|브릿지에서 열기>` : '브릿지에서 여세요'}. 이 스레드에 쓰는 글은 이제 세션에 가지 않아요.`, toSlack(thread))
      })
    }

    /** Someone the plugin has not seen: they get a link, and whoever is signed in to the bridge decides. */
    async function askToLink(user, thread_ts) {
      const code = host.code()
      pending.set(code, user)
      setTimeout(() => pending.delete(code), 10 * 60_000).unref?.()
      await slack('chat.postEphemeral', { channel: config.channel, user, thread_ts, text: `이 Slack 계정으로 세션을 조작하려면 Agent Bridge 에 로그인한 브라우저에서 이 링크를 여세요 (10분): ${host.origin}/api/plugins/slack/link?code=${code}` })
    }

    async function pictures(files) {
      const out = []
      for (const f of (files ?? []).filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.mimetype ?? '') && onFilesHost(f.url_private)).slice(0, 8)) {
        const r = await fetch(f.url_private, { headers: { Authorization: `Bearer ${config.botToken}` } })
        if (r.ok) out.push({ name: f.name, data: `data:${f.mimetype};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}` })
      }
      return out
    }

    async function onMessage(m) {
      if (m.channel !== config.channel || m.bot_id || !m.user || m.user === botUser) return
      if (m.subtype && m.subtype !== 'file_share') return
      if (!st.users.includes(m.user)) return askToLink(m.user, m.thread_ts)
      const text = String(m.text ?? '').replace(/<@[A-Z0-9]+>\s*/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim()
      const say = (t) => post(m.thread_ts ?? m.ts, t).catch(() => {})
      try {
        if (m.thread_ts) {
          const thread = bySlack()[m.thread_ts]
          if (!thread) return void say('이 스레드에 이어진 세션이 없어요. 채널에 새 글을 쓰면 새 세션이 떠요.')
          const seat = host.seat?.(thread)
          if (seat && seat.where !== 'slack') {
            const t = `이 세션은 지금 브릿지에서 작업 중이라 이 글은 전달하지 않았어요. <${seat.link}|브릿지에서 열기>`
            return void (await whisper(m.user, m.thread_ts, t, [section(t), { type: 'actions', elements: [toSlack(thread)] }]))
          }
          if (text === '브릿지로 옮기기') return void (await host.moveTo(thread, 'web'))
          const images = await pictures(m.files)
          if (!text && !images.length) return
          await host.send(thread, text, images)
        } else {
          const images = await pictures(m.files)
          if (!text && !images.length) return
          // In the queue: what the new session says while it starts waits until its thread is known.
          await inOrder(async () => {
            try {
              const { thread } = await host.start({ prompt: text, cwd: config.cwd || '', places: config.places || '' })
              st.threads[thread] = m.ts
              host.save()
              await seatMessage(thread, m.ts, '세션을 띄웠어요. 이 스레드에 답하면 세션에 전달돼요. 웹에서 이어서 하려면 *브릿지로 옮기기* 를 누르세요.', toWeb(thread))
              host.seatUrl?.(thread, await permalink(m.ts))
            } catch (e) {
              await say(`⚠️ ${e.message}`)
            }
          })
        }
      } catch (e) {
        await say(`⚠️ ${e.message}`)
      }
    }

    async function onAction(p) {
      if (p.channel?.id !== config.channel) return
      const thread_ts = p.message?.thread_ts ?? p.container?.thread_ts
      if (!st.users.includes(p.user?.id)) return askToLink(p.user.id, thread_ts)
      for (const a of p.actions ?? []) {
        try {
          if (a.action_id === 'seat_web' || a.action_id === 'seat_slack') await host.moveTo(a.value, a.action_id === 'seat_web' ? 'web' : 'slack')
          else await host.command(a.value ?? a.selected_option?.value ?? '')
        } catch (e) {
          await whisper(p.user.id, thread_ts, `⚠️ ${e.message}`)
        }
      }
    }

    /** Socket Mode: Slack hands out a WebSocket address; every envelope is acknowledged, then acted on. */
    async function connect() {
      let wait = 1000
      while (!stopped) {
        try {
          botUser = (await slack('auth.test')).user_id
          if (!channelName) channelName = await slack('conversations.info', { channel: config.channel }).then((r) => String(r.channel?.name ?? ''), () => '')
          const { url } = await slack('apps.connections.open', {}, config.appToken)
          await new Promise((resolve, reject) => {
            ws = new WebSocket(url)
            ws.onopen = () => {
              wait = 1000
              status = { state: 'on', note: `연결됨 · 채널 ${where()}${st.users.length ? '' : ' · 채널에 글을 써서 Slack 계정을 연결하세요'}` }
              host.changed()
            }
            ws.onmessage = (e) => {
              let env
              try {
                env = JSON.parse(e.data)
              } catch {
                return
              }
              if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id }))
              if (env.type === 'disconnect') return ws.close()
              if (env.type === 'events_api' && env.payload?.event?.type === 'message') onMessage(env.payload.event).catch((err) => host.log(`slack: ${err.message}`))
              else if (env.type === 'interactive' && env.payload?.type === 'block_actions') onAction(env.payload).catch((err) => host.log(`slack: ${err.message}`))
            }
            ws.onclose = resolve
            ws.onerror = () => reject(new Error('Slack 과의 연결이 끊겼어요'))
          })
        } catch (e) {
          // A wrong token does not get better by trying again every second.
          const fatal = /invalid_auth|not_authed|account_inactive|token_revoked|not_allowed_token_type|missing_scope/.test(e.message)
          status = { state: 'error', note: fatal ? `Slack 이 토큰을 받지 않았어요 (${e.message})` : `다시 연결하는 중 (${e.message})` }
          host.changed()
          if (fatal) return
        }
        if (stopped) return
        await sleep(wait)
        wait = Math.min(wait * 2, 30_000)
      }
    }
    connect()

    return {
      onEvent,
      moveIn,
      moveOut,
      status: () => ({ ...status, linked: st.users.length }),
      /**
       * Who a link would connect, for the page that asks before connecting (R1-M2): the Slack id and the name Slack
       * gives for it. Null when the code is unknown or expired. Looking does not use the code up.
       */
      async who(code) {
        const user = pending.get(code)
        if (!user) return null
        const u = await slack('users.info', { user }).then((r) => r.user, () => null)
        return { user, name: u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name || user }
      },
      /** POST /api/plugins/slack/link {code}: the person signed in to the bridge said yes on that page. */
      link(code) {
        const user = pending.get(code)
        if (!user) return '링크가 만료됐어요. Slack 채널에 글을 다시 써 주세요.'
        pending.delete(code)
        if (!st.users.includes(user)) st.users.push(user)
        host.save()
        status = { ...status, note: `연결됨 · 채널 ${where()}` }
        host.changed()
        slack('chat.postEphemeral', { channel: config.channel, user, text: '연결됐어요. 이제 이 채널에 글을 쓰면 세션이 뜨고, 스레드에 답하면 그 세션에 전달돼요.' }).catch(() => {})
        return 'Slack 계정을 연결했어요. 이 창은 닫아도 됩니다.'
      },
      stop() {
        stopped = true
        for (const run of runs.values()) clearTimeout(run.timer)
        try {
          ws?.close()
        } catch {}
        // Off: the session menu no longer offers Slack.
        host.changed()
      },
    }
  },
}
