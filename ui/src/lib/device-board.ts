// 설정 → 기기 (REQ-F-842): what one host's card says, kept apart from the page so a test can read it.
// No runtime imports: the unit test loads this file straight into node (test/unit/device-board.test.mjs).
import type { SysUse } from './format'
import type { TidyBrief } from './types'

export type Tone = 'ok' | 'warn' | 'bad'

/** One bar: what it measures, how full (0..100), the words beside it, and its colour. */
export interface Meter {
  key: 'cpu' | 'mem' | 'disk'
  label: string
  pct: number
  text: string
  tone: Tone
}

/** Disk: 85% and up amber, 95% and up red (REQ-F-801·REQ-F-803, the disk menu's own rule). CPU and memory have no
 *  warning colour: a busy build sits at 100% for a while and that is not a problem to point at. */
export function diskTone(pct: number): Tone {
  return pct >= 95 ? 'bad' : pct >= 85 ? 'warn' : 'ok'
}

const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n)))

/** The three bars a card shows, leaving out what the agent did not send. `bytes` is format.ts's. */
export function meters(sys: SysUse | null | undefined, bytes: (n: number) => string): Meter[] {
  if (!sys) return []
  const out: Meter[] = []
  if (sys.cpu != null) out.push({ key: 'cpu', label: 'CPU', pct: clampPct(sys.cpu), text: `${clampPct(sys.cpu)}%${sys.cores ? ` · ${sys.cores}코어` : ''}`, tone: 'ok' })
  if (sys.memUsed != null && sys.memTotal) {
    const pct = clampPct((100 * sys.memUsed) / sys.memTotal)
    out.push({ key: 'mem', label: '메모리', pct, text: `${pct}% · ${bytes(sys.memUsed)} / ${bytes(sys.memTotal)}`, tone: 'ok' })
  }
  if (sys.disk?.pct != null) {
    const pct = clampPct(sys.disk.pct)
    out.push({ key: 'disk', label: '디스크', pct, text: `${pct}%${sys.disk.avail != null ? ` · ${bytes(sys.disk.avail)} 남음` : ''}`, tone: diskTone(sys.disk.pct) })
  }
  return out
}

const MODE_TEXT = { auto: '자동', suggest: '제안만', off: '끔' } as const

/** 세션 정리's mode in a word: 자동 · 제안만 · 끔 (REQ-F-840; 제안만 for the first 7 days or someone else's host). */
export function tidyModeText(t: Pick<TidyBrief, 'mode'>) {
  return MODE_TEXT[t.mode] ?? t.mode
}

/** The card's 세션 정리 line: its mode and the counts the open box heads its lists with (REQ-F-839 rule 1). */
export function tidyCardText(t: TidyBrief | null | undefined): { mode: string | null; text: string; count: number } {
  if (!t) return { mode: null, text: '정리 정보 없음(에이전트가 1.385 이전)', count: 0 }
  const mode = tidyModeText(t)
  if (!t.at) return { mode, text: t.mode === 'off' ? '꺼져 있어요' : '아직 계산 전', count: 0 }
  const offer = t.rest + t.files
  if (!t.stop && !offer) return { mode, text: '정리할 것 없음', count: 0 }
  return { mode, text: `내릴 세션 ${t.stop} · 제안 ${offer}`, count: t.stop + offer }
}

/** Connected ones first, then the rest; each by how full the disk is (the one to clear on top). */
export function boardOrder<T extends { online: boolean; sys?: SysUse | null }>(list: T[]): T[] {
  return [...list].sort((a, b) => Number(b.online) - Number(a.online) || (b.sys?.disk?.pct ?? -1) - (a.sys?.disk?.pct ?? -1))
}
