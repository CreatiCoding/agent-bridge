// Which links the in-app browser sheet of a touch device takes, and how it shows them (REQ-F-879). The sheet
// itself: components/link-sheet.

/** A phone or a tablet: no hover, a finger for a pointer. A computer with a touch screen still has a mouse. */
export const touchDevice = () => typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches

// Where the sheet is used: answers and the pages' own links. A login address, a PR and a Slack thread need the real
// browser (a login needs the browser's cookies, a PR and a thread the person's sign-in), and so do the sheet's own
// 브라우저로 열기 ('inapp') and 로컬 미리보기's 새 탭으로 ('preview').
const IN_APP_FROM = new Set(['markdown', 'report', 'guide', 'settings'])
const LOCAL = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]'])
const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i

const parse = (url: string, base: string) => {
  try {
    return new URL(url, base)
  } catch {
    return null
  }
}
const here = () => (typeof location === 'object' ? location.href : 'http://x/')

/** A Mac's own address (http://localhost:3000/…): it means nothing on a phone. */
export function localPort(url: string, base = 'http://x/'): number | null {
  const u = parse(url, base)
  if (!u || !LOCAL.has(u.hostname)) return null
  return Number(u.port || (u.protocol === 'https:' ? 443 : 80))
}

// ---------- 링크 열기 규칙 (REQ-F-881) ----------
// The account's rules (설정 → 이 기기 → 링크 열기): per host, how the sheet opens a link. Kept here as well as on the
// server: link.open must decide inside the press (iOS opens a new tab only there), so nothing is fetched then.
export type LinkMode = 'read' | 'snapshot' | 'preview' | 'browser'
export interface LinkRule {
  host: string
  mode: LinkMode
}
export const LINK_MODES: { value: LinkMode; label: string }[] = [
  { value: 'read', label: '읽기' },
  { value: 'snapshot', label: '스냅샷' },
  { value: 'preview', label: '미리보기' },
  { value: 'browser', label: '브라우저' },
]
/** 미리보기 is the session's local preview: only a Mac's own address opens that way. */
export const LOCAL_RULE_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0'])
const RULES_KEY = 'cb2.linkRules'
let rules: LinkRule[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(RULES_KEY) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
})()
export const getLinkRules = () => rules
export function setLinkRules(v: LinkRule[] | undefined) {
  rules = Array.isArray(v) ? v : []
  try {
    if (rules.length) localStorage.setItem(RULES_KEY, JSON.stringify(rules))
    else localStorage.removeItem(RULES_KEY)
  } catch {}
}

/** What the person typed as a rule's host: a pasted address gives its host name. Null when it is not one. */
export function ruleHost(text: string): string | null {
  let s = text.trim().toLowerCase()
  if (!s) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    const u = parse(s, 'http://x/')
    if (!u) return null
    s = u.hostname
  }
  s = s.replace(/[/:?#].*$/, '').replace(/\.$/, '')
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(s) ? s : null
}

/** The rule for a host: its own, else the closest parent domain's ("example.com" covers "a.example.com"). */
export function ruleFor(hostname: string, list: LinkRule[] = rules): LinkMode | null {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  let best: LinkRule | null = null
  for (const r of list) {
    if ((h === r.host || h.endsWith('.' + r.host)) && (!best || r.host.length > best.host.length)) best = r
  }
  return best?.mode ?? null
}

/**
 * How the sheet opens an address: the host's rule; with none, on a session's page a snapshot by its Mac (1.470,
 * localhost too), elsewhere localhost through the preview and the rest to read. `fromRule` says which it was: a
 * snapshot taken by default goes back to the old way when it fails (link-sheet).
 */
export function modeOf(url: string, session: boolean, base = here(), list: LinkRule[] = rules): { mode: LinkMode; fromRule: boolean } {
  const u = parse(url, base)
  const local = localPort(url, base) != null
  const rule = u ? ruleFor(u.hostname, list) : null
  if (rule === 'preview' && !local) return { mode: 'read', fromRule: true }
  if (rule) return { mode: rule, fromRule: true }
  return { mode: session ? 'snapshot' : local ? 'preview' : 'read', fromRule: false }
}
export const modeFor = (url: string, base = here(), list: LinkRule[] = rules, session = false): LinkMode => modeOf(url, session, base, list).mode

/** Whether link.open shows this link in the sheet rather than a new tab. */
export function opensInApp(url: string, from: string, touch = touchDevice(), base = here(), list: LinkRule[] = rules) {
  if (!touch || !IN_APP_FROM.has(from)) return false
  const u = parse(url, base)
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return false
  // This site's own address: a picture shows in the sheet; a page of it is not read through the reader.
  if (u.origin === new URL(base).origin) return IMAGE.test(u.pathname) || u.pathname.includes('/img/')
  // A host the person sends to the browser (규칙 브라우저), except a picture, which still shows as one.
  if (ruleFor(u.hostname, list) === 'browser' && !IMAGE.test(u.pathname)) return false
  return true
}

/** A picture fetched through the server: the page's policy lets pictures come from this site only. */
export const readerImg = (src: string) => (/^data:image\//.test(src) ? src : `/api/read/img?u=${encodeURIComponent(src)}`)

/** The address a link to a picture shows as one picture, or null when the link is a page. */
export function imageUrl(url: string, base = here()): string | null {
  const u = parse(url, base)
  if (!u) return null
  if (u.origin === new URL(base).origin) return IMAGE.test(u.pathname) || u.pathname.includes('/img/') ? u.pathname + u.search : null
  return IMAGE.test(u.pathname) ? readerImg(u.href) : null
}

/** The preview address of a localhost link: the path, query and fragment it named, on the preview's root. */
export function throughPreview(previewRoot: string, url: string) {
  const u = new URL(url, 'http://x/')
  return previewRoot.replace(/\/$/, '') + u.pathname + u.search + u.hash
}
