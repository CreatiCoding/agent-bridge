// Conversations kept in this browser (IndexedDB), so opening one draws it at once and only what is new is
// fetched. The newest 3000 events of the 30 sessions opened last. A locked session is never kept.
import type { Ev } from './types'

const DB = 'cb2-cache'
const STORE = 'logs'
const KEEP_EVENTS = 3000
const KEEP_SESSIONS = 30

interface Entry {
  sid: string
  events: Ev[]
  older: boolean
  at: number
}

let db: Promise<IDBDatabase | null> | null = null
function open(): Promise<IDBDatabase | null> {
  db ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'sid' })
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return db
}

const run = async <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> => {
  const d = await open()
  if (!d) return null
  return new Promise((resolve) => {
    try {
      const r = f(d.transaction(STORE, mode).objectStore(STORE))
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

export async function loadLog(sid: string): Promise<{ events: Ev[]; older: boolean } | null> {
  const e = await run<Entry>('readonly', (s) => s.get(sid))
  return e && Array.isArray(e.events) && e.events.length ? { events: e.events, older: e.older } : null
}

const pending = new Map<string, ReturnType<typeof setTimeout>>()
/** Written a moment after the last change: a busy session writes once every second and a half at most. */
export function saveLog(sid: string, events: Ev[], older: boolean) {
  clearTimeout(pending.get(sid))
  pending.set(
    sid,
    setTimeout(async () => {
      pending.delete(sid)
      const kept = events.slice(-KEEP_EVENTS)
      await run('readwrite', (s) => s.put({ sid, events: kept, older: older || kept.length < events.length, at: Date.now() } satisfies Entry))
      void trim()
    }, 1500),
  )
}

export async function dropLog(sid: string) {
  clearTimeout(pending.get(sid))
  pending.delete(sid)
  await run('readwrite', (s) => s.delete(sid))
}

/** Only the sessions opened most recently are kept. */
async function trim() {
  const all = await run<Entry[]>('readonly', (s) => s.getAll())
  if (!all || all.length <= KEEP_SESSIONS) return
  for (const e of all.sort((a, b) => b.at - a.at).slice(KEEP_SESSIONS)) await run('readwrite', (s) => s.delete(e.sid))
}

// The list, as last seen, so the page draws it before the stream is up. Locked sessions arrive already blank.
const LIST = 'cb2.state'
export function loadList<T>(): T | null {
  try {
    return JSON.parse(localStorage.getItem(LIST) ?? 'null')
  } catch {
    return null
  }
}
let listTimer: ReturnType<typeof setTimeout> | undefined
export function saveList(state: unknown) {
  clearTimeout(listTimer)
  listTimer = setTimeout(() => {
    try {
      localStorage.setItem(LIST, JSON.stringify(state))
    } catch {}
  }, 1000)
}
