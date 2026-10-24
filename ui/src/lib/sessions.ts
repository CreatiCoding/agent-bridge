// What a session row says about where a session stands, in one place so the list, the header and the
// notifications agree.
import type { Group, Host, Session } from './types'

export type Look = { label: string; tone: 'grey' | 'blue' | 'green' | 'red' | 'amber' | 'violet'; pulse?: boolean; need?: boolean }

const WAITING: Record<string, string> = { permission: '권한 요청', question: '질문', plan: '플랜 승인', dialog: '터미널 확인', keyed: '터미널 확인', stuck: '지시 대기' }

export function look(s: Session, host?: Host): Look {
  if (s.closed) return { label: '끝남', tone: 'grey' }
  if (s.moving) return { label: '옮기는 중', tone: 'violet', pulse: true }
  if (host && !host.online) return { label: '기기 끊김', tone: 'grey' }
  const st = s.state
  if (!st.alive) return { label: s.resting ? '휴면' : '멈춤', tone: 'grey' }
  if (s.card?.open || st.phase === 'waiting') return { label: WAITING[s.card?.kind ?? st.waiting ?? ''] ?? '응답 대기', tone: 'amber', need: true }
  if (st.phase === 'starting') return { label: '뜨는 중', tone: 'blue', pulse: true }
  if (st.phase === 'busy') return { label: s.coding ? '코딩 중' : '작업 중', tone: 'blue', pulse: true }
  if (s.resting) return { label: '휴면', tone: 'grey' }
  return { label: '대기', tone: 'green' }
}

export const titleOf = (s: Session) => s.title || s.preview || '새 세션'

export const KINDS: Record<string, string> = { imac: '아이맥', macbook: '맥북', macmini: '맥 미니', macstudio: '맥 스튜디오', server: '서버', other: '기타' }
export const hostIcon = (kind: string) => (kind === 'macbook' ? 'laptop' : 'desktop')

/** The model's short name: claude-fable-5-1[1m] → Fable 5.1 (1M). */
export function modelName(id: string | null | undefined) {
  if (!id) return ''
  if (id === 'default') return '기본'
  if (id === 'opusplan') return 'Opus plan'
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?(\[1m\])?/.exec(id)
  if (!m) return id
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ? ' (1M)' : ''}`
}

export const MODE_NAMES: Record<string, string> = { default: 'manual', acceptEdits: 'acceptEdits', plan: 'plan', auto: 'auto', bypassPermissions: 'bypass' }

export const GROUP_DEPTH = 3

/** Every group in tree order, with its depth (1 at the top) and its path ("상위 / 하위"). */
export function groupTree(groups: Group[]) {
  const out: { group: Group; depth: number; path: string; names: string[] }[] = []
  const known = new Set(groups.map((g) => g.id))
  // `names` is the path as its parts, so a name that itself holds " / " is still one part.
  const walk = (parent: string | null, depth: number, above: string[]) => {
    if (depth > GROUP_DEPTH + 1) return
    for (const g of groups.filter((x) => (x.parent && known.has(x.parent) ? x.parent : null) === parent)) {
      const names = [...above, g.name]
      out.push({ group: g, depth, path: names.join(' / '), names })
      walk(g.id, depth + 1, names)
    }
  }
  walk(null, 1, [])
  return out
}

/** How many levels a group and the groups inside it take up. */
export function groupHeight(groups: Group[], id: string): number {
  return 1 + Math.max(0, ...groups.filter((g) => g.parent === id).map((g) => groupHeight(groups, g.id)))
}
