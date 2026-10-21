// The Slack plugin against a pretend Slack: its Web API over HTTP and Socket Mode over a WebSocket.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { plugins } from '../../server/plugins.mjs'
import slack, { toMrkdwn, pieces, withTool, listOf } from '../../server/plugins/slack.mjs'

const until = async (fn, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('기다리던 일이 일어나지 않음')
}

/** A Slack that records what it is asked and lets the test push Socket Mode envelopes. */
async function fakeSlack() {
  const calls = []
  let socket = null
  const acks = []
  const server = http.createServer(async (req, res) => {
    // The plugin only POSTs. Anything else is not a Slack call: the bridge agent running these tests probes the
    // servers its sessions start with GET /, and counting that made the call counts flaky.
    if (req.method !== 'POST') return res.writeHead(404).end()
    let raw = ''
    for await (const c of req) raw += c
    const method = req.url.slice(1)
    const args = !raw ? {} : /json/.test(req.headers['content-type'] ?? '') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))
    calls.push({ method, args, token: req.headers.authorization })
    const reply = (o) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(o))
    if (req.headers.authorization === 'Bearer xoxb-bad') return reply({ ok: false, error: 'invalid_auth' })
    if (method === 'auth.test') return reply({ ok: true, user_id: 'UBOT' })
    if (method === 'apps.connections.open') return reply({ ok: true, url: `ws://127.0.0.1:${server.address().port}/socket` })
    if (method === 'users.info') return reply({ ok: true, user: { id: args.user, name: 'u1name', profile: { display_name: '<b>앨리스</b>' } } })
    if (method === 'chat.postMessage' && String(args.markdown_text ?? '').includes('NO_MD')) return reply({ ok: false, error: 'invalid_arguments' })
    if (method === 'chat.postMessage') return reply({ ok: true, ts: `1700000000.${String(calls.length).padStart(6, '0')}` })
    if (method === 'conversations.info') return args.channel === 'C1' ? reply({ ok: true, channel: { id: 'C1', name: 'bridge' } }) : reply({ ok: false, error: 'channel_not_found' })
    if (method === 'chat.getPermalink') return reply({ ok: true, permalink: `https://team.slack.test/archives/${args.channel}/p${String(args.message_ts).replace('.', '')}` })
    if (method === 'users.conversations')
      return req.headers.authorization === 'Bearer xoxb-old'
        ? reply({ ok: false, error: 'missing_scope' })
        : req.headers.authorization === 'Bearer xoxb-one'
          ? reply({ ok: true, channels: [{ id: 'C9', name: 'only', is_private: true }], response_metadata: { next_cursor: '' } })
          : reply({ ok: true, channels: [{ id: 'C2', name: 'zeta', is_private: false }, { id: 'C1', name: 'bridge', is_private: true }], response_metadata: { next_cursor: '' } })
    reply({ ok: true })
  })
  server.on('upgrade', (req, sock) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket = sock
    let buf = Buffer.alloc(0)
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      // Client frames: masked, and short enough here for the 7-bit or 16-bit length.
      while (buf.length >= 6) {
        let len = buf[1] & 0x7f
        let at = 2
        if (len === 126) (len = buf.readUInt16BE(2)), (at = 4)
        if (buf.length < at + 4 + len) return
        const mask = buf.subarray(at, at + 4)
        const body = Buffer.from(buf.subarray(at + 4, at + 4 + len).map((b, i) => b ^ mask[i % 4]))
        if ((buf[0] & 0x0f) === 1) acks.push(JSON.parse(body.toString()))
        buf = buf.subarray(at + 4 + len)
      }
    })
    sock.on('error', () => {})
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const push = (env) => {
    const body = Buffer.from(JSON.stringify(env))
    const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff])
    socket.write(Buffer.concat([head, body]))
  }
  return { calls, acks, push, connected: () => !!socket, url: `http://127.0.0.1:${server.address().port}`, close: () => (socket?.destroy(), server.close()) }
}

/** The server's side, as the plugin sees it. `seats` is where each session is worked on (web unless said). */
function fakeBridge() {
  const saved = {}
  const did = []
  const seats = {}
  let p = null
  const io = {
    load: (uid) => (saved[uid] ??= {}),
    store: () => {},
    log: () => {},
    changed: () => {},
    host: (uid) => ({
      origin: 'https://bridge.test',
      code: () => 'code-1',
      find: (thread) => ({ name: `세션 ${thread}`, cwd: '/work', bridge: { host: 'MacA' } }),
      seat: (thread) => ({ where: seats[thread] ?? 'web', link: `https://bridge.test/#/s/${thread}` }),
      summary: (thread) => ({ title: `세션 ${thread}`, host: 'MacA', cwd: '~/work', last: '**다 했어요**', link: `https://bridge.test/#/s/${thread}` }),
      seatUrl: (thread, url) => did.push({ uid, seatUrl: thread, url }),
      // As the server does: the seat changes, then the plugin is told (moveIn waits for the thread).
      moveTo: async (thread, to) => {
        did.push({ uid, moveTo: thread, to })
        if (to === 'slack') await p.instance(uid, 'slack').moveIn(thread)
        seats[thread] = to
        if (to === 'web') p.instance(uid, 'slack').moveOut(thread)
      },
      command: async (value) => did.push({ uid, command: value }),
      send: async (thread, text, images) => did.push({ uid, send: thread, text, images }),
      start: async ({ prompt, cwd, places }) => ((seats['T-new'] = 'slack'), did.push({ uid, start: prompt, cwd, places }), { thread: 'T-new' }),
    }),
  }
  return { io, did, saved, seats, use: (x) => (p = x) }
}

test('markdown becomes mrkdwn, code is left alone, long text is cut at a line', () => {
  assert.equal(toMrkdwn('## 제목\n**굵게** [링크](https://a.b/c) `a**b**`\n- 하나'), '\u200b*제목*\u200b\n\u200b*굵게*\u200b <https://a.b/c|링크> `a**b**`\n• 하나')
  assert.equal(toMrkdwn('**커밋(`d99`)이 올라감.** 그 뒤 **5번**했고'), '\u200b*커밋(`d99`)이 올라감.*\u200b 그 뒤 \u200b*5번*\u200b했고', '코드가 든 굵게, 한글에 붙은 굵게')
  assert.equal(toMrkdwn('```js\nif (a < b) **x**\n```'), '```\nif (a < b) **x**\n```')
  const parts = pieces(`${'가'.repeat(3000)}\n${'나'.repeat(3000)}`)
  assert.equal(parts.length, 2)
  assert.equal(parts[0], '가'.repeat(3000))
})

test('a session is a thread: text and cards go out, replies and buttons come in, per person', async () => {
  const s = await fakeSlack()
  process.env.SLACK_API_URL = s.url
  const { io, did, saved, seats, use } = fakeBridge()
  const PLACES = JSON.stringify({ main: 'h2', dirs: { h1: '~/a', h2: `~/${'x'.repeat(600)}` } })
  const p = use(plugins(io))
  try {
    await assert.rejects(p.set('u1', 'slack', { enabled: true, config: { botToken: 'xoxb-1' } }), /App 토큰/)
    await p.set('u1', 'slack', { enabled: true, config: { botToken: 'xoxb-1', appToken: 'xapp-1', channel: 'C1', cwd: '~/w', places: PLACES } })
    await until(() => s.connected() && p.list('u1')[0].status.state === 'on')
    assert.equal(p.list('u1')[0].config.botToken, '••••••••', '비밀 값은 돌려주지 않음')
    assert.equal(s.calls.find((c) => c.method === 'apps.connections.open').token, 'Bearer xapp-1')
    assert.match(p.list('u1')[0].status.note, /^연결됨 · 채널 #bridge/, '채널은 ID 가 아니라 이름으로')

    // Someone the plugin has not met: a link, and nothing is done for them.
    s.push({ envelope_id: 'e1', type: 'events_api', payload: { event: { type: 'message', channel: 'C1', user: 'U1', ts: '100.1', text: 'hello' } } })
    await until(() => s.calls.some((c) => c.method === 'chat.postEphemeral'))
    assert.deepEqual(s.acks[0], { envelope_id: 'e1' })
    assert.match(s.calls.find((c) => c.method === 'chat.postEphemeral').args.text, /https:\/\/bridge\.test\/api\/plugins\/slack\/link\?code=code-1/)
    assert.equal(did.length, 0)
    // R1-M2 (리포트 #1): looking at the link says who would be linked and links nobody; only link() does.
    assert.deepEqual(await p.instance('u1', 'slack').who('code-1'), { user: 'U1', name: '<b>앨리스</b>' })
    assert.deepEqual(await p.instance('u1', 'slack').who('code-1'), { user: 'U1', name: '<b>앨리스</b>' }, '보기만 해서는 쓰지 않음')
    assert.equal(await p.instance('u1', 'slack').who('nope'), null)
    assert.match(p.instance('u1', 'slack').link('code-1'), /연결했어요/)
    assert.match(p.instance('u1', 'slack').link('code-1'), /만료/)

    // A message at the top of the channel starts a session worked on in Slack; that message is its thread, and
    // the first reply carries the button that moves it to the bridge (and opens its page).
    s.push({ envelope_id: 'e2', type: 'events_api', payload: { event: { type: 'message', channel: 'C1', user: 'U1', ts: '100.2', text: 'fix &lt;it&gt;' } } })
    await until(() => did.some((d) => d.start))
    // The places set with buttons (기기마다 폴더, 기본 기기) go along whole, past the 400 characters a typed value keeps.
    assert.deepEqual(did.find((d) => d.start), { uid: 'u1', start: 'fix <it>', cwd: '~/w', places: PLACES })
    await until(() => saved.u1.slack.state.threads['T-new'] === '100.2' && did.some((d) => d.seatUrl))
    const started = s.calls.filter((c) => c.method === 'chat.postMessage').at(-1).args
    assert.equal(started.thread_ts, '100.2')
    assert.deepEqual([started.blocks[1].elements[0].action_id, started.blocks[1].elements[0].url], ['seat_web', 'https://bridge.test/#/s/T-new'])
    assert.equal(did.find((d) => d.seatUrl).url, 'https://team.slack.test/archives/C1/p1002', '세션 화면이 스레드로 가는 주소를 받음')
    const postsBefore = s.calls.filter((c) => c.method === 'chat.postMessage').length

    // What the session says goes to that thread; what was typed in Slack is not said back to it.
    const inst = p.instance('u1', 'slack')
    inst.onEvent('T-new', { type: 'user', via: 'slack', text: 'fix <it>' })
    inst.onEvent('T-new', { type: 'text', text: '**done**' })
    inst.onEvent('T-new', { type: 'msg', ts: 'card-1', text: '권한 요청', blocks: [{ type: 'actions', elements: [{ type: 'button', action_id: 'perm_allow', value: '1001:card card-1 1' }] }] })
    await until(() => s.calls.filter((c) => c.method === 'chat.postMessage').length === postsBefore + 2)
    const posts = s.calls.filter((c) => c.method === 'chat.postMessage').slice(postsBefore).map((c) => c.args)
    assert.deepEqual([posts[0].thread_ts, posts[0].markdown_text, posts[0].text], ['100.2', '**done**', undefined], '세션의 글은 Markdown 그대로')
    assert.equal(posts[1].blocks[0].elements[0].value, '1001:card card-1 1')

    // The button answers the card, and the card is then rewritten in place.
    s.push({ envelope_id: 'e3', type: 'interactive', payload: { type: 'block_actions', channel: { id: 'C1' }, user: { id: 'U1' }, message: { thread_ts: '100.2' }, actions: [{ action_id: 'perm_allow', value: '1001:card card-1 1' }] } })
    await until(() => did.some((d) => d.command))
    assert.equal(did.at(-1).command, '1001:card card-1 1')
    inst.onEvent('T-new', { type: 'msg_update', ts: 'card-1', text: '✅ 허용', blocks: [] })
    await until(() => s.calls.some((c) => c.method === 'chat.update'))
    assert.equal(s.calls.find((c) => c.method === 'chat.update').args.ts, saved.u1.slack.state.msgs['card-1'])

    // A reply in the thread is sent to the session; the bot's own messages and other channels are not.
    s.push({ envelope_id: 'e4', type: 'events_api', payload: { event: { type: 'message', channel: 'C1', user: 'U1', ts: '100.3', thread_ts: '100.2', text: 'and tests' } } })
    s.push({ envelope_id: 'e5', type: 'events_api', payload: { event: { type: 'message', channel: 'C1', user: 'UBOT', bot_id: 'B1', ts: '100.4', thread_ts: '100.2', text: 'mine' } } })
    s.push({ envelope_id: 'e6', type: 'events_api', payload: { event: { type: 'message', channel: 'C2', user: 'U1', ts: '100.5', text: 'elsewhere' } } })
    await until(() => did.some((d) => d.send))
    await new Promise((r) => setTimeout(r, 100))
    assert.deepEqual(did.filter((d) => d.send || d.start).length, 2)
    assert.deepEqual(did.find((d) => d.send), { uid: 'u1', send: 'T-new', text: 'and tests', images: [] })

    // Slack refusing markdown_text: the same piece goes as mrkdwn instead, bold kept at a Korean word's edge.
    inst.onEvent('T-new', { type: 'text', text: 'NO_MD **통과**했고 **`a`**' })
    await until(() => s.calls.filter((c) => c.method === 'chat.postMessage').at(-1).args.text?.startsWith('NO_MD'))
    assert.equal(s.calls.filter((c) => c.method === 'chat.postMessage').at(-1).args.text, 'NO_MD \u200b*통과*\u200b했고 \u200b*`a`*\u200b')

    // A session worked on in the bridge is not posted at all.
    const quiet = s.calls.length
    inst.onEvent('T-web', { type: 'text', text: 'hi' })
    inst.onEvent('T-web', { type: 'end', why: '종료' })
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(s.calls.length, quiet, '브릿지에서 작업 중인 세션은 Slack 에 올리지 않음')

    // Moved to Slack: a thread is made whose head says where the earlier talk is, with the button back.
    const r = await inst.moveIn('T-web')
    seats['T-web'] = 'slack'
    const root = s.calls.filter((c) => c.method === 'chat.postMessage').at(-1).args
    assert.equal(root.thread_ts, undefined)
    assert.match(root.text, /세션 T-web/)
    assert.match(root.text, /<https:\/\/bridge\.test\/#\/s\/T-web\|브릿지에서 보기>/)
    assert.match(root.text, /\*다 했어요\*/, '마지막 답을 함께 보여 줌')
    assert.equal(root.blocks[1].elements[0].action_id, 'seat_web')
    assert.equal(r.url, `https://team.slack.test/archives/C1/p${saved.u1.slack.state.threads['T-web'].replace('.', '')}`)
    inst.onEvent('T-web', { type: 'text', text: 'now here' })
    await until(() => s.calls.filter((c) => c.method === 'chat.postMessage').at(-1).args.text === 'now here') // 거절된 뒤 10분은 mrkdwn 으로

    // The button moves it back: the head loses its button, the thread says where it went and offers the way back.
    s.push({ envelope_id: 'e7', type: 'interactive', payload: { type: 'block_actions', channel: { id: 'C1' }, user: { id: 'U1' }, message: { ts: saved.u1.slack.state.threads['T-web'] }, actions: [{ action_id: 'seat_web', value: 'T-web' }] } })
    await until(() => s.calls.filter((c) => c.method === 'chat.postMessage').at(-1).args.blocks?.[1]?.elements?.[0]?.action_id === 'seat_slack')
    assert.deepEqual(did.filter((d) => d.moveTo).at(-1), { uid: 'u1', moveTo: 'T-web', to: 'web' })
    const update = s.calls.filter((c) => c.method === 'chat.update').at(-1).args
    assert.equal(update.ts, saved.u1.slack.state.threads['T-web'])
    assert.equal(update.blocks.length, 1, '앞 메시지의 버튼은 지움')
    assert.match(s.calls.filter((c) => c.method === 'chat.postMessage').at(-1).args.text, /브릿지로 옮겼어요.*<https:\/\/bridge\.test\/#\/s\/T-web\|브릿지에서 열기>/)

    // A reply there now reaches nobody: the writer is told where the session is, with a way to bring it back.
    const sent = did.filter((d) => d.send).length
    s.push({ envelope_id: 'e8', type: 'events_api', payload: { event: { type: 'message', channel: 'C1', user: 'U1', ts: '100.9', thread_ts: saved.u1.slack.state.threads['T-web'], text: 'still there?' } } })
    await until(() => s.calls.filter((c) => c.method === 'chat.postEphemeral').at(-1).args.text?.includes('브릿지에서 작업 중'))
    assert.equal(did.filter((d) => d.send).length, sent)
    assert.equal(s.calls.filter((c) => c.method === 'chat.postEphemeral').at(-1).args.blocks[1].elements[0].action_id, 'seat_slack')

    // R1-L15 (리포트 #1): an attachment somewhere other than Slack's file host gets no bot token.
    const sends = did.filter((d) => d.send).length
    s.push({ envelope_id: 'e9', type: 'events_api', payload: { event: { type: 'message', subtype: 'file_share', channel: 'C1', user: 'U1', ts: '100.10', thread_ts: saved.u1.slack.state.threads['T-new'], text: 'pic', files: [{ name: 'a.png', mimetype: 'image/png', url_private: `${s.url}/evil-file` }] } } })
    await until(() => did.filter((d) => d.send).length > sends)
    assert.equal(s.calls.filter((c) => c.method === 'evil-file').length, 0, 'Slack 파일 호스트가 아니면 받지 않음')

    // Another person's plugin is another app: a bad token is theirs alone.
    await p.set('u2', 'slack', { enabled: true, config: { botToken: 'xoxb-bad', appToken: 'xapp-2', channel: 'C9' } })
    await until(() => p.list('u2')[0].status.state === 'error')
    assert.equal(p.list('u1')[0].status.state, 'on')

    // Off keeps the settings; removed forgets them.
    await p.set('u1', 'slack', { enabled: false })
    assert.equal(p.list('u1')[0].enabled, false)
    assert.equal(p.list('u1')[0].config.channel, 'C1')
    const before = s.calls.length
    inst.onEvent('T-new', { type: 'text', text: 'after off' })
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(s.calls.length, before, '끈 뒤에는 Slack 에 아무것도 보내지 않음')
    await p.remove('u1', 'slack')
    assert.equal(p.list('u1')[0].added, false)
    assert.equal(p.list('u1')[0].config.channel, '')
    await p.remove('u2', 'slack')
  } finally {
    delete process.env.SLACK_API_URL
    s.close()
  }
})

test('a run gathers the same tool on files, and the same thing done again, into one line', () => {
  const run = (tools) => listOf(tools.reduce(withTool, []))
  assert.equal(run([{ name: 'Write', what: 'a.ts' }, { name: 'Write', what: 'b<c>.ts' }, { name: 'Edit', what: 'a.ts' }]), '• *Write* a.ts, b&lt;c&gt;.ts\n• *Edit* a.ts')
  assert.equal(run([{ name: 'Bash', what: '설치', desc: true }, { name: 'Bash', what: '설치', desc: true }, { name: 'Bash', what: '빌드', desc: true }]), '• *Bash* ×2 설치\n• *Bash* 빌드', '설명이 있는 줄은 같을 때만 합침')
  assert.equal(run([{ name: 'Write', what: '' }, { name: 'Write', what: '' }]), '• *Write* ×2')
  assert.equal(run([{ name: 'Edit', what: 'a.ts' }, { name: 'Edit', what: 'a.ts' }, { name: 'Edit', what: 'b.ts' }]), '• *Edit* ×2 a.ts\n• *Edit* b.ts')
  const many = run(Array.from({ length: 40 }, (_, k) => ({ name: 'Write', what: `file-${k}.tsx` })))
  assert.ok(many.split('\n').every((l) => l.length <= 200), '합친 줄은 200자에서 멈춤')
  assert.equal(many.match(/file-\d+/g).length, 40, '파일 이름은 빠지지 않음')
})

test('what 전부 허용 allowed folds into one message per run, within what one Slack message holds', async () => {
  const s = await fakeSlack()
  process.env.SLACK_API_URL = s.url
  process.env.SLACK_AUTO_EDIT_MS = '40'
  const { io, seats, use } = fakeBridge()
  const p = use(plugins(io))
  try {
    await p.set('u1', 'slack', { enabled: true, config: { botToken: 'xoxb-1', appToken: 'xapp-1', channel: 'C1' } })
    await until(() => p.list('u1')[0].status.state === 'on')
    seats.T1 = 'slack'
    const inst = p.instance('u1', 'slack')
    const posts = () => s.calls.filter((c) => c.method === 'chat.postMessage').map((c) => ({ ...c.args, text: c.args.text ?? c.args.markdown_text }))
    const updates = () => s.calls.filter((c) => c.method === 'chat.update').map((c) => c.args)
    const auto = (k, name = 'Bash', what = `일 ${k}`, desc = name === 'Bash') => inst.onEvent('T1', { type: 'msg', ts: `a${k}`, text: `⚡ 자동 허용 · ${name}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '```rm -rf /tmp/x```' } }], auto: { name, what, desc } })

    inst.onEvent('T1', { type: 'text', text: '시작' })
    for (let k = 0; k < 4; k++) auto(k, k === 3 ? 'Edit' : 'Bash', k === 3 ? 'a<b>.ts' : undefined)
    await until(() => updates().length === 1)
    // The head, the text, then one message for the four: the first goes out alone, the rest come in one edit.
    assert.equal(posts().length, 3)
    const first = posts()[2]
    assert.equal(first.text, '⚡ 자동 허용 1개')
    const u = updates()[0]
    assert.equal(u.ts, `1700000000.${String(s.calls.findIndex((c) => c.method === 'chat.postMessage' && c.args.text === first.text) + 1).padStart(6, '0')}`, '첫 메시지를 고침')
    assert.equal(u.text, '⚡ 자동 허용 4개')
    assert.equal(u.blocks[0].text.text, '⚡ 자동 허용 4개 · Bash 3 · Edit')
    assert.equal(u.blocks[1].text.text, '• *Bash* 일 0\n• *Bash* 일 1\n• *Bash* 일 2\n• *Edit* a&lt;b&gt;.ts')
    assert.ok(!JSON.stringify([first, u]).includes('rm -rf'), '명령 원문은 올리지 않음')

    // Anything else in the thread ends the run: the next one is a new message.
    inst.onEvent('T1', { type: 'text', text: '중간 답' })
    auto(10)
    await until(() => posts().length === 5)
    assert.deepEqual(posts().slice(3).map((x) => x.text), ['중간 답', '⚡ 자동 허용 1개'])
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(updates().length, 1, '하나뿐인 묶음은 고치지 않음')

    // 30 lines to a message: the 31st starts the next one, and the full one gets its last edit first.
    inst.onEvent('T1', { type: 'text', text: '많이' })
    for (let k = 0; k < 31; k++) auto(100 + k)
    await until(() => posts().length === 8)
    await until(() => updates().some((x) => x.text === '⚡ 자동 허용 30개'))
    assert.equal(posts().at(-1).text, '⚡ 자동 허용 1개')
    assert.equal(updates().find((x) => x.text === '⚡ 자동 허용 30개').blocks[1].text.text.split('\n').length, 30)

    // Long lines: a message never passes a section's 3,000 characters, and no line is lost.
    inst.onEvent('T1', { type: 'text', text: '길게' })
    for (let k = 0; k < 40; k++) auto(200 + k, 'Bash', `${k} ${'가'.repeat(98)}`)
    inst.onEvent('T1', { type: 'text', text: '끝' })
    await until(() => posts().at(-1)?.text === '끝')
    await new Promise((r) => setTimeout(r, 120))
    const long = [...s.calls].filter((c) => /^⚡/.test(c.args.text ?? '') && (c.args.blocks?.[1]?.text.text ?? '').includes('가'.repeat(98)))
    assert.ok(long.every((c) => c.args.blocks.every((b) => b.text.text.length <= 3000)), '섹션은 3,000자 이하')
    const seen = new Set(long.flatMap((c) => c.args.blocks[1].text.text.split('\n').map((l) => l.split(' ')[2])))
    assert.equal(seen.size, 40, '빠진 줄이 없음')
    assert.ok(posts().filter((x) => /^⚡/.test(x.text)).length >= 4, '길이가 차면 새 메시지')
  } finally {
    await p.stopAll()
    delete process.env.SLACK_API_URL
    delete process.env.SLACK_AUTO_EDIT_MS
    s.close()
  }
})

test('the channel is picked from the ones the bot is in', async () => {
  const s = await fakeSlack()
  process.env.SLACK_API_URL = s.url
  const { io } = fakeBridge()
  const p = plugins(io)
  try {
    await assert.rejects(p.choices('u1', 'slack', 'channel', {}), /Bot 토큰을 먼저/)
    await assert.rejects(p.choices('u1', 'slack', 'cwd', { botToken: 'xoxb-1' }), /고를 수 있는 값이 없어요/)
    assert.deepEqual(await p.choices('u1', 'slack', 'channel', { botToken: 'xoxb-1' }), [
      { value: 'C1', label: '#bridge', hint: '비공개 · C1' },
      { value: 'C2', label: '#zeta', hint: '공개 · C2' },
    ])
    const asked = s.calls.find((c) => c.method === 'users.conversations')
    assert.equal(asked.args.types, 'public_channel,private_channel', '읽기 메서드는 form 으로 보냄')
    await assert.rejects(p.choices('u1', 'slack', 'channel', { botToken: 'xoxb-old' }), /channels:read, groups:read/)
  } finally {
    delete process.env.SLACK_API_URL
    s.close()
  }
})

test('swapped tokens go back where they belong, a wrong one is refused, the only channel is taken', async () => {
  const s = await fakeSlack()
  process.env.SLACK_API_URL = s.url
  const { io } = fakeBridge()
  const p = plugins(io)
  try {
    await assert.rejects(p.set('u1', 'slack', { enabled: true, config: { botToken: 'hello', appToken: 'xapp-1', channel: 'C1' } }), /Bot 토큰은 xoxb- 로 시작해요/)
    const r = await p.set('u1', 'slack', { enabled: true, config: { botToken: 'xapp-1', appToken: 'xoxb-one' } })
    const mine = io.load('u1').slack
    assert.equal(mine.config.botToken, 'xoxb-one')
    assert.equal(mine.config.appToken, 'xapp-1')
    assert.equal(mine.config.channel, 'C9', '봇이 들어간 채널이 하나면 그 채널')
    assert.deepEqual(r.notes, ['Bot 토큰과 App 토큰 (Socket Mode)이 바뀌어 있어서 제자리에 넣었어요', '전용 채널을 #only(으)로 정했어요'])
    await assert.rejects(p.set('u1', 'slack', { enabled: true, config: { botToken: 'xoxb-1', channel: '' } }), /전용 채널 을\(를\) 채워 주세요/, '여럿이면 고르게 함')
  } finally {
    await p.stopAll()
    delete process.env.SLACK_API_URL
    s.close()
  }
})

test('the plugin says what it needs', () => {
  assert.deepEqual(slack.fields.filter((f) => f.required).map((f) => f.key), ['botToken', 'appToken', 'channel'])
  assert.ok(JSON.parse(slack.help[0].copy.text).settings.socket_mode_enabled, '매니페스트를 복사할 수 있음')
  assert.ok(['channels:read', 'groups:read'].every((x) => JSON.parse(slack.help[0].copy.text).oauth_config.scopes.bot.includes(x)), '채널 목록을 읽을 권한')
  assert.equal(slack.fields.find((f) => f.key === 'channel').pick, '채널 고르기')
  assert.ok(slack.help.every((h) => h.title && h.text.length > 40), '단계마다 무엇을 누르는지 적혀 있음')
  assert.match(slack.prompt.text, /\{origin\}\/guide/)
  assert.match(slack.prompt.text, /socket_mode_enabled/)
  assert.match(slack.prompt.text, /토큰은 다루지 마/, 'AI 는 토큰을 읽거나 넣지 않음')
  assert.doesNotMatch(slack.prompt.text, /토큰을 넣고|Bot 토큰, App 토큰을 넣/)
  const link = new URL(slack.help[0].link.url)
  assert.deepEqual(JSON.parse(link.searchParams.get('manifest_json')), JSON.parse(slack.help[0].copy.text), '링크에 매니페스트가 채워져 있음')
  assert.equal(link.searchParams.get('new_app'), '1')
  assert.deepEqual(slack.fields.filter((f) => f.prefix).map((f) => f.prefix), ['xoxb-', 'xapp-'])
})
