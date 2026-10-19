// 성능 리포트: the scores of every measurement run (docs/QUALITY-RUBRIC.md), page by page, mobile and desktop,
// and how they moved from run to run. The data is server/quality.json, written by each measurement and shipped
// with the deploy; nothing here is measured in the browser.
import { useEffect, useState } from 'react'
import { errorText, get } from '../lib/api'
import { back } from '../lib/router'
import { Empty, IconButton, Spinner, useWide } from '../kit'

type Cell = { perf?: number; interactive?: number; ux?: number; cls?: number }
type Run = {
  id: string
  at: string
  build: string
  label: string
  notes?: string[]
  pages: Record<string, { mobile?: Cell; desktop?: Cell }>
  server?: Record<string, number>
  interactions?: Record<string, number>
}
type Quality = { rubric?: string; pages: { name: string; label: string; path: string }[]; runs: Run[] }
type Metric = 'perf' | 'interactive' | 'ux'
type Form = 'mobile' | 'desktop'

const METRICS: { key: Metric; label: string; hint: string }[] = [
  { key: 'perf', label: '로딩 성능', hint: 'Lighthouse 12, 3회 중앙값 · CLS·LCP 상한' },
  { key: 'interactive', label: '인터렉티브 성능', hint: '누르기·열고 닫기·끌기·치기·굴리기의 응답과 매끄러움' },
  { key: 'ux', label: 'UX', hint: '접근성·키보드·반응·상태 화면·휴리스틱' },
]
const FORMS: { key: Form; label: string }[] = [
  { key: 'mobile', label: '모바일' },
  { key: 'desktop', label: '데스크톱' },
]
const SERVER: { key: string; label: string; unit: string; better: 'low' | 'high' }[] = [
  { key: 'eventsP50Ms', label: '대화 한 쪽 응답 p50', unit: 'ms', better: 'low' },
  { key: 'events10wideP95Ms', label: '10개 동시 p95', unit: 'ms', better: 'low' },
  { key: 'statsP50Ms', label: '통계 응답 p50', unit: 'ms', better: 'low' },
  { key: 'renameBytes', label: '이름 바꾸기 1번의 전송량', unit: 'B', better: 'low' },
  { key: 'mainJsKB', label: '첫 로딩 메인 JS(전송)', unit: 'KB', better: 'low' },
  { key: 'rssAfterMB', label: '부하 뒤 서버 메모리', unit: 'MB', better: 'low' },
]

/** Good / needs work / poor, by Lighthouse's own colour bands; always with its words, never colour alone. */
const grade = (v?: number) => (v == null ? '' : v >= 90 ? 'good' : v >= 50 ? 'mid' : 'bad')
const shortDate = (iso: string) => {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The average and the lowest score of one metric in one run, over the pages that run measured. */
function summary(run: Run, metric: Metric, form: Form) {
  const vals = Object.values(run.pages)
    .map((p) => p[form]?.[metric])
    .filter((v): v is number => typeof v === 'number')
  if (!vals.length) return null
  return { avg: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length), min: Math.min(...vals), n: vals.length }
}

/**
 * One metric over the runs: two lines (mobile, desktop), 0–100 with the 90 line marked. A point per run that
 * measured it; hover (or focus) a point for the exact numbers. Small multiples, one axis each.
 */
function Trend({ runs, metric }: { runs: Run[]; metric: Metric }) {
  const [hover, setHover] = useState<{ run: Run; form: Form; x: number; y: number } | null>(null)
  // Drawn at about the size it is shown, so its text stays readable (11 px) on a phone and on a PC.
  const W = 340
  const H = 150
  const L = 26
  const B = 22
  const x = (i: number) => (runs.length < 2 ? L + (W - L) / 2 : L + 8 + (i * (W - L - 16)) / (runs.length - 1))
  const y = (v: number) => 8 + ((100 - v) / 100) * (H - B - 8)
  const series = FORMS.map((f) => ({ form: f, pts: runs.map((r, i) => ({ r, i, s: summary(r, metric, f.key) })).filter((p) => p.s) }))
  const any = series.some((s) => s.pts.length)
  return (
    <figure className="q-trend">
      <figcaption>
        <b>{METRICS.find((m) => m.key === metric)!.label}</b>
        <span className="muted">화면 평균 · 기록마다</span>
        <span className="q-legend">
          {FORMS.map((f, k) => (
            <span key={f.key}>
              <i className={`q-swatch q-s${k + 1}`} aria-hidden />
              {f.label}
            </span>
          ))}
        </span>
      </figcaption>
      {!any ? (
        <p className="muted q-none">아직 잰 기록이 없어요</p>
      ) : (
        <div className="q-plot">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${METRICS.find((m) => m.key === metric)!.label} 추이`} onMouseLeave={() => setHover(null)}>
            {[0, 50, 90, 100].map((v) => (
              <g key={v}>
                <line x1={L} x2={W} y1={y(v)} y2={y(v)} className={v === 90 ? 'q-ref' : 'q-grid'} />
                <text x={L - 6} y={y(v) + 4} textAnchor="end" className="q-tick">
                  {v}
                </text>
              </g>
            ))}
            {runs.map((r, i) => (
              <text key={r.id} x={x(i)} y={H - 6} textAnchor={runs.length > 1 && i === runs.length - 1 ? 'end' : runs.length > 1 && i === 0 ? 'start' : 'middle'} className="q-tick">
                {shortDate(r.at)}
              </text>
            ))}
            {series.map(({ form, pts }, k) => (
              <g key={form.key} className={`q-s${k + 1}`}>
                {pts.length > 1 ? <polyline points={pts.map((p) => `${x(p.i)},${y(p.s!.avg)}`).join(' ')} className="q-line" /> : null}
                {pts.map((p) => (
                  <circle
                    key={p.r.id}
                    cx={x(p.i)}
                    cy={y(p.s!.avg)}
                    r={5}
                    className="q-dot"
                    tabIndex={0}
                    aria-label={`${shortDate(p.r.at)} ${form.label} 평균 ${p.s!.avg}점, 가장 낮은 화면 ${p.s!.min}점, ${p.s!.n}개 화면`}
                    onMouseEnter={() => setHover({ run: p.r, form: form.key, x: x(p.i), y: y(p.s!.avg) })}
                    onFocus={() => setHover({ run: p.r, form: form.key, x: x(p.i), y: y(p.s!.avg) })}
                    onBlur={() => setHover(null)}
                  />
                ))}
              </g>
            ))}
            {(() => {
              // The latest value of each line, beside its last point; the higher one above, the lower below.
              const ends = series.map(({ form, pts }) => ({ form, last: pts.at(-1) })).filter((e) => e.last)
              const top = Math.max(...ends.map((e) => e.last!.s!.avg))
              return ends.map(({ form, last }, k) => {
                const above = last!.s!.avg === top && (k === 0 || ends[0].last!.s!.avg !== top)
                return (
                  <text key={form.key} x={x(last!.i)} y={y(last!.s!.avg) + (above ? -9 : 17)} textAnchor="end" className="q-direct">
                    {last!.s!.avg}
                  </text>
                )
              })
            })()}
          </svg>
          {hover ? (
            <div className="q-tip" style={{ left: `${(hover.x / W) * 100}%`, top: `${(hover.y / H) * 100}%` }} role="status">
              <b>{hover.run.label}</b>
              <span>
                {shortDate(hover.run.at)} · {hover.run.build}
              </span>
              {(() => {
                const s = summary(hover.run, metric, hover.form)!
                return (
                  <span>
                    {FORMS.find((f) => f.key === hover.form)!.label} 평균 <b>{s.avg}</b> · 최저 {s.min} · {s.n}개 화면
                  </span>
                )
              })()}
            </div>
          ) : null}
        </div>
      )}
    </figure>
  )
}

function ScoreCell({ v, prev }: { v?: number; prev?: number }) {
  if (v == null) return <td className="q-cell q-empty">–</td>
  const d = prev == null ? null : v - prev
  return (
    <td className={`q-cell q-${grade(v)}`}>
      <b>{v}</b>
      {d ? <span className={`q-delta ${d > 0 ? 'up' : 'down'}`}>{d > 0 ? `+${d}` : d}</span> : null}
    </td>
  )
}

export function QualityPage() {
  const wide = useWide()
  const [q, setQ] = useState<Quality | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [runId, setRunId] = useState<string>('')
  useEffect(() => {
    get<Quality>('/api/quality').then(
      (d) => (setQ(d), setRunId(d.runs.at(-1)?.id ?? '')),
      (e) => setError(errorText(e)),
    )
  }, [])
  const runs = q?.runs ?? []
  const i = runs.findIndex((r) => r.id === runId)
  const run = runs[i]
  // The score a page had last time it was measured before this run, for the change beside each cell.
  const prevOf = (page: string, form: Form, metric: Metric) => {
    for (let k = i - 1; k >= 0; k--) {
      const v = runs[k].pages[page]?.[form]?.[metric]
      if (v != null) return v
    }
    return undefined
  }
  const serverRuns = runs.filter((r) => r.server)
  return (
    <div className="main">
      <div className="topbar">
        {!wide ? <IconButton icon="back" label="뒤로" onClick={back} /> : null}
        <div className="topbar-title">
          <b>성능 리포트</b>
          <span>화면별 점수와 개선 기록</span>
        </div>
      </div>
      <div className="scroll">
        {error ? (
          <Empty icon="warn" title="리포트를 불러오지 못했어요">
            {error}
          </Empty>
        ) : !q ? (
          <div className="page-wait" role="status" aria-label="불러오는 중">
            <Spinner />
          </div>
        ) : !runs.length ? (
          <Empty icon="chart" title="아직 측정 기록이 없어요" />
        ) : (
          <div className="page stack">
            <section className="card-box">
              <h2 style={{ marginTop: 0 }}>추이</h2>
              <p className="muted q-intro">
                점수는 <code>{q.rubric ?? 'docs/QUALITY-RUBRIC.md'}</code> 기준이에요. 90점 이상이 좋음, 50–89 개선 필요, 50 미만 나쁨. 같은 빌드를 고정한 데이터로 재요.
              </p>
              <div className="q-trends">
                {METRICS.map((m) => (
                  <Trend key={m.key} runs={runs} metric={m.key} />
                ))}
              </div>
            </section>

            <section className="card-box">
              <div className="hstack q-head">
                <h2 style={{ margin: 0 }} className="grow">
                  화면별 점수
                </h2>
                <select className="input q-run" value={runId} onChange={(e) => setRunId(e.target.value)} aria-label="기록 고르기">
                  {[...runs].reverse().map((r) => (
                    <option key={r.id} value={r.id}>
                      {shortDate(r.at)} · {r.label}
                    </option>
                  ))}
                </select>
              </div>
              {run?.notes?.length ? (
                <ul className="q-notes">
                  {run.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              ) : null}
              <div className="q-table-wrap">
                <table className="q-table">
                  <thead>
                    <tr>
                      <th rowSpan={2}>화면</th>
                      {FORMS.map((f) => (
                        <th key={f.key} colSpan={3} className="q-group">
                          {f.label}
                        </th>
                      ))}
                    </tr>
                    <tr>
                      {FORMS.flatMap((f) =>
                        METRICS.map((m) => (
                          <th key={`${f.key}-${m.key}`} title={m.hint}>
                            {m.key === 'perf' ? '로딩' : m.key === 'interactive' ? '인터렉티브' : 'UX'}
                          </th>
                        )),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {q.pages.map((p) => (
                      <tr key={p.name}>
                        <th scope="row">
                          {p.label}
                          <span className="q-path">{p.path}</span>
                        </th>
                        {FORMS.flatMap((f) => METRICS.map((m) => <ScoreCell key={`${f.key}-${m.key}`} v={run?.pages[p.name]?.[f.key]?.[m.key]} prev={prevOf(p.name, f.key, m.key)} />))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted q-foot">칸 옆의 +/− 는 그 화면을 바로 앞서 잰 기록과 비교한 변화예요. – 는 이 기록에서 재지 않은 칸이에요.</p>
            </section>

            {serverRuns.length ? (
              <section className="card-box">
                <h2 style={{ marginTop: 0 }}>서버</h2>
                <p className="muted q-intro">세션 40개·이벤트 8,000개 대화로 같은 요청을 100번 보내 쟀어요.</p>
                <div className="q-table-wrap">
                  <table className="q-table q-server">
                    <thead>
                      <tr>
                        <th>항목</th>
                        {serverRuns.map((r) => (
                          <th key={r.id}>
                            {shortDate(r.at)}
                            <span className="q-path">{r.label}</span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {SERVER.map((m) => (
                        <tr key={m.key}>
                          <th scope="row">{m.label}</th>
                          {serverRuns.map((r, k) => {
                            const v = r.server?.[m.key]
                            const p = k ? serverRuns[k - 1].server?.[m.key] : undefined
                            const pct = v != null && p ? Math.round(((v - p) / p) * 100) : null
                            return (
                              <td key={r.id} className="q-cell">
                                {v == null ? '–' : `${v.toLocaleString()} ${m.unit}`}
                                {pct ? <span className={`q-delta ${(pct < 0) === (m.better === 'low') ? 'up' : 'down'}`}>{pct > 0 ? `+${pct}%` : `${pct}%`}</span> : null}
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
