// The whole app's slots (REQ-F-865): app.banner, app.status.items, notification.items and an extension's own page
// (app.routes). What an extension adds here is drawn by the page, inside its own frame and back button.
import { useSyncExternalStore, type ReactNode } from 'react'
import { back } from '../lib/router'
import { useWide, Empty, Icon, IconButton, Spinner } from '../kit'
import { SlotContext, SlotRender } from '../lib/slot-view'
import type { SlotItem } from '../lib/slots'
import { blocked, runItem, spoken, SlotSections, useAdded } from './slot-parts'
import type { ActionItem } from '../lib/slots'

// ---------- app.banner ----------

/** app.banner: notices for the whole app, under the connection banner, above every page. */
export function AppBanner({ route }: { route: string }) {
  return <SlotSections slot="app.banner" ctx={{ route }} className="slot-sections slot-banner" />
}

// ---------- app.status.items ----------

/** app.status.items: background work an extension is doing, as chips (working, done, failed) anyone can press. */
export function StatusStrip({ route }: { route: string }) {
  const list = useAdded<ActionItem<{ route: string }> & { tone?: 'ok' | 'bad' }>('app.status.items').filter((i) => {
    try {
      return !i.visible || i.visible({ route })
    } catch {
      return false
    }
  })
  if (!list.length) return null
  return (
    <div className="status-strip" role="status" aria-label="익스텐션 작업">
      {list.map((i) => {
        const busy = i.busy != null && i.busy !== false
        return (
          <button key={i.id} type="button" className={`chip chip-btn${i.tone ? ` chip-${i.tone}` : ''}`} aria-label={spoken(i as ActionItem)} disabled={blocked(i)} onClick={() => runItem('app.status.items', i, { route })}>
            {busy ? <Spinner size={14} /> : <Icon name={(i.tone === 'bad' ? 'warn' : i.tone === 'ok' ? 'check' : i.icon) as never} />}
            <span>{i.label}</span>
            {typeof i.busy === 'number' ? <span className="muted">{Math.round(i.busy * 100)}%</span> : null}
          </button>
        )
      })}
    </div>
  )
}

// ---------- notification.items ----------

export interface ExtNotice extends SlotItem {
  title: string
  text?: string
  tone?: 'ok' | 'fail' | 'info'
  at?: number
  /** Pressing the notice: go where it is about. */
  run?: () => void
  /** Closing it: the extension forgets it (else it is only hidden in this page until it changes). */
  onClose?: () => void
}
// Closed in this page: by id and what it said, so the same id with new words shows again.
const closed = new Set<string>()
const closedSubs = new Set<() => void>()
const keyOf = (n: ExtNotice) => `${n.extId ?? ''}|${n.id}|${n.at ?? ''}|${n.title}|${n.text ?? ''}`
const useClosed = () =>
  useSyncExternalStore(
    (f) => (closedSubs.add(f), () => void closedSubs.delete(f)),
    () => closed.size,
  )

/** The extensions' notices still open: counted on the bell, listed at the top of the notice sheet. */
export function useExtNotices() {
  useClosed()
  return useAdded<ExtNotice>('notification.items').filter((n) => !closed.has(keyOf(n)))
}

export function ExtNoticeRows({ ago }: { ago: (at: number) => string }) {
  const list = useExtNotices()
  return (
    <>
      {list.map((n) => (
        <div key={`${n.extId}:${n.id}`} className="notice-item" data-slot="notification.items">
          <Icon name={n.tone === 'fail' ? 'warn' : n.tone === 'ok' ? 'check' : 'bell'} />
          <button type="button" className="grow" onClick={() => n.run?.()} disabled={!n.run}>
            <b>{n.title}</b> {n.at ? <span className="muted">{ago(n.at)}</span> : null}
            {n.text ? <p>{n.text}</p> : null}
          </button>
          <IconButton
            icon="close"
            label="지우기"
            onClick={() => {
              closed.add(keyOf(n))
              closedSubs.forEach((f) => f())
              try {
                n.onClose?.()
              } catch {
                /* the extension's own */
              }
            }}
          />
        </div>
      ))}
    </>
  )
}

// ---------- app.routes ----------

interface ExtRoute extends SlotItem {
  title: string
  render: () => ReactNode
}

/** /x/<ext>/<page>: an extension's page, in the page's frame (title and back), its drawing below. */
export function ExtPage({ ext, page }: { ext: string; page: string }) {
  const wide = useWide()
  const item = useAdded<ExtRoute>('app.routes').find((r) => r.extId === ext && r.id === page)
  return (
    <div className="main ext-page">
      <div className="topbar">
        {!wide ? <IconButton icon="back" label="뒤로" onClick={back} /> : null}
        <div className="topbar-title">
          <b>{item?.title ?? '익스텐션 화면'}</b>
        </div>
      </div>
      <div className="scroll">
        <div className="page stack">
          {item ? (
            <SlotContext.Provider value={{ ext, page }}>
              <SlotRender render={item.render} owner={ext} />
            </SlotContext.Provider>
          ) : (
            <Empty icon="info" title="이 화면을 찾지 못했어요">
              익스텐션이 꺼져 있거나, 아직 불러오는 중이거나, 이 기기에서 켜지 않았을 수 있어요(설정 → 플러그인).
            </Empty>
          )}
        </div>
      </div>
    </div>
  )
}
