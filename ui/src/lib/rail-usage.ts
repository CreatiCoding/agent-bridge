// The plan limits on a PC's app rail (REQ-F-858): per runner, the 5-hour and weekly use its latest session reported.
import type { Session } from './types'

export type Limit = { pct: number; resetsAt: number | null }
export type RunnerUsage = { id: 'claude' | 'codex'; name: string; fiveHour: Limit | null; week: Limit | null; from: string }

const RUNNERS = [
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'Codex' },
] as const

/** A limit whose reset time has passed is full again: 0, as the classic view counts it (cs.go). */
const limitOf = (pct: number | null | undefined, resetsAt: number | null | undefined, now: number): Limit | null =>
  pct == null ? null : { pct: resetsAt && resetsAt < now ? 0 : pct, resetsAt: resetsAt || null }

/** Per runner, the latest session (by updatedAt) that has reported a limit; runners with none are left out. */
export function railUsage(sessions: readonly Session[], now: number): RunnerUsage[] {
  const out: RunnerUsage[] = []
  for (const r of RUNNERS) {
    let best: Session | null = null
    for (const s of sessions) {
      const id = !s.runner || s.runner === 'claude' ? 'claude' : s.runner
      const u = s.state?.usage
      if (id !== r.id || !u || (u.fiveHour == null && u.week == null)) continue
      if (!best || s.updatedAt > best.updatedAt) best = s
    }
    const u = best?.state.usage
    if (!best || !u) continue
    out.push({ id: r.id, name: r.name, fiveHour: limitOf(u.fiveHour, u.fiveHourResetsAt, now), week: limitOf(u.week, u.weekResetsAt, now), from: best.title || best.preview || '' })
  }
  return out
}
