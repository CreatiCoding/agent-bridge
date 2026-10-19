// Touch gestures for phones: a row that slides to show its actions, and sliding back from the left edge.
import { useEffect, useRef } from 'react'

/** Only one row is open at a time: opening one closes the last. */
let openRow: (() => void) | null = null

/**
 * A row slid to the left shows the actions behind it (width `reveal` px). Vertical scrolling is left alone:
 * the slide starts only when the finger moves more sideways than down. Returns props for the sliding part.
 */
export function useSwipeRow(reveal: number, enabled: boolean) {
  const el = useRef<HTMLElement | null>(null)
  const st = useRef({ x: 0, y: 0, dx: 0, open: false, active: false, decided: false, horizontal: false })
  const place = (x: number, animate: boolean) => {
    const e = el.current
    if (!e) return
    e.style.transition = animate ? 'transform .18s ease' : 'none'
    e.style.transform = x ? `translateX(${x}px)` : ''
    // The actions behind show only while the row is moved: at rest even the clip's soft edge would let them through.
    const box = e.parentElement
    if (x) box?.classList.add('swiping')
    else setTimeout(() => !e.style.transform && box?.classList.remove('swiping'), animate ? 200 : 0)
  }
  const close = () => {
    st.current.open = false
    place(0, true)
  }
  useEffect(() => () => void (openRow === close && (openRow = null)))
  if (!enabled) return { ref: el, handlers: {}, close, isOpen: () => false }
  const handlers = {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0]
      Object.assign(st.current, { x: t.clientX, y: t.clientY, dx: 0, active: true, decided: false, horizontal: false })
    },
    onTouchMove: (e: React.TouchEvent) => {
      const s = st.current
      if (!s.active) return
      const t = e.touches[0]
      const dx = t.clientX - s.x
      const dy = t.clientY - s.y
      if (!s.decided && Math.abs(dx) + Math.abs(dy) > 8) (s.decided = true), (s.horizontal = Math.abs(dx) > Math.abs(dy) * 1.2)
      if (!s.horizontal) return
      s.dx = dx
      const base = s.open ? -reveal : 0
      place(Math.min(0, Math.max(-reveal - 24, base + dx)), false)
    },
    onTouchEnd: () => {
      const s = st.current
      s.active = false
      if (!s.horizontal) return
      const base = s.open ? -reveal : 0
      const open = base + s.dx < -reveal / 2
      s.open = open
      place(open ? -reveal : 0, true)
      if (open) {
        if (openRow && openRow !== close) openRow()
        openRow = close
      }
    },
  }
  return { ref: el, handlers, close, isOpen: () => st.current.open || st.current.horizontal }
}

/**
 * Sliding from the left edge of the screen goes back, as a phone's own gesture does. Not where the browser
 * already does this itself (Safari on iOS, outside a home-screen app), so the two do not fight.
 *
 * As on a phone, the screen it goes back to shows underneath while the page slides: a touch at the edge asks the
 * app (event `cb-peek`) to lay the list under the page, and the list follows from 30 % to the left (parallax).
 * Only for the length of the gesture: the list is not drawn under a conversation otherwise.
 */
const peek = (on: boolean) => dispatchEvent(new CustomEvent('cb-peek', { detail: on }))
const PARALLAX = 0.3
export function useEdgeSwipeBack(el: HTMLElement | null, enabled: boolean, onBack: () => void) {
  useEffect(() => {
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent)
    const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
    if (!el || !enabled || (ios && !standalone)) return
    let start: { x: number; y: number } | null = null
    let dx = 0
    let horizontal: boolean | null = null
    const place = (x: number, animate: boolean) => {
      const ease = animate ? 'transform .18s ease' : 'none'
      el.style.transition = animate ? `${ease}, box-shadow .18s ease` : 'none'
      el.style.transform = x ? `translateX(${x}px)` : ''
      // Above the list underneath, with an edge shadow as the page lifts off it.
      el.style.zIndex = x ? '2' : ''
      el.style.boxShadow = x ? '-8px 0 24px rgba(0, 0, 0, .18)' : ''
      const under = document.querySelector<HTMLElement>('.under-list')
      if (under) {
        under.style.transition = ease
        under.style.transform = `translateX(${(x / innerWidth - 1) * PARALLAX * innerWidth}px)`
      }
    }
    const down = (e: TouchEvent) => {
      const t = e.touches[0]
      start = t.clientX <= 24 ? { x: t.clientX, y: t.clientY } : null
      dx = 0
      horizontal = null
      if (start) peek(true)
    }
    const move = (e: TouchEvent) => {
      if (!start) return
      const t = e.touches[0]
      dx = Math.max(0, t.clientX - start.x)
      if (horizontal === null && Math.abs(dx) + Math.abs(t.clientY - start.y) > 8) horizontal = dx > Math.abs(t.clientY - start.y)
      if (!horizontal) return
      e.preventDefault()
      place(dx, false)
    }
    const up = () => {
      if (!start || !horizontal) {
        if (start) peek(false)
        return void (start = null)
      }
      start = null
      if (dx > 80) {
        place(innerWidth, true)
        setTimeout(() => (place(0, false), onBack(), peek(false)), 180)
      } else {
        place(0, true)
        setTimeout(() => peek(false), 180)
      }
    }
    el.addEventListener('touchstart', down, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', up)
    el.addEventListener('touchcancel', up)
    return () => {
      el.removeEventListener('touchstart', down)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', up)
      el.removeEventListener('touchcancel', up)
    }
  }, [el, enabled, onBack])
}
