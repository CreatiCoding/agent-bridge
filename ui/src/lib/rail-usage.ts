// The plan limits on a PC's app rail (REQ-F-858): per runner, the 5-hour and weekly use the sessions reported.
import type { Session, Usage } from './types'

export type Limit = { pct: number; resetsAt: number | null }
export type RunnerUsage = { id: 'claude' | 'codex'; name: string; fiveHour: Limit | null; week: Limit | null; from: string }

const RUNNERS = [
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'Codex' },
] as const

/** Two reports of the same window can carry reset times a few seconds or minutes apart. */
const SAME_WINDOW_MS = 10 * 60_000

type Pick = { limit: Limit; s: Session }

/**
 * One limit across a runner's sessions. Each session only refreshes its numbers while it runs a turn, so a quiet
 * session keeps an old, lower snapshot, and the session touched last (updatedAt) is not the one measured last. Within
 * one window use only grows, so: the current window (the latest reset time still ahead), and in it the highest value.
 * When every reported window has reset, the limit is full again (0, as server/cs.go counts it).
 */
function pickLimit(list: readonly Session[], pctOf: (u: Usage) => number | null, resetOf: (u: Usage) => number | null, now: number): Pick | null {
  const all = list.flatMap((s) => {
    const u = s.state.usage!
    const pct = pctOf(u)
    return pct == null ? [] : [{ s, pct, resetsAt: resetOf(u) || null }]
  })
  if (!all.length) return null
  const live = all.filter((c) => !c.resetsAt || c.resetsAt >= now)
  if (!live.length) {
    const last = all.reduce((a, b) => ((b.resetsAt ?? 0) > (a.resetsAt ?? 0) ? b : a))
    return { limit: { pct: 0, resetsAt: last.resetsAt }, s: last.s }
  }
  const timed = live.filter((c) => c.resetsAt)
  const latest = timed.length ? Math.max(...timed.map((c) => c.resetsAt!)) : null
  // Without any reset time the windows cannot be told apart: the session updated last, as before.
  if (latest == null) {
    const last = live.reduce((a, b) => (b.s.updatedAt > a.s.updatedAt ? b : a))
    return { limit: { pct: last.pct, resetsAt: null }, s: last.s }
  }
  const window = timed.filter((c) => latest - c.resetsAt! <= SAME_WINDOW_MS)
  const best = window.reduce((a, b) => (b.pct > a.pct || (b.pct === a.pct && b.s.updatedAt > a.s.updatedAt) ? b : a))
  return { limit: { pct: best.pct, resetsAt: latest }, s: best.s }
}

/** Per runner, its current 5-hour and weekly use; runners whose sessions reported no limit are left out. */
export function railUsage(sessions: readonly Session[], now: number): RunnerUsage[] {
  const out: RunnerUsage[] = []
  for (const r of RUNNERS) {
    const mine = sessions.filter((s) => {
      const id = !s.runner || s.runner === 'claude' ? 'claude' : s.runner
      const u = s.state?.usage
      return id === r.id && !!u && (u.fiveHour != null || u.week != null)
    })
    if (!mine.length) continue
    const fiveHour = pickLimit(mine, (u) => u.fiveHour, (u) => u.fiveHourResetsAt, now)
    const week = pickLimit(mine, (u) => u.week, (u) => u.weekResetsAt, now)
    const from = (week ?? fiveHour)!.s
    out.push({ id: r.id, name: r.name, fiveHour: fiveHour?.limit ?? null, week: week?.limit ?? null, from: from.title || from.preview || '' })
  }
  return out
}

/** How long until a limit fills again, short enough for the rail's 38 px: "40분", "3시간", "2일". */
export function untilReset(resetsAt: number | null, now: number): string {
  if (!resetsAt || resetsAt <= now) return ''
  const m = Math.ceil((resetsAt - now) / 60_000)
  if (m < 60) return `${m}분`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}시간`
  return `${Math.round(h / 24)}일`
}
