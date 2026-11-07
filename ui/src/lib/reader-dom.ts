// 스냅샷의 읽기 (REQ-F-881, 1.469): the page the session's Mac rendered, read here into title, text and pictures
// with the same rules as the server's reader (server/reader.go readerParse, IF-275). The server never reads a
// snapshot: a Mac that seals sends it as a piece only this device opens. The HTML is parsed by DOMParser, which
// runs no script and loads nothing; only the blocks below reach the screen, as this page's own elements.

export interface ReaderBlock {
  t: 'h1' | 'h2' | 'h3' | 'p' | 'li' | 'pre' | 'quote' | 'img'
  text?: string
  src?: string
}
export interface ReaderPage {
  title: string
  site: string
  blocks: ReaderBlock[]
}

const MAX_BLOCKS = 400
const MAX_TEXT = 200_000
// Thrown away with what is inside, as the server's reader does.
const DROP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'canvas', 'select', 'textarea', 'button', 'head'])
// A page's own furniture: what is inside is not read.
const CHROME = new Set(['nav', 'header', 'footer', 'aside', 'form', 'dialog', 'menu'])
const BREAKS = new Set(['p', 'div', 'section', 'table', 'tr', 'figure', 'figcaption', 'article', 'main'])

/** What a block's picture shows as: a data: picture the Mac read, else src(abs) or nothing. */
export type ImageOf = (abs: string) => string | null

/** The minimal DOM this reads: a DOMParser document, or anything shaped like one (tests). */
interface N {
  nodeType: number
  nodeName: string
  nodeValue?: string | null
  childNodes: ArrayLike<N>
  getAttribute?: (name: string) => string | null
}

export function readDom(doc: { documentElement: N; title?: string; querySelector?: (s: string) => { getAttribute(n: string): string | null } | null }, pageUrl: string, imageOf: ImageOf): ReaderPage {
  const meta = (p: string) => doc.querySelector?.(`meta[property="${p}"]`)?.getAttribute('content')?.trim() ?? ''
  const title = meta('og:title') || (doc.title ?? '').trim()
  const site = meta('og:site_name')
  type Blk = ReaderBlock & { article: boolean; main: boolean }
  const all: Blk[] = []
  let cur = ''
  let curT: ReaderBlock['t'] = 'p'
  let chrome = 0
  let article = 0
  let main = 0
  let total = 0
  const add = (b: ReaderBlock) => {
    if (total > MAX_TEXT || all.length >= MAX_BLOCKS) return
    const last = all[all.length - 1]
    // The same line twice in a row: a page's phone and computer layouts of one thing.
    if (last && last.t === b.t && last.text === b.text && last.src === b.src) return
    total += b.text?.length ?? 0
    all.push({ ...b, article: article > 0, main: main > 0 })
  }
  const flush = () => {
    const t = curT === 'pre' ? cur.replace(/^\n+|\n+$/g, '') : cur.replace(/\s+/g, ' ').trim()
    cur = ''
    if (t) add({ t: curT, text: t })
  }
  const start = (t: ReaderBlock['t']) => {
    flush()
    curT = t
  }
  const breakHere = () => (curT === 'pre' ? (cur += '\n') : flush())
  const imgSrc = (el: N) => {
    const a = (n: string) => (el.getAttribute?.(n) ?? '').trim()
    let s = a('src')
    if (!s || s.startsWith('data:')) s = a('data-src')
    if (!s) s = a('srcset').split(/\s+/)[0] ?? ''
    if (!s || s.startsWith('data:')) return null
    try {
      const u = new URL(s, pageUrl)
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
    } catch {
      return null
    }
  }
  const walk = (n: N) => {
    if (n.nodeType === 3) {
      if (chrome === 0) cur += n.nodeValue ?? ''
      return
    }
    if (n.nodeType !== 1) return
    const name = n.nodeName.toLowerCase()
    if (DROP.has(name)) return
    if (name === 'img') {
      if (chrome > 0) return
      const abs = imgSrc(n)
      const src = abs ? imageOf(abs) : null
      if (src) {
        flush()
        add({ t: 'img', src, text: (n.getAttribute?.('alt') ?? '').trim() || undefined })
      }
      return
    }
    if (name === 'br') {
      cur += curT === 'pre' ? '\n' : ' '
      return
    }
    // Opening.
    if (/^h[1-6]$/.test(name)) start(name === 'h1' ? 'h1' : name === 'h2' ? 'h2' : 'h3')
    else if (name === 'li' || name === 'dt' || name === 'dd') start('li')
    else if (name === 'blockquote') start('quote')
    else if (name === 'pre') start('pre')
    else if (BREAKS.has(name)) breakHere()
    else if (name === 'td' || name === 'th') cur += ' '
    if (CHROME.has(name)) chrome++
    if (name === 'article') article++
    if (name === 'main') main++
    for (const c of Array.from(n.childNodes)) walk(c)
    if (CHROME.has(name)) chrome--
    if (name === 'article') article--
    if (name === 'main') main--
    // Closing.
    if (/^h[1-6]$/.test(name) || ['li', 'dt', 'dd', 'blockquote', 'pre', 'ul', 'ol', 'dl'].includes(name)) start('p')
    else if (BREAKS.has(name)) breakHere()
  }
  walk(doc.documentElement)
  flush()
  // <article> when there is one, else <main>, else everything (IF-275).
  const someArticle = all.some((b) => b.article)
  const someMain = all.some((b) => b.main)
  const blocks = all.filter((b) => (someArticle ? b.article : someMain ? b.main : true)).map(({ article: _a, main: _m, ...b }) => b)
  return { title, site, blocks }
}

/** A snapshot as the Mac gave it, read with DOMParser (the browser's; inert: no scripts, nothing loaded). */
export function readSnapshot(html: string, pageUrl: string, imageOf: ImageOf): ReaderPage {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return readDom(doc as unknown as Parameters<typeof readDom>[0], pageUrl, imageOf)
}
