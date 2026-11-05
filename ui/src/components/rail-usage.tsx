// The plan limits on a PC's app rail (REQ-F-858): Claude Code's and Codex's 5-hour and weekly use, stacked above
// the report, bell and settings buttons. They belong to the account, not to a session, so a wide screen shows them
// here once instead of beside every conversation's input.
// Drawn like a watch's activity rings around the runner's mark: the weekly limit on the outer ring, the 5-hour one
// inside it, so the rail's 52 px holds both without bars.
import { useTick } from '../kit'
import { clock } from '../lib/format'
import { NONE, useStore } from '../lib/store'
import type { Session } from '../lib/types'
import { type Limit, type RunnerUsage, railUsage, untilReset } from '../lib/rail-usage'

const level = (pct: number) => (pct >= 85 ? 'high' : pct >= 60 ? 'mid' : '')

/** The runner's mark in the ring's middle, on the 24-unit icon grid: an eight-ray burst for Claude, a prompt for Codex. */
const MARK: Record<RunnerUsage['id'], string> = {
  claude: 'M12 4v16M4 12h16M6.34 6.34l11.32 11.32M17.66 6.34L6.34 17.66',
  codex: 'M6.5 4.5h11a3.5 3.5 0 0 1 3.5 3.5v8a3.5 3.5 0 0 1 -3.5 3.5h-11a3.5 3.5 0 0 1 -3.5 -3.5v-8a3.5 3.5 0 0 1 3.5 -3.5zM7.5 9.5l2.5 2.5l-2.5 2.5M12.5 14.5h4',
}

/** As wide as the rail's 36 px buttons below it, so the ring lines up with the bell and settings icons. */
const SIZE = 36
const C = SIZE / 2
/** Outer (weekly) and inner (5-hour) rings: radius and stroke. */
const RINGS = [
  { r: 14, w: 2 },
  { r: 10.5, w: 2.5 },
] as const
/** The runner's mark in the middle, in px. */
const MARK_PX = 12

function Ring({ r, w, l }: { r: number; w: number; l: Limit }) {
  const len = 2 * Math.PI * r
  const pct = Math.min(100, Math.max(2, l.pct))
  return (
    <>
      <circle className="rail-ring-track" cx={C} cy={C} r={r} strokeWidth={w} />
      <circle
        className={`rail-ring-fill ${level(l.pct)}`}
        cx={C}
        cy={C}
        r={r}
        strokeWidth={w}
        strokeDasharray={`${(len * pct) / 100} ${len}`}
        transform={`rotate(-90 ${C} ${C})`}
      />
    </>
  )
}

function Row({ k, label, l, now }: { k: string; label: string; l: Limit; now: number }) {
  const left = untilReset(l.resetsAt, now)
  return (
    <span className={`rail-usage-row ${level(l.pct)}`} title={`${label} ${Math.round(l.pct)}%${l.resetsAt ? ` · ${clock(l.resetsAt)} 에 다시 차요` : ''}`}>
      <span className="rail-usage-k">{k}</span>
      <span className="rail-usage-v">{Math.round(l.pct)}%</span>
      {left ? <span className="rail-usage-left">{left} 뒤</span> : null}
    </span>
  )
}

export function RailUsage() {
  useTick(60_000)
  const now = Date.now()
  const sessions = useStore((st) => st.state?.sessions ?? NONE) as readonly Session[]
  const list = railUsage(sessions, now)
  if (!list.length) return null
  return (
    <div className="rail-usage" aria-label="사용량">
      {list.map((r) => {
        // The weekly limit takes the outer ring; with only one limit reported, that one does.
        const rings = [r.week, r.fiveHour].filter((l): l is Limit => !!l)
        return (
          <div key={r.id} className="rail-usage-group" title={r.from ? `${r.name} 사용량 · 세션 "${r.from}" 이 알린 값` : `${r.name} 사용량`}>
            <svg className={`rail-ring ${r.id}`} width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={r.name}>
              {rings.map((l, i) => (
                <Ring key={i} r={RINGS[i].r} w={RINGS[i].w} l={l} />
              ))}
              <path className="rail-ring-mark" d={MARK[r.id]} transform={`translate(${C - MARK_PX / 2} ${C - MARK_PX / 2}) scale(${MARK_PX / 24})`} />
            </svg>
            {r.week ? <Row k="주" label={`${r.name} 주간`} l={r.week} now={now} /> : null}
            {r.fiveHour ? <Row k="5h" label={`${r.name} 5시간`} l={r.fiveHour} now={now} /> : null}
          </div>
        )
      })}
    </div>
  )
}
