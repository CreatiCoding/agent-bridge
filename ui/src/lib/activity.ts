// What the session page's status line says while a turn runs (REQ-F-874): what is going on when it can be told,
// "작업 중 · 상태 업데이트 없음" when it cannot, and the turn's whole time apart from the time since anything last moved.
// Everything comes from what the page already has (the session's state, its timeline, the link): no extra asking.

/** From this long without anything new, the line also says "마지막 활동 … 전". */
export const ACTIVITY_QUIET_MS = 60_000
/** A link down this briefly is a reconnect, not worth a word (the app's own banner waits as long). */
export const LINK_DOWN_MS = 8_000

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
  if (a.tool?.title) return { label: null, total, quiet }
  return { label: a.hooks ? '생각하는 중' : '작업 중 · 상태 업데이트 없음', total, quiet }
}
