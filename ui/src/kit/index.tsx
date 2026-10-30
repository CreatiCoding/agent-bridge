// The page's own small set of controls. Styles are in styles.css under the same class names.
import type React from 'react'
import { type ButtonHTMLAttributes, type ReactNode, forwardRef, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { Icon, type IconName } from './icons'

export { Icon, ICONS, Logo, type IconName } from './icons'

type Tone = 'primary' | 'plain' | 'danger' | 'ghost' | 'soft'

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; size?: 'sm' | 'md' | 'lg'; icon?: IconName; busy?: boolean; block?: boolean }>(function Button(
  { tone = 'plain', size = 'md', icon, busy, block, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button ref={ref} type="button" className={`btn btn-${tone} btn-${size}${block ? ' btn-block' : ''}${className ? ` ${className}` : ''}`} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <Spinner size={14} /> : icon ? <Icon name={icon} /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  )
})

/** keepFocus: a press leaves the focus where it is (a text box keeps it, and a phone's keyboard stays up). */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; active?: boolean; keepFocus?: boolean }>(function IconButton(
  { icon, label, active, className, keepFocus, onMouseDown, ...rest },
  ref,
) {
  const down = keepFocus
    ? (e: React.MouseEvent<HTMLButtonElement>) => {
        const a = document.activeElement
        if (a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement) e.preventDefault()
        onMouseDown?.(e)
      }
    : onMouseDown
  return (
    <button ref={ref} type="button" className={`icon-btn${active ? ' on' : ''}${className ? ` ${className}` : ''}`} aria-label={label} title={label} onMouseDown={down} {...rest}>
      <Icon name={icon} />
    </button>
  )
})

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="불러오는 중" />
}

export function Badge({ tone = 'grey', children, dot }: { tone?: 'grey' | 'blue' | 'green' | 'red' | 'amber' | 'violet'; children?: ReactNode; dot?: boolean }) {
  return <span className={`badge badge-${tone}${dot ? ' badge-dot' : ''}`}>{children}</span>
}

export function Chip({ children, icon, onClick, active, tone, title }: { children: ReactNode; icon?: IconName; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; active?: boolean; tone?: 'warn' | 'ok' | 'bad' | 'merged'; title?: string }) {
  const cls = `chip${active ? ' on' : ''}${tone ? ` chip-${tone}` : ''}${onClick ? ' chip-btn' : ''}`
  const inner = (
    <>
      {icon ? <Icon name={icon} /> : null}
      <span>{children}</span>
    </>
  )
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} title={title}>
      {inner}
    </button>
  ) : (
    <span className={cls} title={title}>
      {inner}
    </span>
  )
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`switch${checked ? ' on' : ''}`} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="switch-knob" />
    </button>
  )
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, hint, children }: { label?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      {label ? <span className="field-label">{label}</span> : null}
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  )
}

/** A row in a list: something on the left, text in the middle, something on the right, and maybe a press. */
/**
 * A one-line (or, with rows, several-line) text box in the page's style; the several-line one is left alone by
 * password managers and autocorrect. On one line, Enter (not while a Korean syllable is being put together) calls onEnter.
 */
export const TextField = forwardRef<HTMLInputElement & HTMLTextAreaElement, { value: string; onChange: (v: string) => void; label?: string; placeholder?: string; rows?: number; autoFocus?: boolean; disabled?: boolean; onEnter?: () => void }>(function TextField({ value, onChange, label, placeholder, rows, autoFocus, disabled, onEnter }, ref) {
  return rows ? (
    <textarea ref={ref} className="input" {...NO_AUTOFILL} aria-label={label} autoFocus={autoFocus} disabled={disabled} rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
  ) : (
    <input ref={ref} className="input" aria-label={label} autoFocus={autoFocus} disabled={disabled} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && onEnter?.()} />
  )
})

export function Row({ left, title, sub, right, onClick, onContextMenu, active, href, className, chevron }: { left?: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode; onClick?: () => void; onContextMenu?: (e: React.MouseEvent) => void; active?: boolean; href?: string; className?: string; chevron?: boolean }) {
  const body = (
    <>
      {left ? <span className="row-left">{left}</span> : null}
      <span className="row-main">
        <span className="row-title">{title}</span>
        {sub ? <span className="row-sub">{sub}</span> : null}
      </span>
      {right ? <span className="row-right">{right}</span> : null}
      {chevron ? <Icon name="forward" className="row-chevron" /> : null}
    </>
  )
  const cls = `row${active ? ' active' : ''}${onClick || href ? ' row-btn' : ''}${className ? ` ${className}` : ''}`
  if (href)
    return (
      <a className={cls} href={href} onContextMenu={onContextMenu}>
        {body}
      </a>
    )
  if (onClick)
    return (
      <button type="button" className={cls} onClick={onClick} onContextMenu={onContextMenu}>
        {body}
      </button>
    )
  return <div className={cls}>{body}</div>
}

export function SectionHeader({ title, right, onClick, folded }: { title: ReactNode; right?: ReactNode; onClick?: () => void; folded?: boolean }) {
  // The whole line folds, not only the words: a press on the blank part of a group's head counts too. The
  // buttons on the right (the ⋯ menu) and the title button itself handle their own presses.
  const onLine = onClick
    ? (e: React.MouseEvent<HTMLDivElement>) => {
        const t = e.target as HTMLElement
        if (t.closest('.section-right') || t.closest('.section-toggle')) return
        onClick()
      }
    : undefined
  return (
    <div className={`section-head${onClick ? ' section-click' : ''}`} onClick={onLine}>
      {onClick ? (
        <button type="button" className="section-title section-toggle" onClick={onClick} aria-expanded={!folded}>
          <Icon name="forward" className={`chev${folded ? '' : ' chev-open'}`} />
          <span>{title}</span>
        </button>
      ) : (
        <span className="section-title">{title}</span>
      )}
      {right ? <span className="section-right">{right}</span> : null}
    </div>
  )
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Something that opens and closes in place (a group's sessions, a tool call's output): it grows from its head and
 * fades in, and shrinks back before it goes. Closed, it is not in the page at all, so a long list costs nothing
 * while folded. Only grid rows and opacity change; with reduced motion it simply appears and disappears.
 */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(open)
  const [settled, setSettled] = useState(open)
  useLayoutEffect(() => {
    if (open) {
      setMounted(true)
      setSettled(false)
      if (reducedMotion()) return void (setShown(true), setSettled(true))
      // One frame closed first, so the change to open is a transition and not where it starts.
      const f = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)))
      return () => cancelAnimationFrame(f)
    }
    setSettled(false)
    setShown(false)
    if (reducedMotion()) setMounted(false)
  }, [open])
  if (!mounted) return null
  return (
    <div
      className={`collapse${shown ? ' open' : ''}${settled ? ' settled' : ''}${className ? ` ${className}` : ''}`}
      onTransitionEnd={(e) => {
        if (e.target !== e.currentTarget || e.propertyName !== 'grid-template-rows') return
        if (open) setSettled(true)
        else setMounted(false)
      }}
    >
      <div className="collapse-in">{children}</div>
    </div>
  )
}

export function Empty({ icon = 'info', title, children, action }: { icon?: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} />
      </span>
      <p className="empty-title">{title}</p>
      {children ? <div className="empty-text">{children}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  )
}

/**
 * A read that failed: what could not be read, why, and a way to try again. Never shown as "nothing there": an
 * empty list or field in its place read as the truth (and a field saved from it overwrote the real value).
 */
export function LoadError({ what, error, onRetry }: { what: ReactNode; error?: unknown; onRetry: () => void }) {
  const why = error instanceof Error ? error.message : error ? String(error) : ''
  return (
    <Empty
      icon="warn"
      title={<>{what} 불러오지 못했어요</>}
      action={
        <Button icon="refresh" onClick={onRetry}>
          다시 시도
        </Button>
      }
    >
      {why || '연결을 확인하고 다시 시도해 주세요.'}
    </Empty>
  )
}

export function useMedia(query: string) {
  return useSyncExternalStore(
    (f) => {
      const m = matchMedia(query)
      m.addEventListener('change', f)
      return () => m.removeEventListener('change', f)
    },
    () => matchMedia(query).matches,
  )
}
/** Wide enough for the list beside the conversation. */
const WIDE = '(min-width: 744px)'
export const useWide = () => useMedia(WIDE)
/** The same, read once (outside a render). */
export const wideNow = () => matchMedia(WIDE).matches

/** Re-render every `ms`, for relative times. */
/**
 * One clock for every relative time on the page ("3분 전"): a shared 30 s tick, so a time can redraw on its own
 * without its row or list redrawing.
 */
let sharedTick = 0
const tickSubs = new Set<() => void>()
let tickTimer = 0
const subscribeTick = (f: () => void) => {
  tickSubs.add(f)
  if (!tickTimer) tickTimer = window.setInterval(() => ((sharedTick += 1), tickSubs.forEach((g) => g())), 30_000)
  return () => {
    tickSubs.delete(f)
    if (!tickSubs.size) (clearInterval(tickTimer), (tickTimer = 0))
  }
}
export function Ago({ t, format }: { t: number; format: (t: number) => string }) {
  useSyncExternalStore(subscribeTick, () => sharedTick)
  return <>{format(t)}</>
}

/**
 * For a box of free text (a message, a prompt): no AutoFill. iOS Safari guesses a contact or an address field from
 * little and puts "자동 완성 연락처" over the keyboard; autocomplete="off" alone does not stop it, a name with
 * "search" in it does (Safari leaves search fields alone). Password managers are told to keep out too.
 * No autocorrect, spell check or auto capitals either: the person does not use them, and with them off iOS is
 * reported to leave out the ↑ ↓ ✓ bar over the keyboard (a trial, REQ-F-721).
 */
export const NO_AUTOFILL = { autoComplete: 'off', name: 'cb-text-search', autoCorrect: 'off', spellCheck: false, autoCapitalize: 'none', 'data-1p-ignore': true, 'data-lpignore': 'true', 'data-form-type': 'other' } as const

export function useTick(ms = 30_000) {
  const [, set] = useState(0)
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms)
    return () => clearInterval(t)
  }, [ms])
}

/**
 * A card's title and what the card is for. A PC shows the words under the title; a phone keeps them behind ⓘ
 * beside it, so a screen of cards reads as their titles and controls first.
 */
export function CardHead({ title, help, medium }: { title: ReactNode; help?: ReactNode; medium?: boolean }) {
  const wide = useWide()
  const [open, setOpen] = useState(false)
  return (
    <>
      <h2 className="card-head" style={{ marginTop: 0 }}>
        {title}
        {!wide && help ? <IconButton icon="info" label={open ? '설명 닫기' : '설명 보기'} active={open} aria-expanded={open} onClick={() => setOpen((o) => !o)} /> : null}
      </h2>
      {help && (wide || open) ? (
        <p className="muted" style={{ fontSize: medium ? 'var(--fs-medium)' : 'var(--fs-small)', marginTop: 0 }}>
          {help}
        </p>
      ) : null}
    </>
  )
}

/**
 * On a phone, a part of a page that is not needed every time folds into one line (its icon, its name, a chevron)
 * and opens in place; a PC shows it as it is.
 */
export function PhoneFold({ icon, title, hint, children, open: initial = false }: { icon: IconName; title: ReactNode; hint?: ReactNode; children: ReactNode; open?: boolean }) {
  const wide = useWide()
  const [open, setOpen] = useState(initial)
  // Asked open later (what it holds turned out to be needed, e.g. no Mac yet): it opens then too.
  useEffect(() => {
    if (initial) setOpen(true)
  }, [initial])
  if (wide) return <>{children}</>
  return (
    <div className="phone-fold">
      <button type="button" className="link-row phone-fold-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name={icon} />
        <span className="grow">{title}</span>
        {hint && !open ? <span className="muted">{hint}</span> : null}
        <Icon name="forward" className={`chev${open ? ' chev-open' : ''}`} />
      </button>
      <Collapse open={open}>{children}</Collapse>
    </div>
  )
}

/**
 * A setting's explanation under its name. A PC shows it; a phone puts ⓘ after the name and shows it when pressed.
 */
export function Help({ children }: { children: ReactNode }) {
  const wide = useWide()
  const [open, setOpen] = useState(false)
  const text = (
    <>
      <br />
      <span className="muted" style={{ fontSize: 'var(--fs-small)' }}>
        {children}
      </span>
    </>
  )
  if (wide) return text
  return (
    <>
      <IconButton icon="info" label={open ? '설명 닫기' : '설명 보기'} className="help-btn" active={open} aria-expanded={open} onClick={() => setOpen((o) => !o)} />
      {open ? text : null}
    </>
  )
}
