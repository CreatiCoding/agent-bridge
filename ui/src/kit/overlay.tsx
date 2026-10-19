// Things drawn above the page: sheets (a bottom sheet on a phone, a centred panel on a PC), menus, short
// notes (toasts) and the questions the page asks (confirm, prompt). One host component renders them all.
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Button, Icon, type IconName, NO_AUTOFILL, useWide } from './index'

// ---------- leaving ----------

const LEAVE_MS = 180
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Something that goes away stays a moment longer, marked as leaving, so it can fade or sink out instead of
 * vanishing. Returns what to draw (the last value while it leaves) and whether it is leaving.
 */
function useLeaving<T>(value: T | null): [T | null, boolean] {
  const [kept, setKept] = useState<T | null>(value)
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    if (value) return void (setKept(value), setLeaving(false))
    if (reducedMotion()) return void setKept(null)
    setLeaving(true)
    const t = setTimeout(() => (setKept(null), setLeaving(false)), LEAVE_MS)
    return () => clearTimeout(t)
  }, [value])
  return [value ?? kept, !value && leaving]
}

// ---------- sheet ----------

const focusables = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled):not([type=hidden]), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null || el === document.activeElement)

/** Arrow keys, Home and End move between a menu's items; → opens a row's submenu beside it. */
function menuKeys(e: ReactKeyboardEvent<HTMLElement>) {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(':scope > .menu-item:not(:disabled)')]
  const i = items.indexOf(document.activeElement as HTMLElement)
  const go = (n: number) => (e.preventDefault(), e.stopPropagation(), items[(n + items.length) % items.length]?.focus())
  if (e.key === 'ArrowDown') go(i + 1)
  else if (e.key === 'ArrowUp') go(i < 0 ? -1 : i - 1)
  else if (e.key === 'Home') go(0)
  else if (e.key === 'End') go(-1)
  else if (e.key === 'ArrowRight' && items[i]?.getAttribute('aria-haspopup')) {
    e.preventDefault()
    e.stopPropagation()
    items[i].click()
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.menu-fly .menu-item:not(:disabled)')?.focus())
  }
}

export function Sheet({ open, onClose, title, children, footer, wide, className, leaving: leavingFromHost }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; className?: string; leaving?: boolean }) {
  const panel = useRef<HTMLDivElement>(null)
  // A sheet its parent closes (open → false) sinks out before it goes.
  const [present, leavingSelf] = useLeaving(open ? true : null)
  const leaving = leavingFromHost || leavingSelf
  // The latest onClose, so the effect below runs once per opening and not again on every render of the parent:
  // re-running it moved focus out of the field the person was typing in (to the ✕) a few seconds after opening.
  const close = useRef(onClose)
  close.current = onClose
  // What had focus before the sheet opened, taken while rendering: by the time an effect runs, a field inside
  // with autoFocus has taken focus already, and focus went back to that (removed) field, i.e. to the page body.
  const opener = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)
  if (open && !wasOpen.current) opener.current = document.activeElement as HTMLElement | null
  wasOpen.current = open
  useEffect(() => {
    if (!open) return
    const prev = opener.current
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close.current()
      }
      // Tab goes round inside the topmost sheet only, so the keyboard never wanders to the page behind it.
      if (e.key === 'Tab') {
        const p = panel.current
        const sheets = document.querySelectorAll('.sheet')
        if (!p || sheets[sheets.length - 1] !== p) return
        const all = focusables(p)
        if (!all.length) return
        const i = all.indexOf(document.activeElement as HTMLElement)
        const to = e.shiftKey ? (i <= 0 ? all[all.length - 1] : all[i - 1]) : i < 0 || i === all.length - 1 ? all[0] : all[i + 1]
        e.preventDefault()
        to.focus()
      }
    }
    addEventListener('keydown', onKey, true)
    // Focus moves in, so the keyboard works there and a screen reader starts at its title: a field in the body
    // first, then a button in the body or the footer, and only then the ✕ in the head. Never when focus is in already.
    requestAnimationFrame(() => {
      const p = panel.current
      if (!p || p.contains(document.activeElement)) return
      ;(p.querySelector<HTMLElement>('.sheet-body [data-autofocus], .sheet-body input:not([type=hidden]), .sheet-body textarea, .sheet-body select, .sheet-body button, .sheet-foot button') ?? p.querySelector<HTMLElement>('button'))?.focus()
    })
    return () => {
      removeEventListener('keydown', onKey, true)
      if (prev?.isConnected) prev.focus()
    }
  }, [open])
  if (!open && !present) return null
  return createPortal(
    <div className={`scrim${leaving ? ' leaving' : ''}`} onMouseDown={(e) => !leaving && e.target === e.currentTarget && onClose()}>
      <div ref={panel} className={`sheet${wide ? ' sheet-wide' : ''}${leaving ? ' leaving' : ''}${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="sheet-grip" aria-hidden />
        {title ? (
          <div className="sheet-head">
            <h2 className="sheet-title">{title}</h2>
            <button type="button" className="icon-btn" aria-label="닫기" onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>
        ) : null}
        <div className="sheet-body">{children}</div>
        {footer ? <div className="sheet-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  )
}

// ---------- menu ----------

export interface MenuItem {
  label: ReactNode
  icon?: IconName
  danger?: boolean
  checked?: boolean
  disabled?: boolean
  hint?: ReactNode
  onSelect?: () => void
  /** A submenu, shown in place (a phone) or beside (a PC). */
  items?: MenuItem[]
}
export type MenuEntry = MenuItem | 'sep' | { header: ReactNode }

interface MenuReq {
  items: MenuEntry[]
  at: { x: number; y: number; under?: DOMRect }
  title?: ReactNode
}

// ---------- the overlay host ----------

type Dialog =
  | { kind: 'confirm'; title: ReactNode; text?: ReactNode; ok: string; cancel?: string; danger?: boolean; resolve: (v: boolean) => void }
  | { kind: 'prompt'; title: ReactNode; text?: ReactNode; value: string; placeholder?: string; ok: string; multiline?: boolean; resolve: (v: string | null) => void }
  | { kind: 'choose'; title: ReactNode; text?: ReactNode; options: { value: string; label: ReactNode; hint?: ReactNode; danger?: boolean }[]; resolve: (v: string | null) => void }

interface Overlay {
  menu: MenuReq | null
  dialog: Dialog | null
  toasts: { id: number; text: ReactNode; tone?: 'ok' | 'bad'; ms: number; action?: { label: string; run: () => void }; leaving?: boolean }[]
}
let ov: Overlay = { menu: null, dialog: null, toasts: [] }
const subs = new Set<() => void>()
const setOv = (p: Partial<Overlay>) => {
  ov = { ...ov, ...p }
  subs.forEach((f) => f())
}
const useOv = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => ov,
  )

/** Open a menu at an element (under it) or at a point (a right-click). */
export function openMenu(items: MenuEntry[], at: HTMLElement | { x: number; y: number }, title?: ReactNode) {
  const pos = at instanceof HTMLElement ? (() => {
    const r = at.getBoundingClientRect()
    return { x: r.left, y: r.bottom + 4, under: r }
  })() : at
  setOv({ menu: { items, at: pos, title } })
}
export const closeMenu = () => setOv({ menu: null })

let toastSeq = 0
/**
 * A note at the bottom of the screen. Its time runs out on the bar along its foot (a CSS animation, so pointing at
 * the note pauses it), and it can be closed early with × or by swiping it sideways.
 */
export function toast(text: ReactNode, opts: { tone?: 'ok' | 'bad'; ms?: number; action?: { label: string; run: () => void } } = {}) {
  const id = ++toastSeq
  const ms = opts.ms ?? (opts.action ? 6000 : opts.tone === 'bad' ? 5000 : 3200)
  setOv({ toasts: [...ov.toasts.slice(-2), { id, text, tone: opts.tone, ms, action: opts.action }] })
}
/** It sinks away first, then goes. */
function dismissToast(id: number) {
  if (!ov.toasts.some((t) => t.id === id && !t.leaving)) return
  setOv({ toasts: ov.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) })
  setTimeout(() => setOv({ toasts: ov.toasts.filter((t) => t.id !== id) }), reducedMotion() ? 0 : LEAVE_MS)
}

const TOAST_ICON: Record<'ok' | 'bad' | 'note', IconName> = { ok: 'check', bad: 'warn', note: 'check' }
/** A swipe further than this (px) sideways closes the note. */
const SWIPE_CLOSE = 72

function ToastItem({ t }: { t: Overlay['toasts'][number] }) {
  const el = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; id: number } | null>(null)
  const kind = t.tone ?? 'note'
  const down = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    drag.current = { x: e.clientX, id: e.pointerId }
    el.current?.setPointerCapture(e.pointerId)
    el.current?.classList.add('dragging')
  }
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId || !el.current) return
    const dx = e.clientX - d.x
    el.current.style.transform = `translateX(${dx}px)`
    el.current.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / 220))
  }
  const up = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId || !el.current) return
    drag.current = null
    const dx = e.clientX - d.x
    el.current.classList.remove('dragging')
    if (Math.abs(dx) > SWIPE_CLOSE) {
      el.current.classList.add('swiped')
      el.current.style.transform = `translateX(${dx > 0 ? 120 : -120}%)`
      el.current.style.opacity = '0'
      dismissToast(t.id)
    } else {
      el.current.style.transform = ''
      el.current.style.opacity = ''
    }
  }
  return (
    <div
      ref={el}
      className={`toast toast-${kind}${t.leaving ? ' leaving' : ''}`}
      role={t.tone === 'bad' ? 'alert' : 'status'}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <span className="toast-icon" aria-hidden>
        <Icon name={TOAST_ICON[kind]} />
      </span>
      <span className="toast-text">{t.text}</span>
      {t.action ? (
        <button type="button" className="toast-action" onClick={() => (t.action?.run(), dismissToast(t.id))}>
          {t.action.label}
        </button>
      ) : null}
      <button type="button" className="toast-close" aria-label="닫기" onClick={() => dismissToast(t.id)}>
        <Icon name="close" />
      </button>
      <span className="toast-time" aria-hidden>
        <i style={{ animationDuration: `${t.ms}ms` }} onAnimationEnd={() => dismissToast(t.id)} />
      </span>
    </div>
  )
}

export const confirmDialog = (title: ReactNode, opts: { text?: ReactNode; ok?: string; cancel?: string; danger?: boolean } = {}) =>
  new Promise<boolean>((resolve) => setOv({ dialog: { kind: 'confirm', title, text: opts.text, ok: opts.ok ?? '확인', cancel: opts.cancel, danger: opts.danger, resolve } }))
/** Close the open dialog as if cancelled (a link inside it that goes elsewhere). */
export function cancelDialog() {
  const d = ov.dialog
  if (!d) return
  setOv({ dialog: null })
  ;(d.resolve as (x: unknown) => void)(d.kind === 'confirm' ? false : null)
}
export const promptDialog = (title: ReactNode, opts: { text?: ReactNode; value?: string; placeholder?: string; ok?: string; multiline?: boolean } = {}) =>
  new Promise<string | null>((resolve) => setOv({ dialog: { kind: 'prompt', title, text: opts.text, value: opts.value ?? '', placeholder: opts.placeholder, ok: opts.ok ?? '확인', multiline: opts.multiline, resolve } }))
export const chooseDialog = (title: ReactNode, options: { value: string; label: ReactNode; hint?: ReactNode; danger?: boolean }[], text?: ReactNode) =>
  new Promise<string | null>((resolve) => setOv({ dialog: { kind: 'choose', title, text, options, resolve } }))

function MenuList({ items, onDone, hover }: { items: MenuEntry[]; onDone: () => void; hover?: boolean }) {
  // On a phone a submenu replaces the list, and one inside it replaces that: back goes up one at a time.
  const [subs, setSubs] = useState<MenuItem[]>([])
  const sub = subs[subs.length - 1]
  const setSub = (it: MenuItem) => setSubs((p) => [...p, it])
  // On a PC a submenu opens beside its row as soon as the pointer rests on it.
  const [fly, setFly] = useState<{ item: MenuItem; at: DOMRect } | null>(null)
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  const list = sub ? [{ label: <b>{sub.label}</b>, icon: 'back', onSelect: () => setSubs((p) => p.slice(0, -1)), keep: true } as MenuItem & { keep: boolean }, 'sep' as const, ...(sub.items ?? [])] : items
  return (
    <div className="menu-list" role="menu" onKeyDown={menuKeys}>
      {list.map((it, i) => {
        if (it === 'sep') return <div key={i} className="menu-sep" role="separator" />
        if ('header' in it) return <div key={i} className="menu-header">{it.header}</div>
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            aria-haspopup={it.items ? 'menu' : undefined}
            aria-expanded={it.items && hover ? fly?.item === it : undefined}
            className={`menu-item${it.danger ? ' danger' : ''}${hover && fly?.item === it ? ' open' : ''}`}
            disabled={it.disabled}
            onMouseEnter={
              hover
                ? (e) => {
                    clearTimeout(timer.current)
                    const at = e.currentTarget.getBoundingClientRect()
                    timer.current = window.setTimeout(() => setFly(it.items ? { item: it, at } : null), it.items ? 80 : 160)
                  }
                : undefined
            }
            onClick={(e) => {
              if (it.items) {
                if (!hover) return setSub(it)
                clearTimeout(timer.current)
                return setFly({ item: it, at: e.currentTarget.getBoundingClientRect() })
              }
              if ((it as { keep?: boolean }).keep) return it.onSelect?.()
              onDone()
              it.onSelect?.()
            }}
          >
            <span className="menu-icon">{it.checked ? <Icon name="check" /> : it.icon ? <Icon name={it.icon} /> : null}</span>
            <span className="menu-label">{it.label}</span>
            {it.hint ? <span className="menu-hint">{it.hint}</span> : null}
            {it.items ? <Icon name="forward" /> : null}
          </button>
        )
      })}
      {hover && fly ? <FlyMenu key={String(list.indexOf(fly.item))} item={fly.item} at={fly.at} onDone={onDone} onEnter={() => clearTimeout(timer.current)} /> : null}
    </div>
  )
}

/** A submenu beside its row: to the right, or to the left when the right has no room. */
function FlyMenu({ item, at, onDone, onEnter }: { item: MenuItem; at: DOMRect; onDone: () => void; onEnter: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: at.right + 4, top: at.top - 5, visible: false })
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left = at.right + 4
    if (left + w > innerWidth - 8) left = Math.max(8, at.left - w - 4)
    const top = Math.max(8, Math.min(at.top - 5, innerHeight - h - 8))
    setPos({ left, top, visible: true })
  }, [at])
  return (
    <div ref={box} className="menu-pop menu-fly" style={{ left: pos.left, top: pos.top, visibility: pos.visible ? 'visible' : 'hidden' }} onMouseEnter={onEnter}>
      <MenuList items={item.items ?? []} onDone={onDone} hover />
    </div>
  )
}

function FloatingMenu({ req, leaving }: { req: MenuReq; leaving?: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: req.at.x, top: req.at.y, visible: false })
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left = req.at.under ? Math.min(req.at.under.right - w, Math.max(req.at.under.left, req.at.x)) : req.at.x
    let top = req.at.y
    left = Math.max(8, Math.min(left, innerWidth - w - 8))
    if (top + h > innerHeight - 8) top = req.at.under ? req.at.under.top - h - 4 : innerHeight - h - 8
    setPos({ left, top: Math.max(8, top), visible: true })
  }, [req])
  // The keyboard: focus moves to the first item when the menu opens; Escape or Tab closes it, and focus goes back
  // to what opened it (a menu at the end of the page could not be reached with Tab).
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    opener.current = document.activeElement as HTMLElement | null
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>('.menu-item:not(:disabled)')?.focus())
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Tab') return
      e.preventDefault()
      e.stopPropagation()
      closeMenu()
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [])
  useEffect(() => {
    if (leaving && box.current?.contains(document.activeElement)) opener.current?.focus?.()
  }, [leaving])
  return (
    <div className={`menu-scrim${leaving ? ' leaving' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && closeMenu()} onContextMenu={(e) => (e.preventDefault(), closeMenu())}>
      <div ref={box} className="menu-pop" style={{ left: pos.left, top: pos.top, visibility: pos.visible ? 'visible' : 'hidden' }}>
        {req.title ? <div className="menu-title">{req.title}</div> : null}
        <MenuList items={req.items} onDone={closeMenu} hover />
      </div>
    </div>
  )
}

function DialogView({ d, leaving }: { d: Dialog; leaving?: boolean }) {
  const [value, setValue] = useState(d.kind === 'prompt' ? d.value : '')
  const done = (v: unknown) => {
    setOv({ dialog: null })
    ;(d.resolve as (x: unknown) => void)(v)
  }
  const cancel = () => done(d.kind === 'confirm' ? false : null)
  return (
    <Sheet
      open
      leaving={leaving}
      onClose={cancel}
      title={d.title}
      footer={
        d.kind === 'choose' ? (
          <Button block onClick={cancel}>
            닫기
          </Button>
        ) : (
          <div className="dialog-buttons">
            <Button onClick={cancel}>{(d.kind === 'confirm' && d.cancel) || '취소'}</Button>
            <Button tone={d.kind === 'confirm' && d.danger ? 'danger' : 'primary'} onClick={() => done(d.kind === 'confirm' ? true : value)} disabled={d.kind === 'prompt' && !value.trim()}>
              {d.ok}
            </Button>
          </div>
        )
      }
    >
      {d.text ? <div className="dialog-text">{d.text}</div> : null}
      {d.kind === 'prompt' ? (
        d.multiline ? (
          <textarea className="input" {...NO_AUTOFILL} autoFocus rows={8} value={value} placeholder={d.placeholder} onChange={(e) => setValue(e.target.value)} />
        ) : (
          <input
            className="input"
            autoFocus
            value={value}
            placeholder={d.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && value.trim() && done(value)}
          />
        )
      ) : null}
      {d.kind === 'choose' ? (
        <div className="choose-list">
          {d.options.map((o) => (
            <button key={o.value} type="button" className={`choose-item${o.danger ? ' danger' : ''}`} onClick={() => done(o.value)}>
              <span>{o.label}</span>
              {o.hint ? <span className="choose-hint">{o.hint}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </Sheet>
  )
}

export function OverlayHost() {
  const o = useOv()
  const wide = useWide()
  const [menu, menuLeaving] = useLeaving(o.menu)
  const [dialog, dialogLeaving] = useLeaving(o.dialog)
  return (
    <>
      {menu ? (
        wide ? (
          <FloatingMenu req={menu} leaving={menuLeaving} />
        ) : (
          <Sheet open leaving={menuLeaving} onClose={closeMenu} title={menu.title} className="sheet-menu">
            <MenuList items={menu.items} onDone={closeMenu} />
          </Sheet>
        )
      ) : null}
      {dialog ? <DialogView key={String(dialog.title)} d={dialog} leaving={dialogLeaving} /> : null}
      {createPortal(
        <div className="toasts" aria-live="polite">
          {o.toasts.map((t) => (
            <ToastItem key={t.id} t={t} />
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}
