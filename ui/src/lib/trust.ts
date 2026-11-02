// This browser as a paired device of a Mac that does not trust the server (REQ-S-090~, docs/TRUST-DESIGN.md).
// The device's keys are made here and can never be read out (WebCrypto, extractable: false), kept in IndexedDB.
// Every request that makes a paired Mac act carries this device's signature (X-Bridge-Auth); the Mac checks it and
// rebuilds the command from what was signed, so the server cannot change or make up one.
import type { Host, Session } from './types'
import { getStore } from './store'

const DB = 'cb2-trust'
const STORE = 'kv'

/** The text the server sends for 압축 (server/live.go COMPACT_TEXT): signed as it is. */
const COMPACT_TEXT = '/compact 이어서 할 수 있게 지금까지의 결정과 이유, 관련 파일, 진행 상황, 다음에 할 일을 남겨 주세요'

interface DeviceRec {
  id: string
  spub: string
  dpub: string
  spriv: CryptoKey
  dpriv: CryptoKey
  at: number
}
interface HostRec {
  hostId: string
  fp: string
  apub: string
  kid: string
  keys: Record<string, { aes: CryptoKey; mac: CryptoKey }>
  at: number
}

// ---------- bytes ----------
const enc = new TextEncoder()
export const b64u = (b: ArrayBuffer | Uint8Array) => {
  const a = b instanceof Uint8Array ? b : new Uint8Array(b)
  let s = ''
  for (const x of a) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export const unb64u = (s: string) => {
  const t = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
  const a = new Uint8Array(t.length)
  for (let i = 0; i < t.length; i++) a[i] = t.charCodeAt(i)
  return a
}
const cat = (...parts: (string | Uint8Array)[]) => {
  const bs = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p))
  const out = new Uint8Array(bs.reduce((n, b) => n + b.length, 0))
  let o = 0
  for (const b of bs) (out.set(b, o), (o += b.length))
  return out
}
const sha256 = async (...parts: (string | Uint8Array)[]) => new Uint8Array(await crypto.subtle.digest('SHA-256', cat(...parts)))
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
export const sha256Hex = async (s: string) => hex(await sha256(s))
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n))

// ---------- storage ----------
let dbp: Promise<IDBDatabase | null> | null = null
function db(): Promise<IDBDatabase | null> {
  dbp ??= new Promise((resolve) => {
    try {
      const r = indexedDB.open(DB, 1)
      r.onupgradeneeded = () => r.result.createObjectStore(STORE)
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => resolve(null)
      r.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbp
}
async function kv<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
  const d = await db()
  if (!d) return null
  return new Promise((resolve) => {
    try {
      const r = f(d.transaction(STORE, mode).objectStore(STORE))
      r.onsuccess = () => resolve((r.result ?? null) as T | null)
      r.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}
const kget = <T>(k: string) => kv<T>('readonly', (s) => s.get(k))
const kput = (k: string, v: unknown) => kv('readwrite', (s) => s.put(v, k))
const kdel = (k: string) => kv('readwrite', (s) => s.delete(k))

// Hosts this device is paired with, kept in memory so a request is signed without waiting on storage.
const hostRecs = new Map<string, HostRec>()
let device: DeviceRec | null = null
let loaded: Promise<void> | null = null
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((f) => f())
export const onTrustChange = (f: () => void) => (listeners.add(f), () => void listeners.delete(f))

export function loadTrust() {
  loaded ??= (async () => {
    device = await kget<DeviceRec>('device')
    const ids = (await kget<string[]>('hosts')) ?? []
    for (const id of ids) {
      const h = await kget<HostRec>(`host:${id}`)
      if (h) hostRecs.set(id, h)
    }
    changed()
  })()
  return loaded
}
if (typeof window !== 'undefined') void loadTrust()

export const supported = () => typeof crypto !== 'undefined' && !!crypto.subtle && typeof indexedDB !== 'undefined'
export const deviceId = () => device?.id ?? null
export const pairedWith = (hostId: string) => hostRecs.has(hostId)
export const pairedHosts = () => [...hostRecs.keys()]

/** Whether this device is on the Mac's list (the Mac says, through the server: used only to show, never to decide). */
export const listedOn = (h: Host) => !!device && !!h.trust?.devices?.some((d) => d.id === device!.id)

async function ensureDevice(): Promise<DeviceRec> {
  await loadTrust()
  if (device) return device
  const s = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const d = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const spub = new Uint8Array(await crypto.subtle.exportKey('raw', s.publicKey))
  const dpub = new Uint8Array(await crypto.subtle.exportKey('raw', d.publicKey))
  const id = b64u(await sha256(spub, dpub)).slice(0, 22)
  const rec: DeviceRec = { id, spub: b64u(spub), dpub: b64u(dpub), spriv: s.privateKey, dpriv: d.privateKey, at: Date.now() }
  await kput('device', rec)
  device = rec
  return rec
}

// ---------- pairing (§4.2) ----------
/** The six digits: the same hash the Mac computes over what both sides committed to. */
export async function pairSas(hostId: string, apub: string, spub: string, dpub: string, na: string, nb: string) {
  const h = await sha256(`bt-pair-sas|${hostId}|`, unb64u(apub), unb64u(spub), unb64u(dpub), unb64u(na), unb64u(nb))
  let v = 0
  for (let i = 0; i < 6; i++) v = v * 256 + h[i]
  return String(v % 1_000_000).padStart(6, '0')
}

type Ask = (body: Record<string, unknown>) => Promise<Record<string, unknown>>

export interface Pairing {
  sas: string
  /** Asks the Mac until the person has answered at its terminal: 'ok' (paired), 'no', or still 'pending'. */
  poll: () => Promise<'ok' | 'no' | 'pending'>
}

export async function startPairing(hostId: string, name: string, ask: Ask): Promise<Pairing> {
  const dev = await ensureDevice()
  const nb = b64u(rand(32))
  const c = b64u(await sha256('bt-pair-commit|', unb64u(dev.spub), unb64u(dev.dpub), unb64u(nb)))
  const r1 = await ask({ op: 'pair1', c })
  const pid = String(r1.pid ?? '')
  const apub = String(r1.apub ?? '')
  const na = String(r1.na ?? '')
  if (r1.hostId !== hostId || unb64u(apub).length !== 65 || unb64u(na).length !== 32) throw new Error('맥의 답이 올바르지 않아요')
  // This page's own number, never the one in the server's answer: the Mac's terminal is where the two are compared.
  const sas = await pairSas(hostId, apub, dev.spub, dev.dpub, na, nb)
  const r3 = await ask({ op: 'pair3', pid, spub: dev.spub, dpub: dev.dpub, nb, name })
  if (r3.sas !== sas) throw new Error('확인 숫자가 서로 달라요. 누군가 중간에서 바꿨을 수 있어요. 짝짓지 마세요')
  const fp = b64u(await sha256(unb64u(apub))).slice(0, 16)
  const poll = async () => {
    const r = await ask({ op: 'pair4', pid })
    if (r.state === 'pending') return 'pending'
    if (r.state !== 'ok') return 'no'
    if (r.fp !== fp) throw new Error('맥의 키가 짝지을 때와 달라요')
    await takeKeys(hostId, apub, fp, r)
    return 'ok'
  }
  return { sas, poll }
}

/** K (and the older keys this device may use), unwrapped with this device's ECDH key, kept unreadable. */
async function takeKeys(hostId: string, apub: string, fp: string, r: Record<string, unknown>) {
  const dev = await ensureDevice()
  const peer = await crypto.subtle.importKey('raw', unb64u(apub), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, dev.dpriv, 256)
  const hk = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey'])
  const wk = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: unb64u(String(r.salt ?? '')), info: enc.encode(`bt-wrap|${hostId}`) }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
  const keys: HostRec['keys'] = {}
  for (const k of (r.keys as { kid: string; wrap: string }[]) ?? []) {
    const b = unb64u(k.wrap)
    let raw: ArrayBuffer
    try {
      raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12), additionalData: enc.encode(`bt-wrap|${hostId}|${k.kid}`) }, wk, b.slice(12))
    } catch {
      throw new Error('맥이 보낸 키를 풀지 못했어요')
    }
    keys[k.kid] = {
      aes: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']),
      mac: await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    }
    new Uint8Array(raw).fill(0)
  }
  const kid = String(r.kid ?? '')
  if (!keys[kid]) throw new Error('맥이 쓰는 키가 오지 않았어요')
  const rec: HostRec = { hostId, fp, apub, kid, keys, at: Date.now() }
  await kput(`host:${hostId}`, rec)
  hostRecs.set(hostId, rec)
  await kput('hosts', [...hostRecs.keys()])
  changed()
}

/** The Mac's keys again (after a device was removed there, it seals with a new one). */
export async function refreshKeys(hostId: string, ask: Ask) {
  const h = hostRecs.get(hostId)
  const dev = await ensureDevice()
  if (!h) return
  const r = await ask({ op: 'keys', d: dev.id })
  if (r.kid && r.salt) await takeKeys(hostId, h.apub, h.fp, r)
}

/** This browser stops being a device of that Mac (the Mac's list is changed by a signed remove). */
export async function forgetHost(hostId: string) {
  hostRecs.delete(hostId)
  await kdel(`host:${hostId}`)
  await kput('hosts', [...hostRecs.keys()])
  changed()
}

// ---------- signing (§5) ----------
export interface Intent {
  h: string
  t: string
  i: Record<string, unknown>
}

/** A number never used twice by this device: time in µs, raised past the last one (one tab at a time). */
async function nextN(): Promise<number> {
  const take = () => {
    let last = 0
    try {
      last = Number(localStorage.getItem('cb2.trust.n')) || 0
    } catch {}
    const n = Math.max(Date.now() * 1000, last + 1)
    try {
      localStorage.setItem('cb2.trust.n', String(n))
    } catch {}
    return n
  }
  const locks = (navigator as Navigator & { locks?: { request: (n: string, f: () => Promise<number>) => Promise<number> } }).locks
  return locks ? locks.request('cb2-trust-n', async () => take()) : take()
}

export async function sign(x: Intent) {
  const dev = await ensureDevice()
  const p = JSON.stringify({ v: 1, h: x.h, d: dev.id, ts: Date.now(), n: await nextN(), t: x.t, i: x.i })
  const s = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, dev.spriv, enc.encode(p))
  return { p, s: b64u(s) }
}

/** HMAC of a text under a Mac's key in use (정정: names the text without the server choosing it). */
export async function textMac(hostId: string, text: string) {
  const h = hostRecs.get(hostId)
  if (!h) return null
  const m = await crypto.subtle.sign('HMAC', h.keys[h.kid].mac, enc.encode(text))
  return { kid: h.kid, mac: b64u(m) }
}

// What this page last said in each session: the text a 정정 names.
const lastSaid = new Map<string, string>()

// ---------- which request makes which command (§5.3) ----------
const sessionOf = (sid: string): Session | undefined => getStore().state?.sessions.find((s) => s.id === sid)

async function imageIds(images: unknown): Promise<string[]> {
  const out: string[] = []
  const ext: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
  for (const x of Array.isArray(images) ? images : []) {
    const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String((x as { data?: string })?.data ?? ''))
    if (!m) continue
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))
    out.push(`${hex(new Uint8Array(await crypto.subtle.digest('SHA-1', bytes)))}.${ext[m[1]]}`)
  }
  return out
}

const sendI = async (sid: string, text: string, images?: unknown) => ({ sid, textH: await sha256Hex(text.slice(0, 100_000)), imgs: await imageIds(images) })
const setAllow = (sid: string, on: boolean, all = false) => ({ t: 'set', i: { sid, autoAllow: on, allowAll: on && all } })

/** /do and the words that start with ':' (server/cscmd.go csCommand). */
async function doIntents(s: Session, cmd: string, arg: string): Promise<{ t: string; i: Record<string, unknown> }[]> {
  const sid = s.id
  switch (cmd) {
    case 'card': {
      const [card, n = ''] = arg.split(/\s+/)
      return [{ t: 'answer', i: { sid, card, n: n === 'esc' || n === 'enter' ? n : Number(n) } }]
    }
    case 'sendnow':
    case 'esc':
      return [{ t: cmd, i: { sid } }]
    case 'dropheld':
      return [{ t: 'dropheld', i: { sid } }]
    case 'continue':
      return [{ t: 'send', i: await sendI(sid, '계속해') }]
    case 'refresh':
      return [{ t: 'refresh', i: { sid, when: arg === 'later' || arg === 'cancel' ? arg : 'now' } }]
    case 'exit':
    case 'kill':
      return [{ t: 'close', i: { sid } }]
    case 'lightfork':
      return [{ t: 'lightfork', i: { sid, ...(arg === 'shrink' || arg === 'cut' ? { mode: arg } : {}) } }]
    case 'auto':
      return [setAllow(sid, arg === 'on')]
    case 'compact':
      return [{ t: 'send', i: await sendI(sid, COMPACT_TEXT) }]
    case 'mode':
      if (arg === 'autoAllow') return [setAllow(sid, true)]
      if (arg === 'allowAll') return [setAllow(sid, true, true)]
      return [setAllow(sid, false), { t: 'setting', i: { sid, kind: 'mode', value: arg.slice(0, 60) } }]
    case 'model':
    case 'effort':
      return [{ t: 'setting', i: { sid, kind: cmd, value: arg.slice(0, 60) } }]
  }
  return []
}

async function retractI(s: Session, h: string) {
  const said = lastSaid.get(s.id)
  const m = said == null ? null : await textMac(h, said)
  return m ? [{ t: 'retract', i: { sid: s.id, quotedM: m.mac, kid: m.kid } }] : []
}

/** What a page message becomes (server csSend): a side question, a ':' command, or a message. */
async function sayIntents(s: Session, h: string, text: string, images?: unknown) {
  const t = text.trim()
  const btw = /^[/:]btw\s+([\s\S]+)/.exec(t)
  if (btw) return [{ t: 'btw', i: { sid: s.id, textH: await sha256Hex(btw[1].trim()) } }]
  const colon = /^:([a-z]+)(?:\s+([\s\S]*))?$/.exec(t)
  if (colon) {
    const [, cmd, rest = ''] = colon
    const arg = rest.trim()
    if (cmd === 'retract') return retractI(s, h)
    if (cmd === 'answer') return s.card?.open && /^\d+$/.test(arg) ? [{ t: 'answer', i: { sid: s.id, card: s.card.id, n: Number(arg) } }] : []
    return doIntents(s, cmd, arg)
  }
  return [{ t: 'send', i: await sendI(s.id, text, images) }]
}

type Body = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')

async function intentsFor(method: string, path: string, body: Body): Promise<Intent[]> {
  const sm = /^\/api\/sessions\/([\w-]+)(?:\/([\w-]+))?$/.exec(path)
  if (sm) {
    const s = sessionOf(sm[1])
    if (!s || !pairedWith(s.hostId)) return []
    const h = s.hostId
    const sid = s.id
    const op = sm[2] ?? ''
    let xs: { t: string; i: Record<string, unknown> }[] = []
    if (method === 'DELETE' && !op) xs = [{ t: 'close', i: { sid } }]
    else if (method !== 'POST') return []
    else if (op === 'say' || op === 'send') {
      xs = op === 'say' ? await sayIntents(s, h, str(body.text), body.images) : [{ t: 'send', i: await sendI(sid, str(body.text), body.images) }]
      if (xs[0]?.t === 'send' && op === 'say' && !/^[:/]/.test(plainOf(str(body.text)).trim())) lastSaid.set(sid, plainOf(str(body.text)).slice(0, 100_000))
    } else if (op === 'do') xs = await doIntents(s, str(body.cmd), str(body.arg).trim())
    else if (op === 'answer') xs = [{ t: 'answer', i: { sid, card: body.card, n: body.n === 'esc' || body.n === 'enter' ? body.n : Number(body.n) } }]
    else if (op === 'setting') xs = [{ t: 'setting', i: { sid, kind: body.kind, value: str(body.value).slice(0, 60) } }]
    else if (op === 'refresh') xs = [{ t: 'refresh', i: { sid, when: body.when === 'later' || body.when === 'cancel' ? body.when : 'now' } }]
    else if (['sendnow', 'esc', 'close', 'trash', 'trimlog', 'fork'].includes(op)) xs = [{ t: op, i: { sid } }]
    else if (op === 'dropheld') xs = [{ t: 'dropheld', i: { sid, ...(typeof body.id === 'string' ? { id: body.id.slice(0, 64) } : {}) } }]
    else if (op === 'btw') xs = [{ t: 'btw', i: { sid, textH: await sha256Hex(str(body.text).trim()) } }]
    else if (op === 'lightfork') xs = [{ t: 'lightfork', i: { sid, ...(body.mode === 'shrink' || body.mode === 'cut' ? { mode: body.mode } : {}) } }]
    else if (op === 'key') xs = [{ t: 'key', i: { sid, keys: (Array.isArray(body.keys) ? body.keys : []).slice(0, 20).map(String), card: s.card?.open ? s.card.id : null } }]
    else if (op === 'killserver') xs = [{ t: 'killserver', i: { sid, port: Number(body.port) } }]
    else if (op === 'retract') xs = await retractI(s, h)
    else if (op === 'resume') xs = [{ t: 'open', i: { sid } }]
    else if (op === 'settings') {
      if (typeof body.autoPush === 'boolean') xs.push({ t: 'set', i: { sid, autoPush: body.autoPush } })
      if (typeof body.autoAllow === 'boolean') xs.push(setAllow(sid, body.autoAllow, body.allowAll === true))
      // 휴면 (REQ-F-501, 1.396): a rest stops claude, a wake starts it again on the same conversation.
      if (body.resting === true && s.state?.alive && !s.resting && !s.closed) xs.push({ t: 'tidyStop', i: { sids: [sid] } })
      if (body.resting === false && s.resting && !s.state?.alive && !s.closed) xs.push({ t: 'open', i: { sid } })
    }
    return xs.map((x) => ({ h, ...x }))
  }
  if (method === 'POST' && path === '/api/sessions') {
    const h = str(body.hostId)
    if (!pairedWith(h)) return []
    const mode = str(body.mode)
    const i: Body = { cwd: (str(body.cwd) || '~').slice(0, 1000), promptH: await sha256Hex(str(body.prompt).slice(0, 100_000)), create: body.create === true, autoPush: true, mode: mode === 'autoAllow' || mode === 'allowAll' ? 'default' : mode }
    for (const k of ['model', 'effort'] as const) if (typeof body[k] === 'string') i[k] = str(body[k]).slice(0, k === 'model' ? 60 : 10)
    if (typeof body.account === 'string' && body.account) i.account = body.account
    if (body.chrome === false) i.chrome = false
    // The runner is signed too (REQ-F-851): a server cannot start another program than the one asked for.
    if (typeof body.runner === 'string' && body.runner && body.runner !== 'claude') i.runner = body.runner.slice(0, 16)
    return [{ h, t: 'new', i }]
  }
  const hm = /^\/api\/hosts\/([a-zA-Z0-9-]+)\/([\w-]+)$/.exec(path)
  if (hm && method === 'POST' && pairedWith(hm[1])) {
    const [, h, op] = hm
    if (op === 'heal') return [{ h, t: 'heal', i: { action: body.action } }]
    if (op === 'background') return [{ h, t: 'background', i: { on: body.on === true } }]
    if (op === 'awake') return [{ h, t: 'awake', i: { ...(typeof body.idle === 'boolean' ? { idle: body.idle } : {}), ...(typeof body.lid === 'boolean' ? { lid: body.lid } : {}) } }]
    if (op === 'compact') return [{ h, t: 'compact', i: { window: body.window ?? null } }]
    if (op === 'update') return body.now === true ? [{ h, t: 'updateNow', i: {} }] : [{ h, t: 'updatePolicy', i: { mode: body.mode, from: body.from, to: body.to, ...(typeof body.skipBusy === 'boolean' ? { skipBusy: body.skipBusy } : {}) } }]
    if (op === 'disk' && ['prune', 'clean', 'trash'].includes(str(body.op))) {
      const i: Body = { op: body.op }
      if (typeof body.id === 'string') i.id = body.id
      if (typeof body.path === 'string') i.path = body.path
      if (Array.isArray(body.paths)) i.paths = body.paths.filter((x) => typeof x === 'string' && x.length <= 4096).slice(0, 200)
      return [{ h, t: 'disk', i }]
    }
    if (op === 'tidy' && body.op === 'stop') return [{ h, t: 'tidyStop', i: { sids: (Array.isArray(body.sids) ? body.sids : []).filter((x) => typeof x === 'string').slice(0, 200) } }]
    if (op === 'tidy' && body.op === 'trash') {
      const items = (Array.isArray(body.items) ? body.items : []).map((x) => ({ kind: String(x?.kind ?? ''), path: x?.path })).filter((x) => typeof x.path === 'string' && x.path.length <= 4096 && (x.kind === 'folder' || x.kind === 'transcript')).slice(0, 200)
      return [{ h, t: 'tidyTrash', i: { items } }]
    }
    if (op === 'trust' && body.op === 'remove') return [{ h, t: 'trust', i: { op: 'remove', id: body.id } }]
  }
  return []
}

/** The X-Bridge-Auth header for a request, or null when it makes no paired Mac act. */
export async function authHeader(method: string, path: string, body: unknown): Promise<string | null> {
  if (!hostRecs.size && !loaded) return null
  await loadTrust()
  if (!hostRecs.size) return null
  let xs: Intent[]
  try {
    xs = await intentsFor(method, path.split('?')[0], (body && typeof body === 'object' ? body : {}) as Body)
  } catch {
    return null
  }
  if (!xs.length) return null
  const toks = await Promise.all(xs.slice(0, 8).map(sign))
  return b64u(enc.encode(JSON.stringify(toks)))
}

// ---------- sealed pieces (§6, REQ-S-095) ----------
// A Mac with `trust seal on` sends its words as ⟦bt1:<kid>:<iv‖ct‖tag>⟧ under a key only its paired devices hold.
// The page opens them where it receives them (the stream and every API answer) and seals what it sends there.

const PIECE_RE = /⟦bt1:([0-9a-f]{8}):([A-Za-z0-9_-]{38,})⟧/g
/** The start of a piece the server cut (it should not: server sealSafeEnd), shown as 🔒. */
const CUT_RE = /⟦bt1:[0-9a-f]{0,8}:?[A-Za-z0-9_-]*$/
export const LOCKED = '🔒'
const opened = new Map<string, string>()
const sealedByMe = new Map<string, string>()

async function openPiece(piece: string, kid: string, body: string): Promise<string> {
  const hit = opened.get(piece)
  if (hit != null) return hit
  let out = LOCKED
  for (const h of hostRecs.values()) {
    const k = h.keys[kid]
    if (!k) continue
    try {
      const b = unb64u(body)
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12), additionalData: enc.encode(`bt1|${h.hostId}|${kid}`) }, k.aes, b.slice(12))
      const o = JSON.parse(new TextDecoder().decode(plain)) as { v?: unknown }
      if (typeof o.v === 'string') out = o.v
    } catch {}
    break
  }
  if (opened.size > 5000) opened.clear()
  opened.set(piece, out)
  return out
}

/** A string with its pieces opened (🔒 where this device cannot). */
export async function openText(s: string): Promise<string> {
  if (!s.includes('⟦bt')) return s
  await loadTrust()
  const parts: (string | Promise<string>)[] = []
  let last = 0
  for (const m of s.matchAll(PIECE_RE)) {
    parts.push(s.slice(last, m.index), openPiece(m[0], m[1], m[2]))
    last = m.index! + m[0].length
  }
  parts.push(s.slice(last).replace(CUT_RE, LOCKED))
  return (await Promise.all(parts)).join('')
}

/** A whole answer or stream message, every string in it opened; a sealed card is put back together (§6.4). */
export async function openDeep<T>(v: T): Promise<T> {
  const walk = async (x: unknown): Promise<unknown> => {
    if (typeof x === 'string') return x.includes('⟦bt') ? openText(x) : x
    if (Array.isArray(x)) return Promise.all(x.map(walk))
    if (x && typeof x === 'object') {
      const o: Record<string, unknown> = {}
      for (const [k, y] of Object.entries(x)) o[k] = await walk(y)
      if (typeof (x as Record<string, unknown>).sealed === 'string' && 'id' in o) return cardOf(o)
      return o
    }
    return x
  }
  return (await walk(v)) as T
}

/** A card whose words came as one sealed piece holding its id: only a piece for this very card is shown with buttons. */
function cardOf(o: Record<string, unknown>) {
  const { sealed, ...rest } = o
  try {
    const w = JSON.parse(String(sealed)) as Record<string, unknown>
    if (w && w.id === o.id) return { ...rest, ...w }
  } catch {}
  return { ...rest, title: '맥에서 확인할 수 없는 카드', options: [], context: '' }
}

const hostOf = (hostId: string) => getStore().state?.hosts.find((h) => h.id === hostId)
/** Whether what this page sends to that Mac is sealed: it seals what it sends out, and this device holds its key. */
export const sealsTo = (hostId: string) => pairedWith(hostId) && !!hostOf(hostId)?.trust?.seal

async function sealPiece(hostId: string, sid: string, text: string) {
  const h = hostRecs.get(hostId)!
  const iv = rand(12)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`bt1|${hostId}|${h.kid}`) }, h.keys[h.kid].aes, enc.encode(JSON.stringify({ d: 'u', s: sid, v: text }))))
  return `⟦bt1:${h.kid}:${b64u(cat(iv, ct))}⟧`
}

/**
 * What a person writes to a sealing Mac, sealed: a ':' command stays as it is (the server reads it, and the Mac
 * takes only what the page signed), a '/name' keeps its first word so the server still sees the command.
 */
export async function sealFor(hostId: string, sid: string, text: string) {
  if (!text.trim() || !sealsTo(hostId) || text.includes('⟦bt1:') || /^\s*:[a-z]+(?:\s|$)/.test(text)) return text
  const lead = /^\s*\/[\w:-]+\s*/.exec(text)?.[0] ?? ''
  const rest = text.slice(lead.length)
  if (!rest.trim()) return text
  const out = lead + (await sealPiece(hostId, sid, rest))
  if (sealedByMe.size > 200) sealedByMe.clear()
  sealedByMe.set(out, text)
  return out
}
/** The words this page sealed, back (what a 정정 names is the plain text). */
function plainOf(s: string) {
  return sealedByMe.get(s) ?? s
}

/** A request body with its words sealed for the Mac it goes to (send, say, btw, a new session's first words). */
export async function sealBody(method: string, path: string, body: unknown): Promise<unknown> {
  if (method !== 'POST' || !body || typeof body !== 'object' || !hostRecs.size) return body
  const b = body as Body
  const p = path.split('?')[0]
  const sm = /^\/api\/sessions\/([\w-]+)\/(say|send|btw)$/.exec(p)
  if (sm && typeof b.text === 'string') {
    const s = sessionOf(sm[1])
    if (s && sealsTo(s.hostId)) return { ...b, text: await sealFor(s.hostId, s.id, b.text) }
  }
  if (p === '/api/sessions' && typeof b.prompt === 'string' && typeof b.hostId === 'string' && sealsTo(b.hostId)) return { ...b, prompt: await sealFor(b.hostId, '', b.prompt) }
  return body
}
