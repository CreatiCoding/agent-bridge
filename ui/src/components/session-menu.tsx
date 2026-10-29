// What can be done to a session, as one menu: the ⋯ in the conversation header, a right-click or a long press
// on its row. Each item says plainly what it does; the ones that cannot be undone ask first.
import { del, errorText, get, post } from '../lib/api'
import { go } from '../lib/router'
import { hostIcon, KINDS, titleOf } from '../lib/sessions'
import { getStore } from '../lib/store'
import { featureOn } from '../lib/features'
import { bytes, tokens } from '../lib/format'
import type { Session } from '../lib/types'
import { chooseDialog, confirmDialog, type MenuEntry, promptDialog, toast } from '../kit/overlay'
import { Icon, type IconName } from '../kit'
import { tokenOf } from '../lib/locks'
import { clearLock, lockSession, relock } from './lock'
import { confirmCopyMode } from './auto-allow-confirm'
import { openCwd } from './cwd-sheet'
import { TODO_ASK, TODO_REASK } from './session-extras'

export async function act<T = { ok: true; note?: string }>(run: () => Promise<T>, done?: string | ((r: T) => string | undefined)) {
  try {
    const r = await run()
    const text = typeof done === 'function' ? done(r) : (done ?? (r as { note?: string })?.note)
    if (text) toast(text)
    return r
  } catch (e) {
    toast(errorText(e), { tone: 'bad' })
    return null
  }
}

/**
 * Put a session to rest or take it back. Put to rest from its own page, it is out of the way at once: the page goes
 * back to the list (where it no longer shows).
 */
export async function toggleRest(s: Session) {
  const rest = !s.resting
  const r = await act(() => sessionPost(s, 'settings', { resting: rest }), rest ? '휴면으로 뒀어요 · 그룹 메뉴에서 깨워요' : '휴면을 풀었어요')
  if (r != null && rest && location.pathname === `/s/${s.id}`) go({ name: 'home' })
}

/** Mark a session as a favourite or take the mark off: favourites lead the newest-first list (REQ-F-782). */
export const toggleFavorite = (s: Session) => act(() => sessionPost(s, 'settings', { favorite: !s.favorite }), s.favorite ? '즐겨찾기에서 뺐어요' : '즐겨찾기에 넣었어요 · 최신순 맨 위에 보여요')

/** End a session, always after asking (the ⋯ menu and a tab's ×). True when it was ended. */
export async function endSession(s: Session) {
  if (!(await confirmDialog(`"${titleOf(s)}" 세션을 끝낼까요?`, { text: '대화는 남아요. 나중에 이어서 열 수 있어요.', ok: '끝내기', danger: true }))) return false
  return (await act(() => sessionPost(s, 'close'), '끝냈어요')) != null
}

/** A command the server runs as the page's ⋯ used to: the same words and checks for every page. */
export const command = (s: Session, cmd: string, arg = '') => post<{ ok: true; note?: string }>(`/api/sessions/${s.id}/do`, { cmd, arg })
export const sessionPost = <T = { ok: true; note?: string }>(s: Session, op: string, body: Record<string, unknown> = {}) => post<T>(`/api/sessions/${s.id}/${op}`, body)

export async function rename(s: Session) {
  const name = await promptDialog('이름 바꾸기', { value: s.title, placeholder: '세션 이름', ok: '바꾸기' })
  if (name != null) await act(() => sessionPost(s, 'settings', { title: name.trim() }), '이름을 바꿨어요')
}

/** Where a move goes, drawn: from here, an arrow, to there. */
function MoveRoute({ from, to, what, note }: { from: { icon: IconName; name: string; sub: string }; to: { icon: IconName; name: string; sub: string }; what: string; note: string }) {
  const end = (x: typeof from, cls: string) => (
    <div className={`move-end ${cls}`}>
      <Icon name={x.icon} />
      <b>{x.name}</b>
      <span>{x.sub}</span>
    </div>
  )
  return (
    <div className="move-route-box">
      <div className="move-route">
        {end(from, 'from')}
        <span className="move-arrow" aria-label="에서">
          <Icon name="forward" />
        </span>
        {end(to, 'to')}
      </div>
      <div className="move-what">{what}</div>
      <div className="muted">{note}</div>
    </div>
  )
}

/** The choice that means Slack, among the Macs (a host id is never this). */
const SLACK = ':slack'
/** Slack can take the session: the plugin is on and the session is not locked. */
export const canSlack = (s: Session) => featureOn('slack') && (getStore().state?.places ?? []).includes('slack') && !s.locked

/** Where to move the session: another Mac, or Slack (its channel's thread), in one list. */
export async function moveTo(s: Session) {
  const all = getStore().state?.hosts ?? []
  const here = all.find((h) => h.id === s.hostId)
  // features.sessionMove off (REQ-F-812): another Mac is not offered, Slack still is.
  const hosts = featureOn('sessionMove') ? all.filter((h) => h.id !== s.hostId) : []
  const slack = canSlack(s)
  if (!hosts.length && !slack) return toast('옮길 다른 맥이 없어요. 다른 맥에서 이 사이트를 열어 연결해 주세요')
  const to = await chooseDialog(
    '옮기기',
    [
      ...hosts.map((h) => ({
        value: h.id,
        label: (
          <span className="move-pick">
            <Icon name={hostIcon(h.kind)} /> {h.name}(으)로 옮기기
          </span>
        ),
        hint: `${KINDS[h.kind] ?? '기타'} · ${h.online ? '연결됨' : '연결 끊김 — 붙으면 옮길 수 있어요'}`,
      })),
      ...(slack
        ? [
            {
              value: SLACK,
              label: (
                <span className="move-pick">
                  <Icon name="send" /> Slack 으로 옮기기
                </span>
              ),
              hint: '전용 채널의 이 세션 스레드에서 이어서 · 이 화면은 읽기만, 언제든 브릿지로 가져와요',
            },
          ]
        : []),
    ],
    <MoveRoute
      from={{ icon: hostIcon(here?.kind ?? ''), name: here?.name ?? '지금 맥', sub: '지금 여기서 도는 중' }}
      to={{ icon: 'move', name: '아래에서 고르기', sub: hosts.length && slack ? '받는 맥 또는 Slack' : slack ? 'Slack' : '받는 맥' }}
      what={`옮길 세션: ${titleOf(s)}`}
      note="다른 맥: 지금 맥에서 마지막으로 싱크한 뒤 받는 맥에서 같은 대화로 이어서 열고, 지금 맥의 세션은 내려놓아요. Slack: 같은 맥에서 돌면서 Slack 스레드에서 이어서 작업해요."
    />,
  )
  if (!to) return
  if (to === SLACK) return seatSlack(s)
  const target = hosts.find((h) => h.id === to)
  const dest = target?.name ?? '받는 맥'
  // A Mac with several Claude accounts: which one takes the session there (its main one unless picked).
  const usable = (target?.accounts ?? []).filter((a) => a.loggedIn !== false)
  let account = ''
  if (usable.length > 1) {
    const pick = await chooseDialog(`${dest} 의 어느 Claude 계정에서 열까요?`, usable.map((a) => ({ value: a.id || MAIN, label: a.name, hint: a.main ? '기본 계정' : undefined })))
    if (!pick) return
    account = pick === MAIN ? '' : pick
  }
  toast(`${here?.name ?? '지금 맥'} → ${dest} 로 옮기는 중이에요…`)
  await act(() => sessionPost<{ ok: true; warnings?: string[] }>(s, 'move', { hostId: to, ...(account ? { account } : {}) }), (r) => (r.warnings?.length ? `${dest}(으)로 옮겼어요 · 확인할 것: ${r.warnings.join(' / ')}` : `${dest}(으)로 옮겼어요`))
}

/** The choice that means a Mac's main account in a dialog (an option's value cannot be empty). */
const MAIN = ':main'
/** The name of the Claude account a session runs in, on its Mac. */
export function accountOf(s: Session) {
  const host = getStore().state?.hosts.find((h) => h.id === s.hostId)
  return (host?.accounts ?? []).find((a) => a.id === (s.account ?? '')) ?? null
}

/**
 * Another Claude account on the same Mac (설정 → Claude 계정): the conversation goes over as it is, like a move to
 * another Mac. The session's transcript is written into that account's folder and resumed there.
 */
export async function moveAccount(s: Session) {
  const host = getStore().state?.hosts.find((h) => h.id === s.hostId)
  const now = s.account ?? ''
  const others = (host?.accounts ?? []).filter((a) => a.id !== now)
  if (!others.length) return toast('이 맥에 다른 Claude 계정이 없어요. 설정 → Claude 계정에서 더해 주세요')
  const from = accountOf(s)
  const to = await chooseDialog(
    '다른 계정으로 옮기기',
    others.map((a) => ({ value: a.id || MAIN, label: a.name, hint: a.loggedIn === false ? '로그인이 필요해요 — 설정 → Claude 계정' : a.main ? '기본 계정' : undefined })),
    <MoveRoute
      from={{ icon: 'user', name: from?.name ?? '지금 계정', sub: '지금 이 계정으로 도는 중' }}
      to={{ icon: 'user', name: '아래에서 고르기', sub: `같은 맥(${host?.name ?? ''})의 다른 계정` }}
      what={`옮길 세션: ${titleOf(s)}`}
      note="마지막으로 싱크한 대화를 그 계정의 기록 폴더에 옮기고 같은 대화로 이어서 열어요. 되감기용 파일 사본도 같이 옮겨요. 사용량 한도는 그 계정 것을 써요."
    />,
  )
  if (!to) return
  const account = to === MAIN ? '' : to
  const name = others.find((a) => a.id === account)?.name ?? '그 계정'
  toast(`${name} 계정으로 옮기는 중이에요…`)
  await act(() => sessionPost<{ ok: true; warnings?: string[] }>(s, 'move', { hostId: s.hostId, account }), (r) => (r.warnings?.length ? `${name}(으)로 옮겼어요 · 확인할 것: ${r.warnings.join(' / ')}` : `${name} 계정으로 옮겼어요`))
}

/** Where the session is worked on: one place at a time, the bridge or Slack. */
export const inSlack = (s: Session) => s.seat?.where === 'slack'
const openUrl = (url: string) => window.open(url, '_blank', 'noopener')

export async function toSlack(s: Session) {
  const ok = await confirmDialog('Slack 으로 옮길까요?', {
    text: (
      <MoveRoute
        from={{ icon: 'laptop', name: '브릿지', sub: '지금 여기서 작업 중' }}
        to={{ icon: 'send', name: 'Slack', sub: '전용 채널의 스레드' }}
        what={`옮길 세션: ${titleOf(s)}`}
        note='Slack 전용 채널의 이 세션 스레드에서 이어서 작업해요(없으면 새로 만들어요). 옮긴 뒤 이 화면은 읽기만 할 수 있어요. 스레드의 "브릿지로 옮기기" 나 이 화면의 "브릿지로 가져오기" 로 언제든 돌아와요.'
      />
    ),
    ok: 'Slack 으로 옮기기',
  })
  if (ok) await seatSlack(s)
}

async function seatSlack(s: Session) {
  try {
    const r = await sessionPost<{ ok: true; url: string | null }>(s, 'seat', { to: 'slack' })
    toast('Slack 으로 옮겼어요', r.url ? { action: { label: 'Slack 열기', run: () => openUrl(r.url ?? '') } } : {})
  } catch (e) {
    toast(errorText(e), { tone: 'bad' })
  }
}

export const toBridge = (s: Session) => act(() => sessionPost(s, 'seat', { to: 'web' }), '브릿지로 가져왔어요. 이제 여기서 이어서 써요')

export async function trash(s: Session) {
  const info = await act(() => get<{ ok: true; cwd: string; repos: { dir: string; uncommitted: number; unpushed: number }[] }>(`/api/sessions/${s.id}/trash`))
  if (!info) return
  const risky = info.repos.filter((r) => r.uncommitted || r.unpushed)
  const ok = await confirmDialog('폴더를 휴지통으로 옮기고 끝낼까요?', {
    text: `${info.cwd}\n${risky.length ? `\n⚠️ 아직 올리지 않은 것이 있어요:\n${risky.map((r) => `· ${r.dir}: 커밋 안 한 변경 ${r.uncommitted}개, push 안 한 커밋 ${r.unpushed}개`).join('\n')}` : '\n커밋 안 한 변경이나 push 안 한 커밋은 없어요.'}\n\n맥의 휴지통에서 되살릴 수 있어요.`,
    ok: '휴지통으로',
    danger: true,
  })
  if (ok) await act(() => sessionPost(s, 'trash'))
}

/**
 * 할 일 정리 (REQ-F-778): asks the session for its done and remaining work. A session started before the bridge MCP had
 * its todos tool (rule 9) is reopened first, so the request reaches a Claude that has it: said while it reopens (or
 * waits to), the request is held and handed to the session that comes back. `again` (a list is already there) asks
 * it to check the open items against now (rule 6a). The session page passes its own send, which shows the bubble.
 */
export async function askTodos(s: Session, again = false, send?: (text: string) => Promise<boolean>) {
  const busy = s.state.alive && s.state.phase === 'busy'
  const later = busy || (s.bg?.length ?? 0) > 0
  const noTool = s.state.alive && !s.state.bridgeTools?.includes('mcp__bridge__todos') && !s.sawTodosTool
  if (noTool) {
    try {
      await sessionPost(s, 'refresh', { when: later ? 'later' : 'now' })
    } catch (e) {
      toast(errorText(e), { tone: 'bad' })
      return false
    }
  }
  const text = again ? TODO_REASK : TODO_ASK
  const ok = send ? await send(text) : (await act(() => sessionPost(s, 'say', { text, images: [] }), () => undefined)) != null
  if (ok) toast(!noTool ? '할 일 정리를 부탁했어요' : later ? '하던 일이 끝나면 세션을 다시 열어 할 일 도구를 붙이고 정리를 부탁할게요' : '세션을 다시 열어 할 일 도구를 붙이고 정리를 부탁했어요')
  return ok
}

/** Why 할 일 정리 cannot be sent now, or undefined when it can. */
export const todoBlocked = (s: Session) => {
  const host = getStore().state?.hosts.find((h) => h.id === s.hostId)
  return inSlack(s) ? 'Slack 에서 작업 중이에요' : s.closed ? '끝난 세션이에요' : s.moving ? '옮기는 중이에요' : host && !host.online ? '맥이 연결돼 있지 않아요' : undefined
}

export function sessionMenu(s: Session, opts: { groups?: { id: string; name: string }[]; noRefresh?: boolean; noTodos?: boolean } = {}): MenuEntry[] {
  const host = getStore().state?.hosts.find((h) => h.id === s.hostId)
  const live = !s.closed && !!host?.online
  // In Slack the session is only read here: what would drive it waits until it is brought back.
  const away = inSlack(s)
  const alive = live && s.state.alive && !away
  const others = (getStore().state?.hosts ?? []).filter((h) => h.id !== s.hostId)
  const slackOn = (getStore().state?.places ?? []).includes('slack')
  const seat: MenuEntry | null = !away && !featureOn('slack') ? null : away
    ? { label: '브릿지로 가져오기', icon: 'move', hint: 'Slack 대신 여기서', onSelect: () => toBridge(s) }
    : { label: 'Slack 으로 옮기기', icon: 'move', hint: !slackOn ? 'Slack 플러그인을 켜야 해요' : s.locked ? '잠긴 세션은 못 옮겨요' : '전용 채널에서 이어서', disabled: !canSlack(s), onSelect: () => toSlack(s) }
  if (s.closed)
    return [
      away ? { label: '이어서 열기 (브릿지로 가져온 뒤)', icon: 'play', disabled: true } : { label: '이어서 열기', icon: 'play', onSelect: () => resume(s) },
      ...(away && seat ? [seat] : []),
      { label: '이름 바꾸기', icon: 'edit', onSelect: () => rename(s) },
      'sep',
      {
        label: '목록에서 지우기',
        icon: 'trash',
        danger: true,
        onSelect: async () => {
          if (await confirmDialog('이 세션을 목록에서 지울까요?', { text: '맥에 둔 화면 기록도 지워요. Claude Code 대화 파일은 맥에 그대로예요.', ok: '지우기', danger: true })) await act(() => del(`/api/sessions/${s.id}`), '지웠어요')
        },
      },
    ]
  const groups = opts.groups ?? []
  return [
    { label: '이름 바꾸기', icon: 'edit', onSelect: () => rename(s) },
    {
            label: '그룹',
            icon: 'group' as const,
            items: [
              ...groups.map((g) => ({ label: g.name, onSelect: () => act(() => post('/api/groups', { op: 'move', session: s.id, group: g.id })) })),
              { label: '그룹에서 빼기', onSelect: () => act(() => post('/api/groups', { op: 'move', session: s.id, group: null })) },
              {
                label: '새 그룹에 넣기…',
                icon: 'plus' as const,
                onSelect: async () => {
                  const name = await promptDialog('새 그룹', { placeholder: '그룹 이름', ok: '만들기' })
                  if (!name) return
                  const r = await act(() => post<{ ok: true; id: string }>('/api/groups', { op: 'create', name }))
                  if (r) await act(() => post('/api/groups', { op: 'move', session: s.id, group: r.id }), `'${name}' 에 넣었어요`)
                },
              },
            ],
          },
    'sep',
    // A wide session page has 새로고침 as a header button instead.
    ...(opts.noRefresh ? [] : [{ label: '새로고침', icon: 'refresh' as const, hint: '대화 그대로 다시 열기', disabled: !alive, onSelect: () => refresh(s) }]),
    // The session page puts its own near the top (it knows whether a list is already there); a row's menu, the only
    // way to it on a phone's list, asks as a first 정리.
    ...(opts.noTodos ? [] : [{ label: '할 일 정리', icon: 'list' as const, hint: '지금까지 한 일·남은 일', disabled: !!todoBlocked(s), onSelect: () => void askTodos(s) }]),
    // The same /compact as the big-context banner (REQ-F-776), at any size: the server takes it only while it rests.
    {
      label: '지금 압축',
      icon: 'sparkle',
      hint: !alive ? undefined : s.state.phase !== 'idle' ? '쉬고 있을 때만' : s.state.cache?.ctx ? `컨텍스트 ${tokens(s.state.cache.ctx)} · 이 세션에서 그대로` : '대화를 요약해 이 세션에서 그대로',
      disabled: !alive || s.state.phase !== 'idle',
      onSelect: () => act(() => command(s, 'compact')),
    },
    {
      label: '복제',
      icon: 'fork',
      hint: '같은 대화에서 갈라진 새 세션',
      disabled: !alive,
      onSelect: async () => (await confirmCopyMode(s)) && act(() => sessionPost<{ ok: true; id: string }>(s, 'fork'), '복제한 세션을 띄웠어요').then((r) => r && go({ name: 'session', id: r.id })),
    },
    {
      label: '가벼운 복제',
      icon: 'sparkle',
      hint: 'SESSION.md 로 새 세션',
      disabled: !alive,
      onSelect: () => void lightCopy(s),
    },
    {
      label: '대화 기록 정리',
      icon: 'doc',
      hint: !alive ? undefined : s.state.phase !== 'idle' ? '쉬고 있을 때만' : s.state.size ? `${bytes(s.state.size)} · 압축 전 기록을 덜어 내고 이 세션에서 그대로` : '압축 전 기록을 덜어 내고 이 세션에서 그대로',
      disabled: !alive || s.state.phase !== 'idle',
      onSelect: () => void trimLog(s),
    },
    ...(featureOn('sessionMove') ? [{ label: others.length ? '다른 맥으로 옮기기' : '다른 맥으로 옮기기 (다른 맥 없음)', icon: 'move' as const, disabled: !alive || !others.length || s.state.phase === 'busy', onSelect: () => moveTo(s) }] : []),
    // Shown where the Mac has more than one Claude account (설정 → Claude 계정).
    ...((host?.accounts?.length ?? 0) > 1 ? [{ label: '다른 계정으로 옮기기', icon: 'user' as const, hint: `지금: ${accountOf(s)?.name ?? '기본 계정'}`, disabled: !alive || s.state.phase === 'busy', onSelect: () => moveAccount(s) }] : []),
    { label: '작업 폴더 바꾸기', icon: 'folder', hint: '같은 맥의 다른 폴더에서 이어서', disabled: !live || away || s.state.phase === 'busy', onSelect: () => openCwd(s) },
    ...(seat ? [seat] : []),
    'sep',
    away
      ? { label: '잠그기', icon: 'key' as const, hint: 'Slack 에서 작업 중', disabled: true }
      : s.locked
      ? {
          label: '잠금',
          icon: 'key' as const,
          items: [
            ...(tokenOf(s.id) ? [{ label: '이 탭에서 다시 잠그기', onSelect: () => relock(s) }] : []),
            { label: '잠금 없애기…', onSelect: () => clearLock(s) },
          ],
        }
      : { label: '잠그기', icon: 'key' as const, hint: '비밀번호로 가리기', onSelect: () => lockSession(s) },
    { label: s.favorite ? '즐겨찾기 빼기' : '즐겨찾기', icon: 'star', hint: s.favorite ? undefined : '최신순 맨 위에', onSelect: () => toggleFavorite(s) },
    { label: s.resting ? '휴면 풀기' : '휴면', icon: s.resting ? 'pop' : 'push', hint: s.resting ? undefined : '그룹 목록에서 숨김', onSelect: () => toggleRest(s) },
    { label: '이 세션의 로그', icon: 'list', onSelect: () => go({ name: 'host', id: s.hostId, sid: s.id }) },
    'sep',
    {
      label: '종료',
      icon: 'stop',
      danger: true,
      disabled: s.closed,
      onSelect: () => void endSession(s),
    },
    { label: '폴더 버리고 종료', icon: 'trash', danger: true, disabled: !live || away, onSelect: () => trash(s) },
  ]
}

/** 가벼운 복제 (REQ-F-402): a new session that picks up from SESSION.md. */
export async function lightCopy(s: Session) {
  return (await confirmCopyMode(s)) && act(() => command(s, 'lightfork'))
}

/**
 * 대화 기록 정리 (REQ-F-793): the Mac moves what came before the last compaction out of the .jsonl and opens the same
 * session again. Asked first: the session restarts, and a rewind cannot reach back past that compaction any more.
 */
export async function trimLog(s: Session) {
  const ok = await confirmDialog('대화 기록을 정리할까요?', {
    text: '마지막 압축 앞의 기록을 기록 파일에서 덜어 내고(맥의 ~/.claude-bridge/trimmed/ 에 원본을 그대로 둬요) 이 세션을 다시 열어요. 대화는 압축 요약에서 그대로 이어지고 이 화면의 대화도 그대로예요. 압축한 적이 없으면 먼저 "지금 압축" 을 하세요.',
    ok: '정리하기',
  })
  if (ok) await act(() => sessionPost(s, 'trimlog'))
}

export async function refresh(s: Session) {
  const busy = s.state.phase === 'busy'
  const bg = s.bg ?? []
  // Nothing to cut and nothing booked: the only choice would be 지금 새로고침, so pressing it refreshes.
  if (!busy && !bg.length && !s.state.refreshAfter) return void (await act(() => sessionPost(s, 'refresh', { when: 'now' }), '다시 여는 중이에요'))
  const pick = await chooseDialog(
    '새로고침',
    [
      { value: 'now', label: '지금 새로고침', hint: busy ? '하던 턴을 끊고 다시 열어요' : '대화 그대로 다시 열어요', danger: busy || bg.length > 0 },
      ...(busy || bg.length ? [{ value: 'later', label: '끝나면 새로고침', hint: '턴과 백그라운드 작업이 끝난 뒤에' }] : []),
      ...(s.state.refreshAfter ? [{ value: 'cancel', label: '예약 취소' }] : []),
    ],
    bg.length ? `백그라운드 작업 ${bg.length}개가 돌고 있어요: ${bg.map((t) => t.label).join(', ')}. 지금 새로고침하면 끊겨요.` : undefined,
  )
  if (pick) await act(() => sessionPost(s, 'refresh', { when: pick }), pick === 'now' ? '다시 여는 중이에요' : pick === 'later' ? '끝나면 새로고침해요' : '예약을 취소했어요')
}

export async function resume(s: Session) {
  const hosts = (getStore().state?.hosts ?? []).filter((h) => h.online && (featureOn('sessionMove') || h.id === s.hostId))
  if (!hosts.length) return toast('연결된 맥이 없어요')
  // The conversation is on its own Mac only (REQ-S-069): another Mac can open it only while that one is connected.
  if (!hosts.some((h) => h.id === s.hostId)) return toast('이 세션의 맥이 연결돼 있어야 다시 열 수 있어요')
  let target = hosts.find((h) => h.id === s.hostId)?.id
  if (!target || hosts.length > 1) {
    target =
      (await chooseDialog(
        '어느 맥에서 이어서 열까요?',
        hosts.map((h) => ({ value: h.id, label: h.name, hint: h.id === s.hostId ? '원래 맥' : '원래 맥에서 대화를 받아 열어요' })),
      )) ?? undefined
  }
  if (!target) return
  toast('여는 중이에요…')
  await act(() => sessionPost(s, 'resume', { hostId: target }), '다시 열었어요')
}

export const sessionTitle = titleOf
