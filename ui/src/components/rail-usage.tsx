// The plan limits on a PC's app rail (REQ-F-858): Claude Code's and Codex's 5-hour and weekly use, stacked above
// the report, bell and settings buttons. They belong to the account, not to a session, so a wide screen shows them
// here once instead of beside every conversation's input.
import { useTick } from '../kit'
import { clock } from '../lib/format'
import { NONE, useStore } from '../lib/store'
import type { Session } from '../lib/types'
import { type Limit, railUsage, untilReset } from '../lib/rail-usage'

const level = (pct: number) => (pct >= 85 ? 'high' : pct >= 60 ? 'mid' : '')

function Row({ k, label, l, now }: { k: string; label: string; l: Limit; now: number }) {
  const left = untilReset(l.resetsAt, now)
  return (
    <span className={`rail-usage-row gauge ${level(l.pct)}`} title={`${label} ${Math.round(l.pct)}%${l.resetsAt ? ` · ${clock(l.resetsAt)} 에 다시 차요` : ''}`}>
      <span className="rail-usage-k">{k}</span>
      <span className="rail-usage-v">{Math.round(l.pct)}%</span>
      <span className="gauge-bar">
        <i style={{ width: `${Math.min(100, Math.max(2, l.pct))}%` }} />
      </span>
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
      {list.map((r) => (
        <div key={r.id} className="rail-usage-group" title={r.from ? `${r.name} 사용량 · 세션 "${r.from}" 이 알린 값` : `${r.name} 사용량`}>
          <span className="rail-usage-name">{r.name}</span>
          {r.fiveHour ? <Row k="5h" label={`${r.name} 5시간`} l={r.fiveHour} now={now} /> : null}
          {r.week ? <Row k="주" label={`${r.name} 주간`} l={r.week} now={now} /> : null}
        </div>
      ))}
    </div>
  )
}
