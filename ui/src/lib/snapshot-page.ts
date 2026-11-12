// 스냅샷의 원본 모양 (REQ-F-881, 1.488, Shadow DOM since 1.523): the page the session's Mac rendered, put together
// here from an inert parse (DOMParser: nothing in it runs or loads) and drawn in a shadow root of the sheet.
// Its style sheets come as <style>, its pictures (and those its styles name) as data:, and everything that would run,
// reach out or act is taken away here, because nothing else stands between it and this page: no frame sandbox, no
// document CSP of its own. Left: inline styles, data: pictures, and links that open a new tab.
//   - Elements that run, embed, load or refresh (DROP) are gone; on* attributes, javascript: and other non-http(s)
//     links, every attribute that names an address (src, srcset, background, poster, href, ping, formaction, …) unless
//     it became a data: picture the Mac sent.
//   - Forms become <cb-form> (not a form: nothing to submit) and controls are inert (no focus, no typing, no click).
//   - A popover loses its attribute (no top layer over this page) and stays hidden as it was (1.525).
//   Rule for what is taken away: when it changes how the page looks, that look is kept some other way.
//   - Styles: @import, @font-face, @namespace and @function are dropped, and every address a style could fetch (url()
//     in any case or CSS escape, src(), image-set()/image()/cross-fade() strings) becomes a picture the Mac sent or
//     nothing; a picture function that calls anything that brings a value in (var(), --x(), if(), …) is none, and a
//     cursor is its keyword alone (1.524).
//   - Links to this site or its previews have no href (1.524): a new tab of this site goes with its cookies.
//   - The page's html, body and :root become <cb-html> and <cb-body> (and form, <cb-form>), and its selectors are
//     rewritten to them (CSSOM where the browser has constructable sheets), keeping their specificity.
// The site's CSP (server/httputil.go: scripts only from this site, no inline; styles inline; pictures data:) is the last
// line under all this, not the first. Ids and names inside a shadow root do not become globals of this window.

export interface SnapshotParts {
  url: string
  html: string
  images?: Record<string, string>
  css?: Record<string, string>
  /** This site's own origins (1.524): a link to one of them is no link. Left out: this page's and setAppOrigins'. */
  own?: string[]
  /** The pictures the Mac did not send for being big (1.525): address to [width, height]. */
  big?: Record<string, unknown>
}

/** The server's other origins of its own (its primary one, the previews'), from /api/me (1.524). */
let appOrigins: string[] = []
export function setAppOrigins(list: unknown[]) {
  appOrigins = list.filter((o): o is string => typeof o === 'string' && /^https?:\/\//i.test(o))
}
/** The origins whose links a snapshot keeps none of: this page's, and the server's own (setAppOrigins). */
export const ownOrigins = () => [...(typeof location === 'undefined' ? [] : [location.origin]), ...appOrigins]
/** Whether href (absolute) is at one of own. */
export function atOwnOrigin(href: string, own: string[]): boolean {
  try {
    const o = new URL(href).origin
    return own.some((x) => {
      try {
        return new URL(x).origin === o
      } catch {
        return false
      }
    })
  } catch {
    return true
  }
}

/** The page made safe (1.523), in an inert document: mountSnapshot copies it into a shadow root. */
export interface SnapshotDoc {
  /** The <style> elements of the page's <head>, in order. */
  head: Element[]
  /** <cb-html><cb-body>…</cb-body></cb-html> */
  root: Element
  /** The pictures' custom properties (1.489), `--cb-i0:url("data:…");…`, set on :host. */
  vars: string
  /** About how big it is, for a report. */
  bytes: number
  /**
   * The page's class names and ids made short (1.525), original to new, or null when they were left as they were
   * (no constructable sheets, or a style the names could not be followed through). Tests and reports read it.
   */
  names: { classes: Record<string, string>; ids: Record<string, string> } | null
}

const DATA_IMG = /^data:image\/(png|jpeg|gif|webp|avif);base64,/
/** What a picture the Mac did not send becomes: an empty data: address (nothing is fetched). */
const NO_IMG = 'data:,'
/** A big picture's place (1.525): one grey pixel, drawn at the picture's own size (width, height, --cb-ar). */
const BIG_IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGN4+vw1AAVsArjSAflTAAAAAElFTkSuQmCC'
/**
 * Elements that run, embed, load, refresh or animate an address: dropped with all they hold. None of them hides
 * anything that would show once it is gone (template and noscript content is not drawn by a page that runs scripts,
 * the rest draw nothing of their own), except an SVG <set>/<animate> that sets visibility, display or opacity: left
 * as is, rare in a page, and its timing is not this file's to play.
 */
const DROP =
  'script, noscript, iframe, frame, frameset, object, embed, applet, portal, fencedframe, base, meta, link, template, source, track, animate, animateMotion, animateTransform, set'
/**
 * Attributes that name an address, act, or steal focus: never kept (src and href are seen to on their own).
 * Before adding one here: if it changes how the page looks, keep that look some other way. `popover` is one: the
 * browser's own `[popover]:not(:popover-open){display:none}` hides a closed menu or tooltip, so without the attribute
 * it would be drawn open over the page (1.525). The others here only fetch, act or move focus.
 */
const DROP_ATTRS = ['srcset', 'imagesrcset', 'sizes', 'data-src', 'loading', 'background', 'lowsrc', 'dynsrc', 'longdesc', 'ping', 'download', 'srcdoc', 'formaction', 'formmethod', 'formtarget', 'formenctype', 'form', 'action', 'autofocus', 'contenteditable', 'popover', 'popovertarget', 'popovertargetaction', 'commandfor', 'command', 'manifest', 'archive', 'codebase', 'classid', 'itemtype', 'attributionsrc', 'accesskey', 'cursor']
/** Attributes whose text is never a style (left alone even when it holds "url("). */
const TEXT_ATTRS = /^(alt|title|value|placeholder|label|content|class|id|name|lang|dir|aria-.*|data-.*)$/i

/** The base of every snapshot's shadow root: none of this page's styles come in, a white page as a browser's. */
export const SHADOW_BASE =
  ':host{all:initial;display:block;color-scheme:light;background:#fff;color:#000}cb-body,cb-form{display:block}cb-html{display:flow-root;min-height:var(--cb-vh,0px)}cb-body{margin:8px}[data-cb-big]{aspect-ratio:var(--cb-ar)}'

/** An identifier, CSS escapes and non-ASCII included (`@\69mport` is @import, `\75 rl(` is url(). */
const IDENT = /(?:[\w-]|[^\x00-\x7f]|\\[0-9a-fA-F]{1,6}[ \t\r\n\f]?|\\[^\r\n\f0-9a-fA-F])+/y
const AT_NAME = IDENT
const unescapeCss = (s: string) =>
  s.replace(/\\([0-9a-fA-F]{1,6})[ \t\r\n\f]?|\\(.)/g, (_, h?: string, c?: string) => {
    if (c !== undefined) return c
    const n = parseInt(h ?? '', 16)
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '�'
  })
/**
 * CSS's own preprocessing (1.524): CR LF, CR and FF are one LF, NUL is U+FFFD. Done first, so that this file reads
 * escapes and strings as the browser does: `ur\6c\r\n(` is url( to a browser, and was not to a reader that took the
 * escape's one whitespace as the CR alone.
 */
export const cssPre = (t: string) => t.replace(/\r\n?|\f/g, '\n').replace(/\0/g, '�')
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
/** Where the function whose ( is at i ends (after its matching ), strings and comments stepped over). */
const endOfCall = (t: string, i: number) => {
  let depth = 0
  for (let j = i; j < t.length; ) {
    const c = t[j]
    if (c === '"' || c === "'") j = endOfString(t, j)
    else if (c === '/' && t[j + 1] === '*') j = endOfComment(t, j)
    else if (c === '\\') j += 2
    else {
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) return j + 1
      j++
    }
  }
  return t.length
}
const isIdentStart = (t: string, i: number) => {
  const c = t[i]
  if (c === undefined) return false
  if (c === '\\') return t[i + 1] !== undefined && !/[\r\n\f]/.test(t[i + 1])
  return /[A-Za-z_-]/.test(c) || c > '\x7f'
}
/** The text of a quoted CSS string, unescaped. */
const stringValue = (s: string) => unescapeCss(s.slice(1, s.endsWith(s[0]) && s.length > 1 ? -1 : undefined))
/** A CSS string of s, quoted. */
export const cssString = (s: string) => `"${s.replace(/[\\"]/g, '\\$&').replace(/[\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`

/** Where the block whose { is at i ends (after its matching }, strings, comments and escapes stepped over). */
const endOfBlock = (t: string, i: number) => {
  let depth = 0
  for (let j = i; j < t.length; ) {
    const c = t[j]
    if (c === '"' || c === "'") j = endOfString(t, j)
    else if (c === '/' && t[j + 1] === '*') j = endOfComment(t, j)
    else if (c === '\\') j += 2
    else {
      if (c === '{') depth++
      else if (c === '}' && --depth === 0) return j + 1
      j++
    }
  }
  return t.length
}

/**
 * Every at-rule called `name` taken out, in any case and with CSS escapes, at any depth (inside @media, @supports,
 * @layer, …). A statement (`@import "a";`) goes to its `;`, a block (`@function --u() {…}`) to its matching `}`.
 * Strings and comments are stepped over, so a name inside one is left alone and a cut never eats a comment's end.
 */
function dropAtRule(t: string, name: string, block: boolean): string {
  t = cssPre(t)
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
      if (!m || unescapeCss(m[0]).toLowerCase() !== name) {
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
      else if (block && t[j] === '{') j = endOfBlock(t, j)
      i = from = j
    } else i++
  }
  return out + t.slice(from)
}

/** Every @import rule taken out (1.490): `@import "a"`, `@import url(a)`, in any case and with CSS escapes. */
export const dropImports = (t: string) => dropAtRule(t, 'import', false)

/**
 * Every @function rule taken out (1.524), `@\66unction` and inside @media too: a custom function returns a value
 * where it is called, so `@function --u(){result:"/api/x"}` and `image-set(--u() 1x)` fetched /api/x from this site
 * with its cookies. Calls of one left anywhere become none in scrubCss.
 */
export const dropFunctions = (t: string) => dropAtRule(t, 'function', true)

/** Functions whose strings are pictures to fetch (image-set("a.png" 1x)). */
const IMAGE_FNS = new Set(['image-set', '-webkit-image-set', 'image', 'cross-fade', '-webkit-cross-fade'])
/**
 * The only functions a picture function may hold (1.524): addresses (made pictures here), type(), pictures, gradients,
 * colours and maths, none of which brings a value from elsewhere. Anything else is none: var(), env(), attr(), a
 * custom --x(), if() and whatever substitutes a value next could hand image-set() a string the browser then fetches
 * from this site with its cookies.
 */
const IMAGE_ARGS = new Set([
  ...IMAGE_FNS,
  'url',
  'src',
  'type',
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'calc',
  'min',
  'max',
  'clamp',
  'from',
  'to',
  'color-stop',
])
const imageArg = (name: string) => IMAGE_ARGS.has(name) || /^(-webkit-)?(repeating-)?(linear|radial|conic)-gradient$|^-webkit-gradient$/.test(name)
/** Whether t calls only functions that ok allows (CSS escapes undone), strings and comments stepped over. */
function callsOnly(t: string, ok: (name: string) => boolean): boolean {
  for (let i = 0; i < t.length; ) {
    const c = t[i]
    if (c === '"' || c === "'") i = endOfString(t, i)
    else if (c === '/' && t[i + 1] === '*') i = endOfComment(t, i)
    else if (isIdentStart(t, i)) {
      IDENT.lastIndex = i
      const raw = IDENT.exec(t)?.[0] ?? t[i]
      i += raw.length
      if (t[i] === '(' && !ok(unescapeCss(raw).toLowerCase())) return false
    } else i += c === '\\' ? 2 : 1
  }
  return true
}

/** The parts of a value split at its top-level commas (strings, comments and brackets stepped over). */
function topLevelParts(v: string): string[] {
  const parts: string[] = []
  let from = 0
  for (let i = 0; i < v.length; ) {
    const c = v[i]
    if (c === '"' || c === "'") i = endOfString(v, i)
    else if (c === '/' && v[i + 1] === '*') i = endOfComment(v, i)
    else if (c === '\\') i += 2
    else if (c === '(') i = endOfCall(v, i)
    else {
      if (c === ',') (parts.push(v.slice(from, i)), (from = i + 1))
      i++
    }
  }
  parts.push(v.slice(from))
  return parts
}

/**
 * Every `cursor` declaration made its keyword alone (1.524): a cursor picture (url(), image-set(), a data: one too) can
 * draw a pointer away from where the mouse really is, over this page's own buttons. `cursor:url(a) 1 1, pointer` is
 * `cursor:pointer`, and one with no keyword of its own (`cursor:var(--c)`) is `auto`. A selector (`cursor:hover{`)
 * is told apart by the { that ends it; strings and comments are left alone.
 */
export function keywordCursors(t: string): string {
  t = cssPre(t)
  let out = ''
  let from = 0
  let prev = ''
  for (let i = 0; i < t.length; ) {
    const c = t[i]
    if (c === '/' && t[i + 1] === '*') {
      i = endOfComment(t, i)
      continue
    }
    if (c === '"' || c === "'") {
      i = endOfString(t, i)
      prev = c
      continue
    }
    if (isIdentStart(t, i)) {
      IDENT.lastIndex = i
      const raw = IDENT.exec(t)?.[0] ?? t[i]
      const at = prev === '' || prev === '{' || prev === ';' || prev === '}'
      i += raw.length
      prev = 'a'
      if (!at || unescapeCss(raw).toLowerCase() !== 'cursor') continue
      let k = i
      while (k < t.length && /\s/.test(t[k])) k++
      if (t[k] !== ':') continue
      let e = k + 1
      while (e < t.length && t[e] !== ';' && t[e] !== '}' && t[e] !== '{') {
        if (t[e] === '"' || t[e] === "'") e = endOfString(t, e)
        else if (t[e] === '/' && t[e + 1] === '*') e = endOfComment(t, e)
        else if (t[e] === '(') e = endOfCall(t, e)
        else e += t[e] === '\\' ? 2 : 1
      }
      if (t[e] === '{') continue
      const value = t.slice(k + 1, e)
      if (!/[(,\\]/.test(value)) continue
      const important = /!\s*important\s*$/i.test(value)
      const last = topLevelParts(value.replace(/!\s*important\s*$/i, '')).pop()?.trim() ?? ''
      const kw = /^[a-zA-Z-]+$/.test(last) ? last : 'auto'
      out += t.slice(from, k + 1) + kw + (important ? ' !important' : '')
      from = i = e
      continue
    }
    if (!/\s/.test(c)) prev = c
    i += c === '\\' ? 2 : 1
  }
  return out + t.slice(from)
}

/**
 * Every address a style could fetch, made a picture the Mac sent or nothing (1.523): `url()` in any case or with CSS
 * escapes (`\75 rl(`), `src("…")`, the strings of image-set()/image()/cross-fade(), and `expression()` taken out.
 * `picture` gets the address as written and gives what replaces the whole call (a url() or a var()). Strings and
 * comments elsewhere are left alone. With no frame and no document CSP around a snapshot any more, this is what keeps
 * it from reaching out; the site's CSP is only the last line.
 */
export function scrubCss(t: string, picture: (raw: string) => string): string {
  t = cssPre(t)
  let out = ''
  let i = 0
  let depth = 0
  const images: number[] = []
  while (i < t.length) {
    const c = t[i]
    if (c === '/' && t[i + 1] === '*') {
      const e = endOfComment(t, i)
      out += t.slice(i, e)
      i = e
    } else if (c === '"' || c === "'") {
      const e = endOfString(t, i)
      out += images.length ? picture(stringValue(t.slice(i, e))) : t.slice(i, e)
      i = e
    } else if (isIdentStart(t, i)) {
      IDENT.lastIndex = i
      const m = IDENT.exec(t)
      const raw = m ? m[0] : t[i]
      const j = i + raw.length
      const name = unescapeCss(raw).toLowerCase()
      if (t[j] !== '(') {
        out += raw
        i = j
        continue
      }
      if (name === 'url' || name === 'src' || name === 'expression') {
        const e = endOfCall(t, j)
        if (name === 'expression') out += 'none'
        else {
          const body = t.slice(j + 1, t[e - 1] === ')' ? e - 1 : e).trim()
          const q = body.match(/^(?:"(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?)/)
          out += picture(q ? stringValue(q[0]) : unescapeCss(body))
        }
        i = e
        continue
      }
      if (name.startsWith('--')) {
        // A custom function's call (1.524): its @function is gone (dropFunctions), so it was nothing already, and
        // none wherever it stands (a picture function or a picture's place, `background-image:--u()`).
        out += 'none'
        i = endOfCall(t, j)
        continue
      }
      if (IMAGE_FNS.has(name)) {
        // A value filled in later (var(), env(), attr(), --x(), if()) can be a string the browser then fetches, from
        // this site with its cookies: `--u:"/api/x"; background:image-set(var(--u) 1x)`. Such a picture is none, and
        // so is one that calls anything but the few functions that bring nothing in (IMAGE_ARGS).
        const e = endOfCall(t, j)
        if (!callsOnly(t.slice(j + 1, e), imageArg)) {
          out += 'none'
          i = e
          continue
        }
        images.push(depth + 1)
      }
      out += raw + '('
      depth++
      i = j + 1
    } else if (c === '\\') {
      out += t.slice(i, i + 2)
      i += 2
    } else {
      if (c === '(') depth++
      else if (c === ')') {
        if (images.length && images[images.length - 1] === depth) images.pop()
        depth = Math.max(0, depth - 1)
      }
      out += c
      i++
    }
  }
  return keywordCursors(out)
}

/** The page's own roots, as they are in a shadow root (1.523): same specificity as the type selector they replace. */
const ROOTS: Record<string, string> = { html: 'cb-html', body: 'cb-body', form: 'cb-form' }

/**
 * A selector with the page's `html`, `body`, `form` and `:root` turned into this snapshot's <cb-html>, <cb-body> and
 * <cb-form> (1.523): a shadow root has no html or body, and :root is this page's. Strings and [attribute] tests are
 * left alone, and so are names that are only part of one (`.body`, `#html`, `tbody`, `:has(body)` is rewritten).
 */
export function hostSelector(sel: string): string {
  let out = ''
  let i = 0
  while (i < sel.length) {
    const c = sel[i]
    if (c === '"' || c === "'") {
      const e = endOfString(sel, i)
      out += sel.slice(i, e)
      i = e
    } else if (c === '[') {
      let j = i + 1
      while (j < sel.length && sel[j] !== ']') j = sel[j] === '"' || sel[j] === "'" ? endOfString(sel, j) : j + (sel[j] === '\\' ? 2 : 1)
      out += sel.slice(i, j + 1)
      i = j + 1
    } else if (c === ':' && sel[i + 1] !== ':' && sel[i - 1] !== ':' && isIdentStart(sel, i + 1)) {
      IDENT.lastIndex = i + 1
      const raw = IDENT.exec(sel)?.[0] ?? ''
      out += unescapeCss(raw).toLowerCase() === 'root' && sel[i + 1 + raw.length] !== '(' ? ':is(cb-html)' : ':' + raw
      i += 1 + raw.length
    } else if (isIdentStart(sel, i)) {
      IDENT.lastIndex = i
      const raw = IDENT.exec(sel)?.[0] ?? sel[i]
      const prev = sel[i - 1]
      const typeAt = prev === undefined || /[\s>+~,(|]/.test(prev)
      const to = ROOTS[unescapeCss(raw).toLowerCase()]
      out += typeAt && to && sel[i + raw.length] !== '(' ? to : raw
      i += raw.length
    } else if (c === '\\') {
      out += sel.slice(i, i + 2)
      i += 2
    } else {
      out += c
      i++
    }
  }
  return out
}

/**
 * Style rules' selectors made this snapshot's, and dropped: the rules that only load (font faces, imports,
 * namespaces), custom functions (@function, 1.524), and every rule that could style the host. `scoped` is whether the
 * rule is inside an @scope with a start of its own, where :scope is an element of the page.
 */
function fixRules(list: CSSRuleList, drop: (i: number) => void, scoped = false) {
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i]
    // A rule that styles the host would reach past the box: inside a shadow root its !important wins over this page's
    // own rules, so `:host{position:fixed!important;inset:0!important}` covered the whole sheet. So does an @scope with
    // no start of its own (1.524): its root is the <style>'s parent, which for one in the head is the shadow root's
    // host, and `@scope { :scope {position:fixed!important} }` styled it; and :scope outside a started @scope (`@scope
    // (:scope)` too). The browser has written the selector out plainly (no escapes).
    const text = r.cssText
    const prelude = text.slice(0, Math.max(0, text.indexOf('{')))
    const scope = /^@scope\b/i.test(text)
    const start = scope ? ((r as CSSRule & { start?: string | null }).start ?? '') : ''
    if (
      r instanceof CSSFontFaceRule ||
      r instanceof CSSImportRule ||
      r instanceof CSSNamespaceRule ||
      /^@function\b/i.test(text) ||
      /:host/i.test(prelude) ||
      (scope && (!start.trim() || (!scoped && /:scope|&/i.test(start)))) ||
      (!scoped && !scope && r instanceof CSSStyleRule && /:scope/i.test(r.selectorText))
    ) {
      drop(i)
      continue
    }
    if (r instanceof CSSStyleRule) {
      const s = hostSelector(r.selectorText)
      if (s !== r.selectorText) r.selectorText = s
    }
    // Groups (@media, @supports, @layer, @container, @scope, …) and nested style rules; a keyframes rule holds no
    // selectors.
    if (!(r instanceof CSSKeyframesRule) && 'cssRules' in r && 'deleteRule' in r) {
      const g = r as CSSGroupingRule
      fixRules(g.cssRules, (j) => g.deleteRule(j), scoped || scope)
    }
  }
}

/** A style sheet's text as it goes into the shadow root (1.523). */
function sheetText(text: string, picture: (raw: string) => string): string {
  let t = dropImports(text)
  t = dropFunctions(t)
  try {
    const sh = new CSSStyleSheet()
    sh.replaceSync(t)
    fixRules(sh.cssRules, (i) => sh.deleteRule(i))
    t = Array.from(sh.cssRules, (r) => r.cssText).join('\n')
  } catch {
    // No constructable sheets: the selectors stay as written (they match nothing of html or body here), and what a
    // style could fetch is still taken out below.
  }
  return scrubCss(t, picture)
}

export function snapshotPage(s: SnapshotParts): SnapshotDoc {
  const images = s.images ?? {}
  const css = s.css ?? {}
  const own = s.own ?? ownOrigins()
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
  const bigOf = (u: string | null | undefined): [number, number] | null => {
    if (!u || u.startsWith('data:')) return null
    const v = (s.big ?? {})[abs(u)]
    return Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n > 0 && n <= 100000) ? [v[0], v[1]] : null
  }
  // Every address of a style: its picture when the Mac sent it, else nothing to fetch. A picture is written once, as
  // a custom property on :host, and every style names it by var() (1.489): a sprite named by hundreds of rules made
  // coupang.com's page 15 MB from 3.7 MB of pictures, and an iPhone drew nothing of it.
  const vars = new Map<string, string>()
  const varOf = (d: string) => {
    let v = vars.get(d)
    if (!v) vars.set(d, (v = `--cb-i${vars.size}`))
    return `var(${v})`
  }
  const pictureFor =
    (base = s.url) =>
    (raw: string) => {
      const r = raw.trim()
      if (r.startsWith('#')) return `url(${cssString(r)})`
      if (DATA_IMG.test(r)) return `url(${cssString(r)})`
      const d = images[abs(r, base)]
      return typeof d === 'string' && DATA_IMG.test(d) ? varOf(d) : `url("${NO_IMG}")`
    }

  const doc = new DOMParser().parseFromString(s.html, 'text/html')
  const done = new Set<Element>()
  doc.querySelectorAll('link').forEach((l) => {
    const rel = (l.getAttribute('rel') ?? '').toLowerCase().split(/\s+/)
    const href = abs(l.getAttribute('href') ?? '')
    const text = rel.includes('stylesheet') ? css[href] : undefined
    if (typeof text !== 'string') return void l.remove()
    const st = doc.createElement('style')
    const media = l.getAttribute('media')
    if (media) st.setAttribute('media', media)
    st.textContent = sheetText(text, pictureFor(href))
    done.add(st)
    l.replaceWith(st)
  })
  doc.querySelectorAll(DROP).forEach((e) => e.remove())
  doc.querySelectorAll('style').forEach((st) => {
    if (!done.has(st)) st.textContent = sheetText(st.textContent ?? '', pictureFor())
  })
  doc.querySelectorAll('img, input[type=image]').forEach((img) => {
    const first = (img.getAttribute('srcset') ?? '').trim().split(/\s+/)[0]
    const d = pic(img.getAttribute('src')) || pic(img.getAttribute('data-src')) || pic(first)
    const size = d ? null : bigOf(img.getAttribute('src')) || bigOf(img.getAttribute('data-src')) || bigOf(first)
    img.setAttribute('src', d)
    if (!d) img.removeAttribute('src')
    // A picture the Mac left out for its size (1.525): a grey box as big as it was. Its width and height attributes
    // when it had neither, and its ratio through --cb-ar (SHADOW_BASE), first in its style so the page's own style
    // (even an unclosed comment at its end) cannot take it away; a rule of the page that sets a ratio still wins.
    if (size) {
      img.setAttribute('src', BIG_IMG)
      if (!img.hasAttribute('width') && !img.hasAttribute('height')) {
        img.setAttribute('width', String(size[0]))
        img.setAttribute('height', String(size[1]))
      }
      img.setAttribute('data-cb-big', '')
      img.setAttribute('style', `--cb-ar:${size[0]} / ${size[1]};${img.getAttribute('style') ?? ''}`)
    }
  })
  doc.querySelectorAll('video, audio').forEach((m) => {
    const poster = pic(m.getAttribute('poster'))
    if (poster) m.setAttribute('poster', poster)
    else m.removeAttribute('poster')
  })
  doc.querySelectorAll('a, area').forEach((a) => {
    a.removeAttribute('xlink:href')
    // No href is no link (an empty one would be the page itself).
    if (!a.hasAttribute('href')) return
    const href = abs(a.getAttribute('href') ?? '')
    if (!/^https?:/i.test(href)) return void a.removeAttribute('href')
    // Nor a link to this site or its previews (1.524): a new tab of /api/… goes with this site's cookies.
    if (atOwnOrigin(href, own)) return void a.removeAttribute('href')
    a.setAttribute('href', href)
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener noreferrer')
  })
  // A form becomes a block that is not one: nothing can be sent to this site with its cookies, or anywhere.
  doc.querySelectorAll('form').forEach((f) => {
    const b = doc.createElement('cb-form')
    for (const a of ['class', 'id', 'style', 'dir', 'lang', 'title', 'role']) {
      const v = f.getAttribute(a)
      if (v != null) b.setAttribute(a, v)
    }
    b.append(...Array.from(f.childNodes))
    f.replaceWith(b)
  })
  doc.querySelectorAll('button, input, select, textarea, fieldset').forEach((e) => {
    e.setAttribute('inert', '')
    e.setAttribute('tabindex', '-1')
  })
  doc.querySelectorAll('*').forEach((e) => {
    const tag = e.tagName.toLowerCase()
    // A popover is closed in a snapshot (nothing could open it, and a parsed page has none open): hidden as the
    // browser hides it, since its attribute goes below. Its own style is of no use then, and an inline !important is
    // the one declaration no rule of the page can win over (a page rule with !important and more weight would beat
    // one in SHADOW_BASE; a `hidden` attribute gives way to any display the page sets).
    const closed = e.hasAttribute('popover') && !(tag === 'dialog' && e.hasAttribute('open'))
    for (const a of Array.from(e.attributes)) {
      const n = a.name.toLowerCase()
      if (/^on/.test(n) || DROP_ATTRS.includes(n)) e.removeAttribute(a.name)
      else if (n === 'src') {
        // Only a picture the Mac sent (set above).
        if (!((tag === 'img' || tag === 'input') && DATA_IMG.test(a.value))) e.removeAttribute(a.name)
      } else if (n === 'href' || n === 'xlink:href') {
        // A link's was seen to above. SVG <image>/<use>, MathML and the like: a #fragment or a picture the Mac sent.
        if (tag === 'a' || tag === 'area' || a.value.startsWith('#')) continue
        const d = pic(a.value)
        if (d) e.setAttribute(a.name, d)
        else e.removeAttribute(a.name)
      } else if (n === 'style') e.setAttribute('style', scrubCss(a.value, pictureFor()))
      else if (!TEXT_ATTRS.test(n) && /\(|\\/.test(a.value)) e.setAttribute(a.name, scrubCss(a.value, pictureFor()))
    }
    if (closed) {
      e.setAttribute('style', 'display:none!important')
      e.setAttribute('data-cb-popover', '')
    }
  })

  // The page's html and body as this snapshot's own roots, with their class, style and the like.
  const root = doc.createElement('cb-html')
  const body = doc.createElement('cb-body')
  const keep = ['class', 'id', 'style', 'dir', 'lang']
  for (const [from, to] of [
    [doc.documentElement, root],
    [doc.body, body],
  ] as const) {
    if (!from) continue
    for (const a of keep) {
      const v = from.getAttribute(a)
      if (v != null) to.setAttribute(a, v)
    }
  }
  if (doc.body) body.append(...Array.from(doc.body.childNodes))
  root.append(body)
  const head = doc.head ? Array.from(doc.head.querySelectorAll('style')) : []
  // The body's own <style> elements go with the head's, after them (1.525): the order of the sheets, and so the
  // cascade, is the page's. A site's styles written into its body (one of 518 KB on github.com) were otherwise a
  // piece of the page alone, the piece the phone draws first. Only those before any SVG <style>: that one stays.
  for (const st of Array.from(root.querySelectorAll('style'))) {
    if (st.namespaceURI !== 'http://www.w3.org/1999/xhtml') break
    st.remove()
    head.push(st)
  }
  // Lighter (1.525): rules that match nothing gone, names short, comments and layout whitespace out. Every sheet it
  // writes goes through the same filters as above again, so nothing taken out comes back.
  const names = lighten(root, head, (t) => scrubCss(dropFunctions(dropImports(t)), pictureFor()))
  // The same sheet twice in a row is once (three of 232 KB on github.com). Not two apart: the first names the order of
  // its @layer, the second wins over what is between.
  for (let i = head.length - 1; i > 0; i--) if (head[i].textContent === head[i - 1].textContent && head[i].getAttribute('media') === head[i - 1].getAttribute('media')) head.splice(i, 1)
  const varsText = [...vars].map(([d, v]) => `${v}:url(${cssString(d)})`).join(';')
  const bytes = root.outerHTML.length + head.reduce((n, st) => n + (st.textContent?.length ?? 0), 0) + varsText.length
  return { head, root, vars: varsText, bytes, names }
}

/** Tags whose text keeps its whitespace whatever the page's styles say. */
const KEEP_SPACE = new Set(['pre', 'textarea', 'listing', 'xmp', 'plaintext'])
/** Attributes that name ids, a list of them each (aria-*, label's for, …): an id's new name goes in them too. */
const ID_REFS = ['for', 'headers', 'list', 'anchor', 'itemref', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'aria-flowto', 'aria-details', 'aria-errormessage']
/** An attribute selector, [name], [name op value] or [name op value i]; a namespace before the name is let go. */
const ATTR_SEL = /\[\s*(?:[\w*-]*\|)?((?:[\w-]|\\.)+)\s*(?:([~|^$*]?=)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s\]]+)\s*([iIsS])?\s*)?\]/g
/** What an attribute selector of a class or an id (or a reference to one) tests a name with. */
type NameTest = (name: string) => boolean
/**
 * The tests a selector makes of class names and ids as text (1.525): `[class*="col-"]`, `[aria-controls^=menu]`,
 * `[href="#top"]` of an SVG link, one per name in the attribute. A name such a test passes keeps its own, and a short
 * name it would pass is not given, so what matched still matches and nothing new does. A test of more than one name
 * at once (a value with a space) cannot be followed: `block` gets that kind, and its names all stay.
 */
function nameTests(sel: string, tests: { '.': NameTest[]; '#': NameTest[] }, block: (k: '.' | '#') => void) {
  for (const m of sel.matchAll(ATTR_SEL)) {
    const [, rawName, op, rawValue, flag] = m
    if (!op) continue
    const attr = unescapeCss(rawName).toLowerCase()
    const kind = attr === 'class' ? '.' : attr === 'id' || attr === 'href' || ID_REFS.includes(attr) ? '#' : null
    if (!kind) continue
    let v = /^["']/.test(rawValue) ? stringValue(rawValue) : unescapeCss(rawValue)
    if (op !== '~=' && /[ \t\n\r\f]/.test(v)) {
      block(kind)
      continue
    }
    const ci = /i/i.test(flag ?? '')
    if (ci) v = v.toLowerCase()
    // An href names an id as "#name".
    const of = (n: string) => (attr === 'href' ? '#' : '') + (ci ? n.toLowerCase() : n)
    const pass: Record<string, (x: string) => boolean> = {
      '=': (x) => x === v,
      '~=': (x) => x === v,
      '^=': (x) => v !== '' && x.startsWith(v),
      '$=': (x) => v !== '' && x.endsWith(v),
      '*=': (x) => v !== '' && x.includes(v),
      '|=': (x) => x === v || x.startsWith(`${v}-`),
    }
    tests[kind].push((n) => pass[op](of(n)))
  }
}
/** `url(#id)` in a style or an SVG attribute (fill, clip-path, mask, …): the id it names. */
const URL_ID = /url\(\s*(["']?)#([^"')\s]+)\1\s*\)/g
const WS = /[ \t\n\r\f]+/

/** The n-th short name: a, b, …, z, ba, bb, …: a letter first, then letters and digits. */
function shortName(n: number): string {
  const first = 'abcdefghijklmnopqrstuvwxyz'
  const rest = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = first[n % 26]
  n = Math.floor(n / 26)
  while (n > 0) {
    out += rest[n % 36]
    n = Math.floor(n / 36)
  }
  return out
}

/** Every style rule of a list, inside groups and nested rules too. */
function eachStyleRule(list: CSSRuleList, f: (r: CSSStyleRule) => void) {
  for (const r of Array.from(list)) {
    if (r instanceof CSSStyleRule) f(r)
    if (!(r instanceof CSSKeyframesRule) && 'cssRules' in r) eachStyleRule((r as CSSGroupingRule).cssRules, f)
  }
}

/**
 * The class names (.x) and ids (#x) of a selector as the maps give them (1.525); strings and [attribute] tests are
 * left alone, and so is a name the maps do not have. `seen` gets every name, renamed or not.
 */
export function renameSelector(sel: string, classes: Record<string, string>, ids: Record<string, string>, seen?: (kind: '.' | '#', name: string) => void): string {
  let out = ''
  let i = 0
  while (i < sel.length) {
    const c = sel[i]
    if (c === '"' || c === "'") {
      const e = endOfString(sel, i)
      out += sel.slice(i, e)
      i = e
    } else if (c === '[') {
      let j = i + 1
      while (j < sel.length && sel[j] !== ']') j = sel[j] === '"' || sel[j] === "'" ? endOfString(sel, j) : j + (sel[j] === '\\' ? 2 : 1)
      out += sel.slice(i, j + 1)
      i = j + 1
    } else if (c === '.' || c === '#') {
      IDENT.lastIndex = i + 1
      const raw = IDENT.exec(sel)?.[0] ?? ''
      if (!raw) {
        out += c
        i++
        continue
      }
      const name = unescapeCss(raw)
      seen?.(c, name)
      const to = Object.hasOwn(c === '.' ? classes : ids, name) ? (c === '.' ? classes : ids)[name] : undefined
      out += c + (to ?? raw)
      i += 1 + raw.length
    } else if (c === '\\') {
      out += sel.slice(i, i + 2)
      i += 2
    } else {
      out += c
      i++
    }
  }
  return out
}

/**
 * The snapshot made lighter (1.525), in place, without changing how it looks. Needs constructable sheets (CSSOM);
 * without them only comments go. Each step leaves alone what it cannot judge:
 *   1. Rules: a style rule whose selector matches nothing in the page is dropped, at the top or in an @layer. Kept:
 *      a selector with any pseudo-class or pseudo-element (:hover, ::before, :is(), …) or nesting (&), and whatever is
 *      in @media, @supports, @container, @scope, @starting-style; @keyframes, @property and the like.
 *   2. Whitespace: a text of whitespace alone becomes one space (as the browser draws it anyway), not in pre, textarea
 *      and the like, nor where a style keeps whitespace (white-space: pre…, break-spaces, preserve); none at all when
 *      such a style cannot be followed (nested, a selector that does not parse). Comments go.
 *   3. Names: classes and ids become short names in the page, its selectors and ids' references (label for, aria-*,
 *      an SVG href="#…", url(#…)), all of them or none. A name a selector tests as text ([class*="col-"]) keeps its
 *      own (nameTests); a kind (classes, ids) stays whole when such a test takes more than one name at once; none
 *      change when the page has an @scope (its bounds cannot be rewritten) or the browser refuses a selector.
 * Every sheet is written back through `safe` (the filters of sheetText again), so a rule or an address taken out
 * before cannot come back through the browser's own writing of it. Returns the names, or null when they stayed.
 */
function lighten(root: Element, head: Element[], safe: (t: string) => string): SnapshotDoc['names'] {
  const doc = root.ownerDocument
  const each = (show: number, f: (n: Node) => void) => {
    const w = doc.createTreeWalker(root, show)
    const all: Node[] = []
    for (let n = w.nextNode(); n; n = w.nextNode()) all.push(n)
    all.forEach(f)
  }
  each(NodeFilter.SHOW_COMMENT, (n) => n.parentNode?.removeChild(n))
  const styles = [...head, ...Array.from(root.querySelectorAll('style'))]
  let sheets: CSSStyleSheet[]
  try {
    sheets = styles.map((st) => {
      const sh = new CSSStyleSheet()
      sh.replaceSync(st.textContent ?? '')
      fixRules(sh.cssRules, (i) => sh.deleteRule(i))
      return sh
    })
  } catch {
    return null
  }
  const matches = (sel: string) => {
    try {
      return root.matches(sel) || root.querySelector(sel) !== null
    } catch {
      return true
    }
  }
  // 1. Rules that match nothing.
  const prune = (list: CSSRuleList, del: (i: number) => void) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i]
      if (r instanceof CSSStyleRule) {
        const nested = 'cssRules' in r && (r as CSSStyleRule & { cssRules: CSSRuleList }).cssRules.length > 0
        if (!nested && !/[:&]/.test(r.selectorText) && !matches(r.selectorText)) del(i)
      } else if (typeof CSSLayerBlockRule !== 'undefined' && r instanceof CSSLayerBlockRule) prune(r.cssRules, (j) => r.deleteRule(j))
    }
  }
  for (const sh of sheets) prune(sh.cssRules, (i) => sh.deleteRule(i))
  const text = (sh: CSSStyleSheet) => Array.from(sh.cssRules, (r) => r.cssText).join('')
  const pruned = sheets.map(text)
  const write = (texts: string[]) => styles.forEach((st, i) => (st.textContent = safe(texts[i])))

  // 2. Whitespace, before names change (the page's selectors find the elements that keep it).
  const keep = new Set<Element>()
  let spaces = true
  for (const sh of sheets)
    eachStyleRule(sh.cssRules, (r) => {
      if (!/white-space(?:-collapse)?\s*:[^;]*(?:pre|break-spaces|preserve)/i.test(r.style.cssText)) return
      if (/&/.test(r.selectorText) || r.parentRule instanceof CSSStyleRule) return void (spaces = false)
      try {
        root.querySelectorAll(r.selectorText).forEach((e) => keep.add(e))
        if (root.matches(r.selectorText)) keep.add(root)
      } catch {
        spaces = false
      }
    })
  root.querySelectorAll('[style]').forEach((e) => {
    if (/white-space/i.test(e.getAttribute('style') ?? '')) keep.add(e)
  })
  if (spaces)
    each(NodeFilter.SHOW_TEXT, (n) => {
      const t = n as Text
      if (t.data.length < 2 || !/^[ \t\n\r\f]+$/.test(t.data)) return
      for (let p = t.parentElement; p; p = p.parentElement) if (KEEP_SPACE.has(p.localName) || keep.has(p)) return
      t.data = ' '
    })

  // 3. Names: worked out on copies of the sheets, then all or none.
  let fixed = false
  const blocked = { '.': false, '#': false }
  const tests: { '.': NameTest[]; '#': NameTest[] } = { '.': [], '#': [] }
  const cssNames: [string, string][] = []
  for (const sh of sheets) {
    const walk = (list: CSSRuleList) => {
      for (const r of Array.from(list)) {
        if (/^@scope\b/i.test(r.cssText)) fixed = true
        if (r instanceof CSSStyleRule) {
          nameTests(r.selectorText, tests, (k) => (blocked[k] = true))
          renameSelector(r.selectorText, {}, {}, (k, name) => cssNames.push([k, name]))
        }
        if (!(r instanceof CSSKeyframesRule) && 'cssRules' in r) walk((r as CSSGroupingRule).cssRules)
      }
    }
    walk(sh.cssRules)
  }
  if (fixed || (blocked['.'] && blocked['#'])) {
    write(pruned)
    return null
  }
  const clsCount = new Map<string, number>()
  const idCount = new Map<string, number>()
  const add = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1)
  const els = [root, ...Array.from(root.querySelectorAll('*'))]
  const urlIds = (v: string) => Array.from(v.matchAll(URL_ID), (m) => m[2])
  const fragment = (e: Element, name: string) => (name === 'href' || name === 'xlink:href') && e.localName !== 'a' && e.localName !== 'area'
  for (const e of els) {
    for (const c of (e.getAttribute('class') ?? '').split(WS)) if (c) add(clsCount, c)
    const id = e.getAttribute('id')
    if (id) add(idCount, id)
    for (const a of ID_REFS) for (const r of (e.getAttribute(a) ?? '').split(WS)) if (r) add(idCount, r)
    for (const a of Array.from(e.attributes)) {
      if (fragment(e, a.name) && a.value.startsWith('#')) add(idCount, a.value.slice(1))
      for (const r of urlIds(a.value)) add(idCount, r)
    }
  }
  for (const t of pruned) for (const r of urlIds(t)) add(idCount, r)
  // A name only the styles have gets a short one too: left long, it could be the short name of another.
  for (const [k, name] of cssNames) add(k === '.' ? clsCount : idCount, name)
  // The most used first, the shortest names. A name a test passes keeps its own; a short name that a test passes, or
  // that is a kept name, is skipped.
  const named = (m: Map<string, number>, k: '.' | '#') => {
    const out: Record<string, string> = {}
    if (blocked[k]) return out
    const passes = (x: string) => tests[k].some((f) => f(x))
    const kept = new Set([...m.keys()].filter(passes))
    let n = 0
    for (const [name] of [...m].sort((a, b) => b[1] - a[1])) {
      if (kept.has(name)) continue
      let to = shortName(n++)
      while (passes(to) || kept.has(to)) to = shortName(n++)
      out[name] = to
    }
    return out
  }
  const classes = named(clsCount, '.')
  const ids = named(idCount, '#')
  const urlTo = (v: string) => v.replace(URL_ID, (all, q: string, id: string) => (Object.hasOwn(ids, id) ? `url(${q}#${ids[id]}${q})` : all))
  const renamed: string[] = []
  for (const t of pruned) {
    const sh = new CSSStyleSheet()
    let refused = false
    try {
      sh.replaceSync(t)
      eachStyleRule(sh.cssRules, (r) => {
        const was = r.selectorText
        const to = renameSelector(was, classes, ids)
        if (to === was) return
        r.selectorText = to
        if (r.selectorText === was) refused = true
      })
    } catch {
      refused = true
    }
    if (refused) {
      write(pruned)
      return null
    }
    renamed.push(urlTo(text(sh)))
  }
  write(renamed)
  // Each name in place: the whitespace around it stays (a [class^=x] test reads the attribute as it is).
  const map = (v: string, m: Record<string, string>) => v.replace(/[^ \t\n\r\f]+/g, (x) => (Object.hasOwn(m, x) ? m[x] : x))
  for (const e of els) {
    const cl = e.getAttribute('class')
    if (cl !== null) e.setAttribute('class', map(cl, classes))
    const id = e.getAttribute('id')
    if (id && Object.hasOwn(ids, id)) e.setAttribute('id', ids[id])
    for (const a of ID_REFS) {
      const v = e.getAttribute(a)
      if (v) e.setAttribute(a, map(v, ids))
    }
    for (const a of Array.from(e.attributes)) {
      if (fragment(e, a.name) && a.value.startsWith('#') && Object.hasOwn(ids, a.value.slice(1))) e.setAttribute(a.name, `#${ids[a.value.slice(1)]}`)
      else if (a.value.includes('url(')) {
        const v = urlTo(a.value)
        if (v !== a.value) e.setAttribute(a.name, v)
      }
    }
  }
  return { classes, ids }
}

/** How much of a snapshot is put in at a time (1.525): about 200 KB of its HTML (characters). */
export const SNAPSHOT_CHUNK = 200 * 1024
/**
 * Elements a piece may end inside (their children go in over several pieces): boxes of blocks. Anything else (a
 * paragraph, a list item, a row, a picture, …) goes in whole, so a piece never ends in the middle of one. Custom
 * elements (a name with "-") are boxes too: sites wrap whole pages in them.
 */
const SPLIT_TAGS = new Set(['cb-html', 'cb-body', 'cb-form', 'div', 'main', 'section', 'article', 'aside', 'nav', 'header', 'footer', 'ul', 'ol', 'dl', 'table', 'thead', 'tbody', 'tfoot', 'details', 'fieldset', 'figure', 'blockquote', 'center'])
const splits = (n: Node): n is Element => n instanceof Element && n.firstChild !== null && (SPLIT_TAGS.has(n.localName) || n.localName.includes('-'))
const sizeOf = (n: Node) => (n instanceof Element ? n.outerHTML.length : (n.textContent ?? '').length)

/**
 * A snapshot put in piece by piece (1.525): what is left waits, each node with the parent it goes back into, in the
 * page's order. A piece takes nodes whole while they fit; one that does not fit and is a box goes in empty, its
 * children first in line. A piece goes on until a node went in whole, however big that one is: never boxes alone.
 */
class Pieces {
  private left: [Node, Node][]
  constructor(left: [Node, Node][]) {
    this.left = left
  }
  more(budget: number): boolean {
    let used = 0
    // Whether a node went in whole: until one does, a piece goes on (empty boxes alone are no piece).
    let filled = false
    while (this.left.length) {
      const [parent, node] = this.left[0]
      const size = sizeOf(node)
      if (used + size > budget && splits(node)) {
        this.left.shift()
        const kids = Array.from(node.childNodes)
        node.replaceChildren()
        parent.appendChild(node)
        used += sizeOf(node)
        this.left.unshift(...kids.map((k): [Node, Node] => [node, k]))
        continue
      }
      if (filled && used + size > budget) break
      this.left.shift()
      parent.appendChild(node)
      used += size
      filled = true
    }
    return this.left.length > 0
  }
}
const pieces = new WeakMap<ShadowRoot, Pieces>()

/**
 * The next piece of the snapshot mounted in host (1.525), put in after what is there; whether more is left. The sheet
 * calls it as its box is scrolled near the end.
 */
export function snapshotMore(host: Element, budget = SNAPSHOT_CHUNK): boolean {
  const sh = host.shadowRoot
  const p = sh ? pieces.get(sh) : undefined
  if (!sh || !p) return false
  const left = p.more(budget)
  if (!left) pieces.delete(sh)
  return left
}

/**
 * The snapshot drawn in host's own shadow root (1.523), anew each time: the base, the page's head styles, its body. A
 * click or a submit inside stops at the shadow root and the host, so nothing of the page reaches this page's own
 * handlers (links still open their new tab).
 */
export function mountSnapshot(host: HTMLElement, d: SnapshotDoc, budget = SNAPSHOT_CHUNK): ShadowRoot {
  let sh = host.shadowRoot
  if (!sh) {
    sh = host.attachShadow({ mode: 'open' })
    // On the host too: a click on an inert control is dispatched to the host itself, past the shadow root.
    for (const t of ['click', 'auxclick', 'dblclick', 'submit'])
      for (const at of [sh, host])
        at.addEventListener(t, (e) => {
          e.stopPropagation()
          if (t === 'submit') e.preventDefault()
        })
  }
  const base = document.createElement('style')
  base.textContent = SHADOW_BASE + (d.vars ? `:host{${d.vars}}` : '')
  sh.replaceChildren(base, ...d.head.map((n) => document.importNode(n, true)))
  // The page by SNAPSHOT_CHUNK (1.525): a phone draws the first piece at once, the rest as the box is scrolled.
  const p = new Pieces([[sh, document.importNode(d.root, true)]])
  if (p.more(budget)) pieces.set(sh, p)
  else pieces.delete(sh)
  return sh
}
