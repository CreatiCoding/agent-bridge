// 대표 realm (REQ-F-822): of this browser's top windows, the one holding the Web Lock does what should happen once
// per browser (an extension's event handler registered primaryOnly). A pane of 분할 화면 never asks; when the holder
// closes, the next window waiting takes it. One per browser, not per person: a phone and a Mac each have one.
let primary = false
export const isPrimary = () => primary

export function claimPrimary() {
  if (typeof window === 'undefined' || window.top !== window || !navigator.locks) return
  void navigator.locks.request('bridge-ext-primary', () => {
    primary = true
    // Held for as long as this page lives.
    return new Promise<never>(() => {})
  })
}
