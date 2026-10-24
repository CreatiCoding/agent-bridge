// The list of sessions: a one-line count at the top, then the groups and the sessions in no group, then what was
// ended (to pick up again). Rows keep the order they were started in, so nothing jumps while work goes on;
// a session that needs the person shows it by its colour and badge.
import { memo, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { post } from '../lib/api'
import { ago } from '../lib/format'
import { getPref, getSeen, setPref } from '../lib/local'
import { go, href, navigate } from '../lib/router'
import { prefetch } from '../lib/session-log'
import { GROUP_DEPTH, groupHeight, groupTree, look, titleOf } from '../lib/sessions'
import { useStore } from '../lib/store'
import type { Host, Session } from '../lib/types'
import { openPreset, presetActions, splitRoom } from '../lib/split'
import { Ago, Badge, Collapse, Icon, IconButton, Row, SectionHeader, Segmented, useTick, useWide } from '../kit'
import { confirmDialog, openMenu, promptDialog } from '../kit/overlay'
import { act, resume, sessionMenu, sessionPost, toggleRest } from './session-menu'
import { useSwipeRow } from '../kit/swipe'
import { del } from '../lib/api'
import { StateWait } from './state-wait'
import { useGroupSort } from './group-sort'

function useSeen() {
  const [seen, setSeen] = useState(getSeen)
  useEffect(() => {
    const f = () => setSeen(getSeen())
    addEventListener('cb-seen', f)
    return () => removeEventListener('cb-seen', f)
  }, [])
  return seen
}

// A row redraws only when its own session (or what it shows about it) changed: typing in the search box or a
// state change of another session leaves it alone. The list of groups compares by names, since it is rebuilt.
const sameGroups = (a: { id: string; name: string }[], b: { id: string; name: string }[]) => a === b || (a.length === b.length && a.every((g, i) => g.id === b[i].id && g.name === b[i].name))
const SessionRow = memo(SessionRowView, (a, b) => a.s === b.s && a.host === b.host && a.active === b.active && a.unread === b.unread && a.dropBefore === b.dropBefore && a.multiHost === b.multiHost && !!a.onDragStart === !!b.onDragStart && sameGroups(a.groups, b.groups))
function SessionRowView({ s, host, active, unread, groups, onDragStart, dropBefore, multiHost }: { s: Session; host?: Host; active: boolean; unread: boolean; groups: { id: string; name: string }[]; onDragStart?: (id: string) => void; dropBefore?: boolean; multiHost: boolean }) {
  const l = look(s, host)
  const quiet = l.tone === 'green' || l.label === '휴면' || l.label === '끝남'
  const wide = useWide()
  const swipe = useSwipeRow(144, !wide)
  const press = useRef<number | null>(null)
  const longPressed = useRef(false)
  const menu = (at: HTMLElement | { x: number; y: number }) => openMenu(sessionMenu(s, { groups }), at, titleOf(s))
  const actions = s.closed
    ? [
        { label: '이어서 열기', tone: 'blue', run: () => resume(s) },
        { label: '지우기', tone: 'red', run: async () => (await confirmDialog('이 세션을 목록에서 지울까요?', { text: '맥에 둔 화면 기록도 지워요. Claude Code 대화 파일은 맥에 그대로예요.', ok: '지우기', danger: true })) && act(() => del(`/api/sessions/${s.id}`), '지웠어요') },
      ]
    : [
        { label: s.resting ? '휴면 풀기' : '휴면', tone: 'grey', run: () => toggleRest(s) },
        { label: '종료', tone: 'red', run: async () => (await confirmDialog('세션을 끝낼까요?', { text: '대화는 남아요. 나중에 이어서 열 수 있어요.', ok: '끝내기', danger: true })) && act(() => sessionPost(s, 'close'), '끝냈어요') },
      ]
  return (
    <div className="swipe">
      {!wide ? (
        <div className="swipe-actions" aria-hidden={false}>
          {actions.map((a) => (
            <button key={a.label} type="button" className={`swipe-btn swipe-${a.tone}`} onClick={() => (swipe.close(), void a.run())}>
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
    <a
      ref={(n) => void (swipe.ref.current = n)}
      {...swipe.handlers}
      className={`srow${active ? ' active' : ''}${unread ? ' unread' : ''}${dropBefore ? ' drop-before' : ''}${l.label === '휴면' ? ' resting' : ''}`}
      href={href({ name: 'session', id: s.id })}
      title={multiHost && host ? `${titleOf(s)} · ${host.name}` : undefined}
      draggable={!!onDragStart}
      data-sid={s.id}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/x-session', s.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart?.(s.id)
      }}
      onPointerDown={(e) => {
        prefetch(s.id)
        if (e.pointerType !== 'touch') return
        longPressed.current = false
        const el = e.currentTarget
        press.current = window.setTimeout(() => {
          longPressed.current = true
          navigator.vibrate?.(10)
          menu(el)
        }, 480)
      }}
      onPointerUp={() => press.current && clearTimeout(press.current)}
      onPointerMove={() => press.current && clearTimeout(press.current)}
      onPointerCancel={() => press.current && clearTimeout(press.current)}
      onClick={(e) => {
        if (longPressed.current) return e.preventDefault()
        // A row slid open closes on a tap instead of opening the session.
        if (swipe.isOpen()) return e.preventDefault(), swipe.close()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        menu({ x: e.clientX, y: e.clientY })
      }}
    >
      {/* A filled dot only when there is something to see: working, waiting for the person, moving, stopped or cut
          off. A session simply idle gets a hollow ring, so the list is not a column of green yet every row looks alike. */}
      {/* Put to rest: a pause mark in the dot's place and a dimmed title, so it does not read as simply idle. */}
      {l.label === '휴면' ? (
        <span className="srow-rest" title="휴면" aria-label="휴면">
          <Icon name="pause" />
        </span>
      ) : (
        // 전부 허용 that asks nothing (REQ-F-796): a red ring round the dot, whatever the dot says the session is doing.
        <span className={`dot srow-dot dot-${l.tone}${l.pulse ? ' pulse' : ''}${quiet ? ' srow-dot-none' : ''}${s.state.autoAllow && s.state.allowAll ? ' srow-dot-allow-all' : ''}`} aria-hidden title={s.state.autoAllow && s.state.allowAll ? '전부 허용 중' : undefined} />
      )}
      <span className="srow-main">
        {/* One line: the title, what needs the person (a badge), and when it last moved. No preview of the
            conversation: the list is for finding a session, the conversation is one tap away. */}
        <span className="srow-top">
          <span className="srow-title">
            {s.favorite ? <Icon name="star" className="inline-icon srow-star" /> : null}
            {s.locked ? <Icon name="key" className="inline-icon" /> : null}
            {titleOf(s)}
          </span>
          {l.need || l.tone === 'violet' || l.label === '기기 끊김' ? <Badge tone={l.tone}>{l.label}</Badge> : null}
          {s.seat?.where === 'slack' ? <Badge tone="violet">Slack</Badge> : null}
          {/* Driven by a session on another Mac (다른 맥에 맡기기): told apart from the ones the person works in. */}
          {s.delegatedBy ? <Badge tone="violet">맡김</Badge> : null}
          {/* Put to rest: the word where the time goes, so it reads from across the room. */}
          <span className="srow-time">{l.label === '휴면' ? '휴면' : <Ago t={s.lastAt} format={ago} />}</span>
        </span>
      </span>
    </a>
    </div>
  )
}

let endedOpen = false

export function SessionList({ activeId, filter }: { activeId: string | null; filter: string }) {
  useTick(30_000)
  const state = useStore((s) => s.state)
  const seen = useSeen()
  const wide = useWide()
  // Kept outside the list (like its scroll, app.tsx listKept): a phone draws the list anew on coming back.
  const [showEnded, setShowEnded] = useState(endedOpen)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ group: string | null; before: string | null } | null>(null)
  // 그룹 or 최신순: remembered on this device only.
  const [view, setView] = useState<ListView>(listView)
  // A phone switches the view from the app menu (setListView), not from a control on the list.
  useEffect(() => {
    const f = () => setView(listView())
    addEventListener(VIEW_EVENT, f)
    return () => removeEventListener(VIEW_EVENT, f)
  }, [])
  // Folding answers at once: the server's word (through the stream) took a round trip, ~180 ms, before the
  // group moved. Kept until the server's list agrees, dropped if the request fails.
  const [foldNow, setFoldNow] = useState<Record<string, boolean>>({})
  // A group dragged to a new place is drawn there at once: parent id ('' the top) -> its groups in order. Kept
  // until the server's list changes (it then has the move), dropped if the request fails.
  const [orderNow, setOrderNow] = useState<Record<string, string[]>>({})
  const sortCommit = useRef<(id: string, before: string | null) => void>(() => {})
  const sort = useGroupSort((id, before) => sortCommit.current(id, before))
  const serverCollapsed = (state?.groups as { collapsed?: string[] } | undefined)?.collapsed
  useEffect(() => {
    setFoldNow((p) => {
      const left = Object.fromEntries(Object.entries(p).filter(([id, f]) => f !== (serverCollapsed ?? []).includes(id)))
      return Object.keys(left).length === Object.keys(p).length ? p : left
    })
  }, [serverCollapsed])
  useEffect(() => setOrderNow({}), [state?.groups.groups])
  if (!state) return <StateWait />
  const presets = state.splits ?? []
  const byAll = new Map(state.sessions.map((s) => [s.id, s]))
  const hosts = new Map(state.hosts.map((h) => [h.id, h]))
  const multiHost = state.hosts.length > 1
  const q = filter.trim().toLowerCase()
  const match = (s: Session) => !q || [s.title, s.preview, s.cwd, s.last].some((x) => x?.toLowerCase().includes(q))
  const live = state.sessions.filter((s) => !s.closed)
  const byId = new Map(live.map((s) => [s.id, s]))
  const placed = new Set<string>()
  const groups = state.groups.groups.map((g) => {
    const items = g.items.map((id) => byId.get(id)).filter((s): s is Session => !!s)
    items.forEach((s) => placed.add(s.id))
    return { ...g, sessions: items }
  })
  const collapsed = new Set((state.groups as { collapsed?: string[] }).collapsed ?? [])
  const loose = [...state.groups.loose.map((id) => byId.get(id)).filter((s): s is Session => !!s && !placed.has(s.id)), ...live.filter((s) => !placed.has(s.id) && !state.groups.loose.includes(s.id))]
  // Put to rest: out of the group view (the one open now, and any a search finds, still show). They come back from
  // the group's menu or the button beside its +.
  const shown = (s: Session) => !s.resting || s.id === activeId || !!q
  const resting = (list: Session[]) => list.filter((s) => s.resting && s.id !== activeId)
  const ended = state.sessions
    .filter((s) => s.closed && match(s))
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, 30)
  const tree = groupTree(state.groups.groups)
  const groupList = tree.map((t) => ({ id: t.group.id, name: t.path }))
  const depthOf = new Map(tree.map((t) => [t.group.id, t.depth]))
  const byGroup = new Map(groups.map((g) => [g.id, g]))
  const childrenOf = (id: string | null) => {
    const ids = tree.filter((t) => (t.group.parent && depthOf.has(t.group.parent) ? t.group.parent : null) === id).map((t) => t.group.id)
    const now = orderNow[id ?? '']
    return now ? [...ids].sort((a, b) => now.indexOf(a) - now.indexOf(b)) : ids
  }
  /** Sessions in a group and in every group inside it: what its header counts. */
  const countIn = (id: string): number => (byGroup.get(id)?.sessions.length ?? 0) + childrenOf(id).reduce((n, c) => n + countIn(c), 0)
  /** What a group's header counts: the sessions it shows (not those put to rest). */
  const awakeIn = (id: string): number => (byGroup.get(id)?.sessions.filter((s) => !s.resting).length ?? 0) + childrenOf(id).reduce((n, c) => n + awakeIn(c), 0)
  /** Every session a group and the groups inside it hold, ended ones too: what emptying it deletes. */
  const heldIn = (id: string): number => (state.groups.groups.find((g) => g.id === id)?.items.length ?? 0) + childrenOf(id).reduce((n, c) => n + heldIn(c), 0)
  const within = (id: string, of: string): boolean => id === of || (!!byGroup.get(id)?.parent && within(byGroup.get(id)!.parent!, of))
  const unread = (s: Session) => s.id !== activeId && s.seq > (seen[s.id] ?? 0) && !(s as { lastMine?: boolean }).lastMine && (seen[s.id] ?? 0) > 0

  const drop = async (group: string | null, before: string | null) => {
    const id = dragId
    setDragId(null)
    setDropAt(null)
    if (!id || id === before) return
    await act(() => post('/api/groups', { op: 'move', session: id, group, before }))
  }
  const dropProps = (group: string | null, before: string | null) =>
    wide
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!dragId) return
            e.preventDefault()
            e.stopPropagation()
            if (dropAt?.group !== group || dropAt?.before !== before) setDropAt({ group, before })
          },
          onDrop: (e: React.DragEvent) => {
            // A dragged group is the group block's to take.
            if (!dragId) return
            e.preventDefault()
            e.stopPropagation()
            void drop(group, before)
          },
        }
      : {}

  const rows = (list: Session[], group: string | null) =>
    list
      .filter((s) => shown(s) && match(s))
      .map((s) => (
        <div key={s.id} {...dropProps(group, s.id)} onDragEnd={() => (setDragId(null), setDropAt(null))} className={dragId === s.id ? 'dragging' : undefined}>
          <SessionRow s={s} host={hosts.get(s.hostId)} active={s.id === activeId} unread={unread(s)} groups={groupList} onDragStart={wide ? setDragId : undefined} dropBefore={!!dragId && dropAt?.group === group && dropAt?.before === s.id} multiHost={multiHost} />
        </div>
      ))

  // Taking one back from rest: woken and opened, ready to use again.
  const wake = (s: Session) => void act(() => sessionPost(s, 'settings', { resting: false }), '휴면을 풀었어요').then((r) => r != null && openSession(s.id))
  // Each one put to rest: opened (woken) or removed (ended and deleted, as "목록에서 지우기" does).
  const restItems = (list: Session[]) =>
    list.map((s) => ({
      label: titleOf(s),
      icon: 'pop' as const,
      items: [
        { label: '열기', icon: 'pop' as const, hint: '깨워서', onSelect: () => wake(s) },
        {
          label: '제거하기',
          icon: 'trash' as const,
          danger: true,
          onSelect: async () => {
            if (await confirmDialog(`'${titleOf(s)}' 세션을 제거할까요?`, { text: '세션을 끝내고 목록과 맥의 화면 기록에서 지워요. Claude Code 대화 파일은 맥에 그대로예요.', ok: '제거하기', danger: true })) await act(() => del(`/api/sessions/${s.id}`), '제거했어요')
          },
        },
      ],
    }))
  // Beside +: instead of a new session, one put to rest is taken out (the first in the group's order) and opened.
  // Picking a particular one is the group menu's.
  const restButton = (list: Session[], always = false) =>
    (wide || always) && list.length ? <IconButton icon="pop" label={`휴면 세션 하나 꺼내 쓰기 · ${list.length}개 남음`} onClick={() => wake(list[0])} /> : null

  const nest = (id: string, parent: string | null) => act(() => post('/api/groups', { op: 'nest', id, parent }))
  const groupMenu = (g: { id: string; name: string; parent?: string }, at: HTMLElement) => {
    const depth = depthOf.get(g.id) ?? 1
    const height = groupHeight(state.groups.groups, g.id)
    // Where it may go: not inside itself, and no deeper than three levels with what it holds.
    const targets = tree.filter((t) => !within(t.group.id, g.id) && t.group.id !== g.parent && t.depth + height <= GROUP_DEPTH)
    // Up and down move it among the groups beside it: placed before the one above, or before the one after the
    // one below (null: last).
    const siblings = childrenOf(g.parent && depthOf.has(g.parent) ? g.parent : null)
    const sibIndex = siblings.indexOf(g.id)
    const order = (before: string | null) => act(() => post('/api/groups', { op: 'order', id: g.id, before }))
    const asleep = resting(byGroup.get(g.id)?.sessions ?? [])
    openMenu(
      [
        { label: '이 그룹에 새 세션', icon: 'plus', onSelect: () => navigate(`/new?group=${g.id}`) },
        ...(asleep.length ? [{ label: `휴면 세션 ${asleep.length}개`, icon: 'pop' as const, hint: '깨워서 열기', items: restItems(asleep) }] : []),
        ...(depth < GROUP_DEPTH
          ? [
              {
                label: '하위 그룹 만들기',
                icon: 'group' as const,
                onSelect: async () => {
                  const name = await promptDialog(`'${g.name}' 안에 새 그룹`, { placeholder: '그룹 이름', ok: '만들기' })
                  if (name) await act(() => post('/api/groups', { op: 'create', name, parent: g.id }), `'${name}' 그룹을 만들었어요`)
                },
              },
            ]
          : []),
        {
          label: '다른 그룹 안으로',
          icon: 'move',
          disabled: !targets.length,
          items: targets.map((t) => ({ label: t.path, onSelect: () => nest(g.id, t.group.id) })),
        },
        ...(g.parent ? [{ label: '맨 위로 빼기', icon: 'up' as const, onSelect: () => nest(g.id, null) }] : []),
        { label: '위로 옮기기', icon: 'arrowUp', disabled: !sibIndex, onSelect: () => void order(siblings[sibIndex - 1]) },
        { label: '아래로 옮기기', icon: 'arrowDown', disabled: sibIndex === siblings.length - 1, onSelect: () => void order(siblings[sibIndex + 2] ?? null) },
        'sep',
        {
          label: '이름 바꾸기',
          icon: 'edit',
          onSelect: async () => {
            const name = await promptDialog('그룹 이름', { value: g.name, ok: '바꾸기' })
            if (name) await act(() => post('/api/groups', { op: 'rename', id: g.id, name }))
          },
        },
        {
          label: '그룹 비우기',
          icon: 'trash',
          hint: '안의 세션 모두 지우기',
          danger: true,
          disabled: !heldIn(g.id),
          onSelect: async () => {
            const n = heldIn(g.id)
            const live = countIn(g.id)
            if (
              await confirmDialog(`'${g.name}' 그룹을 비울까요?`, {
                text: `안의 세션 ${n}개${childrenOf(g.id).length ? '를 하위 그룹 것까지' : '를'} 모두 지워요.${live > 0 ? ` 돌아가는 세션 ${live}개는 끝낸 뒤 지워요.` : ''} 그룹은 그대로 남아요. 맥에 있는 대화 파일은 남아서 "맥의 대화 이어 가기" 로 다시 열 수 있어요.`,
                ok: '모두 지우기',
                danger: true,
              })
            )
              await act(() => post('/api/groups', { op: 'empty', id: g.id }))
          },
        },
        {
          label: '그룹 지우기',
          icon: 'trash',
          danger: true,
          onSelect: async () => {
            if (await confirmDialog(`'${g.name}' 그룹을 지울까요?`, { text: g.parent ? '안의 세션과 그룹은 한 단계 위 그룹으로 옮겨져요.' : '안의 세션과 그룹은 그룹 밖(맨 위)으로 나와요.', ok: '지우기', danger: true })) await act(() => post('/api/groups', { op: 'delete', id: g.id }))
          },
        },
      ],
      at,
      g.name,
    )
  }

  sortCommit.current = (id, before) => {
    const parent = byGroup.get(id)?.parent
    const level = parent && depthOf.has(parent) ? parent : null
    const ids = childrenOf(level).filter((x) => x !== id)
    const at = before ? ids.indexOf(before) : -1
    ids.splice(at < 0 ? ids.length : at, 0, id)
    flushSync(() => setOrderNow((p) => ({ ...p, [level ?? '']: ids })))
    void act(() => post('/api/groups', { op: 'order', id, before })).then((r) => r == null && setOrderNow({}))
  }

  const toggleFold = (id: string, folded: boolean) => {
    setFoldNow((p) => ({ ...p, [id]: !folded }))
    void act(() => post('/api/groups', { op: 'fold', id, open: folded })).then((r) => {
      if (r == null) setFoldNow(({ [id]: _, ...p }) => p)
    })
  }
  // The section of sessions in no group folds like a group, kept on the server under the id 'loose'.
  const looseFolded = foldNow.loose ?? collapsed.has('loose')

  const renderGroup = (id: string): React.ReactNode => {
    const g = byGroup.get(id)
    if (!g) return null
    const depth = depthOf.get(id) ?? 1
    const folded = foldNow[id] ?? collapsed.has(id)
    const kids = childrenOf(id)
    return (
      <div key={id} className="group-block" data-gid={id} style={{ ['--depth' as string]: depth - 1 }} {...dropProps(id, null)}>
        {/* Held (a finger) or dragged (a mouse), the head moves the group among the ones beside it. */}
        <div className="group-head" {...sort.headProps(id)} onContextMenu={(e) => (e.preventDefault(), !sort.holding() && groupMenu(g, e.currentTarget as HTMLElement))}>
          <SectionHeader
            title={
              <>
                {g.name}
                <span className="section-count">{awakeIn(id)}</span>
              </>
            }
            folded={folded}
            onClick={() => toggleFold(id, folded)}
            right={
              <>
                {/* The menu's first item, one tap away: a new session in this group (a PC's; a phone has it in ⋯). */}
                {wide ? <IconButton icon="plus" label="이 그룹에 새 세션" onClick={() => navigate(`/new?group=${g.id}`)} /> : null}
                {restButton(resting(g.sessions))}
                <IconButton icon="more" label="그룹 메뉴" onClick={(e) => groupMenu(g, e.currentTarget)} />
              </>
            }
          />
        </div>
        {/* What the group holds sits under its head, one step in, with a line along the left: the tree reads at a
            glance. It grows open and shrinks shut. */}
        <Collapse open={!folded}>
          <div className="group-kids">
            {kids.map(renderGroup)}
            {rows(g.sessions, id)}
            {!g.sessions.some(shown) && !kids.length ? <div className="row-sub" style={{ padding: '2px 14px 8px', fontSize: 'var(--fs-small)', color: 'var(--faint)' }}>{g.sessions.length ? `휴면 세션 ${resting(g.sessions).length}개 · ${wide ? '그룹 우클릭' : '그룹 ⋯'}에서 깨워요` : wide ? '세션을 끌어다 놓으세요' : '세션 메뉴 → 그룹에서 넣을 수 있어요'}</div> : null}
          </div>
        </Collapse>
      </div>
    )
  }

  const empty = !live.length && !ended.length
  const looks = live.map((x) => look(x, hosts.get(x.hostId)))
  // 최신순: the favourites first, in a section of their own, then the rest; each by its last movement.
  const newest = live.filter(match).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
  const favorites = newest.filter((s) => s.favorite)
  const others = newest.filter((s) => !s.favorite)
  const recentRow = (s: Session) => <SessionRow key={s.id} s={s} host={hosts.get(s.hostId)} active={s.id === activeId} unread={unread(s)} groups={groupList} multiHost={multiHost} />
  const busyCount = looks.filter((l) => l.tone === 'blue').length
  const needCount = looks.filter((l) => l.need).length
  return (
    <div className="list">
      {/* How many sessions there are, and how many are working or waiting for the person. The Macs themselves are
          on the 기기 page; only "none connected" is said here, since nothing can run then. */}
      {/* A phone keeps only what asks for attention here (the count and the view switch are a PC's; a phone's
          view is in the app menu). The line stays, empty, when there is none: dropping it moved the whole list
          down the moment the first session started working. */}
      <div className="list-summary" aria-live="polite">
        {wide ? (
          <span>
            세션 <b>{live.length}</b>개
          </span>
        ) : null}
        {busyCount ? <span className="sum-busy">작업 중 {busyCount}</span> : null}
        {needCount ? <span className="sum-need">응답 대기 {needCount}</span> : null}
        {state.hosts.length && !state.hosts.some((h) => h.online) ? (
          <a className="sum-off" href={href({ name: 'hosts' })}>
            연결된 맥 없음
          </a>
        ) : null}
        {wide ? (
          <span className="list-view">
            <Segmented
              label="목록 보기"
              value={view}
              onChange={(v) => setListView(v)}
              options={[
                { value: 'group', label: '그룹' },
                { value: 'recent', label: '최신순' },
              ]}
            />
          </span>
        ) : null}
      </div>
      {/* 분할 조합 (REQ-F-790): where two panes fit, the saved sets open from the top of the list. */}
      {wide && presets.length > 0 && splitRoom() >= 2 ? (
        <div className="split-presets-list">
          <SectionHeader
            title={`분할 조합 · ${presets.length}`}
            right={<IconButton icon="more" label="분할 조합 관리" onClick={(e) => openMenu(presets.map((p) => ({ label: p.name, icon: 'columns', items: presetActions(p) })), e.currentTarget, '분할 조합')} />}
          />
          {presets.map((p) => (
            <Row
              key={p.id}
              className="split-preset"
              left={<Icon name="columns" />}
              title={p.name}
              sub={p.ids.map((id) => { const s = byAll.get(id); return s && !s.closed ? titleOf(s) : '(끝난 세션)' }).join(' · ')}
              onClick={() => openPreset(p)}
              onContextMenu={(e) => (e.preventDefault(), openMenu(presetActions(p), { x: e.clientX, y: e.clientY }, p.name))}
            />
          ))}
        </div>
      ) : null}
      {empty ? (
        <div className="empty" style={{ padding: '32px 12px' }}>
          <p className="empty-title" style={{ fontSize: 'var(--fs-large)' }}>
            세션이 없어요
          </p>
          <div className="empty-text">새 세션을 시작해 보세요.</div>
        </div>
      ) : null}
      {view === 'recent' && live.length ? (
        // 최신순: no groups, every open session by its last movement, newest first, and no dragging. Favourites
        // (REQ-F-782) come first under their own head.
        <div>
          {favorites.length ? (
            <div className="recent-favorites">
              <SectionHeader title={`즐겨찾기 · ${favorites.length}`} />
              {favorites.map(recentRow)}
            </div>
          ) : null}
          <SectionHeader title={`최신순 · ${others.length}`} />
          {wide ? (
            <div className="row-sub" style={{ padding: '0 14px 6px', fontSize: 'var(--fs-small)', color: 'var(--faint)' }}>
              마지막으로 움직인 순서예요
            </div>
          ) : null}
          {others.map(recentRow)}
        </div>
      ) : null}
      {view === 'group' ? childrenOf(null).map(renderGroup) : null}
      {view !== 'group' ? null : loose.length ? (
        <div {...dropProps(null, null)}>
          {groups.length ? (
            <SectionHeader title={`그룹 없음 · ${loose.filter((s) => !s.resting).length}`} folded={looseFolded} onClick={() => toggleFold('loose', looseFolded)} right={restButton(resting(loose), true) ?? undefined} />
          ) : (
            <SectionHeader
              title={`세션 · ${loose.filter((s) => !s.resting).length}`}
              folded={looseFolded}
              onClick={() => toggleFold('loose', looseFolded)}
              right={
                <>
                  {restButton(resting(loose), true)}
                  <IconButton icon="group" label="새 그룹" onClick={newGroup} />
                </>
              }
            />
          )}
          <Collapse open={!looseFolded}>
            <div>{rows(loose, null)}</div>
          </Collapse>
        </div>
      ) : groups.length ? (
        <div {...dropProps(null, null)} style={{ minHeight: dragId ? 40 : 0 }} />
      ) : null}
      {ended.length ? (
        <>
          <SectionHeader title={`이어서 하기 · ${ended.length}`} folded={!showEnded} onClick={() => setShowEnded((endedOpen = !showEnded))} />
          {showEnded ? ended.map((s) => <SessionRow key={s.id} s={s} host={hosts.get(s.hostId)} active={s.id === activeId} unread={false} groups={groupList} multiHost={multiHost} />) : null}
        </>
      ) : null}
    </div>
  )
}

type ListView = 'group' | 'recent'
const VIEW_EVENT = 'cb-list-view'
export const listView = (): ListView => (getPref<string>('listView', 'group') === 'recent' ? 'recent' : 'group')
/** The list's view (그룹 / 최신순), remembered; every list on the page follows it. */
export function setListView(v: ListView) {
  setPref('listView', v)
  dispatchEvent(new Event(VIEW_EVENT))
}

export async function newGroup() {
  const name = await promptDialog('새 그룹', { placeholder: '그룹 이름', ok: '만들기' })
  if (name) await act(() => post('/api/groups', { op: 'create', name }), `'${name}' 그룹을 만들었어요`)
}

export const openSession = (id: string) => go({ name: 'session', id })
