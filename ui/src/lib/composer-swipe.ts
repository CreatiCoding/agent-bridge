// Vertical swipes on the input box (REQ-F-880). Up = ↑ (one back in the sent-message record, REQ-F-082), down while
// going through the record = ↓, any other downward swipe puts a phone's keyboard away. Every SWIPE_STEP px of travel
// is one step, so one long drag goes several back. Not while the text inside can still scroll that way (the swipe
// scrolls it first), and not for a sideways swipe (the chips scroll sideways). A gesture that stepped through the
// record never also puts the keyboard away.

export const SWIPE_STEP = 40

export interface Swipe {
  x: number
  y: number
  /** May an upward swipe step back (the text cannot scroll further toward its end)? */
  up: boolean
  /** May a downward swipe step forward or put the keyboard away (the text is at its start)? */
  down: boolean
  stepped: boolean
}

export interface SwipeBox {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
}

/** The gesture's start, or null when it is not one this box follows. `inside`: it started on the text itself. */
export function swipeBegin(x: number, y: number, box: SwipeBox, inside: boolean): Swipe {
  return {
    x,
    y,
    // A finger moving up scrolls the text toward its end; moving down, toward its start.
    up: !(inside && box.scrollTop + box.clientHeight < box.scrollHeight - 1),
    down: !(inside && box.scrollTop > 0),
    stepped: false,
  }
}

export interface SwipeDo {
  /** The slash list is open (↑/↓ pick there): the swipe does nothing. */
  picking: boolean
  /** One back in the record; false when it could not (text typed, empty record). */
  back: () => boolean
  /** One forward; false when not going through the record. */
  forward: () => boolean
  /** Put the keyboard away. */
  blur: () => void
}

/** One touchmove. Returns the gesture to keep following, or null when it is over. */
export function swipeMove(s: Swipe, x: number, y: number, act: SwipeDo): Swipe | null {
  const dy = y - s.y
  const dx = Math.abs(x - s.x)
  if (Math.abs(dy) <= SWIPE_STEP || Math.abs(dy) <= dx * 1.5) return s
  if (act.picking) return null
  const moved = () => ({ ...s, x, y, stepped: true })
  if (dy < 0) {
    if (s.up && act.back()) return moved()
    return s.stepped ? s : null
  }
  if (s.down && act.forward()) return moved()
  if (s.stepped) return s
  if (s.down) act.blur()
  return null
}
