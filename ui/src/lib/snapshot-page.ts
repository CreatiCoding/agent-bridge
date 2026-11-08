// 스냅샷의 원본 모양 (REQ-F-881, 1.488): the page the session's Mac rendered, put together here as one self-contained
// document for a sandboxed frame. Its style sheets come as <style>, its pictures (and those its styles name) as
// data:, and everything that would run or reach out is taken away: scripts, frames, plugins, <base>, refresh, every
// address left over. The frame has no scripts and no origin of its own (sandbox without allow-scripts or
// allow-same-origin), and it carries its own CSP (SNAPSHOT_CSP, 1.490) on top of this site's, which still lets a style
// fetch from this site: under both it loads nothing but inline styles and data: pictures.
// Links open in a new tab (allow-popups). DOMParser builds an inert document: nothing in it runs or loads here.

export interface SnapshotParts {
  url: string
  html: string
  images?: Record<string, string>
  css?: Record<string, string>
}

const DATA_IMG = /^data:image\/(png|jpeg|gif|webp|avif);base64,/
/** What a picture the Mac did not send becomes: an empty data: address (nothing is fetched). */
const NO_IMG = 'data:,'
const URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi
const DROP = 'script, noscript, iframe, frame, frameset, object, embed, applet, portal, base, meta[http-equiv], template'
/**
 * The document's own policy (1.490), first in its <head> so it holds before anything of the page is read: inline
 * styles and data: pictures, nothing else. The site's CSP the frame inherits still lets a style fetch from this
 * site ('self'), and the frame's sandbox does not stop styles fetching: this does, whatever this file failed to strip.
 */
export const SNAPSHOT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"
/** An at-keyword's name after the @, CSS escapes included (`@\69mport` is @import). */
const AT_NAME = /(?:[\w-]|\\[0-9a-fA-F]{1,6}[ \t\r\n\f]?|\\[^\r\n\f0-9a-fA-F])+/y
const unescapeCss = (s: string) =>
  s.replace(/\\([0-9a-fA-F]{1,6})[ \t\r\n\f]?|\\(.)/g, (_, h?: string, c?: string) => {
    if (c !== undefined) return c
    const n = parseInt(h ?? '', 16)
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '�'
  })
/** Where a quoted string that starts at i ends (after its closing quote, or at a line end or the end). */
const endOfString = (t: string, i: number) => {
  const q = t[i]
  for (let j = i + 1; j < t.length; j++) {
    if (t[j] === '\\') j++
    else if (t[j] === q) return j + 1
    else if (t[j] === '\n' || t[j] === '\r' || t[j] === '\f') return j
  }
  return t.length
}
const endOfComment = (t: string, i: number) => {
  const e = t.indexOf('*/', i + 2)
  return e < 0 ? t.length : e + 2
}
/**
 * Every @import rule taken out (1.490): `@import "a"`, `@import url(a)`, in any case and with CSS escapes. Strings and
 * comments are stepped over, so an "@import" inside one is left alone and a cut never eats a comment's end.
 */
export function dropImports(t: string): string {
  let out = ''
  let from = 0
  let i = 0
  while (i < t.length) {
    const c = t[i]
    if (c === '/' && t[i + 1] === '*') i = endOfComment(t, i)
    else if (c === '"' || c === "'") i = endOfString(t, i)
    else if (c === '\\') i += 2
    else if (c === '@') {
      AT_NAME.lastIndex = i + 1
      const m = AT_NAME.exec(t)
      if (!m || unescapeCss(m[0]).toLowerCase() !== 'import') {
        i += 1 + (m ? m[0].length : 0)
        continue
      }
      out += t.slice(from, i)
      let j = i + 1 + m[0].length
      while (j < t.length && t[j] !== ';' && t[j] !== '{' && t[j] !== '}') {
        if (t[j] === '"' || t[j] === "'") j = endOfString(t, j)
        else if (t[j] === '/' && t[j + 1] === '*') j = endOfComment(t, j)
        else j += t[j] === '\\' ? 2 : 1
      }
      if (t[j] === ';') j++
      i = from = j
    } else i++
  }
  return out + t.slice(from)
}

export function snapshotPage(s: SnapshotParts): string {
  const images = s.images ?? {}
  const css = s.css ?? {}
  const abs = (u: string, base = s.url) => {
    try {
      return new URL(u.trim().replace(/&amp;/g, '&'), base).href
    } catch {
      return ''
    }
  }
  const pic = (u: string | null | undefined) => {
    if (!u || u.startsWith('data:')) return ''
    const d = images[abs(u)]
    return typeof d === 'string' && DATA_IMG.test(d) ? d : ''
  }
  // Every url(...) of a style: its picture when the Mac sent it, else nothing to fetch. A picture is written once, as
  // a custom property on :root, and every style names it by var() (1.489): a sprite named by hundreds of rules made
  // coupang.com's page 15 MB from 3.7 MB of pictures, and an iPhone drew nothing of it.
  const vars = new Map<string, string>()
  const varOf = (d: string) => {
    let v = vars.get(d)
    if (!v) vars.set(d, (v = `--cb-i${vars.size}`))
    return `var(${v})`
  }
  const styled = (text: string, base = s.url) =>
    dropImports(text).replace(URL_RE, (all, a?: string, b?: string, c?: string) => {
      const raw = (a ?? b ?? c ?? '').trim()
      if (raw.startsWith('#')) return all
      if (raw.startsWith('data:')) return DATA_IMG.test(raw) ? all : `url("${NO_IMG}")`
      const d = images[abs(raw, base)]
      return typeof d === 'string' && DATA_IMG.test(d) ? varOf(d) : `url("${NO_IMG}")`
    })

  const doc = new DOMParser().parseFromString(s.html, 'text/html')
  doc.querySelectorAll(DROP).forEach((e) => e.remove())
  doc.querySelectorAll('link').forEach((l) => {
    const rel = (l.getAttribute('rel') ?? '').toLowerCase().split(/\s+/)
    const href = abs(l.getAttribute('href') ?? '')
    const text = rel.includes('stylesheet') ? css[href] : undefined
    if (typeof text !== 'string') return void l.remove()
    const st = doc.createElement('style')
    const media = l.getAttribute('media')
    if (media) st.setAttribute('media', media)
    st.textContent = styled(text, href)
    l.replaceWith(st)
  })
  doc.querySelectorAll('style').forEach((st) => (st.textContent = styled(st.textContent ?? '')))
  doc.querySelectorAll('[style]').forEach((e) => e.setAttribute('style', styled(e.getAttribute('style') ?? '')))
  // <picture> sources and media would fetch their own addresses: the <img> inside stays.
  doc.querySelectorAll('source, track').forEach((e) => e.remove())
  doc.querySelectorAll('img, input[type=image]').forEach((img) => {
    const first = (img.getAttribute('srcset') ?? '').trim().split(/\s+/)[0]
    const d = pic(img.getAttribute('src')) || pic(img.getAttribute('data-src')) || pic(first)
    for (const a of ['srcset', 'sizes', 'data-src', 'loading']) img.removeAttribute(a)
    if (d) img.setAttribute('src', d)
    else img.removeAttribute('src')
  })
  doc.querySelectorAll('video, audio').forEach((m) => {
    m.removeAttribute('src')
    const poster = pic(m.getAttribute('poster'))
    if (poster) m.setAttribute('poster', poster)
    else m.removeAttribute('poster')
  })
  // SVG <image>/<use> and the like name addresses too: only a data: picture stays.
  doc.querySelectorAll('[href], [xlink\\:href]').forEach((e) => {
    if (e.tagName.toLowerCase() === 'a') return
    for (const a of ['href', 'xlink:href']) {
      const v = e.getAttribute(a)
      if (v != null && !v.startsWith('#')) {
        const d = pic(v)
        if (d) e.setAttribute(a, d)
        else e.removeAttribute(a)
      }
    }
  })
  doc.querySelectorAll('a').forEach((a) => {
    const href = abs(a.getAttribute('href') ?? '')
    if (!/^https?:/i.test(href)) return void a.removeAttribute('href')
    a.setAttribute('href', href)
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener noreferrer')
  })
  doc.querySelectorAll('form').forEach((f) => f.removeAttribute('action'))
  doc.querySelectorAll('*').forEach((e) => {
    for (const a of Array.from(e.attributes)) if (/^on/i.test(a.name)) e.removeAttribute(a.name)
  })
  const head = doc.head ?? doc.documentElement
  if (vars.size) {
    const defs = doc.createElement('style')
    defs.textContent = `:root{${[...vars].map(([d, v]) => `${v}:url("${d}")`).join(';')}}`
    head.prepend(defs)
  }
  const meta = doc.createElement('meta')
  meta.setAttribute('name', 'referrer')
  meta.setAttribute('content', 'no-referrer')
  head.prepend(meta)
  const policy = doc.createElement('meta')
  policy.setAttribute('http-equiv', 'Content-Security-Policy')
  policy.setAttribute('content', SNAPSHOT_CSP)
  head.prepend(policy)
  const cs = doc.createElement('meta')
  cs.setAttribute('charset', 'utf-8')
  head.prepend(cs)
  return '<!doctype html>' + doc.documentElement.outerHTML
}
