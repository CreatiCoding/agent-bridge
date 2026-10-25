// 디스크 관리 메뉴 (REQ-F-803): every host of this person in one list, each with how full its disk is, opening into
// the same disk box as before (caches, merged worktrees, big folders) without going to each host's page.
// 디스크 정리 도움 (REQ-F-804): an owner answers an operator's request here, and an operator sees everyone else's
// hosts, asks for one, and manages it once granted.
import { useEffect, useState } from 'react'
import { errorText, get, post } from '../lib/api'
import { ago, bytes, clock, type SysUse } from '../lib/format'
import { back } from '../lib/router'
import { useStore } from '../lib/store'
import type { DiskHelp, Me } from '../lib/types'
import { Button, Empty, Icon, IconButton, Row, useWide } from '../kit'
import { confirmDialog, toast } from '../kit/overlay'
import { StateWait, useStateLoaded } from '../components/state-wait'
import { DiskBox } from './host-disk'

const helpCall = (hostId: string, op: 'ask' | 'grant' | 'end') => post(`/api/hosts/${hostId}/disk-help`, { op })
const granted = (h?: DiskHelp | null) => !!h && h.until > Date.now()

/** How full a disk is: the line and its bar. */
function DiskLine({ sys, online }: { sys?: SysUse | null; online: boolean }) {
  const d = sys?.disk
  if (d?.pct == null) return <>{online ? '사용률을 아직 받지 못했어요(에이전트가 1.322 이전)' : '끊김'}</>
  return (
    <span className="stack" style={{ gap: 4 }}>
      <span>
        {Math.round(d.pct)}% 사용{d.avail != null ? ` · ${bytes(d.avail)} 남음` : ''}
        {online ? '' : ' · 끊김'}
      </span>
      <span style={{ display: 'block', height: 6, borderRadius: 3, background: 'var(--line)', overflow: 'hidden' }} aria-hidden>
        <span style={{ display: 'block', width: `${Math.min(100, d.pct)}%`, height: '100%', background: d.pct >= 95 ? 'var(--red)' : d.pct >= 85 ? 'var(--amber)' : 'var(--accent)' }} />
      </span>
    </span>
  )
}

/** The owner's answer to an operator's request, or the grant they can take back. */
function HelpBanner({ hostId, help }: { hostId: string; help: DiskHelp }) {
  const [busy, setBusy] = useState(false)
  const act = async (op: 'grant' | 'end') => {
    if (op === 'grant' && !(await confirmDialog(`운영자 ${help.login} 에게 24시간 동안 이 기기의 디스크 정리를 맡길까요?`, { text: '그 운영자가 이 기기의 캐시를 비우고, 머지된 worktree 를 정리하고, 홈 폴더의 항목을 휴지통으로 옮길 수 있어요. 언제든 거둘 수 있어요.', ok: '24시간 허용' }))) return
    setBusy(true)
    try {
      await helpCall(hostId, op)
      toast(op === 'grant' ? '24시간 동안 허용했어요' : '권한을 거뒀어요')
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
    setBusy(false)
  }
  return (
    <div className="banner">
      <Icon name="shield" />
      <div className="banner-body">
        {granted(help) ? (
          <>
            운영자 <b>{help.login}</b> 이 {clock(help.until)} 까지 이 기기의 디스크를 정리할 수 있어요.
            <div className="hstack" style={{ gap: 6, marginTop: 6 }}>
              <Button size="sm" disabled={busy} onClick={() => act('end')}>
                권한 거두기
              </Button>
            </div>
          </>
        ) : (
          <>
            운영자 <b>{help.login}</b> 이 디스크 정리를 도우려고 권한을 요청했어요({ago(help.askedAt)}).
            <div className="hstack" style={{ gap: 6, marginTop: 6 }}>
              <Button size="sm" tone="primary" disabled={busy} onClick={() => act('grant')}>
                24시간 허용
              </Button>
              <Button size="sm" disabled={busy} onClick={() => act('end')}>
                거절
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

interface OtherHost {
  id: string
  name: string
  online: boolean
  sys?: SysUse | null
  diskHelp?: DiskHelp | null
  login: string
}

/** An operator's view of everyone else's hosts: ask, wait, and manage once the owner grants it. */
function OthersSection({ me }: { me: Me }) {
  const [list, setList] = useState<OtherHost[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = () =>
    get<{ users: { login: string; hosts: Omit<OtherHost, 'login'>[] }[] }>('/api/admin/overview').then(
      (o) => setList(o.users.filter((u) => u.login !== me.user.login).flatMap((u) => u.hosts.map((h) => ({ ...h, login: u.login })))),
      () => setList([]),
    )
  useEffect(() => {
    void load()
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const act = async (h: OtherHost, op: 'ask' | 'end') => {
    setBusy(h.id)
    try {
      await helpCall(h.id, op)
      toast(op === 'ask' ? `${h.login} 에게 요청했어요. 허용하면 여기서 정리할 수 있어요` : '권한을 내려놓았어요')
      await load()
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
    }
    setBusy(null)
  }
  if (!list?.length) return null
  return (
    <>
      <h3 style={{ margin: '12px 0 0', fontSize: 'var(--fs-medium)' }}>다른 사용자 기기 · 운영자</h3>
      {list.map((h) => {
        const mine = h.diskHelp?.login === me.user.login
        const can = mine && granted(h.diskHelp)
        const shown = open === h.id && can
        return (
          <div key={h.id} className="stack" style={{ gap: 8 }}>
            <Row
              left={<span className={`dot dot-${h.online ? 'green' : 'grey'}`} />}
              title={`${h.login} · ${h.name}`}
              sub={
                <span className="stack" style={{ gap: 4 }}>
                  <DiskLine sys={h.sys} online={h.online} />
                  <span>{can ? `정리 권한 ${clock(h.diskHelp!.until)} 까지` : mine ? '요청함 · 주인의 허용을 기다리는 중' : h.diskHelp ? `운영자 ${h.diskHelp.login} 이 요청함` : ''}</span>
                </span>
              }
              right={
                can ? (
                  <Icon name={shown ? 'up' : 'down'} />
                ) : mine ? (
                  <Button size="sm" disabled={busy === h.id} onClick={(e) => (e.stopPropagation(), act(h, 'end'))}>
                    요청 취소
                  </Button>
                ) : (
                  <Button size="sm" disabled={busy === h.id} onClick={(e) => (e.stopPropagation(), act(h, 'ask'))}>
                    정리 권한 요청
                  </Button>
                )
              }
              onClick={can ? () => setOpen(shown ? null : h.id) : undefined}
            />
            {shown ? <DiskBox key={h.id} hostId={h.id} online={h.online} sys={h.sys} title={`${h.login} · ${h.name} 디스크`} /> : null}
          </div>
        )
      })}
    </>
  )
}

export function DiskPage({ me }: { me: Me | null }) {
  const wide = useWide()
  const loaded = useStateLoaded()
  const hosts = useStore((s) => s.state?.hosts ?? [])
  const [open, setOpen] = useState<string | null>(null)
  // Fullest first: the one most likely to need clearing is at the top.
  const list = [...hosts].sort((a, b) => (b.sys?.disk?.pct ?? -1) - (a.sys?.disk?.pct ?? -1))
  return (
    <div className="main">
      <div className="topbar">
        {!wide ? <IconButton icon="back" label="뒤로" onClick={back} /> : null}
        <div className="topbar-title">
          <b>디스크 관리</b>
          <span>기기 {hosts.length}대</span>
        </div>
      </div>
      <div className="scroll">
        <div className="page stack">
          {!loaded ? <StateWait /> : !list.length ? <Empty icon="laptop" title="연결된 기기가 없어요" /> : null}
          {list.map((h) => {
            const shown = open === h.id
            return (
              <div key={h.id} className="stack" style={{ gap: 8 }}>
                <Row
                  left={<span className={`dot dot-${h.online ? 'green' : 'grey'}`} />}
                  title={h.name}
                  sub={<DiskLine sys={h.sys} online={h.online} />}
                  right={<Icon name={shown ? 'up' : 'down'} />}
                  onClick={() => setOpen(shown ? null : h.id)}
                />
                {h.diskHelp ? <HelpBanner hostId={h.id} help={h.diskHelp} /> : null}
                {shown ? <DiskBox key={h.id} hostId={h.id} online={h.online} sys={h.sys} title={`${h.name} 디스크`} /> : null}
              </div>
            )
          })}
          {me?.admin ? <OthersSection me={me} /> : null}
        </div>
      </div>
    </div>
  )
}
