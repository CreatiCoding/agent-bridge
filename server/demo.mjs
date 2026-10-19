// 데모 모드 (REQ-F-766, REQ-S-068): a Mac played inside the server for the beta reviewer's account. It stands where a
// bridge tab's stream would (server.mjs puts `res` in `bridges`), reads the commands the server sends down, and
// answers through the same handler a real tab's /api/bridge/up reaches: transcript lines, status, cards. So the page
// and the server run their real paths, and nothing of it ever reaches a real Mac. No dependencies.
import crypto from 'node:crypto'

/**
 * A demo account: one per demo sign-in, so reviewers signed in at the same time never clear each other's screens.
 * Not a GitHub login and never made from one (GitHub's are `gh<id>`, dev ones `dev-<name>`).
 */
export const newDemoUid = () => `demo-${crypto.randomBytes(6).toString('hex')}`
export const isDemoUid = (uid) => typeof uid === 'string' && /^demo-[0-9a-f]{12}$/.test(uid)
/** Its Mac. No real Mac may say hello with an id of this shape (server.mjs refuses it). */
export const demoHostOf = (uid) => `demohost-${uid.slice(5)}`
export const isDemoHost = (id) => typeof id === 'string' && id.startsWith('demohost-')
/** Shown as the account's name: not a valid GitHub login, so it never matches an operator, an allow-list entry or a pin. */
export const DEMO_LOGIN_NAME = '심사용 데모'
const HOME = '/Users/demo'
const MODEL = 'claude-sonnet-5-5'
export const DEMO_REFUSED = '데모에서는 쓸 수 없어요'

/**
 * The account's starting arrangement for the seed sessions `sids`: the first two in one group, the third outside it.
 * Voice input is on, so its button and screen are there to try (the demo Mac does not transcribe).
 */
export const demoPrefs = (sids) => ({ groups: [{ id: crypto.randomBytes(4).toString('hex'), name: '데모 프로젝트', items: sids.slice(0, 2) }], loose: [sids[2]], defaultPrompt: '', voice: { on: true } })

const iso = (t) => new Date(t).toISOString()
const uuid = () => crypto.randomUUID()
const userLine = (at, content) => JSON.stringify({ type: 'user', uuid: uuid(), timestamp: iso(at), message: { role: 'user', content } })
const asstLine = (at, content) => JSON.stringify({ type: 'assistant', uuid: uuid(), timestamp: iso(at), message: { role: 'assistant', model: MODEL, content } })
const say = (at, text) => asstLine(at, [{ type: 'text', text }])
const toolUse = (at, id, name, input) => asstLine(at, [{ type: 'tool_use', id, name, input }])
const toolResult = (at, id, text) => userLine(at, [{ type: 'tool_result', tool_use_id: id, content: text }])

const permissionCard = (command) => ({
  id: uuid(),
  open: true,
  at: Date.now(),
  kind: 'permission',
  title: 'Bash command',
  context: command,
  description: '데모라 실제로 실행하지는 않아요',
  options: [
    { n: 1, label: 'Yes', kind: 'allow-once' },
    { n: 2, label: `Yes, and don't ask again for ${command.split(' ').slice(0, 2).join(' ')} commands in this project`, kind: 'allow-always' },
    { n: 3, label: 'No, and tell Claude what to do differently', kind: 'deny' },
  ],
  tool: { name: 'Bash', input: { command } },
})

/** The three sessions the account starts with: a finished piece of work, one waiting on a permission, a short chat. */
function seed(now, ids) {
  const m = (min) => now - min * 60_000
  return [
    {
      id: ids[0],
      cwd: `${HOME}/projects/todo-app`,
      lines: [
        JSON.stringify({ type: 'ai-title', aiTitle: '할 일 앱에 다크 모드 넣기' }),
        userLine(m(42), '할 일 앱에 다크 모드를 넣어 줘. 시스템 설정을 따라가면 좋겠어.'),
        say(m(41.8), '좋아요. 먼저 스타일 파일을 볼게요.'),
        toolUse(m(41.75), 'toolu_demo_plan1', 'mcp__bridge__todos', { todos: [{ content: '스타일 파일 보기', activeForm: '스타일 파일 보는 중', status: 'in_progress' }, { content: '다크 모드 색 더하기', status: 'pending' }, { content: '테스트 돌리기', status: 'pending' }] }),
        toolResult(m(41.75), 'toolu_demo_plan1', '할 일 3개 중 0개 완료로 패널에 보였어요.'),
        toolUse(m(41.7), 'toolu_demo_read', 'Read', { file_path: `${HOME}/projects/todo-app/src/styles.css` }),
        toolResult(m(41.6), 'toolu_demo_read', ':root {\n  --bg: #ffffff;\n  --text: #1b1b1a;\n}'),
        toolUse(m(41), 'toolu_demo_edit', 'Edit', { file_path: `${HOME}/projects/todo-app/src/styles.css`, old_string: '}', new_string: '}\n@media (prefers-color-scheme: dark) {\n  :root { --bg: #1b1b1a; --text: #e8e6df; }\n}' }),
        toolResult(m(40.9), 'toolu_demo_edit', 'The file has been updated.'),
        toolUse(m(40.5), 'toolu_demo_test', 'Bash', { command: 'npm test', description: '테스트 실행' }),
        toolResult(m(40), 'toolu_demo_test', '> todo-app@1.0.0 test\n> vitest run\n\n ✓ src/app.test.ts (6 tests)\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)'),
        toolUse(m(39.9), 'toolu_demo_plan2', 'mcp__bridge__todos', { todos: [{ content: '스타일 파일 보기', status: 'completed' }, { content: '다크 모드 색 더하기', status: 'completed' }, { content: '테스트 돌리기', status: 'completed' }] }),
        toolResult(m(39.9), 'toolu_demo_plan2', '할 일 3개 중 3개 완료로 패널에 보였어요.'),
        say(m(39.8), '다크 모드를 넣었어요.\n\n- `styles.css` 에 `prefers-color-scheme: dark` 일 때의 색을 더했어요\n- 시스템 설정을 바꾸면 바로 따라가요\n- 테스트 6개가 모두 통과했어요'),
      ],
    },
    {
      id: ids[1],
      cwd: `${HOME}/projects/todo-app`,
      lines: [
        JSON.stringify({ type: 'ai-title', aiTitle: 'README 정리하고 테스트 돌리기' }),
        userLine(m(12), 'README 의 설치 방법을 정리하고 테스트를 한 번 돌려 줘.'),
        say(m(11.8), 'README 를 정리했어요. 이제 테스트를 돌려 볼게요.'),
        toolUse(m(11.5), 'toolu_demo_wait', 'Bash', { command: 'npm test', description: '테스트 실행' }),
      ],
      // Waiting on the person: the card shows with 허용 / 거부 buttons.
      card: permissionCard('npm test'),
      pendingTool: 'toolu_demo_wait',
    },
    {
      id: ids[2],
      cwd: `${HOME}/projects/notes`,
      lines: [
        JSON.stringify({ type: 'ai-title', aiTitle: '이 앱은 무엇을 하나요?' }),
        userLine(m(3), '이 앱은 무엇을 하나요?'),
        say(m(2.9), 'Agent Bridge 는 맥에서 도는 Claude Code 세션을 폰이나 다른 컴퓨터에서 이어서 다루게 해 줘요.\n\n지금은 **데모 모드**예요. 실제 맥에 연결돼 있지 않고, 정해진 답만 보여 드려요. 아래 버튼을 눌러 보거나 아무 말이나 보내 보세요.\n\n```choices\n무엇을 할 수 있어요?\n권한 요청 보여 줘\n코드 예시 보여 줘\n```'),
      ],
    },
  ]
}

/** What the demo Mac answers to something said, chosen by its words. `permission` asks first with a card. */
export function demoReply(text) {
  const t = String(text ?? '').toLowerCase()
  // The page's 지금까지 한 일로 정리 (REQ-F-778): answered the way a session without the todos tool answers.
  if (/할 일 패널에 정리/.test(t))
    return { text: '지금까지 한 일과 남은 일을 정리했어요.\n\n```todos\n[x] **세션 목록** 둘러보기\n[x] 메시지 보내 보기\n[>] **할 일 패널** 써 보기\n[ ] **내 맥** 연결하기 (선택, 직접)\n```' }
  if (/권한|permission|허용/.test(t)) return { permission: 'npm run build', text: '빌드를 돌려 볼게요. 먼저 허용을 받아야 해요.' }
  if (/코드|code|예시/.test(t))
    return { text: '예를 들면 이런 코드를 써 드려요.\n\n```ts\nexport function greet(name: string) {\n  return `안녕하세요, ${name}님`\n}\n```\n\n데모 모드라 실제 파일은 바뀌지 않아요.' }
  if (/무엇|뭐|what|할 수/.test(t))
    return { text: '이런 것을 할 수 있어요.\n\n- 맥에서 도는 세션 목록을 보고 골라 열기\n- 메시지를 보내고 답을 실시간으로 받기\n- 권한 요청에 버튼으로 답하기\n- 세션을 그룹으로 묶기\n\n데모 모드예요. 실제 맥에 연결돼 있지 않아요.\n\n```choices\n권한 요청 보여 줘\n코드 예시 보여 줘\n```' }
  if (/안녕|hello|hi\b/.test(t)) return { text: '안녕하세요! 데모 모드예요. 실제 맥에 연결돼 있지 않아서 정해진 답만 드려요.' }
  return { text: '데모 모드예요. 실제 맥에 연결돼 있지 않아요.\n\n보내 주신 글은 받았어요. 실제로 쓰면 이 자리에 맥의 Claude 가 일한 결과가 나와요.' }
}

/**
 * The demo Mac. `up(msgs)` hands messages to the server as a bridge tab's /api/bridge/up would; `build` is the
 * agent build the server hands out (so it is not told to update). `reset()` starts over from the seed.
 */
export function createDemoMac({ build, up, log = () => {} }) {
  /** sid -> { id, cwd, lines, sent, phase, card, pendingTool, mode, effort, model, autoAllow, turnAt, timers } */
  let sessions = new Map()
  const send = (...msgs) => up(msgs)
  const later = (s, ms, f) => {
    const t = setTimeout(() => {
      s.timers.delete(t)
      if (sessions.get(s.id) === s) f()
    }, ms)
    t.unref?.()
    s.timers.add(t)
  }
  const stopAll = (s) => {
    for (const t of s.timers) clearTimeout(t)
    s.timers.clear()
  }

  function status(s) {
    send({ t: 'status', sid: s.id, alive: s.phase !== 'ended', phase: s.card ? 'waiting' : s.phase, waiting: s.card ? '권한 요청' : null, waitingSince: s.card?.at ?? null, held: [], tool: null, tools: 0, running: [], mode: s.mode, effort: s.effort, context: '9%', autoAllow: s.autoAllow, model: s.model, turnAt: s.turnAt, size: 24_000, card: s.card?.id ?? null })
  }
  /** The transcript lines the server does not have yet. */
  function flush(s) {
    if (s.lines.length > s.sent) send({ t: 'lines', sid: s.id, from: s.sent, lines: s.lines.slice(s.sent) })
    s.sent = s.lines.length
  }
  const add = (s, ...lines) => (s.lines.push(...lines), flush(s))

  function hello() {
    send({ t: 'hello', name: '데모 맥', kind: 'macbook', home: HOME, version: 'demo', build, info: { node: 'demo', os: 'macOS (데모)' }, ws: [], sessions: [...sessions.values()].map((s) => ({ id: s.id, cwd: s.cwd, conv: s.id, alive: s.phase !== 'ended' })) })
  }

  function open(sid, cwd) {
    const s = { id: sid, cwd, lines: [], sent: 0, phase: 'idle', card: null, pendingTool: null, mode: 'default', effort: 'medium', model: MODEL, autoAllow: false, turnAt: null, timers: new Set() }
    sessions.set(sid, s)
    return s
  }

  /** Back to the seed, under new session ids (returned, for the account's groups). */
  function reset() {
    stop()
    const ids = [uuid(), uuid(), uuid()]
    for (const x of seed(Date.now(), ids)) Object.assign(open(x.id, x.cwd), { lines: x.lines, card: x.card ?? null, pendingTool: x.pendingTool ?? null })
    hello()
    health()
    return ids
  }
  /** Nothing more is said: the account is gone. */
  function stop() {
    for (const s of sessions.values()) stopAll(s)
    sessions = new Map()
  }
  /** What the settings' voice screen shows for this Mac: ready, so the screen opens (REQ-F-758). */
  const VOICE = { whisper: true, models: ['large-v3-turbo-q5_0'], vadModel: true, vad: 'idle', ffmpeg: true }
  const health = () => send({ t: 'health', checks: [], features: [], repairs: [], awake: { idle: false, lid: false }, voice: VOICE, sessions: [...sessions.values()].map((s) => ({ id: s.id, lines: s.sent })) })

  /** A turn: busy, the words streamed in over about a second and a half, then the answer and idle. */
  function answer(s, said) {
    const r = demoReply(said)
    s.phase = 'busy'
    s.turnAt = Date.now()
    status(s)
    const words = r.text.split(/(?<=\s)/)
    const steps = 6
    for (let i = 1; i <= steps; i++) later(s, 250 * i, () => send({ t: 'preview', sid: s.id, text: words.slice(0, Math.ceil((words.length * i) / steps)).join('') }))
    later(s, 250 * steps + 200, () => {
      send({ t: 'preview', sid: s.id, text: '' })
      add(s, say(Date.now(), r.text))
      if (r.permission) {
        const id = `toolu_demo_${crypto.randomBytes(6).toString('hex')}`
        add(s, toolUse(Date.now(), id, 'Bash', { command: r.permission }))
        s.pendingTool = id
        s.card = permissionCard(r.permission)
        status(s)
        send({ t: 'card', sid: s.id, card: s.card })
        return
      }
      s.phase = 'idle'
      s.turnAt = null
      status(s)
    })
  }

  /** The person pressed a button on the permission card. */
  function decide(s, n) {
    const card = s.card
    const opt = card.options.find((o) => o.n === n)
    const allowed = !!opt && opt.kind !== 'deny' && n !== 'esc'
    s.card = null
    send({ t: 'card', sid: s.id, card: { id: card.id, open: false, result: allowed ? opt.label : '거부', at: Date.now() } })
    s.phase = 'busy'
    status(s)
    later(s, 700, () => {
      const tool = s.pendingTool
      s.pendingTool = null
      if (tool) add(s, toolResult(Date.now(), tool, allowed ? `> ${card.context}\n\n(데모 모드라 실제로 실행하지 않았어요)\n✓ 완료` : 'The user doesn’t want to proceed with this tool use.'))
      add(s, say(Date.now(), allowed ? '허용해 주셔서 실행했어요. 데모 모드라 실제 맥에서는 아무것도 실행되지 않았어요.' : '알겠어요. 실행하지 않을게요.'))
      s.phase = 'idle'
      s.turnAt = null
      status(s)
    })
  }

  const handlers = {
    welcome(cmd) {
      for (const [sid, k] of Object.entries(cmd.sessions ?? {})) {
        const s = sessions.get(sid)
        if (!s || !k.mine) continue
        s.sent = Math.min(Number(k.lines) || 0, s.lines.length)
        flush(s)
        status(s)
        if (s.card) send({ t: 'card', sid, card: s.card })
      }
    },
    resync(cmd) {
      const s = sessions.get(cmd.sid)
      if (!s) return
      // The server's copy is the count to go on from (a session opened again after it was ended).
      const n = Number(cmd.lines) || 0
      if (n > s.lines.length) s.lines.push(...Array(n - s.lines.length).fill('{}'))
      s.sent = n
      flush(s)
    },
    ping: (cmd) => (send({ t: 'pong', ts: cmd.ts }), health()),
    check: health,
    // The voice screen works up to here: the recording arrives, and the demo Mac says it does not transcribe.
    voice: (cmd) => send({ t: 'voice', reqId: cmd.reqId, ok: false, code: 'demo', error: '데모 모드라 실제 받아쓰기는 하지 않아요. 실제로 쓰면 세션의 맥이 말을 글로 바꿔 입력창에 넣어요.' }),
    // 복제: the copy starts with the original's lines; the server already has them drawn and does not draw them again.
    fork(cmd) {
      const from = sessions.get(cmd.sid)
      if (!from) return void send({ t: 'error', reqId: cmd.reqId, message: '세션을 찾지 못했어요' })
      const s = open(cmd.newSid, from.cwd)
      s.lines = [...from.lines]
      send({ t: 'forked', reqId: cmd.reqId, ok: true, sid: s.id, cwd: s.cwd })
      flush(s)
      status(s)
    },
    report: (cmd) => sessions.has(cmd.sid) && status(sessions.get(cmd.sid)),
    new(cmd) {
      const s = open(cmd.sid, `${HOME}/projects/${String(cmd.cwd ?? '').replace(/^~\/?/, '').split('/').filter((x) => /^[\w.-]{1,40}$/.test(x)).slice(-2).join('/') || 'demo'}`)
      if (cmd.mode) s.mode = String(cmd.mode).slice(0, 20)
      send({ t: 'opened', reqId: cmd.reqId, sid: s.id, ok: true, cwd: s.cwd })
      status(s)
      if (String(cmd.prompt ?? '').trim()) later(s, 300, () => (add(s, userLine(Date.now(), String(cmd.prompt).slice(0, 4000))), answer(s, cmd.prompt)))
    },
    open(cmd) {
      const s = sessions.get(cmd.sid) ?? open(cmd.sid, String(cmd.cwd || `${HOME}/projects/demo`))
      s.phase = 'idle'
      send({ t: 'opened', reqId: cmd.reqId, ok: true, sid: s.id, cwd: s.cwd, warnings: [] })
    },
    flush: (cmd) => send({ t: 'flushed', reqId: cmd.reqId, ok: true }),
    send(cmd) {
      const s = sessions.get(cmd.sid)
      if (!s) return
      send({ t: 'delivered', sid: s.id, ids: [cmd.id] })
      const text = String(cmd.text ?? '').slice(0, 4000)
      add(s, userLine(Date.now(), text))
      if (s.card) return
      answer(s, text)
    },
    answer(cmd) {
      const s = sessions.get(cmd.sid)
      if (s?.card && s.card.id === cmd.card) decide(s, cmd.n === 'esc' ? 'esc' : Number(cmd.n))
    },
    esc(cmd) {
      const s = sessions.get(cmd.sid)
      if (!s) return
      stopAll(s)
      send({ t: 'preview', sid: s.id, text: '' })
      if (s.card) decide(s, 'esc')
      else ((s.phase = 'idle'), (s.turnAt = null), status(s), send({ t: 'note', sid: s.id, text: '멈췄어요', tone: 'info' }))
    },
    close(cmd) {
      const s = sessions.get(cmd.sid)
      if (!s) return
      stopAll(s)
      s.phase = 'ended'
      s.card = null
    },
    set(cmd) {
      const s = sessions.get(cmd.sid)
      if (!s) return
      if (typeof cmd.autoAllow === 'boolean') s.autoAllow = cmd.autoAllow
      status(s)
    },
    setting(cmd) {
      const s = sessions.get(cmd.sid)
      if (!s) return
      if (cmd.kind === 'mode') s.mode = String(cmd.value).slice(0, 20)
      else if (cmd.kind === 'effort') s.effort = String(cmd.value).slice(0, 10)
      else if (cmd.kind === 'model') s.model = String(cmd.value).slice(0, 60)
      status(s)
    },
    refresh(cmd) {
      const s = sessions.get(cmd.sid)
      if (s) (send({ t: 'note', sid: s.id, text: '세션을 다시 열었어요 (데모)', tone: 'info' }), status(s))
    },
    retract(cmd) {
      const s = sessions.get(cmd.sid)
      if (s) send({ t: 'note', sid: s.id, text: '잘못 보낸 메시지라고 알렸어요 (데모)', tone: 'info' })
    },
    dropheld: (cmd) => send({ t: 'dropped', reqId: cmd.reqId, ok: true, ids: [] }),
    screen(cmd) {
      const text = `╭──────────────────────────────╮\n│ 데모 맥 · 실제 터미널이 아니에요 │\n╰──────────────────────────────╯\n\n> ${sessions.get(cmd.sid)?.cwd ?? HOME}`
      if (cmd.reqId) send({ t: 'screen', reqId: cmd.reqId, ok: true, text })
      else send({ t: 'screen', sid: cmd.sid, text })
    },
    skills: (cmd) => send({ t: 'skills', reqId: cmd.reqId, ok: true, menu: { direct: [], auto: [], other: [] } }),
    dirs: (cmd) => send({ t: 'dirs', reqId: cmd.reqId, ok: true, path: `${HOME}/projects`, parent: HOME, dirs: ['todo-app', 'notes', 'demo'] }),
    btw: (cmd) => send({ t: 'btw', reqId: cmd.reqId, ok: true, answer: '데모 모드예요. 곁가지 질문도 정해진 답만 드려요.' }),
  }

  /** A command from the server, as a bridge tab hands it on: acknowledged at once, then done a moment later. */
  function take(cmd) {
    if (!cmd || typeof cmd.t !== 'string') return
    if (cmd.reqId) send({ t: 'got', reqId: cmd.reqId })
    setImmediate(() => {
      try {
        const h = handlers[cmd.t]
        if (h) return void h(cmd)
        // Anything else that waits for an answer (a move, a fork, root, the Mac's accounts) is refused here too.
        if (cmd.reqId) send({ t: 'error', reqId: cmd.reqId, message: DEMO_REFUSED })
      } catch (e) {
        log('demo', cmd.t, e)
      }
    })
  }

  /** Stands in for the bridge tab's event stream: what the server writes down to it. */
  const res = {
    writable: true,
    writableLength: 0,
    write(chunk) {
      for (const line of String(chunk).split('\n')) {
        if (!line.startsWith('data: ')) continue
        try {
          take(JSON.parse(line.slice(6)))
        } catch {}
      }
      return true
    },
    end() {},
  }

  return { res, reset, stop, hello }
}
