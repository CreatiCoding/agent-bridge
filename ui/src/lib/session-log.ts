// A session's log on this page: drawn at once from what this browser kept (lib/cache), then only what came
// after it is fetched; older pages when the person scrolls up; after a dropped stream, only what was missed.
// Kept per session while the page lives, so going back to a conversation draws it at once.
import { useEffect, useSyncExternalStore } from 'react'
import { ApiError, get } from './api'
import { dropLog, loadLog, saveLog } from './cache'
import { tokenOf } from './locks'
import { getStore, onEvents, onPoke, onReconnect } from './store'
import { emptyFold, fold, type Folded } from './timeline'
import type { Card, Ev, EventsPage } from './types'

interface Log {
  events: Ev[]
  folded: Folded
  /** There is more before the first event held. */
  older: boolean
  loading: boolean
  loaded: boolean
  /** Drawn from this browser's copy, the server not asked yet. */
  cached: boolean
  error: string | null
  card: Card | null
  /** The session's Mac is not connected: the server keeps no log to show (REQ-S-069), only this browser's copy. */
  offline: boolean
}

const logs = new Map<string, Log>()
const subs = new Map<string, Set<() => void>>()
const empty: Log = { events: [], folded: emptyFold(), older: false, loading: false, loaded: false, cached: false, error: null, card: null, offline: false }

const isLocked = (sid: string) => !!getStore().state?.sessions.find((s) => s.id === sid)?.locked

function set(sid: string, patch: Partial<Log>) {
  const next = { ...(logs.get(sid) ?? empty), ...patch }
  logs.set(sid, next)
  for (const f of subs.get(sid) ?? []) f()
  // What the browser keeps follows what is on screen; a locked conversation is not kept.
  if (('events' in patch || 'older' in patch) && next.loaded && !next.cached) isLocked(sid) ? void dropLog(sid) : saveLog(sid, next.events, next.older)
}

/** Merge events into the log, keeping it in order and each seq once. */
function merge(sid: string, incoming: Ev[]) {
  if (!incoming.length) return
  const log = logs.get(sid) ?? empty
  const last = log.events.at(-1)?.seq ?? 0
  const first = log.events[0]?.seq ?? Infinity
  if (incoming.every((e) => e.seq > last)) {
    const events = [...log.events, ...incoming]
    // A gap means events were missed (the stream dropped between): fill it from the server.
    if (last && incoming[0].seq > last + 1) void catchUp(sid)
    set(sid, { events, folded: fold(log.folded, incoming) })
  } else {
    const seen = new Set(log.events.map((e) => e.seq))
    const events = [...log.events, ...incoming.filter((e) => !seen.has(e.seq))].sort((a, b) => a.seq - b.seq)
    // Older events change how later ones fold (a tool and its result): fold again from the start.
    set(sid, { events, folded: incoming[0].seq < first ? fold(emptyFold(), events) : fold(log.folded, incoming.filter((e) => !seen.has(e.seq))) })
  }
}

async function firstPage(sid: string) {
  set(sid, { loading: true, error: null })
  const page = await get<EventsPage>(`/api/sessions/${sid}/events`)
  const events = page.events
  set(sid, { events, folded: fold(emptyFold(), events), older: page.more, loading: false, loaded: true, cached: false, card: page.card, offline: false })
  // Live events that arrived while the first page loaded.
  if (page.last > (events.at(-1)?.seq ?? 0)) await afterLoop(sid)
}

const inflight = new Map<string, Promise<void>>()
/** How often a conversation whose Mac is away is asked for again while it is on screen. */
const OFFLINE_RETRY_MS = 10_000
async function catchUp(sid: string) {
  if (inflight.has(sid)) return inflight.get(sid)
  const run = (async () => {
    try {
      if (!logs.get(sid)?.loaded) {
        const kept = isLocked(sid) ? null : await loadLog(sid)
        if (kept && !logs.get(sid)?.loaded) {
          set(sid, { events: kept.events, folded: fold(emptyFold(), kept.events), older: kept.older, loaded: true, cached: true })
        } else if (!logs.get(sid)?.loaded) return await firstPage(sid)
      }
      await afterLoop(sid)
    } catch (e) {
      // The Mac is away: what this browser kept stays on screen, marked, and the server is asked again in a while.
      if (e instanceof ApiError && e.status === 409 && e.data.offline) {
        const log = logs.get(sid) ?? empty
        set(sid, { loading: false, error: null, offline: true, card: (e.data.card as Card | null) ?? log.card })
        setTimeout(() => subs.get(sid)?.size && logs.get(sid)?.offline && void catchUp(sid), OFFLINE_RETRY_MS)
        return
      }
      set(sid, { loading: false, error: (e as Error).message })
    }
  })().finally(() => inflight.delete(sid))
  inflight.set(sid, run)
  return run
}

async function afterLoop(sid: string) {
  for (let i = 0; i < 20; i++) {
    const log = logs.get(sid) ?? empty
    const last = log.events.at(-1)?.seq ?? 0
    const page = await get<EventsPage>(`/api/sessions/${sid}/events?after=${last}`)
    // The server has less than this browser kept (its copy was replaced): start from the server's.
    if (page.last < last) {
      void dropLog(sid)
      logs.delete(sid)
      return firstPage(sid)
    }
    merge(sid, page.events)
    set(sid, { card: page.card, cached: false, offline: false })
    if (!page.more) break
  }
}

export async function loadOlder(sid: string) {
  const log = logs.get(sid)
  if (!log || !log.older || log.loading) return
  set(sid, { loading: true })
  try {
    const page = await get<EventsPage>(`/api/sessions/${sid}/events?before=${log.events[0]?.seq ?? 0}`)
    set(sid, { loading: false, older: page.more })
    merge(sid, page.events)
  } catch (e) {
    set(sid, { loading: false, error: (e as Error).message })
  }
}

let wired = false
function wire() {
  if (wired) return
  wired = true
  onReconnect(() => {
    for (const sid of logs.keys()) if (subs.get(sid)?.size) void catchUp(sid)
  })
  // A locked session's news is fetched only by a tab that unlocked it.
  onPoke((sid) => logs.get(sid)?.loaded && tokenOf(sid) && void catchUp(sid))
  // Locked again in this tab: what was on screen goes.
  addEventListener('cb-unlock', (e) => {
    const sid = (e as CustomEvent<string>).detail
    if (tokenOf(sid)) return
    logs.delete(sid)
    for (const f of subs.get(sid) ?? []) f()
  })
}

/** Try again after a failed read (다시 시도). */
export function retryLog(sid: string) {
  void catchUp(sid)
}

/** Start loading a session before anything is drawn (a press on its row). */
export function prefetch(sid: string) {
  if (!logs.get(sid)?.loaded && !isLocked(sid)) void catchUp(sid)
}

const listening = new Map<string, () => void>()
/** The log of a session; null (nothing loaded) for a locked session this tab has not unlocked. */
export function useSessionLog(sid: string | null): Log {
  wire()
  useEffect(() => {
    if (!sid) return
    if (!listening.has(sid)) listening.set(sid, onEvents(sid, (evs) => (logs.get(sid)?.loaded ? merge(sid, evs) : undefined)))
    void catchUp(sid)
  }, [sid])
  return useSyncExternalStore(
    (f) => {
      if (!sid) return () => {}
      if (!subs.has(sid)) subs.set(sid, new Set())
      subs.get(sid)!.add(f)
      return () => void subs.get(sid)?.delete(f)
    },
    () => (sid ? (logs.get(sid) ?? empty) : empty),
  )
}
