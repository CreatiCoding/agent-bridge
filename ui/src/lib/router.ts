// Addresses are plain paths (/s/<id>, /settings): the server hands the same page to every one of them
// (server/server.mjs APP_PATH) and the page moves between them without reloading (history.pushState).
// The addresses of before, /#/s/<id>, still work: fromHash() turns them into paths as the page starts.
import { useSyncExternalStore } from 'react'

export type Route =
  | { name: 'home' }
  | { name: 'session'; id: string }
  | { name: 'new' }
  | { name: 'stats' }
  | { name: 'quality' }
  | { name: 'host'; id: string; sid?: string }
  | { name: 'hosts' }
  | { name: 'report'; id: string }
  | { name: 'settings'; tab?: SettingsTab }
  | { name: 'guide'; path: GuidePath }
  | { name: 'split'; ids: string[] }

/** The start guide's ways: /guide, /guide/accounts. */
export type GuidePath = 'start' | 'accounts'

/** The settings page's tabs; the first is what /settings opens. */
export const SETTINGS_TABS = ['launch', 'prompt', 'accounts', 'device', 'plugins', 'voice', 'admin', 'changes', 'more'] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]

/** The route a path (with its query) names, or null when it is not one of this page's (/recovery, /guide/mcp, …). */
export function matchRoute(url: string): Route | null {
  const [p, q = ''] = url.split('?')
  let m: RegExpExecArray | null
  if (p === '/' || p === '') return { name: 'home' }
  if ((m = /^\/s\/([\w-]+)$/.exec(p))) return { name: 'session', id: m[1] }
  if ((m = /^\/hosts\/([\w-]+)$/.exec(p))) {
    const sid = /(?:^|&)sid=([\w-]+)/.exec(q)?.[1]
    return { name: 'host', id: m[1], ...(sid ? { sid } : {}) }
  }
  // 분할 화면 (REQ-F-786): /split?s=<id>,<id>,<id>, up to three, each once.
  if (p === '/split') {
    const ids = [...new Set((/(?:^|&)s=([\w,-]*)/.exec(q)?.[1] ?? '').split(',').filter((x) => /^[\w-]+$/.test(x)))].slice(0, 3)
    return ids.length ? { name: 'split', ids } : { name: 'home' }
  }
  if (p === '/new') return { name: 'new' }
  if (p === '/stats') return { name: 'stats' }
  if (p === '/quality') return { name: 'quality' }
  if (p === '/hosts') return { name: 'hosts' }
  // The admin page of before is now the settings page's 운영 tab; /admin (bookmarks, links) opens that tab.
  if (p === '/admin') return { name: 'settings', tab: 'admin' }
  if ((m = /^\/admin\/reports\/([\w-]+)$/.exec(p))) return { name: 'report', id: m[1] }
  if (p === '/settings') return { name: 'settings' }
  if ((m = /^\/settings\/([a-z]+)$/.exec(p)) && (SETTINGS_TABS as readonly string[]).includes(m[1])) return { name: 'settings', tab: m[1] as SettingsTab }
  if (p === '/guide') return { name: 'guide', path: 'start' }
  if (p === '/guide/accounts') return { name: 'guide', path: 'accounts' }
  // A link from when the guide had a third way: it opens the first one.
  if (p === '/guide/move') return { name: 'guide', path: 'start' }
  return null
}

export const parseRoute = (url: string): Route => matchRoute(url) ?? { name: 'home' }

export const href = (r: Route) =>
  ({ home: '/', session: `/s/${(r as { id?: string }).id}`, new: '/new', stats: '/stats', quality: '/quality', host: `/hosts/${(r as { id?: string }).id}${(r as { sid?: string }).sid ? `?sid=${(r as { sid?: string }).sid}` : ''}`, hosts: '/hosts', report: `/admin/reports/${(r as { id?: string }).id}`, settings: `/settings${(r as { tab?: string }).tab && (r as { tab?: string }).tab !== 'launch' ? `/${(r as { tab?: string }).tab}` : ''}`, split: `/split?s=${((r as { ids?: string[] }).ids ?? []).join(',')}`, guide: `/guide${(r as { path?: string }).path && (r as { path?: string }).path !== 'start' ? `/${(r as { path?: string }).path}` : ''}` })[r.name]

const ROUTE_EVENT = 'cb-route'

/** Moves to an address of this page (a path, with a query if any) without reloading it. */
export function navigate(url: string, opts: { replace?: boolean } = {}) {
  if (opts.replace) history.replaceState(history.state, '', url)
  else history.pushState({ idx: (history.state?.idx ?? 0) + 1 }, '', url)
  dispatchEvent(new Event(ROUTE_EVENT))
}

export const go = (r: Route, opts: { replace?: boolean } = {}) => navigate(href(r), opts)

/** Back where the person came from, or to the list when this page was opened directly. */
export function back() {
  if ((history.state?.idx ?? 0) > 0) history.back()
  else go({ name: 'home' }, { replace: true })
}

/**
 * An address of before (/#/s/<id>, /#/new?group=<id>), from a bookmark, a phone's home screen, a Slack message or an
 * old notification, becomes its path in place, before anything is drawn. Other hashes are left alone.
 */
export function fromHash() {
  if (!location.hash.startsWith('#/')) return
  const url = location.hash.slice(1)
  history.replaceState(history.state, '', matchRoute(url) ? url : '/')
}

/**
 * A click on a link to one of this page's addresses moves there without reloading. A click with a modifier key,
 * a middle click, a link with a target or a download, and links elsewhere are the browser's.
 */
export function interceptLinks() {
  addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return
    const u = new URL(a.href, location.href)
    if (u.origin !== location.origin || !matchRoute(u.pathname + u.search)) return
    e.preventDefault()
    navigate(u.pathname + u.search)
  })
}

export function useRoute(): Route {
  const url = useSyncExternalStore(
    (f) => (addEventListener('popstate', f), addEventListener(ROUTE_EVENT, f), () => (removeEventListener('popstate', f), removeEventListener(ROUTE_EVENT, f))),
    () => location.pathname + location.search,
  )
  return parseRoute(url)
}
