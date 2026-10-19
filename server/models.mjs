// The new-session page's model list, made from Claude Code's own model catalog (agent `models`).

/**
 * The list made from a catalog (`[{value, resolved, name, description}]`, in Claude Code's order): each model by
 * its full id, a 1M-context form the list already had right before its model (the catalog does not name those),
 * then opusplan if the list had it, and Default (with what it stands for) last.
 */
export function modelsFromCatalog(catalog, prev) {
  const out = []
  const push = (label, value) => out.some((x) => x.value === value) || out.push({ label, value })
  for (const m of catalog) {
    if (m.value === 'default') continue
    const id = /^claude-/.test(m.resolved) ? m.resolved : m.value
    if (prev.some((x) => x.value === `${id}[1m]`)) push(`${m.name} (1M)`, `${id}[1m]`)
    push(m.name, id)
  }
  if (prev.some((x) => x.value === 'opusplan')) push('Opus plan / Sonnet work', 'opusplan')
  const def = catalog.find((m) => m.value === 'default')
  const stands = def ? (def.description.split(' · ')[0] || def.resolved) : ''
  push(stands ? `Default · ${stands}` : 'Default', 'default')
  return out
}

