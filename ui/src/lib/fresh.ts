// A page left open (a phone's home-screen app above all) keeps running the build it was loaded with, deploy after
// deploy. The server says which build it hands out now (state.ui); when that is another one, the page reloads
// itself, but only when nothing is lost by it: not while something is being typed, or a sheet, dialog or menu is
// open, or a finger or the mouse was just on it. A hidden page reloads at once.

import { inPane } from './split'

/** This page's own entry file, as the server names it (`index-<hash>.js`). None when run by the dev server. */
const mine = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')?.src.match(/index-[\w-]+\.js/)?.[0] ?? null
/** The newer build waiting for a quiet moment. */
let wanted: string | null = null
let lastTouch = 0
let timer = 0

const touched = () => {
  lastTouch = Date.now()
  // A pane's touches are the page around it's too: it is the one that reloads.
  if (inPane) window.parent.dispatchEvent(new Event('cb-pane-touch'))
}
addEventListener('pointerdown', touched, { capture: true, passive: true })
addEventListener('keydown', touched, { capture: true, passive: true })
addEventListener('cb-pane-touch', () => (lastTouch = Date.now()))
document.addEventListener('visibilitychange', () => wanted && attempt())

function busyIn(doc: Document): boolean {
  const a = doc.activeElement as HTMLElement | null
  // 분할 화면's panes are this page in frames (REQ-F-786): what is typed or open in one counts as here.
  if (a?.tagName === 'IFRAME') {
    try {
      const inner = (a as HTMLIFrameElement).contentDocument
      if (inner && busyIn(inner)) return true
    } catch {}
  }
  const typing = !!a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'range'].includes((a as HTMLInputElement).type)) || a.isContentEditable)
  return typing || !!doc.querySelector('.sheet, .dialog, .menu-pop')
}

function busy() {
  return busyIn(document) || Date.now() - lastTouch < 3000
}

function attempt() {
  clearTimeout(timer)
  if (!wanted) return
  if (document.visibilityState === 'visible' && busy()) return void (timer = window.setTimeout(attempt, 3000))
  // Once per build: a page that comes back with the same old build (a cache in the way) does not reload in a loop.
  try {
    if (sessionStorage.getItem('cb.reloadedFor') === wanted) return
    sessionStorage.setItem('cb.reloadedFor', wanted)
  } catch {}
  location.reload()
}

/** The build the server hands out now, from the state. */
export function sawBuild(ui: unknown) {
  // A pane is reloaded with the page around it.
  if (inPane) return
  if (typeof ui !== 'string' || !mine || ui === mine || ui === wanted) return
  wanted = ui
  attempt()
}

/** For tests: this page's build and the one it waits to reload into. */
;(window as unknown as { __build: () => unknown }).__build = () => ({ mine, wanted })
