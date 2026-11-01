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
