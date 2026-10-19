// One live picture of this person's Macs and sessions, kept up by the server's stream (/api/classic/stream).
// Components read slices of it with useStore; nothing else holds a copy.
import { useSyncExternalStore } from 'react'
import { loadList, saveList } from './cache'
import type { Ev, State } from './types'
import { sawBuild } from './fresh'

export type Link = 'connecting' | 'live' | 'retrying'

interface Store {
  state: State | null
  link: Link
  /** Since when the stream has been down; the page says so only after a while (short blips are normal). */
  downSince: number | null
  /** What Claude is writing right now, per session, read off the terminal. Never stored. */
  writing: Record<string, string>
  /** The last terminal screen a session sent, per session. */
  screens: Record<string, string>
}

// The list as this browser last saw it is drawn at once; the stream replaces it as soon as it is up.
let store: Store = { state: loadList<State>(), link: 'connecting', downSince: null, writing: {}, screens: {} }
const subs = new Set<() => void>()
const set = (patch: Partial<Store>) => {
  store = { ...store, ...patch }
  for (const f of subs) f()
}

export function useStore<T>(pick: (s: Store) => T): T {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => pick(store),
  )
}
export const getStore = () => store

type EventsListener = (events: Ev[]) => void
const eventListeners = new Map<string, Set<EventsListener>>()
/** New lines of one session's log, as they are written. */
export function onEvents(sid: string, f: EventsListener) {
  if (!eventListeners.has(sid)) eventListeners.set(sid, new Set())
  eventListeners.get(sid)!.add(f)
  return () => void eventListeners.get(sid)?.delete(f)
}

const pokeListeners = new Set<(sid: string) => void>()
/** A locked session has new lines (their content is not on the stream). */
export function onPoke(f: (sid: string) => void) {
  pokeListeners.add(f)
  return () => void pokeListeners.delete(f)
}

type ToastListener = (text: string, sid?: string) => void
const toastListeners = new Set<ToastListener>()
export function onServerToast(f: ToastListener) {
  toastListeners.add(f)
  return () => void toastListeners.delete(f)
}

/** Every time the stream comes back after a gap: open views ask for what they missed. */
const reconnectListeners = new Set<() => void>()
export function onReconnect(f: () => void) {
  reconnectListeners.add(f)
  return () => void reconnectListeners.delete(f)
}

let es: EventSource | null = null
let everLive = false
export function connect() {
  es?.close()
  es = new EventSource('/api/classic/stream?delta=1')
  es.onopen = () => {
    const again = everLive
    everLive = true
    set({ link: 'live', downSince: null })
    if (again) for (const f of reconnectListeners) f()
  }
  es.onerror = () => {
    if (store.link !== 'retrying') set({ link: 'retrying', downSince: store.downSince ?? Date.now() })
    // A closed stream (the server answered with an error, often a sign-in that ran out) is not retried by the
    // browser on its own. Ask whether the sign-in still holds, then try again.
    if (es?.readyState === EventSource.CLOSED) {
      setTimeout(async () => {
        const r = await fetch('/api/me', { credentials: 'same-origin' }).catch(() => null)
        if (r?.status === 401) return location.reload()
        connect()
      }, 2000)
    }
  }
  es.onmessage = (m) => {
    let msg: { t: string; [k: string]: unknown }
    try {
      msg = JSON.parse(m.data)
    } catch {
      return
    }
    if (msg.t === 'state') {
      const { t: _t, ...state } = msg
      set({ state: state as unknown as State })
      saveList(state)
      sawBuild(state.ui)
    } else if (msg.t === 'state_delta' && store.state) {
      // Only what changed: rows not named keep the very objects they were, so their components do not redraw.
      const prev = store.state
      const d = msg as unknown as Partial<State> & { changed?: State['sessions']; order?: string[] }
      const fresh = new Map((d.changed ?? []).map((r) => [r.id, r]))
      const old = new Map(prev.sessions.map((r) => [r.id, r]))
      const order = d.order ?? prev.sessions.map((r) => r.id)
      const next: State = {
        ...prev,
        ...(d.hosts ? { hosts: d.hosts } : {}),
        ...(d.groups ? { groups: d.groups } : {}),
        ...(d.splits ? { splits: d.splits } : {}),
        ...(d.notices ? { notices: d.notices } : {}),
        ...(d.places ? { places: d.places } : {}),
        ...(d.ui ? { ui: d.ui } : {}),
        sessions: order.map((id) => fresh.get(id) ?? old.get(id)).filter((r): r is State['sessions'][number] => !!r),
      }
      set({ state: next })
      saveList(next as unknown as Record<string, unknown>)
      sawBuild(d.ui)
    } else if (msg.t === 'ev' && msg.locked) {
      // A locked session only says there is news; a tab that unlocked it asks for it.
      for (const f of pokeListeners) f(String(msg.sid))
    } else if (msg.t === 'ev') {
      const sid = String(msg.sid)
      const events = msg.events as Ev[]
      for (const f of eventListeners.get(sid) ?? []) f(events)
      // Once written to the log, the text read off the screen is no longer news.
      if (events.some((e) => e.k === 'text') && store.writing[sid]) set({ writing: { ...store.writing, [sid]: '' } })
    } else if (msg.t === 'preview') {
      set({ writing: { ...store.writing, [String(msg.sid)]: String(msg.text ?? '') } })
    } else if (msg.t === 'screen') {
      set({ screens: { ...store.screens, [String(msg.sid)]: String(msg.text ?? '') } })
    } else if (msg.t === 'notice') {
      for (const f of toastListeners) f(String(msg.text ?? ''), msg.sid ? String(msg.sid) : undefined)
    }
  }
}

/** Tell the server whether this page is in front: a card on a session someone is looking at needs no push. */
export function reportFocus(sid: string | null) {
  const visible = document.visibilityState === 'visible'
  fetch('/api/focus', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visible, sid: visible ? sid : null }) }).catch(() => {})
}

/** One empty list for selectors to fall back on: a new [] on every read would redraw forever. */
export const NONE: never[] = []
