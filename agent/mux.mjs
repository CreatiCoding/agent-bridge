// Which terminal program a session runs in (REQ-F-794): zeropty, which the agent fetches itself at a fixed version
// and checks against a fixed SHA-256, or tmux. Both take the same commands (zeropty speaks tmux's CLI), so only the
// program that is run differs. No dependencies: node's own fetch and crypto, and /usr/bin/tar.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'

/**
 * The zeropty release the agent uses on each system, keyed by `process.platform` (macOS, one universal build) or
 * `platform-arch`. Fixed here, in a signed agent file (REQ-S-067): what is fetched is trusted because its hash is
 * part of what the operator signed, not because of where it came from. A system with no entry has no zeropty yet:
 * its sessions run in tmux. `shim` is the library zeropty-tty preloads (DYLD_INSERT_LIBRARIES or LD_PRELOAD).
 */
export const ZEROPTY_RELEASES = Object.freeze({
  darwin: Object.freeze({
    version: '0.1.3',
    sha256: '6fe2331e9d22ef9298640d7cfa5d59e1ca55caced8d36be66ce76acc3c739f80',
    url: 'https://github.com/CreatiCoding/zeropty/releases/download/v0.1.3/zeropty-0.1.3-darwin-universal.tar.gz',
    top: 'zeropty-0.1.3-darwin-universal',
    shim: 'shim.dylib',
  }),
  'linux-x64': Object.freeze({
    version: '0.1.6',
    sha256: 'f2ba31ebb70cacdbd06b58439bea91c4a55197f9ec6ad1baaf2fdab0f930cff9',
    url: 'https://github.com/CreatiCoding/zeropty/releases/download/v0.1.6/zeropty-0.1.6-linux-x86_64.tar.gz',
    top: 'zeropty-0.1.6-linux-x86_64',
    shim: 'shim.so',
  }),
})
/** The release for a system, or null where zeropty has none. */
export const zeroptyFor = (platform, arch) => ZEROPTY_RELEASES[platform] ?? ZEROPTY_RELEASES[`${platform}-${arch}`] ?? null
/** This system's release, or null. */
export const ZEROPTY = zeroptyFor(process.platform, process.arch)
const MAX_BYTES = 64 * 1024 * 1024

/** Where a version lives under the agent's folder: `<state>/zeropty/<version>/`. All null where there is no release. */
export function zeroptyPaths(stateDir, z = ZEROPTY) {
  if (!z) return { dir: null, bin: null, tty: null, shim: null }
  const dir = path.join(stateDir, 'zeropty', z.version)
  return { dir, bin: path.join(dir, 'zeropty'), tty: path.join(dir, 'zeropty-tty'), shim: path.join(dir, z.shim ?? 'shim.dylib') }
}

/** Whether that version is unpacked and runnable. */
export function zeroptyInstalled(p) {
  if (!p.dir) return false
  try {
    fs.accessSync(p.bin, fs.constants.X_OK)
    fs.accessSync(p.tty, fs.constants.X_OK)
    return fs.statSync(p.shim).isFile()
  } catch {
    return false
  }
}

const tar = (argv) => new Promise((resolve, reject) => execFile('/usr/bin/tar', argv, { timeout: 60_000 }, (e, _o, err) => (e ? reject(new Error(String(err || e.message).trim().slice(0, 200))) : resolve())))

/**
 * Fetch, check and unpack the release into `<state>/zeropty/<version>/`, unless it is there. Nothing is left in place
 * unless the archive's SHA-256 is the fixed one: a mismatch, a short read or a broken archive installs nothing.
 * @param {string} stateDir
 * @param {{ fetch?: typeof fetch, z?: typeof ZEROPTY, log?: (m: string) => void }} [o]
 * @returns {Promise<{ ok: boolean, already?: boolean, error?: string }>}
 */
export async function installZeropty(stateDir, { fetch: get = globalThis.fetch, z = ZEROPTY, log = () => {} } = {}) {
  if (!z) return { ok: false, unsupported: true, error: '이 시스템용 zeropty 가 없음' }
  const p = zeroptyPaths(stateDir, z)
  if (zeroptyInstalled(p)) return { ok: true, already: true }
  const root = path.dirname(p.dir)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const tmp = fs.mkdtempSync(path.join(root, '.get-'))
  try {
    const r = await get(z.url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) })
    if (!r.ok) throw new Error(`받지 못함 (HTTP ${r.status})`)
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length > MAX_BYTES) throw new Error(`너무 큼 (${buf.length} byte)`)
    const got = crypto.createHash('sha256').update(buf).digest('hex')
    if (got !== z.sha256) throw new Error(`SHA-256 이 맞지 않음 (받은 것 ${got.slice(0, 12)}…, 기대 ${z.sha256.slice(0, 12)}…)`)
    const file = path.join(tmp, 'z.tar.gz')
    fs.writeFileSync(file, buf, { mode: 0o600 })
    const out = path.join(tmp, 'x')
    fs.mkdirSync(out)
    await tar(['-xzf', file, '-C', out])
    const top = path.join(out, z.top)
    for (const f of ['zeropty', 'zeropty-tty', z.shim ?? 'shim.dylib']) if (!fs.statSync(path.join(top, f)).isFile()) throw new Error(`묶음에 ${f} 가 없음`)
    fs.chmodSync(path.join(top, 'zeropty'), 0o755)
    fs.chmodSync(path.join(top, 'zeropty-tty'), 0o755)
    // Renamed into place whole, so a half-unpacked folder is never taken for an install.
    fs.rmSync(p.dir, { recursive: true, force: true })
    fs.renameSync(top, p.dir)
    log(`zeropty ${z.version} 설치함 (${p.dir})`)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** The backend a session has: one with no record started before zeropty and is tmux's until it closes. */
export const muxOf = (s) => (s?.mux === 'zeropty' ? 'zeropty' : 'tmux')

/**
 * The backend a session that starts now gets: zeropty when it is installed, unless the Mac is told to keep to tmux
 * (agent.json `mux: "tmux"`, or `--mux tmux`).
 * @param {{ force?: string, ready: boolean }} o
 */
export const pickMux = ({ force, ready }) => (force === 'tmux' || !ready ? 'tmux' : 'zeropty')

/**
 * Whether the agent should fetch zeropty: not on a Mac kept to tmux, unless a session there still runs in zeropty
 * (its path has the version in it, so an update would leave that session with no binary to drive it).
 * @param {{ force?: string, sessions: Iterable<{ mux?: string }> }} o
 */
export function needsZeropty({ force, sessions }) {
  if (force !== 'tmux') return true
  for (const s of sessions) if (muxOf(s) === 'zeropty') return true
  return false
}

/**
 * The environment zeropty is run with. Its server keeps the environment of the command that started it (as tmux
 * does), so whatever ran the agent must not leak into every session it will hold: tmux's own variables, and those
 * a running Claude Code hands its children. ZEROPTY_SOCK too: each command names its socket (REQ-F-841).
 */
export function muxEnv(env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) if (!/^(TMUX|TMUX_PANE|CLAUDECODE|CLAUDE_CODE_.*|ZEROPTY_SOCK)$/.test(k)) out[k] = v
  return out
}

/** The session a tmux-style command is about: its `-t` target or `new-session -s` name, without `=` and `:`. */
export function targetName(argv) {
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === '-t' || (argv[i] === '-s' && argv[0] === 'new-session')) return String(argv[i + 1]).replace(/^=/, '').replace(/:.*$/, '')
  return ''
}

// ---------- the bridge's own zeropty socket (REQ-F-841) ----------
// zeropty picks its server by $ZEROPTY_SOCK, else ~/.zeropty/mux.sock. Up to 1.385 the agent used that default, so
// a `zeropty kill-server` typed anywhere without a socket (on 2026-11-01, by a session developing zeropty) ended every
// bridge session. Terminals started from now on live on a socket of the bridge's own; older ones stay where they are.

/** The longest socket path each system takes, without the closing NUL (sockaddr_un.sun_path is 104 and 108). */
export const SOCK_MAX = Object.freeze({ darwin: 103, linux: 107 })

/**
 * The bridge's socket: `<state>/zeropty/bridge.sock`, or under /tmp in a folder of this user's when that path is too
 * long for a socket on this system.
 */
export function zeroptySock(stateDir, { platform = process.platform, uid = process.getuid?.() ?? 0, tmp = '/tmp' } = {}) {
  const p = path.join(stateDir, 'zeropty', 'bridge.sock')
  if (Buffer.byteLength(p) <= (SOCK_MAX[platform] ?? SOCK_MAX.darwin)) return p
  return path.join(tmp, `cb-zeropty-${uid}`, 'bridge.sock')
}

/** Where agents up to 1.385 started zeropty: the agent's own ZEROPTY_SOCK when it had one (tests), else the default. */
export const legacyZeroptySock = (env, home) => env.ZEROPTY_SOCK || path.join(home, '.zeropty', 'mux.sock')

/** The socket of a session's terminal: the one written down when it started, else the old default (started before). */
export const sockOf = (s, legacy) => (typeof s?.zsock === 'string' && s.zsock ? s.zsock : legacy)

/** The environment a zeropty command runs with: always naming its socket. */
export const zeroptyEnv = (base, sock) => ({ ...base, ZEROPTY_SOCK: sock })

// ---------- claude's terminal in zeropty: a runtime adapter, not zeropty-tty (REQ-F-794 규칙 5) ----------
// A zeropty terminal is a socket, not a PTY, and claude with no terminal falls back to --print and exits. Up to 1.387
// claude was started through zeropty-tty, which runs a hardened program from a copy of it re-signed ad hoc and loads
// the shim with DYLD_INSERT_LIBRARIES: machines that forbid either could not start it. claude's native build is a Bun
// program, so instead Bun loads this script before claude (BUN_OPTIONS=--preload; NODE_OPTIONS=--require for a claude
// installed from npm, which runs on node). The binary, its signature and its hardened runtime stay as they are.
// The same script as zeropty's examples/node/tty-adapter.cjs; it uses only what every zeropty session has.

/** The adapter's source. Written to the agent's own folder (0700) by writeTtyAdapter. */
export const TTY_ADAPTER = String.raw`// Loaded by the runtime before the program (NODE_OPTIONS=--require, BUN_OPTIONS=--preload): makes the
// zeropty session's socket a terminal to the program's tty module and process.stdout/stderr/stdin.
(() => {
  const id = /^(-?\d+):(\d+)$/.exec(process.env.ZEROPTY_TTY_ID || '');
  // The programs it starts do not load the adapter again.
  delete process.env.NODE_OPTIONS;
  delete process.env.BUN_OPTIONS;
  if (!id) return;
  const fs = require('fs'), tty = require('tty');
  // st_dev is negative on macOS (-1:...) and ino can pass 2^53: compare as bigints.
  const ours = (fd) => {
    try {
      const s = fs.fstatSync(fd, { bigint: true });
      return BigInt.asIntN(32, s.dev) === BigInt.asIntN(32, BigInt(id[1])) && s.ino === BigInt(id[2]);
    } catch { return false }
  };
  const size = () => {
    let cols = Number(process.env.ZEROPTY_COLS) || 80, rows = Number(process.env.ZEROPTY_ROWS) || 24;
    try { [cols, rows] = fs.readFileSync(process.env.ZEROPTY_SIZE_FILE, 'utf8').trim().split(/\s+/).map(Number) } catch {}
    return [cols, rows];
  };
  const isatty = tty.isatty;
  tty.isatty = (fd) => ours(fd) || isatty(fd);
  const out = [process.stdout, process.stderr].filter((s) => ours(s.fd));
  for (const s of out) {
    s.isTTY = true;
    Object.defineProperty(s, 'columns', { get: () => size()[0], configurable: true });
    Object.defineProperty(s, 'rows', { get: () => size()[1], configurable: true });
    s.getWindowSize = size;
    s.hasColors = () => true;
    s.getColorDepth = () => 8;
  }
  process.on('SIGWINCH', () => out.forEach((s) => s.emit('resize')));
  if (out.length && ours(0)) {
    process.stdin.isTTY = true;
    // Raw (0) or a new terminal's modes (15), told to zeropty in the output stream.
    process.stdin.setRawMode = function (on) {
      out[0].write(on ? '\x1b]zeropty-tty;0\x07' : '\x1b]zeropty-tty;15\x07');
      this.isRaw = !!on;
      return this;
    };
  }
})();
`

/**
 * Where the adapter is kept: `<state>/zeropty/tty-adapter.cjs`, or beside the bridge's socket under /tmp when the
 * folder has whitespace in it (BUN_OPTIONS is split at whitespace, so such a path would not reach Bun whole).
 */
export function ttyAdapterPath(stateDir, { uid = process.getuid?.() ?? 0, tmp = '/tmp' } = {}) {
  const p = path.join(stateDir, 'zeropty', 'tty-adapter.cjs')
  return /\s/.test(p) ? path.join(tmp, `cb-zeropty-${uid}`, 'tty-adapter.cjs') : p
}

/** Writes the adapter at `file` (its folder 0700, the file 0600) unless it is there as it should be. */
export function writeTtyAdapter(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.chmodSync(path.dirname(file), 0o700)
  try {
    if (fs.readFileSync(file, 'utf8') === TTY_ADAPTER) return
  } catch {}
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, TTY_ADAPTER, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** What goes before claude in a zeropty terminal: the adapter for Bun (native claude) and for node (claude from npm). */
export const adapterPrefix = (file, q) => `BUN_OPTIONS=${q(`--preload ${file}`)} NODE_OPTIONS=${q(`--require ${file}`)} `

/** A screen that says claude saw no terminal and fell back to --print (the adapter did not load). */
export const NO_TERMINAL = /no stdin data received|when used with --print|Input must be provided either through stdin/
