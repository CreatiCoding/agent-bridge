// The local screen (REQ-F-843~845, REQ-S-096~098, docs/LOCAL-UI-DESIGN.md): what the agent serves at
// http://127.0.0.1:<port>/local/ so this Mac's sessions can be seen and typed into while the site is down or out of
// reach. Its files come as a bundle signed with the maintainer's key, the same keys as agent updates: builtin (in
// localbundle.mjs, an agent file) or remote (sent by the server while linked, staged, checked again, then put in
// place). The way bundles are kept follows Webview Bundle (wvb.dev): two sources, a manifest with current, previous
// and staged, a sha256 integrity, a signed update document, and rollback. Its format and code are this repo's own.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { UPDATE_KEYS } from './keys.mjs'

/**
 * What the page and the agent agree on: a bundle for another api is never served. 2 (1.517): conv, new, close and
 * files on send (REQ-F-898). A page made for 2 on an agent of 1 would show buttons that answer 404.
 */
export const LOCALUI_API = 2
/** In front of what is signed, so that no agent-update signature reads as a bundle's and none of these as one. */
export const SIG_PREFIX = 'claude-bridge localui v1\n'
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', json: 'application/json' }
export const MAX_FILES = 32
export const MAX_BYTES = 2 * 1024 * 1024
const TICKET_MS = 5 * 60_000
const MAX_TICKETS = 5
const MAX_TOKENS = 10
/** How long a newly put-in-place remote bundle has to say its first screen came up before it is rolled back. */
export const BOOT_MS = 30_000

const sha256 = (b) => crypto.createHash('sha256').update(b).digest()
const hashText = (t) => sha256(String(t)).toString('hex')

// ---------- agent.json `localUi` ----------

/** agent.json's `localUi`, with its defaults (§3): on, remote bundles taken, 12-hour sign-ins. */
export function localUiOf(cfg) {
  const v = cfg && typeof cfg.localUi === 'object' && cfg.localUi ? cfg.localUi : {}
  const h = Number(v.sessionHours)
  return { on: v.on !== false, ota: v.ota !== false, sessionHours: Number.isFinite(h) ? Math.min(168, Math.max(1, Math.round(h))) : 12 }
}

// ---------- bundle format (cb-bundle v1) ----------

/** The bundle bytes for these files ({name: Buffer|string}), names in order so the same files give the same bytes. */
export function makeBundle(files, api = LOCALUI_API) {
  const out = {}
  for (const name of Object.keys(files).sort()) {
    const ext = name.split('.').pop()
    if (!NAME_RE.test(name) || !TYPES[ext]) throw new Error(`묶음에 넣을 수 없는 파일 이름: ${name}`)
    out[name] = { type: TYPES[ext], data: Buffer.from(files[name]).toString('base64') }
  }
  return JSON.stringify({ format: 'cb-bundle', v: 1, name: 'localui', api, files: out })
}

/** The files of bundle bytes, or an Error saying why they are not a bundle this agent serves (§2.2). */
export function parseBundle(text, api = LOCALUI_API) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES * 2) return new Error('묶음이 너무 큼')
  let b
  try {
    b = JSON.parse(text)
  } catch {
    return new Error('묶음이 JSON 이 아님')
  }
  if (!b || b.format !== 'cb-bundle' || b.v !== 1 || b.name !== 'localui') return new Error('묶음 형식이 아님')
  if (b.api !== api) return new Error(`다른 api 의 묶음(${b.api})`)
  if (!b.files || typeof b.files !== 'object' || Array.isArray(b.files)) return new Error('파일 목록이 없음')
  const names = Object.keys(b.files)
  if (!names.length || names.length > MAX_FILES) return new Error('파일 수가 맞지 않음')
  const files = new Map()
  let total = 0
  for (const name of names) {
    const f = b.files[name]
    const ext = name.split('.').pop()
    if (!NAME_RE.test(name) || !TYPES[ext] || !f || f.type !== TYPES[ext] || typeof f.data !== 'string') return new Error(`파일이 올바르지 않음: ${name.slice(0, 64)}`)
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)) return new Error(`파일 내용이 base64 가 아님: ${name}`)
    const body = Buffer.from(f.data, 'base64')
    total += body.length
    if (total > MAX_BYTES) return new Error('묶음이 너무 큼')
    files.set(name, { type: f.type, body })
  }
  if (!files.has('index.html')) return new Error('index.html 이 없음')
  return files
}

// ---------- the signed document ----------

/** The update document of bundle bytes under seq: what is signed, as these exact bytes (§2.3). */
export function docOf(bundle, seq, api = LOCALUI_API) {
  const h = sha256(bundle)
  return JSON.stringify({ name: 'localui', version: h.toString('hex').slice(0, 12), seq, api, integrity: `sha256:${h.toString('base64')}`, size: Buffer.byteLength(bundle) })
}
export const signDoc = (doc, privateKey) => crypto.sign(null, Buffer.from(SIG_PREFIX + doc), privateKey).toString('base64')
/** Whether sig (base64) is one of the keys' signature of doc's exact bytes. */
export function docSigned(doc, sig, keys = UPDATE_KEYS) {
  if (typeof doc !== 'string' || typeof sig !== 'string' || !sig || doc.length > 4096) return false
  const text = Buffer.from(SIG_PREFIX + doc)
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
 * The whole check of §2.4, in order: the signature over the document's bytes first, then what it says, then the
 * bundle's bytes against it, then the bundle itself. {ok, d, files} or {ok:false, why}. Nothing that fails is served.
 */
export function verify({ doc, sig, bundle }, { keys = UPDATE_KEYS, api = LOCALUI_API } = {}) {
  if (!docSigned(doc, sig, keys)) return { ok: false, why: '관리자 서명이 없거나 맞지 않음' }
  let d
  try {
    d = JSON.parse(doc)
  } catch {
    return { ok: false, why: '갱신 문서가 JSON 이 아님' }
  }
  if (!d || d.name !== 'localui' || !Number.isSafeInteger(d.seq) || d.seq < 1 || typeof d.integrity !== 'string' || !/^sha256:[A-Za-z0-9+/]{43}=$/.test(d.integrity) || typeof d.version !== 'string') return { ok: false, why: '갱신 문서가 올바르지 않음' }
  if (d.api !== api) return { ok: false, why: `이 에이전트가 쓰지 않는 api(${d.api})` }
  if (typeof bundle !== 'string') return { ok: false, why: '묶음이 없음' }
  const h = sha256(bundle)
  if (`sha256:${h.toString('base64')}` !== d.integrity || Buffer.byteLength(bundle) !== d.size || h.toString('hex').slice(0, 12) !== d.version) return { ok: false, why: '묶음이 서명한 해시와 다름' }
  const files = parseBundle(bundle, api)
  if (files instanceof Error) return { ok: false, why: files.message }
  return { ok: true, d, files }
}

// ---------- the bundles on this Mac ----------

const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}
function writeJson(p, v) {
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(v), { mode: 0o600 })
  fs.renameSync(`${p}.tmp`, p)
}
const emptyManifest = () => ({ manifestVersion: 1, current: null, previous: null, staged: null, floor: 0, bad: [], versions: {} })

/**
 * The bundles (builtin and remote), which one is served, the one-time tickets and the sign-in tokens. Everything is
 * under `dir` (~/.claude-bridge/localui, 0700, files 0600); nothing here reads the network.
 */
export class LocalUi {
  constructor({ dir, builtin, keys = UPDATE_KEYS, api = LOCALUI_API, log = () => {}, now = () => Date.now() }) {
    Object.assign(this, { dir, keys, api, log, now })
    this.remoteDir = path.join(dir, 'remote')
    this.manifestPath = path.join(this.remoteDir, 'manifest.json')
    const b = builtin ? verify(builtin, { keys, api }) : { ok: false, why: '들어 있는 묶음이 없음' }
    this.builtin = b.ok ? { source: 'builtin', version: b.d.version, seq: b.d.seq, files: b.files, confirmed: true } : null
    if (!b.ok) log('warn', `들어 있는 화면 묶음을 쓰지 않음: ${b.why}`)
    this.loaded = null
    this.trial = null
    this.fails = []
  }
  ensure() {
    fs.mkdirSync(this.remoteDir, { recursive: true, mode: 0o700 })
    for (const d of [this.dir, this.remoteDir])
      try {
        fs.chmodSync(d, 0o700)
      } catch {}
  }
  manifest() {
    const m = readJson(this.manifestPath, null)
    return m && m.manifestVersion === 1 && m.versions && typeof m.versions === 'object' ? { ...emptyManifest(), ...m, bad: Array.isArray(m.bad) ? m.bad : [] } : emptyManifest()
  }
  save(m) {
    this.ensure()
    // Only what may still be used is kept: current, previous and staged (wvb's prune).
    const keep = new Set([m.current, m.previous, m.staged].filter(Boolean))
    for (const v of Object.keys(m.versions)) if (!keep.has(v)) delete m.versions[v]
    for (const f of fs.readdirSync(this.remoteDir)) if (f.endsWith('.cbb') && !keep.has(f.slice(0, -4))) fs.rmSync(path.join(this.remoteDir, f), { force: true })
    m.bad = m.bad.slice(-20)
    writeJson(this.manifestPath, m)
  }
  fileOf = (v) => path.join(this.remoteDir, `${String(v).replace(/[^0-9a-f]/g, '')}.cbb`)
  /** A remote version, read back from disk and checked whole (§2.4), or {ok:false, why}. */
  readRemote(m, v) {
    const rec = m.versions[v]
    if (!rec) return { ok: false, why: '기록이 없음' }
    let bundle
    try {
      bundle = fs.readFileSync(this.fileOf(v), 'utf8')
    } catch {
      return { ok: false, why: '파일이 없음' }
    }
    const r = verify({ doc: rec.doc, sig: rec.sig, bundle }, { keys: this.keys, api: this.api })
    if (r.ok && r.d.version !== v) return { ok: false, why: '버전이 기록과 다름' }
    return r
  }

  /**
   * A bundle the server passed on (`localui`): checked, staged, then installed (§2.6). Returns what happened, as
   * wvb's result types: installed, verify_failed, old (signed before what this Mac has), bad, same.
   */
  offer({ doc, sig, bundle }) {
    const r = verify({ doc, sig, bundle }, { keys: this.keys, api: this.api })
    if (!r.ok) return { result: 'verify_failed', why: r.why }
    const m = this.manifest()
    if (m.bad.includes(r.d.version)) return { result: 'bad', version: r.d.version }
    const active = this.active()
    if (active && active.version === r.d.version) return { result: 'same', version: r.d.version }
    // Never back: a bundle signed before the one this Mac took or ships is an older one sent again (§2.6).
    const floor = Math.max(m.floor || 0, this.builtin?.seq ?? 0, active?.seq ?? 0)
    if (r.d.seq <= floor) return { result: 'old', version: r.d.version, seq: r.d.seq, floor }
    // staged
    this.ensure()
    fs.writeFileSync(`${this.fileOf(r.d.version)}.tmp`, bundle, { mode: 0o600 })
    fs.renameSync(`${this.fileOf(r.d.version)}.tmp`, this.fileOf(r.d.version))
    m.versions[r.d.version] = { doc, sig, at: this.now(), confirmed: false }
    m.staged = r.d.version
    // Raised as it is staged: whatever happens to it next, nothing signed before it is taken again.
    m.floor = Math.max(m.floor || 0, r.d.seq)
    this.save(m)
    return this.install()
  }
  /** Puts the staged bundle in place, after reading it back from disk and checking it again. */
  install() {
    const m = this.manifest()
    const v = m.staged
    if (!v) return { result: 'staged_bundle_not_exists' }
    const r = this.readRemote(m, v)
    if (!r.ok) {
      m.staged = null
      delete m.versions[v]
      this.save(m)
      this.log('warn', `화면 묶음 ${v} 을 깔지 않음: ${r.why}`)
      return { result: 'verify_failed', version: v, why: r.why }
    }
    if (m.current && m.current !== v) m.previous = m.current
    m.current = v
    m.staged = null
    m.floor = Math.max(m.floor || 0, r.d.seq)
    m.versions[v].confirmed = false
    this.save(m)
    this.loaded = null
    this.trial = null
    this.log('info', `화면 묶음 ${v} 을 깔았음(순번 ${r.d.seq})`)
    return { result: 'installed', version: v, seq: r.d.seq }
  }

  /**
   * The bundle served now (§2.1): the remote current when it checks out and is newer than the builtin, else the
   * builtin. One that fails to load is rolled back from here (§2.7). null: nothing can be served.
   */
  active() {
    const m = this.manifest()
    if (this.loaded && this.loaded.source === 'remote' && this.loaded.version === m.current) return this.loaded
    if (this.loaded?.source === 'builtin' && !m.current) return this.loaded
    if (m.current) {
      const r = this.readRemote(m, m.current)
      if (r.ok && this.builtin && r.d.seq <= this.builtin.seq) {
        // The agent was updated and its own bundle is newer: an older remote one does not hide it.
        this.log('info', `들어 있는 화면 묶음이 더 새것이라 원격 묶음 ${m.current} 을 내림`)
        m.previous = m.current
        m.current = null
        this.save(m)
      } else if (r.ok) {
        this.loaded = { source: 'remote', version: m.current, seq: r.d.seq, files: r.files, confirmed: !!m.versions[m.current]?.confirmed }
        return this.loaded
      } else {
        this.rollback(`불러오지 못함: ${r.why}`, { bad: true })
        return this.active()
      }
    }
    this.loaded = this.builtin
    return this.loaded
  }
  /**
   * Away from the current remote bundle (§2.7). On its own (a load or a check that failed, a page that never came up)
   * the agent goes back to the builtin only, never to an older remote one: that would let whoever made it fail pick
   * an older signed screen. `manual` (`local rollback` at the terminal) goes to previous when it checks out and is
   * newer than the builtin. `bad`: it failed its check, and is never taken again.
   */
  rollback(why, { manual = false, bad = false } = {}) {
    const m = this.manifest()
    const from = m.current
    if (!from) return { result: 'previous_bundle_not_exists' }
    if (bad) m.bad = [...m.bad.filter((v) => v !== from), from]
    let to = null
    if (manual && m.previous && m.previous !== from && !m.bad.includes(m.previous)) {
      const p = this.readRemote(m, m.previous)
      if (p.ok && !(this.builtin && p.d.seq <= this.builtin.seq)) to = m.previous
    }
    m.current = to
    m.previous = to ? null : from
    this.save(m)
    this.loaded = null
    this.trial = null
    this.fails.push({ at: this.now(), version: from, why })
    this.fails = this.fails.slice(-5)
    this.log('warn', `화면 묶음 ${from} 을 되돌림(${why}) → ${to ?? '들어 있는 묶음'}`)
    return { result: 'rolled_back', from, to: to ?? 'builtin' }
  }
  /** Remote bundles off: the builtin is served (`local reset`). */
  reset() {
    const m = this.manifest()
    m.current = null
    m.previous = null
    m.staged = null
    this.save(m)
    this.loaded = null
    this.trial = null
  }
  /** index.html of a remote bundle not yet confirmed went out: it has BOOT_MS to say its page came up. */
  served(a) {
    if (a?.source !== 'remote' || a.confirmed || this.trial?.version === a.version) return
    this.trial = { version: a.version, until: this.now() + BOOT_MS }
  }
  /** The page of this version drew its first screen (`booted`): it stays. */
  booted(version) {
    const m = this.manifest()
    if (!m.current || m.current !== version || !m.versions[version] || m.versions[version].confirmed) return false
    m.versions[version].confirmed = true
    this.save(m)
    if (this.loaded?.version === version) this.loaded.confirmed = true
    this.trial = null
    this.log('info', `화면 묶음 ${version} 이 떴음`)
    return true
  }
  /** Called now and then: a trial that ran out is rolled back. */
  tick() {
    if (this.trial && this.now() > this.trial.until) {
      const v = this.trial.version
      this.trial = null
      if (this.manifest().current === v) this.rollback('페이지가 첫 화면을 그리지 못함')
    }
  }
  info() {
    const a = this.active()
    return { api: this.api, active: a ? { source: a.source, version: a.version, seq: a.seq } : null, builtin: this.builtin ? { version: this.builtin.version, seq: this.builtin.seq } : null, fails: this.fails }
  }

  // ---------- tickets and tokens (§4) ----------

  get ticketsPath() {
    return path.join(this.dir, 'tickets.json')
  }
  get tokensPath() {
    return path.join(this.dir, 'tokens.json')
  }
  /** Made at the Mac's terminal (`local open`) only: there is no way to make one over HTTP or from the server. */
  newTicket() {
    this.ensure()
    const t = crypto.randomBytes(32).toString('base64url')
    const now = this.now()
    const list = readJson(this.ticketsPath, []).filter((x) => x && x.exp > now).slice(-(MAX_TICKETS - 1))
    writeJson(this.ticketsPath, [...list, { h: hashText(t), exp: now + TICKET_MS }])
    return t
  }
  /** A ticket taken once, before it ran out. */
  takeTicket(t) {
    if (typeof t !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(t)) return false
    const now = this.now()
    const list = readJson(this.ticketsPath, [])
    if (!Array.isArray(list)) return false
    const h = hashText(t)
    const hit = list.find((x) => x && typeof x.h === 'string' && x.exp > now && x.h.length === h.length && crypto.timingSafeEqual(Buffer.from(x.h), Buffer.from(h)))
    if (!hit) return false
    writeJson(this.ticketsPath, list.filter((x) => x !== hit && x?.exp > now))
    return true
  }
  issue(hours) {
    this.ensure()
    const tok = crypto.randomBytes(32).toString('base64url')
    const now = this.now()
    const exp = now + hours * 3600_000
    const list = readJson(this.tokensPath, []).filter((x) => x && x.exp > now).slice(-(MAX_TOKENS - 1))
    writeJson(this.tokensPath, [...list, { h: hashText(tok), exp }])
    return { token: tok, exp }
  }
  tokenOk(tok) {
    if (typeof tok !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(tok)) return false
    const now = this.now()
    const h = Buffer.from(hashText(tok))
    const list = readJson(this.tokensPath, [])
    return Array.isArray(list) && list.some((x) => x && typeof x.h === 'string' && x.exp > now && x.h.length === h.length && crypto.timingSafeEqual(Buffer.from(x.h), h))
  }
  drop(tok) {
    const h = hashText(tok)
    writeJson(this.tokensPath, readJson(this.tokensPath, []).filter((x) => x?.h !== h))
  }
  dropAll() {
    for (const f of [this.ticketsPath, this.tokensPath]) fs.rmSync(f, { force: true })
  }
}

// ---------- who may ask (§4.3) ----------

/** The Host of a request to /local/: this Mac's own loopback name and port only (no DNS rebinding). */
export const hostOk = (host, port) => host === `127.0.0.1:${port}` || host === `localhost:${port}`
/** An Origin, when there is one: the local screen's own. */
export const originOk = (origin, port) => origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
/** The headers every file of the local screen goes with. */
export const FILE_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

// ---------- files sent with a message (REQ-F-898) ----------

/** At most this many files with one message, each at most LOCAL_FILE_MAX bytes. */
export const LOCAL_FILES_MAX = 4
export const LOCAL_FILE_MAX = 8 * 1024 * 1024
/** A send's body may be this big (the files go in it as base64); every other request stays at LOCAL_BODY_MAX. */
export const LOCAL_SEND_MAX = 48 * 1024 * 1024
export const LOCAL_BODY_MAX = 64 * 1024

/** A picture is told by its first bytes, not by the name or type the page gave: anything else is a plain file. */
export function pictureExt(bytes) {
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length >= 6 && b.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif'
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return ''
}

/** A file's name as it is kept: one plain name, no path, no dot first, at most 120 characters. */
export function fileName(name) {
  const n = String(name ?? '').split(/[\\/]/).pop().replace(/[^\w.가-힣 -]/g, '_').replace(/^\.+/, '').slice(0, 120)
  return n || 'file'
}

/**
 * The files of a send from the page ([{name, data: base64}]), checked: { files: [{ picture: ext|'', name, bytes }] }
 * or { error }. Nothing is written here.
 */
export function localFiles(list) {
  if (list === undefined || list === null) return { files: [] }
  if (!Array.isArray(list)) return { error: '파일 목록이 올바르지 않아요' }
  if (list.length > LOCAL_FILES_MAX) return { error: `파일은 한 번에 ${LOCAL_FILES_MAX}개까지예요` }
  const files = []
  for (const f of list) {
    if (!f || typeof f !== 'object' || typeof f.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)) return { error: '파일 내용이 올바르지 않아요' }
    const bytes = Buffer.from(f.data, 'base64')
    if (!bytes.length) return { error: `빈 파일이에요: ${fileName(f.name)}` }
    if (bytes.length > LOCAL_FILE_MAX) return { error: `파일 하나는 ${LOCAL_FILE_MAX / 1024 / 1024} MB 까지예요: ${fileName(f.name)}` }
    files.push({ picture: pictureExt(bytes), name: fileName(f.name), bytes })
  }
  return { files }
}

// ---------- the terminal: `node agent.mjs local …` ----------

/**
 * `local [open] | on | off | ota on|off | status | rollback | reset` at this Mac's terminal (§3). Returns the exit
 * code. agent.json's `localUi` is written here and read again by the running agent every 2 s.
 */
export async function localCli(words, { configPath, ui, port, open, running }) {
  const cfg = readJson(configPath, {})
  const set = (patch) => {
    const disk = readJson(configPath, {})
    disk.localUi = { ...(disk.localUi && typeof disk.localUi === 'object' ? disk.localUi : {}), ...patch }
    fs.writeFileSync(`${configPath}.tmp`, JSON.stringify(disk, null, 2), { mode: 0o600 })
    fs.renameSync(`${configPath}.tmp`, configPath)
  }
  const [cmd = 'open', arg] = words
  const now = localUiOf(cfg)
  if (cmd === 'open') {
    if (!now.on) {
      console.error('로컬 화면이 꺼져 있어요. 켜려면: node agent.mjs local on')
      return 1
    }
    const t = ui.newTicket()
    const link = `http://127.0.0.1:${port}/local/#t=${t}`
    console.log(`로컬 화면 링크(5분 안에 한 번만 열 수 있어요, 이 맥의 브라우저에서):\n\n  ${link}\n`)
    if (!(await running())) console.log('에이전트가 지금 꺼져 있어요. 에이전트를 켠 뒤 링크를 여세요.')
    else if (open) open(link)
    // A host without a screen: the same port forwarded from another machine, since the page checks its own address.
    if (!open || process.platform !== 'darwin') console.log(`화면 없는 기기라면 다른 컴퓨터에서: ssh -L ${port}:127.0.0.1:${port} <이 기기> 뒤 위 링크를 그 컴퓨터 브라우저로 (포트는 같게)`)
    return 0
  }
  if (cmd === 'on' || cmd === 'off') {
    set({ on: cmd === 'on' })
    if (cmd === 'off') ui.dropAll()
    console.log(cmd === 'on' ? '로컬 화면을 켰어요.' : '로컬 화면을 껐어요. 로그인과 링크도 모두 지웠어요.')
    return 0
  }
  if (cmd === 'ota' && (arg === 'on' || arg === 'off')) {
    set({ ota: arg === 'on' })
    console.log(arg === 'on' ? '연동 중에 서버가 보내는 새 화면 묶음(관리자 서명된 것만)을 받아요.' : '새 화면 묶음을 받지 않아요. 지금 깔린 묶음을 그대로 써요.')
    return 0
  }
  if (cmd === 'rollback') {
    const r = ui.rollback('맥 터미널에서 되돌림', { manual: true })
    console.log(r.result === 'rolled_back' ? `되돌렸어요: ${r.from} → ${r.to}` : '되돌릴 원격 묶음이 없어요(들어 있는 묶음을 쓰는 중).')
    return 0
  }
  if (cmd === 'reset') {
    ui.reset()
    console.log('원격 묶음을 내리고 들어 있는 묶음을 써요.')
    return 0
  }
  if (cmd === 'status') {
    const i = ui.info()
    console.log(`로컬 화면: ${now.on ? '켜짐' : '꺼짐'} · 원격 묶음 받기: ${now.ota ? '켜짐' : '꺼짐'} · 로그인 유지 ${now.sessionHours}시간`)
    console.log(`쓰는 묶음: ${i.active ? `${i.active.source === 'remote' ? '원격' : '들어 있는'} ${i.active.version} (순번 ${i.active.seq})` : '없음(서명 확인 실패)'}`)
    console.log(`주소: http://127.0.0.1:${port}/local/ (링크: node agent.mjs local)`)
    if (i.fails.length) console.log(`최근 되돌림: ${i.fails.map((f) => `${f.version} (${f.why})`).join(', ')}`)
    return 0
  }
  console.error('사용법: node agent.mjs local [open] | on | off | ota on|off | status | rollback | reset')
  return 1
}
