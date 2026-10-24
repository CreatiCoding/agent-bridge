// What must not leave a Mac as it is: sign-in parts of git remote addresses, home folder paths and the agent's link
// keys. Both the agent
// (before it sends) and the server (before it stores) run these, so an older agent on the other end changes nothing.

/**
 * A remote address without the credentials written into it. `https://user:token@host/x` and
 * `https://x-access-token:…@host/x` lose the whole `user:token@` part; `ssh://git:pw@host/x` keeps the user and loses
 * the password; `git@host:owner/repo` (scp style) has no secret and stays.
 */
export function stripCreds(url) {
  if (typeof url !== 'string') return url
  return url.replace(/\b((?:https?|ftps?|git\+https?):\/\/)[^\s/@]*@/gi, '$1').replace(/\b((?:ssh|git\+ssh):\/\/)([^\s/:@]*):[^\s/@]*@/gi, '$1$2@')
}

/** Every remote address in a text (an error from git, a log line) without its credentials. */
export const hideRemotes = (text) => stripCreds(String(text ?? ''))

/**
 * A text without the agent's link keys: the key in a link address (`…/bridge#port=4317&key=…`, as on a headless
 * Chrome's command line, which `ps` shows), in a hook header (`x-bridge-key: …`), and any of `secrets` (this Mac's
 * own keys) wherever they are. The server runs it without secrets: only the two forms are hidden there.
 */
export function hideKeys(text, secrets = []) {
  let s = String(text ?? '')
  for (const k of secrets) if (typeof k === 'string' && k.length >= 16) s = s.split(k).join('***')
  return s.replace(/([#&]key=)[A-Za-z0-9_%-]{16,}/g, '$1***').replace(/(x-bridge-key:\s*)[A-Za-z0-9_-]{16,}/gi, '$1***')
}

/** Every string in a message (objects and arrays walked) through hideKeys. */
export function hideKeysDeep(v, secrets = []) {
  if (typeof v === 'string') return hideKeys(v, secrets)
  if (Array.isArray(v)) return v.map((x) => hideKeysDeep(x, secrets))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hideKeysDeep(x, secrets)]))
  return v
}

/** A text with home folder paths replaced by "(경로)", so a log or a problem shown to others does not name a person's files. */
export const hidePaths = (text) =>
  String(text ?? '')
    .replace(/(?:~|file:\/\/)?\/(?:Users|home|private|var|tmp|Volumes|opt|Library|usr|Applications|etc)\/[^\n'"`)\]]*/g, '(경로)')
    .replace(/(?:~|\$HOME|\$\{HOME\})\/[^\n'"`)\]]*/g, '(경로)')

/**
 * A folder snapshot as the server may keep it: remote addresses without credentials and no note contents (the
 * SESSION/AGENTS/CLAUDE.md text stays on the Mac; a move asks the Mac for it then).
 */
export function cleanFolder(folder) {
  if (!folder || typeof folder !== 'object') return folder
  const out = { ...folder }
  if (Array.isArray(out.repos)) out.repos = out.repos.map((r) => (r && typeof r === 'object' ? { ...r, ...(r.origin ? { origin: stripCreds(r.origin) } : {}), ...(typeof r.push === 'string' ? { push: hideRemotes(r.push) } : {}), ...(r.pushError ? { pushError: hideRemotes(r.pushError) } : {}) } : r))
  if (out.origin) out.origin = stripCreds(out.origin)
  if (out.files && typeof out.files === 'object') out.files = {}
  return out
}
