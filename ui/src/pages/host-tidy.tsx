// 세션 정리 (REQ-F-839): what the hourly tidy on a host would do or did, in three lists (sessions to take down,
// rests and ends offered, folders and big transcripts), with its mode and days, and the same steps by hand. Taking
// claude down leaves the conversation; folders and transcripts go to the Trash only, never deleted. The agent judges
// each again before acting. Its own page is 설정 → 세션 정리 (/settings/tidy): one card per host, each row named by
// its session, the path or id only as the small line under it.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { errorText, get, post } from '../lib/api'
import { ago, bytes, clock } from '../lib/format'
import { Button, Empty, Spinner } from '../kit'
import { confirmDialog, toast } from '../kit/overlay'
import { createRecalc, type Recalc } from '../lib/recalc'
import { tidyGroups, tidyRowName, tidyRowSub } from '../lib/tidy-groups'
import { REST_TOAST } from '../lib/sessions'
import { openSession } from '../lib/builtin-actions'
import { go, href } from '../lib/router'
import { useStore } from '../lib/store'
import type { DiskHelp, Me } from '../lib/types'
import { StateWait, useStateLoaded } from '../components/state-wait'

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
  cwd?: string | null
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
  name?: string | null
  sid?: string | null
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
const MODE_TEXT: Record<Mode, string> = { auto: '자동', suggest: '제안만', off: '끔' }

function modeWhy(p: Policy | null) {
  if (!p) return ''
  if (p.mode === 'off') return '정리하지 않아요'
  if (p.mode === 'auto') return '예고 뒤 저절로 내리고 안전한 폴더는 휴지통으로'
  if (p.why === 'observe') return p.observeUntil ? `처음 7일은 제안만 · ${clock(p.observeUntil)}부터 자동` : '처음 7일은 제안만'
  if (p.why === 'owner') return '다른 사용자 기기라 제안만 · 주인이 켜면 자동'
  return '목록만 보여 주고 손대지 않아요'
}

function Pick<T extends string | number>({ label, value, options, text, onPick, disabled }: { label: string; value: T | ''; options: (T | '')[]; text: (v: T | '') => string; onPick: (v: T | '') => void; disabled?: boolean }) {
  return (
    <label className="tidy-pick">
      <span>{label}</span>
      <select className="input" value={String(value)} disabled={disabled} onChange={(e) => onPick((options.find((o) => String(o) === e.target.value) ?? '') as T | '')}>
        {options.map((o) => (
          <option key={String(o)} value={String(o)}>
            {text(o)}
          </option>
        ))}
      </select>
    </label>
  )
}

/** One list of the box: a head with its count and a bulk action, what it is, and its rows (or that it is empty). */
function Group({ id, title, count, hint, action, children }: { id: string; title: string; count: number; hint: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="tidy-group" aria-labelledby={id}>
      <div className="tidy-group-head">
        <h3 id={id}>
          {title} <span className="tidy-count">{count}</span>
        </h3>
        {action}
      </div>
      <p className="tidy-hint">{hint}</p>
      {count ? <div className="tidy-rows">{children}</div> : <p className="tidy-none">없음</p>}
    </section>
  )
}

/** A row: the session's name first, why and when under it, the path or id in small grey, its buttons to the side (below on a phone). */
function TidyRow({ name, meta, sub, busy, actions, onOpen }: { name: string; meta: ReactNode; sub: string; busy: boolean; actions: ReactNode; onOpen?: () => void }) {
  return (
    <div className={`tidy-row${busy ? ' tidy-row-busy' : ''}`} aria-busy={busy || undefined}>
      <div className="tidy-row-main">
        {onOpen ? (
          <button type="button" className="tidy-name tidy-name-link" onClick={onOpen}>
            {name}
          </button>
        ) : (
          <b className="tidy-name">{name}</b>
        )}
        <span className="tidy-meta">
          {busy ? '처리 중 · ' : ''}
          {meta}
        </span>
        {sub ? <span className="tidy-id">{sub}</span> : null}
      </div>
      <div className="tidy-actions">{actions}</div>
    </div>
  )
}

export function TidyBox({ hostId, online, name, onChange }: { hostId: string; online: boolean; name: string; onChange?: () => void }) {
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
    // 자동 다시 계산 (REQ-F-839 rule 8): the host works its tidy out again (IF-264 run) once a burst of actions is
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
    if (!(await confirmDialog(`"${tidyRowName(row)}" 세션을 끝낼까요?`, { text: '대화는 남아요. 나중에 이어서 열 수 있어요.', ok: '끝내기', danger: true }))) return
    await act([row.sid], () => run('close', { op: 'close', sids: [row.sid] }, '끝냈어요'))
  }
  const keep = (row: SessionRow) => sessionSet(row, { keepAlive: true }, '이 세션은 자동으로 내리지 않아요')
  const hold = (row: SessionRow) => sessionSet(row, { tidyKeep: true }, '이번엔 유지해요')
  const rest = (row: SessionRow) => sessionSet(row, { resting: true }, REST_TOAST)
  const trash = async (kind: 'folder' | 'transcript', rows: FileRow[], all: boolean) => {
    const total = rows.reduce((a, r) => a + (r.size ?? 0), 0)
    if (!(await confirmDialog(all ? `${rows.length}개(${bytes(total)})를 휴지통으로 옮길까요?` : `"${tidyRowName(rows[0])}"(${rows[0].path}) 를 휴지통으로 옮길까요?`, { text: TRASH_UNDO, ok: all ? '모두 휴지통' : '휴지통' }))) return
    await act(rows.map((r) => r.path), () => run('trash', { op: 'trash', items: rows.map((r) => ({ kind, path: r.path })) }, '휴지통으로 옮겼어요'))
  }

  const sessions = report?.sessions ?? []
  const { stop: idle, rest: others } = tidyGroups(sessions)
  // Favourites the batch would have stopped or rested, left alone (REQ-F-782 rule 6): counted, nothing to press.
  const spared = sessions.filter((s) => s.favorite && s.why === FAVORITE_WHY).length
  const folders = report?.folders ?? []
  const transcripts = report?.transcripts ?? []
  const files = folders.length + transcripts.length
  const p = policy
  const off = !online || !!busy

  const sessionRow = (s: SessionRow, stoppable: boolean) => (
    <TidyRow
      key={s.sid}
      name={tidyRowName(s)}
      onOpen={() => openSession(s.sid, 'tidy')}
      busy={pending.has(s.sid)}
      sub={tidyRowSub(s)}
      meta={
        <>
          사람 입력 {Math.floor(s.idleDays)}일 전{s.from === 'launch' ? ' · 사람 메시지 기록 없음, 시작 시각 기준' : ''}
          {s.stopAt && s.act === 'notice' ? ` · ${clock(s.stopAt)}에 내림` : ''}
          {s.why ? ` · ${s.why}` : ''}
        </>
      }
      actions={
        <>
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
        </>
      }
    />
  )
  const fileRow = (kind: 'folder' | 'transcript', f: FileRow) => (
    <TidyRow
      key={f.path}
      name={`${kind === 'transcript' ? '대화 기록 · ' : ''}${tidyRowName(f)}`}
      busy={pending.has(f.path)}
      sub={f.path}
      meta={
        <>
          {bytes(f.size ?? 0)}
          {f.lastAt ? ` · ${ago(f.lastAt)} 씀` : ''}
          {f.auto ? ' · 자동 대상' : ''}
          {f.why ? ` · ${f.why}` : ''}
        </>
      }
      actions={
        <Button size="sm" disabled={off} onClick={() => trash(kind, [f], false)}>
          휴지통
        </Button>
      }
    />
  )

  return (
    <section className={`tidy-host${online ? '' : ' tidy-host-off'}`} id={`tidy-${hostId}`} aria-label={`${name} 세션 정리`}>
      <header className="tidy-host-head">
        <span className={`dot dot-${online ? 'green' : 'grey'}`} aria-hidden />
        <b className="tidy-host-name">{name}</b>
        {p ? <span className={`dev-mode dev-mode-${p.mode}`}>{MODE_TEXT[p.mode]}</span> : null}
        <span className="tidy-host-state">{online ? '연결됨' : '끊김'}</span>
      </header>
      <p className="tidy-hint">
        {modeWhy(p)}
        {report ? ` · 마지막 계산 ${ago(report.at)}` : ''}
        {calculating || pending.size ? ' · 다시 계산하는 중…' : ''}
      </p>
      {report ? (
        <div className="tidy-stats" role="list">
          {[
            ['내릴 세션', idle.length, `tidy-${hostId}-stop`],
            ['휴면·끝내기 제안', others.length, `tidy-${hostId}-rest`],
            ['폴더·기록 제안', files, `tidy-${hostId}-files`],
          ].map(([label, n, to]) => (
            <a key={String(to)} role="listitem" className={`tidy-stat${n ? '' : ' tidy-stat-zero'}`} href={`#${to}`} onClick={(e) => (e.preventDefault(), document.getElementById(String(to))?.scrollIntoView({ block: 'start', behavior: 'smooth' }))}>
              <b>{n}</b>
              <span>{label}</span>
            </a>
          ))}
        </div>
      ) : null}
      {p ? (
        <div className="tidy-picks">
          <Pick<Mode> label="정리 방식" value={p.mode} options={['', 'auto', 'suggest', 'off']} text={(v) => (v === '' ? '기본값 따름' : MODE_TEXT[v])} onPick={(v) => settings({ mode: v === '' ? null : v })} disabled={!!busy} />
          <Pick<number> label="세션 내림" value={p.idleStopDays} options={STOP_DAYS} text={(v) => (v === 0 ? '끔' : `${v}일 입력 없으면`)} onPick={(v) => settings({ idleStopDays: v === '' ? null : v })} disabled={!!busy} />
          <Pick<number> label="폴더 휴지통" value={p.folderTrashDays} options={TRASH_DAYS} text={(v) => (v === 0 ? '끔' : `${v}일 안 쓰면`)} onPick={(v) => settings({ folderTrashDays: v === '' ? null : v })} disabled={!!busy} />
          <Button size="sm" disabled={off || calculating} onClick={() => run('run', { op: 'run' }, '다시 계산했어요')}>
            {busy === 'run' ? <Spinner size={14} /> : null} 다시 계산
          </Button>
        </div>
      ) : null}
      {!loaded ? <Spinner size={16} /> : !report ? <p className="tidy-hint">아직 계산하지 않았어요(에이전트가 1.385 이전이거나 켜진 지 10분 안)</p> : null}
      {report ? (
        <>
          <Group
            id={`tidy-${hostId}-stop`}
            title="내릴 세션"
            count={idle.length}
            hint="사람 입력이 오래 없는 세션이에요. 내려도 대화는 남고, 글을 보내면 이어서 열려요."
            action={
              idle.length ? (
                <Button size="sm" disabled={off} onClick={() => stop(idle.map((s) => s.sid), true)}>
                  모두 종료
                </Button>
              ) : null
            }
          >
            {idle.map((s) => sessionRow(s, true))}
          </Group>
          {spared ? <p className="tidy-hint">즐겨찾기라 정리하지 않음 · 세션 {spared}개</p> : null}
          <Group id={`tidy-${hostId}-rest`} title="휴면·끝내기 제안" count={others.length} hint="이미 내려간 세션이에요. 휴면은 목록에서 접어 두고, 끝내기는 세션을 닫아요(대화는 남아요).">
            {others.map((s) => sessionRow(s, false))}
          </Group>
          <Group
            id={`tidy-${hostId}-files`}
            title="폴더·기록 제안"
            count={files}
            hint="끝난 세션의 폴더와 큰 대화 기록이에요. 휴지통으로만 옮겨요(영구 삭제 아님)."
            action={
              files ? (
                <span className="tidy-actions">
                  {folders.length ? (
                    <Button size="sm" disabled={off} onClick={() => trash('folder', folders, true)}>
                      폴더 모두 휴지통
                    </Button>
                  ) : null}
                  {transcripts.length ? (
                    <Button size="sm" disabled={off} onClick={() => trash('transcript', transcripts, true)}>
                      기록 모두 휴지통
                    </Button>
                  ) : null}
                </span>
              ) : null
            }
          >
            {folders.map((f) => fileRow('folder', f))}
            {transcripts.map((f) => fileRow('transcript', f))}
          </Group>
        </>
      ) : null}
    </section>
  )
}

interface OtherHost {
  id: string
  name: string
  online: boolean
  diskHelp?: DiskHelp | null
  login: string
}

/** 설정 → 세션 정리 (REQ-F-839): every host of mine in one page, and for an operator the other users' hosts they were granted. */
export function TidyBoard({ me, host }: { me: Me | null; host?: string }) {
  const loaded = useStateLoaded()
  const hosts = useStore((s) => s.state?.hosts ?? [])
  const [others, setOthers] = useState<OtherHost[] | null>(null)
  const admin = !!me?.admin
  const login = me?.user.login
  useEffect(() => {
    if (!admin) return
    let live = true
    const load = () =>
      get<{ users: { login: string; hosts: Omit<OtherHost, 'login'>[] }[] }>('/api/admin/overview').then(
        (o) => live && setOthers(o.users.filter((u) => u.login !== login).flatMap((u) => u.hosts.map((h) => ({ ...h, login: u.login })))),
        () => live && setOthers([]),
      )
    void load()
    return () => {
      live = false
    }
  }, [admin, login])
  const granted = (others ?? []).filter((h) => h.diskHelp?.login === login && (h.diskHelp?.until ?? 0) > Date.now())
  const notGranted = (others?.length ?? 0) - granted.length
  // Connected first, then by name: the hosts the page can act on are on top.
  const list = [...hosts].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
  // Came from a host's line elsewhere (/settings/tidy?host=<id>): bring its box into view once it is drawn.
  const found = !!host && (list.some((h) => h.id === host) || granted.some((h) => h.id === host))
  useEffect(() => {
    if (found) requestAnimationFrame(() => document.getElementById(`tidy-${host}`)?.scrollIntoView({ block: 'start' }))
  }, [found, host])
  return (
    <div className="tidy-board">
      <p className="tidy-intro">
        한 시간마다 기기마다 오래 쉰 세션과 안 쓰는 폴더를 찾아요. 자동이면 예고 뒤 claude 를 내리고 안전한 폴더는 휴지통으로 옮기고, 제안만이면 목록만 보여 줘요. 즐겨찾기한 세션은 정리하지 않아요.
      </p>
      {!loaded ? <StateWait /> : !list.length ? <Empty icon="laptop" title="연결된 기기가 없어요" /> : null}
      {list.map((h) => (
        <TidyBox key={h.id} hostId={h.id} online={h.online} name={h.name} />
      ))}
      {granted.length ? <h2 className="tidy-others-head">다른 사용자 기기 · 운영자</h2> : null}
      {granted.map((h) => (
        <TidyBox key={h.id} hostId={h.id} online={h.online} name={`${h.login} · ${h.name}`} />
      ))}
      {admin && notGranted > 0 ? (
        <p className="tidy-hint">
          다른 사용자 기기 {notGranted}대는 주인이 허용하면 여기 보여요 ·{' '}
          <a href={href({ name: 'disk' })} onClick={(e) => (e.preventDefault(), go({ name: 'disk' }))}>
            디스크 관리에서 요청
          </a>
        </p>
      ) : null}
    </div>
  )
}
