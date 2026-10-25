// Checks on what the server or a page hands the agent before it touches this Mac with it: addresses, names, paths,
// files. Each one answers a finding of review report #1; kept apart from agent.mjs so they can be tested.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { UPDATE_KEYS } from './keys.mjs'

/**
 * A one-time sign-in link for the headless browser (R1-M7): exactly the site's own origin and its QR sign-in path.
 * A prefix check let `https://site.example.attacker.test/…` and `https://site.example@attacker.test/` through, and
 * the agent key rides on the address's fragment.
 */
export function siteLogin(login, site) {
  try {
    const u = new URL(String(login))
    const s = new URL(String(site))
    return u.origin === s.origin && !u.username && !u.password && u.pathname.startsWith('/api/auth/qr/') && (u.protocol === 'https:' || u.hostname === 'localhost') ? u.href : null
  } catch {
    return null
  }
}

/** A folder name inside a session's folder that a move may create (R1-L7): one plain name, never `.` or `..`. */
export const safeDirName = (s) => typeof s === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(s) && s !== '.' && s !== '..'

/** A session or conversation id as it goes into a file name (R1-L7): the server's own id shape, no path in it. */
export const safeConvId = (s) => typeof s === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(s)

/** Whether file (after symlinks) is one of roots or inside one (R1-L8). False when it does not exist. */
export function insideAny(file, roots) {
  let real
  try {
    real = fs.realpathSync(file)
  } catch {
    return false
  }
  return roots.some((r) => {
    let root
    try {
      root = fs.realpathSync(r)
    } catch {
      return false
    }
    return real === root || real.startsWith(root.endsWith('/') ? root : `${root}/`)
  })
}

/**
 * A plain file's text, up to max bytes (R1-L9). A symlink counts only when root is given and the link ends inside
 * it (CLAUDE.md pointing at the folder's own AGENTS.md); one that leads out of the folder, anything not a file, or
 * one too big is null.
 */
export function readPlain(p, max, root) {
  try {
    if (fs.lstatSync(p).isSymbolicLink() && !(root && insideAny(p, [root]))) return null
    const st = fs.statSync(p)
    if (!st.isFile() || st.size > max) return null
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/** Writes text to p, never through a symlink there (R1-L9): a link in its place throws (ELOOP). */
export function writePlain(p, content) {
  const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644)
  try {
    fs.writeFileSync(fd, content)
  } finally {
    fs.closeSync(fd)
  }
}

/** git options for every git the agent runs by itself (R1-L10): a folder's own config must not run a program. */
export const GIT_SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']

/**
 * Who may sign an agent update (R1-I1): ed25519 public keys, in keys.mjs (1.292), which is itself a signed agent file.
 * The private keys are on the signer's Mac only, never on the server: a server or a page of the site that is broken
 * into cannot make this agent run code it was not given by the signer.
 */
export { UPDATE_KEYS }
/** What is signed for a build (the fingerprint of the agent's files, as AGENT_BUILD). */
export const signedText = (build) => `claude-bridge-agent-build:${build}`

/** Whether sig (base64) is one of UPDATE_KEYS' signature of build. */
export function buildSigned(build, sig, keys = UPDATE_KEYS) {
  if (typeof build !== 'string' || typeof sig !== 'string' || !sig) return false
  const bytes = Buffer.from(sig, 'base64')
  return keys.some((k) => {
    try {
      return crypto.verify(null, Buffer.from(signedText(build)), crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }), bytes)
    } catch {
      return false
    }
  })
}

/**
 * What the maintainer signs from 1.165 (R5-H1, R5-M1, R5-L1): every file's name, length and full SHA-256, in the
 * order they are sent, after a number that only grows. The 12-letter build (48 bits of SHA-1 over the contents run
 * together) could be matched by other code with enough tries, and said nothing of which content is which file.
 */
export function manifestOf(files, seq) {
  // A name with a NUL or a newline could make two different lists read the same (R7-I1): only plain file names.
  for (const name of Object.keys(files)) if (!/^[a-z]+\.mjs$/.test(name)) throw new Error(`에이전트 파일 이름이 아닙니다: ${JSON.stringify(name)}`)
  const lines = Object.entries(files).map(([name, text]) => `${name}\0${Buffer.byteLength(text)}\0${crypto.createHash('sha256').update(text).digest('hex')}`)
  return `claude-bridge-agent-manifest\nseq:${seq}\n${lines.join('\n')}\n`
}

/** Whether msig (base64) is one of UPDATE_KEYS' signature of these files' manifest under seq. */
export function manifestSigned(files, seq, msig, keys = UPDATE_KEYS) {
  if (!files || typeof files !== 'object' || !Number.isSafeInteger(seq) || seq < 1 || typeof msig !== 'string' || !msig) return false
  let text
  try {
    text = Buffer.from(manifestOf(files, seq))
  } catch {
    return false
  }
  const bytes = Buffer.from(msig, 'base64')
  return keys.some((k) => {
    try {
      return crypto.verify(null, text, crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }), bytes)
    } catch {
      return false
    }
  })
}

/**
 * What 전부 허용 still asks the person about (REQ-F-759): a tool call that deletes outside the session's folder,
 * rewrites git history on a remote or throws away work, runs as root, reads this Mac's secrets, or changes Claude
 * Code's own settings or what macOS starts at login. Returns why in a few words, or null. A command is only read
 * as written: what a script it runs does inside is not seen.
 */
export function riskyCall(tool, { cwd = '', home = '' } = {}) {
  const name = String(tool?.name ?? '')
  const input = tool?.input ?? {}
  const secret = /(^|[\s'"=:/])(~|\$HOME|\$\{HOME\})?\/?\.ssh(\/|\b)|\.claude-bridge-signing\b|\.claude-bridge\/(agent\.json|hook\.header|openai\.key|browser)\b|(^|[\s'"=/])\.env(?!\.(example|sample|template|dist)\b)(\.[\w.-]+)?(?=$|[\s'";|&)])|\bsecurity\s+(find-generic-password|find-internet-password|dump-keychain|export)\b|Library\/Keychains/
  const settings = /\.claude\/(settings(\.local)?\.json|hooks\b)|Library\/LaunchAgents|Library\/LaunchDaemons|\blaunchctl\s+(load|bootstrap|enable|submit)\b/
  if (name === 'Bash') {
    const c = String(input.command ?? '')
    if (/(^|[\s;&|(])sudo\s/.test(c)) return '관리자 권한(sudo)'
    if (/\bgit\b[^;&|\n]*\spush\b[^;&|\n]*(\s(--force|-f|--force-with-lease)\b|\s\+[\w./-]+)/.test(c)) return 'git 강제 push'
    if (/\bgit\b[^;&|\n]*\sreset\b[^;&|\n]*\s--hard\b/.test(c)) return 'git reset --hard'
    if (secret.test(c)) return '비밀 파일'
    if (settings.test(c)) return 'Claude 설정·로그인 항목 바꾸기'
    if (removesOutside(c, cwd, home)) return '세션 폴더 밖 삭제'
    return null
  }
  const file = String(input.file_path ?? input.notebook_path ?? input.path ?? '')
  if (!file) return null
  if (secret.test(file)) return '비밀 파일'
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name) && settings.test(file)) return 'Claude 설정·로그인 항목 바꾸기'
  return null
}

/**
 * 관리자 권한 (REQ-F-764). The admin password typed on the web is kept in the agent's memory this long, sudo's own
 * default, and never written anywhere.
 */
export const SUDO_WINDOW_MS = 300_000
const shq1 = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
/**
 * The `sudo` a bridge session finds first on its PATH. Without a terminal, sudo asks a helper for the password only
 * when told to (-A), so this adds it. One that reads the password itself (-S) or must not ask (-n) goes as written.
 */
export function sudoWrapper(askpass) {
  return `#!/bin/sh
# claude-bridge: sudo in a bridge session asks the person on the web for the password (REQ-F-764).
for a in "$@"; do
  case "$a" in
    --) break ;;
    --stdin|--non-interactive) exec /usr/bin/sudo "$@" ;;
    --*) ;;
    -*S*|-*n*) exec /usr/bin/sudo "$@" ;;
    -*) ;;
    *) break ;;
  esac
done
SUDO_ASKPASS=${shq1(askpass)} exec /usr/bin/sudo -A "$@"
`
}
/** sudo's helper: prints the password this Mac's agent hands out, or fails (nothing printed) when there is none. */
export function askpassScript(header) {
  return `#!/bin/sh
# claude-bridge: sudo's password, from this Mac's agent (it asks the person on the web; kept 5 minutes).
[ -n "$CB_HOOK" ] || exit 1
exec /usr/bin/curl -sf -m 130 -X POST -H @${shq1(header)} --data-binary "$1" "$(printf %s "$CB_HOOK" | sed 's|/hook?|/askpass?|')"
`
}
/** At most this much of what a root command printed is kept: its end, where the result usually is. */
export function tailOf(text, max = 20_000) {
  const t = String(text ?? '')
  return t.length > max ? `…(앞 ${t.length - max}자 생략)\n${t.slice(-max)}` : t
}

/**
 * The systemd user unit that runs the agent as a service on Linux, the counterpart of the launchd plist on macOS.
 * Every value is quoted for systemd: `%` is a specifier and `$` a variable to it, and a line break would start a
 * directive of its own, so a path or PATH entry with one is refused rather than written.
 * KillMode=process: a restart (an update, the site's "restart") ends the agent only. The terminal server and the
 * headless browser it started are in the same cgroup and must outlive it, as they do under launchd.
 * @param {{ node: string, self: string, home: string, log: string, env: Record<string, string> }} o
 */
export function systemdUnit({ node, self, home, log, env }) {
  const plain = (s) => {
    if (/[\r\n]/.test(String(s))) throw new Error('줄바꿈이 든 값은 systemd 유닛에 쓸 수 없습니다')
    return String(s).replace(/%/g, '%%')
  }
  const q = (s) => `"${plain(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const arg = (s) => q(s).replace(/\$/g, '$$$$')
  return `[Unit]
Description=Agent Bridge agent
After=network-online.target

[Service]
Type=simple
ExecStart=${arg(node)} ${arg(self)} --service
WorkingDirectory=${plain(home)}
${Object.entries(env)
  .map(([k, v]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`환경 변수 이름이 맞지 않습니다: ${k}`)
    return `Environment=${q(`${k}=${v}`)}`
  })
  .join('\n')}
Restart=always
RestartSec=10
KillMode=process
StandardOutput=append:${plain(log)}
StandardError=append:${plain(log)}

[Install]
WantedBy=default.target
`
}

/**
 * A retired agent key, kept only as this print: a tab that comes back with it is a browser of this Mac that was
 * closed while the key changed, and is never told the new key (the key changed so that the old one opens nothing).
 */
export const keyPrint = (key) => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 32)
/** At most this many retired keys are remembered. */
export const RETIRED_KEYS_MAX = 5
/** The prints to keep after retiring `key`: newest first, no repeats, at most RETIRED_KEYS_MAX. */
export function retireKey(prints, key) {
  if (!key) return prints ?? []
  const p = keyPrint(key)
  return [p, ...(prints ?? []).filter((x) => x !== p)].slice(0, RETIRED_KEYS_MAX)
}
/**
 * Which app on this Mac a request's User-Agent came from, as a bundle id for `open -b`, so the link page opens in the
 * browser that holds the old key. null for the agent's own headless browser and for what cannot be told apart.
 */
/** How old a key gets before it changes by itself (1.319, REQ-S-083). */
export const KEY_ROTATE_MS = 24 * 3600_000

/**
 * Whether the key should change by itself now: it is KEY_ROTATE_MS old (no keyAt: older still), the linked tab can
 * take a new key and came with the current one, and the previous key is not still in its grace (changing again then
 * would drop it at once, before other browsers caught up).
 */
export function keyRotateDue({ now, keyAt, oldUntil, linked, rekey }) {
  if (!rekey || linked !== 'current') return false
  if (oldUntil && now < oldUntil) return false
  return now - (keyAt ?? 0) >= KEY_ROTATE_MS
}

export function browserApp(ua) {
  const s = String(ua ?? '')
  if (!/Macintosh/.test(s) || /HeadlessChrome/.test(s)) return null
  if (/Edg\//.test(s)) return 'com.microsoft.edgemac'
  if (/Firefox\//.test(s)) return 'org.mozilla.firefox'
  if (/Chrome\//.test(s)) return 'com.google.Chrome'
  if (/Safari\//.test(s)) return 'com.apple.Safari'
  return null
}

/** Whether a command's `rm -r` reaches outside cwd:an absolute or home path not under it, `..`, or after a cd away. */
function removesOutside(c, cwd, home) {
  const root = cwd ? path.resolve(cwd) : ''
  const movedAway = /(^|[;&|(]\s*)cd\s+(?!\.\/|[\w-])/.test(c) || /(^|[;&|(]\s*)cd\s+[^;&|]*\.\./.test(c)
  for (const m of c.matchAll(/(?:^|[;&|(]\s*|\bxargs\s+)rm\s+([^;&|\n]*)/g)) {
    const args = m[1].trim().split(/\s+/).filter(Boolean)
    const flags = args.filter((a) => a.startsWith('-'))
    if (!flags.some((f) => /^-[a-zA-Z]*[rR]/.test(f) || f === '--recursive')) continue
    for (const a of args.filter((x) => !x.startsWith('-')).map((x) => x.replace(/^['"]|['"]$/g, ''))) {
      if (a.includes('..') || a === '/' || /^\$/.test(a)) return true
      if (a.startsWith('/') || a.startsWith('~')) {
        const abs = a.startsWith('~') ? path.join(home || '/', a.slice(1)) : a
        if (!root || !(abs === root || abs.startsWith(`${root}/`))) return true
      } else if (movedAway) return true
    }
  }
  return false
}

/**
 * What a session is told before anything else: the bridge's own words, the person's default prompt, and, for a
 * copy made while the original was working (REQ-F-401), that the original keeps that work. A copy inherits the
 * whole conversation, a summary's "still to do" list among it, and otherwise took the original's unfinished work
 * for its own: it picked it up, or asked whether to finish it, while the original went on with it.
 */
export function sessionPrompt(bridge, s) {
  const fork = s?.forkOf && /^[\w-]{8}$/.test(String(s.forkOf))
    ? `[복제된 세션] 이 세션은 ${s.forkOf} 세션이 일하던 도중에 복제한 것입니다. 복제할 때 진행 중이던 작업과 대화에 남아 있는 할 일(요약의 남은 일 포함)은 원본 세션이 계속 맡고 있습니다. 사용자가 이 세션에서 그 일을 하라고 직접 말하지 않는 한 그 일을 이어서 하거나 마저 할지 묻지 말고, 이 세션에 새로 온 요청만 처리하세요. 원본이 쓰는 worktree·브랜치·임시 파일도 건드리지 마세요.`
    : ''
  return [bridge, String(s?.sysPrompt ?? '').trim(), fork].filter(Boolean).join('\n\n')
}
