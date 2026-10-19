// 화면 진단 표시 (설정 → 이 기기): the numbers that place the input over a phone's keyboard, shown on the session
// page to find a gap that cannot be seen from a desktop. This browser's own, off unless turned on.
const KEY = 'cb2.kbdebug'
export const kbDebugOn = () => {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}
export const setKbDebug = (on: boolean) => {
  try {
    if (on) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch {}
  dispatchEvent(new Event('cb-kbdebug'))
}

/** One line of what is measured now: layout and visual viewport, the input's place, and the room kept under it. */
export function kbDebugText(page: HTMLElement) {
  const vv = window.visualViewport
  const comp = page.querySelector<HTMLElement>('.composer')
  const box = page.querySelector<HTMLElement>('.composer-in')
  const r = (n: number | undefined) => (n == null ? '-' : Math.round(n))
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom)'
  document.body.appendChild(probe)
  const safe = getComputedStyle(probe).paddingBottom
  probe.remove()
  const shown = vv ? vv.offsetTop + vv.height : innerHeight
  return [
    `ih ${innerHeight} vv ${r(vv?.height)} top ${r(vv?.offsetTop)} x${vv?.scale.toFixed(2) ?? '-'}`,
    `kb ${page.classList.contains('kb-open') ? 'open' : 'no'} safe ${safe} pad ${comp ? getComputedStyle(comp).paddingBottom : '-'}`,
    `comp ${r(comp?.getBoundingClientRect().bottom)} box ${r(box?.getBoundingClientRect().bottom)} seen ${r(shown)} gap ${box ? r(shown - box.getBoundingClientRect().bottom) : '-'}`,
  ].join('\n')
}
