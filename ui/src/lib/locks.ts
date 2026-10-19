// Session locks on this page. The password never leaves the browser: what is sent is a hash of it (the proof),
// which the server stretches again before keeping. An unlock gives a token kept for this tab only.
const KEY = (sid: string) => `cb2.unlock.${sid}`

export async function proofOf(password: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`claude-bridge-lock:${password}`))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function tokenOf(sid: string): string | null {
  try {
    return sessionStorage.getItem(KEY(sid))
  } catch {
    return null
  }
}
export function setToken(sid: string, token: string | null) {
  try {
    if (token) sessionStorage.setItem(KEY(sid), token)
    else sessionStorage.removeItem(KEY(sid))
  } catch {}
  dispatchEvent(new CustomEvent('cb-unlock', { detail: sid }))
}

/** The session a path is about, if any: its requests carry that session's token. */
export const sessionOfPath = (path: string) => /^\/api\/sessions\/([\w-]+)/.exec(path)?.[1] ?? null
