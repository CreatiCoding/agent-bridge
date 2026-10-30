// Drawing a slot (REQ-F-824): its context, and its items drawn again whenever one comes, goes or is replaced.
import { createContext, type ReactNode, useContext, useSyncExternalStore } from 'react'
import { slotsVersion, watchSlots } from './slots'

/** What a slot's item is given where it is drawn (§7.1): the slot's context and its commands. */
export const SlotContext = createContext<unknown>(null)
export const useSlotContext = <T,>() => useContext(SlotContext) as T

/** Redraws when the slots change. */
export const useSlots = () => useSyncExternalStore(watchSlots, slotsVersion)

/** One item's render as a component of its own, so the hooks it calls (useSlotContext) are its own. */
export function SlotRender({ render }: { render: () => ReactNode }) {
  return <>{render()}</>
}
