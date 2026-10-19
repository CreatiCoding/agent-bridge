// Pull requests for the usage statistics (사용 통계): what `gh` on the Macs answered, summed up. Pure: no disk, no network.

/** Pull requests merged and created in the window, how long they took, and how many came up in the conversations. */
export function prSummary(prs, now, days) {
  const from = now - days * 86_400_000
  const inWin = (t) => !!t && Date.parse(t) >= from && Date.parse(t) <= now
  const merged = prs.filter((p) => inWin(p.mergedAt))
  const created = prs.filter((p) => inWin(p.createdAt))
  const times = merged.map((p) => Date.parse(p.mergedAt) - Date.parse(p.createdAt)).filter((x) => x >= 0).sort((a, b) => a - b)
  const quantile = (q) => (times.length ? times[Math.min(times.length - 1, Math.floor(q * times.length))] : undefined)
  const sum = (xs, k) => xs.reduce((a, p) => a + (p[k] ?? 0), 0)
  return {
    merged: merged.length,
    created: created.length,
    medianMergeMs: quantile(0.5),
    p90MergeMs: quantile(0.9),
    additions: sum(merged, 'additions'),
    deletions: sum(merged, 'deletions'),
    linked: 0,
    recent: [...created].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 20).map((p) => ({ url: p.url, createdAt: p.createdAt, mergedAt: p.mergedAt })),
  }
}
