// What a report (제보) carries about the page itself: the device and browser, where the person was, and the last
// errors the page met. The server adds its side (the Macs, the session's state, their logs).
import { getStore } from './store'

type Seen = { at: number; kind: 'error' | 'rejection' | 'console'; text: string }
const SEEN_MAX = 30
const seen: Seen[] = []
const keep = (kind: Seen['kind'], text: string) => {
  seen.push({ at: Date.now(), kind, text: text.slice(0, 1000) })
  if (seen.length > SEEN_MAX) seen.shift()
}
const say = (v: unknown) => (v instanceof Error ? `${v.name}: ${v.message}${v.stack ? `\n${v.stack.split('\n').slice(1, 4).join('\n')}` : ''}` : typeof v === 'string' ? v : (() => { try { return JSON.stringify(v) } catch { return String(v) } })())

addEventListener('error', (e) => keep('error', `${e.message}${e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno}:${e.colno})` : ''}`))
addEventListener('unhandledrejection', (e) => keep('rejection', say(e.reason)))
const consoleError = console.error.bind(console)
console.error = (...a: unknown[]) => (keep('console', a.map(say).join(' ')), consoleError(...a))

/**
 * The last snapshots shown as the page looked (REQ-F-881, 1.495): how big the page was and whether it went into its
 * shadow root (1.523, the error when not), so a report of a blank snapshot says what the phone was given. The site's host only, never the address.
 */
export type SnapNote = { at: number; site: string; bytes: number; width: number; via: string | null; sealed: boolean; images: number; css: number; frame: 'waiting' | 'drawn' | 'failed'; error: string | null; ms: number | null }
const SNAPS_MAX = 5
const snaps: SnapNote[] = []
export function noteSnapshot(n: Omit<SnapNote, 'at' | 'frame' | 'error' | 'ms'>): SnapNote {
  const s: SnapNote = { at: Date.now(), ...n, frame: 'waiting', error: null, ms: null }
  snaps.push(s)
  if (snaps.length > SNAPS_MAX) snaps.shift()
  return s
}

const media = (q: string) => matchMedia(q).matches
const nav = navigator as Navigator & { deviceMemory?: number; connection?: { effectiveType?: string; rtt?: number; downlink?: number; saveData?: boolean }; standalone?: boolean }

/** The page's account of itself at the moment of the report. */
export function clientDebug(sid: string | null) {
  const st = getStore()
  const s = sid ? st.state?.sessions.find((x) => x.id === sid) : null
  return {
    path: location.pathname + location.search,
    page: document.querySelector<HTMLScriptElement>('script[type=module][src*="/assets/index-"]')?.src.split('/').pop() ?? null,
    userAgent: navigator.userAgent,
    platform: (navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } }).userAgentData?.platform ?? navigator.platform,
    language: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio, viewport: `${innerWidth}x${innerHeight}`, visual: visualViewport ? `${Math.round(visualViewport.width)}x${Math.round(visualViewport.height)}` : null },
    input: { finePointer: media('(pointer: fine)'), touchPoints: navigator.maxTouchPoints },
    display: { standalone: media('(display-mode: standalone)') || !!nav.standalone, dark: media('(prefers-color-scheme: dark)'), reducedMotion: media('(prefers-reduced-motion: reduce)'), theme: document.documentElement.dataset.theme ?? null },
    network: { online: navigator.onLine, ...(nav.connection ? { type: nav.connection.effectiveType, rtt: nav.connection.rtt, downlink: nav.connection.downlink, saveData: nav.connection.saveData } : {}) },
    memory: nav.deviceMemory ?? null,
    link: { state: st.link, mode: st.mode, downSince: st.downSince ?? null },
    session: s ? { id: s.id, title: s.title, phase: s.state.phase, alive: s.state.alive, closed: s.closed } : null,
    errors: [...seen],
    snapshots: snaps.map((s) => ({ ...s })),
  }
}
