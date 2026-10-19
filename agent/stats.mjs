// What the usage statistics need from one session, as numbers only (REQ-S-070): the Mac works them out from its own
// log and sends them; the server adds the sessions up. No words of the conversation are in them.

const HOUR = 3_600_000
const DAY = 86_400_000
/** A turn counts for at most this long. */
export const TURN_CAP = 30 * 60_000
/** How far back the numbers go: the longest range the statistics page offers. */
export const STATS_DAYS = 90
const PR_RE = /https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+/g

/**
 * One session's numbers: `spans` [[start, end]] of finished turns (each at most TURN_CAP), `open` the start of a turn
 * not finished (or null), `lastAt` its last event, and `hours` {hourStart: {a, m, p, t}} where a = 1 when anything
 * happened that hour, m = what the person said, p = permission cards, t = {tool name: calls}.
 */
export function sessionStats(events, now = Date.now()) {
  const from = now - STATS_DAYS * DAY
  const spans = []
  const hours = {}
  let open = null
  let lastAt = 0
  for (const e of events) {
    const at = Number(e.at) || 0
    lastAt = at
    if (e.k === 'status') {
      if (open != null) {
        const to = Math.min(at, open + TURN_CAP)
        if (to > from) spans.push([open, to])
        open = null
      }
      if (e.phase === 'busy') open = at
    }
    if (at < from) continue
    const h = (hours[at - (at % HOUR)] ??= { a: 1 })
    if (e.k === 'tool' && e.name) (h.t ??= {})[e.name] = (h.t[e.name] ?? 0) + 1
    else if (e.k === 'card' && e.card?.kind === 'permission') h.p = (h.p ?? 0) + 1
    else if (e.k === 'user' && !e.command) h.m = (h.m ?? 0) + 1
  }
  return { spans, open, lastAt, hours }
}

/** The pull requests the conversation names, the most recently named first, at most `max`. */
export function prLinks(events, max = 100) {
  const found = []
  for (const e of events.slice(-2000)) if (e.k === 'text' || e.k === 'user') for (const u of String(e.text ?? '').match(PR_RE) ?? []) found.push(u)
  return [...new Set(found.reverse())].slice(0, max)
}

/** Numbers as the server keeps them: only known fields, sane sizes. Null when it is not that shape. */
export function cleanStats(s) {
  if (!s || typeof s !== 'object') return null
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const spans = (Array.isArray(s.spans) ? s.spans : []).slice(-20_000).filter((x) => Array.isArray(x) && x.length === 2).map(([a, b]) => [num(a), num(b)])
  const hours = {}
  for (const [k, v] of Object.entries(s.hours && typeof s.hours === 'object' ? s.hours : {}).slice(-24 * STATS_DAYS)) {
    if (!/^\d{10,14}$/.test(k) || !v || typeof v !== 'object') continue
    const t = {}
    for (const [name, n] of Object.entries(v.t && typeof v.t === 'object' ? v.t : {}).slice(0, 100)) if (/^[\w.:-]{1,80}$/.test(name)) t[name] = num(n)
    hours[k] = { a: 1, ...(v.m ? { m: num(v.m) } : {}), ...(v.p ? { p: num(v.p) } : {}), ...(Object.keys(t).length ? { t } : {}) }
  }
  return { spans, open: s.open == null ? null : num(s.open), lastAt: num(s.lastAt), hours }
}

/**
 * The statistics page from every session's numbers (`list` of {stats, cwd, id}), for the last `days` days: the same
 * figures the server once counted from its own copy of the logs.
 */
export function addStats(list, days, now = Date.now()) {
  const from = now - days * DAY
  const spans = []
  const tools = {}
  const folders = {}
  const daily = {}
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0))
  let toolCalls = 0
  let permissions = 0
  const day = (t) => {
    const d = new Date(t)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const dayOf = (t) => (daily[day(t)] ??= { day: day(t), workMs: 0, mine: 0, sessions: new Set() })
  for (const { stats: s, cwd, id } of list) {
    if (!s) continue
    const push = (a, b) => b > from && spans.push({ a: Math.max(a, from), b, cwd, sid: id })
    for (const [a, b] of s.spans) push(a, b)
    if (s.open != null) push(s.open, now - s.lastAt < TURN_CAP ? Math.min(now, s.open + TURN_CAP) : Math.min(s.lastAt + 60_000, s.open + TURN_CAP))
    for (const [k, h] of Object.entries(s.hours)) {
      const at = Number(k)
      if (at + HOUR <= from) continue
      for (const [name, n] of Object.entries(h.t ?? {})) (toolCalls += n), (tools[name] = (tools[name] ?? 0) + n)
      permissions += h.p ?? 0
      if (h.m) {
        dayOf(at).mine += h.m
        const d = new Date(at)
        heat[d.getDay()][d.getHours()] += h.m
      }
      dayOf(at).sessions.add(id)
    }
  }
  for (const s of spans) {
    folders[s.cwd] = (folders[s.cwd] ?? 0) + (s.b - s.a)
    for (let a = s.a; a < s.b; ) {
      const next = Math.min(s.b, new Date(a).setHours(24, 0, 0, 0))
      dayOf(a).workMs += next - a
      a = next
    }
  }
  const edges = spans.flatMap((s) => [[s.a, 1], [s.b, -1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1])
  let level = 0
  let peak = 0
  let busy = 0
  let prev = 0
  for (const [t, d] of edges) {
    if (level > 0) busy += t - prev
    level += d
    peak = Math.max(peak, level)
    prev = t
  }
  const work = spans.reduce((n, s) => n + (s.b - s.a), 0)
  const lens = spans.map((s) => s.b - s.a).sort((a, b) => a - b)
  const q = (p) => (lens.length ? lens[Math.min(lens.length - 1, Math.floor(p * lens.length))] : null)
  const bucket = days === 1 ? 15 * 60_000 : days <= 7 ? HOUR : 3 * HOUR
  const series = []
  for (let t = from; t < now; t += bucket) series.push(Math.round((spans.reduce((n, s) => n + Math.max(0, Math.min(s.b, t + bucket) - Math.max(s.a, t)), 0) / bucket) * 100) / 100)
  const top = (o, key, val) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ [key]: k, [val]: v }))
  return {
    days,
    totals: { work, busy, avgConcurrency: busy ? Math.round((work / busy) * 100) / 100 : 0, peakConcurrency: peak },
    turns: { count: lens.length, medianMs: q(0.5), p90Ms: q(0.9) },
    tools: toolCalls,
    permissions,
    series,
    heat,
    daily: Object.values(daily).sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ ...d, sessions: d.sessions.size })),
    topFolders: top(folders, 'cwd', 'workMs'),
    topTools: top(tools, 'name', 'count'),
  }
}
