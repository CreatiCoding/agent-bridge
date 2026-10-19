// One conversation: the header, the log (newest at the bottom, older pages on the way up), what Claude is
// writing now, and the input with what is around it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { errorText } from '../lib/api'
import { kbDebugOn, kbDebugText } from '../lib/kbdebug'
import { duration, folderPath, shortLabel, tokens } from '../lib/format'
import { getPref, markSeen, setPref } from '../lib/local'
import { back, go, navigate } from '../lib/router'
import { loadOlder, retryLog, useSessionLog } from '../lib/session-log'
import { groupTree, look, modelName, titleOf } from '../lib/sessions'
import { NONE, useStore } from '../lib/store'
import type { Item } from '../lib/timeline'
import type { Session } from '../lib/types'
import { Button, Chip, Empty, Icon, IconButton, LoadError, Spinner, useTick, useWide, wideNow } from '../kit'
import { openMenu, toast, type MenuEntry } from '../kit/overlay'
import { Composer, type ComposerHandle, type SentVideo } from '../components/composer'
import type { VoiceDraft } from '../components/voice-mode'
import { CacheSheet, DocSheet, Gauges, gaugesHigh, PrChips, ScreenSheet, setTodoPanelPref, SettingsSheet, TODO_ASK, TODO_REASK, TodoAskCard, todoAskOf, TodoPanel, todoPanelPref, Todos, useTodoHidden } from '../components/session-extras'
import { act, canSlack, command, inSlack, moveTo, refresh, rename, resume, sessionMenu, sessionPost, toBridge } from '../components/session-menu'
import { TimelineView, Writing } from '../components/timeline-view'
import { DecisionCard } from '../components/decision-card'
import { LockScreen, useUnlocked } from '../components/lock'
import { SessionTabs, useGroupTabs } from '../components/session-tabs'
import { PreviewSheet, ServerButton, type Server } from '../components/local-preview'
import { useEdgeSwipeBack } from '../kit/swipe'
import { inPane, SPLIT_MAX, splitHost, splitRoom, startSplit } from '../lib/split'

interface Pending {
  key: string
  text: string
  images: string[]
  at: number
  /** 음성 모드's 전송 waiting for the Mac's words: the browser's words stand in, and it is not sent yet. */
  writing?: boolean
}

function OfflineBanner({ s }: { s: Session }) {
  const hosts = useStore((st) => st.state?.hosts ?? NONE)
  const host = hosts.find((h) => h.id === s.hostId)
  const others = hosts.filter((h) => h.online && h.id !== s.hostId)
  if (s.closed || !host || host.online) return null
  return (
    <div className="banner">
      <Icon name="warn" />
      <div className="banner-body">
        <b>{host.name} 이(가) 연결돼 있지 않아요.</b>
        <div className="muted" style={{ fontSize: 'var(--fs-small)' }}>
          그 맥의 브라우저에서 이 사이트를 열면 다시 붙어요. 마지막 싱크 {s.syncedAt ? new Date(s.syncedAt).toLocaleString('ko-KR') : '없음'} · 서버는 대화를 갖고 있지 않아, 이 기기에 남은 대화만 볼 수 있어요.
        </div>
        <div className="muted" style={{ fontSize: 'var(--fs-small)', marginTop: 4 }}>
          {others.length ? '다른 맥으로 옮기려면 이 맥이 연결돼 있어야 해요. 대화는 이 맥에만 있어요.' : '지금 연결된 다른 맥도 없어요.'}
        </div>
      </div>
    </div>
  )
}

/** After a switch, the Mac the session came from is back: offer to go back to it (never done on its own). */
function ReturnedBanner({ s }: { s: Session }) {
  const hosts = useStore((st) => st.state?.hosts ?? NONE)
  const [hidden, setHidden] = useState(false)
  const prev = hosts.find((h) => h.id === s.prevHostId)
  const last = s.moves.at(-1)
  if (hidden || !prev?.online || s.closed || s.moving || s.prevHostId === s.hostId || !last || last.sourceOnline || s.state.phase === 'busy') return null
  return (
    <div className="banner" style={{ background: 'var(--blue-soft)' }}>
      <Icon name="info" />
      <div className="banner-body">
        원래 맥 <b>{prev.name}</b> 이(가) 돌아왔어요. 그 맥에 있던 이 세션은 지금 사본으로 덮어쓴 뒤 옮겨요(덮어쓰기 전 사본은 그 맥에 남아요).
        <div className="banner-actions">
          <Button size="sm" icon="move" onClick={() => act(() => sessionPost(s, 'move', { hostId: prev.id }), `${prev.name} 로 돌아갔어요`)}>
            {prev.name} 로 돌아가기
          </Button>
          <Button size="sm" tone="ghost" onClick={() => setHidden(true)}>
            여기서 계속
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Worked on in Slack: this page only reads it, and says where to go and how to bring it back. */
function SeatBanner({ s }: { s: Session }) {
  const [busy, setBusy] = useState(false)
  if (!inSlack(s)) return null
  const url = s.seat?.url
  return (
    <div className="banner" style={{ background: 'var(--violet-soft)' }}>
      <Icon name="move" />
      <div className="banner-body">
        <b>이 세션은 Slack 에서 작업 중이에요.</b>
        <div className="muted" style={{ fontSize: 'var(--fs-small)' }}>
          여기서는 읽기만 할 수 있어요. Slack 에서 나눈 대화도 이 화면에 그대로 쌓여요.
        </div>
        <div className="banner-actions">
          {url ? (
            <Button size="sm" icon="link" onClick={() => window.open(url, '_blank', 'noopener')}>
              Slack 스레드 열기
            </Button>
          ) : null}
          <Button size="sm" tone="primary" icon="move" busy={busy} onClick={() => (setBusy(true), void toBridge(s).finally(() => setBusy(false)))}>
            브릿지로 가져오기
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Opened by a session on another Mac to hand it work (다른 맥에 맡기기): said at the top and by a frame around the
 * page, like a browser that Claude is driving. The person can still type here; it says whose work this is.
 */
function DrivenBar({ s }: { s: Session }) {
  const parent = useStore((st) => st.state?.sessions.find((x) => x.id === s.delegatedBy) ?? null)
  const hosts = useStore((st) => st.state?.hosts ?? NONE)
  if (!s.delegatedBy || s.closed) return null
  const from = parent ? hosts.find((h) => h.id === parent.hostId)?.name : undefined
  return (
    <div className="driven-bar" role="status">
      <Icon name="laptop" />
      <span className="driven-text">
        <b>{from ?? '다른 맥'} 의 세션이 맡긴 일</b>
        <span className="muted">{parent ? ` · ${titleOf(parent)}` : ''} · 직접 입력해도 돼요</span>
      </span>
      {parent ? (
        <Button size="sm" tone="ghost" onClick={() => go({ name: 'session', id: parent.id })}>
          맡긴 세션 열기
        </Button>
      ) : null}
    </div>
  )
}

/**
 * The sessions this one handed work to and still open (REQ-F-760): said at the top, each with its Mac and state, so
 * the session handing over shows what it is linked to without opening the list.
 */
function DelegatesBar({ s }: { s: Session }) {
  const sessions = useStore((st) => st.state?.sessions ?? NONE)
  const hosts = useStore((st) => st.state?.hosts ?? NONE)
  // The ones waiting on the person come first: that is what the bar is looked at for.
  const kids = useMemo(() => {
    const open = sessions.filter((c) => c.delegatedBy === s.id && !c.closed)
    return open
      .map((c) => {
        const host = hosts.find((h) => h.id === c.hostId)
        return { c, host, l: look(c, host) }
      })
      .sort((a, b) => Number(!!b.l.need) - Number(!!a.l.need))
  }, [sessions, hosts, s.id])
  if (s.closed || s.delegatedBy || !kids.length) return null
  return (
    <div className="driven-bar delegates-bar" role="status">
      <Icon name="laptop" />
      <b className="delegates-head">맡긴 세션 {kids.length}</b>
      <span className="delegates-list">
        {kids.map(({ c, host, l }) => (
          <button key={c.id} type="button" className={`delegate-chip${l.need ? ' need' : ''}`} title={`${host?.name ?? '다른 맥'} · ${titleOf(c)} · ${l.label}\n누르면 열기`} onClick={() => go({ name: 'session', id: c.id })}>
            <span className={`dot dot-${l.tone}${l.pulse ? ' pulse' : ''}`} style={{ width: 7, height: 7 }} />
            <span className="delegate-title">{titleOf(c)}</span>
            <span className="muted delegate-meta">
              {host?.name ?? '다른 맥'}
              <span className="delegate-state"> · {l.label}</span>
            </span>
          </button>
        ))}
      </span>
    </div>
  )
}

/**
 * What the sessions this one handed work to are waiting on (REQ-F-760): their cards, answered here as there. The
 * session handing over waits on them, so the person looking at it answers without opening each one.
 */
function DelegateAsks({ s }: { s: Session }) {
  const sessions = useStore((st) => st.state?.sessions ?? NONE)
  const hosts = useStore((st) => st.state?.hosts ?? NONE)
  const asks = useMemo(() => sessions.filter((c) => c.delegatedBy === s.id && !c.closed && !c.locked && c.card?.open && !c.card.auto), [sessions, s.id])
  if (s.closed || !asks.length) return null
  return (
    <>
      {asks.map((c) => (
        <div key={c.id} className="delegate-ask">
          <div className="driven-bar" role="status">
            <Icon name="laptop" />
            <span className="driven-text">
              <b>{hosts.find((h) => h.id === c.hostId)?.name ?? '다른 맥'} 에 맡긴 세션이 기다려요</b>
              <span className="muted"> · {titleOf(c)}</span>
            </span>
            <Button size="sm" tone="ghost" onClick={() => go({ name: 'session', id: c.id })}>
              맡긴 세션 열기
            </Button>
          </div>
          <DecisionCard session={c} card={c.card!} closed={false} />
        </div>
      ))}
    </>
  )
}

/**
 * A session resting with a big context reads all of it back on every call (REQ-F-776): it is offered a light copy,
 * which is compacted where it is (/compact) and goes on in the same session; Claude Code's summary also lands in
 * SESSION.md (saveCompactSummary). Closed, it comes back only once the context has grown by LIGHT_NUDGE_AGAIN since.
 */
const LIGHT_NUDGE_AT = 300_000
const LIGHT_NUDGE_AGAIN = 200_000
/** How long the banner stays away after 지금 압축 while the compaction runs (the context drops when it is done). */
const COMPACT_WAIT_MS = 300_000

function LightNudge({ s }: { s: Session }) {
  const [closedAt, setClosedAt] = useState<number | null>(() => getPref<Record<string, number>>('lightNudge', {})[s.id] ?? null)
  const [compactAt, setCompactAt] = useState(0)
  useTick(10_000)
  const ctx = s.state.cache?.ctx ?? 0
  if (s.closed || s.locked || !s.state.alive || s.state.handedOffTo || s.state.phase !== 'idle') return null
  if (ctx < LIGHT_NUDGE_AT || (closedAt != null && ctx < closedAt + LIGHT_NUDGE_AGAIN)) return null
  if (Date.now() - compactAt < COMPACT_WAIT_MS) return null
  const compact = () => {
    setCompactAt(Date.now())
    // The server types the /compact and says so with a notice: it is not shown as something the person wrote.
    void act(() => command(s, 'compact')).then((r) => r || setCompactAt(0))
  }
  const close = () => {
    const all = getPref<Record<string, number>>('lightNudge', {})
    all[s.id] = ctx
    const keys = Object.keys(all)
    if (keys.length > 100) for (const k of keys.slice(0, keys.length - 100)) delete all[k]
    setPref('lightNudge', all)
    setClosedAt(ctx)
  }
  return (
    <div className="banner" role="status" style={{ background: 'var(--violet-soft)' }}>
      <Icon name="sparkle" />
      <div className="banner-body">
        컨텍스트가 <b>{tokens(ctx)}</b> 토큰이에요. Claude 는 부를 때마다 이만큼 다시 읽어요. 일이 한 단락 끝났으면 지금 압축해서 이 세션에서 그대로 이어가면 한도를 덜 써요.
        <div className="banner-actions">
          <Button size="sm" tone="primary" icon="sparkle" onClick={compact}>
            지금 압축
          </Button>
          <Button size="sm" tone="ghost" onClick={close}>
            닫기
          </Button>
        </div>
      </div>
    </div>
  )
}

function StateBanner({ s }: { s: Session }) {
  const hosts = useStore((st) => st.state?.hosts ?? NONE)
  const host = hosts.find((h) => h.id === s.hostId)
  if (s.moving)
    return (
      <div className="banner">
        <Spinner size={16} />
        <div className="banner-body">{hosts.find((h) => h.id === s.moving?.to)?.name ?? '다른 맥'} 로 옮기는 중이에요…</div>
      </div>
    )
  if (s.closed)
    return (
      <div className="banner" style={{ background: 'var(--hover)' }}>
        <Icon name="info" />
        <div className="banner-body">
          끝난 세션이에요. 같은 대화로 이어서 열 수 있어요.
          <div className="banner-actions">
            <Button size="sm" tone="primary" icon="play" onClick={() => resume(s)}>
              이어서 열기
            </Button>
          </div>
        </div>
      </div>
    )
  if (host?.online && !s.state.alive && s.state.phase === 'ended')
    return (
      <div className="banner" style={{ background: 'var(--hover)' }}>
        <Icon name="pause" />
        <div className="banner-body">세션이 맥에서 멈춰 있어요. 글을 보내면 같은 대화로 다시 열고 전달해요.</div>
      </div>
    )
  if (s.state.handedOffTo)
    return (
      <div className="banner" style={{ background: 'var(--violet-soft)' }}>
        <Icon name="sparkle" />
        <div className="banner-body">
          이 세션은 더 가벼운 새 세션으로 넘겨졌어요.
          <div className="banner-actions">
            <Button size="sm" onClick={() => navigate(`/s/${s.state.handedOffTo}`)}>
              새 세션으로
            </Button>
          </div>
        </div>
      </div>
    )
  return null
}

/** Whether this turn's timeline already shows a running `name` tool (its row says the command and "도는 중"). */
function shownRunning(items: Item[], name: string): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.t === 'user') return false
    if (it.t === 'tool' && !it.done && it.name === name) return true
  }
  return false
}

function Activity({ s, items }: { s: Session; items: Item[] }) {
  useTick(1000)
  if (s.closed || !s.state.alive) return null
  const st = s.state
  if (st.phase === 'starting')
    return (
      <div className="activity">
        <Spinner size={12} /> 세션을 띄우는 중
      </div>
    )
  // Between turns the line keeps its place, empty: dropping it pulled the conversation down at every turn's end
  // and pushed it up again at the next one.
  if (st.phase !== 'busy') return <div className="activity" aria-hidden />
  const since = st.turnAt ? duration(Date.now() - st.turnAt) : ''
  // The agent's title starts with the tool's name ("Bash /private/tmp/…"): said once, with its paths short (REQ-F-703).
  const name = st.tool?.name ?? ''
  // The timeline row of that tool already says its name and command: said again here it read as the same thing twice.
  if (name && shownRunning(items, name)) {
    const n = st.running?.length ?? 0
    return (
      <div className="activity">
        <Spinner size={12} />
        <span className="activity-text">
          {n > 1 ? `도구 ${n}개 실행 중` : '도구 실행 중'}
          {since ? ` · ${since}` : ''}
        </span>
      </div>
    )
  }
  const what = st.tool?.title ? shortLabel(name && st.tool.title.startsWith(`${name} `) ? st.tool.title.slice(name.length + 1) : st.tool.title) : ''
  return (
    <div className="activity">
      <Spinner size={12} />
      <span className="activity-text">
        {st.tool?.name ? `${st.tool.name}${what ? ` · ${what}` : ''}` : '생각하는 중'}
        {since ? ` · ${since}` : ''}
        {st.running && st.running.length > 1 ? ` · 도구 ${st.running.length}개 실행 중` : ''}
      </span>
    </div>
  )
}

/** The session last opened: a session put to rest is woken only on the way in (see SessionPage). */
let openedFor: string | null = null

export function SessionPage({ id }: { id: string }) {
  const s = useStore((st) => st.state?.sessions.find((x) => x.id === id) ?? null)
  const loaded = useStore((st) => !!st.state)
  const host = useStore((st) => st.state?.hosts.find((h) => h.id === s?.hostId))
  const groups = useStore((st) => st.state?.groups.groups ?? NONE)
  const hosts = useStore((st) => st.state?.hosts ?? NONE)
  const hostCount = hosts.length
  const writing = useStore((st) => st.writing[id] ?? '')
  const unlocked = useUnlocked(id)
  // On a phone, sliding from the left edge goes back to the list.
  const [pageEl, setPageEl] = useState<HTMLDivElement | null>(null)
  useEdgeSwipeBack(pageEl, !useWide(), back)
  // A locked session's conversation is not even asked for until this tab has its key.
  const shut = !!s?.locked && !unlocked
  const log = useSessionLog(shut ? null : id)
  const wide = useWide()
  const scroller = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const composer = useRef<ComposerHandle>(null)
  const atBottom = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const [pending, setPending] = useState<Pending[]>([])
  const [sheet, setSheet] = useState<'settings' | 'screen' | 'doc' | 'sessionmd' | 'cache' | null>(null)
  /** The localhost server shown inside the page (another device than its Mac). */
  const [server, setServer] = useState<Server | null>(null)
  // A phone folds what is under the input but the model and the warnings (더보기); it remembers which way it was left.
  const [dock, setDock] = useState(() => getPref('dockOpen', false))
  const [todoPref, setTodoPref] = useState(todoPanelPref)
  const [todoEmptyOpen, setTodoEmptyOpen] = useState(false)
  const todoHidden = useTodoHidden(s)
  const group = useGroupTabs(id)
  // Opening a conversation puts the cursor in its input, once, as soon as the input is there. Only where there is a
  // mouse: on a phone the keyboard would come up over the conversation the person came to read.
  const focused = useRef(false)
  useEffect(() => {
    if (focused.current || !s || !matchMedia('(hover: hover) and (pointer: fine)').matches) return
    focused.current = true
    requestAnimationFrame(() => composer.current?.focus())
  }, [s])

  // Seen: everything up to the newest event, while this conversation is on screen.
  useEffect(() => {
    if (s && document.visibilityState === 'visible') markSeen(id, s.seq)
  }, [id, s?.seq, s])

  // Opening a session put to rest takes it back out (a pop): however it was reached (a tab, a search, a link), the
  // one on screen is in use. Judged once, when it is first seen after being opened (kept outside the component, so
  // a redraw does not undo a rest the person just gave the session they are looking at).
  useEffect(() => {
    if (!s || openedFor === id) return
    openedFor = id
    if (s.resting && !s.closed) void act(() => sessionPost(s, 'settings', { resting: false }))
  }, [id, s])
  // Leaving its address forgets it, so coming back to it later is a new opening.
  useEffect(
    () => () => {
      if (!location.pathname.endsWith(`/s/${id}`)) openedFor = null
    },
    [id],
  )

  // Follow the bottom while the person is there; otherwise offer a way back to it.
  const toBottom = useCallback((smooth = false) => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])
  useLayoutEffect(() => {
    atBottom.current = true
    setShowJump(false)
    setPending([])
    toBottom()
  }, [id, toBottom])
  // Watched again once the conversation itself is drawn: opened with nothing to show yet (no copy in this browser,
  // the list still coming), the first run found no element and the conversation then opened at its oldest line.
  const drawn = !!s && !shut
  useEffect(() => {
    const el = inner.current
    if (!el) return
    if (atBottom.current) toBottom()
    const ro = new ResizeObserver(() => atBottom.current && toBottom())
    ro.observe(el)
    return () => ro.disconnect()
  }, [toBottom, id, drawn])
  // The input floats over the conversation (glass): its height, kept in --composer-h, is the room the conversation
  // leaves under its last line and where 맨 아래로 sits. Set before paint, so nothing jumps.
  const composerEl = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = composerEl.current
    if (!el || !pageEl) return
    const put = () => pageEl.style.setProperty('--composer-h', `${el.offsetHeight}px`)
    put()
    const ro = new ResizeObserver(put)
    ro.observe(el)
    return () => ro.disconnect()
  }, [pageEl, drawn])
  // 화면 진단 표시: what places the input over the keyboard, measured on the phone (lib/kbdebug).
  const [kbText, setKbText] = useState('')
  const [kbDebug, setKbDebugShown] = useState(kbDebugOn)
  useEffect(() => {
    const on = () => setKbDebugShown(kbDebugOn())
    addEventListener('cb-kbdebug', on)
    return () => removeEventListener('cb-kbdebug', on)
  }, [])
  useEffect(() => {
    if (!kbDebug || !pageEl) return
    const t = setInterval(() => setKbText(kbDebugText(pageEl)), 500)
    return () => clearInterval(t)
  }, [kbDebug, pageEl])
  // iOS pans the whole page up when the keyboard opens (the app frame is fixed, but what is seen moves): the phone's
  // floating header is brought down by as much (--vv-top), so it stays at the top of what is seen. While the keyboard
  // is up (what is seen is much shorter than the tallest it has been at this width, not zoomed in) kb-open drops the
  // room kept under the input for the home bar, so the input sits right on the keyboard. Measured against the tallest
  // seen, not the page: Safari keeps the page's height and shortens what is seen, but the iOS app's web view itself
  // gets shorter, page and all.
  // An iPad does not pan the page for an input at its foot, and a pane of 분할 화면 is a frame that is never told about
  // the keyboard (its own visualViewport keeps its full height): both measure what is seen of the page around them
  // and lift the input (--kb-lift) by as much of it as the keyboard covers (REQ-F-757 rule 4a).
  useEffect(() => {
    const top = inPane ? window.parent : window
    const vv = top.visualViewport
    if (!vv || !pageEl) return
    const frame = inPane ? (window.frameElement as HTMLElement | null) : null
    let tallest = { w: 0, h: 0 }
    const put = () => {
      if (tallest.w !== top.innerWidth) tallest = { w: top.innerWidth, h: 0 }
      tallest.h = Math.max(tallest.h, top.innerHeight, vv.height)
      const kb = vv.scale < 1.05 && tallest.h - vv.height > 150
      // Where this page is in the page around it (the whole of it when it is that page).
      const box = frame?.getBoundingClientRect() ?? { top: 0, bottom: top.innerHeight }
      pageEl.style.setProperty('--vv-top', `${Math.max(0, Math.round(vv.offsetTop - box.top))}px`)
      // A phone is panned: iOS already brings the input above the keyboard, and lifting it as well moved it twice.
      const lift = kb && (inPane || (wideNow() && vv.offsetTop < 1)) ? Math.max(0, Math.round(box.bottom - (vv.offsetTop + vv.height))) : 0
      pageEl.style.setProperty('--kb-lift', `${lift}px`)
      pageEl.classList.toggle('kb-open', kb)
      if (kbDebugOn()) setKbText(kbDebugText(pageEl))
    }
    put()
    vv.addEventListener('scroll', put)
    vv.addEventListener('resize', put)
    return () => (vv.removeEventListener('scroll', put), vv.removeEventListener('resize', put))
  }, [pageEl])

  // Older pages: keep what is on screen where it is while they are put above it.
  const prevHeight = useRef<number | null>(null)
  const firstSeq = log.events[0]?.seq
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && prevHeight.current != null) {
      el.scrollTop += el.scrollHeight - prevHeight.current
      prevHeight.current = null
    }
  }, [firstSeq])
  // Only a move up leaves the bottom. The scroll event comes a frame after the move: a line added in between
  // (80 px of a tool row) made a jump to the bottom read as 80 px short of it, and the conversation stopped following.
  const lastTop = useRef(0)
  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const top = el.scrollTop
    const bottom = el.scrollHeight - top - el.clientHeight < 80 || (atBottom.current && top >= lastTop.current - 1)
    lastTop.current = top
    atBottom.current = bottom
    if (bottom !== !showJump) setShowJump(!bottom)
    if (el.scrollTop < 300 && log.older && !log.loading) {
      prevHeight.current = el.scrollHeight
      void loadOlder(id)
    }
  }

  // A message sent from here shows at once, faded, until the log has it.
  useEffect(() => {
    if (!pending.length) return
    const said = log.folded.items.filter((i) => i.t === 'user').slice(-20) as { text: string; at: number }[]
    const left = pending.filter((p) => p.writing || (!said.some((u) => u.text.trim() === p.text.trim() && u.at >= p.at - 5000) && Date.now() - p.at < 15_000))
    if (left.length !== pending.length) setPending(left)
  }, [log.folded.items, pending])

  // What ↑ brings back in the input: this session's own messages, read from its conversation, so every device
  // (and the terminal on the Mac) sees the same list. The last 50, oldest first, a repeat kept only where it was last.
  const history = useMemo(() => {
    const said = (log.folded.items.filter((i) => i.t === 'user') as { text: string }[]).map((u) => u.text.trim()).filter(Boolean)
    const out: string[] = []
    for (let i = said.length - 1; i >= 0 && out.length < 50; i--) if (!out.includes(said[i])) out.push(said[i])
    return out.reverse()
  }, [log.folded.items])

  const send = useCallback(
    async (text: string, images: { data: string; name: string }[] = [], videos: SentVideo[] = []) => {
      if (!s) return false
      // Shown as the server logs it: the videos as "🎬 <name>" lines under the words.
      const shown = [text, ...videos.map((v) => `🎬 ${v.name}`)].filter(Boolean).join('\n')
      const p: Pending = { key: crypto.randomUUID(), text: shown, images: images.map((i) => i.data), at: Date.now() }
      const side = /^[/:]/.test(text.trim())
      if (!side) setPending((x) => [...x, p])
      atBottom.current = true
      requestAnimationFrame(() => toBottom())
      try {
        await sessionPost(s, 'say', { text, images, ...(videos.length ? { videos: videos.map((v) => ({ id: v.id })) } : {}) })
        return true
      } catch (e) {
        setPending((x) => x.filter((y) => y.key !== p.key))
        toast(errorText(e), { tone: 'bad' })
        return false
      }
    },
    [s, toBottom],
  )
  // 음성 모드's 전송: in the conversation at once with the browser's words (greyer, 받아쓰는 중), and sent with the Mac's
  // words when they are in; from then on it is any sent message.
  const draft = useCallback(
    (shown: string): VoiceDraft => {
      const key = crypto.randomUUID()
      setPending((x) => [...x, { key, text: shown, images: [], at: Date.now(), writing: true }])
      atBottom.current = true
      requestAnimationFrame(() => toBottom())
      const drop = () => setPending((x) => x.filter((y) => y.key !== key))
      return {
        drop,
        send: async (text) => {
          if (!s) return (drop(), false)
          setPending((x) => x.map((y) => (y.key === key ? { ...y, text, at: Date.now(), writing: false } : y)))
          try {
            await sessionPost(s, 'say', { text, images: [] })
            return true
          } catch (e) {
            drop()
            toast(errorText(e), { tone: 'bad' })
            return false
          }
        },
      }
    },
    [s, toBottom],
  )
  const stop = useCallback(() => s && act(() => sessionPost(s, 'esc'), '멈추라고 보냈어요 (Esc)'), [s])

  if (!s)
    return loaded ? (
      <div className="main">
        <div className="topbar">
          <IconButton icon="back" label="뒤로" onClick={back} />
        </div>
        <Empty icon="search" title="세션을 찾지 못했어요" action={<Button onClick={back}>목록으로</Button>}>
          지워졌거나 다른 계정의 세션이에요.
        </Empty>
      </div>
    ) : (
      <div className="main" style={{ display: 'grid', placeItems: 'center' }}>
        <Spinner />
      </div>
    )

  const l = look(s, host)
  // The groups the session sits in, outermost first.
  const holder = groups.find((g) => g.items.includes(s.id))
  const crumbs = holder ? (groupTree(groups).find((t) => t.group.id === holder.id)?.names ?? [holder.name]) : []
  if (shut)
    return (
      <div className="main">
        <div className="topbar">
          {!wide ? <IconButton icon="back" label="뒤로" onClick={back} /> : null}
          <div className="topbar-title">
            <b>{titleOf(s)}</b>
            <span>잠김 · {l.label}</span>
          </div>
        </div>
        <LockScreen s={s} />
      </div>
    )
  const model = modelName(s.launchModel || s.model)
  const busy = s.state.alive && s.state.phase === 'busy'
  const away = inSlack(s)
  // The to-do panel (REQ-F-778): open as remembered while there is a list; with none, only once 할 일 is pressed.
  const todoItems = todoHidden.visible(log.folded.todos ?? [])
  const todoShown = todoItems.length ? todoPref : todoEmptyOpen
  const showTodos = (on: boolean) => (setTodoPref(on), setTodoPanelPref(on), setTodoEmptyOpen(on))
  // A session started before the bridge MCP had its todos tool (REQ-F-778 rule 9) is reopened first, so the request
  // reaches a Claude that has it: said while it reopens (or waits to), the request is held and handed to the session
  // that comes back. While it works, it reopens once the turn and the background work are done.
  const noTodosTool = s.state.alive && !s.state.bridgeTools?.includes('mcp__bridge__todos') && !s.sawTodosTool
  const askTodos = async () => {
    const later = busy || (s.bg?.length ?? 0) > 0
    if (noTodosTool) {
      try {
        await sessionPost(s, 'refresh', { when: later ? 'later' : 'now' })
      } catch (e) {
        toast(errorText(e), { tone: 'bad' })
        return false
      }
    }
    const ok = await send(todoItems.length ? TODO_REASK : TODO_ASK)
    if (ok) toast(!noTodosTool ? '할 일 정리를 부탁했어요' : later ? '하던 일이 끝나면 세션을 다시 열어 할 일 도구를 붙이고 정리를 부탁할게요' : '세션을 다시 열어 할 일 도구를 붙이고 정리를 부탁했어요')
    return ok
  }
  // ▶ and a to-do item send the request like any message, so a busy session gets it after its turn (REQ-F-779).
  const runTodos = (text: string) => void send(text).then((ok) => ok && toast(busy ? '지금 하던 일이 끝나면 이어서 해요' : '할 일을 시작했어요'))
  const copyPath = () => navigator.clipboard?.writeText(s.cwd).then(() => toast('경로를 복사했어요'))
  // What a phone leaves out of its header, at the top of the ⋯ menu: the group's other sessions (the PC's tabs) and
  // the folder.
  const phoneMenu: MenuEntry[] = wide
    ? []
    : [
        ...(group.tabs.length > 1 && group.holder
          ? [
              {
                label: '같은 그룹 세션',
                icon: 'list' as const,
                hint: `${crumbs.join(' › ')} · ${group.tabs.length}개`,
                items: [
                  ...group.tabs.map((t) => ({ label: titleOf(t), checked: t.id === s.id, hint: look(t, hosts.find((h) => h.id === t.hostId)).label, onSelect: () => t.id !== s.id && go({ name: 'session', id: t.id }, { replace: true }) })),
                  { label: '이 그룹에 새 세션', icon: 'plus' as const, onSelect: () => navigate(`/new?group=${group.holder!.id}`) },
                ],
              },
            ]
          : []),
        { label: '경로 복사', icon: 'copy', hint: folderPath(s.cwd, s.home), onSelect: () => void copyPath() },
        'sep',
      ]
  const wideMenu: MenuEntry[] = wide ? [{ label: 'AGENTS.md', icon: 'doc', hint: '이 폴더의 작업 지침', onSelect: () => setSheet('doc') }] : []
  // 터미널 화면 is in the ⋯ menu on every screen; a wide header has 새로고침 in its place (REQ-F-609).
  // 분할 화면 (REQ-F-786): where there is room for two panes, a session opens beside another; inside a pane, the
  // pane adds one beside it, leaves, or opens on its own. Made as the menu opens: the panes change without this one.
  const splitMenu = (): MenuEntry[] => {
  const split = splitHost()
  return inPane && split
    ? [
        { label: '옆에 세션 추가', icon: 'columns', hint: split.count() >= SPLIT_MAX ? `${SPLIT_MAX}칸까지예요` : `${split.count()} / ${SPLIT_MAX}칸`, disabled: split.count() >= SPLIT_MAX, onSelect: () => split.add() },
        { label: '이 세션만 크게', icon: 'forward', onSelect: () => split.full(window) },
        { label: '분할에서 빼기', icon: 'close', onSelect: () => split.close(window) },
        'sep',
      ]
    : splitRoom() >= 2
      ? [{ label: '분할로 띄우기', icon: 'columns', hint: `다른 세션과 나란히 · 최대 ${SPLIT_MAX}개`, onSelect: () => void startSplit(s.id) }, 'sep']
      : []
  }
  const screenItem: MenuEntry = { label: '터미널 화면', icon: 'terminal', disabled: !s.state.alive, onSelect: () => setSheet('screen') }
  const disabled = away ? 'Slack 에서 작업 중이에요' : s.closed ? '끝난 세션이에요' : s.moving ? '옮기는 중이에요' : host && !host.online ? '맥이 연결돼 있지 않아요' : undefined
  return (
    <div className={`main sess${s.delegatedBy && !s.closed ? ' driven' : ''}`} ref={setPageEl}>
      {kbDebug ? <pre className="kbdebug">{kbText}</pre> : null}
      {wide ? <SessionTabs id={s.id} /> : null}
      <div className="topbar">
        {/* A phone: 뒤로 and the title are one glass capsule, ⋯ its own circle (display: contents on a wide screen). */}
        <div className="glass-lead">
          {!wide ? <IconButton icon="back" label="뒤로" onClick={back} /> : null}
          <div className="topbar-title">
            {/* A session inside groups shows where it sits: 그룹 › 하위 그룹 › 제목. Only the title renames. */}
            <span className="crumbs" aria-label={[...crumbs, titleOf(s)].join(' › ')}>
              {/* A phone shows the title alone: the group is in the ⋯ menu (같은 그룹 세션). */}
              {(wide ? crumbs : []).map((c, i) => (
                <span key={i} style={{ display: 'contents' }}>
                  <span className="crumb">{c}</span>
                  <span className="crumb-sep" aria-hidden>
                    ›
                  </span>
                </span>
              ))}
              <button type="button" className="title-btn title-name" onClick={() => rename(s)} title="이름 바꾸기">
                <b>{titleOf(s)}</b>
              </button>
            </span>
            {/* Said once each: the model and mode are on the settings chip below, the Mac only when there are several. */}
            <span>
              <span className={`dot dot-${l.tone}${l.pulse ? ' pulse' : ''}`} style={{ width: 7, height: 7 }} />
              {l.label}
              {host && hostCount > 1 ? ` · ${host.name}` : ''}
              {/* A long path is cut with …; pointing at it shows the whole path, pressing it copies it. A phone has it
                  in the ⋯ menu (경로 복사) instead. */}
              {wide ? (
                <>
                  {' '}·
                  <button type="button" className="topbar-path" title={`${s.cwd}\n누르면 복사`} onClick={copyPath}>
                    {folderPath(s.cwd, s.home)}
                  </button>
                </>
              ) : null}
            </span>
          </div>
        </div>
        {/* A phone has 새로고침 in the ⋯ menu. */}
        {wide ? <IconButton icon="list" label="할 일" className="todo-toggle" active={todoShown} aria-pressed={todoShown} onClick={() => showTodos(!todoShown)} /> : null}
        {wide ? <IconButton icon="refresh" label="새로고침" title="대화 그대로 다시 열기" onClick={() => void refresh(s)} disabled={!!disabled || !s.state.alive} /> : null}
        <div className="glass-group">
          <ServerButton s={s} onPreview={setServer} />
          <IconButton icon="more" label="세션 메뉴" onClick={(e) => openMenu([...splitMenu(), ...phoneMenu, screenItem, { label: '할 일 정리', icon: 'list', hint: '지금까지 한 일·남은 일', disabled: !!disabled, onSelect: () => void askTodos() }, ...wideMenu, 'sep', ...sessionMenu(s, { groups: groupTree(groups).map((t) => ({ id: t.group.id, name: t.path })), noRefresh: wide })], e.currentTarget, titleOf(s))} />
        </div>
      </div>
      <DrivenBar s={s} />
      <DelegatesBar s={s} />
      <div className="sess-body">
      <div className="convo" ref={scroller} onScroll={onScroll}>
        <div className="convo-in" ref={inner}>
          {log.offline ? (
            <div className="log-offline" role="status">
              맥 연결 끊김 · {log.events.length ? '이 기기에 남아 있는 대화만 보여요' : '맥이 연결되면 대화가 보여요'}
            </div>
          ) : null}
          {log.older && !log.offline ? (
            <div className="older">
              <Button size="sm" tone="ghost" busy={log.loading} onClick={() => ((prevHeight.current = scroller.current?.scrollHeight ?? null), void loadOlder(id))}>
                이전 대화 더 보기
              </Button>
            </div>
          ) : null}
          {!log.loaded && log.loading ? (
            <div style={{ display: 'grid', placeItems: 'center', padding: 40 }}>
              <Spinner />
            </div>
          ) : null}
          {log.error && !log.loaded ? <LoadError what="대화를" error={log.error} onRetry={() => retryLog(id)} /> : null}
          {log.loaded && !log.offline && !log.folded.items.length && !pending.length ? (
            <Empty icon="send" title="아직 대화가 없어요">
              아래 입력칸에 첫 메시지를 보내면 여기에 대화가 쌓여요.
            </Empty>
          ) : null}
          <TimelineView items={log.folded.items} session={s} onSend={(t) => void send(t)} onEdit={(t) => composer.current?.setText(t)} />
          {pending.map((p) => (
            <div key={p.key} className="msg-user">
              {p.images.length ? (
                <div className="thumbs">
                  {p.images.map((src, i) => (
                    <img key={i} className="thumb" src={src} alt="" />
                  ))}
                </div>
              ) : null}
              {p.text && todoAskOf(p.text) ? (
                <TodoAskCard ask={todoAskOf(p.text)!} className="sending" />
              ) : p.text ? (
                <div className={`bubble sending${p.writing ? ' writing' : ''}`}>{p.text}</div>
              ) : null}
              {p.writing ? <div className="bubble-note">받아쓰는 중…</div> : null}
            </div>
          ))}
          <Writing text={writing} />
          <Activity s={s} items={log.folded.items} />
          {/* After the conversation is in: drawn before it, they were pushed down the moment it arrived (a layout
              shift of 0.18 on a phone). */}
          {log.loaded ? (
            <>
              <SeatBanner s={s} />
              <DelegateAsks s={s} />
              <StateBanner s={s} />
              <LightNudge s={s} />
              <OfflineBanner s={s} />
              <ReturnedBanner s={s} />
            </>
          ) : null}
        </div>
      </div>
      {/* Kept mounted on a wide screen so opening and closing slide (the conversation and the input move with it). */}
      {wide ? (
        <div className={`todo-dock${todoShown ? ' open' : ''}`} inert={!todoShown}>
          <TodoPanel items={todoItems} onRemove={todoHidden.remove} onClose={() => showTodos(false)} onAsk={askTodos} onRun={runTodos} disabled={disabled} noTool={noTodosTool} />
        </div>
      ) : null}
      </div>
      {showJump ? (
        <div className="jump" style={{ bottom: 'calc(var(--composer-h, 120px) + var(--kb-lift, 0px) + 12px)' }}>
          <Button size="sm" icon="arrowDown" onClick={() => ((atBottom.current = true), toBottom(true))}>
            맨 아래로
          </Button>
        </div>
      ) : null}
      <div className="composer" ref={composerEl}>
        {log.folded.todos || wide || dock ? (
          <div className="composer-in composer-extra">
            {log.folded.todos ? <Todos items={todoItems} onRemove={todoHidden.remove} /> : null}
            {/* Held messages are said by their card in the conversation (with 지금 보내기), not again here. */}
            {wide || dock ? <Gauges s={s} fold={wide} onOpenMd={() => setSheet('sessionmd')} onOpenCache={() => setSheet('cache')} /> : null}
          </div>
        ) : null}
        <Composer
          ref={composer}
          session={s}
          history={history}
          busy={busy}
          disabled={disabled}
          onSend={send}
          onDraft={draft}
          onStop={() => void stop()}
          tools={
            /* The model and what warns always show; the rest a phone folds under 더보기 (red when a gauge is). */
            <>
              <Chip icon="settings" onClick={() => setSheet('settings')}>
                {/* 전부 허용 has its own chip (it can be switched off there): not said here too. */}
                {[model || '모델', s.state.effort, !s.state.autoAllow && s.state.mode && s.state.mode !== 'default' ? s.state.mode : null].filter(Boolean).join(' · ')}
              </Chip>
              {away ? (
                <Chip icon="move" tone="warn" onClick={() => void toBridge(s)} title="눌러서 브릿지로 가져오기">
                  Slack 에서 작업 중
                </Chip>
              ) : null}
              {s.state.autoAllow ? (
                <Chip icon="shield" tone="warn" onClick={() => act(() => sessionPost(s, 'settings', { autoAllow: false }), '전부 허용을 껐어요')} title="눌러서 끄기">
                  전부 허용 중
                </Chip>
              ) : null}
              {s.state.refreshAfter ? (
                <Chip icon="refresh" tone="warn">
                  끝나면 새로고침
                </Chip>
              ) : null}
              {wide || dock ? (
                <>
                  {(s.bg ?? []).length ? (
                    <Chip icon="clock" title={(s.bg ?? []).map((t) => t.label).join('\n')}>
                      백그라운드 {(s.bg ?? []).length}
                    </Chip>
                  ) : null}
                  <PrChips s={s} />
                  {/* A wide screen has AGENTS.md and 옮기기 in the ⋯ menu (sessionMenu already moves): not twice. */}
                  {!wide ? (
                    <>
                      <Chip icon="doc" onClick={() => setSheet('doc')}>
                        AGENTS.md
                      </Chip>
                      {/* Another Mac or Slack: one chip, one list (moveTo). */}
                      {(hostCount > 1 || canSlack(s)) && s.state.alive && !away ? (
                        <Chip icon="move" onClick={() => moveTo(s)}>
                          옮기기
                        </Chip>
                      ) : null}
                    </>
                  ) : null}
                </>
              ) : null}
              {!wide ? (
                <Chip icon={dock ? 'up' : 'down'} tone={!dock && gaugesHigh(s) ? 'bad' : undefined} onClick={() => setDock((d) => (setPref('dockOpen', !d), !d))} title={dock ? '접기' : '백그라운드·AGENTS.md·옮기기·사용량'}>
                  {dock ? '접기' : `더보기${(s.bg ?? []).length ? ` · 백그라운드 ${(s.bg ?? []).length}` : ''}`}
                </Chip>
              ) : null}
            </>
          }
        />
        <div className="sr-only" aria-live="polite">
          {l.label}
        </div>
      </div>
      <SettingsSheet s={s} open={sheet === 'settings'} onClose={() => setSheet(null)} />
      <ScreenSheet s={s} open={sheet === 'screen'} onClose={() => setSheet(null)} />
      <DocSheet s={s} open={sheet === 'doc'} onClose={() => setSheet(null)} />
      <DocSheet s={s} open={sheet === 'sessionmd'} onClose={() => setSheet(null)} file="session" />
      <CacheSheet s={s} open={sheet === 'cache'} onClose={() => setSheet(null)} />
      <PreviewSheet s={s} server={server} onClose={() => setServer(null)} />
    </div>
  )
}
