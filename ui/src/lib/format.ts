// Times, sizes and paths, the short way.
export function ago(ts: number | null | undefined, now = Date.now()) {
  if (!ts) return ''
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 45) return '방금'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}분 전`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}시간 전`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}일 전`
  return new Date(ts).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })
}

export function clock(ts: number) {
  const d = new Date(ts)
  const today = new Date()
  const time = d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })} ${time}`
}

export function duration(ms: number) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}초`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}분${s % 60 ? ` ${s % 60}초` : ''}`
  const h = Math.floor(m / 60)
  return `${h}시간${m % 60 ? ` ${m % 60}분` : ''}`
}

export function bytes(n: number | null | undefined) {
  if (n == null) return ''
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)}KB`
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)}MB`
  return `${(n / 1024 ** 3).toFixed(1)}GB`
}

/** A token count, the short way: 950, 12k, 1.2M. */
export function tokens(n: number) {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
}

/** The folder with the home folder as ~, and only its last parts when long. */
export function shortPath(p: string, home?: string, keep = 3) {
  if (!p) return ''
  let s = home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p
  const parts = s.split('/')
  if (parts.length > keep + 1) s = `…/${parts.slice(-keep).join('/')}`
  return s
}

/**
 * A tool line's paths, the short way (REQ-F-703): a Claude Code scratch folder → `scratch/`, a git worktree →
 * `wt:<name>/`, a home folder → `~/`. Only the one-line label: the opened row keeps the full text.
 */
export function shortLabel(s: string) {
  return s
    .replace(/(^|[\s'"=(])\/(?:private\/)?tmp\/claude-\d+\/[^/\s'"]+\/[0-9a-f-]{36}\/scratchpad\//g, '$1scratch/')
    .replace(/(^|[\s'"=(])(?:[^\s'"]*\/)?\.claude\/worktrees\/([^/\s'"]+)\//g, '$1wt:$2/')
    .replace(/(^|[\s'"=(])\/Users\/[^/\s'"]+\//g, '$1~/')
}

/** A working folder as a path: under the Mac's home it starts with ~/ (the home itself is ~), else the whole path. */
export function folderPath(p: string, home?: string) {
  if (!p) return ''
  const h = (home ?? '').replace(/\/+$/, '')
  if (h && p === h) return '~'
  if (h && p.startsWith(`${h}/`)) return `~/${p.slice(h.length + 1)}`
  // No home known (an older session copy): a macOS home is /Users/<name>.
  return p.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
}
