// The in-app browser of a touch device (REQ-F-879): a link opens in a sheet over the page, with 브라우저로 열기 for
// a real tab. A computer opens links in a new tab right away (lib/builtin-actions, link.open).
// A page is shown in reading mode: the server fetches it (GET /api/read, REQ-S-100) and hands back its title, text
// and pictures as data, drawn here as this page's own elements. Nothing of the page's HTML or scripts runs here.
// 스냅샷 (REQ-F-881) is the page the session's Mac rendered, read here by lib/reader-dom.
// http://localhost:<port> is a Mac's own app, made of scripts: when the session on screen started that server, it
// shows through the site's preview origin in a frame (the same address 로컬 서버 열기 uses, REQ-F-727).
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { errorText, get, post } from '../lib/api'
import { openLink } from '../lib/builtin-actions'
import { imageUrl, localPort, modeFor, modeOf, readerImg, throughPreview } from '../lib/in-app'
import { readSnapshot } from '../lib/reader-dom'

/** What the session's Mac rendered (IF-278): the DOM, its final address, its pictures as data: by address. */
type Snap = { url: string; html: string; images?: Record<string, string>; via?: string }
import { matchRoute } from '../lib/router'
import { Button } from '../kit'
import { Sheet } from '../kit/overlay'

// ---------- the one sheet of this window ----------
let current: { url: string; key: number } | null = null
let seq = 0
const subs = new Set<() => void>()
const set = (v: typeof current) => ((current = v), subs.forEach((f) => f()))
let mounted = false

function close(fromBack = false) {
  if (!current) return
  const key = current.key
  set(null)
  if (!fromBack && history.state?.linkSheet === key) history.back()
}

/** Opens a link in the sheet (link.open's default on a touch device). */
export function openInApp(url: string) {
  if (!mounted) {
    mounted = true
    const host = document.createElement('div')
    document.body.appendChild(host)
    createRoot(host).render(<LinkSheet />)
    // The phone's back gesture closes the sheet, as it does every other sheet.
    addEventListener('popstate', () => current && history.state?.linkSheet !== current.key && close(true))
  }
  const key = ++seq
  if (current) history.replaceState({ ...history.state, linkSheet: key }, '')
  else history.pushState({ ...history.state, linkSheet: key }, '')
  set({ url, key })
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

type Page = { ok: true; url: string; title: string; site?: string; blocks: Block[]; snapshot?: boolean }

async function load(url: string): Promise<View> {
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
    if (fromRule) return snapshotView(sid, abs)
    // A snapshot by default (no rule) goes back to the old way when the Mac cannot take it.
    try {
      return await snapshotView(sid, abs)
    } catch (e) {
      const why = errorText(e)
      if (local) return previewView(url, sid)
      const v = await readView(abs)
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

async function snapshotView(sid: string, abs: string): Promise<View> {
  {
    // POST, signed by this device for a Mac that does not trust the server (lib/trust intentsFor).
    const p = await post<Snap & { sealed?: string }>(`/api/sessions/${sid}/snapshot`, { url: abs })
    let s: Snap | null = p
    // A sealing Mac's answer is one piece (opened by api.ts): it must be a snapshot of this session.
    if (p.sealed !== undefined) {
      s = null
      try {
        const o = JSON.parse(p.sealed) as Snap & { kind?: string; sid?: string }
        if (o.kind === 'snapshot' && o.sid === sid) s = o
      } catch {}
      if (!s) throw new Error('이 기기에서는 풀 수 없는 스냅샷이에요')
    }
    if (typeof s.html !== 'string' || typeof s.url !== 'string') throw new Error('맥에서 페이지를 그리지 못했어요')
    const images = s.images && typeof s.images === 'object' ? s.images : {}
    const sealed = p.sealed !== undefined
    // Pictures the Mac read come as data:; the rest only when the server already saw the page (not sealed).
    const pg = readSnapshot(s.html, s.url, (u) => (typeof images[u] === 'string' && /^data:image\//.test(images[u]) ? images[u] : sealed ? null : readerImg(u)))
    return { kind: 'read', url: s.url, title: pg.title, site: pg.site, blocks: pg.blocks, snapshot: true }
  }
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
  const [view, setView] = useState<View | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!cur) return
    setView(null)
    setError(null)
    let gone = false
    load(cur.url).then(
      (v) => !gone && setView(v),
      (e) => !gone && setError(errorText(e)),
    )
    return () => {
      gone = true
    }
  }, [cur, n])
  let title = ''
  try {
    title = cur ? new URL(cur.url, location.href).host : ''
  } catch {}
  // 브라우저로 열기 opens what the person pressed; a localhost address would not open on the phone itself, so its
  // preview address goes instead.
  const outside = view?.kind === 'frame' ? view.src : cur?.url
  return (
    <Sheet
      open={!!cur}
      onClose={() => close()}
      wide
      className="preview-sheet link-sheet"
      title={title}
      footer={
        <div className="hstack">
          <Button size="sm" icon="refresh" disabled={!view && !error} onClick={() => setN((k) => k + 1)}>
            다시 불러오기
          </Button>
          <span className="grow" />
          <Button size="sm" tone="primary" icon="link" disabled={!outside} onClick={() => outside && openLink(outside, 'inapp')}>
            브라우저로 열기
          </Button>
        </div>
      }
    >
      {error ? (
        <div className="preview-msg">{error}</div>
      ) : !view ? (
        <div className="preview-msg">{cur && modeFor(cur.url, location.href, undefined, !!sessionHere()) === 'snapshot' ? '세션의 맥에서 페이지를 그리는 중… 길면 1분 걸려요' : '여는 중…'}</div>
      ) : view.kind === 'frame' ? (
        <iframe key={n} className="preview-frame" src={view.src} title={title} allow="clipboard-write; fullscreen" />
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
