// Which terminal program a session runs in (REQ-F-794): zeropty, which the agent fetches itself at a fixed version
// and checks against a fixed SHA-256, or tmux. Both take the same commands (zeropty speaks tmux's CLI), so only the
// program that is run differs. No dependencies: node's own fetch and crypto, and /usr/bin/tar.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'

/**
 * The zeropty release the agent uses. Fixed here, in a signed agent file (REQ-S-067): what is fetched is trusted
 * because its hash is part of what the operator signed, not because of where it came from.
 */
export const ZEROPTY = Object.freeze({
  version: '0.1.3',
  sha256: '6fe2331e9d22ef9298640d7cfa5d59e1ca55caced8d36be66ce76acc3c739f80',
  url: 'https://github.com/CreatiCoding/zeropty/releases/download/v0.1.3/zeropty-0.1.3-darwin-universal.tar.gz',
  top: 'zeropty-0.1.3-darwin-universal',
})
/** The files a usable install has. */
const NEEDED = ['zeropty', 'zeropty-tty', 'shim.dylib']
const MAX_BYTES = 64 * 1024 * 1024

/** Where a version lives under the agent's folder: `<state>/zeropty/<version>/`. */
export function zeroptyPaths(stateDir, z = ZEROPTY) {
  const dir = path.join(stateDir, 'zeropty', z.version)
  return { dir, bin: path.join(dir, 'zeropty'), tty: path.join(dir, 'zeropty-tty') }
}

/** Whether that version is unpacked and runnable. */
export function zeroptyInstalled(p) {
  try {
    fs.accessSync(p.bin, fs.constants.X_OK)
    fs.accessSync(p.tty, fs.constants.X_OK)
    return fs.statSync(path.join(p.dir, 'shim.dylib')).isFile()
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
    for (const f of NEEDED) if (!fs.statSync(path.join(top, f)).isFile()) throw new Error(`묶음에 ${f} 가 없음`)
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
 * The environment zeropty is run with. Its server keeps the environment of the command that started it (as tmux
 * does), so whatever ran the agent must not leak into every session it will hold: tmux's own variables, and those
 * a running Claude Code hands its children.
 */
export function muxEnv(env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) if (!/^(TMUX|TMUX_PANE|CLAUDECODE|CLAUDE_CODE_.*)$/.test(k)) out[k] = v
  return out
}

/** The session a tmux-style command is about: its `-t` target or `new-session -s` name, without `=` and `:`. */
export function targetName(argv) {
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === '-t' || (argv[i] === '-s' && argv[0] === 'new-session')) return String(argv[i + 1]).replace(/^=/, '').replace(/:.*$/, '')
  return ''
}
