// 익스텐션 (REQ-F-827): the page loads the extensions this person agreed to (their files come from this origin,
// /ext/<id>/<hash>/), hands each its `bridge` object, asks once for the ones not agreed to yet, reports what fails,
// and loads again when their files change. ?noext=1 opens the page without any (kept for this tab until ?noext=0).
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { useEffect, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import * as actions from './actions'
import * as slots from './slots'
import { registerShortcut, type Shortcut } from './shortcuts'
import { SlotContext, onSlotFailed } from './slot-view'
import { isPrimary } from './primary'
import { getStore, onExtMessage, onReconnect, useStore } from './store'
import { parseRoute, useRoute } from './router'
import { Markdown } from './markdown'
import type { Me } from './types'
import * as kitAll from '../kit'
import { chooseDialog, confirmDialog, openMenu, promptDialog, Sheet, toast, type MenuEntry } from '../kit/overlay'

export interface ExtInfo {
  id: string
  name: string
  version: string
  entry: string
  hash: string
  extensionApi: number
  uses: { actions: string[]; slots: string[] }
  routes: { path: string; upstream: string }[]
  hooks: { name: string; url: string }[]
  storesData: boolean
  consented: boolean
  loadError?: string
  errors?: { at: number; uid: string; message: string; stack: string }[]
}

/** The extensionApi this page gives; a newer one is not loaded. */
export const EXT_API = 1
const EVENTS = ['session.done', 'decision.waiting', 'decision.answered']
// The events' shape is the server's (REQ-F-817); the page only passes them on, so it takes the published types.
type ExtEvents = import('../../../extensions/agent-bridge-ext').EventMap
type ExtEventName = keyof ExtEvents
const H = { 'X-Bridge-Ext': '1' }

// ---------- ?noext ----------

/** ?noext=1 opens without extensions, for this tab (its panes too) until ?noext=0. */
export function noExt() {
  try {
    const q = new URLSearchParams(location.search).get('noext')
    if (q === '1') sessionStorage.setItem('cb-noext', '1')
    if (q === '0') sessionStorage.removeItem('cb-noext')
    return sessionStorage.getItem('cb-noext') === '1'
  } catch {
    return new URLSearchParams(location.search).get('noext') === '1'
  }
}

// ---------- requests ----------

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method, credentials: 'same-origin', headers: { ...H, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(data.error || `${r.status}`), { status: r.status })
  return data as T
}

// Reported to 운영 탭: message and stack only, never what the page shows.
const reported = new Map<string, number>()
function report(id: string, where: string, e: unknown) {
  if (!id) return
  const key = `${id}|${where}|${e instanceof Error ? e.message : String(e)}`
  if (Date.now() - (reported.get(key) ?? 0) < 60_000) return
  reported.set(key, Date.now())
  console.warn(`[ext ${id}] ${where}:`, e)
  void call('POST', '/api/ext/errors', { id, message: `${where}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 1024), stack: (e instanceof Error ? e.stack ?? '' : '').slice(0, 1024) }).catch(() => {})
}
actions.onNoted((owner, action, what) => report(owner, action, new Error(what)))
onSlotFailed((owner, where, e) => report(owner, where, e))

// ---------- sheets ----------

// A sheet an extension opens takes one history entry, so back (or the iOS back swipe) closes it instead of leaving
// the page. The page's own sheets are not touched.
type Open = { key: number; Comp: ComponentType<Record<string, unknown>>; props: Record<string, unknown>; title?: ReactNode; wide?: boolean; done: () => void }
let sheets: Open[] = []
const sheetSubs = new Set<() => void>()
const setSheets = (s: Open[]) => ((sheets = s), sheetSubs.forEach((f) => f()))
let seq = 0
let host: HTMLDivElement | null = null

function ExtSheets() {
  const list = useSyncExternalStore(
    (f) => (sheetSubs.add(f), () => sheetSubs.delete(f)),
    () => sheets,
  )
  return (
    <>
      {list.map((s) => (
        <Sheet key={s.key} open onClose={() => closeSheet(s.key)} title={s.title} wide={s.wide}>
          <s.Comp {...s.props} close={() => closeSheet(s.key)} />
        </Sheet>
      ))}
    </>
  )
}

function closeSheet(key: number, fromBack = false) {
  const s = sheets.find((x) => x.key === key)
  if (!s) return
  setSheets(sheets.filter((x) => x !== s))
  s.done()
  if (!fromBack && history.state?.extSheet === key) history.back()
}

addEventListener('popstate', () => {
  const top = sheets[sheets.length - 1]
  if (top && history.state?.extSheet !== top.key) closeSheet(top.key, true)
})

function openSheet<P extends object>(Comp: ComponentType<P & { close: () => void }>, props: P = {} as P, opts: { title?: ReactNode; wide?: boolean } = {}) {
  if (!host) {
    host = document.createElement('div')
    document.body.appendChild(host)
    createRoot(host).render(<ExtSheets />)
  }
  const key = ++seq
  let done = () => {}
  const closed = new Promise<void>((r) => (done = r))
  history.pushState({ ...history.state, extSheet: key }, '')
  setSheets([...sheets, { key, Comp: Comp as unknown as ComponentType<Record<string, unknown>>, props: props as Record<string, unknown>, title: opts.title, wide: opts.wide, done }])
  return { closed, close: () => closeSheet(key) }
}

// ---------- shared data ----------

const shared = new Map<string, { value: unknown; at: number; subs: Set<() => void>; loading: boolean; ms: number; fetcher: () => Promise<unknown> }>()
function refresh(key: string) {
  const e = shared.get(key)
  if (!e || e.loading || document.visibilityState === 'hidden') return
  e.loading = true
  e.fetcher().then(
    (v) => ((e.value = v), (e.at = Date.now()), (e.loading = false), e.subs.forEach((f) => f())),
    () => (e.loading = false),
  )
}
setInterval(() => {
  for (const [k, e] of shared) if (e.subs.size && Date.now() - e.at >= e.ms) refresh(k)
}, 1000)

// ---------- the bridge object ----------

function makeBridge(x: ExtInfo, locale: Record<string, string>, me: Me) {
  const owner = x.id
  const usesAction = (n: string) => {
    if (!x.uses.actions.includes(n)) throw new Error(`extension.yaml 의 uses.actions 에 ${n} 가 없어요`)
  }
  const usesSlot = (n: string) => {
    if (!x.uses.slots.includes(n)) throw new Error(`extension.yaml 의 uses.slots 에 ${n} 가 없어요`)
  }
  const evHandlers: { name: string; fn: (ev: unknown) => void; primaryOnly: boolean }[] = []
  onExtMessage((m) => {
    if (m.t !== 'ext-event') return
    const ev = m.event as { name?: string } | undefined
    for (const h of evHandlers)
      if (h.name === ev?.name && (!h.primaryOnly || isPrimary()))
        try {
          h.fn(ev)
        } catch (e) {
          report(owner, h.name, e)
        }
  })
  const base = (scope: string) => `/api/ext/${owner}/storage/${scope}`
  const store = (scope: 'user' | 'server') => ({
    get: (key: string) => call<{ item: { value: unknown; version: number } | null }>('GET', `${base(scope)}/${encodeURIComponent(key)}`).then((r) => r.item),
    set: (key: string, value: unknown, o: { ifVersion?: number } = {}) => call<{ version: number }>('PUT', `${base(scope)}/${encodeURIComponent(key)}`, { value, ...(o.ifVersion != null ? { ifVersion: o.ifVersion } : {}) }).then((r) => ({ version: r.version })),
    delete: (key: string) => call('DELETE', `${base(scope)}/${encodeURIComponent(key)}`).then(() => undefined),
    list: (prefix = '') => call<{ keys: string[] }>('GET', `${base(scope)}?prefix=${encodeURIComponent(prefix)}`).then((r) => r.keys),
  })
  const callPath = (p: string) => `/api/ext/${owner}/call${p.startsWith('/') ? p : `/${p}`}`
  const user = { uid: me.uid ?? '', login: me.user.login, provider: me.provider ?? 'github', admin: me.admin }
  return {
    React,
    kit: { ...kitAll, Sheet, Markdown },
    extensionApi: EXT_API,
    id: owner,
    actions: {
      before: <N extends Exclude<actions.ActionName, 'renderer.block'>>(n: N, fn: actions.BeforeFn<N>, o: actions.HookOpts = {}) => (usesAction(n), actions.before(n, fn, { ...o, owner })),
      around: <N extends actions.ActionName>(n: N, fn: actions.AroundFn<N>, o: actions.HookOpts = {}) => (usesAction(n), actions.around(n, fn, { ...o, owner })),
      after: ((n: string, fn: (...a: never[]) => void, o: actions.HookOpts & { primaryOnly?: boolean } = {}) => {
        usesAction(n)
        if (EVENTS.includes(n)) {
          const h = { name: n, fn: fn as (ev: unknown) => void, primaryOnly: !!o.primaryOnly }
          evHandlers.push(h)
          return () => void evHandlers.splice(evHandlers.indexOf(h) >>> 0, 1)
        }
        return actions.after(n as actions.ActionName, fn as never, { ...o, owner })
      }) as {
        <N extends actions.ActionName>(n: N, fn: actions.AfterFn<N>, o?: actions.HookOpts): () => void
        <E extends ExtEventName>(n: E, fn: (ev: ExtEvents[E]) => void, o?: { primaryOnly?: boolean }): () => void
      },
      dispatch: actions.dispatch,
    },
    slots: {
      // An item's other fields are the slot's own (agent-bridge-ext.d.ts SlotItems); the place that draws it reads them.
      register: (slot: slots.SlotName, item: { id: string; order?: slots.SlotItem['order'] }) => (usesSlot(slot), slots.register(slot, item as slots.SlotItem, owner)),
      replace: (slot: slots.SlotName, id: string, f: (orig: never) => { id: string }) => (usesSlot(slot), slots.replace(slot, id, f as unknown as (o: slots.SlotItem) => slots.SlotItem, owner)),
      hide: (slot: slots.SlotName, id: string) => (usesSlot(slot), slots.hide(slot, id, owner)),
      useSlotContext: <C = unknown,>() => React.useContext(SlotContext) as C,
    },
    commands: { register: (s: Shortcut) => registerShortcut({ ...s, id: `${owner}.${s.id}` }, owner) },
    ui: {
      sheet: { open: openSheet },
      confirm: (title: ReactNode, body?: ReactNode) => confirmDialog(title, { text: body }),
      menu: (items: MenuEntry[], at: HTMLElement | { x: number; y: number }, title?: ReactNode) => openMenu(items, at, title),
      prompt: promptDialog,
      choose: chooseDialog,
      toast: (text: ReactNode, o?: { tone?: 'ok' | 'bad' }) => toast(text, o),
    },
    storage: {
      user: store('user'),
      server: store('server'),
      secrets: {
        set: (key: string, value: string) => call('PUT', `/api/ext/${owner}/secrets/${encodeURIComponent(key)}`, { value }).then(() => undefined),
        delete: (key: string) => call('DELETE', `/api/ext/${owner}/secrets/${encodeURIComponent(key)}`).then(() => undefined),
        has: (key: string) => call<{ keys: string[] }>('GET', `/api/ext/${owner}/secrets`).then((r) => r.keys.includes(key)),
      },
    },
    api: {
      /** fetch to one of this extension's routes; the server adds who is asking and signs it. */
      fetch: (p: string, init: RequestInit = {}) => fetch(callPath(p), { ...init, credentials: 'same-origin', headers: { ...(init.headers as Record<string, string>), ...H, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } }),
      json: <T,>(p: string, body?: unknown) => call<T>(body === undefined ? 'GET' : 'POST', callPath(p), body),
      /** A picture from a route as a blob: address (an <img> cannot send the header). */
      blobUrl: async (p: string) => {
        const r = await fetch(callPath(p), { credentials: 'same-origin', headers: H })
        if (!r.ok) throw new Error(`${r.status}`)
        return URL.createObjectURL(await r.blob())
      },
    },
    get isPrimary() {
      return isPrimary()
    },
    events: {
      /** True for the first page of this person to claim the event (one phone and one Mac: one of them). */
      claim: (eventId: string) => call('POST', `/api/ext/${owner}/events/${encodeURIComponent(eventId)}/claim`, {}).then(
        () => true,
        () => false,
      ),
    },
    data: {
      /** One fetch per key for every user of it in this page, again every ms (not while the page is hidden). */
      shared: <T,>(key: string, fetcher: () => Promise<T>, ms: number): T | undefined => {
        const k = `${owner}|${key}`
        const [, bump] = useState(0)
        useEffect(() => {
          let e = shared.get(k)
          if (!e) shared.set(k, (e = { value: undefined, at: 0, subs: new Set(), loading: false, ms, fetcher }))
          const f = () => bump((n) => n + 1)
          e.subs.add(f)
          if (!e.at) refresh(k)
          return () => void e!.subs.delete(f)
        }, [k])
        return shared.get(k)?.value as T | undefined
      },
    },
    i18n: { locale: navigator.language?.split('-')[0] || 'ko', t: (key: string) => locale[key] ?? key },
    theme: {
      dark: () => document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches),
      token: (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name.startsWith('--') ? name : `--${name}`).trim(),
    },
    user,
    useSessions: () => useStore((s) => s.state?.sessions ?? []),
    useCurrent: () => {
      const r = useRoute()
      return { route: r.name, ...(r.name === 'session' ? { sid: r.id } : {}) }
    },
    current: () => {
      const r = parseRoute(location.pathname + location.search)
      return { route: r.name, ...(r.name === 'session' ? { sid: r.id } : {}) }
    },
    sessions: () => getStore().state?.sessions ?? [],
  }
}
export type Bridge = ReturnType<typeof makeBridge>

// ---------- loading ----------

async function localeOf(x: ExtInfo) {
  const dir = x.entry.slice(0, x.entry.lastIndexOf('/'))
  for (const lang of [navigator.language?.split('-')[0] || 'ko', 'ko']) {
    const r = await fetch(`${dir}/locales/${lang}.json`, { credentials: 'same-origin' }).catch(() => null)
    if (r?.ok) return (await r.json().catch(() => ({}))) as Record<string, string>
  }
  return {}
}

const loaded = new Set<string>()
async function loadOne(x: ExtInfo, me: Me) {
  if (loaded.has(x.id) || x.loadError || !x.consented) return
  if (x.extensionApi > EXT_API) return report(x.id, 'load', new Error(`extensionApi ${x.extensionApi} 를 이 화면이 몰라요`))
  loaded.add(x.id)
  try {
    const mod = await import(/* @vite-ignore */ x.entry)
    await mod.default(makeBridge(x, await localeOf(x), me))
  } catch (e) {
    report(x.id, 'load', e)
  }
}

let listNow: ExtInfo[] = []

/**
 * Loads the agreed extensions; the page waits for them up to 1.5 s (so their renderers are there for the first
 * drawing), not at all when there are none. Then, in a top window only, asks about the ones not agreed to yet.
 */
export async function startExtensions(me: Me | null): Promise<void> {
  const list = ((me as { extensions?: ExtInfo[] } | null)?.extensions ?? []).filter((x) => !x.loadError)
  listNow = list
  if (!me || !list.length || noExt()) return
  // Their files changed (or another server took over with other files): load again.
  onExtMessage((m) => m.t === 'ext-reload' && location.reload())
  onReconnect(() =>
    void call<{ extensions: ExtInfo[] }>('GET', '/api/ext').then((r) => {
      const now = new Map(r.extensions.map((x) => [x.id, x.hash]))
      if (listNow.some((x) => now.get(x.id) !== x.hash)) location.reload()
    }, () => {}),
  )
  await Promise.race([Promise.all(list.filter((x) => x.consented).map((x) => loadOne(x, me))), new Promise((r) => setTimeout(r, 1500))])
}

/** After the first drawing: the extensions this person has not been asked about (for this version) yet. */
export async function askExtensions(me: Me | null) {
  if (!me || window.top !== window || noExt()) return
  for (const x of listNow.filter((y) => !y.consented)) {
    const asked = `cb-ext-asked-${x.id}`
    try {
      if (localStorage.getItem(asked) === x.hash) continue
      localStorage.setItem(asked, x.hash)
    } catch {
      /* asked again next time */
    }
    if (await askConsent(x)) {
      x.consented = true
      void loadOne(x, me)
    }
  }
}

/** What an extension may do, said before agreeing to it (also from 설정 → 플러그인). */
export function ConsentText({ x }: { x: ExtInfo }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div>
        <b>{x.name}</b> <span className="muted">v{x.version} · {x.hash}</span>
      </div>
      <div>이 익스텐션은 당신의 권한으로 맥에서 명령을 실행할 수 있고, 당신의 요청을 적힌 외부 주소로 보낼 수 있습니다. 이 서버에 데이터를 저장할 수 있습니다.</div>
      {x.uses.actions.length || x.uses.slots.length ? <div className="muted">쓰는 것: {[...x.uses.actions, ...x.uses.slots].join(', ')}</div> : null}
      {x.routes.length || x.hooks.length ? <div className="muted">보내는 곳: {[...new Set([...x.routes.map((r) => r.upstream), ...x.hooks.map((h) => h.url)])].join(', ')}</div> : null}
      <div className="muted">운영자가 이 서버에 설치했어요. 바뀌면 다시 물어요.</div>
    </div>
  )
}

export async function askConsent(x: ExtInfo) {
  if (!(await confirmDialog('익스텐션을 켤까요?', { text: <ConsentText x={x} />, ok: '켜기', cancel: '켜지 않기' }))) return false
  try {
    await call('POST', `/api/ext/${x.id}/consent`, { hash: x.hash })
    return true
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), { tone: 'bad' })
    return false
  }
}

export async function revokeConsent(x: ExtInfo) {
  await call('DELETE', `/api/ext/${x.id}/consent`)
}

export const listExtensions = () => call<{ extensions: ExtInfo[] }>('GET', '/api/ext').then((r) => r.extensions)
export const extLeftovers = () => call<{ ids: string[] }>('GET', '/api/admin/ext-leftovers').then((r) => r.ids)
export const cleanLeftover = (id: string) => fetch('/api/admin/ext-leftovers', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).then((r) => r.ok)
