// The in-app browser of a touch device (REQ-F-879): a link opens in a sheet over the page, with 브라우저로 열기 for
// a real tab. A computer opens links in a new tab right away (lib/builtin-actions, link.open).
// A page is shown in reading mode: the server fetches it (GET /api/read, REQ-S-100) and hands back its title, text
// and pictures as data, drawn here as this page's own elements. Nothing of the page's HTML or scripts runs here.
// 스냅샷 (REQ-F-881) is the page the session's Mac rendered, read here by lib/reader-dom.
// http://localhost:<port> is a Mac's own app, made of scripts: when the session on screen started that server, it
// shows through the site's preview origin in a frame (the same address 로컬 서버 열기 uses, REQ-F-727).
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { errorText, get, post } from '../lib/api'
import { openLink } from '../lib/builtin-actions'
import { imageUrl, localPort, modeFor, modeOf, readerImg, throughPreview } from '../lib/in-app'
import { readSnapshot } from '../lib/reader-dom'
import { mountSnapshot, snapshotAnchor, snapshotMore, snapshotPage, type SnapshotDoc } from '../lib/snapshot-page'
import { snapshotStream, type SnapDraw } from '../lib/snap-stream'
import { getStore } from '../lib/store'
import { noteSnapshot, type SnapNote } from '../lib/debug'

/**
 * What the session's Mac rendered (IF-278): the DOM, its final address, its pictures as data: by address, its style
 * sheets as text by address and the page's width (1.488).
 */
type Snap = { url: string; html: string; images?: Record<string, string>; big?: Record<string, unknown>; css?: Record<string, string>; width?: number; via?: string }
import { matchRoute } from '../lib/router'
import { LOCKED, loadTrust, pairedWith } from '../lib/trust'
import { Button, IconButton } from '../kit'
import { Sheet } from '../kit/overlay'

// ---------- the one sheet of this window ----------
/**
 * The sheet's own history (1.526, REQ-F-906): every page it went to by a snapshot's link, with what it showed and where
 * it was scrolled to. Going back shows what is kept here without asking the Mac again; only the last VIEWS_KEPT
 * around the one shown keep their drawing (the address stays: it is drawn again, quickly from the Mac's disk).
 * The phone's back gesture goes back here first (history.state.linkStep), and closes the sheet from the first page.
 */
type Entry = { url: string; view: View | null; status: string; scroll: number }
type Cur = { key: number; stack: Entry[]; at: number }
const VIEWS_KEPT = 4
let current: Cur | null = null
let seq = 0
const subs = new Set<() => void>()
const set = (v: Cur | null) => ((current = v), subs.forEach((f) => f()))
let mounted = false

/**
 * A link that may be a trap (1.527, sneakyLink: not seen, or covering half the screen) is asked about first: the
 * sheet says where it goes, and only the same link clicked again within ASK_MS goes there.
 */
type Ask = { href: string; at: number }
let asking: Ask | null = null
const ASK_MS = 15_000
const setAsk = (v: Ask | null) => ((asking = v), subs.forEach((f) => f()))

/** A snapshot's link clicked: to the sheet's next page, or (sneaky) asked about first. */
function goLink(href: string, sneaky: boolean) {
  if (sneaky && !(asking && asking.href === href && Date.now() - asking.at < ASK_MS)) return setAsk({ href, at: Date.now() })
  goTo(href)
}

function close(fromBack = false) {
  if (!current) return
  const { key, at } = current
  asking = null
  set(null)
  if (!fromBack && history.state?.linkSheet === key) history.go(-(at + 1))
}

/** Opens a link in the sheet (link.open's default on a touch device). */
export function openInApp(url: string) {
  if (!mounted) {
    mounted = true
    const host = document.createElement('div')
    document.body.appendChild(host)
    createRoot(host).render(<LinkSheet />)
    // The phone's back gesture: a page back in the sheet, or closing it from its first page, as every other sheet.
    addEventListener('popstate', () => {
      const c = current
      if (!c) return
      const st = history.state
      if (st?.linkSheet !== c.key) return close(true)
      const at = typeof st.linkStep === 'number' ? st.linkStep : 0
      if (at !== c.at && at >= 0 && at < c.stack.length) set({ ...c, at })
    })
  }
  const key = ++seq
  const entry: Entry = { url, view: null, status: '', scroll: 0 }
  if (current) history.replaceState({ ...history.state, linkSheet: key, linkStep: 0 }, '')
  else history.pushState({ ...history.state, linkSheet: key, linkStep: 0 }, '')
  set({ key, stack: [entry], at: 0 })
}

/** A snapshot's link, in the sheet (1.526): a new page after the one shown (the ones ahead of it are gone). */
function goTo(url: string) {
  const c = current
  if (!c) return
  asking = null
  const stack = [...c.stack.slice(0, c.at + 1), { url, view: null, status: '', scroll: 0 }]
  const at = stack.length - 1
  // Only the drawings near the one shown stay in memory.
  stack.forEach((e, i) => at - i > VIEWS_KEPT && (e.view = null))
  history.pushState({ ...history.state, linkSheet: c.key, linkStep: at }, '')
  set({ key: c.key, stack, at })
}

/** How long ago a kept drawing was made, as the sheet says it. */
function ago(at: number) {
  const m = Math.round((Date.now() - at) / 60_000)
  if (!(at > 0) || m < 1) return '방금'
  if (m < 60) return `${m}분 전`
  if (m < 60 * 24) return `${Math.round(m / 60)}시간 전`
  return `${Math.round(m / 1440)}일 전`
}

interface Block {
  t: 'h1' | 'h2' | 'h3' | 'p' | 'li' | 'pre' | 'quote' | 'img'
  text?: string
  src?: string
}
type View =
  | { kind: 'frame'; src: string }
  | { kind: 'image'; src: string }
  | { kind: 'read'; url: string; title: string; site: string; blocks: Block[]; snapshot?: boolean; note?: string }
  // 스냅샷 as the page looked (1.488): the page made safe for a shadow root (1.523), and the same page in reading mode.
  | { kind: 'page'; url: string; doc: SnapshotDoc; width: number; note: SnapNote; read: { kind: 'read'; url: string; title: string; site: string; blocks: Block[]; snapshot?: boolean; note?: string } }

type Page = { ok: true; url: string; title: string; site?: string; blocks: Block[]; snapshot?: boolean }

/** A drawing (or a step of one) to show now, with a line about it (저장된 화면 · n분 전, 새로 받지 못했어요). */
type Show = (v: View, status: string) => void

async function load(url: string, show: Show, signal: AbortSignal): Promise<View> {
  // 링크 열기 규칙 (REQ-F-881): the host's rule; with none, a snapshot on a session's page (1.470), elsewhere
  // localhost through the preview and the rest to read.
  const sid = sessionHere()
  const { mode, fromRule } = modeOf(url, !!sid, location.href)
  const local = localPort(url, location.href) != null
  if (mode === 'preview') return previewView(url, sid)
  const img = imageUrl(url, location.href)
  if (img && !(mode === 'snapshot' && local)) return { kind: 'image', src: img }
  const abs = new URL(url, location.href).href
  if (mode === 'snapshot') {
    // Drawn by the session's Mac: only from a session's page.
    if (!sid) throw new Error('스냅샷은 세션 화면에서만 열 수 있어요. 그 세션의 맥이 페이지를 그려요')
    if (fromRule) return snapshotView(sid, abs, show, signal)
    // A paired Mac's address never goes to the server plain (REQ-S-110): no reading by the server in its place.
    const hostId = getStore().state?.sessions.find((x) => x.id === sid)?.hostId
    if (hostId && (await loadTrust().then(() => pairedWith(hostId), () => false))) return snapshotView(sid, abs, show, signal)
    // A snapshot by default (no rule) goes back to the old way when the Mac cannot take it.
    try {
      return await snapshotView(sid, abs, show, signal)
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e
      const why = errorText(e)
      if (local) return previewView(url, sid)
      // Both reasons when reading fails too (1.483): a site that turns away the server (403) would hide the snapshot's.
      const v = await readView(abs).catch((r) => {
        throw new Error(`스냅샷을 만들지 못했어요 (${why}). 읽기로도 못 열었어요 (${errorText(r)})`)
      })
      return v.kind === 'read' ? { ...v, note: `스냅샷을 만들지 못해 읽기로 열었어요 (${why})` } : v
    }
  }
  return readView(abs)
}

const sessionHere = () => {
  const r = matchRoute(location.pathname + location.search)
  return r?.name === 'session' ? r.id : null
}

async function previewView(url: string, sid: string | null): Promise<View> {
  if (!sid) throw new Error('폰에서는 맥의 localhost 를 바로 열 수 없어요. 그 서버를 띄운 세션에서 눌러 주세요')
  const p = await post<{ ok: true; url: string }>(`/api/sessions/${sid}/preview`, { port: localPort(url, location.href) })
  return { kind: 'frame', src: throughPreview(p.url, url) }
}

async function readView(abs: string): Promise<View> {
  const p = await get<Page>(`/api/read?u=${encodeURIComponent(abs)}`)
  return { kind: 'read', url: p.url, title: p.title, site: p.site ?? '', blocks: p.blocks }
}

/** The view of one drawing (as the Mac sent it, whole or the start of it). */
function pageView(s: Snap, sealed: boolean): Extract<View, { kind: 'page' }> {
  if (typeof s.html !== 'string' || typeof s.url !== 'string') throw new Error('맥에서 페이지를 그리지 못했어요')
  const images = s.images && typeof s.images === 'object' ? s.images : {}
  // Pictures the Mac read come as data:; the rest only when the server already saw the page (not sealed).
  const pg = readSnapshot(s.html, s.url, (u) => (typeof images[u] === 'string' && /^data:image\//.test(images[u]) ? images[u] : sealed ? null : readerImg(u)))
  const read = { kind: 'read' as const, url: s.url, title: pg.title, site: pg.site, blocks: pg.blocks, snapshot: true }
  const css = s.css && typeof s.css === 'object' ? s.css : {}
  const width = typeof s.width === 'number' && s.width > 0 && s.width <= 10000 ? s.width : 0
  const big = s.big && typeof s.big === 'object' ? s.big : {}
  const doc = snapshotPage({ url: s.url, html: s.html, images, css, big })
  let site = ''
  try {
    site = new URL(s.url).host
  } catch {}
  const note = noteSnapshot({ site, bytes: doc.bytes, width, via: typeof s.via === 'string' ? s.via.slice(0, 20) : null, sealed, images: Object.keys(images).length, css: Object.keys(css).length })
  return { kind: 'page', url: s.url, doc, width, note, read }
}

/**
 * A snapshot (1.526): asked for in pieces (lib/snap-stream). The drawing the Mac kept shows first (저장된 화면 ·
 * n분 전), then the one drawn now takes its place; the first drawing shows as soon as its first piece is in. When
 * drawing anew fails after a kept one showed, the kept one stays (새로 받지 못했어요). A server or Mac before 1.526
 * answers whole, read as before.
 */
async function snapshotView(sid: string, abs: string, show: Show, signal: AbortSignal): Promise<View> {
  const hostId = getStore().state?.sessions.find((x) => x.id === sid)?.hostId ?? null
  let shown: { view: View; gen: number; complete: boolean; at: number } | null = null
  const onDraw = (d: SnapDraw) => {
    // The one drawn now replaces a whole kept one only when it is whole too (no half page over a whole one).
    if (shown && shown.gen === 0 && shown.complete && d.gen === 1 && !d.complete) return
    const view = pageView(d, d.sealed)
    shown = { view, gen: d.gen, complete: d.complete, at: d.at }
    show(view, d.gen === 0 ? `저장된 화면 · ${ago(d.at)}${d.complete ? ' · 새로 받는 중…' : ''}` : '')
  }
  let end: Awaited<ReturnType<typeof snapshotStream>>
  try {
    end = await snapshotStream(sid, hostId, abs, onDraw, signal)
  } catch (e) {
    // Drawing anew failed (a broken piece, the server gone) after the kept one showed whole: that one stays.
    const kept = shown as { view: View; gen: number; complete: boolean; at: number } | null
    if ((e as Error).name === 'AbortError' || !kept || kept.gen !== 0 || !kept.complete) throw e
    end = { kind: 'stream', fresh: false, error: errorText(e) }
  }
  if (end.kind === 'whole') {
    // A paired Mac seals its snapshot always (1.526): a plain whole answer is the server's own.
    if (end.paired && end.answer.sealed === undefined) throw new Error('이 맥의 스냅샷인데 봉인되지 않은 답이 왔어요. 서버가 바꾼 답일 수 있어 보이지 않아요')
    return wholeView(end.answer as Snap & { sealed?: unknown }, sid)
  }
  const last = shown as { view: View; gen: number; complete: boolean; at: number } | null
  if (end.fresh && last) return last.view
  if (last && last.gen === 0 && last.complete) {
    show(last.view, `저장된 화면 · ${ago(last.at)} · 새로 받지 못했어요 (${end.error ?? ''})`)
    return last.view
  }
  throw new Error(end.error ?? '맥에서 페이지를 그리지 못했어요')
}

/** A snapshot answered whole (a server or Mac before 1.526): one sealed piece opened by api.ts, or the page plain. */
function wholeView(p: Snap & { sealed?: unknown }, sid: string): View {
  let s: Snap | null = p
  // A sealing Mac's answer is one piece (opened by api.ts): it must be a snapshot of this session.
  if (p.sealed !== undefined) {
    s = null
    // Which step failed (1.486): the key, the contents, or whose snapshot it is.
    let why = ''
    const t = String(p.sealed)
    if (t === LOCKED || t.startsWith('⟦bt')) why = '이 기기에 그 맥의 열쇠가 없거나 잠금을 풀지 못했어요'
    else {
      try {
        const o = JSON.parse(t) as Snap & { kind?: string; sid?: string }
        if (o.kind !== 'snapshot') why = `스냅샷이 아닌 답이에요 (${String(o.kind).slice(0, 20)})`
        else if (o.sid !== sid) why = `다른 세션의 스냅샷이에요 (${String(o.sid).slice(0, 8)} ≠ ${sid.slice(0, 8)})`
        else s = o
      } catch {
        why = `풀었지만 내용이 깨졌어요 (${t.length.toLocaleString()}자, 끝: ${JSON.stringify(t.slice(-12))})`
      }
    }
    if (!s) throw new Error(`이 기기에서는 풀 수 없는 스냅샷이에요: ${why}`)
  }
  return pageView(s, p.sealed !== undefined)
}

/**
 * The page as the Mac drew it (1.488), in a shadow root of this sheet (1.523, before it a sandboxed frame that iOS
 * Safari left white): laid out at the page's own width and scaled to the sheet, as a phone's browser shows a wide page.
 * The sheet scrolls; the page's own box is as tall as its content times the scale. What runs, loads or acts was taken
 * out by lib/snapshot-page; the box keeps the page's fixed and stacked elements inside it (contain, isolation).
 */
function PageFrame({ v, title, onPlain, entry }: { v: Extract<View, { kind: 'page' }>; title: string; onPlain: () => void; entry: Entry }) {
  const box = useRef<HTMLDivElement>(null)
  const page = useRef<HTMLDivElement>(null)
  const fit = useRef<HTMLDivElement>(null)
  // While the page is taken out and put in again, the box's scrolling is not the person's (1.526).
  const restoring = useRef(false)
  // The page's scale in the box, for the effect that adds pieces as the box is scrolled (1.525).
  const scale = useRef(1)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [height, setHeight] = useState(0)
  // Whether the page went into its shadow root (1.523): an error there is said over the box instead of a white sheet.
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const shown = size.w > 0
  useEffect(() => {
    const host = page.current
    if (!shown || !host) return
    const started = performance.now()
    const el = box.current
    // The page's height in the box now (not when React next draws): scrolling to a place needs the room there.
    const sizeFit = () => {
      setHeight(host.offsetHeight)
      if (fit.current) fit.current.style.height = `${Math.ceil(host.offsetHeight * scale.current)}px`
    }
    // A link of the snapshot (1.526): another page in this sheet, or a place in this one.
    const onLink = (href: string, kind: 'nav' | 'frag', sneaky: boolean) => {
      if (kind === 'nav') return goLink(href, sneaky)
      if (!el) return
      let hash = ''
      try {
        hash = new URL(href).hash
      } catch {}
      const to = snapshotAnchor(host, v.doc, hash)
      if (to === 'top') el.scrollTop = 0
      else if (to) {
        sizeFit()
        el.scrollTop += to.getBoundingClientRect().top - el.getBoundingClientRect().top
      }
    }
    try {
      mountSnapshot(host, v.doc, undefined, onLink)
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)).slice(0, 200)
      v.note.frame = 'failed'
      v.note.error = why
      setFailed(why)
      return
    }
    v.note.frame = 'drawn'
    v.note.error = null
    v.note.ms = Math.round(performance.now() - started)
    setFailed(null)
    const ro = new ResizeObserver(() => setHeight(host.offsetHeight))
    ro.observe(host)
    // The rest of a big page (1.525), a piece at a time, while the box's end is within three of its heights. The
    // host's own height (read now, not the state) says where the page ends.
    const fill = () => {
      if (!el) return
      let added = false
      for (let n = 0; n < 20 && el.scrollTop + el.clientHeight * 3 >= host.offsetHeight * scale.current; n++) {
        if (!snapshotMore(host)) break
        added = true
      }
      if (added) sizeFit()
    }
    // Back where the person was on this page (1.526): going back to it, or its new drawing over the kept one. The
    // pieces down to there go in first.
    const target = entry.scroll
    if (el && target > 0) {
      for (let n = 0; n < 500 && host.offsetHeight * scale.current < target + el.clientHeight; n++) if (!snapshotMore(host)) break
      sizeFit()
      el.scrollTop = target
    }
    restoring.current = false
    fill()
    // The room for the page at once (1.526): the observer's first word came a few hundred ms late on a page drawn over
    // another, and until then the box could not be scrolled.
    sizeFit()
    const keep = () => {
      if (el && !restoring.current) entry.scroll = el.scrollTop
    }
    el?.addEventListener('scroll', fill, { passive: true })
    el?.addEventListener('scroll', keep, { passive: true })
    return () => {
      restoring.current = true
      ro.disconnect()
      el?.removeEventListener('scroll', fill)
      el?.removeEventListener('scroll', keep)
      host.shadowRoot?.replaceChildren()
    }
  }, [shown, v, entry])
  const pw = Math.max(v.width, size.w)
  const k = size.w && pw ? size.w / pw : 1
  scale.current = k
  return (
    <div ref={box} className="snapshot-box">
      {shown ? (
        <div ref={fit} className="snapshot-fit" style={{ height: Math.ceil(height * k) }}>
          {/* The box is the wrapper, not the shadow host: page CSS can style its host (:host{…!important} and an
              @scope with no start, whose :scope is the host, win; snapshot-page drops both where the browser parses the
              sheet) but never the wrapper, so whatever the host becomes stays inside it. */}
          <div className="snapshot-page" style={{ width: pw, transform: `scale(${k})`, '--cb-vh': `${Math.round(size.h / k)}px` } as CSSProperties}>
            <div ref={page} className="snapshot-host" role="document" aria-label={title} />
          </div>
        </div>
      ) : null}
      {failed !== null ? (
        <div className="snapshot-late" role="alert">
          <p>
            원본 모양을 그리지 못했어요 ({(v.doc.bytes / 1048576).toFixed(1)} MB, 폭 {pw}px, {failed}). 읽기 모양으로 보거나 브라우저로 열어 주세요
          </p>
          <Button size="sm" onClick={onPlain}>
            읽기 모양으로 보기
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function Reading({ v }: { v: Extract<View, { kind: 'read' }> }) {
  let host = ''
  try {
    host = new URL(v.url).host
  } catch {}
  return (
    <article className="reader">
      <div className="reader-site">
        {v.snapshot ? '스냅샷 · ' : ''}
        {v.site || host}
      </div>
      {v.note ? <p className="reader-empty">{v.note}</p> : null}
      {v.title ? <h1 className="reader-title">{v.title}</h1> : null}
      {v.blocks.length ? null : (
        <p className="reader-empty">
          {v.snapshot
            ? '맥에서 그린 페이지에서도 읽을 본문을 찾지 못했어요. 브라우저로 열어 주세요'
            : '읽을 본문을 찾지 못했어요. 스크립트로 그리는 페이지일 수 있어요. 설정 → 이 기기 → 링크 열기에서 이 사이트를 스냅샷으로 두거나 브라우저로 열어 주세요'}
        </p>
      )}
      {v.blocks.map((b, i) => {
        // The page's own first heading usually repeats its title.
        if (b.t === 'h1' && b.text === v.title) return null
        switch (b.t) {
          case 'h1':
          case 'h2':
            return <h2 key={i}>{b.text}</h2>
          case 'h3':
            return <h3 key={i}>{b.text}</h3>
          case 'li':
            return (
              <p key={i} className="reader-li">
                {b.text}
              </p>
            )
          case 'pre':
            return <pre key={i}>{b.text}</pre>
          case 'quote':
            return <blockquote key={i}>{b.text}</blockquote>
          case 'img':
            return b.src ? <img key={i} src={readerImg(b.src)} alt={b.text ?? ''} loading="lazy" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = 'none')} /> : null
          default:
            return <p key={i}>{b.text}</p>
        }
      })}
    </article>
  )
}

function LinkSheet() {
  const cur = useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => current,
  )
  const entry = cur ? cur.stack[cur.at] : null
  const ask = useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => asking,
  )
  let askHost = ''
  try {
    askHost = ask ? new URL(ask.href).host : ''
  } catch {}
  const [view, setView] = useState<View | null>(null)
  // A line over the page (1.526): 저장된 화면 · n분 전, 새로 받지 못했어요.
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [n, setN] = useState(0)
  // 읽기 모양: a snapshot shown in reading mode instead of as the page looked (1.488).
  const [plain, setPlain] = useState(false)
  useEffect(() => {
    if (!entry) return
    setPlain(false)
    setError(null)
    // Back to a page the sheet still holds: shown as it was, the Mac not asked again.
    if (entry.view) {
      setView(entry.view)
      setStatus(entry.status)
      return
    }
    setView(null)
    setStatus('')
    let gone = false
    const ctl = new AbortController()
    const show: Show = (v, st) => {
      if (gone) return
      entry.view = v
      entry.status = st
      setView(v)
      setStatus(st)
    }
    load(entry.url, show, ctl.signal).then(
      (v) => {
        if (gone || entry.view === v) return
        entry.view = v
        entry.status = ''
        setView(v)
        setStatus('')
      },
      (e) => {
        if (gone || (e as Error).name === 'AbortError') return
        entry.view = null
        setError(errorText(e))
      },
    )
    return () => {
      gone = true
      ctl.abort()
      // Left before the new drawing came: the kept one stays, without saying it is still coming.
      entry.status = entry.status.replace(' · 새로 받는 중…', '')
    }
  }, [cur, entry, n])
  let title = ''
  try {
    title = entry ? new URL(entry.url, location.href).host : ''
  } catch {}
  // 브라우저로 열기 opens what the person pressed; a localhost address would not open on the phone itself, so its
  // preview address goes instead.
  const outside = view?.kind === 'frame' ? view.src : entry?.url
  // 뒤로·앞으로 (1.526): through the window's history, so the phone's back gesture and these agree.
  const head =
    cur && cur.stack.length > 1 ? (
      <span className="link-nav">
        <IconButton icon="back" label="뒤로" disabled={cur.at === 0} onClick={() => history.back()} />
        <IconButton icon="forward" label="앞으로" disabled={cur.at >= cur.stack.length - 1} onClick={() => history.forward()} />
        <span className="link-nav-host">{title}</span>
      </span>
    ) : (
      title
    )
  return (
    <Sheet
      open={!!cur}
      onClose={() => close()}
      wide
      className="preview-sheet link-sheet"
      title={head}
      footer={
        <div className="hstack">
          <Button
            size="sm"
            icon="refresh"
            disabled={!view && !error}
            onClick={() => {
              if (entry) entry.view = null
              setN((k) => k + 1)
            }}
          >
            다시 불러오기
          </Button>
          {view?.kind === 'page' ? (
            <Button size="sm" onClick={() => setPlain((p) => !p)}>
              {plain ? '원본 모양' : '읽기 모양'}
            </Button>
          ) : null}
          <span className="grow" />
          <Button size="sm" tone="primary" icon="link" disabled={!outside} onClick={() => outside && openLink(outside, 'inapp')}>
            브라우저로 열기
          </Button>
        </div>
      }
    >
      {ask && !error && view ? (
        <div className="snapshot-status link-ask" role="alert" data-t="link-ask">
          이 링크는 보이지 않거나 화면을 덮고 있어요. <b>{askHost}</b> 로 가려면 같은 곳을 한 번 더 눌러 주세요
          <button type="button" className="link-ask-no" onClick={() => setAsk(null)}>
            취소
          </button>
        </div>
      ) : null}
      {status && !error && view ? (
        <div className="snapshot-status" role="status">
          {status}
        </div>
      ) : null}
      {error ? (
        <div className="preview-msg">{error}</div>
      ) : !view || !entry ? (
        <div className="preview-msg">{entry && modeFor(entry.url, location.href, undefined, !!sessionHere()) === 'snapshot' ? '세션의 맥에서 페이지를 그리는 중… 길면 1분 걸려요' : '여는 중…'}</div>
      ) : view.kind === 'frame' ? (
        <iframe key={n} className="preview-frame" src={view.src} title={title} allow="clipboard-write; fullscreen" />
      ) : view.kind === 'page' ? (
        plain ? (
          <Reading v={view.read} />
        ) : (
          <PageFrame key={n} v={view} title={title} onPlain={() => setPlain(true)} entry={entry} />
        )
      ) : view.kind === 'image' ? (
        <div className="reader-image">
          <img src={view.src} alt="" referrerPolicy="no-referrer" />
        </div>
      ) : (
        <Reading v={view} />
      )}
    </Sheet>
  )
}
