// A Codex session's sandbox and approval (REQ-F-854): one string `<sandbox>:<approval>[:net]`, as agent/codex.mjs
// parseCodexMode reads it. Either part empty is codex's own default; '' is both. danger-full-access is never offered.
import { codexFeatures } from './features'

export const CODEX_SANDBOXES = ['read-only', 'workspace-write']
export const CODEX_APPROVALS = ['on-request', 'never']

export interface CodexMode {
  sandbox: string
  approval: string
  network: boolean
}

export function codexModeParts(v: string | undefined): CodexMode {
  const m = /^([a-z-]*):([a-z-]*)(:net)?$/.exec(v ?? '')
  if (!m) return { sandbox: '', approval: '', network: false }
  const sandbox = CODEX_SANDBOXES.includes(m[1]) ? m[1] : ''
  return { sandbox, approval: CODEX_APPROVALS.includes(m[2]) ? m[2] : '', network: !!m[3] && sandbox === 'workspace-write' }
}

export const codexModeOf = (m: CodexMode) => (!m.sandbox && !m.approval ? '' : `${m.sandbox}:${m.approval}${m.network && m.sandbox === 'workspace-write' ? ':net' : ''}`)

/** What this server lets people pick (bridge.yaml features.codexSandboxes·codexApprovals·codexNetwork). */
export function codexOptions() {
  const f = codexFeatures()
  return {
    sandboxes: CODEX_SANDBOXES.filter((x) => !f.sandboxes || f.sandboxes.includes(x)),
    approvals: CODEX_APPROVALS.filter((x) => !f.approvals || f.approvals.includes(x)),
    network: f.network !== false,
  }
}

/** A kept pick that this server no longer allows goes back to codex's default for that part. */
export function codexAllowed(v: string): string {
  const m = codexModeParts(v)
  const o = codexOptions()
  return codexModeOf({ sandbox: o.sandboxes.includes(m.sandbox) ? m.sandbox : '', approval: o.approvals.includes(m.approval) ? m.approval : '', network: m.network && o.network })
}

/** A short label for a session's mode: '' for codex's default. */
export function codexModeLabel(v: string | undefined): string {
  const m = codexModeParts(v)
  if (!m.sandbox && !m.approval) return ''
  return [m.sandbox || '샌드박스 기본', m.approval || '승인 기본', m.network ? '네트워크' : ''].filter(Boolean).join(' · ')
}
