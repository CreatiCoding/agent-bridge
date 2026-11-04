// The session list's search text (REQ-F-865): kept outside the list (a phone draws the list anew on coming back),
// read and changed by the list's box and by extensions (bridge.list).
import { useSyncExternalStore } from 'react'

let text = ''
const subs = new Set<() => void>()
export const getListFilter = () => text
export function setListFilter(v: string) {
  const next = String(v ?? '')
  if (next === text) return
  text = next
  subs.forEach((f) => f())
}
export const useListFilter = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => text,
  )
