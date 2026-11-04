// 설정 → 기기 (REQ-F-842): every host of this person on one screen, one card each: connected or not, CPU, memory
// and disk bars, the battery, and 세션 정리 in a line. A card opens that host's box in 디스크 관리 (/disk?host=<id>),
// where its disk and 세션 정리 are handled as before. An operator also sees everyone else's hosts below, in the same
// cards, under the same rules as the disk menu (REQ-F-804: 세션 정리 only once the owner has granted it).
import { SlotActions, SlotBadges } from './slot-parts'
import { hostInfo } from '../lib/host-info'
import { useEffect, useState } from 'react'
import { get } from '../lib/api'
import { boardOrder, meters, tidyCardText, type Meter } from '../lib/device-board'
import { ago, batteryLine, batteryLow, bytes, clock, hostBattery, type Battery, type SysUse } from '../lib/format'
import { go, href } from '../lib/router'
import { useStore } from '../lib/store'
import type { DiskHelp, Me, TidyBrief } from '../lib/types'
import { Empty, Icon, useTick } from '../kit'
import { StateWait, useStateLoaded } from './state-wait'

/** What a card needs; the state's hosts and the admin overview's both have it. */
export interface BoardHost {
  id: string
  name: string
  online: boolean
  lastSeen?: number | null
  sys?: SysUse | null
  battery?: (Battery & { at: number }) | null
  tidy?: TidyBrief | null
  diskHelp?: DiskHelp | null
  /** Someone else's host (the operator's list): whose it is. */
  login?: string
}

function Bar({ m, label }: { m: Meter; label: string }) {
  return (
    <div className="dev-meter">
      <div className="dev-meter-top">
        <span className="dev-meter-label">{m.label}</span>
        <span className="dev-meter-val">{m.text}</span>
      </div>
      {/* The value is in the text above and in aria-valuetext: a colour is never the only sign. */}
      <div className={`dev-bar dev-bar-${m.tone}`} role="meter" aria-label={`${label} ${m.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={m.pct} aria-valuetext={m.text}>
        <span style={{ width: `${m.pct}%` }} />
      </div>
    </div>
  )
}

/** The 세션 정리 line, or what stands in for it on someone else's host without a grant. */
function TidyLine({ h, hidden }: { h: BoardHost; hidden?: string }) {
  if (hidden) return <span className="dev-line muted">세션 정리 · {hidden}</span>
  const t = tidyCardText(h.tidy)
  return (
    <span className="dev-line">
      <span className="dev-line-key">세션 정리</span>
      {t.mode ? <span className={`dev-mode dev-mode-${h.tidy?.mode}`}>{t.mode}</span> : null}
      <span className={t.count ? '' : 'muted'}>{t.text}</span>
    </span>
  )
}

function DeviceCard({ h, me }: { h: BoardHost; me: Me | null }) {
  const label = h.login ? `${h.login} · ${h.name}` : h.name
  const bars = meters(h.sys, bytes)
  const bat = hostBattery(h)
  const others = !!h.login
  const mineAsk = others && h.diskHelp?.login === me?.user.login
  const granted = mineAsk && (h.diskHelp?.until ?? 0) > Date.now()
  // Someone else's host: its 세션 정리 is the owner's until they grant it (REQ-F-804), so the card says where it stands.
  const tidyHidden = others && !granted ? (mineAsk ? '주인의 허용을 기다리는 중' : h.diskHelp ? `운영자 ${h.diskHelp.login} 이 요청함` : '정리 권한을 요청하면 보여요') : undefined
  // My own host with an operator's request on it: the answer is in the disk menu.
  const asked = !others && h.diskHelp && !(h.diskHelp.until > Date.now())
  const to = { name: 'disk' as const, host: h.id }
  return (
    <a
      className={`dev-card${h.online ? '' : ' dev-card-off'}`}
      href={href(to)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return
        e.preventDefault()
        go(to)
      }}
    >
      <div className="dev-card-head">
        <span className={`dot dot-${h.online ? 'green' : 'grey'}`} aria-hidden />
        <b className="dev-card-name">{label}</b>
        <span className="dev-card-state">{h.online ? '연결됨' : `끊김${h.lastSeen ? ` · ${ago(h.lastSeen)}` : ''}`}</span>
        {/* host-card.* (REQ-F-865): the card is a link, so an action stops it from opening. */}
        <SlotBadges slot="host-card.badges" ctx={{ host: hostInfo(h) }} />
        <SlotActions slot="host-card.actions" ctx={{ host: hostInfo(h) }} max={1} />
        <span className="sr-only">· 디스크 관리·세션 정리 열기</span>
        <Icon name="forward" />
      </div>
      {bars.length ? (
        <div className="dev-meters">
          {bars.map((m) => (
            <Bar key={m.key} m={m} label={label} />
          ))}
        </div>
      ) : (
        <span className="dev-line muted">{h.online ? '사용률을 아직 받지 못했어요(에이전트가 1.322 이전)' : '사용률 없음'}</span>
      )}
      <div className="dev-foot">
        {bat ? (
          <span className={`dev-line${batteryLow(bat.b) ? ' dev-low' : ''}`}>
            {batteryLine(bat.b)}
            {bat.at ? <span className="muted"> · 마지막 값 {ago(bat.at)}</span> : null}
          </span>
        ) : null}
        <TidyLine h={h} hidden={tidyHidden} />
        {granted ? <span className="dev-line muted">정리 권한 {clock(h.diskHelp!.until)} 까지</span> : null}
        {asked ? (
          <span className="dev-line dev-ask">
            <Icon name="shield" />
            운영자 {h.diskHelp!.login} 이 디스크 정리 권한을 요청했어요
          </span>
        ) : null}
      </div>
    </a>
  )
}

/** The operator's list: everyone else's hosts from the admin overview, every 15 s as the disk menu reads it. */
function OthersBoard({ me }: { me: Me }) {
  const [list, setList] = useState<BoardHost[] | null>(null)
  useEffect(() => {
    let live = true
    const load = () =>
      get<{ users: { login: string; hosts: Omit<BoardHost, 'login'>[] }[] }>('/api/admin/overview').then(
        (o) => live && setList(o.users.filter((u) => u.login !== me.user.login).flatMap((u) => u.hosts.map((h) => ({ ...h, login: u.login })))),
        () => live && setList([]),
      )
    void load()
    const t = setInterval(load, 15_000)
    return () => ((live = false), clearInterval(t))
  }, [me.user.login])
  if (!list?.length) return null
  return (
    <section className="dev-section" aria-labelledby="dev-others">
      <h2 className="dev-section-head" id="dev-others">
        다른 사용자 기기
        <span className="muted">운영자 · {list.length}대</span>
      </h2>
      <div className="dev-grid">
        {boardOrder(list).map((h) => (
          <DeviceCard key={h.id} h={h} me={me} />
        ))}
      </div>
    </section>
  )
}

export function DeviceBoard({ me }: { me: Me | null }) {
  useTick()
  const loaded = useStateLoaded()
  const hosts = useStore((s) => s.state?.hosts ?? [])
  const list = boardOrder(hosts)
  const on = hosts.filter((h) => h.online).length
  return (
    <>
      <section className="dev-section" aria-labelledby="dev-mine">
        <h2 className="dev-section-head" id="dev-mine">
          내 기기
          <span className="muted">{loaded ? `${hosts.length}대 · 연결 ${on}` : ''}</span>
          <span className="grow" />
          <a className="dev-head-link" href={href({ name: 'hosts' })} onClick={(e) => (e.preventDefault(), go({ name: 'hosts' }))}>
            기기 화면
          </a>
        </h2>
        {!loaded ? (
          <StateWait />
        ) : !list.length ? (
          <Empty icon="laptop" title="연결된 기기가 없어요">
            맥에서 연동 페이지를 열면 여기에 보여요.
          </Empty>
        ) : (
          <div className="dev-grid">
            {list.map((h) => (
              <DeviceCard key={h.id} h={h} me={me} />
            ))}
          </div>
        )}
      </section>
      {me?.admin ? <OthersBoard me={me} /> : null}
    </>
  )
}
