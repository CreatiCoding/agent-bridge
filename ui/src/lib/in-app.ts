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

/** Whether link.open shows this link in the sheet rather than a new tab. */
export function opensInApp(url: string, from: string, touch = touchDevice(), base = here()) {
  if (!touch || !IN_APP_FROM.has(from)) return false
  const u = parse(url, base)
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return false
  // This site's own address: a picture shows in the sheet; a page of it is not read through the reader.
  if (u.origin === new URL(base).origin) return IMAGE.test(u.pathname) || u.pathname.includes('/img/')
  return true
}

/** A picture fetched through the server: the page's policy lets pictures come from this site only. */
export const readerImg = (src: string) => `/api/read/img?u=${encodeURIComponent(src)}`

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
