// Claude's answers as React elements: headings, lists, quotes, tables, fenced code, inline code, bold,
// italics, links. No HTML from a message is ever interpreted; everything is text until a rule makes it markup.
import { createContext, Fragment, memo, type ReactNode, useContext, useState, useSyncExternalStore } from 'react'
import { Icon } from '../kit/icons'
import { actionsVersion, dispatch, setDefault, watchActions } from './actions'
import { copyText, linkClick } from './builtin-actions'

import { diffLine, type Inline, inlineParts, isDiff, parse } from './md-parse'

function draw(parts: Inline[], key: string): ReactNode[] {
  return parts.map((p, n) => {
    const k = `${key}-${n}`
    switch (p.t) {
      case 'text':
        return p.text
      case 'link':
        return (
          <a key={k} href={p.href} target="_blank" rel="noopener noreferrer" onClick={linkClick(p.href, 'markdown')}>
            {p.text}
          </a>
        )
      case 'code':
        return <code key={k}>{p.text}</code>
      case 'strong':
        return <strong key={k}>{draw(p.kids, k)}</strong>
      case 'del':
        return <del key={k}>{draw(p.kids, k)}</del>
      case 'em':
        return <em key={k}>{draw(p.kids, k)}</em>
    }
  })
}

/** Inline markup: `code`, **bold**, *italic* / _italic_, ~~strike~~, [label](url), bare links (parsed in md-parse). */
export function inline(text: string, key = 'i'): ReactNode[] {
  return draw(inlineParts(text), key)
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false)
  const diff = isDiff(code, lang)
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
                <span key={i} className={diffLine(l)}>
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

function lines(text: string, key: string) {
  const parts = text.split('\n')
  return parts.map((l, i) => (
    <Fragment key={`${key}${i}`}>
      {inline(l, `${key}${i}`)}
      {i < parts.length - 1 ? <br /> : null}
    </Fragment>
  ))
}

// renderer.block (REQ-F-822): a fenced block goes through the bus, so a handler around it can draw it its own way.
// The page's own ```html preview is one such handler (components/html-preview).
setDefault('renderer.block', ({ lang, text }) => <CodeBlock code={text} lang={lang} />)

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
