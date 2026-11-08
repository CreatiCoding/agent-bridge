// A Mac that does not trust the server (SPEC REQ-S-090~, docs/TRUST-DESIGN.md).
// Devices (a browser profile, a phone) are paired at the Mac's terminal; from then on, in `enforce`, this Mac only
// acts on commands such a device signed, and what it sends out is sealed so that only paired devices can read it.
// Nothing here trusts what comes through the server: the pairing is confirmed at the terminal, never over HTTP.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** Raised by any change to what this file checks. An update that brings a lower one (or none) is refused (§5.7). */
export const TRUST_VERSION = 10
/** The last signed agent before this file existed (agent/agent.sig seq): no build at or below it is taken while trust is on. */
export const TRUST_MIN_SEQ = 1793550529
export const MODES = ['off', 'warn', 'enforce']
/** How far a signed command's time may be from this Mac's (each way), and how long its number is remembered. */
export const SKEW_MS = 60_000
export const PAIR_WINDOW_MS = 5 * 60_000
export const PAIR_TTL_MS = 3 * 60_000
const MAX_DEVICES = 16

export const b64u = (b) => Buffer.from(b).toString('base64url')
export const unb64u = (s) => Buffer.from(String(s ?? ''), 'base64url')
const sha256 = (...parts) => {
  const h = crypto.createHash('sha256')
  for (const p of parts) h.update(typeof p === 'string' ? Buffer.from(p, 'utf8') : p)
  return h.digest()
}
export const sha256Hex = (s) => crypto.createHash('sha256').update(Buffer.from(String(s ?? ''), 'utf8')).digest('hex')

/** A P-256 public key as WebCrypto exports it ('raw': 0x04 ‖ x ‖ y), or null. */
export function ecPublicKey(raw) {
  const b = unb64u(raw)
  if (b.length !== 65 || b[0] !== 4) return null
  try {
    return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(b.subarray(1, 33)), y: b64u(b.subarray(33)) }, format: 'jwk' })
  } catch {
    return null
  }
}
export const deviceIdOf = (spub, dpub) => b64u(sha256(unb64u(spub), unb64u(dpub))).slice(0, 22)
export const pairCommit = (spub, dpub, nb) => b64u(sha256('bt-pair-commit|', unb64u(spub), unb64u(dpub), unb64u(nb)))
/** The six digits both sides show: the first 48 bits of the hash, mod a million. */
export function pairSas(hostId, apub, spub, dpub, na, nb) {
  const h = sha256(`bt-pair-sas|${hostId}|`, unb64u(apub), unb64u(spub), unb64u(dpub), unb64u(na), unb64u(nb))
  return String(h.readUIntBE(0, 6) % 1_000_000).padStart(6, '0')
}
/** The key that carries K to one device: HKDF over the ECDH secret between this Mac and that device. */
export function wrapKey(secret, salt, hostId) {
  return Buffer.from(crypto.hkdfSync('sha256', secret, unb64u(salt), Buffer.from(`bt-wrap|${hostId}`, 'utf8'), 32))
}
export function gcmSeal(key, plain, aad) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  if (aad) c.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([c.update(plain), c.final()])
  return b64u(Buffer.concat([iv, ct, c.getAuthTag()]))
}
export function gcmOpen(key, sealed, aad) {
  const b = unb64u(sealed)
  if (b.length < 28) return null
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
    if (aad) d.setAAD(Buffer.from(aad, 'utf8'))
    d.setAuthTag(b.subarray(b.length - 16))
    return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()])
  } catch {
    return null
  }
}

// ---------- sealed pieces ----------

/** ⟦bt1:<kid>:<iv‖ct‖tag>⟧ — may sit anywhere in a string. */
export const SEAL_RE = /⟦bt1:([0-9a-f]{8}):([A-Za-z0-9_-]{38,})⟧/g
export const hasSeal = (s) => typeof s === 'string' && s.includes('⟦bt1:')
export const sealAad = (hostId, kid) => `bt1|${hostId}|${kid}`
export function sealWith(key, kid, hostId, text, dir, sid) {
  return `⟦bt1:${kid}:${gcmSeal(key, Buffer.from(JSON.stringify({ d: dir, s: sid || '', v: String(text) }), 'utf8'), sealAad(hostId, kid))}⟧`
}
/** One piece → {d, s, v}, or null. */
export function openWith(keyOf, hostId, piece) {
  const m = /^⟦bt1:([0-9a-f]{8}):([A-Za-z0-9_-]+)⟧$/.exec(piece)
  if (!m) return null
  const key = keyOf(m[1])
  if (!key) return null
  const b = gcmOpen(key, m[2], sealAad(hostId, m[1]))
  if (!b) return null
  try {
    const o = JSON.parse(b.toString('utf8'))
    return o && typeof o.v === 'string' && (o.d === 'm' || o.d === 'u') ? o : null
  } catch {
    return null
  }
}

// ---------- which command needs what (§5.5) ----------

/**
 * Every command the agent takes. `sign`: only with a paired device's signature in enforce; `off`: never in enforce;
 * `free`: as it comes. `i`: what the signature carries (and what the command is rebuilt from); `keep`: what is
 * taken from the server's copy as it is; everything else the server sent is dropped. A command missing here is
 * treated as `off`, and test/unit/trust.test.mjs fails until it is placed.
 */
export const TRUST_CLASS = {
  // the state of the link, and the Mac's copy of the log
  delegated: 'off', sudoans: 'off', sudopass: 'off', sudo: 'off', release: 'off', http: 'off', ws: 'off',
  sudooff: 'free', log: 'free', putimg: 'free', welcome: 'free', check: 'free', ping: 'free', rehello: 'free', report: 'free', resync: 'free', bg: 'free', models: 'free', update: 'free',
  // the local screen's bundle: checked by the maintainer's signature and a seq that only grows, like update (REQ-F-844)
  localui: 'free',
  // reads: what comes back is sealed
  events: 'free', export: 'free', img: 'free', screen: 'free', flush: 'free', readfile: 'free', readimage: 'free', trashinfo: 'free', prsearch: 'free', prstates: 'free', skills: 'free', dirs: 'free', recent: 'free', voice: 'free',
  // the bridge MCP's attach (by the id the session made) and another Mac's read_session (refused while sealing)
  attachment: 'free', convread: 'free',
  // actions
  // A codex session's sandbox and approval (REQ-F-854) are signed with it: a server cannot loosen them.
  // 전부 허용 asked for at the start is signed with it (REQ-F-860): the page cannot sign a set for a sid it does not know yet.
  new: { i: ['cwd', 'promptH', 'model', 'effort', 'mode', 'create', 'account', 'chrome', 'autoPush', 'runner', 'codexMode', 'autoAllow', 'allowAll', 'root'], keep: ['sid', 'prompt'] },
  open: { i: ['sid', 'model', 'effort', 'mode'], keep: [] },
  // 실행기 전환 (REQ-F-891): the runner, Codex's sandbox and approval, and 전부 허용 are signed: a server cannot switch a
  // session to another program, or loosen what was picked.
  switch: { i: ['sid', 'runner', 'codexMode', 'autoAllow', 'allowAll'], keep: [] },
  // 맥의 대화 가져오기: the conversation and its folder are signed; the Mac opens it only when its transcript was
  // written in that folder (agent.mjs adopt). The server's sysPrompt·routing are dropped, as for new.
  // A codex conversation names its runner, signed too (REQ-F-853).
  adopt: { i: ['conv', 'cwd', 'runner', 'codexMode'], keep: ['sid'] },
  send: { i: ['sid', 'textH', 'imgs'], keep: ['text', 'files', 'id'] },
  sendnow: { i: ['sid'] },
  esc: { i: ['sid'] },
  close: { i: ['sid'] },
  forget: { i: ['sid'] },
  trash: { i: ['sid'] },
  trimlog: { i: ['sid'] },
  dropheld: { i: ['sid', 'id'] },
  retract: { i: ['sid', 'quotedM', 'kid'] },
  answer: { i: ['sid', 'card', 'n'] },
  key: { i: ['sid', 'keys', 'card'] },
  set: { i: ['sid', 'autoPush', 'autoAllow', 'allowAll'] },
  setting: { i: ['sid', 'kind', 'value'] },
  refresh: { i: ['sid', 'when'] },
  fork: { i: ['sid'], keep: ['newSid', 'copyLog'] },
  lightfork: { i: ['sid', 'mode'], keep: ['newSid'] },
  btw: { i: ['sid', 'textH'], keep: ['text'] },
  killserver: { i: ['sid', 'port'] },
  // 스냅샷 (REQ-F-881, 1.469): the address is the one the person's device signed, so a server cannot name what this
  // Mac's browser (signed in where the person is) opens.
  snapshot: { i: ['sid', 'url'] },
  background: { i: ['on', 'proxy'], keep: ['login'] },
  heal: { i: ['action'] },
  awake: { i: ['idle', 'lid'] },
  compact: { i: ['window'] },
  updatePolicy: { i: ['mode', 'from', 'to', 'skipBusy'] },
  updateNow: { i: [] },
  // 정비 재부팅 (REQ-F-884): the policy like updatePolicy. Restarting the Mac itself cannot be undone and stops every
  // session on it: never without a paired device's signature, in warn too (like removing a device).
  rebootPolicy: { i: ['on', 'day', 'from', 'to', 'minClones', 'minFreeGB', 'failMin'] },
  rebootNow: { i: [], always: true },
  // 세션 정리 (REQ-F-839): the timed batch only reports while trust is on (agent.mjs tidyRun); what a person picks is signed.
  tidyRun: 'free',
  tidyStop: { i: ['sids'], keep: ['holds', 'rest'] },
  tidyTrash: { i: ['items'] },
  // 로컬 어댑터 (REQ-F-893): its input and result are not sealed and a write acts outside this Mac, so while the
  // Mac does not trust the server (enforce) it is refused; warn runs it with a warning.
  adapter: 'off',
  // by op
  // 깊게 찾기 (REQ-F-885, 9): probe only measures; clones and docker remove things, so they are signed like clean.
  // 공유 디스크만 보기 (REQ-F-888, 10): shared only measures the one path the server names, like info.
  disk: { ops: { info: 'free', shared: 'free', scan: 'free', worktrees: 'free', probe: 'free', prune: { i: ['op', 'id', 'path', 'paths'] }, clean: { i: ['op', 'id', 'path', 'paths'] }, trash: { i: ['op', 'id', 'path', 'paths'] }, clones: { i: ['op', 'id', 'path', 'paths'] }, docker: { i: ['op', 'id', 'path', 'paths'] } } },
  account: { ops: { list: 'free' }, other: 'off' },
  trust: { ops: { info: 'free', pair1: 'free', pair3: 'free', pair4: 'free', keys: 'free', remove: { i: ['op', 'id'], always: true } } },
}
/** What a command is: 'free', 'off', or its {i, keep} rule. */
export function classOf(cmd) {
  const c = TRUST_CLASS[cmd?.t]
  if (!c) return 'off'
  if (c.ops) return c.ops[cmd.op] ?? c.other ?? 'off'
  return c
}

// ---------- the Mac's side ----------

const readJson = (p, fb) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return fb
  }
}
const writeJson = (p, v) => {
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(v, null, 2), { mode: 0o600 })
  fs.renameSync(`${p}.tmp`, p)
}
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, 64) || '이름 없는 기기'

export const trustPaths = (stateDir) => {
  const dir = path.join(stateDir, 'trust')
  return { dir, host: path.join(dir, 'host-key.json'), keys: path.join(dir, 'content-keys.json'), devices: path.join(dir, 'devices.json'), replay: path.join(dir, 'replay.json'), window: path.join(dir, 'pair-window.json'), pending: path.join(dir, 'pending.json'), confirm: path.join(dir, 'confirm.json'), audit: path.join(dir, 'audit.log'), prompt: path.join(dir, 'prompt.txt') }
}

/** The mode in agent.json: a Mac with paired devices and no (or an unknown) mode is in enforce (§3). */
export function modeOf(config, devicesCount) {
  const m = config?.trust
  if (MODES.includes(m)) return m
  return devicesCount > 0 ? 'enforce' : 'off'
}

export class Trust {
  constructor({ stateDir, hostId, now = () => Date.now() }) {
    this.p = trustPaths(stateDir)
    this.hostId = hostId
    this.now = now
    this.pairs = new Map() // pid → pairing in progress
    this.recent = [] // times pair1 was taken
  }
  ensure() {
    fs.mkdirSync(this.p.dir, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(this.p.dir, 0o700)
    } catch {}
    if (!fs.existsSync(this.p.host)) {
      const e = crypto.createECDH('prime256v1')
      e.generateKeys()
      writeJson(this.p.host, { priv: b64u(e.getPrivateKey()), pub: b64u(e.getPublicKey()) })
    }
    if (!fs.existsSync(this.p.keys)) writeJson(this.p.keys, { current: newKid(), keys: {} })
    const k = readJson(this.p.keys, null)
    if (k && !k.keys[k.current]) (k.keys[k.current] = b64u(crypto.randomBytes(32))), writeJson(this.p.keys, k)
  }
  hostKey() {
    this.ensure()
    const h = readJson(this.p.host, null)
    const e = crypto.createECDH('prime256v1')
    e.setPrivateKey(unb64u(h.priv))
    return { ecdh: e, pub: h.pub }
  }
  fingerprint() {
    return b64u(sha256(unb64u(this.hostKey().pub))).slice(0, 16)
  }
  devices() {
    const d = readJson(this.p.devices, [])
    return Array.isArray(d) ? d.filter((x) => x && typeof x.id === 'string' && ecPublicKey(x.spub) && ecPublicKey(x.dpub)) : []
  }
  device(id) {
    return this.devices().find((d) => d.id === id) ?? null
  }
  contentKeys() {
    if (!fs.existsSync(this.p.keys)) return null
    return readJson(this.p.keys, null)
  }
  keyOf(kid) {
    const k = this.contentKeys()?.keys?.[kid]
    return k ? unb64u(k) : null
  }
  /** Sealing is on while there is a mode and someone to read what is sealed. */
  sealing(mode) {
    return mode !== 'off' && this.devices().length > 0
  }
  seal(text, dir, sid) {
    const k = this.contentKeys()
    if (!k) return String(text)
    return sealWith(unb64u(k.keys[k.current]), k.current, this.hostId, text, dir, sid)
  }
  /** A whole string from the page: its pieces opened (only those sealed by a device: 'u'), the rest as it is. */
  openText(s, sid) {
    if (!hasSeal(s)) return s
    let bad = false
    const out = String(s).replace(SEAL_RE, (piece) => {
      const o = openWith((kid) => this.keyOf(kid), this.hostId, piece)
      if (!o || o.d !== 'u' || (sid && o.s && o.s !== sid)) return ((bad = true), '')
      return o.v
    })
    return bad ? null : out
  }
  /** seal: whether `trust seal on` was chosen; what is reported is whether sealing really happens. */
  info(mode, seal = false) {
    return { mode, version: TRUST_VERSION, seal: !!seal && this.sealing(mode), fp: fs.existsSync(this.p.host) ? this.fingerprint() : '', devices: this.devices().map((d) => ({ id: d.id, name: d.name, at: d.at, used: d.used ?? 0 })), window: this.windowOpen() }
  }
  /** One reading of the key in use, for sealing a whole message (a line has many strings). */
  sealer(dir = 'm') {
    const k = this.contentKeys()
    if (!k?.keys?.[k.current]) return null
    const key = unb64u(k.keys[k.current])
    return (text, sid) => sealWith(key, k.current, this.hostId, text, dir, sid)
  }
  windowOpen() {
    const w = readJson(this.p.window, null)
    return !!w && Number(w.until) > this.now()
  }
  audit(line) {
    try {
      this.ensure()
      fs.appendFileSync(this.p.audit, `${new Date(this.now()).toISOString()} ${line.replace(/[\r\n]+/g, ' ').slice(0, 500)}\n`, { mode: 0o600 })
    } catch {}
  }

  // ---- pairing (§4.2) ----
  pair1({ c }, mode) {
    if (mode === 'off') throw new Error('이 맥은 짝짓기를 받지 않아요 (trust 가 off). 맥에서 trust 모드를 켜 주세요')
    if (!this.windowOpen()) throw new Error('맥에서 짝짓기 창이 열려 있지 않아요. 맥 터미널에서 `node ~/.claude-bridge/agent.mjs trust pair` 를 먼저 실행하세요')
    if (typeof c !== 'string' || unb64u(c).length !== 32) throw new Error('짝짓기 요청이 올바르지 않아요')
    this.sweep()
    if ([...this.pairs.values()].some((x) => !x.done)) throw new Error('다른 짝짓기가 진행 중이에요. 잠시 뒤 다시 하세요')
    if (this.devices().length >= MAX_DEVICES) throw new Error(`짝지은 기기가 ${MAX_DEVICES}개예요. 맥에서 먼저 해제하세요`)
    this.ensure()
    const pid = b64u(crypto.randomBytes(16))
    const na = b64u(crypto.randomBytes(32))
    this.pairs.set(pid, { c, na, at: this.now() })
    return { pid, apub: this.hostKey().pub, na, hostId: this.hostId }
  }
  pair3({ pid, spub, dpub, nb, name }) {
    this.sweep()
    const x = this.pairs.get(pid)
    if (!x || x.sas) throw new Error('짝짓기가 만료됐어요. 처음부터 다시 하세요')
    if (!ecPublicKey(spub) || !ecPublicKey(dpub) || unb64u(nb).length !== 32 || pairCommit(spub, dpub, nb) !== x.c) {
      this.pairs.delete(pid)
      throw new Error('짝짓기 값이 약속과 달라요. 처음부터 다시 하세요')
    }
    const apub = this.hostKey().pub
    Object.assign(x, { spub, dpub, nb, name: cleanName(name), id: deviceIdOf(spub, dpub), sas: pairSas(this.hostId, apub, spub, dpub, x.na, nb) })
    writeJson(this.p.pending, { pid, sas: x.sas, name: x.name, id: x.id, until: x.at + PAIR_TTL_MS })
    return { sas: x.sas }
  }
  /** Called while a pairing waits: the terminal's yes (trust/confirm.json) completes it. */
  checkConfirm() {
    const c = readJson(this.p.confirm, null)
    if (!c) return
    fs.rmSync(this.p.confirm, { force: true })
    const x = this.pairs.get(c.pid)
    if (!x || !x.sas || x.done) return
    // A refusal or a number that does not match ends this pairing: it is not tried again with another number.
    if (c.no || c.sas !== x.sas) return ((x.done = 'no'), fs.rmSync(this.p.pending, { force: true }), this.audit(`pairing refused ${x.id}`))
    const list = this.devices().filter((d) => d.id !== x.id)
    list.push({ id: x.id, name: x.name, spub: x.spub, dpub: x.dpub, at: this.now() })
    writeJson(this.p.devices, list)
    x.done = 'ok'
    fs.rmSync(this.p.pending, { force: true })
    fs.rmSync(this.p.window, { force: true })
    this.audit(`paired ${x.id} "${x.name}"`)
  }
  pair4({ pid }) {
    this.checkConfirm()
    const x = this.pairs.get(pid)
    if (!x) return { state: 'no' }
    if (x.done === 'no') return (this.pairs.delete(pid), { state: 'no' })
    if (x.done !== 'ok') return { state: this.now() - x.at > PAIR_TTL_MS ? 'no' : 'pending' }
    this.pairs.delete(pid)
    const salt = b64u(Buffer.concat([unb64u(x.na), unb64u(x.nb)]))
    return { state: 'ok', ...this.wrapFor(x.id, salt), fp: this.fingerprint() }
  }
  /** K (every kid this device may use) for one device, readable only with that device's ECDH key. */
  wrapFor(id, salt = b64u(crypto.randomBytes(32))) {
    const d = this.device(id)
    const k = this.contentKeys()
    if (!d || !k) return { kid: '', keys: [] }
    const secret = this.hostKey().ecdh.computeSecret(unb64u(d.dpub))
    const wk = wrapKey(secret, salt, this.hostId)
    const since = d.at ?? 0
    // A device gets the key in use and the ones made since it was paired, not those from before.
    const kids = Object.keys(k.keys).filter((kid) => kid === k.current || (k.made?.[kid] ?? 0) >= since)
    return { kid: k.current, salt, keys: kids.map((kid) => ({ kid, wrap: gcmSeal(wk, unb64u(k.keys[kid]), `bt-wrap|${this.hostId}|${kid}`) })) }
  }
  sweep() {
    const t = this.now()
    for (const [pid, x] of this.pairs) if (t - x.at > PAIR_TTL_MS + 60_000) this.pairs.delete(pid)
    const p = readJson(this.p.pending, null)
    if (p && Number(p.until) < t) fs.rmSync(this.p.pending, { force: true })
  }
  /** Forget a device, and seal from now on with a key it never had (§4.3). */
  remove(id) {
    const list = this.devices()
    if (!list.some((d) => d.id === id)) return false
    writeJson(this.p.devices, list.filter((d) => d.id !== id))
    const k = this.contentKeys() ?? { keys: {} }
    const kid = newKid()
    k.keys[kid] = b64u(crypto.randomBytes(32))
    k.made = { ...(k.made ?? {}), [kid]: this.now() }
    k.current = kid
    writeJson(this.p.keys, k)
    for (const pid of [...this.pairs.keys()]) this.pairs.delete(pid)
    this.audit(`removed ${id}`)
    return true
  }

  // ---- signed commands (§5) ----
  /**
   * Whether cmd carries a good signature from a paired device. Returns {ok, why, dev, i}. On ok the number is
   * written down before anything runs, so the same signature is never taken twice.
   */
  verify(cmd) {
    const a = cmd?.auth
    if (!a || typeof a.p !== 'string' || typeof a.s !== 'string' || a.p.length > 4096) return { ok: false, why: '서명 없음' }
    let p
    try {
      p = JSON.parse(a.p)
    } catch {
      return { ok: false, why: '서명 형식' }
    }
    if (p?.v !== 1 || p.h !== this.hostId) return { ok: false, why: '다른 맥의 서명' }
    if (p.t !== cmd.t || (cmd.op !== undefined && p.i?.op !== cmd.op)) return { ok: false, why: '다른 명령의 서명' }
    const dev = this.device(p.d)
    if (!dev) return { ok: false, why: '짝짓지 않은 기기' }
    const key = ecPublicKey(dev.spub)
    const sig = unb64u(a.s)
    let good = false
    try {
      good = sig.length === 64 && crypto.verify('sha256', Buffer.from(a.p, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, sig)
    } catch {}
    if (!good) return { ok: false, why: '서명이 맞지 않음' }
    const t = this.now()
    if (!Number.isFinite(p.ts) || Math.abs(t - p.ts) > SKEW_MS) return { ok: false, why: `시각이 ${Math.round((t - p.ts) / 1000)}초 어긋남` }
    if (!Number.isSafeInteger(p.n) || p.n <= 0) return { ok: false, why: '일련번호 형식' }
    const r = readJson(this.p.replay, {})
    const mine = r[p.d] ?? { floor: 0, seen: {} }
    for (const [n, at] of Object.entries(mine.seen)) if (t - at > SKEW_MS * 2) ((mine.floor = Math.max(mine.floor, Number(n))), delete mine.seen[n])
    if (p.n <= mine.floor || mine.seen[p.n]) return { ok: false, why: '이미 쓴 서명' }
    mine.seen[p.n] = t
    r[p.d] = mine
    writeJson(this.p.replay, r)
    const list = this.devices()
    const me = list.find((d) => d.id === p.d)
    if (me && t - (me.used ?? 0) > 60_000) ((me.used = t), writeJson(this.p.devices, list))
    return { ok: true, dev, i: p.i && typeof p.i === 'object' ? p.i : {} }
  }
}
const newKid = () => crypto.randomBytes(4).toString('hex')

/** Rebuild a command from its rule: {t, reqId} + the kept server fields + what was signed. */
export function rebuild(cmd, rule, i) {
  const out = { t: cmd.t, ...(cmd.reqId ? { reqId: cmd.reqId } : {}) }
  for (const k of rule.keep ?? []) if (cmd[k] !== undefined) out[k] = cmd[k]
  for (const k of rule.i ?? []) if (i[k] !== undefined) out[k] = i[k]
  return out
}

/** The hashes a signature binds, against what came: {field: hashField}. */
export const HASHED = { send: { text: 'textH' }, btw: { text: 'textH' }, new: { prompt: 'promptH' } }
export function hashesHold(cmd, i) {
  for (const [f, h] of Object.entries(HASHED[cmd.t] ?? {})) {
    const v = cmd[f] ?? ''
    if ((i[h] ?? sha256Hex('')) !== sha256Hex(v)) return false
  }
  if (cmd.t === 'send') {
    const want = Array.isArray(i.imgs) ? i.imgs : []
    const files = Array.isArray(cmd.files) ? cmd.files : []
    if (files.length !== want.length) return false
    for (const [k, f] of files.entries()) {
      const id = String(f?.id ?? '')
      const sum = crypto.createHash('sha1').update(Buffer.from(String(f?.data ?? ''), 'base64')).digest('hex')
      if (id !== want[k] || !id.startsWith(`${sum}.`)) return false
    }
  }
  return true
}

/** HMAC of a text under the content key in use: what the page binds when it names a text it said (retract). */
export function textMac(key, text) {
  return crypto.createHmac('sha256', key).update(Buffer.from(String(text ?? ''), 'utf8')).digest('base64url')
}

/** Whether an update may replace this agent while trust is on (§5.7): it must carry trust.mjs, not older, at a newer seq. */
export function updateKeepsTrust(files, seq, floor) {
  const t = files?.['trust.mjs']
  if (typeof t !== 'string') return 'trust.mjs 가 없는 버전'
  const v = Number(/export const TRUST_VERSION = (\d+)/.exec(t)?.[1] ?? 0)
  if (v < TRUST_VERSION) return `trust 판이 낮은 버전(${v} < ${TRUST_VERSION})`
  if (!(Number(seq) > Math.max(floor ?? 0, TRUST_MIN_SEQ))) return `서명 순번이 낮은 버전(${seq})`
  return null
}

// ---------- what leaves the Mac, sealed (§6, 1.394) ----------

/** Sealing is a second choice made at the terminal (`trust seal on`): off unless agent.json says `trustSeal: true`. */
export const sealChosen = (config) => config?.trustSeal === true

/** The text the page sends for 압축 (server/live.go COMPACT_TEXT): the server compares it as it is. */
const COMPACT_TEXT = '/compact 이어서 할 수 있게 지금까지의 결정과 이유, 관련 파일, 진행 상황, 다음에 할 일을 남겨 주세요'
/** What the bridge itself types into a session (server/eventlog.go bridgeTypedRe): the server reads the start. */
const BRIDGE_TYPED_RE = /^(\[정정\] |\[새로고침\] |\[이전 대화에서 이어감 |지금까지의 대화를 이어받을 다음 세션이 읽을 SESSION\.md|Write SESSION\.md in the working folder now|Continue the work described in this handover)/
/** The wrapping tags the server reads in a person's line (server/events.go ENVELOPE_RE, and summary·status). */
const TAG_NAMES = 'channel|task-notification|system-reminder|agent-message|local-command-[a-z-]+|command-name|command-message|command-args|bash-input|bash-stdout|bash-stderr|summary|status'
const PLAIN_BITS = new RegExp(`<\\/?(?:${TAG_NAMES})(?:\\s[^>]*)?>|^\\[Request interrupted by user(?: for tool use)?\\]$|\\[Image attached: [^\\]\\n]*\\]|\\[Image #\\d+\\]`, 'gim')

/** A person's text: the server's tags and markers stay as they are, every other run of text is sealed (§6.2). */
export function sealPersonText(text, seal) {
  const t = String(text)
  if (t === COMPACT_TEXT) return t
  const pre = BRIDGE_TYPED_RE.exec(t)?.[0] ?? ''
  const rest = t.slice(pre.length)
  const piece = (x) => (/\S/.test(x) ? seal(x) : x)
  let out = pre
  let last = 0
  for (const m of rest.matchAll(PLAIN_BITS)) {
    out += piece(rest.slice(last, m.index))
    const tag = /^<(\/?)([a-z-]+)(\s[^>]*)?>$/i.exec(m[0])
    out += tag && tag[3]?.trim() ? `<${tag[1]}${tag[2]} ${seal(tag[3].trim())}>` : m[0]
    last = m.index + m[0].length
  }
  return out + piece(rest.slice(last))
}

const TOP_PLAIN = new Set(['type', 'subtype', 'uuid', 'parentUuid', 'sessionId', 'timestamp', 'version', 'cwd', 'gitBranch', 'isSidechain', 'isMeta', 'userType', 'requestId', 'level', 'toolUseID', 'logicalParentUuid', 'promptId'])
const MSG_PLAIN = new Set(['role', 'model', 'id', 'stop_reason', 'type'])
const PART_PLAIN = new Set(['type', 'id', 'name', 'tool_use_id', 'is_error', 'media_type'])
/** Whether the string at this path of a transcript line stays plain: only the structure the server reads (§6.2). */
function plainPath(p) {
  const k = p[p.length - 1]
  if (p.length === 1) return TOP_PLAIN.has(k)
  if (p[0] === 'message' && p.length === 2) return MSG_PLAIN.has(k)
  // Pictures stay plain: the server shows them by asking the Mac (img), which it could not do with sealed bytes (R5).
  if (p[p.length - 2] === 'source') return k === 'type' || k === 'media_type' || k === 'data'
  if (p.includes('content') && typeof p[p.length - 2] === 'number' && PART_PLAIN.has(k)) return true
  if (p.includes('todos') && k === 'status') return true
  if (p[0] === 'attachment' && (k === 'type' || p.includes('addedNames'))) return p.length === 2 || p.includes('addedNames')
  return false
}

/** What a person said in a line, plain (for bridgeEcho), or null when the line is not a person's words. */
function personText(o) {
  if (o?.type !== 'user' || o?.message?.role !== 'user') return null
  const c = o.message.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c) || c.some((x) => x?.type === 'tool_result')) return null
  return c.filter((x) => x?.type === 'text').map((x) => x.text).join('\n')
}

/**
 * One transcript line with its words sealed and its structure plain. isEcho(text) says whether the person's text
 * is what this Mac just typed from the page: such a line gets "bridgeEcho": true, since the server can no longer
 * compare the words (eventlog.go isEcho).
 */
// ---------- 조용한 답 (REQ-F-850) ----------
// The same test as server/quiet.go and ui/src/lib/quiet.ts (cases in server/testdata/quiet-cases.json). A sealing
// Mac runs it on the words the server cannot read and marks the line ("bridgeQuiet": <extension id>), plain.

/** The first rule whose end the answer has (end spaces, tabs and newlines ignored), or null. */
export function quietOf(text, rules) {
  if (typeof text !== 'string' || !text || text.includes('⟦bt1:')) return null
  const t = text.replace(/[ \t\r\n]+$/, '')
  if (!t) return null
  for (const r of rules ?? []) if (r?.suffix && t.endsWith(r.suffix)) return r
  return null
}
/** quietSuffixOk in server/quiet.go: 1-40 characters on one line, nothing around to trim, no control character or seal bracket. */
export function quietSuffixOk(s) {
  if (typeof s !== 'string') return false
  const n = [...s].length
  return n >= 1 && n <= 40 && s.trim() === s && !/[\u0000-\u001f\u007f-\u009f⟦⟧]/.test(s)
}
/**
 * The ends chosen at this Mac's terminal (`trust quiet add`, agent.json `trustQuiet`), as rules marked "mac". Never
 * the server's: a server choosing the ends could learn, one plain mark at a time, how sealed answers end.
 */
export function quietChosen(config) {
  const out = []
  for (const x of Array.isArray(config?.trustQuiet) ? config.trustQuiet : []) {
    if (out.length >= QUIET_MAC_MAX) break
    if (quietSuffixOk(x) && !out.some((r) => r.suffix === x)) out.push({ ext: 'mac', suffix: x })
  }
  return out
}
export const QUIET_MAC_MAX = 5

/** Claude's answer words in a transcript line (each text block), or [] when the line is not an answer. */
function answerTexts(o) {
  if (o?.type !== 'assistant' || !Array.isArray(o?.message?.content)) return []
  return o.message.content.filter((x) => x?.type === 'text' && typeof x.text === 'string').map((x) => x.text)
}

export function sealLine(line, seal, isEcho = () => false, quiet = []) {
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return line.trim() ? seal(line) : line
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return line
  const said = personText(o)
  const person = o.type === 'user' && o.message?.role === 'user'
  const walk = (v, p) => {
    if (typeof v === 'string') {
      if (!v || hasSeal(v) || plainPath(p)) return v
      const words = person && p[0] === 'message' && p[1] === 'content' && (p.length === 2 || p[p.length - 1] === 'text')
      return words ? sealPersonText(v, seal) : seal(v)
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, [...p, i]))
    if (v && typeof v === 'object') {
      const out = {}
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, [...p, k])
      return out
    }
    return v
  }
  const out = walk(o, [])
  if (said != null && said.trim() && isEcho(said)) out.bridgeEcho = true
  if (quiet.length) {
    const hit = answerTexts(o).map((t) => quietOf(t, quiet)).find(Boolean)
    if (hit) out.bridgeQuiet = hit.ext
  }
  return JSON.stringify(out)
}

// Keys whose strings are structure, not words, in the replies sealed field by field below.
const STRUCT = new Set(['t', 'sid', 'reqId', 'id', 'kind', 'type', 'state', 'status', 'code', 'ok', 'tone', 'level', 'number', 'sha', 'branch', 'head', 'base', 'url', 'repo', 'at'])
function sealDeep(v, seal, key = '') {
  if (typeof v === 'string') return !v || hasSeal(v) || STRUCT.has(key) ? v : seal(v)
  if (Array.isArray(v)) return v.map((x) => sealDeep(x, seal, key))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sealDeep(x, seal, k)]))
  return v
}

/** The card a person answers, as one sealed piece holding its id: the server can neither change nor move a choice (§6.4). */
const CARD_PLAIN = new Set(['id', 'kind', 'open', 'auto', 'at', 'result'])
export function sealCard(card, seal) {
  if (!card || typeof card !== 'object') return card
  const words = Object.fromEntries(Object.entries(card).filter(([k]) => !CARD_PLAIN.has(k)))
  if (!Object.keys(words).length) return card
  const out = { ...Object.fromEntries(Object.entries(card).filter(([k]) => CARD_PLAIN.has(k))), sealed: seal(JSON.stringify({ ...words, id: card.id })) }
  // What the server sees in place of the words: the shape it counts (how many choices), never the words.
  if (Array.isArray(card.options)) out.options = card.options.map((o) => (o && typeof o === 'object' ? { n: o.n, label: '🔒' } : '🔒'))
  if (typeof card.title === 'string') out.title = '🔒'
  if (typeof card.result === 'string') out.result = card.result
  return out
}

/**
 * A message the agent sends, its words sealed (§6.2). `lines` are sealed where they are read (sealLine), pictures
 * stay plain (R5). seal(text, sid) makes one piece. The message is copied, never changed in place.
 */
export function sealOut(msg, seal) {
  if (!msg || typeof msg !== 'object') return msg
  const sid = typeof msg.sid === 'string' ? msg.sid : ''
  const S = (v) => (typeof v === 'string' && v && !hasSeal(v) ? seal(v, sid) : v)
  const d = (v) => sealDeep(v, (x) => seal(x, sid))
  const m = { ...msg }
  switch (m.t) {
    case 'screen':
    case 'preview':
    case 'note':
    case 'toast':
      m.text = S(m.text)
      break
    case 'error':
      m.message = S(m.message)
      m.error = S(m.error)
      break
    case 'status':
      if (Array.isArray(m.held)) m.held = m.held.map((h) => (h && typeof h === 'object' ? { ...h, text: S(h.text) } : S(h)))
      if (m.tool && typeof m.tool === 'object') m.tool = { ...m.tool, title: S(m.tool.title) }
      if (Array.isArray(m.running)) m.running = m.running.map((r) => (typeof r === 'string' ? S(r) : r && typeof r === 'object' ? { ...r, label: S(r.label), title: S(r.title) } : r))
      if (Array.isArray(m.servers)) m.servers = m.servers.map((x) => (x && typeof x === 'object' ? { ...x, title: S(x.title) } : x))
      break
    case 'card':
      m.card = sealCard(m.card, (x) => seal(x, sid))
      break
    case 'btw':
      m.answer = S(m.answer)
      m.error = S(m.error)
      break
    case 'file':
      m.content = S(m.content)
      m.name = S(m.name)
      m.path = S(m.path)
      break
    case 'attachment':
      // One piece holding the id, the session and the type with the bytes: the page checks the id it asked for.
      if (typeof m.data === 'string') {
        m.sealed = S(JSON.stringify({ kind: 'attach', id: m.id, sid, name: m.name, type: m.type, size: m.size, data: m.data }))
        delete m.name
        delete m.type
        delete m.data
      }
      if (m.error !== undefined) m.error = S(m.error)
      break
    case 'convread':
      if (m.text !== undefined) m.text = S(m.text)
      if (m.error !== undefined) m.error = S(m.error)
      break
    case 'voice':
      m.text = S(m.text)
      break
    case 'snapshot':
      // 스냅샷 (1.469): the page, its address and its pictures in one piece bound to the session; the screen reads it.
      if (typeof m.html === 'string') {
        m.sealed = S(JSON.stringify({ kind: 'snapshot', sid, url: m.url, html: m.html, images: m.images ?? {}, css: m.css ?? {}, width: m.width ?? 0, via: m.via }))
        delete m.url
        delete m.html
        delete m.images
        delete m.css
      }
      if (m.error !== undefined) m.error = S(m.error)
      break
    case 'recent':
      // bound (1.412): the conversation id, its folder and the words the person picks it by, in one piece, so a server
      // cannot show one conversation's title on another's id or folder (the page uses only what this piece says).
      if (Array.isArray(m.conversations)) m.conversations = m.conversations.map((c) => (c && typeof c === 'object' ? { ...c, title: S(c.title), first: S(c.first), last: S(c.last), bound: S(JSON.stringify({ conv: c.conv, cwd: c.cwd, title: c.title ?? '', first: c.first ?? '', ...(c.runner ? { runner: c.runner } : {}) })) } : c))
      break
    case 'folder':
    case 'flushed':
      if (m.folder) m.folder = d(m.folder)
      break
    case 'prsearch':
    case 'prstates':
      for (const k of Object.keys(m)) if (!STRUCT.has(k)) m[k] = d(m[k])
      break
    case 'stats':
      if (m.prs) m.prs = d(m.prs)
      break
    case 'logs':
      if (Array.isArray(m.entries)) m.entries = m.entries.map((e) => (e && typeof e === 'object' ? { ...e, text: S(e.text) } : e))
      break
  }
  return m
}

// ---------- the terminal (`node ~/.claude-bridge/agent.mjs trust …`) ----------

const HELP = `trust: 서버를 믿지 않는 맥 (docs/TRUST-DESIGN.md)
  trust                 지금 모드와 짝지은 기기
  trust mode <off|warn|enforce>
  trust seal <on|off>   대화·화면 내용을 짝지은 기기만 풀 수 있게 봉인해 내보냄(기본 off)
  trust quiet [add|rm <끝 글자>]  봉인한 답 중 이 글자로 끝나는 답을 조용한 답으로 표시(새 답·알림 없음, 5개까지)
  trust pair            5분 동안 짝짓기를 받고, 기기 화면의 6자리 숫자를 여기 입력해 확인
  trust devices         짝지은 기기
  trust remove <id>     기기 해제(앞으로의 봉인 키도 바뀜)
  trust log             서명·거부 기록(최근 50줄)
  trust prompt          이 맥의 세션 기본 프롬프트 파일 위치(계정 기본 프롬프트 대신 씀)`

/** Runs one `trust …` command at the terminal; resolves the exit code. ask(q) reads a line. */
export async function trustCli(words, { stateDir, configPath, hostId, ask, out = console.log }) {
  const t = new Trust({ stateDir, hostId })
  const cfg = () => readJson(configPath, {})
  const show = () => {
    const d = t.devices()
    out(`모드: ${modeOf(cfg(), d.length)}${cfg().trust ? '' : ' (agent.json 에 trust 칸 없음)'} · 봉인 ${sealChosen(cfg()) ? 'on' : 'off'}`)
    out(d.length ? d.map((x) => `  ${x.id}  ${x.name}  짝지은 때 ${new Date(x.at).toLocaleString()}${x.used ? ` · 마지막 서명 ${new Date(x.used).toLocaleString()}` : ''}`).join('\n') : '  짝지은 기기 없음')
    if (fs.existsSync(t.p.host)) out(`맥 키 지문: ${t.fingerprint()}`)
  }
  const [cmd, arg] = words
  if (!cmd) return (show(), 0)
  if (cmd === 'help') return (out(HELP), 0)
  if (cmd === 'devices') return (show(), 0)
  if (cmd === 'prompt') {
    t.ensure()
    out(`${t.p.prompt}\n이 파일이 있으면 trust 모드에서 새로 띄우는 세션이 이 글을 기본 프롬프트로 씁니다(없으면 기본 문구).`)
    return 0
  }
  if (cmd === 'log') {
    try {
      out(fs.readFileSync(t.p.audit, 'utf8').trim().split('\n').slice(-50).join('\n'))
    } catch {
      out('기록 없음')
    }
    return 0
  }
  if (cmd === 'mode') {
    if (!MODES.includes(arg)) return (out('trust mode off|warn|enforce'), 1)
    const c = cfg()
    c.trust = arg
    writeJson(configPath, c)
    t.ensure()
    out(`모드를 ${arg} 로 바꿨어요. 에이전트가 2초 안에 읽어요.`)
    if (arg === 'enforce') out('이제 짝지은 기기가 서명한 명령만 실행해요. 이 맥은 다시 설치(curl … | bash)하지 마세요: 서버가 준 파일을 그대로 깔게 됩니다.')
    if (arg !== 'off' && !t.devices().length) out('아직 짝지은 기기가 없어요: `trust pair` 로 짝지으세요.')
    return 0
  }
  if (cmd === 'seal') {
    if (arg !== 'on' && arg !== 'off') return (out(`trust seal on|off (지금 ${sealChosen(cfg()) ? 'on' : 'off'})`), 1)
    const c = cfg()
    c.trustSeal = arg === 'on'
    writeJson(configPath, c)
    out(arg === 'on' ? '봉인을 켰어요. 모드가 off 가 아니고 짝지은 기기가 있으면, 대화·화면·카드 내용을 짝지은 기기만 풀 수 있게 봉인해 내보내요(그림은 평문). 알림·Slack 에는 내용이 가지 않아요.' : '봉인을 껐어요. 이제 내용을 평문으로 내보내요.')
    if (arg === 'on' && modeOf(c, t.devices().length) === 'off') out('지금 모드가 off 라 봉인하지 않아요: `trust mode warn` 또는 `trust mode enforce`.')
    return 0
  }
  if (cmd === 'quiet') {
    const c = cfg()
    const now = quietChosen(c).map((r) => r.suffix)
    if (!arg) {
      out(now.length ? `조용한 답의 끝 글자(봉인 중에만 씀):\n${now.map((x) => `  ${x}`).join('\n')}` : '조용한 답의 끝 글자가 없어요: `trust quiet add "[조용히]"`')
      return 0
    }
    const [op, ...rest] = [arg, ...words.slice(2)]
    const word = rest.join(' ')
    if ((op !== 'add' && op !== 'rm') || !word) return (out('trust quiet add|rm <끝 글자>'), 1)
    if (op === 'add') {
      if (!quietSuffixOk(word)) return (out('끝 글자는 앞뒤 공백·제어 문자·⟦⟧ 없는 한 줄 1~40자예요'), 1)
      if (now.includes(word)) return (out(`이미 있어요: ${word}`), 0)
      if (now.length >= QUIET_MAC_MAX) return (out(`${QUIET_MAC_MAX}개까지예요. 먼저 \`trust quiet rm\` 으로 빼세요`), 1)
      c.trustQuiet = [...now, word]
    } else {
      if (!now.includes(word)) return (out(`그런 끝 글자가 없어요: ${word}`), 1)
      c.trustQuiet = now.filter((x) => x !== word)
    }
    writeJson(configPath, c)
    out(op === 'add' ? `더했어요: 봉인한 답이 "${word}" 로 끝나면 조용한 답으로 표시해요(서버는 표시만 보고 글은 못 봐요). 에이전트가 2초 안에 읽어요.` : `뺐어요: ${word}`)
    return 0
  }
  if (cmd === 'remove') {
    if (!arg) return (out('trust remove <기기 id>'), 1)
    const ok = t.remove(arg)
    out(ok ? `해제했어요: ${arg}. 앞으로의 내용은 새 키로 봉인해요.` : `그런 기기가 없어요: ${arg}`)
    return ok ? 0 : 1
  }
  if (cmd === 'pair') {
    if (modeOf(cfg(), t.devices().length) === 'off') return (out('trust 모드가 off 예요. 먼저 `trust mode warn` 또는 `trust mode enforce`.'), 1)
    t.ensure()
    const until = Date.now() + PAIR_WINDOW_MS
    writeJson(t.p.window, { until })
    out('5분 동안 짝짓기를 받아요. 짝지을 브라우저·폰에서 설정 → 이 기기 → 맥 짝짓기를 누르세요. (그만두려면 Ctrl+C)')
    try {
      let seen = ''
      while (Date.now() < until) {
        const p = readJson(t.p.pending, null)
        if (p && p.pid !== seen && Number(p.until) > Date.now()) {
          seen = p.pid
          out(`\n기기 '${p.name}'(서버가 전달한 이름, ${p.id}) 이(가) 짝짓기를 요청했어요.`)
          let ok = false
          for (let i = 0; i < 3 && !ok; i++) {
            const typed = String(await ask('기기 화면의 6자리 숫자를 입력하세요(거절은 빈 줄): ')).replace(/\D/g, '')
            if (!typed) break
            ok = typed === p.sas
            if (!ok) out('숫자가 달라요.')
          }
          writeJson(t.p.confirm, ok ? { pid: p.pid, sas: p.sas } : { pid: p.pid, no: true })
          if (!ok) {
            // The window closes with a refusal (finally below): another try is another `trust pair`.
            out('거절하고 짝짓기 창을 닫았어요. 숫자가 계속 다르면 서버가 끼어든 것일 수 있어요. 다시 하려면 `trust pair`.')
            return 1
          }
          out(`확인 숫자 ${p.sas.slice(0, 3)} ${p.sas.slice(3)} 일치. 짝짓는 중…`)
          for (let i = 0; i < 20; i++) {
            if (t.device(p.id)) return (out(`짝지었어요: ${p.name} (${p.id})`), 0)
            await new Promise((r) => setTimeout(r, 500))
          }
          out('에이전트가 확인을 받지 못했어요. 에이전트가 돌고 있는지 보세요.')
          return 1
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      out('5분이 지나 짝짓기 창을 닫았어요.')
      return 1
    } finally {
      fs.rmSync(t.p.window, { force: true })
    }
  }
  out(HELP)
  return 1
}

// ---------- background work, counted on this Mac (server/eventlog.go trackBackgroundLine, §5.3 refresh) ----------

const BG_START = [
  [/^Command running in background with ID: (\S+?)\.?(?:\s|$)/, 'bash'],
  [/^Command [^\n]{0,120}?moved to the background \(ID: ([^)]+)\)/, 'bash'],
  [/^Monitor started \(task (\S+?),/, 'monitor'],
  [/^Async agent launched/, 'agent'],
]
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((x) => (x?.type === 'text' ? String(x.text ?? '') : '')).join('\n') : '')
const tagIn = (name, s) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s)?.[1]?.trim()

/**
 * What runs in the background of one session, from its own transcript. A server that is not trusted cannot say
 * "nothing runs" to make a reserved refresh cut work off, nor keep one waiting.
 */
export class BgTracker {
  constructor() {
    this.labels = new Map()
    this.tasks = []
  }
  line(line) {
    if (!/tool_use|tool_result|task-notification/.test(line)) return
    let o
    try {
      o = JSON.parse(line)
    } catch {
      return
    }
    const content = o?.message?.content
    if (o?.type !== 'assistant') {
      const text = typeof content === 'string' || Array.isArray(content) ? textOf(content) : typeof o?.content === 'string' ? o.content : String(o?.attachment?.prompt ?? '')
      for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
        const status = tagIn('status', m[1])
        if (!status || status === 'running') continue
        const id = tagIn('tool-use-id', m[1])
        const taskId = tagIn('task-id', m[1])
        const k = this.tasks.findIndex((t) => (id && t.toolUseId === id) || (taskId && t.id === taskId))
        if (k >= 0) this.tasks.splice(k, 1)
      }
    }
    if (!Array.isArray(content)) return
    for (const c of content) {
      if (o.type === 'assistant' && c?.type === 'tool_use') {
        const i = c.input ?? {}
        this.labels.set(String(c.id), { name: c.name, label: String(i.description ?? i.command ?? i.prompt ?? c.name ?? '').replace(/\s+/g, ' ').slice(0, 120), timeout: Number(i.timeout_ms) || 0, taskId: String(i.task_id ?? i.shell_id ?? '') })
        if (this.labels.size > 2000) this.labels.delete(this.labels.keys().next().value)
      } else if (o.type === 'user' && c?.type === 'tool_result') {
        const tag = this.labels.get(String(c.tool_use_id))
        this.labels.delete(String(c.tool_use_id))
        const body = textOf(c.content)
        if (tag?.name === 'TaskStop' || tag?.name === 'KillShell') {
          if (!c.is_error && /^Successfully stopped/.test(body.trim())) this.tasks = this.tasks.filter((t) => t.id !== tag.taskId)
          continue
        }
        const first = body.split('\n')[0].slice(0, 400)
        for (const [re, kind] of BG_START) {
          const m = re.exec(first)
          if (!m) continue
          const id = kind === 'agent' ? (/agentId: (\w+)/.exec(body)?.[1] ?? '') : m[1]
          this.tasks.push({ toolUseId: String(c.tool_use_id), id, kind, label: tag?.label ?? kind, at: Date.parse(o.timestamp) || Date.now(), ...(kind === 'monitor' ? { timeout: tag?.timeout || 300_000 } : {}) })
          if (this.tasks.length > 50) this.tasks.shift()
          break
        }
      }
    }
  }
  /** What still runs: a monitor ends by itself after its timeout. */
  running(now = Date.now()) {
    this.tasks = this.tasks.filter((t) => t.kind !== 'monitor' || now < t.at + t.timeout)
    return this.tasks
  }
}
