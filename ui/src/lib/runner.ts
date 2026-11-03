// Session runners (REQ-F-851): which CLI a session runs. A session with no runner is a Claude Code session and can do
// everything; another runner says what it can do (`caps`, from its Mac's hello), and the page hides the rest.
import { getStore } from './store'
import type { Host, Session } from './types'

export type RunnerCap = 'hooks' | 'cards' | 'bridgeTools' | 'model' | 'effort' | 'mode' | 'autoAllow' | 'fork' | 'move' | 'account' | 'compact' | 'trim' | 'skills' | 'btw' | 'todos' | 'preview' | 'adopt' | 'routing' | 'chrome' | 'sessionMd' | 'zeropty'

/** A session's runner id: 'claude' unless another is on record. */
export const runnerOf = (s: Pick<Session, 'runner'>) => (s.runner && s.runner !== 'claude' ? s.runner : 'claude')

const hostOf = (s: Pick<Session, 'hostId'>, hosts?: Host[]) => (hosts ?? getStore().state?.hosts ?? []).find((h) => h.id === s.hostId)

/** Whether a session's runner can do `cap`. A runner its Mac no longer lists can do nothing beyond seeing and typing. */
export function runnerCan(s: Pick<Session, 'runner' | 'hostId'>, cap: RunnerCap, hosts?: Host[]): boolean {
  const id = runnerOf(s)
  if (id === 'claude') return true
  return !!hostOf(s, hosts)?.runners?.find((r) => r.id === id)?.caps.includes(cap)
}

/** The name to show for a session's runner, or null for Claude Code (nothing is shown for it). */
export function runnerLabel(s: Pick<Session, 'runner' | 'hostId'>, hosts?: Host[]): string | null {
  const id = runnerOf(s)
  if (id === 'claude') return null
  return hostOf(s, hosts)?.runners?.find((r) => r.id === id)?.name || id
}

/** The session menu's items that need a cap (session-menu.tsx ids). */
export const MENU_CAPS: Record<string, RunnerCap> = { todos: 'todos', compact: 'compact', fork: 'fork', lightfork: 'fork', 'trim-log': 'trim', 'move-host': 'move', 'move-account': 'move', 'move-cwd': 'move' }
