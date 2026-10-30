// Claude's answers as React elements: headings, lists, quotes, tables, fenced code, inline code, bold,
// italics, links. No HTML from a message is ever interpreted; everything is text until a rule makes it markup.
import { createContext, Fragment, memo, type ReactNode, useContext, useState, useSyncExternalStore } from 'react'
import { Icon } from '../kit/icons'
import { actionsVersion, dispatch, setDefault, watchActions } from './actions'
import { copyText, linkClick } from './builtin-actions'

const URL_RE = /https?:\/\/[\x21-\x5f\x61-\x7e]+/g

function linkify(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let at = 0
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0]
    // Closing punctuation belongs to the sentence, not to the address.
    while (/[.,)\]'"]$/.test(url)) url = url.slice(0, -1)
    if (!url) continue
    const i = m.index ?? 0
    if (i > at) out.push(text.slice(at, i))
    out.push(
      <a key={`${key}l${i}`} href={url} target="_blank" rel="noopener noreferrer" onClick={linkClick(url, 'markdown')}>
        {url}
      </a>,
    )
    at = i + url.length
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}

/** Inline markup: `code`, **bold**, *italic* / _italic_, ~~strike~~, [label](url), bare links. */
export function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1(?!`)|\*\*([^*\n]+?)\*\*|~~([^~\n]+?)~~|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(^|[\s(])[*_]([^*_\n]+?)[*_](?=[\s).,!?:;]|$)/g
  let at = 0
  let n = 0
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    const lead = m[7] ?? ''
    if (i + lead.length > at) out.push(...linkify(text.slice(at, i + lead.length), `${key}${n}`))
    const k = `${key}-${n++}`
    if (m[2] !== undefined) out.push(<code key={k}>{m[2]}</code>)
    else if (m[3] !== undefined) out.push(<strong key={k}>{inline(m[3], k)}</strong>)
    else if (m[4] !== undefined) out.push(<del key={k}>{inline(m[4], k)}</del>)
    else if (m[5] !== undefined)
      out.push(
        <a key={k} href={m[6]} target="_blank" rel="noopener noreferrer" onClick={linkClick(m[6], 'markdown')}>
          {m[5]}
        </a>,
      )
    else if (m[8] !== undefined) out.push(<em key={k}>{inline(m[8], k)}</em>)
    at = i + m[0].length
  }
  if (at < text.length) out.push(...linkify(text.slice(at), `${key}e`))
  return out
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false)
  const diff = lang === 'diff' || (!lang && /^(@@|\+\+\+|---) /m.test(code) && /^[+-]/m.test(code))
  return (
    <div className="codebox">
      {lang ? <span className="codebox-lang">{lang}</span> : null}
      <button
        type="button"
        className="codebox-copy"
        aria-label="복사"
        onClick={() => {
          void copyText(code, 'code').then((ok) => ok && (setCopied(true), setTimeout(() => setCopied(false), 1200)))
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} />
        <span>{copied ? '복사됨' : '복사'}</span>
      </button>
      <pre>
        <code>
          {diff
            ? code.split('\n').map((l, i) => (
                <span key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'd-add' : l.startsWith('-') && !l.startsWith('---') ? 'd-del' : l.startsWith('@@') ? 'd-hunk' : undefined}>
                  {l}
                  {'\n'}
                </span>
              ))
            : code}
        </code>
      </pre>
    </div>
  )
}

type Block =
  | { t: 'p'; text: string }
  | { t: 'h'; level: number; text: string }
  | { t: 'code'; lang: string; code: string; closed: boolean }
  | { t: 'quote'; text: string }
  | { t: 'list'; ordered: boolean; start: number; items: { text: string; depth: number; check?: boolean }[] }
  | { t: 'table'; head: string[]; rows: string[][]; align: ('left' | 'right' | 'center' | undefined)[] }
  | { t: 'hr' }

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

function lines(text: string, key: string) {
  const parts = text.split('\n')
  return parts.map((l, i) => (
    <Fragment key={`${key}${i}`}>
      {inline(l, `${key}${i}`)}
      {i < parts.length - 1 ? <br /> : null}
    </Fragment>
  ))
}

/** How a ```html block is drawn; set by the page (components/html-preview), plain code until then. */
let htmlBlock: ((code: string) => ReactNode) | null = null
export const setHtmlBlock = (f: (code: string) => ReactNode) => void (htmlBlock = f)

// renderer.block (REQ-F-822): a fenced block goes through the bus, so a handler around it can draw it its own way.
setDefault('renderer.block', ({ lang, text }) => (lang === 'html' && htmlBlock ? htmlBlock(text) : <CodeBlock code={text} lang={lang} />))

/**
 * Where a piece of Markdown is drawn: the session it belongs to and whether it is that session's last message.
 * Outside a session (a card's plan, a quote) there is no sid.
 */
export const MarkdownContext = createContext<{ sid?: string; isLast?: boolean }>({})

function FencedBlock({ lang, code, closed }: { lang: string; code: string; closed: boolean }) {
  const { sid, isLast } = useContext(MarkdownContext)
  // Drawn again when a handler comes or goes.
  useSyncExternalStore(watchActions, actionsVersion)
  return <>{dispatch('renderer.block', { lang, text: code, closed, isLast: !!isLast, ...(sid ? { sid } : {}) }) as ReactNode}</>
}

/** Parsed and drawn again only when its text changes. */
export const Markdown = memo(MarkdownView)
function MarkdownView({ text, className }: { text: string; className?: string }) {
  const blocks = parse(text)
  return (
    <div className={`md${className ? ` ${className}` : ''}`}>
      {blocks.map((b, i) => {
        const k = `b${i}`
        switch (b.t) {
          case 'p':
            return <p key={k}>{lines(b.text, k)}</p>
          case 'h': {
            const H = `h${Math.min(6, b.level + 1)}` as 'h2'
            return <H key={k}>{inline(b.text, k)}</H>
          }
          case 'code':
            return <FencedBlock key={k} lang={b.lang} code={b.code} closed={b.closed} />
          case 'quote':
            return (
              <blockquote key={k}>
                <Markdown text={b.text} />
              </blockquote>
            )
          case 'hr':
            return <hr key={k} />
          case 'table':
            return (
              <div key={k} className="md-table">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j} style={{ textAlign: b.align[j] }}>
                          {inline(c, `${k}h${j}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri}>
                        {b.head.map((_, j) => (
                          <td key={j} style={{ textAlign: b.align[j] }}>
                            {inline(r[j] ?? '', `${k}r${ri}c${j}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case 'list': {
            const L = b.ordered ? 'ol' : 'ul'
            return (
              <L key={k} start={b.ordered && b.start !== 1 ? b.start : undefined}>
                {b.items.map((it, j) => (
                  <li key={j} style={it.depth ? { marginLeft: `${it.depth * 1.2}em` } : undefined} className={it.check !== undefined ? 'task' : undefined}>
                    {it.check !== undefined ? <span className={`task-box${it.check ? ' on' : ''}`} aria-hidden /> : null}
                    {lines(it.text, `${k}i${j}`)}
                  </li>
                ))}
              </L>
            )
          }
        }
      })}
    </div>
  )
}
