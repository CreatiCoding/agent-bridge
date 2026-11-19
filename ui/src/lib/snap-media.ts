// 스냅샷의 @media 를 그린 폭에 맞추기 (REQ-F-922): a snapshot is laid out in the sheet at its own width (the Mac's,
// or wider when zoomed out), but the page's @media rules still ask about the phone's own screen, so a page drawn
// 1280 wide kept its phone layout. Each media list that asks about width or height is answered here against the
// width the page is laid out at, and set to `all` or `not all`; the rest (colour scheme, hover, print) is left to
// the browser. A query this file cannot read is left as it was.

/** The browser's own answer for a feature this file does not size (prefers-color-scheme, hover, …). */
export type MatchMedia = (query: string) => boolean

const SIZE = /\b(width|height|aspect-ratio|orientation)\b/i
const EM = 16

/** A length or ratio in px (ratios as a number); NaN when it is not one this file reads. */
function valueOf(v: string): number {
  const t = v.trim().toLowerCase()
  const ratio = /^([\d.]+)\s*\/\s*([\d.]+)$/.exec(t)
  if (ratio) return Number(ratio[1]) / Number(ratio[2])
  const m = /^(-?[\d.]+)(px|em|rem)?$/.exec(t)
  if (!m) return NaN
  const n = Number(m[1])
  return m[2] === 'em' || m[2] === 'rem' ? n * EM : n
}

/** Splits s at depth 0 on sep (a regex matching the separator, anchored to where it is tried). */
function splitTop(s: string, sep: RegExp): string[] {
  const out: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (depth === 0) {
      sep.lastIndex = i
      const m = sep.exec(s)
      if (m && m.index === i) {
        out.push(s.slice(from, i))
        from = i + m[0].length
        i = from - 1
      }
    }
  }
  out.push(s.slice(from))
  return out
}

type Size = { w: number; h: number }

function compare(a: number, op: string, b: number): boolean {
  switch (op) {
    case '<':
      return a < b
    case '<=':
      return a <= b
    case '>':
      return a > b
    case '>=':
      return a >= b
    default:
      return a === b
  }
}
const flip: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '=' }

/** The size a feature name asks about, or undefined when it is not a size feature. */
function sizeOf(name: string, z: Size): number | undefined {
  const n = name.trim().toLowerCase().replace(/^-webkit-/, '')
  if (n === 'width' || n === 'device-width') return z.w
  if (n === 'height' || n === 'device-height') return z.h
  if (n === 'aspect-ratio' || n === 'device-aspect-ratio') return z.w / z.h
  return undefined
}

/** One feature in parentheses (without them): true/false, or null when this file cannot read it. */
function feature(f: string, z: Size, mm: MatchMedia): boolean | null {
  const t = f.trim()
  if (!SIZE.test(t)) return mm(`(${t})`)
  const colon = /^([a-z-]+)\s*:\s*(.+)$/i.exec(t)
  if (colon) {
    const name = colon[1].toLowerCase()
    if (name === 'orientation') return colon[2].trim().toLowerCase() === (z.h >= z.w ? 'portrait' : 'landscape')
    const bound = /^(min|max)-(.+)$/.exec(name)
    const size = sizeOf(bound ? bound[2] : name, z)
    const v = valueOf(colon[2])
    if (size === undefined || Number.isNaN(v)) return null
    return bound ? (bound[1] === 'min' ? size >= v : size <= v) : size === v
  }
  if (/^[a-z-]+$/i.test(t)) return sizeOf(t, z) === undefined ? null : true
  // Range syntax: `width >= 600px`, `600px <= width`, `400px < width <= 900px`.
  const parts = t.split(/\s*(<=|>=|<|>|=)\s*/)
  if (parts.length === 3) {
    const [a, op, b] = parts
    const sa = sizeOf(a, z)
    const sb = sizeOf(b, z)
    if (sa !== undefined && !Number.isNaN(valueOf(b))) return compare(sa, op, valueOf(b))
    if (sb !== undefined && !Number.isNaN(valueOf(a))) return compare(sb, flip[op], valueOf(a))
    return null
  }
  if (parts.length === 5) {
    const [a, op1, name, op2, b] = parts
    const s = sizeOf(name, z)
    const va = valueOf(a)
    const vb = valueOf(b)
    if (s === undefined || Number.isNaN(va) || Number.isNaN(vb)) return null
    return compare(va, op1, s) && compare(s, op2, vb)
  }
  return null
}

/** A condition: features in parentheses joined by and / or, each maybe after not. */
function condition(c: string, z: Size, mm: MatchMedia): boolean | null {
  const t = c.trim()
  if (/^not\s/i.test(t)) {
    const r = condition(t.slice(4), z, mm)
    return r === null ? null : !r
  }
  const ors = splitTop(t, /\s+or\s+/iy)
  if (ors.length > 1) {
    const rs = ors.map((o) => condition(o, z, mm))
    return rs.includes(null) ? null : rs.some(Boolean)
  }
  const ands = splitTop(t, /\s+and\s+/iy)
  if (ands.length > 1) {
    const rs = ands.map((a) => condition(a, z, mm))
    return rs.includes(null) ? null : rs.every(Boolean)
  }
  const m = /^\((.*)\)$/s.exec(t)
  if (!m) return null
  const inner = m[1]
  return /^\s*(\(|not\s)/i.test(inner) || splitTop(inner, /\s+(and|or)\s+/iy).length > 1 ? condition(inner, z, mm) : feature(inner, z, mm)
}

/** One media query: `[not|only] [type] [and condition]` or a bare condition. */
function query(q: string, z: Size, mm: MatchMedia): boolean | null {
  let t = q.trim()
  if (!t) return null
  if (t.startsWith('(') || /^not\s*\(/i.test(t)) return condition(t, z, mm)
  let not = false
  const lead = /^(not|only)\s+/i.exec(t)
  if (lead) {
    not = lead[1].toLowerCase() === 'not'
    t = t.slice(lead[0].length)
  }
  const type = /^([a-z-]+)\s*/i.exec(t)
  if (!type) return null
  const name = type[1].toLowerCase()
  const typeOk = name === 'all' || name === 'screen' ? true : name === 'print' || name === 'speech' ? false : null
  if (typeOk === null) return null
  const rest = t.slice(type[0].length)
  let r: boolean | null = typeOk
  if (rest) {
    const and = /^and\s+/i.exec(rest)
    if (!and) return null
    const c = condition(rest.slice(and[0].length), z, mm)
    r = c === null ? null : typeOk && c
  }
  return r === null ? null : not ? !r : r
}

/** A media list against a page laid out w × h: true/false, or null when it is not read here (left to the browser). */
export function evalMedia(text: string, w: number, h: number, mm: MatchMedia): boolean | null {
  if (!SIZE.test(text)) return null
  const rs = splitTop(text, /\s*,\s*/y).map((q) => query(q, { w, h }, mm))
  if (rs.some((r) => r === true)) return true
  return rs.includes(null) ? null : false
}

const ORIGINAL = new WeakMap<MediaList, string>()

function fit(ml: MediaList | undefined, w: number, h: number, mm: MatchMedia) {
  if (!ml) return
  const was = ORIGINAL.get(ml) ?? ml.mediaText
  if (!ORIGINAL.has(ml)) ORIGINAL.set(ml, was)
  const r = was ? evalMedia(was, w, h, mm) : null
  const now = r === null ? was : r ? 'all' : 'not all'
  if (ml.mediaText !== now) ml.mediaText = now
}

function walk(list: CSSRuleList | undefined, w: number, h: number, mm: MatchMedia) {
  if (!list) return
  for (const r of Array.from(list)) {
    if (typeof CSSMediaRule !== 'undefined' && r instanceof CSSMediaRule) fit(r.media, w, h, mm)
    if ('cssRules' in r) walk((r as CSSGroupingRule).cssRules, w, h, mm)
  }
}

/**
 * Every @media rule and <style media> of the snapshot in this shadow root answered for a page w × h px. Called again
 * when the width changes and after more of the page is put in (its own <style>s come with it): each list keeps what
 * the page wrote, so going back and forth is exact.
 */
export function fitMedia(root: ShadowRoot, w: number, h: number, mm: MatchMedia = (q) => matchMedia(q).matches) {
  if (!(w > 0) || !(h > 0)) return
  for (const sheet of Array.from(root.styleSheets)) {
    fit(sheet.media, w, h, mm)
    let rules: CSSRuleList | undefined
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    walk(rules, w, h, mm)
  }
}
