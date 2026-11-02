// One live picture of this person's Macs and sessions, kept up by the server's stream (/api/classic/stream).
// Components read slices of it with useStore; nothing else holds a copy.
import { useSyncExternalStore } from 'react'
import { loadList, saveList } from './cache'
import type { Ev, State } from './types'
import { sawBuild } from './fresh'
import { openDeep } from './trust'

export type Link = 'connecting' | 'live' | 'retrying'
/** How the page hears the server: a stream, or fetching because streams do not get through (REQ-F-849). */
export type LinkMode = 'sse' | 'poll'

interface Store {
  state: State | null
  link: Link
  mode: LinkMode
  /** Since when the stream has been down; the page says so only after a while (short blips are normal). */
  downSince: number | null
  /** What Claude is writing right now, per session, read off the terminal. Never stored. */
  writing: Record<string, string>
  /** The last terminal screen a session sent, per session. */
  screens: Record<string, string>
  /** state came from the server in this page load (not only the copy this browser kept, which can be old). */
  served: boolean
}

// The list as this browser last saw it is drawn at once; the stream replaces it as soon as it is up.
let store: Store = { state: loadList<State>(), link: 'connecting', mode: 'sse', downSince: null, writing: {}, screens: {}, served: false }
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

/** The server's events for extensions (ext-event, REQ-F-826) and its word that their files changed (ext-reload). */
const extListeners = new Set<(msg: { t: string; event?: unknown }) => void>()
export function onExtMessage(f: (msg: { t: string; event?: unknown }) => void) {
  extListeners.add(f)
  return () => void extListeners.delete(f)
}

/** Every time the stream comes back after a gap: open views ask for what they missed. */
const reconnectListeners = new Set<() => void>()
export function onReconnect(f: () => void) {
  reconnectListeners.add(f)
  return () => void reconnectListeners.delete(f)
}

// ---------- the link: a stream, or fetching when a proxy holds streams back (REQ-F-849) ----------
// Some networks (a proxy that buffers long answers or cuts them) never let a stream through. The page then fetches
// the same messages (/api/classic/poll) and now and then tries whether a stream gets through again.

/** A stream must bring its first message this soon, or the attempt failed. */
const FIRST_MS = 10_000
/** A stream that says nothing this long is stalled (the server pings every 20 s). */
const STALL_MS = 50_000
/** This many failed attempts in a row, while the server answers plain requests, and the page fetches instead. */
const FAILS_TO_POLL = 2
/** While fetching: how long a fetch may wait for news (s), the pause after one, and the pause in a hidden tab. */
const POLL_WAIT_S = 20
const POLL_GAP_MS = 1_000
const POLL_SHORT_MS = 3_000
const POLL_HIDDEN_MS = 30_000
/** A stream is tried again this long after fetching began, then twice as long after each miss, up to the max. */
const PROBE_FIRST_MS = 60_000
const PROBE_MAX_MS = 15 * 60_000
/** Back on a stream this long without trouble, and the next fallback starts probing from PROBE_FIRST_MS again. */
const PROBE_RESET_MS = 10 * 60_000

let es: EventSource | null = null
let everLive = false
let fails = 0
let heard = 0
let gotFirst = false
/** When the stream brought its first message: only one that then stays well a while clears the failures. A proxy
 * that holds small messages back lets a big first state through and then nothing, again and again. */
let liveAt = 0
let firstTimer: ReturnType<typeof setTimeout> | undefined
let probeDelay = PROBE_FIRST_MS
let streamSince = 0

const comeBack = () => {
  for (const f of reconnectListeners) f()
}

export function connect() {
  es?.close()
  clearTimeout(firstTimer)
  gotFirst = false
  const mine = (es = new EventSource('/api/classic/stream?delta=1&hb=1'))
  firstTimer = setTimeout(() => es === mine && !gotFirst && failed('첫 메시지가 오지 않음'), FIRST_MS)
  mine.onerror = () => {
    if (es !== mine) return
    if (store.link !== 'retrying') set({ link: 'retrying', downSince: store.downSince ?? Date.now() })
    // Before its first message an error is a failed attempt; after it the browser reconnects by itself, unless
    // the server answered with an error (often a sign-in that ran out), which it does not retry.
    if (!gotFirst || mine.readyState === EventSource.CLOSED) failed(gotFirst ? '스트림이 닫힘' : '스트림이 열리지 않음')
    else {
      // The browser reconnects by itself: that new stream must bring its first message in time too.
      gotFirst = false
      clearTimeout(firstTimer)
      firstTimer = setTimeout(() => es === mine && !gotFirst && failed('다시 연결한 스트림에 첫 메시지가 오지 않음'), FIRST_MS)
    }
  }
  mine.onmessage = (m) => {
    if (es !== mine) return
    heard = Date.now()
    if (!gotFirst) {
      gotFirst = true
      liveAt = Date.now()
      clearTimeout(firstTimer)
      const again = everLive
      everLive = true
      set({ link: 'live', downSince: null })
      if (again) comeBack()
    }
    deliver(m.data)
  }
}

let checking = false
/** A stream attempt failed: tell a blocked stream from a server that is down, and fall back after a few. */
async function failed(why: string) {
  if (checking || store.mode === 'poll') return
  checking = true
  es?.close()
  es = null
  clearTimeout(firstTimer)
  if (store.link !== 'retrying') set({ link: 'retrying', downSince: store.downSince ?? Date.now() })
  try {
    const r = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000) }).catch(() => null)
    if (r?.status === 401) return location.reload()
    // The server itself does not answer (a deploy, no network), or the page was away (hidden, a phone that put it
    // to sleep, just back): not the stream's fault, try the stream again.
    if (r?.ok && navigator.onLine && document.visibilityState === 'visible' && Date.now() - shownAt > 5_000) fails++
    if (fails >= FAILS_TO_POLL) {
      linkNote = why
      startPolling()
    } else setTimeout(connect, r?.ok ? 1000 : 3000)
  } finally {
    checking = false
  }
}

// A stream that goes quiet is not noticed by the browser. The watch's own pauses (a sleeping laptop, a frozen
// tab) are not the stream's fault: after one, the stream gets a fresh allowance.
let lastTick = Date.now()
setInterval(() => {
  const now = Date.now()
  const slept = now - lastTick > 15_000
  lastTick = now
  if (store.mode !== 'sse' || !es || !gotFirst) return
  if (slept) heard = now
  else if (now - liveAt > 2 * STALL_MS) fails = 0
  if (now - heard > STALL_MS) failed(`${Math.round((now - heard) / 1000)}초째 아무것도 오지 않음`)
}, 5_000)

let linkNote = ''
let pollRun = 0
let pollAbort: AbortController | null = null
let wake: (() => void) | null = null
const pid = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')

function pause(ms: number) {
  return new Promise<void>((r) => {
    const t = setTimeout(() => ((wake = null), r()), ms)
    wake = () => (clearTimeout(t), (wake = null), r())
  })
}
let shownAt = Date.now()
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  shownAt = Date.now()
  wake?.()
})

function startPolling() {
  if (store.mode === 'poll') return
  // Back on the stream only a short while: probing goes on from where it was, so a flapping network is not
  // switched every minute.
  if (streamSince && Date.now() - streamSince > PROBE_RESET_MS) probeDelay = PROBE_FIRST_MS
  set({ mode: 'poll' })
  void pollLoop(++pollRun)
}

async function pollLoop(run: number) {
  let since = 0
  let longOk = true
  let errs = 0
  let probeAt = Date.now() + probeDelay
  while (run === pollRun) {
    const visible = document.visibilityState === 'visible'
    if (visible && Date.now() >= probeAt) {
      if (await probe()) {
        if (run !== pollRun) return
        pollRun++
        pollAbort?.abort()
        streamSince = Date.now()
        set({ mode: 'sse' })
        fails = 0
        connect()
        return
      }
      probeDelay = Math.min(probeDelay * 2, PROBE_MAX_MS)
      probeAt = Date.now() + probeDelay
    }
    const wait = visible && longOk ? POLL_WAIT_S : 0
    pollAbort = new AbortController()
    const timer = setTimeout(() => pollAbort?.abort(), wait * 1000 + 15_000)
    let pauseMs = !visible ? POLL_HIDDEN_MS : longOk ? POLL_GAP_MS : POLL_SHORT_MS
    try {
      const r = await fetch(`/api/classic/poll?pid=${pid}&since=${since}&wait=${wait}`, { credentials: 'same-origin', cache: 'no-store', signal: pollAbort.signal })
      if (run !== pollRun) return
      if (r.status === 401) return location.reload()
      // 429: too soon; 410: a newer fetch of this page answers (this one was late). Neither is a failure.
      if (r.status === 429 || r.status === 410) pauseMs = Math.max(pauseMs, 1000)
      else {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const j = (await r.json()) as { since: number; last: number; msgs: string[]; reset?: boolean }
        if (run !== pollRun) return
        // An answer to another since than the one asked (a proxy that answered a retried request): not ours.
        if (j.since !== since) throw new Error('since')
        errs = 0
        since = j.last
        if (store.link !== 'live') set({ link: 'live', downSince: null })
        for (const d of j.msgs) deliver(d)
        // Starting over (the first fetch, or one after a gap): open views ask for what they missed.
        if (j.reset) {
          if (everLive) comeBack()
          everLive = true
        }
      }
    } catch {
      if (run !== pollRun) return
      // A proxy that also cuts a fetch that waits: fetch without waiting, more often.
      if (++errs >= 2 && wait > 0) longOk = false
      if (errs >= 2 && store.link !== 'retrying') set({ link: 'retrying', downSince: store.downSince ?? Date.now() })
      pauseMs = Math.min(2000 * errs, POLL_HIDDEN_MS)
    } finally {
      clearTimeout(timer)
    }
    await pause(pauseMs)
  }
}

/** Whether a stream gets through now: the probe's messages a second apart must arrive apart, not all at the end. */
function probe(): Promise<boolean> {
  return new Promise((resolve) => {
    const at: number[] = []
    // The real stream's address, so a proxy that sorts by address treats the probe as it treats the stream.
    const p = new EventSource('/api/classic/stream?probe=1')
    const end = (ok: boolean) => (p.close(), clearTimeout(t), resolve(ok))
    const t = setTimeout(() => end(false), 7_000)
    p.onmessage = () => {
      at.push(Date.now())
      if (at.length >= 3 && at[at.length - 1] - at[0] >= 1_500) end(true)
    }
    p.onerror = () => end(false)
  })
}

/** What the page shows about the link: fetching, and why. */
export const linkWhy = () => linkNote

/** One message off the stream or out of a fetch. */
function deliver(data: string) {
  let msg: { t: string; [k: string]: unknown }
  try {
    msg = JSON.parse(data)
  } catch {
    return
  }
  // A sealing Mac's words come as pieces (REQ-S-095): opened before use, and every message keeps its place in line.
  if (opening || data.includes('⟦bt')) {
    opening++
    inLine = inLine
      .then(() => openDeep(msg).catch(() => msg))
      .then(handle, () => {})
      .finally(() => opening--)
    return
  }
  handle(msg)
}

let opening = 0
let inLine: Promise<unknown> = Promise.resolve()
function handle(msg: { t: string; [k: string]: unknown }) {
  if (msg.t === 'state') {
    const { t: _t, ...state } = msg
    set({ state: state as unknown as State, served: true })
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
  } else if (msg.t === 'ext-event' || msg.t === 'ext-reload') {
    for (const f of extListeners) f(msg)
  } else if (msg.t === 'notice') {
    for (const f of toastListeners) f(String(msg.text ?? ''), msg.sid ? String(msg.sid) : undefined)
  }
}

/** Tell the server whether this page is in front: a card on a session someone is looking at needs no push. */
export function reportFocus(sid: string | null) {
  const visible = document.visibilityState === 'visible'
  fetch('/api/focus', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visible, sid: visible ? sid : null }) }).catch(() => {})
}

/** One empty list for selectors to fall back on: a new [] on every read would redraw forever. */
export const NONE: never[] = []
