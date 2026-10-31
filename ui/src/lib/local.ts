// What one browser keeps for itself: drafts, sent-message history, what has been seen, the theme. Every
// read and write is guarded; a private window or a full quota only loses the convenience.
const read = <T>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key)
    return v == null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
const write = (key: string, v: unknown) => {
  try {
    if (v === undefined || v === null || v === '') localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(v))
  } catch {}
}

const DRAFTS = 'cb2.drafts'
export const getDraft = (sid: string) => read<Record<string, string>>(DRAFTS, {})[sid] ?? ''
export function setDraft(sid: string, text: string) {
  const all = read<Record<string, string>>(DRAFTS, {})
  if (text) all[sid] = text
  else delete all[sid]
  const keys = Object.keys(all)
  if (keys.length > 100) for (const k of keys.slice(0, keys.length - 100)) delete all[k]
  write(DRAFTS, all)
}

// What was sent is read from each session's conversation now (session-page); the list this browser once kept goes.
write('cb2.history', null)

const SEEN = 'cb2.seen'
export const getSeen = () => read<Record<string, number>>(SEEN, {})
export function markSeen(sid: string, seq: number) {
  const all = getSeen()
  if ((all[sid] ?? 0) >= seq) return
  all[sid] = seq
  write(SEEN, all)
  dispatchEvent(new Event('cb-seen'))
}

export type Theme = 'auto' | 'light' | 'dark'
export const getTheme = () => read<Theme>('theme', 'auto')
export function setTheme(t: Theme) {
  write('theme', t === 'auto' ? null : t)
  if (t === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
  dispatchEvent(new Event('cb-theme'))
}

// The icon settings are the account's (설정 → 이 기기); this browser keeps the last ones only so the first paint,
// before /api/me answers, already has them.
export const ICONS_DEFAULT = { size: 18, fill: 1 }
export const getIcons = () => ({ ...ICONS_DEFAULT, ...read<Partial<typeof ICONS_DEFAULT>>('cb2.icons', {}) })
export function applyIcons(v: { size: number; fill: number }) {
  const s = document.documentElement.style
  s.setProperty('--icon', `${v.size}px`)
  s.setProperty('--icon-fill', String(v.fill))
  write('cb2.icons', v.size === ICONS_DEFAULT.size && v.fill === ICONS_DEFAULT.fill ? null : v)
}

export const getPref =<T>(key: string, fallback: T) => read<T>(`cb2.${key}`, fallback)
export const setPref = (key: string, v: unknown) => write(`cb2.${key}`, v)

/** "나중에" on the app update dialog (REQ-F-781): which build, and until when. */
const APP_SNOOZE = 'cb2.appUpdateSnooze'
export const getAppSnooze = () => read<{ build: number; until: number } | null>(APP_SNOOZE, null)
export const setAppSnooze = (v: { build: number; until: number }) => write(APP_SNOOZE, v)

/** "하루 동안 안 보기" on the agent update dialog (REQ-F-832): until when, per Mac. */
const AGENT_SNOOZE = 'cb2.agentUpdateSnooze'
export const AGENT_UPDATE_SNOOZE_MS = 24 * 60 * 60_000
export const getAgentSnooze = () => read<Record<string, number>>(AGENT_SNOOZE, {})
export function setAgentSnooze(hostId: string, until: number) {
  const all = getAgentSnooze()
  for (const [k, v] of Object.entries(all)) if (v < Date.now()) delete all[k]
  all[hostId] = until
  write(AGENT_SNOOZE, all)
}
