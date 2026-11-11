// 로컬 전체 화면 (local --full, SPEC REQ-F-900~902, REQ-S-103~105, docs/LOCAL-UI-DESIGN.md §8): the web screen of
// the site, served on this Mac by the site's own server program built for macOS and signed by the maintainer. The
// agent checks the signature and the hash before it runs it, never takes one signed before the one it has, starts it
// at 127.0.0.1 with a secret made for that run, and links to it instead of the site: one link at a time, no server of
// the site in between. Its data (sessions list, groups, favourites) is its own folder and is never matched with the
// site's account. A person gets in only through a one-time link made at this Mac's terminal.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { UPDATE_KEYS } from './keys.mjs'

/** In front of what is signed: no localui bundle's or agent update's signature reads as one of these. */
export const LF_PREFIX = 'claude-bridge localfull v1\n'
export const LF_API = 1
export const LF_ARCHES = ['darwin-arm64', 'darwin-amd64']
/** A build bigger than this is not taken (the server is about 20 MB with its screen). */
export const LF_MAX = 200 * 1024 * 1024
const TICKET_MS = 5 * 60_000
const MAX_TICKETS = 5

const sha256 = (b) => crypto.createHash('sha256').update(b).digest()

/** This machine's build name, or null where there is none (Linux, Windows). */
export function archOf(platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin') return null
  if (arch === 'arm64') return 'darwin-arm64'
  if (arch === 'x64') return 'darwin-amd64'
  return null
}

/** The signed document of a build: the same fields as the local screen's (scripts/sign-agent.mjs docOf). */
export function lfDocOf(bytes, seq, arch) {
  const h = sha256(bytes)
  return JSON.stringify({ name: `localfull-${arch}`, version: h.toString('hex').slice(0, 12), seq, api: LF_API, integrity: `sha256:${h.toString('base64')}`, size: bytes.length })
}
export const lfSign = (doc, privateKey) => crypto.sign(null, Buffer.from(LF_PREFIX + doc), privateKey).toString('base64')
/** Whether sig is one of the keys' signature over doc's exact bytes. */
export function lfSigned(doc, sig, keys = UPDATE_KEYS) {
  if (typeof doc !== 'string' || typeof sig !== 'string' || !sig || doc.length > 4096) return false
  const text = Buffer.from(LF_PREFIX + doc)
  const bytes = Buffer.from(sig, 'base64')
  return keys.some((k) => {
    try {
      return crypto.verify(null, text, crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }), bytes)
    } catch {
      return false
    }
  })
}

/**
 * The whole check, in order (REQ-S-103): the signature over the document's bytes, then what it says (this machine's
 * build, api, a seq), then the bytes against it. {ok, d} or {ok:false, why}. Nothing that fails is ever run.
 */
export function lfVerify({ doc, sig, bytes }, { arch, keys = UPDATE_KEYS } = {}) {
  if (!lfSigned(doc, sig, keys)) return { ok: false, why: '관리자 서명이 없거나 맞지 않음' }
  let d
  try {
    d = JSON.parse(doc)
  } catch {
    return { ok: false, why: '문서가 JSON 이 아님' }
  }
  if (!d || d.name !== `localfull-${arch}` || d.api !== LF_API || !Number.isSafeInteger(d.seq) || d.seq < 1 || typeof d.integrity !== 'string' || typeof d.version !== 'string') return { ok: false, why: '이 기기의 빌드 문서가 아님' }
  if (!Buffer.isBuffer(bytes) || bytes.length > LF_MAX) return { ok: false, why: '빌드가 없거나 너무 큼' }
  const h = sha256(bytes)
  if (`sha256:${h.toString('base64')}` !== d.integrity || bytes.length !== d.size || h.toString('hex').slice(0, 12) !== d.version) return { ok: false, why: '빌드가 서명한 해시와 다름' }
  return { ok: true, d }
}

/** agent.json's `localFull`: off unless turned on at this Mac's terminal; the port is the agent's + 10 by default. */
export function localFullOf(cfg, agentPort = 4317) {
  const v = cfg && typeof cfg.localFull === 'object' && cfg.localFull ? cfg.localFull : {}
  const p = Number(v.port)
  const h = Number(v.sessionHours)
  return { on: v.on === true, port: Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : agentPort + 10, sessionHours: Number.isFinite(h) ? Math.min(168, Math.max(1, Math.round(h))) : 12 }
}

const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}
function writeJson(p, v, mode = 0o600) {
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(v), { mode })
  fs.renameSync(`${p}.tmp`, p)
}

/**
 * The build on this Mac, the floor under which none is taken, the one-time links and the local server's data. All
 * under `dir` (~/.claude-bridge/localfull, 0700; files 0600, the program 0700).
 */
export class LocalFull {
  constructor({ dir, arch = archOf(), keys = UPDATE_KEYS }) {
    Object.assign(this, { dir, arch, keys })
    this.binDir = path.join(dir, 'bin')
    this.binPath = path.join(this.binDir, 'bridge-server')
    this.docPath = path.join(this.binDir, 'doc.json')
    this.manifestPath = path.join(dir, 'manifest.json')
    this.ticketsPath = path.join(dir, 'tickets.json')
    this.statePath = path.join(dir, 'state.json')
    this.dataDir = path.join(dir, 'data')
  }
  ensure() {
    for (const d of [this.dir, this.binDir]) {
      fs.mkdirSync(d, { recursive: true, mode: 0o700 })
      try {
        fs.chmodSync(d, 0o700)
      } catch {}
    }
  }
  floor() {
    const n = Number(readJson(this.manifestPath, {}).floor)
    return Number.isSafeInteger(n) && n > 0 ? n : 0
  }
  /** The build on disk, read back and checked whole. {ok, d} or {ok:false, why}. */
  installed() {
    if (!this.arch) return { ok: false, why: '이 기기용 빌드가 없음(macOS arm64·x64 만)' }
    const rec = readJson(this.docPath, null)
    if (!rec) return { ok: false, why: '받은 빌드가 없음' }
    let bytes
    try {
      bytes = fs.readFileSync(this.binPath)
    } catch {
      return { ok: false, why: '빌드 파일이 없음' }
    }
    const r = lfVerify({ doc: rec.doc, sig: rec.sig, bytes }, { arch: this.arch, keys: this.keys })
    if (r.ok && r.d.seq < this.floor()) return { ok: false, why: '전에 받은 것보다 먼저 서명된 빌드' }
    return r
  }
  /**
   * A build from the site (or anywhere): checked, then put in place. A seq lower than the floor is refused: the site
   * cannot send back a build signed before the one this Mac took (REQ-S-103).
   */
  install({ doc, sig, bytes }) {
    const r = lfVerify({ doc, sig, bytes }, { arch: this.arch, keys: this.keys })
    if (!r.ok) return { result: 'verify_failed', why: r.why }
    const floor = this.floor()
    if (r.d.seq < floor) return { result: 'old', seq: r.d.seq, floor }
    const now = this.installed()
    if (now.ok && now.d.version === r.d.version) return { result: 'same', version: r.d.version, seq: r.d.seq }
    this.ensure()
    fs.writeFileSync(`${this.binPath}.tmp`, bytes, { mode: 0o700 })
    fs.renameSync(`${this.binPath}.tmp`, this.binPath)
    writeJson(this.docPath, { doc, sig })
    writeJson(this.manifestPath, { floor: Math.max(floor, r.d.seq) })
    return { result: 'installed', version: r.d.version, seq: r.d.seq }
  }
  /** Made at this Mac's terminal only (`local --full open`): stored as its SHA-256, five minutes, once. */
  newTicket() {
    this.ensure()
    const t = crypto.randomBytes(32).toString('base64url')
    const now = Date.now()
    const list = (Array.isArray(readJson(this.ticketsPath, [])) ? readJson(this.ticketsPath, []) : []).filter((x) => x && x.exp > now).slice(-(MAX_TICKETS - 1))
    writeJson(this.ticketsPath, [...list, { h: sha256(t).toString('hex'), exp: now + TICKET_MS }])
    return t
  }
  dropTickets() {
    fs.rmSync(this.ticketsPath, { force: true })
  }
  /** What the running agent says about the switch, for the terminal: {on, active, port, version, error, at}. */
  state() {
    return readJson(this.statePath, {})
  }
  saveState(v) {
    this.ensure()
    writeJson(this.statePath, { ...v, at: Date.now() })
  }
}

// ---------- the agent's link to its local server ----------

/** SSE text into its messages: `data:` lines of each block, JSON. Comments and other fields are skipped. */
export function sseMessages(buf) {
  const out = []
  let rest = buf
  let i
  while ((i = rest.indexOf('\n\n')) >= 0) {
    const block = rest.slice(0, i)
    rest = rest.slice(i + 2)
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data) continue
    try {
      out.push(JSON.parse(data))
    } catch {}
  }
  return { msgs: out, rest }
}

/**
 * What the site's bridge tab does (web/relay.js), done by the agent itself for its local server: the agent's messages
 * go up (/api/bridge/up), the server's commands come down (/api/bridge/stream) and are run in the agent. Every
 * request carries the run's secret; the local server takes nothing else on these routes (REQ-S-104).
 *   toAgent(cmd)                runs a command in the agent (throws when it cannot)
 *   saveFile({id, name, sid, body})  keeps a file the server holds for a message, returns where
 */
export class Relay {
  constructor({ base, secret, toAgent, saveFile, log = () => {}, fetchImpl = fetch, auth = null }) {
    // auth: other headers in place of the secret (a test standing in for the site's bridge tab with a sign-in cookie).
    Object.assign(this, { base, secret, toAgent, saveFile, log, fetch: fetchImpl, auth })
    this.queue = []
    this.hostId = null
    this.conn = null
    this.ready = false
    this.stopped = true
    this.pumping = false
    this.gen = 0
    this.abort = null
    this.lastHello = null
  }
  headers(json) {
    return { ...(this.auth ?? { Authorization: `Bearer ${this.secret}` }), ...(json ? { 'Content-Type': 'application/json' } : {}) }
  }
  post(p, body, ms = 30_000) {
    return this.fetch(this.base + p, { method: 'POST', headers: this.headers(true), body: JSON.stringify(body), signal: AbortSignal.timeout(ms) })
  }
  start() {
    this.stopped = false
  }
  /** What the agent emitted (its SSE line to a tab). */
  fromAgent(msg) {
    if (this.stopped || !msg || typeof msg !== 'object' || msg.t === 'rekey') return
    if (msg.t === 'hello') {
      this.queue.length = 0
      this.lastHello = msg
      if (this.hostId !== msg.hostId || !this.conn) {
        this.hostId = msg.hostId
        this.queue.push(msg)
        return void this.helloServer(msg)
      }
    }
    this.queue.push(msg)
    this.pump()
  }
  async helloServer(msg) {
    const gen = ++this.gen
    this.abort?.abort()
    this.ready = false
    while (!this.stopped && gen === this.gen) {
      try {
        const r = await this.post('/api/bridge/hello', { hostId: msg.hostId, name: msg.name }, 10_000)
        const j = await r.json().catch(() => ({}))
        if (!r.ok || !j.conn) throw new Error(j.error || `HTTP ${r.status}`)
        this.conn = j.conn
        return void this.down(gen)
      } catch (e) {
        this.log('warn', `로컬 서버에 연동을 알리지 못함: ${e.message}`)
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }
  /** The server's commands, as long as this connection is the host's. A lost one asks the agent to say hello again. */
  async down(gen) {
    let first = true
    while (!this.stopped && gen === this.gen) {
      const ac = (this.abort = new AbortController())
      try {
        const r = await this.fetch(`${this.base}/api/bridge/stream?${new URLSearchParams({ hostId: this.hostId, conn: this.conn, gen: String(gen) })}`, { headers: this.headers(false), signal: ac.signal })
        if (r.status === 409) return void this.again('로컬 서버가 이 연결을 받지 않음')
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        this.ready = true
        if (!first) this.toAgent({ t: 'rehello' }).catch(() => {})
        first = false
        this.pump()
        let buf = ''
        const dec = new TextDecoder()
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true })
          const { msgs, rest } = sseMessages(buf)
          buf = rest
          for (const m of msgs) this.fromServer(m)
          if (this.stopped || gen !== this.gen) return
        }
        throw new Error('스트림이 끝남')
      } catch (e) {
        if (this.stopped || gen !== this.gen) return
        this.ready = false
        this.log('warn', `로컬 서버 스트림: ${e.message}, 다시 연결`)
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }
  /** The link is to be made again from the agent's hello (the local server forgot this connection). */
  again(why) {
    this.log('warn', `${why} — 다시 연동`)
    this.conn = null
    this.ready = false
    this.gen++
    // The agent's fresh hello (its sessions as they are now) opens the next connection (fromAgent).
    this.toAgent({ t: 'rehello' }).catch(() => {})
  }
  fromServer(cmd) {
    if (!cmd || typeof cmd !== 'object' || cmd.t === 'web') return
    if (cmd.t === 'replaced') return void this.again('다른 연결이 넘겨받음')
    if (cmd.reqId) (this.queue.push({ t: 'got', reqId: cmd.reqId }), this.pump())
    this.prepare(cmd)
      .then((c) => c && this.toAgent(c))
      .catch((e) => {
        this.log('error', `${cmd.t} 를 에이전트로 넘기지 못함: ${e.message}`)
        if (cmd.reqId) (this.queue.push({ t: 'relayfail', reqId: cmd.reqId, error: e.message }), this.pump())
      })
  }
  /** What the bridge tab adds before a command reaches the agent (web/relay.js toAgent). */
  async prepare(cmd) {
    const q = (o) => new URLSearchParams({ ...o, hostId: this.hostId, conn: this.conn })
    if (cmd.t === 'open') {
      const r = await this.fetch(`${this.base}/api/bridge/transcript?${q({ sid: cmd.sid })}`, { headers: this.headers(false) })
      if (!r.ok) throw new Error(`대화 사본을 받지 못함 (HTTP ${r.status})`)
      if (r.status !== 204) cmd.transcript = await r.text()
    }
    // The local server hands out no agent files: the agent updates from the site, after `local --full off`.
    if (cmd.t === 'update') return null
    if (cmd.t === 'send' && Array.isArray(cmd.videos)) {
      for (const v of cmd.videos) {
        const r = await this.fetch(`${this.base}/api/bridge/upload?${q({ id: v.id })}`, { headers: this.headers(false) })
        if (!r.ok) throw new Error(`영상·파일을 받지 못함 (HTTP ${r.status})`)
        v.path = await this.saveFile({ id: v.id, name: v.name, sid: cmd.sid, body: r.body })
      }
    }
    return cmd
  }
  /** The agent's messages, in order, in batches of about 1 MB. A failed batch is sent again, never skipped. */
  async pump() {
    if (this.pumping || !this.ready || this.stopped) return
    this.pumping = true
    try {
      while (this.queue.length && this.ready && !this.stopped) {
        const batch = []
        let size = 0
        while (this.queue.length && size < 1024 * 1024) {
          size += JSON.stringify(this.queue[0]).length
          batch.push(this.queue.shift())
        }
        try {
          const r = await this.post('/api/bridge/up', { hostId: this.hostId, conn: this.conn, msgs: batch })
          if (r.status === 409) return void this.again('로컬 서버가 이 연결을 받지 않음')
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
        } catch (e) {
          this.queue.unshift(...batch)
          this.log('warn', `로컬 서버로 보내지 못함 (${e.message}), 다시 시도`)
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
    } finally {
      this.pumping = false
    }
  }
  async stop() {
    if (this.stopped) return
    this.stopped = true
    this.gen++
    this.abort?.abort()
    if (this.hostId && this.conn) await this.post('/api/bridge/bye', { hostId: this.hostId, conn: this.conn }, 2000).catch(() => {})
    this.conn = null
    this.ready = false
  }
}

// ---------- the terminal: `node agent.mjs local --full …` ----------

/** A build from the site: its signed document, then its bytes. */
export async function fetchBuild(site, arch, fetchImpl = fetch) {
  const j = await fetchImpl(`${site}/localfull/${arch}.json`, { signal: AbortSignal.timeout(20_000) })
  const meta = await j.json().catch(() => ({}))
  if (!j.ok || typeof meta.doc !== 'string') throw new Error(meta.error || `문서를 받지 못함 (HTTP ${j.status})`)
  const b = await fetchImpl(`${site}/localfull/${arch}`, { signal: AbortSignal.timeout(600_000) })
  if (!b.ok) throw new Error(`빌드를 받지 못함 (HTTP ${b.status})`)
  const bytes = Buffer.from(await b.arrayBuffer())
  return { doc: meta.doc, sig: meta.sig, bytes }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * `local --full on | off | open | status` at this Mac's terminal (REQ-F-902). agent.json's `localFull` is written
 * here (never by a server command) and read again by the running agent every 2 s, which makes the switch.
 * Returns the exit code.
 */
export async function localFullCli(words, { configPath, lf, site, agentPort, open, running, fetchImpl = fetch, waitMs = 30_000 }) {
  const set = (patch) => {
    const disk = readJson(configPath, {})
    disk.localFull = { ...(disk.localFull && typeof disk.localFull === 'object' ? disk.localFull : {}), ...patch }
    fs.writeFileSync(`${configPath}.tmp`, JSON.stringify(disk, null, 2), { mode: 0o600 })
    fs.renameSync(`${configPath}.tmp`, configPath)
  }
  const now = () => localFullOf(readJson(configPath, {}), agentPort)
  const link = () => `http://127.0.0.1:${now().port}/#t=${lf.newTicket()}`
  const waitState = async (want) => {
    const end = Date.now() + waitMs
    while (Date.now() < end) {
      const st = lf.state()
      if (st.active === want) return st
      if (want && st.error && st.at > started) return st
      await sleep(500)
    }
    return lf.state()
  }
  const started = Date.now()
  const [cmd = 'status'] = words
  if (cmd === 'on') {
    if (!lf.arch) {
      console.error('로컬 전체 화면은 macOS(arm64·x64)에서만 써요.')
      return 1
    }
    // The build: the site's, when it has one signed after (or as) the one here; else the one already here.
    let got = null
    try {
      if (!/^https?:\/\//.test(site || '')) throw new Error('사이트 주소가 없음')
      console.log(`${site} 에서 맥용 서버(${lf.arch})를 받는 중…`)
      got = lf.install(await fetchBuild(site, lf.arch, fetchImpl))
    } catch (e) {
      got = { result: 'fetch_failed', why: e.message }
    }
    const have = lf.installed()
    if (got.result === 'installed') console.log(`맥용 서버 ${got.version}(순번 ${got.seq})을 확인하고 받았어요.`)
    else if (got.result === 'same') console.log(`맥용 서버 ${got.version}(순번 ${got.seq}): 이미 받은 것과 같아요.`)
    else if (got.result === 'old') console.log(`사이트의 빌드(순번 ${got.seq})가 이 맥의 것(순번 ${got.floor})보다 먼저 서명돼 받지 않았어요.`)
    else console.log(`사이트에서 받지 못했어요: ${got.why}`)
    if (!have.ok) {
      console.error(`쓸 수 있는 맥용 서버가 없어요(${have.why}). 사이트에 연결된 상태에서 다시 해 주세요.`)
      return 1
    }
    set({ on: true })
    if (!(await running())) {
      console.log('켜 두었어요. 에이전트가 켜지면 로컬 서버로 바꿔 붙어요.')
      return 0
    }
    console.log('에이전트가 사이트 연결을 끊고 로컬 서버로 바꿔 붙는 중…')
    const st = await waitState(true)
    if (!st.active) {
      console.error(`바꾸지 못했어요: ${st.error || '시간이 지남'}. 상태: node agent.mjs local --full status`)
      return 1
    }
    const l = link()
    console.log(`\n로컬 전체 화면: http://127.0.0.1:${st.port}/ (이 맥에서만)\n일회용 링크(5분 안에 한 번만):\n\n  ${l}\n\n사이트로 돌아가려면: node agent.mjs local --full off`)
    open?.(l)
    return 0
  }
  if (cmd === 'off') {
    set({ on: false })
    lf.dropTickets()
    if (!(await running())) {
      console.log('껐어요. 에이전트가 켜지면 사이트에 붙어요.')
      return 0
    }
    const st = await waitState(false)
    console.log(st.active ? '아직 바꾸는 중이에요. 잠시 뒤 status 로 보세요.' : '로컬 서버를 내리고 사이트 연동으로 돌아갔어요. 이 맥의 사이트 탭이나 헤드리스 연동이 몇 초 안에 다시 붙어요.')
    return 0
  }
  if (cmd === 'open') {
    if (!now().on) {
      console.error('로컬 전체 화면이 꺼져 있어요. 켜려면: node agent.mjs local --full on')
      return 1
    }
    const l = link()
    console.log(`일회용 링크(5분 안에 한 번만, 이 맥의 브라우저에서):\n\n  ${l}\n`)
    if (!lf.state().active) console.log('에이전트가 아직 로컬 서버로 바꾸지 않았어요: node agent.mjs local --full status')
    else open?.(l)
    return 0
  }
  if (cmd === 'status') {
    const v = now()
    const st = lf.state()
    const have = lf.installed()
    console.log(`로컬 전체 화면: ${v.on ? '켜짐' : '꺼짐'} · 지금 ${st.active ? `로컬 서버(127.0.0.1:${st.port})에 연동 중` : '사이트 연동'}${st.error ? ` · 문제: ${st.error}` : ''}`)
    console.log(`맥용 서버: ${have.ok ? `${have.d.version} (순번 ${have.d.seq})` : `없음(${have.why})`} · 데이터: ${lf.dataDir}`)
    return 0
  }
  console.error('사용법: node agent.mjs local --full on | off | open | status')
  return 1
}
