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
/** CPU in use between two `os.cpus()` readings, 0–100, or null without a first reading (1.322, REQ-F-800). */
export function cpuBusy(prev, cur) {
  if (!Array.isArray(prev) || !Array.isArray(cur) || prev.length !== cur.length) return null
  let idle = 0
  let total = 0
  cur.forEach((c, i) => {
    const p = prev[i]?.times ?? {}
    const t = c?.times ?? {}
    const d = (k) => Math.max(0, (t[k] ?? 0) - (p[k] ?? 0))
    idle += d('idle')
    total += d('user') + d('nice') + d('sys') + d('irq') + d('idle')
  })
  return total > 0 ? Math.round((1000 * (total - idle)) / total) / 10 : null
}

/**
 * Memory in use on a Mac from `vm_stat`, as Activity Monitor counts it: app memory (anonymous less purgeable), wired
 * and compressed. `os.freemem()` there counts only free pages, so a Mac using its spare memory as cache looks full.
 */
export function macMemUsed(text) {
  const page = Number(/page size of (\d+) bytes/.exec(text)?.[1])
  const n = (label) => Number(new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(text)?.[1])
  const used = n('Anonymous pages') - n('Pages purgeable') + n('Pages wired down') + n('Pages occupied by compressor')
  return Number.isFinite(page) && Number.isFinite(used) && used >= 0 ? used * page : null
}

/** Memory in use on Linux: MemTotal less MemAvailable from /proc/meminfo (bytes), or null. */
export function linuxMemUsed(text) {
  const kb = (label) => Number(new RegExp(`^${label}:\\s+(\\d+) kB`, 'm').exec(text)?.[1])
  const used = kb('MemTotal') - kb('MemAvailable')
  return Number.isFinite(used) && used >= 0 ? used * 1024 : null
}

/** At or under this charge, off power, a battery shows as low (REQ-F-806). */
export const BATTERY_LOW_PCT = 20

/**
 * A Mac's battery from `pmset -g batt`, with wear from `ioreg -rn AppleSmartBattery` when given (REQ-F-806):
 * { present, ac, pct, state, remain (minutes), cycles, health (% of design capacity) }, or { present: false, ac } on a
 * Mac with no battery (a Mac mini prints only its power source). null when pmset said nothing readable.
 */
export function macBattery(pmset, ioreg = '') {
  const src = /Now drawing from '([^']+)'/.exec(String(pmset))?.[1]
  if (!src) return null
  const ac = src !== 'Battery Power'
  const m = /InternalBattery[^\n]*?\s(\d{1,3})%;\s*([^;\n]+?)\s*;\s*(?:(\d+):(\d\d) remaining)?/.exec(String(pmset))
  if (!m) return { present: false, ac }
  const word = m[2].toLowerCase()
  const state = word === 'charged' ? 'full' : /^(charging|finishing charge)$/.test(word) ? 'charging' : word === 'discharging' ? 'discharging' : ac ? 'idle' : 'discharging'
  const remain = m[3] != null ? Number(m[3]) * 60 + Number(m[4]) : null
  const n = (key) => Number(new RegExp(`"${key}" = (\\d+)`).exec(String(ioreg))?.[1])
  const cycles = n('CycleCount')
  const health = n('AppleRawMaxCapacity') / n('DesignCapacity')
  return { present: true, ac, pct: Math.min(100, Number(m[1])), state, remain: remain > 0 && state !== 'full' ? remain : null, cycles: Number.isFinite(cycles) ? cycles : null, health: health > 0 && Number.isFinite(health) ? Math.round(100 * health) : null }
}

/**
 * A Linux machine's battery from /sys/class/power_supply (REQ-F-806): `supplies` is one { file: text } per entry
 * (type, online, capacity, status, cycle_count, energy_* or charge_*, power_now or current_now). Without a battery
 * it runs off the mains, so { present: false, ac: true }.
 */
export function linuxBattery(supplies) {
  const v = (s, k) => String(s?.[k] ?? '').trim()
  const num = (s, k) => (v(s, k) === '' ? NaN : Number(v(s, k)))
  const bat = supplies.find((s) => v(s, 'type') === 'Battery' && v(s, 'present') !== '0')
  const mains = supplies.filter((s) => v(s, 'type') === 'Mains' || v(s, 'type') === 'USB')
  if (!bat) return { present: false, ac: true }
  const status = v(bat, 'status')
  const ac = mains.length ? mains.some((s) => v(s, 'online') === '1') : status !== 'Discharging'
  const state = status === 'Full' ? 'full' : status === 'Charging' ? 'charging' : status === 'Discharging' ? 'discharging' : ac ? 'idle' : 'discharging'
  const [now, full, design, rate] = Number.isFinite(num(bat, 'energy_now'))
    ? [num(bat, 'energy_now'), num(bat, 'energy_full'), num(bat, 'energy_full_design'), num(bat, 'power_now')]
    : [num(bat, 'charge_now'), num(bat, 'charge_full'), num(bat, 'charge_full_design'), num(bat, 'current_now')]
  const hours = rate > 0 ? (state === 'discharging' ? now / rate : state === 'charging' ? (full - now) / rate : NaN) : NaN
  const pct = Number.isFinite(num(bat, 'capacity')) ? num(bat, 'capacity') : full > 0 ? Math.round((100 * now) / full) : NaN
  const cycles = num(bat, 'cycle_count')
  return { present: true, ac, pct: Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : null, state, remain: hours > 0 && hours < 100 ? Math.round(hours * 60) : null, cycles: cycles > 0 ? cycles : null, health: full > 0 && design > 0 ? Math.round((100 * full) / design) : null }
}

/** A disk's size and use from `fs.statfsSync`, counted like `df`: used / (used + available to a user). */
export function diskUse(st) {
  if (!st || !(st.blocks > 0)) return null
  const used = (st.blocks - st.bfree) * st.bsize
  const avail = st.bavail * st.bsize
  return { total: st.blocks * st.bsize, used, avail, pct: Math.round((1000 * used) / (used + avail)) / 10 }
}

/** How old a key gets before it changes by itself (1.319, REQ-S-083). */
export const KEY_ROTATE_MS = 24 * 3600_000

/** How many key changes the agent remembers (1.321, REQ-S-084). */
export const KEY_LOG_MAX = 5

/** A key change, newest first: when, why (`auto` · `site` · `gen`), and when a tab first came with the new key (`took`). */
export const noteRekey = (log, at, why) => [{ at, why, took: null }, ...(Array.isArray(log) ? log : [])].slice(0, KEY_LOG_MAX)

/** A request came with the current key: the newest change is taken up, once. Returns the same array when nothing changes. */
export function noteTook(log, now) {
  if (!Array.isArray(log) || !log[0] || log[0].took) return log
  return [{ ...log[0], took: now }, ...log.slice(1)]
}

/** What became of a change: taken up, still waiting (within the old key's grace), or missed (grace over, no tab came). */
export const rekeyResult = (e, now, graceMs) => (e?.took ? 'took' : now - (e?.at ?? 0) < graceMs ? 'waiting' : 'missed')

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
  return [bridge, String(s?.sysPrompt ?? '').trim(), fork, worktreeGoneNote(s?.worktreeGone)].filter(Boolean).join('\n\n')
}

/**
 * What a session is told when the worktree it worked in was merged and removed from the disk page (REQ-F-805):
 * its folder is then an empty one made again so the conversation can be resumed in it, and work goes on in the
 * repository's main checkout. Only the fields the agent itself wrote, each checked, reach the prompt.
 */
export function worktreeGoneNote(g) {
  const ok = (v) => typeof v === 'string' && v.length > 0 && v.length <= 300 && !/[\n\r`]/.test(v)
  if (!g || !ok(g.path) || !ok(g.repo)) return ''
  const branch = ok(g.branch) ? ` 브랜치 ${g.branch} 는` : ''
  const base = ok(g.base) ? ` ${g.base} 에` : ''
  return `[정리된 worktree] 이 세션이 쓰던 worktree ${g.path} 는${branch}${base} 머지된 뒤 디스크 관리에서 정리(git worktree remove)됐습니다. 지금 작업 폴더는 대화를 이어 가려고 다시 만든 빈 폴더입니다. 그 안의 파일이나 브랜치를 찾지 말고, 이어서 할 일이 있으면 저장소 ${g.repo} 에서 기본 브랜치를 받은 뒤 새 worktree 를 만들어 하세요.`
}

/**
 * The sessions in a worktree (REQ-F-805): each `{sid, alive}`, a live one being any whose claude has not exited.
 * A session is in it when the folder it started in or the one it works in now (`dirs`) is the worktree or inside it:
 * a session that moved into a worktree (EnterWorktree) keeps the folder it started in.
 */
export function worktreeSessions(real, list) {
  const inside = (d) => typeof d === 'string' && (d === real || d.startsWith(`${real}/`))
  return list.filter((x) => (x.dirs ?? []).some(inside)).map((x) => ({ sid: x.sid, alive: x.alive }))
}

/** The folder a transcript's last lines say the conversation was in, or null: each line carries its `cwd`. */
export function lastCwd(tail) {
  const all = [...String(tail).matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)]
  if (!all.length) return null
  try {
    const v = JSON.parse(`"${all[all.length - 1][1]}"`)
    return v.startsWith('/') ? v : null
  } catch {
    return null
  }
}

// ---------- 디스크 관리 (REQ-F-801) ----------

/**
 * The caches the disk page offers to clear: each is made again by its own tool when next needed, so clearing loses
 * nothing but a download. Only these fixed places are ever cleared; the site names an id, never a path. `how`:
 * `contents` empties the folders, `readonly` does too after making them writable (Go's module cache is read-only),
 * `trash` empties the Trash, which is the one that cannot be undone.
 */
export function diskCaches(home, platform) {
  const mac = platform === 'darwin'
  const c = (p) => path.join(home, p)
  const lib = (p) => c(path.join('Library', p))
  const xdg = (p) => c(path.join('.cache', p))
  return [
    { id: 'npm', title: 'npm 캐시', paths: [c('.npm/_cacache')], how: 'contents' },
    { id: 'yarn', title: 'Yarn 캐시', paths: [mac ? lib('Caches/Yarn') : xdg('yarn'), c('.yarn/berry/cache')], how: 'contents' },
    { id: 'pnpm', title: 'pnpm 캐시', paths: [mac ? lib('Caches/pnpm') : xdg('pnpm')], how: 'contents' },
    { id: 'homebrew', title: 'Homebrew 내려받기', paths: [mac ? lib('Caches/Homebrew') : xdg('Homebrew')], how: 'contents' },
    { id: 'go-build', title: 'Go 빌드 캐시', paths: [mac ? lib('Caches/go-build') : xdg('go-build')], how: 'contents' },
    { id: 'go-mod', title: 'Go 모듈 캐시', paths: [c('go/pkg/mod')], how: 'readonly' },
    { id: 'pip', title: 'pip 캐시', paths: [mac ? lib('Caches/pip') : xdg('pip')], how: 'contents' },
    { id: 'playwright', title: 'Playwright 브라우저', paths: [mac ? lib('Caches/ms-playwright') : xdg('ms-playwright')], how: 'contents' },
    ...(mac
      ? [
          { id: 'xcode-derived', title: 'Xcode 빌드 산출물(DerivedData)', paths: [lib('Developer/Xcode/DerivedData')], how: 'contents' },
          { id: 'simulator-caches', title: '시뮬레이터 캐시', paths: [lib('Developer/CoreSimulator/Caches')], how: 'contents' },
        ]
      : []),
    { id: 'trash', title: '휴지통', paths: mac ? [c('.Trash')] : [c('.local/share/Trash/files'), c('.local/share/Trash/info')], how: 'trash', irreversible: true },
  ]
}

/** Where a folder moved out of the way goes: the Trash, from which it can be put back. */
export const trashDir = (home, platform) => (platform === 'darwin' ? path.join(home, '.Trash') : path.join(home, '.local/share/Trash/files'))

/**
 * Folders macOS guards with a permission prompt (TCC). Measuring them from the agent could put up a dialog no one is
 * there to answer and hang the measuring, so the disk page leaves them unmeasured, and the folders holding them are
 * measured only by opening them.
 */
export function guardedDirs(home, platform) {
  if (platform !== 'darwin') return []
  const c = (p) => path.join(home, p)
  return ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies', 'Music', '.Trash', 'Library/Mail', 'Library/Messages', 'Library/Safari', 'Library/Containers', 'Library/Group Containers', 'Library/Calendars', 'Library/Reminders', 'Library/Photos', 'Library/Mobile Documents', 'Library/Application Support/AddressBook', 'Library/Application Support/CallHistoryDB', 'Library/Application Support/com.apple.TCC', 'Library/Cookies', 'Library/HomeKit', 'Library/IdentityServices', 'Library/Metadata', 'Library/Suggestions', 'Library/Accounts'].map(c)
}

/** Names under the home folder whose insides are secrets or the system's own: never moved by the disk page. */
const KEEP_UNDER_HOME = ['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.config', '.local', '.password-store', 'Library']

/**
 * Why a path cannot be moved to the Trash from the disk page, or null when it can. `real`: the path with its parent
 * folders resolved (the item itself may be a link, which is moved as a link). Inside the home folder only, never a
 * folder right under it, nothing inside KEEP_UNDER_HOME but caches two levels into ~/Library (~/Library/Caches/<x>),
 * not the Trash itself, and not a folder that holds (or is inside) what the agent and Claude keep or a session's folder.
 */
export function diskTrashable(real, { home, keep = [], sessions = [], platform }) {
  const rel = path.relative(home, real)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '홈 폴더 안만 옮길 수 있어요'
  const parts = rel.split(path.sep)
  if (parts.length < 2) return '홈 바로 아래 폴더는 옮길 수 없어요'
  const bin = trashDir(home, platform)
  if (real === bin || real.startsWith(`${bin}${path.sep}`)) return '이미 휴지통 안에 있어요'
  if (KEEP_UNDER_HOME.includes(parts[0])) {
    const cacheItem = parts[0] === 'Library' && parts[1] === 'Caches' && parts.length >= 3
    if (!cacheItem) return `~/${parts[0]} 안은 설정·비밀값이 있어 옮길 수 없어요(~/Library/Caches 안은 돼요)`
  }
  for (const d of guardedDirs(home, platform)) if (real === d || d.startsWith(`${real}${path.sep}`) || real.startsWith(`${d}${path.sep}`)) return 'macOS 가 지키는 폴더라 옮길 수 없어요'
  for (const k of keep) if (k && (real === k || k.startsWith(`${real}${path.sep}`) || real.startsWith(`${k}${path.sep}`))) return '에이전트·Claude 가 쓰는 폴더라 옮길 수 없어요'
  for (const s of sessions) if (s && (real === s || s.startsWith(`${real}${path.sep}`))) return '열린 세션의 작업 폴더가 들어 있어 옮길 수 없어요(세션을 먼저 끝내 주세요)'
  return null
}

/** `du -sk` output's first number, in bytes, or null. */
export const duBytes = (out) => {
  const n = Number(/^(\d+)/.exec(String(out ?? '').trim())?.[1])
  return Number.isFinite(n) ? n * 1024 : null
}

/** `git worktree list --porcelain`, without the main checkout (the first entry): path, HEAD, branch (short) or null. */
export function parseWorktrees(text) {
  const out = []
  for (const block of String(text ?? '').split(/\n\s*\n/)) {
    const path_ = /^worktree (.+)$/m.exec(block)?.[1]
    if (!path_) continue
    out.push({ path: path_, head: /^HEAD ([0-9a-f]{7,64})$/m.exec(block)?.[1] ?? null, branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null, prunable: /^prunable\b/m.test(block), locked: /^locked\b/m.test(block) })
  }
  return out.slice(1)
}

/** How long a worktree touched recently is left alone: another Claude, not a bridge session, may be working in it. */
export const WORKTREE_QUIET_MS = 60 * 60_000

/**
 * Why a worktree is not removed by 머지된 worktree 정리 (REQ-F-802), or null when it is: its commits are all in the
 * default branch, nothing is changed or untracked in it, it is not locked, no open session works in it, and it was
 * not touched in WORKTREE_QUIET_MS.
 */
export function worktreeWhy({ merged, dirty, locked, active, touched, now }) {
  if (active) return '살아 있는 세션이 쓰는 중'
  if (locked) return '잠겨 있음(git worktree lock)'
  if (dirty) return '고친 것·새 파일이 남아 있음'
  if (!merged) return '기본 브랜치에 머지되지 않음'
  if (touched && now - touched < WORKTREE_QUIET_MS) return '최근 1시간 안에 쓰임'
  return null
}
