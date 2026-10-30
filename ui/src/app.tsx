// The frame: on a PC the list sits beside the conversation; on a phone each is its own screen.
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { post } from './lib/api'
import { getAppSnooze, getPref, setAppSnooze, setPref } from './lib/local'
import { APP_UPDATE_SNOOZE_MS, appVersion, TESTFLIGHT_URL, updateDue } from './lib/app-version'
import { go, href, type Route, useRoute } from './lib/router'
import { look } from './lib/sessions'
import { getStore, onServerToast, reportFocus, useStore } from './lib/store'
import { Button, Icon, IconButton, Logo, Spinner, useWide } from './kit'
import { confirmDialog, openMenu, OverlayHost, type MenuEntry } from './kit/overlay'
import { PermissionModal } from './components/permission-modal'
import { SudoGate } from './components/sudo-gate'
import { NoticeSheet } from './components/notices'
import { appPushOff } from './components/push'
import { openReport, ReportSheet } from './components/report-sheet'
import { CwdSheet } from './components/cwd-sheet'
import { listView, newGroup, SessionList, setListView } from './components/session-list'
import { useRelay } from './components/relay-status'
import { SessionPage } from './pages/session-page'
import { StateWait, useStateLoaded } from './components/state-wait'
import { SessionPicker, SplitView } from './components/split-view'
import { inPane, splitHost } from './lib/split'
// The list and a conversation come with the first load; every other screen is its own file, fetched when it is
// first opened (and, once the page is idle, ahead of that), so the first load carries less script.
const pageFiles = {
  newSession: () => import('./pages/new-session'),
  stats: () => import('./pages/stats'),
  quality: () => import('./pages/quality'),
  hosts: () => import('./pages/hosts'),
  disk: () => import('./pages/disk'),
  admin: () => import('./pages/admin'),
  settings: () => import('./pages/settings'),
  guide: () => import('./pages/guide'),
}
const NewSessionPage = lazy(() => pageFiles.newSession().then((m) => ({ default: m.NewSessionPage })))
const StatsPage = lazy(() => pageFiles.stats().then((m) => ({ default: m.StatsPage })))
const QualityPage = lazy(() => pageFiles.quality().then((m) => ({ default: m.QualityPage })))
const HostsPage = lazy(() => pageFiles.hosts().then((m) => ({ default: m.HostsPage })))
const DiskPage = lazy(() => pageFiles.disk().then((m) => ({ default: m.DiskPage })))
const HostPage = lazy(() => pageFiles.hosts().then((m) => ({ default: m.HostPage })))
const ReportPage = lazy(() => pageFiles.admin().then((m) => ({ default: m.ReportPage })))
const SettingsPage = lazy(() => pageFiles.settings().then((m) => ({ default: m.SettingsPage })))
const GuidePage = lazy(() => pageFiles.guide().then((m) => ({ default: m.GuidePage })))
const idle = (f: () => void) => ('requestIdleCallback' in window ? requestIdleCallback(f, { timeout: 4000 }) : setTimeout(f, 2500))
idle(() => void pageFiles.newSession().then(() => idle(() => Object.values(pageFiles).forEach((f) => void f()))))
import { shownName, type Me } from './lib/types'
import { openLink, openSession } from './lib/builtin-actions'
import { dispatch } from './lib/actions'

function ConnBanner() {
  const link = useStore((s) => s.link)
  const downSince = useStore((s) => s.downSince)
  const [, tick] = useState(0)
  useEffect(() => {
    if (link === 'live') return
    const t = setInterval(() => tick((n) => n + 1), 2000)
    return () => clearInterval(t)
  }, [link])
  // A blip of a few seconds (a deploy, a network change) is not worth a word.
  if (link === 'live' || !downSince || Date.now() - downSince < 8000) return null
  return (
    <div className="conn-banner" role="status">
      <Icon name="warn" />
      서버와 다시 연결하는 중이에요…
    </div>
  )
}

/** The bell: on a phone in the list's bar, on a PC at the foot of the app rail. Never floating over a page's bar. */
function Bell({ onClick }: { onClick: () => void }) {
  const notices = useStore((s) => s.state?.notices.length ?? 0)
  return (
    <span className="relative">
      <IconButton icon="bell" label="알림" onClick={onClick} />
      {notices ? <span className="count">{notices > 9 ? '9+' : notices}</span> : null}
    </span>
  )
}

// Short on purpose: what to make, the settings (which lead to every other page: 기기, 통계, 스킬, 가이드, 운영,
// 화면 테마, 예전 화면), and who is signed in.
// A phone also switches the list's view here (a PC has 그룹 / 최신순 on the list itself).
function appMenu(at: HTMLElement, me: Me | null, phone = false) {
  const view = listView()
  openMenu(
    [
      { label: '새 세션', icon: 'plus', onSelect: () => go({ name: 'new' }) },
      { label: '새 그룹', icon: 'group', onSelect: newGroup },
      'sep',
      ...(phone
        ? ([
            { label: '그룹으로 보기', icon: 'group', checked: view === 'group', onSelect: () => setListView('group') },
            { label: '최신순으로 보기', icon: 'clock', checked: view === 'recent', onSelect: () => setListView('recent') },
            'sep',
          ] as MenuEntry[])
        : []),
      { label: '설정', icon: 'settings', hint: '기기 · 통계 · 스킬 · 화면', onSelect: () => go({ name: 'settings' }) },
      { label: '문제 제보', icon: 'support', onSelect: openReport },
      'sep',
      { header: me ? `${shownName(me)}${me.admin ? ' · 운영자' : ''}` : '' },
      {
        label: '로그아웃',
        icon: 'logout',
        onSelect: () => appPushOff().finally(() => post('/api/auth/logout', {}).finally(() => location.reload())),
      },
    ],
    at,
  )
}

// On a phone the list is its own screen: opening a session unmounts it, and coming back draws it anew. Where it was
// scrolled to and what was typed in its search live here, outside it, so back lands where the person left.
const listKept = { scroll: 0, filter: '' }

function Sidebar({ route, me, onNotices }: { route: Route; me: Me | null; onNotices?: () => void }) {
  const [filter, setFilter] = useState(listKept.filter)
  const search = useRef<HTMLInputElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !listKept.scroll) return
    el.scrollTop = listKept.scroll
    // Rows that arrive a frame later (a state still loading) would leave it short of the spot: once more then.
    const f = requestAnimationFrame(() => {
      if (el.scrollTop < listKept.scroll) el.scrollTop = listKept.scroll
    })
    return () => cancelAnimationFrame(f)
  }, [])
  const relay = useRelay()
  const wide = useWide()
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        search.current?.focus()
      }
    }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [])
  const activeId = route.name === 'session' ? route.id : null
  return (
    <>
      {/* On a PC the brand, the bell and the menu live on the app rail; the list starts with its own tools. */}
      {!wide ? (
        <div className="topbar">
          <a className="brand" href={href({ name: 'home' })}>
            <Logo />
            <span>Agent Bridge</span>
          </a>
          {onNotices ? <Bell onClick={onNotices} /> : null}
          <IconButton icon="more" label="메뉴" onClick={(e) => appMenu(e.currentTarget, me, true)} />
        </div>
      ) : null}
      <div className="list-tools">
        <input ref={search} className="search" type="search" placeholder={wide ? '검색 (⌘K)' : '검색'} value={filter} onChange={(e) => setFilter((listKept.filter = e.target.value))} aria-label="이름·첫 메시지·폴더 검색" />
        {wide ? <IconButton icon="plus" label="새 세션" onClick={() => go({ name: 'new' })} /> : null}
      </div>
      <div className="scroll" ref={scroller} onScroll={(e) => (listKept.scroll = e.currentTarget.scrollTop)}>
        <SessionList activeId={activeId} filter={filter} />
      </div>
      {relay && !relay.headless ? (
        <div className="side-foot" title={relay.text}>
          <span className={`dot dot-${relay.agent === 'on' && relay.server === 'on' ? 'green' : relay.agent === 'off' ? 'red' : 'amber'}`} />
          <span className="muted grow" style={{ fontSize: 'var(--fs-small)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {relay.agent === 'on' && relay.server === 'on' ? `이 맥(${relay.name || '에이전트'})을 연동하는 중` : relay.text || '이 맥을 연동하는 중…'}
          </span>
        </div>
      ) : null}
    </>
  )
}

/** While a screen's file arrives (only the first time it is opened): a quiet spinner where the screen will be. */
function PageWait() {
  return (
    <div className="page-wait" role="status" aria-label="불러오는 중">
      <Spinner />
    </div>
  )
}

function Main({ route, me }: { route: Route; me: Me | null }) {
  switch (route.name) {
    case 'session':
      return <SessionPage key={route.id} id={route.id} />
    case 'new':
      return <NewSessionPage key={location.search} />
    case 'quality':
      return <QualityPage />
    case 'stats':
      return <StatsPage />
    case 'hosts':
      return <HostsPage me={me} />
    case 'disk':
      return <DiskPage me={me} />
    case 'host':
      return <HostPage id={route.id} sid={route.sid} />
    case 'report':
      return <ReportPage key={route.id} id={route.id} />
    case 'settings':
      return <SettingsPage me={me} tab={route.tab ?? 'launch'} />
    case 'guide':
      return <GuidePage me={me} path={route.path} />
    default:
      return <Welcome />
  }
}

function Welcome() {
  const hosts = useStore((s) => s.state?.hosts.length ?? 0)
  const sessions = useStore((s) => s.state?.sessions.length ?? 0)
  const loaded = useStateLoaded()
  if (!loaded)
    return (
      <div className="main">
        <StateWait />
      </div>
    )
  // A person with nothing yet is shown where to begin, not an empty list.
  if (!hosts || !sessions)
    return (
      <div className="main" style={{ display: 'grid', placeItems: 'center' }}>
        <div className="empty">
          <span className="empty-icon">
            <Logo size={30} />
          </span>
          <p className="empty-title">{hosts ? '첫 세션을 띄워 볼까요?' : '어서 오세요!'}</p>
          <div className="empty-text">{hosts ? '맥이 연결됐어요. 시작 가이드에서 남은 단계를 이어서 하세요.' : '맥 한 대를 연결하면 시작할 수 있어요. 시작 가이드가 단계마다 안내하고, 끝난 단계는 저절로 체크해요.'}</div>
          <div className="empty-action hstack" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
            <Button tone="primary" icon="info" onClick={() => go({ name: 'guide', path: 'start' })}>
              처음 시작해요
            </Button>
          </div>
        </div>
      </div>
    )
  return (
    <div className="main" style={{ display: 'grid', placeItems: 'center' }}>
      <div className="empty">
        <span className="empty-icon">
          <Logo size={30} />
        </span>
        <p className="empty-title">왼쪽에서 세션을 고르세요</p>
        <div className="empty-text">새 세션은 ⌘K 옆의 + 로 시작해요.</div>
      </div>
    </div>
  )
}

/**
 * The iOS app left on an older build than TestFlight has (REQ-F-781): asked once a page load to update.
 * Not in a browser and not for the demo account (it has no appBuild); "나중에" (or closing) puts that build off a day.
 */
let nudged = false
function nudgeAppUpdate(me: Me | null) {
  if (!me || me.demo || nudged || inPane) return
  const now = Date.now()
  const app = appVersion()
  const due = updateDue(app, me.appBuild, now, getAppSnooze())
  if (due == null || !app) return
  nudged = true
  void confirmDialog('새 버전이 있어요', { text: `지금 앱은 빌드 ${app.build}, 새 빌드는 ${due} 이에요. TestFlight 에서 업데이트해 주세요.`, ok: 'TestFlight 열기', cancel: '나중에' }).then((open) => {
    if (open) openLink(TESTFLIGHT_URL, 'app-update', '_self')
    else setAppSnooze({ build: due, until: Date.now() + APP_UPDATE_SNOOZE_MS })
  })
}

export function App({ me }: { me: Me | null }) {
  const route = useRoute()
  const wide = useWide()
  const [collapsed, setCollapsed] = useState(() => getPref('sideCollapsed', false))
  const [width, setWidth] = useState(() => getPref('sideWidth', 300))
  const [notices, setNotices] = useState(false)
  const [reporting, setReporting] = useState(false)
  useEffect(() => {
    const f = () => setReporting(true)
    addEventListener('cb-report', f)
    return () => removeEventListener('cb-report', f)
  }, [])
  const sessions = useStore((s) => s.state?.sessions)
  const hosts = useStore((s) => s.state?.hosts)

  useEffect(() => onServerToast((text, sid) => dispatch('notify.show', { text, ...(sid ? { sid } : {}) })), [])
  useEffect(() => nudgeAppUpdate(me), [me])
  // The sessions waiting for the person: counted in the tab title, and on the folded list's rail.
  const need = (sessions ?? []).filter((s) => look(s, hosts?.find((h) => h.id === s.hostId)).need).length
  useEffect(() => {
    document.title = need ? `(${need}) Agent Bridge` : 'Agent Bridge'
  }, [need])
  // Where this page is looking, so a card on the session in front of the person is not also pushed.
  const sid = route.name === 'session' ? route.id : null
  useEffect(() => {
    reportFocus(sid)
    const f = () => reportFocus(sid)
    document.addEventListener('visibilitychange', f)
    const t = setInterval(f, 30_000)
    return () => (document.removeEventListener('visibilitychange', f), clearInterval(t))
  }, [sid])
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !document.querySelector('.side .search')) {
        e.preventDefault()
        setCollapsed(false)
        setPref('sideCollapsed', false)
        setTimeout(() => document.querySelector<HTMLInputElement>('.side .search')?.focus())
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        setCollapsed((c) => (setPref('sideCollapsed', !c), !c))
      }
      // ⌥↑ / ⌥↓: the previous or next session in the list.
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const rows = [...document.querySelectorAll<HTMLElement>('.side [data-sid]')].map((x) => x.dataset.sid!)
        const st = getStore().state
        if (!rows.length || !st) return
        e.preventDefault()
        const at = sid ? rows.indexOf(sid) : -1
        const next = rows[(at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]
        openSession(next, 'key')
      }
    }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [sid])

  // Dragging the list's edge sets the width on the list alone, once per frame, with its easing off. The width
  // lives on the list, not on the whole app: a variable or class on the app (inherited by every element) made
  // the browser restyle the entire page each frame, which stalled a heavy screen (통계) for 270 ms. React state
  // (which redrew the whole page) is set once, when the drag ends.
  const resize = (e: React.PointerEvent) => {
    e.preventDefault()
    const grip = e.currentTarget as HTMLElement
    const side = grip.parentElement
    if (!side) return
    // Captured, the pointer keeps the grip's cursor over the whole screen, and the default being prevented
    // means no text is selected: nothing has to be set on the body.
    grip.setPointerCapture(e.pointerId)
    const start = e.clientX
    const from = width
    let next = from
    let frame = 0
    side.classList.add('resizing')
    const move = (ev: PointerEvent) => {
      next = Math.max(240, Math.min(520, from + ev.clientX - start))
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), side.style.setProperty('--side-w', `${next}px`)))
    }
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
      cancelAnimationFrame(frame)
      side.style.setProperty('--side-w', `${next}px`)
      side.classList.remove('resizing')
      setWidth(next)
      setPref('sideWidth', next)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }

  const atHome = route.name === 'home'
  /** The sessions 분할 화면's panes show now (they move on by themselves). */
  const [paneIds, setPaneIds] = useState<string[] | null>(null)
  // A pane of 분할 화면 says where it went, so the page around it keeps its address (REQ-F-786).
  useEffect(() => {
    if (inPane) splitHost()?.moved(window, location.pathname + location.search)
  }, [route])
  // A phone's edge swipe back (useEdgeSwipeBack): the list is laid under the page while the finger is down.
  const [peek, setPeek] = useState(false)
  useEffect(() => {
    const f = (e: Event) => setPeek((e as CustomEvent<boolean>).detail)
    addEventListener('cb-peek', f)
    return () => removeEventListener('cb-peek', f)
  }, [])
  return (
    <>
    {me?.demo && !inPane ? (
      <div className="demo-banner" role="status">
        <span>데모 모드 · 실제 맥에 연결되지 않아요</span>
        {/* A full page load: GitHub's sign-in replaces the demo's (REQ-F-766). */}
        <a href="/api/auth/github">내 맥 연결은 GitHub 로그인</a>
      </div>
    ) : null}
    <div className={me?.demo && !inPane ? 'app with-demo' : 'app'}>
      {route.name === 'split' ? (
        <SplitView ids={route.ids} onPanes={setPaneIds} />
      ) : wide ? (
        <>
          {/* The first Tab stop: straight to the page, past the rail and the list (a hash link would be a route). */}
          <button type="button" className="skip-link" onClick={() => document.getElementById('main')?.focus()}>
            본문으로 건너뛰기
          </button>
          <AppRail
            me={me}
            route={route}
            collapsed={collapsed}
            need={need}
            onToggle={() => setCollapsed((c) => (setPref('sideCollapsed', !c), !c))}
            onSearch={() => {
              setCollapsed(false)
              setPref('sideCollapsed', false)
              setTimeout(() => document.querySelector<HTMLInputElement>('.side .search')?.focus())
            }}
            onNotices={() => setNotices(true)}
          />
          {!collapsed ? (
            <aside className="side" aria-label="세션 목록" style={{ ['--side-w' as string]: `${width}px` }}>
              <Sidebar route={route} me={me} />
              <div
                className="side-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label="목록 폭"
                aria-valuemin={240}
                aria-valuemax={520}
                aria-valuenow={width}
                tabIndex={0}
                onPointerDown={resize}
                onDoubleClick={() => (setWidth(300), setPref('sideWidth', 300))}
                onKeyDown={(e) => {
                  // The keyboard too: ← → by 16 px, Home = the default width.
                  const next = e.key === 'ArrowLeft' ? width - 16 : e.key === 'ArrowRight' ? width + 16 : e.key === 'Home' ? 300 : null
                  if (next == null) return
                  e.preventDefault()
                  const w = Math.max(240, Math.min(520, next))
                  setWidth(w)
                  setPref('sideWidth', w)
                }}
                title="끌어서 폭 조절 · 더블클릭하면 기본 폭 · 포커스 뒤 ← → 키"
              />
            </aside>
          ) : null}
          <ConnWrap>
            <Suspense fallback={<PageWait />}>
              <Main route={route} me={me} />
            </Suspense>
          </ConnWrap>
        </>
      ) : atHome ? (
        <aside className="side" style={{ width: '100%', borderRight: 0 }} aria-label="세션 목록">
          <ConnBanner />
          <Sidebar route={route} me={me} onNotices={() => setNotices(true)} />
          <button type="button" className="fab" aria-label="새 세션" onClick={() => go({ name: 'new' })}>
            <Icon name="plus" />
          </button>
        </aside>
      ) : (
        <>
        {peek ? (
          <aside className="side under-list" aria-hidden>
            <Sidebar route={route} me={me} />
          </aside>
        ) : null}
        <ConnWrap>
          <Suspense fallback={<PageWait />}>
              <Main route={route} me={me} />
            </Suspense>
        </ConnWrap>
        </>
      )}
      {/* Asked once for the whole screen, by the page around the panes (a pane would ask it again in each). */}
      {!inPane ? <PermissionModal current={route.name === 'split' ? (paneIds ?? route.ids) : sid} /> : null}
      {!inPane ? <SudoGate /> : null}
      {!inPane ? <SessionPicker /> : null}
      <NoticeSheet open={notices} onClose={() => setNotices(false)} />
      <ReportSheet open={reporting} onClose={() => setReporting(false)} sid={sid} />
      <CwdSheet />
      <OverlayHost />
    </div>
    </>
  )
}

/**
 * The app rail (PC): the things that belong to the whole app, never to one page, in one fixed column at the left
 * edge — the brand (home) and the list (fold or open, ⌘\) above; the bell, the settings and the account menu at the
 * foot. It stays when the list is folded, and then also counts what waits for the person and offers a new session and search.
 */
function AppRail({ me, route, collapsed, need, onToggle, onSearch, onNotices }: { me: Me | null; route: Route; collapsed: boolean; need: number; onToggle: () => void; onSearch: () => void; onNotices: () => void }) {
  return (
    <nav className="app-rail" aria-label="앱">
      <a className="rail-logo" href={href({ name: 'home' })} title="Agent Bridge" aria-label="Agent Bridge 홈">
        <Logo size={22} />
      </a>
      <span className="relative">
        <IconButton icon="sidebar" label={collapsed ? '목록 열기 (⌘\\)' : '목록 접기 (⌘\\)'} onClick={onToggle} active={!collapsed} />
        {collapsed && need ? <span className="count rail-count" title={`확인이 필요한 세션 ${need}개`}>{need > 9 ? '9+' : need}</span> : null}
      </span>
      {/* The open list already has its own search box and + at the top; the rail repeats them only while it is folded. */}
      {collapsed && <IconButton icon="plus" label="새 세션" onClick={() => go({ name: 'new' })} active={route.name === 'new'} />}
      {collapsed && <IconButton icon="search" label="검색 (⌘K)" onClick={onSearch} />}
      <span className="grow" />
      <IconButton icon="support" label="문제 제보" onClick={openReport} />
      <Bell onClick={onNotices} />
      <IconButton icon="settings" label="설정" onClick={() => go({ name: 'settings' })} active={route.name === 'settings'} />
      <IconButton icon="user" label={me ? `${shownName(me)} · 메뉴` : '메뉴'} onClick={(e) => appMenu(e.currentTarget, me)} />
    </nav>
  )
}

function ConnWrap({ children }: { children: React.ReactNode }) {
  return (
    <div className="main" id="main" tabIndex={-1}>
      <ConnBanner />
      {children}
    </div>
  )
}
