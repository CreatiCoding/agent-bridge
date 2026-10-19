// How the sessions were used: time spent working, how many ran at once, when in the week, where, with what.
// Charts are drawn as SVG here; no chart library.
import { useEffect, useState } from 'react'
import { errorText, get } from '../lib/api'
import { duration, folderPath } from '../lib/format'
import { back } from '../lib/router'
import { Empty, IconButton, LoadError, Segmented, Spinner, useWide } from '../kit'

interface Stats {
  days: number
  totals: { work: number; busy: number; avgConcurrency: number; peakConcurrency: number }
  turns: { count: number; medianMs: number | null; p90Ms: number | null }
  tools: number
  permissions: number
  series: number[]
  heat: number[][]
  daily: { day: string; workMs: number; mine: number; sessions: number }[]
  topFolders: { cwd: string; workMs: number }[]
  topTools: { name: string; count: number }[]
  pr?: { merged: number; created: number; medianMergeMs?: number; additions: number; deletions: number; recent: { url: string; createdAt: string; mergedAt: string | null }[] }
}

function Line({ data }: { data: number[] }) {
  const W = 600
  const H = 120
  const max = Math.max(1, ...data)
  const step = data.length > 1 ? W / (data.length - 1) : W
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(H - (v / max) * (H - 10)).toFixed(1)}`).join(' ')
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H + 14}`} role="img" aria-label="동시에 돈 세션 수">
      <line x1="0" x2={W} y1={H} y2={H} stroke="var(--line)" />
      <polyline points={`0,${H} ${pts} ${W},${H}`} fill="var(--accent-soft)" stroke="none" />
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
      <text x="0" y={H + 12}>
        최대 {max}
      </text>
    </svg>
  )
}

function Bars({ data }: { data: { day: string; workMs: number }[] }) {
  const W = 600
  const H = 110
  const max = Math.max(1, ...data.map((d) => d.workMs))
  const bw = W / Math.max(1, data.length)
  return (
    <svg className="chart bars" viewBox={`0 0 ${W} ${H + 16}`} role="img" aria-label="날마다 일한 시간">
      {data.map((d, i) => {
        const h = (d.workMs / max) * H
        return (
          <g key={d.day}>
            <rect x={i * bw + bw * 0.15} y={H - h} width={bw * 0.7} height={Math.max(h, 1)} rx="2">
              <title>{`${d.day} · ${duration(d.workMs)}`}</title>
            </rect>
            {data.length <= 14 || i % Math.ceil(data.length / 10) === 0 ? (
              <text x={i * bw + bw / 2} y={H + 13} textAnchor="middle">
                {d.day.slice(5).replace('-', '/')}
              </text>
            ) : null}
          </g>
        )
      })}
    </svg>
  )
}

function Heat({ heat }: { heat: number[][] }) {
  const days = ['일', '월', '화', '수', '목', '금', '토']
  const max = Math.max(1, ...heat.flat())
  const c = 22
  return (
    <svg className="chart heat" viewBox={`0 0 ${30 + 24 * c} ${7 * c + 16}`} role="img" aria-label="요일·시간별 활동">
      {heat.map((row, d) =>
        row.map((v, h) => (
          <rect key={`${d}-${h}`} x={30 + h * c} y={d * c} width={c - 3} height={c - 3} fill="var(--accent)" fillOpacity={v ? 0.15 + (v / max) * 0.85 : 0.05}>
            <title>{`${days[d]} ${h}시 · ${v}`}</title>
          </rect>
        )),
      )}
      {days.map((d, i) => (
        <text key={d} x="4" y={i * c + 14}>
          {d}
        </text>
      ))}
      {[0, 6, 12, 18].map((h) => (
        <text key={h} x={30 + h * c} y={7 * c + 12}>
          {h}시
        </text>
      ))}
    </svg>
  )
}

function BarList({ items }: { items: { name: string; value: number; label: string; full?: string }[] }) {
  const max = Math.max(1, ...items.map((i) => i.value))
  return (
    <div className="bar-list">
      {items.map((i) => (
        <div key={i.name} className="bar-item">
          <span className="name" title={i.full ?? i.name}>
            {i.name}
          </span>
          <span className="track">
            <i style={{ width: `${(i.value / max) * 100}%` }} />
          </span>
          <span className="muted">{i.label}</span>
        </div>
      ))}
    </div>
  )
}

export function StatsPage() {
  const wide = useWide()
  const [days, setDays] = useState('7')
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setStats(null)
    setError(null)
    get<Stats>(`/api/stats?days=${days}`).then(setStats, (e) => setError(errorText(e)))
  }, [days, attempt])
  return (
    <div className="main">
      <div className="topbar">
        {!wide ? <IconButton icon="back" label="뒤로" onClick={back} /> : null}
        <div className="topbar-title">
          <b>사용 통계</b>
        </div>
        <Segmented label="기간" value={days} onChange={setDays} options={['1', '7', '30', '90'].map((d) => ({ value: d, label: d === '1' ? '오늘' : `${d}일` }))} />
      </div>
      <div className="scroll">
        <div className="page">
          {error ? (
            <LoadError what="통계를" error={error} onRetry={() => setAttempt((n) => n + 1)} />
          ) : !stats ? (
            <div style={{ display: 'grid', placeItems: 'center', padding: 40 }}>
              <Spinner />
            </div>
          ) : !stats.totals.work && !stats.totals.busy ? (
            <Empty icon="chart" title={days === '1' ? '오늘은 아직 기록이 없어요' : `최근 ${days}일 동안 기록이 없어요`}>
              세션이 일하면 일한 시간과 PR 이 여기에 쌓여요. 위에서 기간을 늘려 볼 수도 있어요.
            </Empty>
          ) : (
            <div className="stack">
              <div className="tiles">
                <div className="tile">
                  <b>{duration(stats.totals.work)}</b>
                  <span>세션이 일한 시간</span>
                </div>
                <div className="tile">
                  <b>{duration(stats.totals.busy)}</b>
                  <span>하나라도 일한 시간</span>
                </div>
                <div className="tile">
                  <b>{stats.totals.avgConcurrency}</b>
                  <span>평균 동시 세션 (최대 {stats.totals.peakConcurrency})</span>
                </div>
                <div className="tile">
                  <b>{stats.turns.count}</b>
                  <span>턴 · 중간 {stats.turns.medianMs ? duration(stats.turns.medianMs) : '-'}</span>
                </div>
                <div className="tile">
                  <b>{stats.tools}</b>
                  <span>도구 호출</span>
                </div>
                <div className="tile">
                  <b>{stats.permissions}</b>
                  <span>권한 요청</span>
                </div>
                {stats.pr ? (
                  <div className="tile">
                    <b>{stats.pr.merged}</b>
                    <span>
                      머지한 PR · 만든 PR {stats.pr.created}
                      {stats.pr.medianMergeMs ? ` · 머지까지 ${duration(stats.pr.medianMergeMs)}` : ''}
                    </span>
                  </div>
                ) : null}
              </div>
              <section className="card-box">
                <h2 style={{ marginTop: 0 }}>동시에 돈 세션</h2>
                <Line data={stats.series} />
              </section>
              {stats.daily.length > 1 ? (
                <section className="card-box">
                  <h2 style={{ marginTop: 0 }}>날마다 일한 시간</h2>
                  <Bars data={stats.daily} />
                </section>
              ) : null}
              <section className="card-box">
                <h2 style={{ marginTop: 0 }}>요일 · 시간</h2>
                <Heat heat={stats.heat} />
              </section>
              {stats.topFolders.length ? (
                <section className="card-box">
                  <h2 style={{ marginTop: 0 }}>폴더</h2>
                  <BarList items={stats.topFolders.map((f) => ({ name: folderPath(f.cwd), full: f.cwd, value: f.workMs, label: duration(f.workMs) }))} />
                </section>
              ) : null}
              {stats.topTools.length ? (
                <section className="card-box">
                  <h2 style={{ marginTop: 0 }}>도구</h2>
                  <BarList items={stats.topTools.map((t) => ({ name: t.name, value: t.count, label: String(t.count) }))} />
                </section>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
