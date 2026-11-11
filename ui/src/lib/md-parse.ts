// How Claude's answers are read as Markdown, with no React and no DOM: the web page (lib/markdown.tsx) and
// the Mac's local screen (agent/localui/md.js, made from this file by scripts/local-md.mjs) draw the same
// blocks and inline pieces, so a message looks alike in both (REQ-F-899). Nothing here is ever HTML.

export type Block =
  | { t: 'p'; text: string }
  | { t: 'h'; level: number; text: string }
  | { t: 'code'; lang: string; code: string; closed: boolean }
  | { t: 'quote'; text: string }
  | { t: 'list'; ordered: boolean; start: number; items: { text: string; depth: number; check?: boolean }[] }
  | { t: 'table'; head: string[]; rows: string[][]; align: ('left' | 'right' | 'center' | undefined)[] }
  | { t: 'hr' }

/** One inline piece: plain text, a link, or markup holding more pieces. */
export type Inline =
  | { t: 'text'; text: string }
  | { t: 'link'; text: string; href: string }
  | { t: 'code'; text: string }
  | { t: 'strong' | 'del' | 'em'; kids: Inline[] }

const URL_RE = /https?:\/\/[\x21-\x5f\x61-\x7e]+/g

function linkify(text: string): Inline[] {
  const out: Inline[] = []
  let at = 0
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0]
    // Closing punctuation belongs to the sentence, not to the address.
    while (/[.,)\]'"]$/.test(url)) url = url.slice(0, -1)
    if (!url) continue
    const i = m.index ?? 0
    if (i > at) out.push({ t: 'text', text: text.slice(at, i) })
    out.push({ t: 'link', text: url, href: url })
    at = i + url.length
  }
  if (at < text.length) out.push({ t: 'text', text: text.slice(at) })
  return out
}

/** Inline markup: `code`, **bold**, *italic* / _italic_, ~~strike~~, [label](url), bare links. */
export function inlineParts(text: string): Inline[] {
  const out: Inline[] = []
  const re = /(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1(?!`)|\*\*([^*\n]+?)\*\*|~~([^~\n]+?)~~|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(^|[\s(])[*_]([^*_\n]+?)[*_](?=[\s).,!?:;]|$)/g
  let at = 0
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    const lead = m[7] ?? ''
    if (i + lead.length > at) out.push(...linkify(text.slice(at, i + lead.length)))
    if (m[2] !== undefined) out.push({ t: 'code', text: m[2] })
    else if (m[3] !== undefined) out.push({ t: 'strong', kids: inlineParts(m[3]) })
    else if (m[4] !== undefined) out.push({ t: 'del', kids: inlineParts(m[4]) })
    else if (m[5] !== undefined) out.push({ t: 'link', text: m[5], href: m[6] })
    else if (m[8] !== undefined) out.push({ t: 'em', kids: inlineParts(m[8]) })
    at = i + m[0].length
  }
  if (at < text.length) out.push(...linkify(text.slice(at)))
  return out
}

/** A fenced block that reads as a diff: its + and - lines are coloured. */
export const isDiff = (code: string, lang?: string) => lang === 'diff' || (!lang && /^(@@|\+\+\+|---) /m.test(code) && /^[+-]/m.test(code))

/** The class a diff line gets, or undefined. */
export const diffLine = (l: string) => (l.startsWith('+') && !l.startsWith('+++') ? 'd-add' : l.startsWith('-') && !l.startsWith('---') ? 'd-del' : l.startsWith('@@') ? 'd-hunk' : undefined)

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'))

export function parse(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', text: para.join('\n') })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Fences: the closing fence must be at least as long as the opening one (a ```` block may hold ``` lines).
    const fence = /^(\s{0,3})(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line)
    if (fence) {
      flush()
      const mark = fence[2]
      const body: string[] = []
      let j = i + 1
      for (; j < lines.length; j++) {
        const close = new RegExp(`^\\s{0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}\\s*$`).exec(lines[j])
        if (close) break
        body.push(lines[j].startsWith(fence[1]) ? lines[j].slice(fence[1].length) : lines[j])
      }
      // Not closed yet: an answer still being written, or a fence Claude never closed.
      blocks.push({ t: 'code', lang: fence[3], code: body.join('\n'), closed: j < lines.length })
      i = j
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) {
      flush()
      blocks.push({ t: 'h', level: h[1].length, text: h[2] })
      continue
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      blocks.push({ t: 'hr' })
      continue
    }
    if (/^\s*>/.test(line)) {
      flush()
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      i--
      blocks.push({ t: 'quote', text: body.join('\n') })
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush()
      const head = cells(line)
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : undefined))
      const rows: string[][] = []
      i += 2
      while (i < lines.length && /^\s*\|.*\|?\s*$/.test(lines[i]) && lines[i].trim()) rows.push(cells(lines[i++]))
      i--
      blocks.push({ t: 'table', head, rows, align })
      continue
    }
    const li = /^(\s*)([-*+]|(\d+)[.)])\s+(.*)$/.exec(line)
    if (li) {
      flush()
      const ordered = !!li[3]
      const items: { text: string; depth: number; check?: boolean }[] = []
      const start = ordered ? Number(li[3]) : 1
      for (; i < lines.length; i++) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
        if (m) {
          const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3])
          items.push({ text: task ? task[2] : m[3], depth: Math.min(4, Math.floor(m[1].replace(/\t/g, '  ').length / 2)), ...(task ? { check: task[1] !== ' ' } : {}) })
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) items[items.length - 1].text += `\n${lines[i].trim()}`
        else break
      }
      i--
      blocks.push({ t: 'list', ordered, start, items })
      continue
    }
    para.push(line)
  }
  flush()
  return blocks
}
