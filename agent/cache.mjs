// What the prompt cache did in a session, counted from its transcript (REQ-F-773). Each model call is written to
// the .jsonl with its usage: how much of the context was read from the cache, how much was written to it again,
// and how much was not cached at all. Most of what a long session costs is the context it reads back every call,
// and a call that writes the whole context again (after an hour idle, a model switch, a compaction) costs many
// calls' worth. This only counts; nothing here changes what the session does.

/** A call that wrote at least this much, and more than it read, wrote the context again: it is kept as an event. */
export const REWRITE_MIN = 30_000
/** The prompt cache of a subscription's main session lives an hour; an API key's or a subagent's five minutes. */
export const COLD_MS = 3_600_000
export const WARM_MS = 300_000
/** The latest events kept with the session. */
export const EVENTS_MAX = 5

export const emptyCache = () => ({ calls: 0, read: 0, write: 0, input: 0, output: 0, ctx: 0, at: 0, model: null, events: [], lastId: null, compacted: false })

const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0)

/**
 * Count one transcript line into `c`. One answer is written as several lines (one per content block), each with
 * the same message id and usage: only the first is counted. Subagents' calls (isSidechain) are their own cache,
 * not this conversation's.
 */
export function countLine(c, line) {
  const compact = line.includes('"compact_boundary"') || line.includes('"isCompactSummary"')
  if (!compact && !(line.includes('"usage"') && line.includes('"assistant"'))) return
  let j
  try {
    j = JSON.parse(line)
  } catch {
    return
  }
  if ((j.type === 'system' && j.subtype === 'compact_boundary') || j.isCompactSummary) {
    c.compacted = true
    // The context is what the compaction left, not the last call before it: until the next call, the boundary's
    // own count (0 when it has none, so nothing goes on reading the old size as the current one).
    if (j.subtype === 'compact_boundary') c.ctx = num(j.compactMetadata?.postTokens)
    return
  }
  const m = j.message
  if (j.type !== 'assistant' || j.isSidechain || !m?.usage || m.model === '<synthetic>') return
  if (m.id && m.id === c.lastId) return
  c.lastId = m.id ?? null
  const u = m.usage
  const read = num(u.cache_read_input_tokens)
  const write = num(u.cache_creation_input_tokens)
  const input = num(u.input_tokens)
  const at = Date.parse(j.timestamp) || 0
  if (write >= REWRITE_MIN && write > read) {
    const gap = c.at && at ? at - c.at : 0
    const kind = !c.calls ? 'start' : c.compacted ? 'compact' : c.model && m.model && m.model !== c.model ? 'model' : gap >= COLD_MS ? 'cold' : gap >= WARM_MS ? 'idle' : 'other'
    c.events.push({ at, kind, tokens: write, gap })
    if (c.events.length > EVENTS_MAX) c.events.shift()
  }
  c.calls++
  c.read += read
  c.write += write
  c.input += input
  c.output += num(u.output_tokens)
  c.ctx = read + write + input
  c.at = at || c.at
  c.model = m.model ?? c.model
  c.compacted = false
}

/** What the page is told: the totals, the share read from the cache, and the latest rewrites. */
export function cacheStatus(c) {
  if (!c?.calls) return null
  const all = c.read + c.write + c.input
  return { calls: c.calls, read: c.read, write: c.write, input: c.input, output: c.output, hit: all ? Math.round((c.read / all) * 1000) / 10 : 0, ctx: c.ctx, at: c.at, events: c.events.slice() }
}
