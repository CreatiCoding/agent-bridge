// Tabs over a session, like an editor's: the sessions that share its group, in the list's order. A click moves to
// that session; × ends it, always after asking; + after the last tab starts a new session in the same group.
// Shown only when the group holds two or more sessions still open, and only on a PC: a phone has them in the ⋯ menu.
import { useEffect, useRef } from 'react'
import { go, href } from '../lib/router'
import { look, titleOf } from '../lib/sessions'
import { NONE, useStore } from '../lib/store'
import { Icon } from '../kit'
import { endSession } from './session-menu'

/** The sessions that share this one's group, as tabs: also the phone's "같은 그룹 세션" menu (session-page). */
export function useGroupTabs(id: string) {
  const sessions = useStore((st) => st.state?.sessions ?? NONE)
  const groups = useStore((st) => st.state?.groups.groups ?? NONE)
  const holder = groups.find((g) => g.items.includes(id))
  // The one on screen stays a tab even once ended, so it does not vanish from under the person.
  const held = (holder?.items ?? []).map((sid) => sessions.find((x) => x.id === sid)).filter((x) => !!x && (!x.closed || x.id === id)) as typeof sessions
  // Put to rest: at the end, as in the list.
  return { holder, tabs: [...held.filter((s) => !s.resting), ...held.filter((s) => s.resting)] }
}

export function SessionTabs({ id }: { id: string }) {
  const hosts = useStore((st) => st.state?.hosts ?? NONE)
  const strip = useRef<HTMLDivElement>(null)
  const { holder, tabs } = useGroupTabs(id)

  // The tab on screen is scrolled into view when it changes (a long row of tabs scrolls sideways).
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('.stab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [id])

  // ⌥1 … ⌥9: the n-th tab. By the key's place (code), as ⌥ turns the digit into another sign (⌥1 → ¡) on a Mac.
  const order = useRef(tabs)
  order.current = tabs
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const m = /^Digit([1-9])$/.exec(e.code)
      if (!m || !e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || order.current.length < 2) return
      const t = order.current[Number(m[1]) - 1]
      if (!t) return
      e.preventDefault()
      if (t.id !== id) go({ name: 'session', id: t.id }, { replace: true })
    }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [id])

  if (tabs.length < 2) return null

  const close = async (sid: string) => {
    const s = tabs.find((x) => x.id === sid)
    if (!s || !(await endSession(s)) || sid !== id) return
    // Closing the tab on screen moves to its neighbour, the next one, else the one before.
    const at = tabs.findIndex((x) => x.id === sid)
    const rest = tabs.filter((x) => x.id !== sid && !x.closed)
    const next = rest[Math.min(at, rest.length - 1)]
    if (next) go({ name: 'session', id: next.id }, { replace: true })
  }

  return (
    // A row of links (not a tablist: each tab carries its own 끝내기 button, which a tablist may not hold).
    <nav className="stabs" aria-label={`${holder?.name ?? ''} 그룹의 세션`} ref={strip}>
      {tabs.map((s, i) => {
        const l = look(s, hosts.find((h) => h.id === s.hostId))
        const on = s.id === id
        const resting = l.label === '휴면'
        return (
          <div key={s.id} className={`stab${on ? ' on' : ''}${s.closed ? ' ended' : ''}${resting ? ' resting' : ''}`} title={`${titleOf(s)} · ${l.label}${i < 9 ? ` · ⌥${i + 1}` : ''}`}>
            <a
              aria-current={on ? 'page' : undefined}
              href={href({ name: 'session', id: s.id })}
              className="stab-main"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                e.preventDefault()
                if (!on) go({ name: 'session', id: s.id }, { replace: true })
              }}
              onAuxClick={(e) => {
                // A middle click closes, as in an editor (still asking first).
                if (e.button === 1) (e.preventDefault(), void close(s.id))
              }}
            >
              {resting ? (
                <span className="srow-rest" aria-hidden>
                  <Icon name="pause" />
                </span>
              ) : (
                <span className={`dot dot-${l.tone}${l.pulse ? ' pulse' : ''}${l.tone === 'green' || s.closed ? ' srow-dot-none' : ''}`} aria-hidden />
              )}
              <span className="stab-title">{titleOf(s)}</span>
            </a>
            {s.closed ? null : (
              <button type="button" className="stab-x" aria-label={`${titleOf(s)} 끝내기`} title="끝내기" onClick={() => void close(s.id)}>
                <Icon name="close" />
              </button>
            )}
          </div>
        )
      })}
      {/* After the last tab, as an editor's "new tab": a new session in this same group. */}
      <a className="stab-new" href={`/new?group=${holder!.id}`} aria-label={`${holder!.name} 그룹에 새 세션`} title="이 그룹에 새 세션">
        <Icon name="plus" />
      </a>
    </nav>
  )
}
