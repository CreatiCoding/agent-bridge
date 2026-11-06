// 세션 정리 (REQ-F-839 rule 1·3): which list a session row of the report is in, and the host line's counts. The server
// counts the host line by the same rule (server/tidy.go tidyGroups); test/fixtures/tidy-groups.json holds both to it.

export interface TidyRowLike {
  alive?: boolean
  act?: string | null
  rest?: boolean
  close?: boolean
}

const STOP_ACTS = new Set(['suggest', 'notice', 'wait', 'stop'])

/** 내릴 세션: its claude runs and the batch counts, told, waits on or stops it. 휴면·끝내기 제안: any other row offered a rest or an end. */
export function tidyGroups<T extends TidyRowLike>(rows: T[]): { stop: T[]; rest: T[] } {
  const stop: T[] = []
  const rest: T[] = []
  for (const r of rows) {
    if (r.alive && r.act && STOP_ACTS.has(r.act)) stop.push(r)
    else if (r.rest || r.close) rest.push(r)
  }
  return { stop, rest }
}

/** The host line under 디스크 관리: the same three counts the open box heads its lists with. */
export function tidyBriefText(b: { stop: number; rest: number; files: number }) {
  if (!b.stop && !b.rest && !b.files) return '세션 정리: 정리할 것 없음'
  return `내릴 세션 ${b.stop} · 휴면·끝내기 제안 ${b.rest} · 폴더·기록 제안 ${b.files}`
}

/** A path cut to its last `n` parts (`…/works/app`), for the small grey line under a name. */
export function shortPath(p: string | null | undefined, n = 2) {
  if (!p) return ''
  const parts = p.replace(/\/+$/, '').split('/').filter(Boolean)
  if (parts.length <= n) return p
  return `…/${parts.slice(-n).join('/')}`
}

/**
 * 세션 정리 페이지 (REQ-F-839 rule 3): what a row is called. A session by its name (the one the person gave or the
 * automatic one; one with no name yet by its folder's name); a folder or transcript by the name of the session that
 * used it, else the folder's own name or the transcript's file without `.jsonl`. The id or path is only the small line under it (`tidyRowSub`).
 */
export function tidyRowName(r: { title?: string | null; name?: string | null; cwd?: string | null; path?: string | null; sid?: string | null }) {
  const n = (r.title ?? r.name ?? '').trim()
  if (n) return n
  // A session with no name yet: its folder's name, never its id.
  const place = r.cwd || r.path
  if (place) {
    const last = place.replace(/\/+$/, '').split('/').pop() ?? place
    return last.replace(/\.jsonl$/, '') || place
  }
  return r.sid ? r.sid.slice(0, 8) : ''
}

/** The small line under a row's name: where it lives and its short id. */
export function tidyRowSub(r: { cwd?: string | null; path?: string | null; sid?: string | null }) {
  return [shortPath(r.cwd ?? r.path, 3), r.sid ? r.sid.slice(0, 8) : ''].filter(Boolean).join(' · ')
}
