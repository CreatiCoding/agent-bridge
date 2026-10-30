// Drawing a slot (REQ-F-824): its context, and its items drawn again whenever one comes, goes or is replaced.
import { Component, createContext, type ReactNode, useContext, useSyncExternalStore } from 'react'
import { slotsVersion, watchSlots } from './slots'

let failed: (owner: string, where: string, e: unknown) => void = () => {}
/** Who hears of an item that failed to draw (the extension host reports it to the server). */
export const onSlotFailed = (f: typeof failed) => void (failed = f)
/** An added item's action failed (a menu item's run): reported like a drawing that failed. */
export const slotFailed = (owner: string, where: string, e: unknown) => failed(owner, where, e)

/** An added item that throws while drawing is left out (the rest of the page stays) and reported. */
class Guard extends Component<{ owner: string; children: ReactNode }, { broken: boolean }> {
  state = { broken: false }
  static getDerivedStateFromError() {
    return { broken: true }
  }
  componentDidCatch(e: unknown) {
    failed(this.props.owner, 'slot', e)
  }
  render() {
    return this.state.broken ? null : this.props.children
  }
}

/** What a slot's item is given where it is drawn (§7.1): the slot's context and its commands. */
export const SlotContext = createContext<unknown>(null)
export const useSlotContext = <T,>() => useContext(SlotContext) as T

/** Redraws when the slots change. */
export const useSlots = () => useSyncExternalStore(watchSlots, slotsVersion)

/** One item's render as a component of its own, so the hooks it calls (useSlotContext) are its own. */
export function SlotRender({ render, owner }: { render: () => ReactNode; owner?: string }) {
  return (
    <Guard owner={owner ?? ''}>
      <Call render={render} />
    </Guard>
  )
}
function Call({ render }: { render: () => ReactNode }) {
  return <>{render()}</>
}
