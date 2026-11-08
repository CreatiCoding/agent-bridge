// The session.panel slot (REQ-F-892): an extension's panel beside the conversation. Where there is room it is a dock
// on the right that can be resized and folded; where there is not (a phone, a narrow pane) it is a sheet. One panel
// is open at a time, remembered on this device; each pane of a split screen is its own page and has its own.
// Which one is open is kept per session (REQ-F-894): the person's last choice is the default for a session nobody
// chose for, and an extension may open or close its own panel in one session (bridge.panels) without touching others.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Icon, IconButton, useMedia, type IconName } from '../kit'
import { openMenu, Sheet } from '../kit/overlay'
import { getPref, setPref } from '../lib/local'
import type { SlotItem } from '../lib/slots'
import { slotFailed, SlotContext, SlotRender } from '../lib/slot-view'
import type { Session } from '../lib/types'
import { badgeText, useAdded } from './slot-parts'

export interface PanelItem extends SlotItem {
  label: string
  icon: string
  badge?: number | 'dot' | 'new' | null
  /** Starting width of the dock in px (clamped to PANEL_MIN..PANEL_MAX); the person's own width wins. */
  width?: number
  visible?: (ctx: SessionSlotCtx) => boolean
  render: () => ReactNode
}
export interface SessionSlotCtx {
  sid: string
  session: Session
  wide: boolean
  pane: boolean
}
export interface PanelCtx extends SessionSlotCtx {
  place: 'dock' | 'sheet'
  close: () => void
}

/** Room for the dock: narrower than this (a phone, a narrow pane), the panel opens as a sheet. */
export const PANEL_DOCK = '(min-width: 960px)'
export const PANEL_MIN = 260
export const PANEL_MAX = 720
const PANEL_DEFAULT = 360
const keyOf = (i: PanelItem) => `${String(i.extId ?? '')}/${i.id}`
const clampW = (w: number) => Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.min(w, innerWidth * 0.6))))

// ---------- which panel is open, per session (REQ-F-894) ----------

/** Sessions remembered, the latest kept. */
const PANEL_KEEP = 200
type PanelMemo = { per: Record<string, string>; closed: Record<string, number> }
let memo: PanelMemo | null = null
const memoOf = (): PanelMemo => (memo ??= { per: { ...getPref<Record<string, string>>('extPanelSid', {}) }, closed: { ...getPref<Record<string, number>>('extPanelClosed', {}) } })
const panelSubs = new Set<() => void>()
let panelVer = 0
const trim = <V,>(o: Record<string, V>) => Object.fromEntries(Object.entries(o).slice(-PANEL_KEEP))
function changed() {
  const m = memoOf()
  m.per = trim(m.per)
  m.closed = trim(m.closed)
  setPref('extPanelSid', m.per)
  setPref('extPanelClosed', m.closed)
  panelVer++
  for (const f of panelSubs) f()
}
/** The open panel's key (`<ext>/<id>`, '' for none) in a session: its own, else the person's last choice. */
export function panelOpenKey(sid: string) {
  const m = memoOf()
  return sid in m.per ? m.per[sid] : getPref('extPanel', '')
}
export function subscribePanels(f: () => void) {
  panelSubs.add(f)
  return () => void panelSubs.delete(f)
}
const usePanelVer = () => useSyncExternalStore(subscribePanels, () => panelVer)
/** The person opened (key) or folded ('') a panel in a session. Folding is remembered against automatic opening. */
function personSets(sid: string, key: string) {
  const m = memoOf()
  const was = panelOpenKey(sid)
  delete m.per[sid]
  m.per[sid] = key
  if (!key && was) m.closed[`${sid}|${was}`] = Date.now()
  if (key) delete m.closed[`${sid}|${key}`]
  setPref('extPanel', key || null)
  changed()
}
/**
 * An extension opens its own panel in a session (bridge.panels.open). unlessClosed: not when the person folded that
 * panel in that session, so an automatic open (a link added, the session entered) never fights the person.
 */
export function extOpenPanel(sid: string, key: string, unlessClosed = false) {
  const m = memoOf()
  if (unlessClosed && m.closed[`${sid}|${key}`]) return false
  delete m.per[sid]
  m.per[sid] = key
  delete m.closed[`${sid}|${key}`]
  changed()
  return true
}
/** An extension folds its own panel in a session; another extension's open panel is left alone. */
export function extClosePanel(sid: string, key: string) {
  if (panelOpenKey(sid) !== key) return false
  const m = memoOf()
  delete m.per[sid]
  m.per[sid] = ''
  changed()
  return true
}
export function panelStateOf(sid: string, key: string) {
  const open = panelOpenKey(sid)
  return { open: open === key, other: !!open && open !== key, closedByUser: !!memoOf().closed[`${sid}|${key}`] }
}
export function usePanelState(sid: string, key: string) {
  usePanelVer()
  return panelStateOf(sid, key)
}

/** The panels visible for this session, and the open one (null when folded). */
export function useSessionPanels(ctx: SessionSlotCtx | null) {
  const all = useAdded<PanelItem>('session.panel')
  const list = all.filter((i) => {
    if (!ctx) return false
    if (!i.visible) return true
    try {
      return !!i.visible(ctx)
    } catch (e) {
      slotFailed(String(i.extId ?? ''), `session.panel/${i.id} visible`, e)
      return false
    }
  })
  usePanelVer()
  const sid = ctx?.sid ?? ''
  const openKey = sid ? panelOpenKey(sid) : ''
  const open = list.find((i) => keyOf(i) === openKey) ?? null
  const set = (i: PanelItem | null) => {
    if (sid) personSets(sid, i ? keyOf(i) : '')
  }
  return { list, open, set }
}

/** The topbar's button: one panel toggles itself, several open a menu of them. */
export function PanelToggle({ panels }: { panels: ReturnType<typeof useSessionPanels> }) {
  const { list, open, set } = panels
  if (!list.length) return null
  const dot = (i: PanelItem) => badgeText(i.badge) || i.badge === 'dot'
  if (list.length === 1) {
    const i = list[0]
    const t = badgeText(i.badge)
    return (
      <span className="relative slot-action">
        <IconButton icon={i.icon as IconName} label={i.label} active={open === i} aria-pressed={open === i} onClick={() => set(open === i ? null : i)} />
        {t ? <span className={`count${t === 'NEW' ? ' count-new' : ''}`} aria-hidden>{t}</span> : i.badge === 'dot' ? <span className="count count-dot" aria-hidden /> : null}
      </span>
    )
  }
  return (
    <span className="relative slot-action">
      <IconButton
        icon={(open?.icon ?? 'plugin') as IconName}
        label={`패널 ${list.length}개`}
        active={!!open}
        onClick={(e) =>
          openMenu(
            [
              ...list.map((i) => ({ id: i.id, label: i.label, icon: i.icon as IconName, checked: open === i || undefined, onSelect: () => set(open === i ? null : i) })),
              ...(open ? ['sep' as const, { id: 'close', label: '패널 닫기', icon: 'close' as IconName, onSelect: () => set(null) }] : []),
            ],
            e.currentTarget,
          )
        }
      />
      {list.some(dot) ? <span className="count count-dot" aria-hidden /> : null}
    </span>
  )
}

/** The open panel: the dock (wide enough) or a sheet. Nothing when none is open. */
export function SessionPanel({ panels, ctx, onWidth }: { panels: ReturnType<typeof useSessionPanels>; ctx: SessionSlotCtx; onWidth: (w: number) => void }) {
  const { open, set } = panels
  const docked = useMedia(PANEL_DOCK)
  const wKey = open ? `extPanelW.${keyOf(open)}` : ''
  const [w, setW] = useState(PANEL_DEFAULT)
  useEffect(() => {
    if (open) setW(clampW(getPref<number>(wKey, open.width ?? PANEL_DEFAULT)))
  }, [wKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = open && docked ? w : 0
  useEffect(() => onWidth(shown), [shown]) // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => set(null)
  const value = useMemo<PanelCtx | null>(() => (open ? { ...ctx, place: docked ? 'dock' : 'sheet', close } : null), [open, ctx, docked]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!open || !value) return null
  const body = (
    <SlotContext.Provider value={value}>
      <SlotRender key={keyOf(open)} render={open.render} owner={open.extId as string | undefined} />
    </SlotContext.Provider>
  )
  if (!docked)
    return (
      <Sheet open onClose={close} title={open.label} className="ext-panel-sheet">
        {body}
      </Sheet>
    )
  const save = (v: number) => setPref(wKey, v)
  return (
    <aside className="ext-dock" style={{ width: w }} aria-label={open.label} data-slot="session.panel">
      <Resizer w={w} onChange={setW} onDone={save} />
      <div className="ext-panel">
        <div className="ext-panel-head">
          <Icon name={open.icon as IconName} />
          <b>{open.label}</b>
          <IconButton icon="close" label={`${open.label} 닫기`} onClick={close} />
        </div>
        <div className="ext-panel-body">{body}</div>
      </div>
    </aside>
  )
}

/** The dock's left edge: drag (or ←/→ with the keyboard) to change the width. */
function Resizer({ w, onChange, onDone }: { w: number; onChange: (w: number) => void; onDone: (w: number) => void }) {
  const drag = useRef<{ x: number; w: number; last: number } | null>(null)
  return (
    <div
      className="ext-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="패널 폭"
      aria-valuemin={PANEL_MIN}
      aria-valuemax={PANEL_MAX}
      aria-valuenow={w}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, w, last: w }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        d.last = clampW(d.w + (d.x - e.clientX))
        onChange(d.last)
      }}
      onPointerUp={() => {
        if (drag.current) onDone(drag.current.last)
        drag.current = null
      }}
      onPointerCancel={() => (drag.current = null)}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowLeft' ? 24 : e.key === 'ArrowRight' ? -24 : 0
        if (!step) return
        e.preventDefault()
        const v = clampW(w + step)
        onChange(v)
        onDone(v)
      }}
    />
  )
}
