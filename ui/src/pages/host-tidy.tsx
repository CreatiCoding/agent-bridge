// 세션 정리 (REQ-F-839): what the hourly tidy on a host would do or did, in three lists (sessions resting long,
// folders, big transcripts), with its mode and days, and the same steps by hand. Taking claude down leaves the
// conversation; folders and transcripts go to the Trash only, never deleted. The agent judges each again before acting.
import { useEffect, useRef, useState } from 'react'
import { errorText, post } from '../lib/api'
import { ago, bytes, clock } from '../lib/format'
import { Button, CardHead, Row, Spinner } from '../kit'
import { confirmDialog, toast } from '../kit/overlay'
import { createRecalc, type Recalc } from '../lib/recalc'
import { tidyGroups } from '../lib/tidy-groups'

type Mode = 'auto' | 'suggest' | 'off'
interface Policy {
  mode: Mode
  why?: 'observe' | 'owner' | null
  observeUntil?: number | null
  idleStopDays: number
  folderTrashDays: number
}
interface SessionRow {
  sid: string
  title?: string
  alive?: boolean
  lastHumanAt?: number
  from?: 'transcript' | 'server' | 'launch'
  idleDays: number
  act: 'suggest' | 'notice' | 'wait' | 'stop' | null
  why?: string | null
  stopAt?: number | null
  rest?: boolean
  close?: boolean
  keepAlive?: boolean
  favorite?: boolean
}
interface FileRow {
  path: string
  size?: number | null
  lastAt?: number | null
  auto?: boolean
  why?: string | null
}
interface Report {
  at: number
  mode: Mode
  sessions: SessionRow[]
  folders: FileRow[]
  transcripts: FileRow[]
}

const call = <T,>(hostId: string, body: Record<string, unknown>) => post<T>(`/api/hosts/${hostId}/tidy`, body)
const SESSION_UNDO = '대화는 그대로 남아요. 세션을 열고 글을 보내면 이어서 열려요.'
const TRASH_UNDO = '휴지통으로 옮겨요(영구 삭제 아님). macOS 는 Finder 의 휴지통, 우분투는 ~/.local/share/Trash 에서 되살릴 수 있어요. 공간은 휴지통을 비워야 늘어요.'
const FAVORITE_WHY = '즐겨찾기라 정리하지 않음'
const STOP_DAYS = [0, 1, 2, 3, 5, 7, 14]
const TRASH_DAYS = [0, 7, 14, 30]

function modeLine(p: Policy | null) {
  if (!p) return ''
  if (p.mode === 'off') return '꺼짐'
  if (p.mode === 'auto') return '자동'
  if (p.why === 'observe') return `처음 7일은 제안만 · ${p.observeUntil ? clock(p.observeUntil) : ''}부터 자동`
  if (p.why === 'owner') return '다른 사용자 기기라 제안만 · 주인이 켜면 자동'
  return '제안만'
}

function Pick<T extends string | number>({ label, value, options, text, onPick, disabled }: { label: string; value: T | ''; options: (T | '')[]; text: (v: T | '') => string; onPick: (v: T | '') => void; disabled?: boolean }) {
  return (
    <label className="hstack" style={{ gap: 6, fontSize: 'var(--fs-small)' }}>
      {label}
      <select value={String(value)} disabled={disabled} onChange={(e) => onPick((options.find((o) => String(o) === e.target.value) ?? '') as T | '')}>
        {options.map((o) => (
          <option key={String(o)} value={String(o)}>
            {text(o)}
          </option>
        ))}
      </select>
    </label>
  )
}

export function TidyBox({ hostId, online, onChange }: { hostId: string; online: boolean; onChange?: () => void }) {
  const [report, setReport] = useState<Report | null>(null)
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  // Rows acted on, by sid or path: dimmed as "처리 중" at once, gone when the recalculation comes back.
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [calculating, setCalculating] = useState(false)
  const recalc = useRef<Recalc | null>(null)
  const onlineRef = useRef(online)
  onlineRef.current = online
  // Someone else's host (REQ-F-804): its line comes from the operator's overview, read again after each recalculation.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const run = async (key: string, body: Record<string, unknown>, done?: string) => {
    setBusy(key)
    try {
      const r = await call<{ report?: Report | null; policy?: Policy }>(hostId, body)
      if (r.report !== undefined) setReport(r.report ?? null)
      if (r.policy) setPolicy(r.policy)
      if (done) toast(done)
      return true
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
      return false
    } finally {
      setBusy(null)
    }
  }
  const reload = () => run('report', { op: 'report' }).then(() => setLoaded(true))
  useEffect(() => {
    void reload()
    // 자동 다시 계산 (REQ-F-839 rule 9): the host works its tidy out again (IF-264 run) once a burst of actions is
    // over; offline, only the last report is read again.
    const r = createRecalc(async () => {
      setCalculating(true)
      try {
        const got = await call<{ report?: Report | null; policy?: Policy }>(hostId, { op: onlineRef.current ? 'run' : 'report' })
        if (got.report !== undefined) setReport(got.report ?? null)
        if (got.policy) setPolicy(got.policy)
        onChangeRef.current?.()
      } catch (e) {
        toast(errorText(e), { tone: 'bad' })
      } finally {
        setPending(new Set())
        setCalculating(false)
      }
    }, 1500)
    recalc.current = r
    return () => r.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId])
  const mark = (keys: string[]) => setPending((was) => new Set([...was, ...keys]))
  const unmark = (keys: string[]) =>
    setPending((was) => {
      const next = new Set(was)
      for (const k of keys) next.delete(k)
      return next
    })
  /** An action on rows: dims them now, and whether it worked or not, works the list out again after. */
  const act = async (keys: string[], doIt: () => Promise<boolean>) => {
    mark(keys)
    const ok = await doIt()
    if (!ok) unmark(keys)
    recalc.current?.kick()
  }
  const sessionSet = (row: SessionRow, body: Record<string, unknown>, done: string) =>
    act([row.sid], async () => {
      try {
        await post(`/api/sessions/${row.sid}/settings`, body)
        toast(done)
        return true
      } catch (e) {
        toast(errorText(e), { tone: 'bad' })
        return false
      }
    })

  const settings = (body: Record<string, unknown>) => act([], () => run('settings', { op: 'settings', scope: 'host', ...body }, '이 기기의 세션 정리 설정을 바꿨어요'))
  const stop = async (sids: string[], all: boolean) => {
    if (all && !(await confirmDialog(`세션 ${sids.length}개의 claude 를 내릴까요?`, { text: SESSION_UNDO, ok: '모두 종료' }))) return
    await act(sids, () => run('stop', { op: 'stop', sids }, all ? `${sids.length}개를 내렸어요` : '내렸어요 · 글을 보내면 이어서 열려요'))
  }
  const close = async (row: SessionRow) => {
    if (!(await confirmDialog(`"${row.title ?? row.sid}" 세션을 끝낼까요?`, { text: '대화는 남아요. 나중에 이어서 열 수 있어요.', ok: '끝내기', danger: true }))) return
    await act([row.sid], () => run('close', { op: 'close', sids: [row.sid] }, '끝냈어요'))
  }
  const keep = (row: SessionRow) => sessionSet(row, { keepAlive: true }, '이 세션은 자동으로 내리지 않아요')
  const hold = (row: SessionRow) => sessionSet(row, { tidyKeep: true }, '이번엔 유지해요')
  const rest = (row: SessionRow) => sessionSet(row, { resting: true }, '휴면으로 뒀어요')
  const trash = async (kind: 'folder' | 'transcript', rows: FileRow[], all: boolean) => {
    const total = rows.reduce((a, r) => a + (r.size ?? 0), 0)
    if (!(await confirmDialog(all ? `${rows.length}개(${bytes(total)})를 휴지통으로 옮길까요?` : `${rows[0].path} 를 휴지통으로 옮길까요?`, { text: TRASH_UNDO, ok: all ? '모두 휴지통' : '휴지통' }))) return
    await act(rows.map((r) => r.path), () => run('trash', { op: 'trash', items: rows.map((r) => ({ kind, path: r.path })) }, '휴지통으로 옮겼어요'))
  }
  const dim = (key: string) => (pending.has(key) ? { opacity: 0.45, pointerEvents: 'none' as const } : undefined)

  const sessions = report?.sessions ?? []
  const { stop: idle, rest: others } = tidyGroups(sessions)
  // Favourites the batch would have stopped or rested, left alone (REQ-F-782 rule 6): counted, nothing to press.
  const spared = sessions.filter((s) => s.favorite && s.why === FAVORITE_WHY).length
  const folders = report?.folders ?? []
  const transcripts = report?.transcripts ?? []
  const p = policy
  const off = !online || !!busy

  const sessionRow = (s: SessionRow, stoppable: boolean) => (
    <div key={s.sid} style={dim(s.sid)} aria-busy={pending.has(s.sid) || undefined}>
    <Row
      title={s.title ?? s.sid}
      sub={
        <span>
          {pending.has(s.sid) ? '처리 중 · ' : ''}사람 입력 {Math.floor(s.idleDays)}일 전{s.from === 'launch' ? ' · 사람 메시지 기록 없음, 시작 시각 기준' : ''}
          {s.stopAt && s.act === 'notice' ? ` · ${clock(s.stopAt)}에 내림` : ''}
          {s.why ? ` · ${s.why}` : ''}
        </span>
      }
      right={
        <span className="hstack" style={{ gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {stoppable ? (
            <Button size="sm" disabled={off} onClick={() => stop([s.sid], false)}>
              종료
            </Button>
          ) : null}
          {s.act === 'notice' ? (
            <Button size="sm" disabled={!!busy} onClick={() => hold(s)}>
              유지
            </Button>
          ) : null}
          {stoppable && !s.keepAlive ? (
            <Button size="sm" disabled={!!busy} onClick={() => keep(s)}>
              자동 종료 안 함
            </Button>
          ) : null}
          {s.rest && !s.alive ? (
            <Button size="sm" disabled={!!busy} onClick={() => rest(s)}>
              휴면
            </Button>
          ) : null}
          {s.close ? (
            <Button size="sm" tone="danger" disabled={!!busy} onClick={() => close(s)}>
              끝내기
            </Button>
          ) : null}
        </span>
      }
    />
    </div>
  )
  const fileRow = (kind: 'folder' | 'transcript', f: FileRow) => (
    <div key={f.path} style={dim(f.path)} aria-busy={pending.has(f.path) || undefined}>
    <Row
      title={f.path}
      sub={
        <span>
          {pending.has(f.path) ? '처리 중 · ' : ''}
          {bytes(f.size ?? 0)}
          {f.lastAt ? ` · ${ago(f.lastAt)} 씀` : ''}
          {f.auto ? ' · 자동 대상' : ''}
          {f.why ? ` · ${f.why}` : ''}
        </span>
      }
      right={
        <Button size="sm" disabled={off} onClick={() => trash(kind, [f], false)}>
          휴지통
        </Button>
      }
    />
    </div>
  )

  return (
    <div className="card stack" style={{ gap: 8 }}>
      <CardHead title="세션 정리" />
      <div style={{ fontSize: 'var(--fs-small)', color: 'var(--muted)' }}>
        {modeLine(p)}
        {report ? ` · 마지막 계산 ${ago(report.at)}` : ''}
        {calculating || pending.size ? ' · 다시 계산하는 중…' : ''}
      </div>
      {p ? (
        <div className="hstack" style={{ gap: 12, flexWrap: 'wrap' }}>
          <Pick<Mode> label="방식" value={p.mode} options={['', 'auto', 'suggest', 'off']} text={(v) => (v === '' ? '기본값 따름' : v === 'auto' ? '자동' : v === 'suggest' ? '제안만' : '끔')} onPick={(v) => settings({ mode: v === '' ? null : v })} disabled={!!busy} />
          <Pick<number> label="세션 내림" value={p.idleStopDays} options={STOP_DAYS} text={(v) => (v === 0 ? '끔' : `${v}일`)} onPick={(v) => settings({ idleStopDays: v === '' ? null : v })} disabled={!!busy} />
          <Pick<number> label="폴더 휴지통" value={p.folderTrashDays} options={TRASH_DAYS} text={(v) => (v === 0 ? '끔' : `${v}일`)} onPick={(v) => settings({ folderTrashDays: v === '' ? null : v })} disabled={!!busy} />
          <Button size="sm" disabled={off || calculating} onClick={() => run('run', { op: 'run' }, '다시 계산했어요')}>
            {busy === 'run' ? <Spinner size={14} /> : null} 다시 계산
          </Button>
        </div>
      ) : null}
      {!loaded ? <Spinner size={16} /> : !report ? <div style={{ fontSize: 'var(--fs-small)' }}>아직 계산하지 않았어요(에이전트가 1.385 이전이거나 켜진 지 10분 안)</div> : null}
      {report ? (
        <>
          <div className="hstack" style={{ justifyContent: 'space-between' }}>
            <b>내릴 세션 · {idle.length}</b>
            {idle.length ? (
              <Button size="sm" disabled={off} onClick={() => stop(idle.map((s) => s.sid), true)}>
                모두 종료
              </Button>
            ) : null}
          </div>
          {idle.map((s) => sessionRow(s, true))}
          {spared ? <div style={{ fontSize: 'var(--fs-small)', color: 'var(--muted)' }}>즐겨찾기라 정리하지 않음 · 세션 {spared}개</div> : null}
          {others.length ? <b>휴면·끝내기 제안 · {others.length}</b> : null}
          {others.map((s) => sessionRow(s, false))}
          <div className="hstack" style={{ justifyContent: 'space-between' }}>
            <b>정리 제안 폴더 · {folders.length}</b>
            {folders.length ? (
              <Button size="sm" disabled={off} onClick={() => trash('folder', folders, true)}>
                모두 휴지통
              </Button>
            ) : null}
          </div>
          {folders.map((f) => fileRow('folder', f))}
          <div className="hstack" style={{ justifyContent: 'space-between' }}>
            <b>큰 대화 기록 · {transcripts.length}</b>
            {transcripts.length ? (
              <Button size="sm" disabled={off} onClick={() => trash('transcript', transcripts, true)}>
                모두 휴지통
              </Button>
            ) : null}
          </div>
          {transcripts.map((f) => fileRow('transcript', f))}
        </>
      ) : null}
    </div>
  )
}
