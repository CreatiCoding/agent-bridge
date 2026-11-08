// What the session page's status line says while a turn runs (REQ-F-874): what is going on when it can be told,
// "작업 중 · 상태 업데이트 없음" when it cannot, and the turn's whole time apart from the time since anything last moved.
// Everything comes from what the page already has (the session's state, its timeline, the link): no extra asking.

/** From this long without anything new, the line also says "마지막 활동 … 전". */
export const ACTIVITY_QUIET_MS = 60_000
/** A link down this briefly is a reconnect, not worth a word (the app's own banner waits as long). */
export const LINK_DOWN_MS = 8_000
/** What a runner without hooks gets when nothing tells what it is doing. */
export const NO_UPDATE = '작업 중 · 상태 업데이트 없음'

export interface ActivityInput {
  now: number
  phase: string
  turnAt: number | null
  waiting: string | null
  waitingSince: number | null
  tool: { name: string | null; title: string | null; at: number | null } | null
  compacting?: boolean
  /** The runner says what it is doing through hooks (Claude Code). Without them "생각하는 중" is only a guess. */
  hooks: boolean
  hostOnline: boolean
  link: string
  downSince: number | null
  /** When the latest timeline item of this turn came (0 when none did). */
  lastItemAt: number
  /** This turn's timeline shows a tool that has not ended (its row says "도는 중"). */
  toolRunning?: boolean
}

/** The last thing that showed in this turn: what it was and when (REQ-F-874 규칙 6). */
export interface LastSeen {
  what: string
  at: number
}

/** The few fields of a timeline item this needs (ui/src/lib/timeline.ts Item). */
type SeenItem = { t: string; at: number; name?: string; label?: string; text?: string; done?: boolean }

const LAST_WHAT_MAX = 60
const firstLine = (s: string) =>
  (s.split('\n').find((l) => l.trim()) ?? '')
    .replace(/\*\*/g, '')
    .trim()
const cut = (s: string) => (s.length > LAST_WHAT_MAX ? `${s.slice(0, LAST_WHAT_MAX - 1)}…` : s)
const tagged = (tag: string, s: string) => cut(s ? `${tag} · ${s}` : tag)

/** What a timeline item says it was, in a few words; null for items that are not the runner's own work. */
function seenWhat(it: SeenItem): string | null {
  if (it.t === 'tool') return cut([it.name, it.label].filter(Boolean).join(' · ') || '도구')
  if (it.t === 'thinking') return tagged('생각', firstLine(it.text ?? ''))
  if (it.t === 'text') return tagged('답', firstLine(it.text ?? ''))
  return null
}

/**
 * The latest item of the running turn (back to its user message) that says what the runner did, or the Codex header
 * when it changed later (a tool with no name, REQ-F-851 규칙 9a). Null when nothing came yet. Only what the page has.
 */
export function lastSeen(items: SeenItem[], turnAt: number | null, tool?: ActivityInput['tool']): LastSeen | null {
  let found: LastSeen | null = null
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.t === 'user' || (turnAt && it.at < turnAt)) break
    const what = seenWhat(it)
    if (what) {
      found = { what, at: it.at }
      break
    }
  }
  if (tool && !tool.name && tool.title && tool.at && (!found || tool.at > found.at)) found = { what: cut(tool.title), at: tool.at }
  return found
}

/** Whether this turn's timeline shows a tool still running. */
export function toolRunningIn(items: SeenItem[], turnAt: number | null): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.t === 'user' || (turnAt && it.at < turnAt)) return false
    if (it.t === 'tool' && !it.done) return true
  }
  return false
}

export interface ActivityLine {
  /** What is going on, or null for the tool rows' own wording (the page picks it). */
  label: string | null
  /** The turn's whole time so far (ms), or null. */
  total: number | null
  /** The time since the last thing that moved (ms), only when it is long enough to say. */
  quiet: number | null
}

const WAIT_WORDS: Record<string, string> = {
  '권한 요청': '승인 대기 중',
  '플랜 승인': '플랜 승인 대기 중',
  질문: '질문 답 대기 중',
  '터미널 확인': '터미널 확인 대기 중',
  '지시 대기': '다음 지시 대기 중',
}

/** The latest moment something showed in a busy turn: its start, a tool, a header change, a timeline item. */
export function lastActivityAt(a: Pick<ActivityInput, 'turnAt' | 'tool' | 'waitingSince' | 'lastItemAt'>): number {
  return Math.max(a.turnAt ?? 0, a.tool?.at ?? 0, a.waitingSince ?? 0, a.lastItemAt || 0)
}

/** The status line for a turn that runs or waits; null when there is none (not busy, not waiting). */
export function activityLine(a: ActivityInput): ActivityLine | null {
  if (a.phase !== 'busy' && a.phase !== 'waiting') return null
  const total = a.turnAt ? Math.max(0, a.now - a.turnAt) : null
  const last = lastActivityAt(a)
  const gap = last ? a.now - last : 0
  const quiet = gap >= ACTIVITY_QUIET_MS ? gap : null
  // What the page shows is the last state it got: with the Mac or the page's link down it may be stale.
  if (!a.hostOnline) return { label: '맥 연결 끊김 · 상태 확인 불가', total, quiet }
  if (a.link !== 'live' && a.downSince && a.now - a.downSince >= LINK_DOWN_MS) return { label: '연결 끊김 · 다시 연결하는 중', total, quiet }
  if (a.phase === 'waiting') {
    const words = (a.waiting && WAIT_WORDS[a.waiting]) || `${a.waiting || '응답'} 대기 중`
    return { label: words, total: a.waitingSince ? Math.max(0, a.now - a.waitingSince) : total, quiet: null }
  }
  if (a.compacting) return { label: '컨텍스트 압축 중', total, quiet }
  if (a.tool?.name) return { label: null, total, quiet }
  // A runner without hooks (Codex) says nothing of its commands: the timeline row of one still running does (규칙 5).
  if (!a.hooks && a.toolRunning) return { label: '도구 실행 중', total, quiet }
  if (a.tool?.title) return { label: null, total, quiet }
  return { label: a.hooks ? '생각하는 중' : NO_UPDATE, total, quiet }
}
