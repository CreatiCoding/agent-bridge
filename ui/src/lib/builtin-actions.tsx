// The built-in way of doing each action of lib/actions (REQ-F-822), and the small helpers the page calls instead
// of doing the thing itself. Each default works without the screen that started it (an event handler can dispatch).
import type { MouseEvent } from 'react'
import { dispatch, onCancelShown, setDefault, type ActionMap } from './actions'
import { go } from './router'
import { toast } from '../kit/overlay'

setDefault('session.open', ({ sid, replace }) => go({ name: 'session', id: sid }, { replace }))
setDefault('link.open', ({ url, target }) => {
  if (target === '_self') location.href = url
  else window.open(url, '_blank', 'noopener')
})
// Started inside the press (iOS allows a clipboard write only there); the promise says whether it was written.
setDefault('clipboard.copy', ({ text }) => (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('클립보드를 쓸 수 없어요'))))
setDefault('notify.show', ({ text }) => void toast(text))
onCancelShown((reason) => toast(reason, { tone: 'bad' }))

/** Moves to a session's page; `from` says which part of the page asked. */
export const openSession = (sid: string, from: string, opts: { replace?: boolean } = {}) => dispatch('session.open', { sid, from, ...(opts.replace ? { replace: true } : {}) })

/** Opens an address in a new window (or this one, for an address that hands over to another app). */
export const openLink = (url: string, from: string, target?: '_self') => dispatch('link.open', { url, from, ...(target ? { target } : {}) })

/**
 * A link's plain left click goes through link.open; a long press, a middle click or a click with a modifier key
 * stays the browser's.
 */
export const linkClick = (url: string, from: string, target?: '_self') => (e: MouseEvent) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.defaultPrevented) return
  e.preventDefault()
  openLink(url, from, target)
}

/** Copies text; true once it is on the clipboard. */
export const copyText = (text: string, kind: ActionMap['clipboard.copy']['args']['kind'] = 'other') =>
  Promise.resolve(dispatch('clipboard.copy', { text, kind })).then(
    () => true,
    () => false,
  )
