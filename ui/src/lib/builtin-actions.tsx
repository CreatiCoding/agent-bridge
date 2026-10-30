// The built-in way of doing each action of lib/actions (REQ-F-822), and the small helpers the page calls instead
// of doing the thing itself. Each default works without the screen that started it (an event handler can dispatch).
import type { MouseEvent } from 'react'
import { dispatch, onCancelShown, setDefault, type ActionMap } from './actions'
import { del, post } from './api'
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

type Send = ActionMap['message.send']['args']
type SendWatch = (args: Send) => ((ok: boolean) => void) | void
const sendWatch = new Map<string, Set<SendWatch>>()
/**
 * A session's page draws the message it is about to send (faded, until the log has it) with the words that are
 * really sent: after every before handler. What the watcher returns is told whether it went.
 */
export function onSending(sid: string, f: SendWatch) {
  if (!sendWatch.has(sid)) sendWatch.set(sid, new Set())
  sendWatch.get(sid)!.add(f)
  return () => void sendWatch.get(sid)?.delete(f)
}
setDefault('message.send', async (a) => {
  const done = [...(sendWatch.get(a.sid) ?? [])].map((f) => f(a))
  try {
    const r = await post(`/api/sessions/${a.sid}/say`, { text: a.text, images: a.images, ...(a.videos.length ? { videos: a.videos.map((v) => ({ id: v.id })) } : {}) })
    for (const d of done) d?.(true)
    return r
  } catch (e) {
    for (const d of done) d?.(false)
    throw e
  }
})

// The composer of each session open in this window submits its own text (composer.submit).
type Submit = (text?: string) => Promise<ActionMap['composer.submit']['result']>
const composers = new Map<string, Submit>()
export function registerComposer(sid: string, f: Submit) {
  composers.set(sid, f)
  return () => void (composers.get(sid) === f && composers.delete(sid))
}
setDefault('composer.submit', ({ sid, text }) => composers.get(sid)?.(text) ?? { sent: false, reason: 'no-composer' })

setDefault('permission.answer', ({ sid, card, option }) => post(`/api/sessions/${sid}/answer`, { card: card.id, n: option.n }))
setDefault('session.create', async (body) => ({ sid: (await post<{ ok: true; id: string }>('/api/sessions', body)).id }))
setDefault('session.close', ({ sid, kind }) => (kind === 'remove' ? del(`/api/sessions/${sid}`) : post(`/api/sessions/${sid}/${kind === 'trash' ? 'trash' : 'close'}`)))

/** Sends a message to a session: `:` makes it a bridge command. */
export const sendMessage = (sid: string, text: string, images: Send['images'] = [], videos: Send['videos'] = []) =>
  dispatch('message.send', { sid, text, kind: text.trimStart().startsWith(':') ? 'command' : 'text', images, videos })

/** Ends (`end`), removes from the list (`remove`) or ends throwing its folder away (`trash`); asked about already. */
export const closeSession = (sid: string, kind: ActionMap['session.close']['args']['kind']) => dispatch('session.close', { sid, kind })

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
