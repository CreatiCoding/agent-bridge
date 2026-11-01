// 세션 정리 (REQ-F-839): what the hourly tidy on a host would do or did, in three lists (sessions resting long,
// folders, big transcripts), with its mode and days, and the same steps by hand. Taking claude down leaves the
// conversation; folders and transcripts go to the Trash only, never deleted. The agent judges each again before acting.
import { useEffect, useState } from 'react'
import { errorText, post } from '../lib/api'
import { ago, bytes, clock } from '../lib/format'
import { Button, CardHead, Row, Spinner } from '../kit'
import { confirmDialog, toast } from '../kit/overlay'

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

export function TidyBox({ hostId, online }: { hostId: string; online: boolean }) {
  const [report, setReport] = useState<Report | null>(null)
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId])

  const settings = (body: Record<string, unknown>) => run('settings', { op: 'settings', scope: 'host', ...body }, '이 기기의 세션 정리 설정을 바꿨어요')
  const stop = async (sids: string[], all: boolean) => {
    if (all && !(await confirmDialog(`세션 ${sids.length}개의 claude 를 내릴까요?`, { text: SESSION_UNDO, ok: '모두 종료' }))) return
    if (await run('stop', { op: 'stop', sids }, all ? `${sids.length}개를 내렸어요` : '내렸어요 · 글을 보내면 이어서 열려요')) await reload()
  }
  const close = async (row: SessionRow) => {
    if (!(await confirmDialog(`"${row.title ?? row.sid}" 세션을 끝낼까요?`, { text: '대화는 남아요. 나중에 이어서 열 수 있어요.', ok: '끝내기', danger: true }))) return
    if (await run('close', { op: 'close', sids: [row.sid] }, '끝냈어요')) await reload()
  }
  const keep = async (row: SessionRow) => {
    try {
      await post(`/api/sessions/${row.sid}/settings`, { keepAlive: true })
      toast('이 세션은 자동으로 내리지 않아요')
      await reload()
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
  }
  const hold = async (row: SessionRow) => {
    try {
      await post(`/api/sessions/${row.sid}/settings`, { tidyKeep: true })
      toast('이번엔 유지해요')
      await reload()
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
  }
  const trash = async (kind: 'folder' | 'transcript', rows: FileRow[], all: boolean) => {
    const total = rows.reduce((a, r) => a + (r.size ?? 0), 0)
    if (!(await confirmDialog(all ? `${rows.length}개(${bytes(total)})를 휴지통으로 옮길까요?` : `${rows[0].path} 를 휴지통으로 옮길까요?`, { text: TRASH_UNDO, ok: all ? '모두 휴지통' : '휴지통' }))) return
    if (await run('trash', { op: 'trash', items: rows.map((r) => ({ kind, path: r.path })) }, '휴지통으로 옮겼어요')) await reload()
  }

  const sessions = report?.sessions ?? []
  const idle = sessions.filter((s) => s.alive && (s.act === 'suggest' || s.act === 'notice' || s.act === 'wait' || s.act === 'stop'))
  const others = sessions.filter((s) => !idle.includes(s) && (s.rest || s.close))
  const folders = report?.folders ?? []
  const transcripts = report?.transcripts ?? []
  const p = policy
  const off = !online || !!busy

  const sessionRow = (s: SessionRow, stoppable: boolean) => (
    <Row
      key={s.sid}
      title={s.title ?? s.sid}
      sub={
        <span>
          사람 입력 {Math.floor(s.idleDays)}일 전{s.from === 'launch' ? ' · 사람 메시지 기록 없음, 시작 시각 기준' : ''}
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
          {s.close ? (
            <Button size="sm" tone="danger" disabled={!!busy} onClick={() => close(s)}>
              끝내기
            </Button>
          ) : null}
        </span>
      }
    />
  )
  const fileRow = (kind: 'folder' | 'transcript', f: FileRow) => (
    <Row
      key={f.path}
      title={f.path}
      sub={
        <span>
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
  )

  return (
    <div className="card stack" style={{ gap: 8 }}>
      <CardHead title="세션 정리" />
      <div style={{ fontSize: 'var(--fs-small)', color: 'var(--muted)' }}>
        {modeLine(p)}
        {report ? ` · 마지막 계산 ${ago(report.at)}` : ''}
      </div>
      {p ? (
        <div className="hstack" style={{ gap: 12, flexWrap: 'wrap' }}>
          <Pick<Mode> label="방식" value={p.mode} options={['', 'auto', 'suggest', 'off']} text={(v) => (v === '' ? '기본값 따름' : v === 'auto' ? '자동' : v === 'suggest' ? '제안만' : '끔')} onPick={(v) => settings({ mode: v === '' ? null : v })} disabled={!!busy} />
          <Pick<number> label="세션 내림" value={p.idleStopDays} options={STOP_DAYS} text={(v) => (v === 0 ? '끔' : `${v}일`)} onPick={(v) => settings({ idleStopDays: v === '' ? null : v })} disabled={!!busy} />
          <Pick<number> label="폴더 휴지통" value={p.folderTrashDays} options={TRASH_DAYS} text={(v) => (v === 0 ? '끔' : `${v}일`)} onPick={(v) => settings({ folderTrashDays: v === '' ? null : v })} disabled={!!busy} />
          <Button size="sm" disabled={off} onClick={() => run('run', { op: 'run' }, '다시 계산했어요')}>
            {busy === 'run' ? <Spinner size={14} /> : null} 다시 계산
          </Button>
        </div>
      ) : null}
      {!loaded ? <Spinner size={16} /> : !report ? <div style={{ fontSize: 'var(--fs-small)' }}>아직 계산하지 않았어요(에이전트가 1.385 이전이거나 켜진 지 10분 안)</div> : null}
      {report ? (
        <>
          <div className="hstack" style={{ justifyContent: 'space-between' }}>
            <b>오래 쉰 세션 · {idle.length}</b>
            {idle.length ? (
              <Button size="sm" disabled={off} onClick={() => stop(idle.map((s) => s.sid), true)}>
                모두 종료
              </Button>
            ) : null}
          </div>
          {idle.map((s) => sessionRow(s, true))}
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
