// A session's numbered log, kept on the Mac (REQ-S-069): the server numbers each event and hands it down; this is
// where it stays. The server keeps no copy, so the page reads it from here through the server.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const safeSid = (sid) => typeof sid === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(sid)
const CACHE_MAX = 16

/**
 * One JSONL file per session. Events can arrive out of order (the bridge tab hands commands over side by side) and
 * twice (the server sends again what it did not hear was kept): reading orders them by seq and keeps one of each.
 */
export class EventStore {
  constructor(dir) {
    this.dir = dir
    /** sid -> { size, rest, bySeq: Map, sorted: Array|null } for the logs read lately. */
    this.cache = new Map()
  }
  file(sid) {
    return path.join(this.dir, `${sid}.jsonl`)
  }
  append(sid, events) {
    if (!safeSid(sid)) return 0
    const good = (Array.isArray(events) ? events : []).filter((e) => e && typeof e === 'object' && Number.isInteger(e.seq) && e.seq > 0)
    if (!good.length) return 0
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    fs.appendFileSync(this.file(sid), good.map((e) => `${JSON.stringify(e)}\n`).join(''), { mode: 0o600 })
    return good.length
  }
  /** Every event of the session, oldest first, one per seq. The array is shared: callers never change it. */
  all(sid) {
    if (!safeSid(sid)) return []
    const file = this.file(sid)
    let st
    try {
      st = fs.statSync(file)
    } catch {
      this.cache.delete(sid)
      return []
    }
    let hit = this.cache.get(sid)
    if (hit && st.size < hit.size) hit = null
    if (!hit) hit = { size: 0, rest: '', bySeq: new Map(), sorted: null }
    if (st.size > hit.size) {
      const fd = fs.openSync(file, 'r')
      let text
      try {
        const buf = Buffer.alloc(st.size - hit.size)
        fs.readSync(fd, buf, 0, buf.length, hit.size)
        text = hit.rest + buf.toString('utf8')
      } finally {
        fs.closeSync(fd)
      }
      const lines = text.split('\n')
      hit.rest = lines.pop() ?? ''
      for (const l of lines) {
        if (!l) continue
        try {
          const e = JSON.parse(l)
          if (Number.isInteger(e?.seq)) hit.bySeq.set(e.seq, e)
        } catch {}
      }
      hit.size = st.size
      hit.sorted = null
    }
    hit.sorted ??= [...hit.bySeq.values()].sort((a, b) => a.seq - b.seq)
    this.cache.delete(sid)
    this.cache.set(sid, hit)
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value)
    return hit.sorted
  }
  /** `after`: what came after, oldest first. `before`: one page further back. Neither: the newest page. */
  page(sid, { after, before, limit = 500, kinds } = {}) {
    // `kinds`: only those (the server putting an open card back after it restarted).
    const all = Array.isArray(kinds) ? this.all(sid).filter((e) => kinds.includes(e.k)) : this.all(sid)
    const n = Math.max(1, Math.min(2000, Number(limit) || 500))
    if (Number.isFinite(after)) {
      const rest = all.filter((e) => e.seq > after)
      return { events: rest.slice(0, n), more: rest.length > n }
    }
    const older = Number.isFinite(before) ? all.filter((e) => e.seq < before) : all
    return { events: older.slice(-n), more: older.length > n }
  }
  lastSeq(sid) {
    return this.all(sid).at(-1)?.seq ?? 0
  }
  /** The highest seq among the file's last lines, without reading it all (every session, at each hello). */
  tailSeq(sid) {
    if (!safeSid(sid)) return 0
    try {
      const fd = fs.openSync(this.file(sid), 'r')
      try {
        const size = fs.fstatSync(fd).size
        const buf = Buffer.alloc(Math.min(size, 64 * 1024))
        fs.readSync(fd, buf, 0, buf.length, size - buf.length)
        let max = 0
        for (const m of buf.toString('utf8').matchAll(/"seq":(\d+)/g)) max = Math.max(max, Number(m[1]))
        return max
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return 0
    }
  }
  has(sid) {
    return safeSid(sid) && fs.existsSync(this.file(sid))
  }
  remove(sid) {
    if (!safeSid(sid)) return
    this.cache.delete(sid)
    fs.rmSync(this.file(sid), { force: true })
  }
  /** The sessions that have a log here. */
  list() {
    try {
      return fs.readdirSync(this.dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)).filter(safeSid)
    } catch {
      return []
    }
  }
  /**
   * A fork starts with the original's log up to `upTo` (REQ-S-069): what was asked and answered, not the cards that
   * waited or the marks on messages.
   */
  copy(from, to, upTo) {
    if (!safeSid(from) || !safeSid(to)) return 0
    const keep = this.all(from).filter((e) => e.seq <= upTo && !['card', 'card_end', 'react', 'status', 'held'].includes(e.k))
    return this.append(to, keep)
  }
}

const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
export const imageIdOk = (id) => typeof id === 'string' && /^[0-9a-f]{40}\.(png|jpg|gif|webp)$/.test(id)
export const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
/** A picture's id, the same the server gives it: sha1 of its bytes and its kind. */
export function imageId(mediaType, base64) {
  const ext = IMG_EXT[mediaType]
  if (!ext || typeof base64 !== 'string') return null
  const bytes = Buffer.from(base64, 'base64')
  if (!bytes.length || bytes.length > 12 * 1024 * 1024) return null
  return { id: `${crypto.createHash('sha1').update(bytes).digest('hex')}.${ext}`, bytes }
}
/**
 * The pictures in one transcript line (pasted into the conversation, or returned by a tool), kept under their ids so
 * the page can still show them when the server keeps none. Cheap for the lines without one.
 */
export function saveLineImages(line, dir) {
  if (typeof line !== 'string' || !line.includes('"base64"')) return 0
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return 0
  }
  let n = 0
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 8) return
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1))
    if (v.type === 'image' && v.source?.type === 'base64') {
      const got = imageId(String(v.source.media_type ?? 'image/png'), v.source.data)
      if (got) n += saveImage(dir, got.id, got.bytes)
      return
    }
    for (const x of Object.values(v)) walk(x, depth + 1)
  }
  walk(o, 0)
  return n
}
export function saveImage(dir, id, bytes) {
  if (!imageIdOk(id)) return 0
  const file = path.join(dir, id)
  if (fs.existsSync(file)) return 0
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, bytes, { mode: 0o600 })
  return 1
}
