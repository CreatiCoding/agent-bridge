// 디스크 관리 메뉴 (REQ-F-803): every host of this person in one list, each with how full its disk is, opening into
// the same disk box as before (caches, merged worktrees, big folders) without going to each host's page.
import { useState } from 'react'
import { bytes } from '../lib/format'
import { back } from '../lib/router'
import { useStore } from '../lib/store'
import { Empty, Icon, IconButton, Row, useWide } from '../kit'
import { StateWait, useStateLoaded } from '../components/state-wait'
import { DiskBox } from './host-disk'

export function DiskPage() {
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
            const d = h.sys?.disk
            const shown = open === h.id
            return (
              <div key={h.id} className="stack" style={{ gap: 8 }}>
                <Row
                  left={<span className={`dot dot-${h.online ? 'green' : 'grey'}`} />}
                  title={h.name}
                  sub={
                    d?.pct != null ? (
                      <span className="stack" style={{ gap: 4 }}>
                        <span>
                          {Math.round(d.pct)}% 사용{d.avail != null ? ` · ${bytes(d.avail)} 남음` : ''}
                          {h.online ? '' : ' · 끊김'}
                        </span>
                        <span style={{ display: 'block', height: 6, borderRadius: 3, background: 'var(--line)', overflow: 'hidden' }} aria-hidden>
                          <span style={{ display: 'block', width: `${Math.min(100, d.pct)}%`, height: '100%', background: d.pct >= 95 ? 'var(--red)' : d.pct >= 85 ? 'var(--amber)' : 'var(--accent)' }} />
                        </span>
                      </span>
                    ) : h.online ? (
                      '사용률을 아직 받지 못했어요(에이전트가 1.322 이전)'
                    ) : (
                      '끊김'
                    )
                  }
                  right={<Icon name={shown ? 'up' : 'down'} />}
                  onClick={() => setOpen(shown ? null : h.id)}
                />
                {shown ? <DiskBox key={h.id} hostId={h.id} online={h.online} sys={h.sys} title={`${h.name} 디스크`} /> : null}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
