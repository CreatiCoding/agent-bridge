// An opened tool row (REQ-F-862): what the call did, shaped by its tool, then what came back. A command reads as a
// shell line with its words colored, an edit as a diff, an input object as indented JSON; the answer carries its exit
// code and time when it has them. Only text is drawn: nothing from a tool is ever interpreted as markup.
import { useState, type ReactNode } from 'react'
import { Icon } from '../kit'
import { copyText } from '../lib/builtin-actions'
import { jsonTokens, jsTokens, prettyJson, shellTokens, type Tok } from '../lib/tool-view'
import type { Item } from '../lib/timeline'

type Tool = Extract<Item, { t: 'tool' }>

const toks = (ts: Tok[]) => ts.map((t, i) => (t.k ? <span key={i} className={`tk-${t.k}`}>{t.t}</span> : t.t))

function diffLines(text: string) {
  return text.split('\n').map((l, i) => (
    <span key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'd-add' : l.startsWith('-') && !l.startsWith('---') ? 'd-del' : l.startsWith('@@') || l.startsWith('***') ? 'd-hunk' : undefined}>
      {l}
      {'\n'}
    </span>
  ))
}

/** A labeled box of code with a copy button. */
function Box({ cap, sub, copy, className, children }: { cap: string; sub?: string; copy: string; className?: string; children: ReactNode }) {
  const [done, setDone] = useState(false)
  return (
    <div className={`tool-box${className ? ` ${className}` : ''}`}>
      <div className="tool-box-head">
        <span className="tool-box-cap">{cap}</span>
        {sub ? <span className="tool-box-sub">{sub}</span> : null}
        <button type="button" className="tool-box-copy" aria-label="복사" onClick={() => void copyText(copy, 'code').then((ok) => ok && (setDone(true), setTimeout(() => setDone(false), 1200)))}>
          <Icon name={done ? 'check' : 'copy'} />
        </button>
      </div>
      <pre>
        <code>{children}</code>
      </pre>
    </div>
  )
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/** Old and new text of an Edit as one diff. */
const editDiff = (oldS: string, newS: string) => [...(oldS ? oldS.split('\n').map((l) => `-${l}`) : []), ...(newS ? newS.split('\n').map((l) => `+${l}`) : [])].join('\n')

function InputView({ it }: { it: Tool }) {
  let o: Record<string, unknown> = {}
  try {
    const v = it.input ? JSON.parse(it.input) : null
    if (v && typeof v === 'object' && !Array.isArray(v)) o = v
  } catch {}
  const name = it.name
  if (name === 'Bash') {
    const cmd = str(o.command) ?? it.detail ?? ''
    if (!cmd) return null
    const why = str(o.description)
    return (
      <>
        {why ? <div className="tool-why">{why}</div> : null}
        <Box cap="$ 셸" sub={str(o.workdir)} copy={cmd} className="tool-box-sh">
          {toks(shellTokens(cmd))}
        </Box>
      </>
    )
  }
  if (name === 'Edit' || name === 'MultiEdit') {
    const patch = str(o.patch) ?? (it.lang === 'diff' ? it.detail : undefined)
    const file = str(o.file_path) ?? ''
    if (patch) return <Box cap="패치" sub={file} copy={patch}>{diffLines(patch)}</Box>
    const edits = Array.isArray(o.edits) ? (o.edits as Record<string, unknown>[]) : [o]
    const text = edits
      .filter((e) => e && (typeof e.old_string === 'string' || typeof e.new_string === 'string'))
      .map((e) => editDiff(str(e.old_string) ?? '', str(e.new_string) ?? ''))
      .join('\n@@\n')
    if (text) return <Box cap={o.replace_all ? '바꾸기 · 전부' : '바꾸기'} sub={file} copy={text}>{diffLines(text)}</Box>
  }
  if (name === 'Write' && typeof o.content === 'string') return <Box cap="쓰기" sub={str(o.file_path)} copy={o.content}>{o.content}</Box>
  if (it.lang === 'js' && it.detail) return <Box cap="JS" copy={it.detail}>{toks(jsTokens(it.detail))}</Box>
  if (it.detail) return <pre>{it.detail}</pre>
  const pretty = prettyJson(it.input)
  if (pretty && pretty !== '{}') return <Box cap="입력" copy={pretty}>{toks(jsonTokens(pretty))}</Box>
  return it.input && it.input !== '{}' ? <pre>{it.input}</pre> : null
}

function OutputView({ it }: { it: Tool }) {
  const out = it.output ?? ''
  const meta = it.meta ? <span className={`tool-box-sub${it.error ? ' err' : ''}`}>{it.meta}</span> : null
  if (!out)
    return meta ? (
      <div className="tool-box-empty">
        결과 없음 {meta}
      </div>
    ) : null
  const pretty = prettyJson(out)
  return (
    <Box cap={it.error ? '결과 · 실패' : '결과'} sub={it.meta} copy={pretty ?? out} className={`tool-box-out${it.error ? ' err' : ''}`}>
      {pretty ? toks(jsonTokens(pretty)) : out}
    </Box>
  )
}

export function ToolDetail({ it }: { it: Tool }) {
  return (
    <>
      <InputView it={it} />
      {it.output || it.meta ? <OutputView it={it} /> : it.done ? null : <span className="muted" style={{ fontSize: 'var(--fs-small)' }}>도는 중…</span>}
    </>
  )
}
