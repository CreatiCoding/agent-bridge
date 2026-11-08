// 스냅샷의 원본 모양 (REQ-F-881, 1.488): the page the session's Mac rendered, put together here as one self-contained
// document for a sandboxed frame. Its style sheets come as <style>, its pictures (and those its styles name) as
// data:, and everything that would run or reach out is taken away: scripts, frames, plugins, <base>, refresh, every
// address left over. The frame has no scripts and no origin of its own (sandbox without allow-scripts or
// allow-same-origin), and it keeps this site's CSP, which lets it load nothing but inline styles and data: pictures.
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
  // Every url(...) of a style: its picture as data: when the Mac sent it, else nothing to fetch.
  const styled = (text: string, base = s.url) =>
    text.replace(URL_RE, (all, a?: string, b?: string, c?: string) => {
      const raw = (a ?? b ?? c ?? '').trim()
      if (raw.startsWith('#')) return all
      if (raw.startsWith('data:')) return DATA_IMG.test(raw) ? all : `url("${NO_IMG}")`
      const d = images[abs(raw, base)]
      return `url("${typeof d === 'string' && DATA_IMG.test(d) ? d : NO_IMG}")`
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
  const meta = doc.createElement('meta')
  meta.setAttribute('name', 'referrer')
  meta.setAttribute('content', 'no-referrer')
  head.prepend(meta)
  const cs = doc.createElement('meta')
  cs.setAttribute('charset', 'utf-8')
  head.prepend(cs)
  return '<!doctype html>' + doc.documentElement.outerHTML
}
