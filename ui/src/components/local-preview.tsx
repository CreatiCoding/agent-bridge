// The web servers a session started on its Mac (npm run dev …): a computer button in the header opens one.
// On that Mac itself, http://localhost:<port> in a new tab. Anywhere else, the same page inside this one, through the
// site's preview origin (server/preview.mjs) and the Mac's bridge tab.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { agentInfo } from '../../../web/relay.js'
import { errorText } from '../lib/api'
import type { Session } from '../lib/types'
import { Button, IconButton } from '../kit'
import { confirmDialog, openMenu, Sheet, toast, type MenuItem } from '../kit/overlay'
import { act, sessionPost } from './session-menu'

// ---------- is this browser on the session's Mac? ----------
// The agent on this Mac (if any) says which host it is; asked once per page.
let localHost: string | null | undefined
const subs = new Set<() => void>()
function askLocalHost() {
  if (localHost !== undefined) return
  localHost = null
  const a = agentInfo() as { port: number; key: string } | null
  if (!a) return
  fetch(`http://127.0.0.1:${a.port}/host?key=${encodeURIComponent(a.key)}`, { signal: AbortSignal.timeout(2500) })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { hostId?: string } | null) => {
      localHost = j?.hostId ?? null
      subs.forEach((f) => f())
    })
    .catch(() => {})
}
const useLocalHost = () => {
  useEffect(askLocalHost, [])
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => localHost ?? null,
  )
}

export interface Server {
  port: number
  title: string
}

const label = (x: Server) => `localhost:${x.port}${x.title ? ` · ${x.title}` : ''}`

/**
 * The header's computer button: one server opens at once, several ask which. A right-click or a long press offers
 * 인앱으로 열기, 새 탭으로 열기 and 끄기 for each. Nothing when there is none.
 */
export function ServerButton({ s, onPreview }: { s: Session; onPreview: (x: Server) => void }) {
  const here = useLocalHost() === s.hostId
  const press = useRef<number>(undefined)
  const longPressed = useRef(false)
  const servers = s.state.servers ?? []
  if (!servers.length || !s.state.alive) return null
  /** A tab of its own: localhost itself on this Mac, the preview address anywhere else. */
  const newTab = (x: Server) => {
    if (here) return void window.open(`http://localhost:${x.port}/`, '_blank', 'noopener')
    // Opened now, while the press still counts: a phone blocks a tab opened after waiting for the address.
    const w = window.open('', '_blank')
    if (w) w.opener = null
    sessionPost<{ ok: true; url: string }>(s, 'preview', { port: x.port }).then(
      (r) => (w ? w.location.replace(r.url) : window.open(r.url, '_blank', 'noopener')),
      (e) => (w?.close(), toast(errorText(e))),
    )
  }
  // The plain press: this Mac opens a tab of its own, another device the page inside this one.
  const open = (x: Server) => (here ? newTab(x) : onPreview(x))
  const title = servers.length === 1 ? `${label(servers[0])} 열기` : `로컬 서버 ${servers.length}개`
  const stop = async (x: Server) => {
    if (!(await confirmDialog(`localhost:${x.port} 서버를 끌까요?`, { text: '맥에서 그 서버 프로세스를 끝내요. 다시 쓰려면 세션에서 다시 띄워야 해요.', ok: '끄기', danger: true }))) return
    await act(() => sessionPost(s, 'killserver', { port: x.port }))
  }
  // Right-click (a phone: a long press): either way of opening, or stop, for each server.
  const actions = (x: Server): MenuItem[] => [
    { label: '인앱으로 열기', icon: 'desktop', onSelect: () => onPreview(x) },
    { label: '새 탭으로 열기', icon: 'link', onSelect: () => newTab(x) },
    { label: '끄기', icon: 'stop', danger: true, onSelect: () => void stop(x) },
  ]
  const menu = (at: HTMLElement | { x: number; y: number }) =>
    openMenu(servers.length === 1 ? actions(servers[0]) : servers.map((x) => ({ label: `localhost:${x.port}`, hint: x.title || undefined, icon: 'desktop' as const, items: actions(x) })), at, servers.length === 1 ? label(servers[0]) : '로컬 서버')
  return (
    <IconButton
      icon="desktop"
      label={title}
      onContextMenu={(e) => (e.preventDefault(), menu({ x: e.clientX, y: e.clientY }))}
      onPointerDown={(e) => {
        // A new press: whatever the last long press left behind no longer holds back a click.
        longPressed.current = false
        if (e.pointerType !== 'touch') return
        const el = e.currentTarget
        press.current = window.setTimeout(() => ((longPressed.current = true), navigator.vibrate?.(10), menu(el)), 480)
      }}
      onPointerUp={() => clearTimeout(press.current)}
      onPointerMove={() => clearTimeout(press.current)}
      onPointerCancel={() => clearTimeout(press.current)}
      onClick={(e) =>
        longPressed.current
          ? (longPressed.current = false)
          : servers.length === 1
          ? open(servers[0])
          : openMenu(
              servers.map((x) => ({ label: `localhost:${x.port}`, hint: x.title || undefined, icon: 'desktop' as const, onSelect: () => open(x) })),
              e.currentTarget,
              here ? '이 맥에서 열기' : '로컬 서버 열기',
            )
      }
    />
  )
}

/** Another device's view of a localhost server: the page inside a frame, with reload and open-in-a-tab. */
export function PreviewSheet({ s, server, onClose }: { s: Session; server: Server | null; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!server) return
    setUrl(null)
    setError(null)
    let gone = false
    sessionPost<{ ok: true; url: string }>(s, 'preview', { port: server.port }).then(
      (r) => !gone && setUrl(r.url),
      (e) => !gone && setError(errorText(e)),
    )
    return () => {
      gone = true
    }
  }, [s, server])
  const reload = () => {
    // A page inside the frame is of another origin: it cannot be told to reload, so the frame is made again.
    setN((k) => k + 1)
  }
  return (
    <Sheet
      open={!!server}
      onClose={onClose}
      wide
      className="preview-sheet"
      title={server ? label(server) : ''}
      footer={
        <div className="hstack">
          <Button size="sm" icon="refresh" disabled={!url} onClick={reload}>
            처음부터 다시
          </Button>
          <span className="grow" />
          <Button size="sm" icon="link" disabled={!url} onClick={() => url && (window.open(url, '_blank', 'noopener'), toast('새 탭에서 열었어요'))}>
            새 탭으로
          </Button>
        </div>
      }
    >
      {error ? (
        <div className="preview-msg">{error}</div>
      ) : url ? (
        <iframe key={n} className="preview-frame" src={url} title={server ? label(server) : ''} allow="clipboard-write; fullscreen" />
      ) : (
        <div className="preview-msg">맥의 localhost:{server?.port} 에 잇는 중…</div>
      )}
    </Sheet>
  )
}
