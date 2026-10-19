// Groups put in order by dragging their head, with a finger and with a mouse: the group follows the pointer and
// the groups beside it (same level) make room as it passes. A finger holds the head a moment first, so a quick
// slide still scrolls the list; a mouse starts as soon as it moves.
import { useEffect, useRef, useState } from 'react'

const HOLD_MS = 300
const SLOP = 8
const MOUSE_SLOP = 4
/** How near the edge of the list's view the pointer has to be for the list to scroll, and how fast at most. */
const EDGE = 48
const SPEED = 14

type Sort = {
  id: string
  els: HTMLElement[]
  /** Where each group's name row is centred: the place is chosen by these, not by the whole (opened) block. */
  mids: number[]
  /** The room one block takes, gap included: what the others move by. */
  slot: number
  from: number
  to: number
  startY: number
  startScroll: number
  scroller: HTMLElement
  y: number
  frame: number
}

function scrollParent(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) return p
  return document.scrollingElement as HTMLElement
}

/**
 * `commit(id, before)`: the group goes before `before` among the groups beside it (null: last). Called once, on
 * release, when its place changed. `headProps(id)` go on the group's head, inside its `.group-block`.
 */
export function useGroupSort(commit: (id: string, before: string | null) => void) {
  const [sorting, setSorting] = useState<string | null>(null)
  const st = useRef<Sort | null>(null)
  const press = useRef<{ id: string; head: HTMLElement; x: number; y: number; touch: boolean; timer: number } | null>(null)
  /** A press that ended a drag is not also a click (it would fold the group). */
  const dragged = useRef(false)
  const commitRef = useRef(commit)
  commitRef.current = commit

  const place = (s: Sort) => {
    const dy = s.y - s.startY + s.scroller.scrollTop - s.startScroll
    const center = s.mids[s.from] + dy
    let to = s.from
    s.mids.forEach((mid, i) => {
      if (i < s.from && center < mid) to = Math.min(to, i)
      if (i > s.from && center > mid) to = Math.max(to, i)
    })
    s.to = to
    s.els.forEach((e, i) => {
      if (i === s.from) e.style.transform = `translateY(${dy}px)`
      else e.style.transform = s.from < i && i <= to ? `translateY(${-s.slot}px)` : to <= i && i < s.from ? `translateY(${s.slot}px)` : ''
    })
  }

  const tick = () => {
    const s = st.current
    if (!s) return
    const box = s.scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : s.scroller.getBoundingClientRect()
    const v = s.y < box.top + EDGE ? -Math.ceil(((box.top + EDGE - s.y) / EDGE) * SPEED) : s.y > box.bottom - EDGE ? Math.ceil(((s.y - box.bottom + EDGE) / EDGE) * SPEED) : 0
    if (v) {
      s.scroller.scrollTop += v
      place(s)
    }
    s.frame = requestAnimationFrame(tick)
  }

  // A finger's slide scrolls the page unless stopped from its first move: the listener is there for the whole
  // touch and stops it only while a group is held.
  const noScroll = (e: TouchEvent) => st.current && e.cancelable && e.preventDefault()

  const begin = (id: string, head: HTMLElement, y: number) => {
    const block = head.closest('.group-block') as HTMLElement | null
    if (!block?.parentElement) return
    const els = [...block.parentElement.children].filter((e): e is HTMLElement => e instanceof HTMLElement && e.classList.contains('group-block'))
    const from = els.indexOf(block)
    if (from < 0) return
    const rects = els.map((e) => e.getBoundingClientRect())
    const next = rects[from + 1]
    const prev = rects[from - 1]
    const slot = next ? next.top - rects[from].top : prev ? rects[from].bottom - prev.bottom : rects[from].height
    const scroller = scrollParent(block)
    const mids = els.map((e, i) => {
      const r = (e.querySelector(':scope > .group-head') ?? e).getBoundingClientRect()
      return r.height ? r.top + r.height / 2 : rects[i].top + rects[i].height / 2
    })
    st.current = { id, els, mids, slot, from, to: from, startY: y, startScroll: scroller.scrollTop, scroller, y, frame: 0 }
    els.forEach((e) => (e.style.transition = e === block ? 'none' : 'transform .16s ease'))
    block.classList.add('sorting')
    document.body.classList.add('group-sorting')
    navigator.vibrate?.(8)
    dragged.current = true
    setSorting(id)
    st.current.frame = requestAnimationFrame(tick)
  }

  const finish = (cancel: boolean) => {
    const p = press.current
    if (p) clearTimeout(p.timer)
    press.current = null
    removeEventListener('pointermove', onMove)
    removeEventListener('pointerup', onUp)
    removeEventListener('pointercancel', onCancel)
    removeEventListener('touchmove', noScroll)
    const s = st.current
    if (!s) return
    st.current = null
    cancelAnimationFrame(s.frame)
    const order = s.els.map((e) => e.dataset.gid ?? '')
    const moved = !cancel && s.to !== s.from
    if (moved) {
      order.splice(s.to, 0, order.splice(s.from, 1)[0])
      // Drawn in its new place first (the caller re-renders at once), then the moves taken off: no jump back.
      commitRef.current(s.id, order[s.to + 1] ?? null)
    }
    s.els.forEach((e) => ((e.style.transition = moved ? 'none' : 'transform .16s ease'), (e.style.transform = '')))
    s.els[s.from].classList.remove('sorting')
    document.body.classList.remove('group-sorting')
    setSorting(null)
    // The click that follows the release comes before the next frame.
    setTimeout(() => (dragged.current = false), 0)
  }

  function onMove(e: PointerEvent) {
    const p = press.current
    if (!p) return
    const s = st.current
    if (s) {
      s.y = e.clientY
      place(s)
      return
    }
    const far = Math.hypot(e.clientX - p.x, e.clientY - p.y)
    // A finger that moves before the hold is up is scrolling; a mouse that moves is dragging.
    if (p.touch) {
      if (far > SLOP) finish(true)
    } else if (far > MOUSE_SLOP) {
      begin(p.id, p.head, p.y)
      if (st.current) (st.current.y = e.clientY), place(st.current)
    }
  }
  function onUp() {
    finish(false)
  }
  function onCancel() {
    finish(true)
  }

  useEffect(() => () => finish(true), [])

  const headProps = (id: string) => ({
    'data-sort': '',
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (st.current || press.current) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      // The buttons on the right of the head (새 세션, ⋯) are buttons, not handles.
      if ((e.target as HTMLElement).closest('.section-right')) return
      const head = e.currentTarget
      const touch = e.pointerType !== 'mouse'
      press.current = { id, head, x: e.clientX, y: e.clientY, touch, timer: touch ? window.setTimeout(() => press.current && begin(id, head, press.current.y), HOLD_MS) : 0 }
      addEventListener('pointermove', onMove)
      addEventListener('pointerup', onUp)
      addEventListener('pointercancel', onCancel)
      if (touch) addEventListener('touchmove', noScroll, { passive: false })
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (dragged.current) (e.preventDefault(), e.stopPropagation())
    },
  })
  /** A finger holding a head: the long press is the drag's, not the menu's (Android opens one). */
  const holding = () => !!st.current || !!press.current?.touch

  return { sorting, headProps, holding }
}
