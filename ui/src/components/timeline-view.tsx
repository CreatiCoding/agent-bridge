// The conversation, drawn from the folded log. Tool calls in a row become one compact block; each can be
// opened to see what it ran and what came back.
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { clock, duration, oneLine, shortLabel } from '../lib/format'
import { Markdown, MarkdownContext } from '../lib/markdown'
import type { Item } from '../lib/timeline'
import type { Session } from '../lib/types'
import { Badge, Button, Collapse, Icon, IconButton, Spinner } from '../kit'
import { openMenu, toast } from '../kit/overlay'
import { DecisionCard } from './decision-card'
import { HtmlPreview, isHtmlDocument } from './html-preview'
import { act, command, sessionPost } from './session-menu'
import { TodoAskCard, todoAskOf } from './session-extras'
import { ToolDetail } from './tool-detail'
import { toolFace } from '../lib/tool-view'
import { copyText, openSession } from '../lib/builtin-actions'
import { errorText, get } from '../lib/api'
import { actionsVersion, watchActions } from '../lib/actions'
import { messageShown, quietFor } from '../lib/quiet'

export function ImageViewer({ src, onClose }: { src: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(1)
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [onClose])
  return createPortal(
    <div className="viewer" onClick={(e) => e.target === e.currentTarget && onClose()} onWheel={(e) => setZoom((z) => Math.min(5, Math.max(1, z - e.deltaY / 400)))}>
      <img src={src} alt="" style={{ transform: `scale(${zoom})` }} onDoubleClick={() => setZoom((z) => (z > 1 ? 1 : 2.5))} />
      <IconButton icon="close" label="닫기" onClick={onClose} />
    </div>,
    document.body,
  )
}

const img = (id: string) => `/api/img/${id}`

function Thumbs({ ids, onOpen }: { ids: string[]; onOpen: (src: string) => void }) {
  if (!ids.length) return null
  return (
    <div className="thumbs">
      {ids.map((id) => (
        <img key={id} className="thumb" src={img(id)} alt="첨부한 그림" loading="lazy" onClick={() => onOpen(img(id))} />
      ))}
    </div>
  )
}

// A picture on the Mac that an answer names by its path (a screenshot it took): `/…/a.png`, `~/…/a.jpg`.
const LOCAL_IMG_RE = /(?:^|[\s`'"(<\[:=*])((?:~|\/)[^\s`'"()<>\[\]*]*\.(?:png|jpe?g|gif|webp))(?=$|[\s`'")>\],.;:!?*])/gi
export const localImages = (text: string) => [...new Set([...text.matchAll(LOCAL_IMG_RE)].map((m) => m[1]).filter((p) => p !== '/' && !p.startsWith('//')))].slice(0, 12)

/** The pictures an answer names, fetched from its Mac. One that cannot be read (gone, not a picture) is not drawn. */
function LocalThumbs({ session, paths, onOpen }: { session: Session; paths: string[]; onOpen: (src: string) => void }) {
  const [gone, setGone] = useState<string[]>([])
  const shown = paths.filter((p) => !gone.includes(p))
  if (!shown.length) return null
  const src = (p: string) => `/api/sessions/${session.id}/localimg?path=${encodeURIComponent(p)}`
  return (
    <div className="thumbs">
      {shown.map((p) => (
        <img key={p} className="thumb" src={src(p)} alt={p.split('/').pop()} title={p} loading="lazy" onClick={() => onOpen(src(p))} onError={() => setGone((g) => [...g, p])} />
      ))}
    </div>
  )
}

const UserMsg = memo(UserMsgView, (a, b) => a.it === b.it && a.session.id === b.session.id)
function UserMsgView({ it, session, onImage, onEdit }: { it: Extract<Item, { t: 'user' }>; session: Session; onImage: (s: string) => void; onEdit: (text: string) => void }) {
  const [open, setOpen] = useState(it.text.length < 1200)
  const held = it.marks.includes('hourglass_flowing_sand')
  const dropped = it.marks.includes('x')
  const ask = it.command ? null : todoAskOf(it.text)
  const menu = (at: HTMLElement | { x: number; y: number }) =>
    openMenu(
      [
        { label: '복사', icon: 'copy', onSelect: () => copyText(it.text, 'message').then((ok) => ok && toast('복사했어요')) },
        { label: '다시 쓰기', icon: 'edit', hint: '입력칸으로', onSelect: () => onEdit(it.text) },
        ...(held
          ? [
              { label: '지금 보내기', icon: 'send' as const, onSelect: () => act(() => sessionPost(session, 'sendnow'), '지금 보내요') },
              {
                label: '보내지 않고 되돌리기',
                icon: 'undo' as const,
                onSelect: () => act(() => sessionPost<{ ok: true; ids: string[] }>(session, 'dropheld', { id: it.id })).then((r) => (r?.ids.includes(it.id) ? (onEdit(it.text), toast('입력칸으로 되돌렸어요')) : toast('이미 전달됐어요'))),
              },
            ]
          : []),
        ...(!dropped && !it.command && !held ? ['sep' as const, { label: '잘못 보냄', icon: 'undo' as const, danger: true, hint: '멈추고 따르지 말라고 알려요', onSelect: () => act(() => sessionPost(session, 'retract', { ts: it.id })) }] : []),
      ],
      at,
    )
  return (
    <div className="msg-user" onContextMenu={(e) => (e.preventDefault(), menu({ x: e.clientX, y: e.clientY }))}>
      <Thumbs ids={it.images} onOpen={onImage} />
      {ask ? (
        <TodoAskCard ask={ask} className={dropped ? 'retracted' : ''} />
      ) : it.text ? (
        <div className={`bubble${it.command ? ' cmd' : ''}${dropped ? ' retracted' : ''}${!open ? ' folded' : ''}`} onClick={() => !open && setOpen(true)}>
          {it.text}
        </div>
      ) : null}
      <div className="user-meta">
        {held ? <Badge tone="amber">대기 중 · 도구가 끝나면 전달</Badge> : null}
        {dropped ? <Badge tone="red">취소됨</Badge> : null}
        {it.via === 'slack' ? <span>Slack</span> : null}
        {it.via === 'delegate' ? <Badge tone="violet">맡긴 세션이 보냄</Badge> : null}
        {it.via === 'delegated' ? <Badge tone="violet">맡긴 세션의 답</Badge> : null}
        <span>{clock(it.at)}</span>
        <button type="button" className="icon-btn" style={{ width: 24, height: 24 }} aria-label="메시지 메뉴" onClick={(e) => menu(e.currentTarget)}>
          <Icon name="more" />
        </button>
      </div>
    </div>
  )
}

function ToolRow({ it, onImage }: { it: Tool; onImage: (s: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="tool">
      <button type="button" className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`tool-state${it.done ? (it.error ? ' err' : ' ok') : ''}`}>{it.done ? <Icon name={it.error ? 'close' : 'check'} /> : <Spinner size={11} />}</span>
        <span className="tool-name">{it.name}</span>
        {it.auto ? <AutoMark /> : null}
        <span className="tool-label">{labelOf(it)}</span>
        <Icon name="forward" className={`chev${open ? ' chev-open' : ''}`} />
      </button>
      <Collapse open={open}>
        <div className="tool-body">
          {it.auto ? (
            <span className="tool-auto-note">
              <Icon name="shield" /> 전부 허용으로 자동 허용됨 · {it.auto}
            </span>
          ) : null}
          <ToolDetail it={it} />
          {it.images?.length ? <Thumbs ids={it.images} onOpen={onImage} /> : null}
        </div>
      </Collapse>
    </div>
  )
}

const Note = memo(NoteView, (a, b) => a.it === b.it && a.session.id === b.session.id && a.session.closed === b.session.closed && a.session.seat?.where === b.session.seat?.where)
function NoteView({ it, session }: { it: Extract<Item, { t: 'note' }>; session: Session }) {
  const [used, setUsed] = useState(false)
  if (it.tone === 'local')
    return (
      <div className="note">
        <Icon name="terminal" />
        <pre className={it.error ? 'err' : undefined}>{it.text}</pre>
      </div>
    )
  return (
    <div className={`note note-${it.tone}`}>
      {it.tone === 'end' ? null : <Icon name={it.tone === 'warn' ? 'warn' : 'info'} />}
      <div className="grow msg-text">
        <Markdown text={it.text.replace(/(^|[^*\w])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?!\*)/g, '$1**$2**')} />
        {it.actions && !used && !session.closed && session.seat?.where !== 'slack' ? (
          <div className="choices">
            {it.actions.map((a) => (
              <Button key={a.label} size="sm" tone={a.primary ? 'primary' : 'plain'} onClick={() => (setUsed(true), void act(() => command(session, a.cmd, a.arg)))}>
                {a.label}
              </Button>
            ))}
          </div>
        ) : null}
        {it.open ? (
          <div className="choices">
            <Button size="sm" icon="forward" onClick={() => void openSession(it.open!.sid, 'notice')}>
              {it.open.label}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

const TextMsg = memo(TextMsgView, (a, b) => a.it === b.it && a.last === b.last && a.session.closed === b.session.closed && a.session.seat?.where === b.session.seat?.where)
type TextProps = { it: Extract<Item, { t: 'text' }>; session: Session; last: boolean; onSend: (text: string) => void; onImage: (s: string) => void }

/**
 * One of Claude's answers through message.render (REQ-F-850): an extension may fold or change it, the page keeps it
 * reachable. A fold is one line that opens; changed words say who changed them and offer the answer's own.
 */
function TextMsgView(p: TextProps) {
  const { it, session, last } = p
  useSyncExternalStore(watchActions, actionsVersion)
  const quiet = quietFor(it.quiet, it.text)
  const shown = messageShown({ sid: session.id, seq: it.seq, text: it.text, quiet, isLast: last })
  const [open, setOpen] = useState(false)
  const [own, setOwn] = useState(false)
  if (shown.folded && !open)
    return (
      <div className="msg-folded" data-quiet={quiet?.ext ?? 'hook'}>
        <span className="msg-folded-mark" aria-hidden>
          🤫
        </span>
        <span className="grow">
          조용히 접은 답{shown.reason ? ` · ${shown.reason}` : ''}
          {shown.by.length ? <span className="muted"> · {shown.by.join(', ')}</span> : null}
        </span>
        <Button size="sm" tone="ghost" onClick={() => setOpen(true)}>
          펼치기
        </Button>
      </div>
    )
  const text = own ? it.text : shown.text
  return (
    <>
      <TextBody {...p} text={text} choices={!shown.folded} />
      {shown.folded || shown.changed ? (
        <div className="msg-changed muted">
          {shown.folded ? `조용히 접은 답${shown.by.length ? ` · ${shown.by.join(', ')}` : ''}` : `${shown.by.join(', ') || '익스텐션'} 이 바꿈`}
          {shown.changed ? (
            <Button size="sm" tone="ghost" onClick={() => setOwn(!own)}>
              {own ? '바꾼 글 보기' : '원문 보기'}
            </Button>
          ) : null}
          {shown.folded ? (
            <Button size="sm" tone="ghost" onClick={() => setOpen(false)}>
              접기
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

function TextBody({ it, session, last, onSend, onImage, text, choices }: TextProps & { text: string; choices: boolean }) {
  const html = isHtmlDocument(text)
  const where = useMemo(() => ({ sid: session.id, isLast: last }), [session.id, last])
  return (
    <div className="msg-text">
      {html ? (
        <HtmlPreview html={text} />
      ) : (
        <MarkdownContext.Provider value={where}>
          <Markdown text={text} />
        </MarkdownContext.Provider>
      )}
      {html ? null : <LocalThumbs session={session} paths={localImages(text)} onOpen={onImage} />}
      {choices && it.choices?.length && last && !session.closed && session.seat?.where !== 'slack' ? (
        <div className="choices">
          {it.choices.map((c) => (
            <Choice key={c} text={c} onSend={onSend} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * One of a reply's choices (REQ-F-709). Not a <button>: Chrome never starts a text selection inside one, and a drag
 * there ends as a click that sends the choice. A drag that leaves text selected on it copies, it does not send.
 */
function Choice({ text, onSend }: { text: string; onSend: (text: string) => void }) {
  const send = (el: HTMLElement) => {
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed && sel.containsNode(el, true)) return
    onSend(text)
  }
  return (
    <span
      role="button"
      tabIndex={0}
      className="btn btn-plain btn-sm choice"
      onClick={(e) => send(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        onSend(text)
      }}
    >
      {text}
    </span>
  )
}

/** A tool row; `auto` is what 전부 허용 answered for it (the dialog's question), folded in instead of a line of its own. */
type Tool = Extract<Item, { t: 'tool' }> & { auto?: string }
type Allow = Extract<Item, { t: 'card' }>
/**
 * Tool rows that follow each other are drawn as one block. Automatic allows with no call of their own to mark (a
 * subagent's or a background call: the main conversation never shows the call) that follow each other are one
 * line too.
 */
type Block = { t: 'tools'; key: string; items: Tool[] } | { t: 'allows'; key: string; items: Allow[] } | { t: 'attach'; key: string; file: Attached } | Item

/** A file the session attached with the bridge MCP's attach (REQ-F-846), named on the first line of the tool's answer. */
export type Attached = { id: string; name: string; type: string; size: number }
const ATTACH_HEAD = '[bridge-attach] '
export function attachedOf(it: { name: string; done: boolean; error?: boolean; output?: string }): Attached | null {
  if (it.name !== 'bridge__attach' || !it.done || it.error || !it.output?.startsWith(ATTACH_HEAD)) return null
  try {
    const a = JSON.parse(it.output.slice(ATTACH_HEAD.length).split('\n')[0])
    if (!/^[0-9a-f]{40}$/.test(a?.id) || typeof a.name !== 'string' || typeof a.type !== 'string' || !Number.isFinite(a.size)) return null
    return { id: a.id, name: a.name.slice(0, 120), type: a.type, size: a.size }
  } catch {
    return null
  }
}
const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const AUTO_PICTURE_MAX = 1024 * 1024
const sizeText = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/**
 * The attached file, fetched from its Mac only when it is wanted (a small picture at once). The bytes become a Blob
 * here: a picture is shown, anything else is only saved, never opened as a page.
 */
function AttachCard({ session, file, onImage }: { session: Session; file: Attached; onImage: (s: string) => void }) {
  const picture = PICTURE_TYPES.includes(file.type)
  const [url, setUrl] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const loading = useRef<Promise<string | null> | null>(null)
  const load = () =>
    (loading.current ??= (async () => {
      setBusy(true)
      try {
        const r = await get<{ id?: string; data?: string; sealed?: string }>(`/api/sessions/${session.id}/attachment?id=${file.id}`)
        let data = r.id === file.id ? r.data : undefined
        // A sealing Mac's answer is one piece (opened by api.ts): it must be this attachment of this session.
        if (r.sealed !== undefined) {
          let o: { kind?: string; id?: string; sid?: string; data?: unknown } | null = null
          try {
            o = JSON.parse(r.sealed)
          } catch {}
          data = o?.kind === 'attach' && o.id === file.id && o.sid === session.id && typeof o.data === 'string' ? o.data : undefined
        }
        if (!data || !/^[A-Za-z0-9+/]+=*$/.test(data)) throw new Error('이 기기에서는 풀 수 없는 첨부예요')
        const bin = atob(data)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const u = URL.createObjectURL(new Blob([bytes], { type: picture ? file.type : 'application/octet-stream' }))
        setUrl(u)
        return u
      } catch (e) {
        setErr(errorText(e))
        loading.current = null
        return null
      } finally {
        setBusy(false)
      }
    })())
  useEffect(() => {
    if (picture && file.size <= AUTO_PICTURE_MAX) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url])
  const save = async () => {
    const u = url ?? (await load())
    if (!u) return
    const a = document.createElement('a')
    a.href = u
    a.download = file.name
    a.click()
  }
  return (
    <div className="att-file">
      {picture && url ? <img className="thumb att-file-pic" src={url} alt={file.name} onClick={() => onImage(url)} /> : null}
      <div className="att-file-row">
        <Icon name={picture ? 'image' : 'doc'} />
        <span className="att-file-name" title={file.name}>
          {file.name}
        </span>
        <span className="att-file-size">{sizeText(file.size)}</span>
        {picture && !url ? (
          <Button size="sm" tone="ghost" icon="eye" disabled={busy} onClick={() => void load()}>
            보기
          </Button>
        ) : null}
        <Button size="sm" tone="ghost" icon="arrowDown" disabled={busy} onClick={() => void save()}>
          받기
        </Button>
      </div>
      {err ? <span className="att-file-err">{err}</span> : null}
    </div>
  )
}

/**
 * A tool's one-line label, short (REQ-F-703 규칙 3). The server cuts a long label (110 characters) before the page
 * can shorten its paths, which left "scratch/perf/compare-br…": when it was cut, the label is made again from the
 * call's own input (its file, or its command's first line), then shortened.
 */
function labelOf(t: Tool) {
  // A sealed label too long to come whole arrives as 🔒… (server sealedShort): the opened input still tells.
  if ((t.label.endsWith('…') || t.label.startsWith('🔒')) && t.input) {
    try {
      const i = JSON.parse(t.input) as Record<string, unknown>
      const first = Object.values(i).find((v): v is string => typeof v === 'string' && !!v.trim() && !v.startsWith('🔒'))
      const whole = typeof i.file_path === 'string' ? i.file_path : typeof i.command === 'string' ? i.command.split('\n')[0] : first ? oneLine(first.split('\n').find((l) => l.trim()) ?? '', 110) : ''
      if (whole) return shortLabel(whole)
    } catch {}
  }
  // A sealed label comes whole and opened (REQ-S-099): its words can be many lines, so its first line, shortened.
  return shortLabel(oneLine(t.label.split('\n')[0], 110))
}

/** The small shield beside a tool's name: 전부 허용 answered its permission request. */
function AutoMark() {
  return (
    <span className="tool-auto" title="전부 허용으로 자동 허용됨" aria-label="자동 허용됨">
      <Icon name="shield" />
    </span>
  )
}
/** Inside a block, two or more calls of the same tool in a row fold to one line (REQ-F-599). */
type Run = { t: 'run'; key: string; items: Tool[] } | { t: 'one'; key: string; item: Tool }
const RUN_MIN = 2

function runs(items: Tool[]): Run[] {
  const out: Run[] = []
  let i = 0
  while (i < items.length) {
    let j = i + 1
    while (j < items.length && items[j].name === items[i].name) j++
    if (j - i >= RUN_MIN) out.push({ t: 'run', key: `r${items[i].key}`, items: items.slice(i, j) })
    else for (const it of items.slice(i, j)) out.push({ t: 'one', key: it.key, item: it })
    i = j
  }
  return out
}

/** Several calls of one tool in a row: one line that says how many and what the latest did; opens to the rows. */
function ToolRun({ items, onImage }: { items: Tool[]; onImage: (s: string) => void }) {
  const [open, setOpen] = useState(false)
  const running = items.some((it) => !it.done)
  const failed = items.some((it) => it.done && it.error)
  const last = items[items.length - 1]
  return (
    <div className={`tool tool-run${open ? ' open' : ''}`}>
      <button type="button" className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`tool-state${running ? '' : failed ? ' err' : ' ok'}`}>{running ? <Spinner size={11} /> : <Icon name={failed ? 'close' : 'check'} />}</span>
        <span className="tool-name">{last.name}</span>
        <span className="tool-count">×{items.length}</span>
        {items.some((it) => it.auto) ? <AutoMark /> : null}
        <span className="tool-label">{labelOf(last)}</span>
        <Icon name="forward" className={`chev${open ? ' chev-open' : ''}`} />
      </button>
      <Collapse open={open}>
        <div className="tool-run-body">
          {items.map((it) => (
            <ToolRow key={it.key} it={it} onImage={onImage} />
          ))}
        </div>
      </Collapse>
    </div>
  )
}

/**
 * Which tool each automatic allow (전부 허용) answered (REQ-F-703 규칙 1). Calls made in parallel do not alternate
 * with their allows: the allows can come in a burst before the calls are written, or after them. So within one
 * stretch of work (up to the next thing said, by the person or by Claude) an allow takes the nearest unmarked
 * call of its tool before it, else the first one after it. Returns tool index → the dialog's question, and the
 * allows that found their call.
 */
function matchAllows(items: Item[]) {
  const auto = new Map<number, string>()
  const used = new Set<number>()
  const said = (it: Item) => it.t === 'text' || it.t === 'user'
  const fits = (j: number, name?: string) => {
    const t = items[j]
    return t.t === 'tool' && !auto.has(j) && (!name || name === t.name)
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.t !== 'card' || !it.card.auto) continue
    const name = it.card.tool?.name
    let hit = -1
    for (let j = i - 1; j >= 0 && !said(items[j]); j--) if (fits(j, name)) (hit = j), (j = -1)
    if (hit < 0) for (let j = i + 1; j < items.length && !said(items[j]); j++) if (fits(j, name)) (hit = j), (j = items.length)
    if (hit < 0) continue
    auto.set(hit, it.card.title || '확인 창')
    used.add(i)
  }
  return { auto, used }
}

/**
 * Tool rows in a row become one block. An automatic allow that found its call is not a line of its own: it marks
 * that call (a shield), so the rows around it stay one block and runs of one tool stay together.
 */
function blocks(items: Item[]): Block[] {
  const out: Block[] = []
  const { auto, used } = matchAllows(items)
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (used.has(i)) continue
    const prev = out.at(-1)
    if (it.t === 'tool') {
      // Codex's exec program is drawn as what it does (REQ-F-862).
      const f = toolFace(it)
      const t: Tool = auto.has(i) ? { ...f, auto: auto.get(i) } : f
      if (prev?.t === 'tools') prev.items.push(t)
      else out.push({ t: 'tools', key: `g${it.key}`, items: [t] })
      // An attached file is shown where it was attached, outside the tools (which fold away).
      const file = attachedOf(it)
      if (file) out.push({ t: 'attach', key: `f${it.key}`, file })
    } else if (it.t === 'card' && it.card.auto) {
      if (prev?.t === 'allows') prev.items.push(it)
      else out.push({ t: 'allows', key: `a${it.key}`, items: [it] })
    } else out.push(it)
  }
  return out
}

/** Automatic allows that marked no row: one quiet line — how many, of which tools — that opens to each of them. */
function Allows({ items }: { items: Allow[] }) {
  const [open, setOpen] = useState(false)
  const counts = new Map<string, number>()
  for (const a of items) counts.set(a.card.tool?.name ?? '확인 창', (counts.get(a.card.tool?.name ?? '확인 창') ?? 0) + 1)
  return (
    <div className="allows">
      <button type="button" className="note allows-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="shield" />
        <span className="grow">
          자동 허용{items.length > 1 ? ` ${items.length}개` : ''} · {[...counts].map(([n, c]) => (c > 1 ? `${n} ${c}` : n)).join(' · ')}
          {items.length === 1 && items[0].card.title ? <span className="muted"> {items[0].card.title}</span> : null}
        </span>
        {items.length > 1 ? <Icon name="forward" className={`chev${open ? ' chev-open' : ''}`} /> : null}
      </button>
      {items.length > 1 ? (
        <Collapse open={open}>
          <div className="tool-run-body">
            {items.map((a) => (
              <div key={a.key} className="note">
                <b>{a.card.tool?.name ?? '확인 창'}</b> <span className="muted">{a.card.title}</span>
              </div>
            ))}
          </div>
        </Collapse>
      ) : null}
    </div>
  )
}

/** At least this many rows (after runs) before a finished block folds to one line. */
const FOLD_MIN = 3
/** While a block is still going on, its latest rows that stay in view; the ones before fold to one line. */
const LIVE_KEEP = 3

const rowsOf = (rs: Run[], onImage: (s: string) => void) => rs.map((r) => (r.t === 'run' ? <ToolRun key={r.key} items={r.items} onImage={onImage} /> : <ToolRow key={r.key} it={r.item} onImage={onImage} />))

/** Tool calls folded to one line — how many, of which tools, failures, how long — that opens to their rows. */
function Folded({ items, rs, lead, onImage }: { items: Tool[]; rs: Run[]; lead: string; onImage: (s: string) => void }) {
  const [open, setOpen] = useState(false)
  const counts = new Map<string, number>()
  for (const t of items) counts.set(t.name, (counts.get(t.name) ?? 0) + 1)
  const top = [...counts].sort((a, b) => b[1] - a[1])
  const failed = items.filter((t) => t.error).length
  const took = items[items.length - 1].at - items[0].at
  return (
    <div className={`tools-folded${open ? ' open' : ''}`}>
      <button type="button" className="tool-head tools-sum" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`tool-state${failed ? ' err' : ' ok'}`}>
          <Icon name={failed ? 'close' : 'check'} />
        </span>
        <span className="tool-name">
          {lead} {items.length}개
        </span>
        <span className="tool-label tools-sum-what">
          {top.slice(0, 4).map(([n, c]) => `${n} ${c}`).join(' · ')}
          {top.length > 4 ? ` · 외 ${top.length - 4}` : ''}
          {failed ? ` · 실패 ${failed}` : ''}
          {took >= 60_000 ? ` · ${duration(took)}` : ''}
        </span>
        <Icon name="forward" className={`chev${open ? ' chev-open' : ''}`} />
      </button>
      <Collapse open={open}>
        <div className="tool-run-body">{rowsOf(rs, onImage)}</div>
      </Collapse>
    </div>
  )
}

/**
 * One block of tool calls (REQ-F-703). Once every call is done and the conversation has moved on (or the session
 * rests), it folds to one line. While it is the work going on, only its latest LIVE_KEEP rows stay in view and the
 * ones before fold to "앞의 도구 n개 …", so a long stretch of work does not fill the screen.
 */
// A block redraws only when one of its own calls changed (the fold keeps unchanged items as the same objects).
const ToolsBlock = memo(ToolsBlockView, (a, b) => a.live === b.live && a.items.length === b.items.length && a.items.every((t, i) => t === b.items[i] || (t.key === b.items[i].key && t.auto === b.items[i].auto && t.done === b.items[i].done && t.output === b.items[i].output)))
function ToolsBlockView({ items, live, onImage }: { items: Tool[]; live: boolean; onImage: (s: string) => void }) {
  const rs = runs(items)
  if (!live && items.every((t) => t.done) && rs.length >= FOLD_MIN)
    return (
      <div className="tools">
        <Folded items={items} rs={rs} lead="도구" onImage={onImage} />
      </div>
    )
  if (live && rs.length > LIVE_KEEP + 1) {
    const earlier = rs.slice(0, -LIVE_KEEP)
    const tools = earlier.flatMap((r) => (r.t === 'run' ? r.items : [r.item]))
    return (
      <div className="tools">
        <Folded items={tools} rs={earlier} lead="앞의 도구" onImage={onImage} />
        {rowsOf(rs.slice(-LIVE_KEEP), onImage)}
      </div>
    )
  }
  return <div className="tools">{rowsOf(rs, onImage)}</div>
}

export const TimelineView = memo(function TimelineView({ items, session, onSend: sendNow, onEdit: editNow }: { items: Item[]; session: Session; onSend: (text: string) => void; onEdit: (text: string) => void }) {
  const [viewer, setViewer] = useState<string | null>(null)
  // The page hands new callbacks on every render; the items get stable ones that call the latest, so a session
  // that is working (its state changes several times a second) does not redraw every message of the conversation.
  const latest = useRef({ sendNow, editNow })
  latest.current = { sendNow, editNow }
  const [onSend] = useState(() => (t: string) => latest.current.sendNow(t))
  const [onEdit] = useState(() => (t: string) => latest.current.editNow(t))
  const list = blocks(items)
  const lastText = [...items].reverse().find((i) => i.t === 'text' || i.t === 'user')
  // The block at the end of a session that is working is the work going on: it stays open.
  const working = ['busy', 'waiting', 'starting'].includes(session.state.phase)
  // Once something arrives after the conversation was drawn, the newest item slides in (not the ones at load).
  const seen = useRef(0)
  const [live, setLive] = useState(false)
  useEffect(() => {
    if (!live && seen.current > 0 && items.length > seen.current) setLive(true)
    seen.current = items.length
  }, [items.length, live])
  return (
    <div className="tl" data-live={live || undefined}>
      {list.map((b, i) => {
        switch (b.t) {
          case 'tools':
            return <ToolsBlock key={b.key} items={b.items} live={working && i === list.length - 1} onImage={setViewer} />
          case 'allows':
            return <Allows key={b.key} items={b.items} />
          case 'attach':
            return <AttachCard key={b.key} session={session} file={b.file} onImage={setViewer} />
          case 'user':
            return <UserMsg key={b.key} it={b} session={session} onImage={setViewer} onEdit={onEdit} />
          case 'text':
            return <TextMsg key={b.key} it={b} session={session} last={lastText?.key === b.key} onSend={onSend} onImage={setViewer} />
          case 'card':
            return <DecisionCard key={b.key} session={session} card={b.card} closed={b.closed || session.card?.id !== b.card.id} result={b.result} />
          case 'held':
            return b.n > 0 && session.state.held.length > 0 ? (
              <div key={b.key} className="held">
                <Icon name="clock" />
                <span className="grow">보낼 글 {session.state.held.length}개가 도구가 끝나기를 기다리고 있어요</span>
                <Button size="sm" icon="send" onClick={() => act(() => sessionPost(session, 'sendnow'), '지금 보내요')}>
                  지금 보내기
                </Button>
                <Button size="sm" tone="ghost" icon="undo" onClick={() => act(() => sessionPost<{ ok: true; ids: string[] }>(session, 'dropheld'), (r) => (r.ids.length ? `${r.ids.length}개를 되돌렸어요` : '이미 전달됐어요'))}>
                  되돌리기
                </Button>
              </div>
            ) : null
          case 'side':
            return (
              <div key={b.key} className="side-q">
                <div className="side-q-q">/btw {b.q}</div>
                {b.answer ? <Markdown text={b.answer} /> : b.error ? <span className="muted">{b.error}</span> : <span className="hstack muted"><Spinner size={12} /> 답을 기다리는 중</span>}
              </div>
            )
          case 'note':
            return <Note key={b.key} it={b} session={session} />
        }
      })}
      {viewer ? <ImageViewer src={viewer} onClose={() => setViewer(null)} /> : null}
    </div>
  )
})

/** What Claude is writing now, read off the terminal: shown faintly until the transcript has it. */
export function Writing({ text, sid }: { text: string; sid: string }) {
  const where = useMemo(() => ({ sid, isLast: true }), [sid])
  if (!text.trim()) return null
  return (
    <div className="msg-text writing">
      <MarkdownContext.Provider value={where}>
        <Markdown text={text} />
      </MarkdownContext.Provider>
    </div>
  )
}


