// The local preview: a web server a session started on its Mac (http://localhost:<port>), shown on another device.
// Requests come to a second origin of this server (lp.<site>, BRIDGE_PREVIEW_ORIGIN) and go to the Mac as the
// agent's `http` command, through the Mac's bridge tab like every other command. WebSockets (a dev server's HMR)
// the same way, as its `ws` command and messages.
//
// A second origin, not a path of the site: the previewed app's scripts (and whatever they load) run there, and
// from there they cannot read the site's sign-in cookie or call its API as the person.
//
// Addresses are /t/<token>/<path>. The token says whose which host and port, for which session, until when, signed
// by this server; it stops working when that session ends (R1-M6).
// An app that asks for an absolute path (/assets/app.js, a link to /about) leaves the token out: such a request is
// sent back to the same path under the token of the page that asked (its Referer, else the last one opened).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** How long an opened preview's address keeps working. Opening it again from the session page gives a new one. */
export const PREVIEW_TTL_MS = 24 * 3_600_000
/** The largest request body passed on to the Mac. */
const BODY_MAX = 16 * 1024 * 1024
/** Request headers that describe this hop, not the request: not passed on. */
const HOP = /^(host|connection|keep-alive|transfer-encoding|upgrade|te|trailer|proxy-.*|accept-encoding|content-length|x-forwarded-.*|x-real-ip|forwarded|cf-.*|x-bridge-handover)$/i

const b64u = (buf) => Buffer.from(buf).toString('base64url')

/** How many preview origins a site may have besides the main one (R1-M6). */
export const POOL_SIZE = 8
/** How often the pool's addresses are checked for reaching this server. */
const PROBE_MS = 10 * 60_000

/**
 * The pool's candidate origins for a site: one label down from the site's own parent, so a certificate per name is
 * all they need (`https://bridge.example.com` -> `https://lp1-bridge.example.com` …). `BRIDGE_PREVIEW_POOL` (a comma
 * separated list of origins) names them instead. None for a site without https (local development).
 */
export function poolCandidates(origin, env = process.env) {
  if (env.BRIDGE_PREVIEW_POOL) return env.BRIDGE_PREVIEW_POOL.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)
  if (!origin?.startsWith('https://')) return []
  const host = new URL(origin).hostname
  const [first, ...rest] = host.split('.')
  if (!rest.length) return []
  return Array.from({ length: POOL_SIZE }, (_, i) => `https://lp${i + 1}-${first}.${rest.join('.')}`)
}

export function createPreview({ dataDir, origin, port, ask, toHost, canUse, log = () => {}, probe = null, now = Date.now }) {
  const ORIGIN = (process.env.BRIDGE_PREVIEW_ORIGIN || (origin ? origin.replace('://', '://lp.') : `http://lp.localhost:${port}`)).replace(/\/+$/, '')
  const HOST = new URL(ORIGIN).host.toLowerCase()
  // Every preview shared ORIGIN, so a previewed app could read another preview's storage and cookies (R1-M6). Each
  // session's previews now go to one origin of a pool (by the session's id), when the pool's addresses reach this
  // server; until then (or without them) to ORIGIN as before.
  const CANDIDATES = poolCandidates(origin)
  /** host -> origin, for every address this server may be asked as a preview origin. */
  const ORIGINS = new Map([[HOST, ORIGIN], ...CANDIDATES.map((o) => [new URL(o).host.toLowerCase(), o])])
  /** The pool's addresses that reach this server (checked by probe). */
  let pool = []

  // The signing key, made once and kept with the data: addresses survive a deploy.
  const keyFile = path.join(dataDir, 'preview.key')
  let key
  try {
    key = fs.readFileSync(keyFile)
  } catch {
    key = crypto.randomBytes(32)
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(keyFile, key, { mode: 0o600 })
  }
  const sign = (body) => b64u(crypto.createHmac('sha256', key).update(body).digest().subarray(0, 16))
  /**
   * What robots.txt of a preview origin answers for a probe's one-time number n: only a server holding this data's
   * key (the same on every server over it) can, so a host that only replays an answer it saw is not taken (R5-L3).
   */
  // Bound to the host asked as well (R7-L2): a host that passed the probe on to the real server would get the answer for
  // the real server's name, not its own.
  const probeAnswer = (host, n) => sign(`preview-origin:${String(host).toLowerCase()}:${n}`)

  /**
   * sid -> { o: origin, at: last used }. A session keeps its origin; a new one gets an origin no session holds, and
   * only when all are held the one used longest ago (R5 의 R1-M6). Kept in the data folder so a restart or a hand-over
   * does not deal the origins out again while old addresses still work (R7-M2), and a token works only while its
   * session still holds the origin it names: a session whose origin went to another one opens its preview again.
   */
  const givenFile = path.join(dataDir, 'preview-given.json')
  // An evicted hold stays as a tombstone ({o, at, gone}): without it the merge below brought it back from the file and
  // the evicted session's old address worked again (R9-M1). Whichever happened later (use or eviction) wins a merge.
  const given = new Map()
  const stamp = (g) => Math.max(Number(g?.at) || 0, Number(g?.gone) || 0)
  const clean = (g) => (g && typeof g.o === 'string' ? { o: g.o, at: Number(g.at) || 0, since: Number(g.since) || 0, ...(g.gone ? { gone: Number(g.gone) } : {}) } : null)
  /**
   * Which of two records of one session wins a merge. A tombstone is undone only by giving the session an origin
   * again after it (`since`), never by a use of its old address that a second server running at the same time let
   * through (R10-L2); otherwise the later use or eviction wins.
   */
  const newer = (a, b) => {
    if (a.gone && !b.gone) return b.since > a.gone ? b : a
    if (b.gone && !a.gone) return a.since > b.gone ? a : b
    return stamp(b) > stamp(a) ? b : a
  }
  const holds = (g) => !!g && !g.gone
  try {
    for (const [sid, g] of Object.entries(JSON.parse(fs.readFileSync(givenFile, 'utf8')))) if (clean(g)) given.set(sid, clean(g))
  } catch {}
  let saving = null
  const saveGiven = () => {
    saving ??= setTimeout(() => {
      saving = null
      try {
        // During a deploy the old and the new server both write here: what the file holds is merged in first (the
        // later use or eviction of each session wins), and each writes through a file of its own (R8-L1, R9-L1: in a
        // container both servers are pid 1, so the name carries a random part too).
        try {
          for (const [sid, raw] of Object.entries(JSON.parse(fs.readFileSync(givenFile, 'utf8')))) {
            const g = clean(raw)
            if (g) given.set(sid, given.has(sid) ? newer(given.get(sid), g) : g)
          }
        } catch {}
        // Tombstones older than any address that could still name them are dropped.
        for (const [sid, g] of given) if (g.gone && now() - g.gone > PREVIEW_TTL_MS) given.delete(sid)
        const tmp = `${givenFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(given)), { mode: 0o600 })
        fs.renameSync(tmp, givenFile)
      } catch {}
    }, 1000)
    saving.unref?.()
  }
  function originFor(sid) {
    if (!pool.length) return ORIGIN
    let g = given.get(sid)
    if (!holds(g) || !pool.includes(g.o)) {
      const held = new Set([...given.values()].filter(holds).map((x) => x.o))
      let o = pool.find((x) => !held.has(x))
      if (!o) {
        const [oldest] = [...given.entries()].filter(([, x]) => holds(x) && pool.includes(x.o)).sort((a, b) => a[1].at - b[1].at)
        if (oldest) given.set(oldest[0], { ...oldest[1], gone: now() })
        o = oldest?.[1].o ?? pool[0]
      }
      g = { o, at: 0, since: now() }
    }
    given.set(sid, { o: g.o, at: now(), since: g.since || now() })
    saveGiven()
    return g.o
  }
  function mint({ uid, hostId, port: p, sid }) {
    const o = originFor(sid)
    const body = b64u(JSON.stringify({ u: uid, h: hostId, s: sid, p, e: Date.now() + PREVIEW_TTL_MS, ...(o !== ORIGIN ? { o } : {}) }))
    return `${body}.${sign(body)}`
  }
  /** The address of a new preview: on its session's origin. */
  function url(args) {
    const token = mint(args)
    const o = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')).o ?? ORIGIN
    return `${o}/t/${token}/`
  }
  /** Checks which of the pool's addresses reach this server: robots.txt there must answer a one-time number. */
  async function probePool() {
    const check =
      probe ??
      (async (o) => {
        const n = crypto.randomBytes(12).toString('hex')
        const r = await fetch(`${o}/robots.txt?n=${n}`, { signal: AbortSignal.timeout(5000) }).catch(() => null)
        return r?.headers.get('x-bridge-preview') === probeAnswer(new URL(o).host, n)
      })
    const ok = []
    for (const o of CANDIDATES) if (await check(o, probeAnswer).catch(() => false)) ok.push(o)
    if (ok.join() !== pool.join()) log(`preview: 미리보기 출처 ${ok.length}개 사용 (${ok.map((o) => new URL(o).host).join(', ') || '없음, 기본 하나만'})`)
    pool = ok
    return ok
  }
  if (CANDIDATES.length) {
    setTimeout(() => probePool().catch(() => {}), 5000).unref?.()
    setInterval(() => probePool().catch(() => {}), PROBE_MS).unref?.()
  }
  function open(token, host = HOST) {
    const [body, mac] = String(token).split('.')
    if (!body || !mac || mac.length !== 22 || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(sign(body)))) return null
    try {
      const t = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
      // A token from before tokens named their session (R1-M6) is not one any more. A token works only on the origin
      // it was made for: another session's preview origin does not take it.
      if (!(t.e > Date.now() && t.s && new URL(t.o ?? ORIGIN).host.toLowerCase() === String(host).toLowerCase())) return null
      // A pool origin's token, only while its session still holds that origin; using it keeps the session's hold.
      if (t.o) {
        const g = given.get(t.s)
        if (!holds(g) || g.o !== t.o) return null
        if (now() - g.at > 60_000) ((g.at = now()), saveGiven())
      }
      return t
    } catch {
      return null
    }
  }

  const page = (res, status, title, text) =>
    res
      .writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" })
      .end(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title}</title><style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;color:#888}h1{font-size:18px;color:CanvasText}</style><h1>${title}</h1><p>${text}</p></html>`)

  const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]))
  const secure = ORIGIN.startsWith('https:')
  const hostOf = (req) => String(req.headers.host ?? '').toLowerCase()
  /** The preview origin a request came to. */
  const originOf = (req) => ORIGINS.get(hostOf(req)) ?? ORIGIN

  /** Whether a request is for the preview origin. */
  const is = (req) => ORIGINS.has(hostOf(req))

  async function handle(req, res) {
    const here = originOf(req)
    const host = new URL(here).host.toLowerCase()
    const url = new URL(req.url, here)
    const m = /^\/t\/([\w-]+\.[\w-]+)(\/.*)?$/.exec(url.pathname)
    if (!m) {
      // An absolute path the app asked for: back under the token of the page that asked.
      let token = null
      try {
        const ref = new URL(req.headers.referer)
        if (ref.host.toLowerCase() === host) token = /^\/t\/([\w-]+\.[\w-]+)\//.exec(ref.pathname)?.[1] ?? null
      } catch {}
      token ||= cookies(req).lp_t || null
      if (url.pathname === '/robots.txt') {
        const n = url.searchParams.get('n')
        return res.writeHead(200, { 'Content-Type': 'text/plain', ...(n && /^[0-9a-f]{24}$/.test(n) ? { 'x-bridge-preview': probeAnswer(host, n) } : {}) }).end('User-agent: *\nDisallow: /\n')
      }
      if (!token || !open(token, host)) return page(res, 404, '미리보기 주소가 아니에요', '세션 화면의 컴퓨터 버튼으로 다시 열어 주세요.')
      return res.writeHead(307, { Location: `/t/${token}${url.pathname}${url.search}`, 'Cache-Control': 'no-store' }).end()
    }
    const token = m[1]
    const t = open(token, host)
    if (!t) return page(res, 403, '미리보기 주소가 만료됐어요', '세션 화면의 컴퓨터 버튼으로 다시 열어 주세요.')
    if (!m[2]) return res.writeHead(308, { Location: `/t/${token}/${url.search}` }).end()
    const why = canUse(t.u, t.h, t.s)
    if (why) return page(res, 503, '맥에 닿지 않아요', why)

    const chunks = []
    let size = 0
    for await (const c of req) {
      size += c.length
      if (size > BODY_MAX) return page(res, 413, '요청이 너무 커요', `${BODY_MAX / 1048576}MB 까지 보낼 수 있어요.`)
      chunks.push(c)
    }
    const local = `http://localhost:${t.p}`
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP.test(k) || typeof v !== 'string') continue
      // The app sees itself asked as it would be on the Mac: its own origin, its own paths.
      if (k === 'origin') headers[k] = local
      else if (k === 'referer') headers[k] = v.replace(/^https?:\/\/[^/]+\/t\/[\w-]+\.[\w-]+/, local)
      else if (k === 'cookie') headers[k] = v.split(/;\s*/).filter((c) => !c.startsWith('lp_t=')).join('; ')
      else headers[k] = v
    }
    if (!headers.cookie) delete headers.cookie
    const r = await ask(t.h, { t: 'http', port: t.p, method: req.method, path: `${m[2]}${url.search}`, headers, body: size ? Buffer.concat(chunks).toString('base64') : '' }, 70_000)
    if (!r.ok) return page(res, r.status || 502, '로컬 서버가 답하지 않아요', String(r.error ?? '').replace(/[<>&]/g, ''))

    const out = {}
    const isHtml = (r.headers ?? []).some(([k, v]) => k.toLowerCase() === 'content-type' && /html/i.test(v))
    for (const [k0, v] of r.headers ?? []) {
      const k = k0.toLowerCase()
      // Shown inside the site's own page: a header that forbids being framed would leave it blank.
      if (k === 'x-frame-options') continue
      if (k === 'content-security-policy') {
        const csp = String(v).split(';').filter((d) => !/^\s*frame-ancestors\b/i.test(d)).join(';')
        if (csp.trim()) out[k] = csp
        continue
      }
      if (k === 'location') {
        // The app's own address, or a path of it: kept under the token.
        const loc = String(v).replace(/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/i, '')
        out[k] = loc.startsWith('/') && !loc.startsWith('//') ? `/t/${token}${loc}` : v
        continue
      }
      out[k] = v
    }
    const set = (r.cookies ?? []).map((c) => String(c).replace(/;\s*domain=[^;]*/gi, ''))
    if (isHtml) set.push(`lp_t=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${PREVIEW_TTL_MS / 1000}${secure ? '; Secure' : ''}`)
    if (set.length) out['set-cookie'] = set
    out['x-robots-tag'] = 'noindex'
    // The address carries the token: a page that loads something from another site does not send it there (R1-M6).
    out['referrer-policy'] = 'same-origin'
    const bytes = Buffer.from(String(r.body ?? ''), 'base64')
    res.writeHead(r.status || 200, out)
    res.end(req.method === 'HEAD' ? undefined : bytes)
  }

  // ---------- WebSockets (a dev server's live reload, HMR) ----------
  //
  // The browser's WebSocket ends here; each message goes to the Mac as the agent's `ws` command and comes back
  // as its `ws` messages, through the bridge tab like everything else. The handshake is answered only once the
  // agent has opened its own WebSocket to localhost, with the subprotocol that one agreed on.

  /** id -> { socket, hostId, seq, opened, closed, resolve } */
  const sockets = new Map()

  const frame = (opcode, payload) => {
    const n = payload.length
    const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b })()])
    return Buffer.concat([head, payload])
  }
  const closeFrame = (code = 1000, reason = '') => {
    const r = Buffer.from(String(reason).slice(0, 100))
    const b = Buffer.alloc(2 + r.length)
    b.writeUInt16BE(code)
    r.copy(b, 2)
    return frame(0x8, b)
  }

  function finish(id, code, reason, tellMac) {
    const c = sockets.get(id)
    if (!c || c.closed) return
    c.closed = true
    sockets.delete(id)
    if (tellMac) toHost(c.hostId, { t: 'ws', op: 'close', id, seq: ++c.seq, code, reason })
    if (!c.socket.destroyed) c.socket.end(c.opened ? closeFrame(code, reason) : undefined)
    setTimeout(() => c.socket.destroy(), 1000).unref()
  }

  /** The `upgrade` event of the server, for the preview origin. */
  async function upgrade(req, socket, head) {
    const refuse = (status, text) => socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    if (String(req.headers.upgrade).toLowerCase() !== 'websocket' || !req.headers['sec-websocket-key']) return refuse(400, 'Bad Request')
    // Only the previewed page itself (on the preview origin) may open one: another site's page would otherwise get
    // the last preview's cookie token with it (R1-M6).
    const here = originOf(req)
    if (req.headers.origin !== here) return refuse(403, 'Forbidden')
    const url = new URL(req.url, here)
    // A dev server's client asks for its own path (Vite: /?token=…, Next: /_next/webpack-hmr): the page's token comes
    // with the cookie the preview set. An address under /t/<token>/ carries its own.
    const m = /^\/t\/([\w-]+\.[\w-]+)(\/.*)?$/.exec(url.pathname)
    const token = m ? m[1] : cookies(req).lp_t
    const t = token && open(token, new URL(here).host)
    if (!t) return refuse(403, 'Forbidden')
    if (canUse(t.u, t.h, t.s)) return refuse(503, 'Service Unavailable')
    const id = crypto.randomUUID()
    const c = { socket, hostId: t.h, seq: 0, opened: false, closed: false, resolve: null }
    sockets.set(id, c)
    socket.on('error', () => {})
    socket.on('close', () => finish(id, 1001, 'browser went away', true))
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim()).filter(Boolean)
    const answer = await new Promise((resolve) => {
      c.resolve = resolve
      setTimeout(() => resolve({ op: 'error', error: 'timeout' }), 15_000).unref()
      if (!toHost(t.h, { t: 'ws', op: 'open', id, seq: 0, port: t.p, path: `${m ? m[2] || '/' : url.pathname}${url.search}`, protocols })) resolve({ op: 'error', error: 'offline' })
    })
    c.resolve = null
    if (answer.op !== 'open' || c.closed) {
      sockets.delete(id)
      if (answer.op === 'open') toHost(t.h, { t: 'ws', op: 'close', id, seq: ++c.seq, code: 1001, reason: '' })
      return socket.destroyed ? undefined : refuse(502, 'Bad Gateway')
    }
    c.opened = true
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, ...(answer.protocol ? [`Sec-WebSocket-Protocol: ${answer.protocol}`] : []), '', ''].join('\r\n'))
    socket.setNoDelay(true)
    // The browser's frames: masked, maybe split in fragments, a message at most BODY_MAX.
    let buf = head?.length ? Buffer.from(head) : Buffer.alloc(0)
    let parts = []
    let partOp = 0
    const read = () => {
      while (buf.length >= 2) {
        const fin = buf[0] & 0x80
        const op = buf[0] & 0x0f
        let len = buf[1] & 0x7f
        let at = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          at = 4
        } else if (len === 127) {
          if (buf.length < 10) return
          len = Number(buf.readBigUInt64BE(2))
          at = 10
        }
        if (len > BODY_MAX) return finish(id, 1009, 'too big', true)
        const masked = buf[1] & 0x80
        if (buf.length < at + (masked ? 4 : 0) + len) return
        const mask = masked ? buf.subarray(at, at + 4) : null
        at += masked ? 4 : 0
        const data = Buffer.from(buf.subarray(at, at + len))
        if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3]
        buf = buf.subarray(at + len)
        if (op === 0x8) return finish(id, data.length >= 2 ? data.readUInt16BE(0) : 1000, data.subarray(2).toString(), true)
        if (op === 0x9) {
          socket.write(frame(0xa, data))
          continue
        }
        if (op === 0xa) continue
        if (op === 0x1 || op === 0x2) (parts = [data]), (partOp = op)
        else if (op === 0x0) {
          // A message is at most BODY_MAX in all, its fragments together (REQ-S-086).
          if (parts.reduce((n, x) => n + x.length, 0) + data.length > BODY_MAX) return finish(id, 1009, 'too big', true)
          parts.push(data)
        }
        if (!fin) continue
        const whole = Buffer.concat(parts)
        parts = []
        const binary = partOp === 0x2
        toHost(c.hostId, { t: 'ws', op: 'send', id, seq: ++c.seq, binary, data: binary ? whole.toString('base64') : whole.toString('utf8') }) || finish(id, 1011, 'mac offline', false)
      }
    }
    socket.on('data', (d) => ((buf = Buffer.concat([buf, d])), read()))
    read()
  }

  /** A `ws` message from a host's agent: the other end of one of these sockets. */
  function fromAgent(hostId, msg) {
    const c = sockets.get(String(msg.id))
    if (!c || c.hostId !== hostId) return
    if (c.resolve) return c.resolve(msg)
    if (msg.op === 'msg') return void c.socket.write(frame(msg.binary ? 0x2 : 0x1, msg.binary ? Buffer.from(String(msg.data), 'base64') : Buffer.from(String(msg.data), 'utf8')))
    if (msg.op === 'close' || msg.op === 'error') finish(String(msg.id), Number(msg.code) >= 1000 && Number(msg.code) < 5000 && ![1005, 1006, 1015].includes(Number(msg.code)) ? Number(msg.code) : 1011, String(msg.reason ?? ''), false)
  }

  /** A host's agent said hello: its sockets that it does not still hold are gone with the agent that had them. */
  function hostGone(hostId, keep = []) {
    for (const [id, c] of sockets) if (c.hostId === hostId && c.opened && !keep.includes(id)) finish(id, 1012, 'mac restarted', false)
  }

  return { ORIGIN, HOST, ORIGINS: [...ORIGINS.values()], is, mint, url, open, probePool, pool: () => pool, handle, upgrade, fromAgent, hostGone }
}
