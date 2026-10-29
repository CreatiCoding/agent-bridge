// For operators: who may sign in, and how every user's Macs are doing. Conversations are not visible here.
import { useEffect, useState } from 'react'
import { del, errorText, get, post } from '../lib/api'
import { ago, batteryLine, batteryLow, bytes, duration, hostBattery, sysLine, type Battery, type SysUse } from '../lib/format'
import { getPref, setPref } from '../lib/local'
import { back, go } from '../lib/router'
import { NONE, useStore } from '../lib/store'
import { Badge, Button, Empty, Icon, IconButton, LoadError, Row, Spinner, Switch } from '../kit'
import { confirmDialog, promptDialog, toast } from '../kit/overlay'
import { ConfigBox } from './admin-config'

interface Access {
  open: boolean
  entries: { login: string; name: string; avatar: string; allowed: boolean; by: string; status: string; admin: boolean; signedUp: boolean; lastAt: number | null; attempts: number; hosts: number; heldBy?: string | null; heldAttempt?: { name: string; at: number } | null }[]
}
interface Overview {
  pending: number
  server: { version: string; agentBuild: string; github?: boolean; originSet?: boolean; root?: boolean; agentSigned?: boolean; agentSeqBack?: boolean; uptime: number; rss: number; bridges: number; controls: number; sessions: number }
  users: { login: string; allowed: boolean; hosts: { id: string; name: string; online: boolean; agent: string | null; build: string | null; outdated: boolean; updateBlocked?: boolean; key?: KeyState | null; sys?: SysUse | null; battery?: (Battery & { at: number }) | null; sessions: number; problem: string | null }[] }[]
}

/** The agent key as the agent reports it (REQ-S-065): no key, only when it changed and how the link tabs follow it. */
interface KeyState {
  gen: number | null
  latest: number | null
  at: number | null
  oldUntil: number | null
  /** When the key changes by itself (1.319); absent from older agents. */
  next?: number | null
  /** The last key changes, newest first (1.321); absent from older agents. */
  log?: { at: number; why: 'auto' | 'site' | 'gen' | null; took: number | null; result: 'took' | 'waiting' | 'missed' | null }[]
  retired: number
  linked: 'current' | 'old' | null
  stale: { at: number; app: string | null } | null
  reopen: { at: number; app: string | null; ok?: boolean } | null
}

const BROWSERS: Record<string, string> = { 'com.google.Chrome': 'Chrome', 'com.apple.Safari': 'Safari', 'com.microsoft.edgemac': 'Edge', 'org.mozilla.firefox': 'Firefox' }
const browserName = (app: string | null) => (app ? (BROWSERS[app] ?? app) : '다른 브라우저')

/** A tab came back with a retired key and nothing opened the link page again after it (within the last hour). */
const keyStuck = (k: KeyState) => !!k.stale && Date.now() - k.stale.at < 3_600_000 && !(k.reopen?.ok && k.reopen.at >= k.stale.at - 1000)

/** One Mac's key at a glance: badge and line. Null: an agent from before 1.224 sends none. */
function keyView(k: KeyState | null | undefined, online: boolean): { tone: 'green' | 'amber' | 'grey'; badge: string; line: string } | null {
  if (!k) return null
  const old = (k.gen ?? 1) < (k.latest ?? 1)
  const parts = [old ? '1.140 이전에 만든 키' : k.at ? `${ago(k.at)} 바꿈` : '처음 키']
  if (k.next && !old) parts.push(k.next <= Date.now() ? '자동 교체 대기' : `${Math.max(1, Math.round((k.next - Date.now()) / 3_600_000))}시간 뒤 자동 교체`)
  parts.push(!online ? '연동 탭 모름' : k.linked === 'current' ? '연동 탭이 지금 키' : k.linked === 'old' ? '연동 탭이 이전 키' : '연동 탭 없음')
  const last = k.log?.[0]
  if (last) {
    const why = last.why === 'auto' ? '자동' : last.why === 'site' ? '사이트' : last.why === 'gen' ? '옛 세대' : ''
    parts.push(`${why} 교체 ${ago(last.at)}: ${last.result === 'took' && last.took ? `탭이 ${Math.max(1, Math.round((last.took - last.at) / 1000))}초 뒤 새 키로 옴` : last.result === 'missed' ? '탭이 새 키로 오지 않음' : '탭을 기다리는 중'}`)
  }
  if (k.oldUntil) parts.push(`이전 키는 ${Math.max(1, Math.round((k.oldUntil - Date.now()) / 60_000))}분 뒤 끝남`)
  if (k.retired) parts.push(`예전 키 ${k.retired}개 기억`)
  if (k.stale) parts.push(`예전 키로 온 탭 ${ago(k.stale.at)} (${browserName(k.stale.app)})`)
  if (k.reopen) parts.push(`${browserName(k.reopen.app)} 에 연동 페이지 ${k.reopen.ok === false ? '다시 열지 못함' : '다시 엶'} ${ago(k.reopen.at)}`)
  const stuck = keyStuck(k) || last?.result === 'missed'
  const tone = !online || !k.linked ? 'grey' : old || k.linked === 'old' || stuck ? 'amber' : 'green'
  const badge = old ? '키 옛것' : stuck ? '키 확인' : !online || !k.linked ? '키 —' : k.linked === 'old' ? '키 바꾸는 중' : '키 정상'
  return { tone, badge, line: parts.join(' · ') }
}

/** 제보 (REQ-F-736): one line of the list. */
interface ReportItem {
  id: string
  at: number
  login: string
  text: string
  images: number
  videos?: number
  status: 'new' | 'fixing'
  fix: { sid: string; at: number; by: string; auto?: boolean } | null
  auto: { tries: number; at: number; error: string | null } | null
  where: string | null
  host: string | null
}
/** 자동 대응 (REQ-F-738). */
interface ReportAuto {
  on: boolean
  by: string | null
  since: number | null
  cwd: string
  /** The Mac it starts sessions on; null: the first one connected. */
  hostId: string | null
}
interface Report {
  id: string
  at: number
  login: string
  text: string
  images: string[]
  videos?: { id: string; name: string; type: string; size: number }[]
  status: 'new' | 'fixing'
  fix: { sid: string; at: number; by: string; open: boolean; auto?: boolean } | null
  debug: { client: Record<string, unknown> & { errors?: { at: number; kind: string; text: string }[] }; server: Record<string, unknown>; hosts: Record<string, unknown>[]; session: Record<string, unknown> | null; logs: Record<string, { at?: number; level?: string; area?: string; text?: string }[]> }
}

const firstLine = (t: string) => t.split('\n').find((l) => l.trim())?.trim() ?? ''

function ReportsBox({ list, onRetry, onRemoved }: { list: ReportItem[] | null; onRetry: () => void; onRemoved: (id: string) => void }) {
  const remove = async (r: ReportItem) => {
    if (!(await confirmDialog('이 제보를 지울까요?', { text: '목록에서 사라지고 되돌릴 수 없어요.', ok: '지우기', danger: true }))) return
    try {
      await del(`/api/reports/${r.id}`)
      onRemoved(r.id)
      toast('제보를 지웠어요')
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
  }
  if (!list) return <LoadError what="제보 목록을" onRetry={onRetry} />
  if (!list.length)
    return (
      <Empty icon="support" title="아직 제보가 없어요">
        누군가 앱 레일의 서비스센터 버튼(폰은 ⋯ 메뉴의 "문제 제보")으로 제보하면 여기에 떠요.
      </Empty>
    )
  return (
    <div className="card-box">
      {list.map((r) => (
        <div key={r.id} className="report-line">
        <Row
          title={
            <span className="hstack" style={{ gap: 6, minWidth: 0 }}>
              <Badge tone={r.status === 'new' ? 'amber' : 'blue'}>{r.status === 'new' ? '새 제보' : r.fix?.auto ? '자동 대응 중' : '고치는 중'}</Badge>
              <span className="ellipsis">{firstLine(r.text) || (r.images ? `그림 ${r.images}장` : `영상 ${r.videos ?? 0}개`)}</span>
            </span>
          }
          sub={`${r.login} · ${ago(r.at)}${r.images ? ` · 그림 ${r.images}장` : ''}${r.videos ? ` · 영상 ${r.videos}개` : ''}${r.host ? ` · ${r.host}` : ''}${r.where ? ` · ${r.where}` : ''}${r.status === 'new' && r.auto?.error ? ` · 자동 대응 실패: ${r.auto.error}` : ''}`}
          onClick={() => go({ name: 'report', id: r.id })}
          chevron
        />
        <IconButton icon="trash" label="이 제보 지우기" onClick={() => void remove(r)} />
        </div>
      ))}
    </div>
  )
}

/** 자동 대응: while on, each new report gets a session on the operator's Mac that fixes it through to the deploy. */
function ReportAutoBox({ initial }: { initial: ReportAuto }) {
  const [a, setA] = useState(initial)
  const [cwd, setCwd] = useState(initial.cwd)
  const [busy, setBusy] = useState(false)
  const hosts = useStore((st) => st.state?.hosts ?? NONE)
  const picked = hosts.find((h) => h.id === a.hostId)
  // The picked one while it is connected, else the first one connected (as the server does).
  const mac = picked?.online ? picked : hosts.find((h) => h.online)
  const send = async (body: Partial<ReportAuto>, note?: string) => {
    setBusy(true)
    try {
      const r = await post<ReportAuto>('/api/admin/reports/auto', body)
      setA(r)
      setCwd(r.cwd)
      if (note) toast(note)
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
    setBusy(false)
  }
  const saveCwd = () => void (cwd.trim() && cwd.trim() !== a.cwd ? send({ cwd: cwd.trim() }, '폴더를 바꿨어요') : setCwd(a.cwd))
  return (
    <div className="card-box stack" style={{ marginBottom: 8 }}>
      <div className="hstack" style={{ alignItems: 'flex-start' }}>
        <span className="grow">
          <b style={{ fontSize: 'var(--fs-medium)' }}>자동 대응</b>
          <div className="muted" style={{ fontSize: 'var(--fs-small)' }}>
            {a.on
              ? `켜짐 · ${a.by ?? '?'} 가 ${a.since ? ago(a.since) : ''} 켰어요. 새 제보가 오면 ${mac ? mac.name : '내 맥'} 에 세션을 띄워요. 운영자의 제보는 전부 허용으로 묻지 않고 배포 확인까지, 다른 사람의 제보는 명령마다 확인을 받으며 고쳐요.`
              : '켜 두면 새 제보마다 내 맥에 세션을 띄워 고쳐요. 운영자의 제보는 묻지 않고 배포 확인까지, 다른 사람의 제보는 명령마다 확인을 받아요. 켜면 지금 기다리는 새 제보부터 바로 시작해요.'}
          </div>
        </span>
        <Switch label="제보 자동 대응" checked={a.on} disabled={busy} onChange={(on) => send({ on, cwd: cwd.trim() || a.cwd }, on ? '자동 대응을 켰어요' : '자동 대응을 껐어요')} />
      </div>
      <label className="field" style={{ margin: 0 }}>
        <span className="field-label">폴더 (내 맥에서 고칠 저장소)</span>
        <input className="input mono" value={cwd} disabled={busy} onChange={(e) => setCwd(e.target.value)} onBlur={saveCwd} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} spellCheck={false} autoCapitalize="off" />
      </label>
      <label className="field" style={{ margin: 0 }}>
        <span className="field-label">맥 (세션을 띄울 곳)</span>
        <select className="input" value={a.hostId ?? ''} disabled={busy} onChange={(e) => void send({ hostId: e.target.value || null }, '맥을 바꿨어요')}>
          <option value="">연결된 첫 맥</option>
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>{`${h.name}${h.online ? '' : ' (연결 안 됨)'}`}</option>
          ))}
          {a.hostId && !picked ? <option value={a.hostId}>다른 운영자의 맥</option> : null}
        </select>
      </label>
      {a.hostId && picked && !picked.online ? <div className="muted" style={{ fontSize: 'var(--fs-small)' }}>{`${picked.name} 가 연결돼 있지 않아 지금은 ${mac ? mac.name : '연결된 맥'} 에 띄워요.`}</div> : null}
    </div>
  )
}

/** Debugging details folded under a heading, opened one at a time. */
function Fold({ title, children, open: start = false }: { title: string; children: React.ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(start)
  return (
    <div className="report-fold">
      <button type="button" className="report-peek" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="grow">{title}</span>
        <Icon name="forward" className={`chev${open ? ' chev-open' : ''}`} />
      </button>
      {open ? <div className="report-fold-body">{children}</div> : null}
    </div>
  )
}
const json = (v: unknown) => <pre className="report-debug">{JSON.stringify(v, null, 2)}</pre>

/** One report: what was said, the pictures, the debugging details, and 이 오류 고치기 (REQ-F-737). */
export function ReportPage({ id }: { id: string }) {
  const [r, setR] = useState<Report | null>(null)
  const [err, setErr] = useState<unknown>(null)
  const [cwd, setCwd] = useState(() => getPref('reportFixCwd', ''))
  const [busy, setBusy] = useState(false)
  const [zoom, setZoom] = useState<string | null>(null)
  const hosts = useStore((st) => st.state?.hosts ?? NONE)
  const mine = hosts.filter((h) => h.online)
  const [hostId, setHostId] = useState(() => getPref('reportFixHost', ''))
  const mac = mine.find((h) => h.id === hostId) ?? mine[0]
  const load = () => (setErr(null), get<{ report: Report }>(`/api/admin/reports/${id}`).then((x) => setR(x.report), (e) => setErr(e ?? true)))
  useEffect(() => void load(), [id])
  const fix = async () => {
    setBusy(true)
    setPref('reportFixCwd', cwd.trim())
    setPref('reportFixHost', mac?.id ?? '')
    try {
      const x = await post<{ ok: true; id: string }>(`/api/admin/reports/${id}/fix`, { cwd: cwd.trim() || '~', hostId: mac?.id })
      go({ name: 'session', id: x.id })
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
      setBusy(false)
    }
  }
  const img = (name: string) => `/api/admin/reports/${id}/img/${name}`
  const d = r?.debug
  const c = d?.client ?? {}
  const scr = c.screen as { viewport?: string; dpr?: number } | undefined
  return (
    <div className="main">
      <div className="topbar">
        <IconButton icon="back" label="뒤로" onClick={() => (history.length > 1 ? back() : go({ name: 'settings', tab: 'admin' }))} />
        <div className="topbar-title">
          <b>제보</b>
          {r ? <span className="muted">{`${r.login} · ${ago(r.at)}`}</span> : null}
        </div>
      </div>
      <div className="scroll">
        {err ? (
          <div className="page">
            <LoadError what="제보를" error={err} onRetry={() => void load()} />
          </div>
        ) : !r ? (
          <div className="page-wait" role="status" aria-label="불러오는 중">
            <Spinner />
          </div>
        ) : (
          <div className="page stack">
            <section className="card-box stack">
              <div className="hstack" style={{ gap: 6, flexWrap: 'wrap' }}>
                <Badge tone={r.status === 'new' ? 'amber' : 'blue'}>{r.status === 'new' ? '새 제보' : r.fix?.auto ? '자동 대응 중' : '고치는 중'}</Badge>
                <span className="muted" style={{ fontSize: 'var(--fs-small)' }}>
                  {new Date(r.at).toLocaleString('ko-KR')} · {r.login}
                </span>
              </div>
              {r.text ? <p className="report-text">{r.text}</p> : <p className="muted">글 없이 그림·영상만 보냈어요.</p>}
              {r.images.length ? (
                <div className="report-pics big">
                  {r.images.map((n) => (
                    <button key={n} type="button" onClick={() => setZoom(img(n))} aria-label="크게 보기">
                      <img src={img(n)} alt="" loading="lazy" />
                    </button>
                  ))}
                </div>
              ) : null}
              {r.videos?.length ? (
                <div className="report-videos big">
                  {r.videos.map((v) => (
                    <video key={v.id} src={`/api/admin/reports/${id}/video/${v.id}`} controls preload="metadata" aria-label={v.name} />
                  ))}
                </div>
              ) : null}
            </section>
            <section className="card-box stack">
              <b>이 오류 고치기</b>
              {r.fix ? (
                <div className="hstack" style={{ flexWrap: 'wrap' }}>
                  <span className="muted grow" style={{ fontSize: 'var(--fs-small)' }}>
                    {`${r.fix.by} 가 ${ago(r.fix.at)} ${r.fix.auto ? '자동 대응으로 ' : ''}세션을 띄웠어요${r.fix.open ? '' : ' (끝난 세션)'}`}
                  </span>
                  <Button size="sm" icon="forward" onClick={() => go({ name: 'session', id: r.fix!.sid })}>
                    그 세션 열기
                  </Button>
                </div>
              ) : null}
              <label className="field" style={{ margin: 0 }}>
                <span className="field-label">폴더 (내 맥에서 고칠 저장소)</span>
                <input className="input mono" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~/projects/저장소" spellCheck={false} autoCapitalize="off" />
              </label>
              {mine.length > 1 ? (
                <label className="field" style={{ margin: 0 }}>
                  <span className="field-label">맥</span>
                  <select className="input" value={mac?.id ?? ''} onChange={(e) => setHostId(e.target.value)}>
                    {mine.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <div className="hstack" style={{ flexWrap: 'wrap' }}>
                <span className="muted grow" style={{ fontSize: 'var(--fs-small)' }}>
                  {mac ? `${mac.name} 에 새 세션을 「Bridge 제보 대응」 그룹으로 띄우고(폴더·그룹이 없으면 만들어요), 제보 글·그림·디버깅 정보를 첫 메시지로 보내요` : '연결된 내 맥이 없어요'}
                </span>
                <Button tone="primary" icon="bolt" busy={busy} disabled={!mine.length} onClick={() => void fix()}>
                  {r.fix ? '다시 고치기' : '이 오류 고치기'}
                </Button>
              </div>
            </section>
            {d ? (
              <section className="stack">
                <h2>디버깅 정보</h2>
                <div className="card-box">
                  <Row title="기기" sub={`${String(c.platform ?? '?')} · ${scr?.viewport ?? '?'} @${scr?.dpr ?? '?'}x · ${String(c.language ?? '')} · ${String(c.timeZone ?? '')}`} />
                  <Row title="보던 화면" sub={`${String(c.path ?? '?')} · ${String(c.page ?? '?')}`} />
                  <Row title="서버" sub={`${String(d.server.version ?? '?')} · 에이전트 build ${String(d.server.agentBuild ?? '?')}`} />
                  {d.session ? <Row title="보던 세션" sub={`${String(d.session.title ?? '')} · ${String(d.session.host ?? '')} · ${String((d.session.state as { phase?: string } | undefined)?.phase ?? '')}`} /> : null}
                  <Row title="화면 오류" sub={c.errors?.length ? `${c.errors.length}개 · 마지막: ${c.errors[c.errors.length - 1].text.slice(0, 120)}` : '없음'} />
                </div>
                <Fold title={`화면이 보낸 정보 · 오류 ${c.errors?.length ?? 0}개`}>{json(c)}</Fold>
                {d.session ? <Fold title="보던 세션">{json(d.session)}</Fold> : null}
                <Fold title={`맥 ${d.hosts.length}대`}>{json(d.hosts)}</Fold>
                {Object.entries(d.logs).map(([k, v]) => (
                  <Fold key={k} title={`${k === 'session' ? '보던 세션의 로그' : `${k} 의 경고·오류 로그`} · ${v.length}줄`}>
                    {v.length ? (
                      <pre className="report-debug">{v.map((e) => `${e.at ? new Date(e.at).toLocaleTimeString('ko-KR') : ''} ${e.level ?? ''} ${e.area ?? ''} ${e.text ?? ''}`).join('\n')}</pre>
                    ) : (
                      <p className="muted">없음</p>
                    )}
                  </Fold>
                ))}
                <Fold title="서버 정보">{json(d.server)}</Fold>
              </section>
            ) : null}
          </div>
        )}
      </div>
      {zoom ? (
        <button type="button" className="report-zoom" onClick={() => setZoom(null)} aria-label="닫기">
          <img src={zoom} alt="" />
        </button>
      ) : null}
    </div>
  )
}

interface Models {
  auto: boolean
  list: { label: string; value: string }[]
  checkedAt: number | null
  changedAt: number | null
  source: { hostId: string; name: string; version: string } | null
  error: string | null
  added: string[]
  removed: string[]
  everyMs: number
}

/** The new-session page's model list, kept in step with Claude Code's catalog (asked of a connected Mac). */
function ModelsBox({ initial, onRetry }: { initial: Models | null; onRetry: () => void }) {
  const [m, setM] = useState<Models | null>(initial)
  const [busy, setBusy] = useState(false)
  const send = async (body: Record<string, unknown>, note?: (r: Models) => string) => {
    setBusy(true)
    try {
      const r = await post<Models>('/api/admin/models', body)
      setM(r)
      if (note) toast(note(r), { tone: r.error ? 'bad' : 'ok' })
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
    setBusy(false)
  }
  if (!m) return <LoadError what="모델 목록을" onRetry={onRetry} />
  return (
    <div className="card-box stack">
      <div className="hstack" style={{ alignItems: 'flex-start' }}>
        <span className="grow">
          <b style={{ fontSize: 'var(--fs-medium)' }}>새 모델이 나오면 자동으로 갱신</b>
          <div className="muted" style={{ fontSize: 'var(--fs-small)' }}>
            {Math.round(m.everyMs / 3_600_000)}시간마다 연결된 맥의 Claude Code 에 모델 목록을 물어, 새 세션 화면의 모델 목록을 맞춰요.
          </div>
        </span>
        <Switch label="모델 목록 자동 갱신" checked={m.auto} disabled={busy} onChange={(auto) => send({ auto }, (r) => (r.auto ? '자동 갱신을 켰어요' : '자동 갱신을 껐어요'))} />
      </div>
      <div className="hstack" style={{ flexWrap: 'wrap' }}>
        <span className="muted grow" style={{ fontSize: 'var(--fs-small)' }}>
          {m.checkedAt ? `마지막 확인 ${ago(m.checkedAt)}` : '아직 확인한 적 없어요'}
          {m.source ? ` · ${m.source.name}${m.source.version ? ` · Claude Code ${m.source.version}` : ''}` : ''}
          {m.changedAt ? ` · 바뀐 때 ${ago(m.changedAt)}` : ''}
        </span>
        <Button size="sm" icon="refresh" busy={busy} onClick={() => send({ refresh: true }, (r) => r.error ?? (r.changedAt && Date.now() - r.changedAt < 60_000 ? `목록을 바꿨어요${r.added.length ? ` · 더함: ${r.added.join(', ')}` : ''}` : '바뀐 것이 없어요'))}>
          지금 확인
        </Button>
      </div>
      {m.error ? (
        <p className="guide-warn">
          <Icon name="warn" />
          <span>{m.error}</span>
        </p>
      ) : null}
      {m.changedAt && (m.added.length || m.removed.length) ? (
        <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-small)' }}>
          지난 변경 {m.added.length ? `· 더함: ${m.added.join(', ')} ` : ''}
          {m.removed.length ? `· 뺌: ${m.removed.join(', ')}` : ''}
        </p>
      ) : null}
      <div className="hstack" style={{ flexWrap: 'wrap', gap: 6 }}>
        {m.list.map((x) => (
          <span key={x.value} title={x.value}>
            <Badge>{x.label}</Badge>
          </span>
        ))}
      </div>
    </div>
  )
}

/** The settings page's 운영 tab (REQ-F-741): server, reports, models, access and everyone's Macs, for admins. */
export function AdminPanel() {
  const [access, setAccess] = useState<Access | null>(null)
  const [over, setOver] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<Models | null | undefined>(undefined)
  const [reports, setReports] = useState<ReportItem[] | null | undefined>(undefined)
  const [overDone, setOverDone] = useState(false)
  const [overErr, setOverErr] = useState<unknown>(null)
  // Each part that fails says so where it would be, with 다시 시도, instead of a spinner or a gap.
  const loadAccess = () => (setError(null), get<Access>('/api/admin/access').then(setAccess, (e) => setError(errorText(e))))
  const loadOver = () => (setOverErr(null), get<Overview>('/api/admin/overview').then(setOver, (e) => setOverErr(e ?? true)).finally(() => setOverDone(true)))
  const loadModels = () => get<Models>('/api/admin/models').then(setModels, () => setModels(null))
  const [auto, setAuto] = useState<ReportAuto | null>(null)
  const loadReports = () => get<{ reports: ReportItem[]; auto?: ReportAuto }>('/api/admin/reports').then((x) => (setReports(x.reports), setAuto(x.auto ?? null)), () => setReports(null))
  const load = () => {
    void loadAccess()
    void loadOver()
    void loadModels()
    void loadReports()
  }
  useEffect(load, [])
  // The page is drawn once everything it shows has arrived: drawn piece by piece, the tiles arriving last pushed
  // the sections below them down (a layout shift of 0.53 on a phone).
  const ready = (access || error) && overDone && models !== undefined && reports !== undefined
  const set = async (login: string, status: string) => {
    // Taking access away (회수, 거부) asks first: one press locked a person out.
    if (status === 'release' && !(await confirmDialog(`${login} 이름을 놓아 줄까요?`, { text: '지금은 이 이름으로 처음 로그인한 GitHub 계정만 쓸 수 있어요. 놓아 주면 다음에 이 이름으로 로그인하는 계정이 이 이름의 권한(허용·운영자)을 받아요. 그 계정이 맞는 사람인지 확인한 뒤에만 놓아 주세요. 지금 이 이름을 쓰는 계정은 곧바로 로그아웃되고 그 계정의 맥 연동도 끊겨요(내 이름이면 나도).', ok: '놓아 주기', danger: true }))) return
    if (status === 'denied' && !(await confirmDialog(`${login} 의 접근을 막을까요?`, { text: '그 계정은 이 사이트에 들어오지 못해요. 나중에 다시 허용할 수 있어요.', ok: '막기', danger: true }))) return
    try {
      setAccess(await post<Access>('/api/admin/access', { login, status }))
      toast('바꿨어요')
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
  }
  if (!ready)
    return (
      <div className="page-wait" role="status" aria-label="불러오는 중">
        <Spinner />
      </div>
    )
  return (
    <>
      {error ? <LoadError what="운영 정보를" error={error} onRetry={() => void loadAccess()} /> : null}
      {overErr ? <LoadError what="서버 개요를" error={overErr} onRetry={() => void loadOver()} /> : null}
      {over ? (
        <div className="tiles">
          <div className="tile">
            <b>{over.server.version}</b>
            <span>
              서버 · 켜진 지 {duration(over.server.uptime)} · {bytes(over.server.rss)}
              {over.server.originSet === false ? ' · BRIDGE_ORIGIN / origins.primary 없음' : ''}
              {over.server.root ? ' · root 로 실행 중' : ''}
            </span>
          </div>
          <div className="tile">
            <b>{over.server.agentBuild}</b>
            <span>
              최신 에이전트 build
              {over.server.agentSigned === false ? (over.server.agentSeqBack ? ' · 서명 순번이 뒤로 감, 업데이트 안 보냄' : ' · 서명 안 됨, 업데이트 안 보냄') : ''}
            </span>
          </div>
          <div className="tile">
            <b>{over.server.bridges}</b>
            <span>연결된 맥</span>
          </div>
          <div className="tile">
            <b>{over.server.controls}</b>
            <span>열린 조작 화면</span>
          </div>
          <div className="tile">
            <b>{over.server.sessions}</b>
            <span>세션</span>
          </div>
        </div>
      ) : null}
      <section>
        <h2>설정 파일</h2>
        <ConfigBox />
      </section>
      <section>
        <h2>제보{reports?.length ? ` · ${reports.filter((r) => r.status === 'new').length}개 새로` : ''}</h2>
        {auto ? <ReportAutoBox initial={auto} /> : null}
        <ReportsBox list={reports ?? null} onRetry={() => void loadReports()} onRemoved={(id) => setReports((l) => l?.filter((r) => r.id !== id))} />
      </section>
      <section>
        <h2>모델 목록</h2>
        <ModelsBox key={models ? 'm' : 'none'} initial={models ?? null} onRetry={() => void loadModels()} />
      </section>
      <section>
        {/* The h2's own margins go on the row, so the button sits level with the title. */}
        <div className="hstack" style={{ margin: '24px 0 8px' }}>
          <h2 className="grow" style={{ margin: 0 }}>접근 관리{access?.open ? ' · 누구나 허용 중(*)' : ''}</h2>
          <Button
            size="sm"
            icon="plus"
            onClick={async () => {
              const l = await promptDialog('계정 미리 허용', { placeholder: 'GitHub 계정 이름', ok: '허용' })
              if (l) await set(l.trim(), 'allowed')
            }}
          >
            계정 허용
          </Button>
        </div>
        {!access ? (
          error ? null : <Spinner />
        ) : !access.entries.length ? (
          <Empty icon="user" title="아직 로그인을 시도한 계정이 없어요">
            누군가 로그인하면 여기에 대기로 떠요. 위의 "계정 허용" 으로 미리 허용할 수도 있어요.
          </Empty>
        ) : (
          access.entries
            .sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || (b.lastAt ?? 0) - (a.lastAt ?? 0))
            .map((e) => (
              <Row
                key={e.login}
                left={e.avatar ? <img src={e.avatar} alt="" width={32} height={32} style={{ borderRadius: 16 }} /> : undefined}
                title={
                  <span className="hstack" style={{ gap: 6 }}>
                    {e.login}
                    {e.admin ? <Badge tone="violet">운영자</Badge> : null}
                    <Badge tone={e.allowed ? 'green' : e.status === 'denied' ? 'red' : 'amber'}>{e.allowed ? '허용' : e.status === 'denied' ? '거부' : '대기'}</Badge>
                    {e.heldBy ? <Badge tone="red">다른 계정이 쓰던 이름</Badge> : null}
                  </span>
                }
                sub={`${e.name && e.name !== e.login ? `${e.name} · ` : ''}${e.by === 'env' ? '서버 설정으로 허용' : ''}${e.lastAt ? ` 마지막 시도 ${ago(e.lastAt)}` : ''}${e.hosts ? ` · 맥 ${e.hosts}대` : ''}${e.heldAttempt ? ` · 다른 GitHub 계정(${e.heldAttempt.name})이 ${ago(e.heldAttempt.at)} 이 이름으로 로그인하려 함` : ''}`}
                right={
                  e.by === 'env' || e.admin ? (
                    e.heldBy ? (
                      <Button size="sm" onClick={() => set(e.login, 'release')}>
                        이름 놓아 주기
                      </Button>
                    ) : null
                  ) : (
                    <span className="hstack">
                      {e.heldBy ? (
                        <Button size="sm" onClick={() => set(e.login, 'release')}>
                          이름 놓아 주기
                        </Button>
                      ) : null}
                      {!e.allowed ? (
                        <Button size="sm" tone="primary" onClick={() => set(e.login, 'allowed')}>
                          허용
                        </Button>
                      ) : (
                        <Button size="sm" tone="danger" onClick={() => set(e.login, 'denied')}>
                          회수
                        </Button>
                      )}
                      {e.status === 'pending' ? (
                        <Button size="sm" onClick={() => set(e.login, 'denied')}>
                          거부
                        </Button>
                      ) : null}
                    </span>
                  )
                }
              />
            ))
        )}
      </section>
      {over ? (
        <section>
          <h2>사용자별 기기</h2>
          {!over.users.length ? <p className="muted">아직 맥을 연결한 사용자가 없어요.</p> : null}
          {over.users.map((u) => (
            <div key={u.login} className="card-box" style={{ marginBottom: 8 }}>
              <b>{u.login}</b>
              {u.hosts.length ? (
                u.hosts.map((h) => {
                  const kv = keyView(h.key, h.online)
                  const bat = hostBattery(h)
                  return (
                    <Row
                      key={h.id}
                      title={
                        <span className="hstack" style={{ gap: 6 }}>
                          {h.name}
                          {h.build ? <Badge tone={h.outdated || h.updateBlocked ? 'amber' : 'green'}>{h.updateBlocked ? '업데이트 보류' : h.outdated ? '최신 아님' : '최신'}</Badge> : null}
                          {kv ? <Badge tone={kv.tone}>{kv.badge}</Badge> : null}
                        </span>
                      }
                      sub={
                        <>
                          {`${h.online ? '연결됨' : '끊김'} · build ${h.build ?? '?'}${h.outdated ? ` (최신 ${over.server.agentBuild})` : ''} · 세션 ${h.sessions}${h.problem ? ` · ${h.problem}` : ''}`}
                          {kv || h.online ? (
                            <>
                              <br />
                              {kv ? `키: ${kv.line}` : '키: 이 에이전트는 키 상태를 보내지 않아요(1.224 이전)'}
                            </>
                          ) : null}
                          {h.online && h.sys && sysLine(h.sys) ? (
                            <>
                              <br />
                              {sysLine(h.sys)}
                            </>
                          ) : null}
                          {bat ? (
                            <>
                              <br />
                              <span style={batteryLow(bat.b) && !bat.at ? { color: 'var(--red)', fontWeight: 600 } : undefined}>{`${batteryLine(bat.b, true)}${bat.at ? ` · 마지막 값 ${ago(bat.at)}` : ''}`}</span>
                            </>
                          ) : null}
                        </>
                      }
                      right={<span className={`dot dot-${h.online ? 'green' : 'grey'}`} />}
                      onClick={() => go({ name: 'host', id: h.id })}
                      chevron
                    />
                  )
                })
              ) : (
                <p className="muted" style={{ margin: '4px 0 0' }}>
                  맥 없음
                </p>
              )}
            </div>
          ))}
        </section>
      ) : null}
    </>
  )
}
