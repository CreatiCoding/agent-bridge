#!/usr/bin/env node
// claude-bridge local agent. Runs on the Mac that hosts Claude Code sessions.
// It listens on 127.0.0.1 only and never connects out: the bridge page in the browser relays for it.
// No dependencies; needs node >= 18, git and the `claude` CLI. Sessions run in zeropty (fetched by the agent, mux.mjs) or tmux.
import http from 'node:http'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import readline from 'node:readline/promises'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DialogDriver, parseDialog, parseKeyedDialog, classifyOption, isProceedDialog, promptHoldsFocus, cursorKeys } from './dialog.mjs'
import { writingPreview } from './preview.mjs'
import { mainColumn } from './split.mjs'
import { cacheStatus, countLine, emptyCache, trimTranscript } from './cache.mjs'
import { sessionPlugins, SkillLineReader, githubAccounts } from './plugins.mjs'
import { availableSkills, skillMenu, SkillUsage } from './skills.mjs'
import { siteLogin, safeDirName, safeConvId, insideAny, readPlain, writePlain, GIT_SAFE, manifestSigned, keyPrint, retireKey, browserApp, riskyCall, SUDO_WINDOW_MS, sudoWrapper, askpassScript, tailOf, sessionPrompt } from './guard.mjs'
import { prepareAccountDir, syncAccountConfig, newAccountId, safeAccountId, accountName, loginUrlOf, safeLoginCode, authOf, copySessionState } from './accounts.mjs'
import { transcribe as voiceTranscribe, LocalWhisper, voiceStatus } from './voice.mjs'
import { TOOLS as BRIDGE_TOOLS } from './mcp.mjs'
import { stripCreds, hideRemotes } from './scrub.mjs'
import { EventStore, saveLineImages, saveImage, imageIdOk, IMAGE_TYPES } from './store.mjs'
import { sessionStats, prLinks } from './stats.mjs'
import { ZEROPTY, zeroptyPaths, zeroptyInstalled, installZeropty, muxOf, pickMux, muxEnv, targetName } from './mux.mjs'
import { WORKING_RE, stuckState, inputBoxHas, detectEffort, detectPermissionMode, detectContext, transcriptTurnLooksOpen, transcriptHasPrompt, normalizeMessage, mostlyEnglish, screenNote, mdMaxOf, sysDialogOpen } from './screen.mjs'

const VERSION = '0.2.0'
/** The files that make up the agent. The server hands out the same list (see /install.sh). */
const AGENT_FILES = ['agent.mjs', 'dialog.mjs', 'preview.mjs', 'screen.mjs', 'plugins.mjs', 'skills.mjs', 'split.mjs', 'guard.mjs', 'accounts.mjs', 'voice.mjs', 'mcp.mjs', 'cache.mjs', 'scrub.mjs', 'store.mjs', 'stats.mjs', 'mux.mjs', 'keys.mjs']
const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url))
/** Fingerprint of those files, so the server can tell an agent that is behind the one it serves. */
const BUILD = AGENT_FILES.reduce((h, f) => h.update(fs.readFileSync(path.join(AGENT_DIR, f))), crypto.createHash('sha1')).digest('hex').slice(0, 12)
const HOME = os.homedir()
const STATE_DIR = process.env.CLAUDE_BRIDGE_HOME || path.join(HOME, '.claude-bridge')
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude')
const CLAUDE_BIN = process.env.CLAUDE_BRIDGE_CLAUDE || 'claude'
const DEFAULT_BRANCHES = (process.env.CLAUDE_BRIDGE_DEFAULT_BRANCHES || 'main,develop,master').split(',')
const INSTRUCTION_FILES = (process.env.CLAUDE_BRIDGE_SYNC_FILES || 'SESSION.md,AGENTS.md,CLAUDE.md').split(',')
const TAIL_MS = 700
const STATUS_MS = 1500
/** How long a pasted message may sit before the agent checks that it started a turn. */
const VERIFY_MS = 5_000
/** An idle prompt with an open turn is only believed after this much silence (a missed Stop hook). */
const IDLE_CLOSE_MS = 15_000
/** How long a dialog answer waits for the prompt to let go of the keyboard. */
const FOCUS_WAIT_MS = 60_000
/** A dialog that comes back this often within the window is explained once instead of asked again. */
const REPEAT_WINDOW_MS = 900_000
const FOLDER_MS = 30_000
const MAX_CHUNK = 256 * 1024
const MAX_FILE = 256 * 1024
const HEALTH_MS = 15_000
const STARTED = Date.now()
const KEYS = new Set(['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab', 'BTab', 'BSpace', 'Space', 'C-c', 'y', 'n', ...'0123456789'])

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args.splice(i, 2)[1] : undefined
}
const portArg = flag('port')
const nameArg = flag('name')
const kindArg = flag('kind')
/** `--mux tmux`: new sessions too stay in tmux; `--mux auto` goes back to zeropty when it is installed (REQ-F-794). */
const muxArg = flag('mux')
const bool = (name) => args.includes(`--${name}`) && !!args.splice(args.indexOf(`--${name}`), 1)
const noOpen = bool('no-open')
const noAutoUpdateArg = bool('no-auto-update')
const autoUpdateArg = bool('auto-update')
const noChromeArg = bool('no-chrome')
const chromeArg = bool('chrome')
const keepAwakeArg = bool('keep-awake')
const allowSleepArg = bool('allow-sleep')
/** Started by launchd as the background service: never asks, never opens a browser. */
const asService = bool('service')
// What is left is an optional site address and an optional command: doctor | link | service install|uninstall|status
const siteArg = args.find((a) => /^https?:\/\//.test(a))
const words = args.filter((a) => a !== siteArg)
const doctorOnly = words[0] === 'doctor'
const linkOnly = words[0] === 'link'
const serviceCmd = words[0] === 'service' ? words[1] || 'status' : null
const awakeCmd = words[0] === 'awake' ? words[1] || 'status' : null
if (words[0] && !doctorOnly && !linkOnly && !['install', 'uninstall', 'status'].includes(serviceCmd) && !['setup', 'remove', 'status'].includes(awakeCmd)) {
  console.error(`모르는 명령입니다: ${words.join(' ')}`)
  process.exit(1)
}

/**
 * `agent.mjs awake setup|remove|status`: the one root step behind "덮개를 닫아도 켜 두기". It installs a sudoers rule
 * that lets this user run exactly `pmset -a disablesleep 0` and `… 1` without a password, and nothing else.
 */
if (awakeCmd) {
  const file = '/etc/sudoers.d/claude-bridge-pmset'
  const user = os.userInfo().username
  if (!/^[a-z_][a-z0-9_.-]*$/i.test(user)) (console.error(`사용자 이름을 sudoers 에 쓸 수 없습니다: ${user}`), process.exit(1))
  try {
    if (awakeCmd === 'setup') {
      const tmp = path.join(os.tmpdir(), `claude-bridge-sudoers-${process.pid}`)
      fs.writeFileSync(tmp, `# claude-bridge: 덮개를 닫아도 켜 두기 (pmset disablesleep 만 허용)\n${user} ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1\n`, { mode: 0o440 })
      execFileSync('/usr/sbin/visudo', ['-cf', tmp], { stdio: 'inherit' })
      console.log('관리자 비밀번호를 물으면 넣어 주세요 (한 번만).')
      execFileSync('/usr/bin/sudo', ['/usr/bin/install', '-m', '0440', '-o', 'root', '-g', 'wheel', tmp, file], { stdio: 'inherit' })
      fs.rmSync(tmp, { force: true })
      console.log(`설정했습니다: ${file}\n이제 사이트의 기기 화면에서 "덮개를 닫아도 켜 두기" 를 켤 수 있습니다.`)
    } else if (awakeCmd === 'remove') {
      execFileSync('/usr/bin/sudo', ['/usr/bin/pmset', '-a', 'disablesleep', '0'], { stdio: 'inherit' })
      execFileSync('/usr/bin/sudo', ['/bin/rm', '-f', file], { stdio: 'inherit' })
      console.log('덮개를 닫으면 잠들게 되돌리고 설정을 지웠습니다.')
    } else {
      const ok = (() => {
        try {
          execFileSync('/usr/bin/sudo', ['-n', '-l', '/usr/bin/pmset', '-a', 'disablesleep', '1'], { stdio: 'ignore' })
          return true
        } catch {
          return false
        }
      })()
      console.log(ok ? `설정돼 있습니다 (${file})` : '설정돼 있지 않습니다. node ~/.claude-bridge/agent.mjs awake setup')
    }
    process.exit(0)
  } catch (e) {
    console.error(`하지 못했습니다: ${e.message}`)
    process.exit(1)
  }
}

if (!doctorOnly) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  // mkdir's mode does nothing for a folder that is already there (the installer made it 0755): this one holds the
  // agent key and every conversation's copy (R1-L11).
  try {
    fs.chmodSync(STATE_DIR, 0o700)
    fs.chmodSync(path.join(STATE_DIR, 'agent.log'), 0o600)
  } catch {}
}
const configPath = path.join(STATE_DIR, 'agent.json')
const sessionsPath = path.join(STATE_DIR, 'sessions.json')
const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}
const writeJson = (p, v) => {
  if (doctorOnly) return // `doctor` only looks: it leaves no config behind
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(v, null, 2), { mode: 0o600 })
  fs.renameSync(`${p}.tmp`, p)
}

// Which key generation this is. Keys made before 1.140 were on tmux command lines (`ps`, and from there pasted into
// conversations), so an agent still on generation 1 changes its key once a bridge tab that can take a new one is
// linked (R1-M8). Changing it later: the site's 복구 동작 `rekey`.
const KEY_GEN = 2
/** How long the key before a change still opens the agent: the tabs of other browsers on this Mac catch up meanwhile. */
const OLD_KEY_MS = 15 * 60_000
const config = readJson(configPath, {})
config.hostId ||= crypto.randomBytes(16).toString('hex')
// A key made here is already of this generation: it has never been on a command line, so it is not changed again.
if (!config.key) Object.assign(config, { key: crypto.randomBytes(24).toString('base64url'), keyGen: KEY_GEN })
// What Claude Code's hooks in a bridge session prove themselves with. Not the key above: it opens only /hook and
// /statusline, and it is read by curl from a file, so it is on no command line and in no environment (`ps` shows
// both, and their output gets pasted).
config.hookKey ||= crypto.randomBytes(24).toString('base64url')
// A key changed before retired keys were remembered is still in oldKey: remembered too, so its browsers find their way back.
if (config.oldKey?.key && !(config.retiredKeys ?? []).includes(keyPrint(config.oldKey.key))) config.retiredKeys = retireKey(config.retiredKeys, config.oldKey.key)
config.site = (siteArg || config.site || '').replace(/\/+$/, '')
config.port = Number(portArg || config.port || 4317)
if (!/^https?:\/\//.test(config.site) && !doctorOnly && !['status', 'uninstall'].includes(serviceCmd)) {
  console.error(`사용법:
  node agent.mjs <사이트 주소> service install   백그라운드 서비스로 설치 (로그인하면 자동으로 켜짐, 터미널 불필요)
  node agent.mjs service status | uninstall     서비스 상태 보기 / 제거
  node agent.mjs link                           연동 페이지 링크를 다시 열기
  node agent.mjs doctor                         점검만 하고 끝냄
  node agent.mjs <사이트 주소>                   이 터미널에서 직접 실행 (터미널을 닫으면 꺼짐)
옵션: --port 4317  --kind imac|macbook|macmini|macstudio|other  --name "내 아이맥"  --keep-awake|--allow-sleep  --no-open  --mux tmux|auto`)
  process.exit(1)
}

// ---------- background service (launchd) ----------

const LABEL = process.env.CLAUDE_BRIDGE_LABEL || 'dev.claude-bridge.agent'
const PLIST = path.join(HOME, 'Library/LaunchAgents', `${LABEL}.plist`)
const DOMAIN = `gui/${process.getuid?.() ?? ''}`
const SELF = fileURLToPath(import.meta.url)
const PID_FILE = path.join(STATE_DIR, 'agent.pid')
const launchctl = (...argv) => {
  try {
    return { ok: true, out: execFileSync('/bin/launchctl', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (e) {
    return { ok: false, out: String(e.stderr || e.message) }
  }
}
const serviceLoaded = () => launchctl('print', `${DOMAIN}/${LABEL}`).ok
const pingAgent = () => fetch(`http://127.0.0.1:${config.port}/ping`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).then((j) => j.agent === 'claude-bridge', () => false)
const bridgeLink = () => `${config.site}/bridge#port=${config.port}&key=${config.key}`

if (serviceCmd === 'status') {
  const loaded = serviceLoaded()
  console.log(`서비스: ${fs.existsSync(PLIST) ? (loaded ? '설치됨, 켜져 있음' : '설치됨, 꺼져 있음') : '설치 안 됨'}`)
  console.log(`에이전트: ${(await pingAgent()) ? `127.0.0.1:${config.port} 에서 응답함` : '응답 없음'}`)
  console.log(`로그: ${path.join(STATE_DIR, 'service.log')}`)
  process.exit(0)
}
if (serviceCmd === 'uninstall') {
  launchctl('bootout', `${DOMAIN}/${LABEL}`)
  fs.rmSync(PLIST, { force: true })
  console.log('서비스를 제거했습니다. 에이전트는 더 이상 자동으로 켜지지 않습니다. 설정과 로그는 ~/.claude-bridge 에 남아 있습니다.')
  process.exit(0)
}
if (linkOnly) {
  console.log(bridgeLink())
  if (process.platform === 'darwin') spawn('open', [bridgeLink()], { stdio: 'ignore', detached: true }).unref()
  process.exit(0)
}

// ---------- which device is this ----------

const KINDS = { imac: '아이맥', macbook: '맥북', macmini: '맥미니', macstudio: '맥 스튜디오', other: '기타' }
function detectKind() {
  try {
    const model = /Model Name:\s*(.+)/.exec(execFileSync('/usr/sbin/system_profiler', ['SPHardwareDataType'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }))?.[1] ?? ''
    return /iMac/i.test(model) ? 'imac' : /MacBook/i.test(model) ? 'macbook' : /Mac mini/i.test(model) ? 'macmini' : /Mac Studio/i.test(model) ? 'macstudio' : 'other'
  } catch {
    return 'other'
  }
}
if (muxArg && !['tmux', 'auto'].includes(muxArg)) {
  console.error('--mux 는 tmux 또는 auto 입니다')
  process.exit(1)
}
if (kindArg && !KINDS[kindArg]) {
  console.error(`--kind 는 ${Object.keys(KINDS).join(', ')} 중 하나입니다`)
  process.exit(1)
}
if (keepAwakeArg) config.keepAwake = true
if (allowSleepArg) config.keepAwake = false
// Remembered, so the background service started by launchd (which passes no flags) keeps the choice.
if (noAutoUpdateArg) config.noAutoUpdate = true
if (autoUpdateArg) config.noAutoUpdate = false
// Claude in Chrome for the sessions this agent starts (claude --chrome): on unless agent.json says chrome: false.
if (noChromeArg) config.chrome = false
if (chromeArg) config.chrome = true
// Written out, so the choice can be seen (and changed) in agent.json.
config.chrome ??= true
const noAutoUpdate = !!config.noAutoUpdate
if (kindArg) config.kind = kindArg
if (muxArg === 'tmux') config.mux = 'tmux'
if (muxArg === 'auto') delete config.mux
if (nameArg) config.name = nameArg
// First run: ask which device this is, so hosts and their logs can be told apart on the site.
if ((!config.kind || !config.name) && !doctorOnly) {
  const guess = config.kind || detectKind()
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    // Enter or Ctrl+D takes the suggestion.
    const ask = (q) => rl.question(q).then((a) => a.trim(), () => '')
    const keys = Object.keys(KINDS)
    if (!config.kind) {
      console.log('이 기기는 무엇인가요?')
      keys.forEach((k, i) => console.log(`  ${i + 1}) ${KINDS[k]}${k === guess ? '  (감지됨)' : ''}`))
      const a = await ask(`번호 [${keys.indexOf(guess) + 1}]: `)
      config.kind = keys[Number(a) - 1] ?? guess
    }
    if (!config.name) {
      const suggested = config.kind === 'other' ? os.hostname().replace(/\.local$/, '') : KINDS[config.kind]
      config.name = (await ask(`사이트에 보일 이름 [${suggested}]: `)).slice(0, 60) || suggested
    }
    rl.close()
  } else {
    config.kind ||= guess
    config.name ||= config.kind === 'other' ? os.hostname().replace(/\.local$/, '') : KINDS[config.kind]
  }
}
writeJson(configPath, config)

// tmux is what a session runs in when zeropty is not there (or the Mac keeps to tmux): offered now rather than missed later.
if (process.stdin.isTTY && process.platform === 'darwin' && !process.env.CLAUDE_BRIDGE_SKIP_TOOL_PROMPT && !doctorOnly) {
  const has = (cmd) => {
    try {
      execFileSync('/usr/bin/which', [cmd], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  if (!has('tmux')) {
    if (has('brew')) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const a = await rl.question('tmux 가 없습니다. Homebrew 로 설치할까요? (brew install tmux) [Y/n]: ').then((x) => x.trim().toLowerCase(), () => 'n')
      rl.close()
      if (a === '' || a === 'y' || a === 'yes') {
        try {
          execFileSync('brew', ['install', 'tmux'], { stdio: 'inherit' })
        } catch {
          console.log('tmux 설치에 실패했습니다. 에이전트는 켜지만 세션은 tmux 를 설치한 뒤에 시작할 수 있습니다.')
        }
      }
    } else console.log('tmux 가 없습니다. https://brew.sh 로 Homebrew 를 설치한 뒤 `brew install tmux` 를 실행해 주세요. 에이전트는 켜지만 세션은 그 뒤에 시작할 수 있습니다.')
  }
}
const SITE_ORIGIN = doctorOnly ? '' : new URL(config.site).origin

/**
 * sid -> session. Kept on disk: cwd, tmux, autoPush, autoAllow, conv (the Claude Code conversation id, which
 * `/clear` changes while the bridge session stays the same). Everything else is rebuilt while running:
 * the transcript position (offset, lineNo, skip), the turn, running tools, held messages, the open card.
 */
const sessions = new Map(Object.entries(readJson(sessionsPath, {})))
const saveSessions = () =>
  writeJson(sessionsPath, Object.fromEntries([...sessions].map(([id, s]) => [id, { cwd: s.cwd, tmux: s.tmux, ...(s.mux === 'zeropty' ? { mux: 'zeropty' } : {}), autoPush: s.autoPush, autoAllow: !!s.autoAllow, conv: s.conv, model: s.model, effort: s.effort, mode: s.mode, ...(s.chrome === false ? { chrome: false } : {}), sysPrompt: s.sysPrompt, launchedAt: s.launchedAt, ...(s.aliveAt ? { aliveAt: s.aliveAt } : {}), ...(s.alive === false ? { alive: false } : {}), ...(s.held?.length ? { held: s.held } : {}), ...(s.refreshAfter ? { refreshAfter: true } : {}), ...(s.lineBase ? { lineBase: s.lineBase } : {}), ...(s.mdFile ? { mdFile: s.mdFile } : {}), ...(s.account ? { account: s.account } : {}), ...(s.forkOf ? { forkOf: s.forkOf } : {}), ...(s.bridgeTools ? { bridgeTools: s.bridgeTools } : {}) }])))

/** Counters and last-seen facts reported in every health message. */
const stats = { sent: 0, commands: 0, lastCommand: null, lastError: null, lastTail: null, pageConnectedAt: null, pageConnects: 0, tools: {} }

/** Log lines not yet handed to the bridge page. They reach the server, where each host's log can be read. */
const pendingLogs = []
/**
 * @param {'info'|'warn'|'error'} level
 * @param {string} area what the agent was doing (a command name, 'push', 'link', ...)
 * @param {string} text
 * @param {string} [sid] the session it concerns
 */
function log(level, area, text, sid) {
  // A git error quotes the remote address as written, a token with it: never kept or sent that way.
  const entry = { ts: Date.now(), level, area, text: hideRemotes(text).slice(0, 2000), sid }
  if (level === 'error') stats.lastError = { ts: entry.ts, area, sid, text: entry.text.slice(0, 300) }
  console.log(`${new Date(entry.ts).toISOString().slice(11, 19)} ${level.toUpperCase().padEnd(5)} [${area}]${sid ? ` ${sid.slice(0, 8)}` : ''} ${entry.text}`)
  pendingLogs.push(entry)
  if (pendingLogs.length > 1000) pendingLogs.shift()
  if (!doctorOnly) fs.appendFile(path.join(STATE_DIR, 'agent.log'), `${JSON.stringify(entry)}\n`, { mode: 0o600 }, () => {})
}
function flushLogs() {
  if (client && welcomed && pendingLogs.length) emit({ t: 'logs', entries: pendingLogs.splice(0, 200) })
}
setInterval(flushLogs, 2000)
process.on('uncaughtException', (e) => {
  log('error', 'agent', `처리되지 않은 오류로 종료: ${e.stack || e.message}`)
  setTimeout(() => process.exit(1), 300)
})

function run(cmd, argv, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, argv, { maxBuffer: 16 * 1024 * 1024, timeout: 60_000, ...opts, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env } }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr).trim() || (err ? String(err.message) : '') }),
    )
  })
}
// ---------- the terminal program: zeropty or tmux (REQ-F-794, agent/mux.mjs) ----------

const ZP = zeroptyPaths(STATE_DIR)
/** Whether this agent's zeropty is unpacked: new sessions start in it from then on. */
let zeroptyReady = zeroptyInstalled(ZP)
/** The terminal names that live in zeropty. Every other name (an older session, one kept to tmux) is tmux's. */
const zeroptyNames = new Set()
for (const s of sessions.values()) if (muxOf(s) === 'zeropty' && s.tmux) zeroptyNames.add(s.tmux)
/** Run with zeropty's own environment (mux.mjs muxEnv): its server keeps what the command that started it had. */
const ZP_ENV = muxEnv({ ...process.env, GIT_TERMINAL_PROMPT: '0' })
const muxProgram = (name) => (zeroptyNames.has(name) ? { bin: ZP.bin, env: ZP_ENV } : { bin: 'tmux', env: process.env })
/** Where a terminal name goes from now on. */
function placeTerminal(name, mux) {
  if (mux === 'zeropty') zeroptyNames.add(name)
  else zeroptyNames.delete(name)
}
/** The backend a terminal that starts now gets. */
const newMux = () => pickMux({ force: config.mux, ready: zeroptyReady })
/** In zeropty a terminal is a socket, not a PTY: claude is started through zeropty-tty to see a terminal. */
const ttyPrefix = (mux) => (mux === 'zeropty' ? `${shq(ZP.tty)} ` : '')
/** A tmux-style command for the terminal `name`, run by that terminal's program. */
const muxAt = (name, ...argv) => {
  const m = muxProgram(name)
  return new Promise((resolve) =>
    execFile(m.bin, argv, { maxBuffer: 16 * 1024 * 1024, timeout: 60_000, env: m.env }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr).trim() || (err ? String(err.message) : '') }),
    ),
  )
}
/** Named `tmux` from before zeropty: the terminal is the command's own `-t` (or `new-session -s`). */
const tmux = (...argv) => muxAt(targetName(argv), ...argv)
/** Output as printed: a screen's leading spaces and blank lines mean something. */
const tmuxRaw = (...argv) => {
  const m = muxProgram(targetName(argv))
  return new Promise((resolve) => execFile(m.bin, argv, { maxBuffer: 16 * 1024 * 1024, timeout: 15_000, env: m.env }, (err, stdout) => resolve(err ? '' : String(stdout))))
}
/** Fetched in the background at start: a failure only means new sessions keep starting in tmux. */
async function ensureZeropty() {
  if (zeroptyReady || doctorOnly) return
  const r = await installZeropty(STATE_DIR, { log: (m) => log('info', 'zeropty', m) })
  zeroptyReady = zeroptyInstalled(ZP)
  if (!r.ok) {
    log('warn', 'zeropty', `zeropty ${ZEROPTY.version} 를 받지 못함 (새 세션은 tmux 로, ${ZEROPTY_RETRY_MS / 60_000}분 뒤 다시): ${r.error}`)
    setTimeout(() => ensureZeropty().catch(() => {}), ZEROPTY_RETRY_MS).unref()
  } else if (!r.already) (zeroptyAt = Date.now()), (checkedAt = 0) // the checks say so with the next health message
}
const ZEROPTY_RETRY_MS = 30 * 60_000
/** When zeropty was unpacked: checks that began before it are run again. */
let zeroptyAt = 0
// GIT_SAFE: a folder's own git config (core.fsmonitor, hooks) runs nothing when the agent itself calls git (R1-L10).
const git = (dir, ...argv) => run('git', [...GIT_SAFE, '-C', dir, ...argv])
const isLink = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Where Claude Code keeps transcripts. `claude auth status` reports the real place; this is the default. */
let projectsDir = path.join(CLAUDE_DIR, 'projects')

// ---------- Claude accounts (agent/accounts.mjs) ----------

const accountsPath = path.join(STATE_DIR, 'accounts.json')
/** The accounts added on this Mac: { id, name, dir }. The main one (id '') is CLAUDE_DIR and is not in the file. */
let accounts = readJson(accountsPath, []).filter((a) => a && a.id && safeAccountId(a.id) && typeof a.dir === 'string')
const saveAccounts = () => writeJson(accountsPath, accounts)
/** What `claude auth status` last said for each account id ('' is the main one). */
const accountAuth = new Map()
/** Account id -> the tmux session where its `claude auth login` waits for the code from the sign-in page. */
const logins = new Map()
/** The main account's global config, where its MCP servers and welcome marks are. */
const MAIN_CONFIG = process.env.CLAUDE_CONFIG_DIR ? path.join(CLAUDE_DIR, '.claude.json') : path.join(HOME, '.claude.json')
/** The config folder of an account id, or null when this Mac has no such account. */
const accountDir = (id) => (!id ? CLAUDE_DIR : (accounts.find((a) => a.id === id)?.dir ?? null))
/** Where an account's conversations are kept. */
const projectsOf = (id) => (!id ? projectsDir : path.join(accountDir(id) ?? path.join(STATE_DIR, 'accounts', id), 'projects'))
/** Every account's projects folder, the main one first. */
const allProjects = () => [{ account: '', dir: projectsDir }, ...accounts.map((a) => ({ account: a.id, dir: path.join(a.dir, 'projects') }))]

// ---------- the session logs, kept here (REQ-S-069) ----------

/** The numbered events of every session, as the server handed them down. The server keeps no copy. */
const store = new EventStore(path.join(STATE_DIR, 'events'))
/** Pictures by id: the ones sent from the page, and the ones in the transcripts (tail). */
const IMAGES_DIR = path.join(STATE_DIR, 'images')
/** Transcripts as they were before 대화 기록 정리 (REQ-F-793): kept whole, never deleted by the agent. */
const TRIMMED_DIR = path.join(STATE_DIR, 'trimmed')
/** How much of a transcript one `export` answer carries (base64 makes it a third bigger on the way). */
const EXPORT_PART = 4 * 1024 * 1024
/** Log hand-overs kept, told to the server in a batch so it stops holding them. */
let keptLids = []
function ackKept() {
  if (!keptLids.length || !client || !welcomed) return
  emit({ t: 'logged', lids: keptLids.splice(0, 500) })
}
setInterval(ackKept, 500).unref()
/** sid -> when its numbers were last sent, and whether they changed since. */
const statsSent = new Map()
const STATS_MS = 60_000
/** A turn that ended is counted sooner: the statistics page is often opened right after one. */
const STATS_TURN_MS = 5_000
function sendStats(sid, force = false, gap = STATS_MS) {
  const was = statsSent.get(sid)
  if (!force && was && Date.now() - was.at < gap) return void ((was.dirty = true), (was.gap = Math.min(was.gap ?? STATS_MS, gap)))
  const events = store.all(sid)
  if (!events.length) return
  statsSent.set(sid, { at: Date.now(), dirty: false })
  emit({ t: 'stats', sid, stats: sessionStats(events), prs: prLinks(events) })
}
setInterval(() => {
  if (!client || !welcomed) return
  for (const [sid, v] of statsSent) if (v.dirty && Date.now() - v.at >= (v.gap ?? STATS_MS)) sendStats(sid, true)
}, 2_000).unref()
/**
 * Every log touched in the statistics' range, once linked: one every 300 ms, so a Mac with many long logs keeps
 * reading its terminals while it counts.
 */
let statsQueue = []
function sendAllStats() {
  const from = Date.now() - 90 * 86_400_000
  const fresh = store.list().filter((sid) => {
    try {
      return fs.statSync(store.file(sid)).mtimeMs >= from
    } catch {
      return false
    }
  })
  const idle = !statsQueue.length
  statsQueue = [...new Set([...statsQueue, ...fresh])]
  if (!idle) return
  const next = () => {
    const sid = statsQueue.shift()
    if (!sid) return
    if (client && welcomed) sendStats(sid, true)
    setTimeout(next, 300).unref()
  }
  next()
}

const projectDir = (cwd, account = '') => path.join(projectsOf(account), cwd.replace(/[^a-zA-Z0-9]/g, '-'))
/** The transcript Claude Code writes for the session's current conversation. A hook's own path wins over the guess. */
const transcriptPath = (s, sid) => s.transcript || path.join(projectDir(s.cwd, s.account), `${s.conv || sid}.jsonl`)
const expandHome = (p) => (p === '~' || p.startsWith('~/') ? path.join(HOME, p.slice(1)) : p)

// ---------- link to the bridge page ----------

/** The one connected bridge page (SSE response), which tab it is, and when that tab last did anything. */
let client = null
let clientTab = ''
/** Whether the linked tab is the headless browser's (헤드리스 연동 모드). */
let clientBg = false
/** Whether the linked tab takes a new key over its stream (web/relay.js from 1.154): only such a tab is sent one. */
let clientRekey = false
/** Whether the linked tab came with the previous key (still good for OLD_KEY_MS) instead of the current one. */
let clientOldKey = false
let clientSeen = 0
let welcomed = false

function emit(msg) {
  if (!client) return
  stats.sent++
  client.write(`data: ${JSON.stringify(msg)}\n\n`)
}

async function hello() {
  welcomed = false
  const list = []
  // seq: the last number this Mac keeps, so a server that started from an older meta.json counts on from it.
  for (const [id, s] of sessions) list.push({ id, cwd: s.cwd, autoPush: s.autoPush !== false, conv: s.conv || id, alive: await alive(s), account: s.account ?? '', seq: store.tailSeq(id) })
  emit({ t: 'hello', caps: ['store'], version: VERSION, build: BUILD, hostId: config.hostId, name: config.name, kind: config.kind, home: HOME, info: { node: process.version, os: `${os.type()} ${os.release()}` }, sessions: list, ws: [...wsConns.keys()] })
}

// ---------- tmux sessions ----------

const pane = (s) => `=${s.tmux}:`

/**
 * The terminal as the dialog driver sees it. Several watchers can want the same screen at the same moment
 * (the status poll, a dialog answer, a focus retry): concurrent callers share one `capture-pane`, and since
 * only in-flight calls are shared nobody sees a stale screen.
 */
const capturing = new Map()
const term = {
  capture(target) {
    const running = capturing.get(target)
    if (running) return running
    // A split screen's right-hand panel is not the conversation: left alone, its text joins dialog lines.
    const p = tmuxRaw('capture-pane', '-p', '-t', target).then(mainColumn).finally(() => capturing.delete(target))
    capturing.set(target, p)
    return p
  },
  /** With colours (SGR) and some history, to turn what Claude is writing back into markdown. */
  captureAnsi: (target, history = 200) => tmuxRaw('capture-pane', '-p', '-e', '-S', `-${history}`, '-t', target).then(mainColumn),
  sendKeys: (target, keys) => tmux('send-keys', '-t', target, ...keys),
}
/** The only code that presses dialog keys: every press first checks that the option is on screen now. */
const driver = new DialogDriver(term, (m) => log('info', 'dialog', m))

async function alive(s) {
  return (await tmux('has-session', '-t', `=${s.tmux}`)).ok
}

/**
 * Hooks are how the agent knows a turn started, a tool ran and the turn ended, instead of guessing from the
 * words on the screen. They are registered for bridge sessions only, through `--settings`, so the person's own
 * ~/.claude/settings.json is never touched. The command posts the payload to this agent on 127.0.0.1 and
 * always exits 0: a hook must never hold up or fail the session.
 */
const hookSettingsPath = path.join(STATE_DIR, 'hooks.json')
/** The header the hooks send, as a file curl reads (`-H @file`): the key never reaches a command line. */
const hookHeaderPath = path.join(STATE_DIR, 'hook.header')
const sudoBinDir = path.join(STATE_DIR, 'bin')
const askpassPath = path.join(STATE_DIR, 'askpass')
/**
 * When Claude Code compacts a bridge session's context on its own (REQ-F-775): a Mac's choice, kept in agent.json
 * and handed to every session through the same --settings file as the hooks. Each call reads the whole context back,
 * so a session kept near a 1M window reads several times what one compacted earlier would. Nothing chosen: Claude
 * Code's own setting (the person's settings.json, or its default) is left alone. Claude Code takes 100k to 1M.
 */
const COMPACT_MIN = 100_000
const COMPACT_MAX = 1_000_000
const compactWindowOf = (v) => (Number.isInteger(v) && v >= COMPACT_MIN && v <= COMPACT_MAX ? v : null)
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'Notification', 'SessionEnd', 'PermissionRequest']
function writeHookSettings() {
  // --retry: while the agent restarts (an update) nothing listens for a few seconds; the hook is sent again
  // once it is back instead of being lost.
  const command = `[ -n "$CB_HOOK" ] && /usr/bin/curl -s -m 3 --retry 6 --retry-connrefused --retry-delay 1 --retry-max-time 10 -X POST -H @${shq(hookHeaderPath)} --data-binary @- "$CB_HOOK" >/dev/null 2>&1; exit 0`
  // PreToolUse prints what the agent answers: a deny when the note written before the call broke the session's
  // language (langGuard). The agent not answering in time prints nothing, and the call goes ahead.
  // PermissionRequest prints it too: an allow for a session in 전부 허용 (autoAllowAnswer), before any dialog is
  // drawn. Not answered in time, the dialog is drawn and read off the screen as before.
  const pre = `[ -n "$CB_HOOK" ] && /usr/bin/curl -s -m 3 --retry 6 --retry-connrefused --retry-delay 1 --retry-max-time 10 -X POST -H @${shq(hookHeaderPath)} --data-binary @- "$CB_HOOK" 2>/dev/null; exit 0`
  // The status line is how Claude Code says how full the context is and how much of the usage limits is spent.
  // It is asked for on every redraw; the agent keeps the numbers and answers with the line to print.
  const statusLine = `[ -n "$CB_HOOK" ] && /usr/bin/curl -s -m 2 -X POST -H @${shq(hookHeaderPath)} --data-binary @- "$(printf %s "$CB_HOOK" | sed 's|/hook?|/statusline?|')" 2>/dev/null || true`
  if (!doctorOnly) {
    fs.writeFileSync(hookHeaderPath, `x-bridge-key: ${config.hookKey}\n`, { mode: 0o600 })
    // sudo in a session asks the person on the web (REQ-F-764): a `sudo` first on the session's PATH, and its helper.
    fs.mkdirSync(sudoBinDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(askpassPath, askpassScript(hookHeaderPath), { mode: 0o700 })
    fs.writeFileSync(path.join(sudoBinDir, 'sudo'), sudoWrapper(askpassPath), { mode: 0o700 })
  }
  const compact = compactWindowOf(config.compactWindow)
  // The to-do list (REQ-F-778) only draws on the page: asking the person each time it changes would be noise.
  writeJson(hookSettingsPath, { hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ hooks: [{ type: 'command', command: e === 'PreToolUse' || e === 'PermissionRequest' ? pre : command, timeout: 5 }] }]])), statusLine: { type: 'command', command: statusLine }, permissions: { allow: ['mcp__bridge__todos'] }, ...(compact ? { autoCompactWindow: compact } : {}) })
}

/**
 * The person reads Korean (their default prompt is written in it), yet the short note Claude wrote right before a
 * tool call came out in English: that call is turned back once, with a word on why, so Claude writes the note
 * again in Korean (REQ-F-710). The note is read off the terminal (an interactive session writes the answer to its
 * transcript only after the call), here on the Mac, so it costs the model nothing while the notes are right. Code,
 * paths, URLs and backticks are not counted; any Hangul at all passes.
 */
const LANG_GUARD_REASON = '방금 도구를 부르기 전에 쓴 설명이 영어였어요. 이 세션의 사용자는 한국어로 읽어요. 같은 내용을 한국어 한두 줄로 다시 쓴 뒤 이 도구를 다시 부르세요(코드·명령·경로는 그대로 둬도 돼요).'
/** At most this many turn-backs in one turn: a note that will not come out in Korean does not stop the work. */
const LANG_GUARD_MAX = 2

/** What the PreToolUse hook is answered: a deny that sends Claude back to write its note in Korean, or nothing. */
async function langGuard(sid, ev) {
  const s = sessions.get(sid)
  if (!s?.turn || !s.tmux) return null
  if (!/[가-힣]/.test(String(s.sysPrompt ?? ''))) return null
  if ((s.turn.langBlocks ?? 0) >= LANG_GUARD_MAX) return null
  const note = screenNote(await term.capture(pane(s)), ev.tool_input ?? {})
  // The same note is never turned back twice: a retry without a new note goes ahead.
  if (!note || note === s.turn.langNote || !mostlyEnglish(note)) return null
  s.turn.langBlocks = (s.turn.langBlocks ?? 0) + 1
  s.turn.langNote = note
  // Only the length: the log is read by operators too, and Claude's words are the person's conversation (R1-M5).
  log('info', 'lang', `영어 설명으로 ${ev.tool_name} 를 한 번 돌려보냄 (설명 ${note.length}자)`, sid)
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: LANG_GUARD_REASON } }
}

/** Tools whose permission request is a question to the person, not a gate on an action: 전부 허용 never answers them. */
const ASKS_PERSON = new Set(['AskUserQuestion', 'ExitPlanMode'])

/**
 * 전부 허용, answered where Claude Code asks for permission, before a dialog is drawn (REQ-F-731). Reading the
 * dialog off the screen depends on how it is drawn (a split screen once ran a side panel's text into the option
 * labels, and no plain "Yes" was found to press); this does not look at the screen at all. Every allow is still
 * left in the conversation as a folded card.
 */
function autoAllowAnswer(sid, ev) {
  const s = sessions.get(sid)
  if (!s?.autoAllow || ASKS_PERSON.has(ev.tool_name)) return null
  const tool = { name: ev.tool_name, input: ev.tool_input ?? {} }
  // Still asked, as a card, even in 전부 허용 (REQ-F-759). The dialog this leaves to be drawn must not be pressed
  // by the screen reader below either, which may not know which call it is about.
  const risk = riskyCall(tool, { cwd: s.cwd, home: os.homedir() })
  s.guarded = risk ? { reason: risk, at: Date.now() } : null
  if (risk) {
    log('info', 'dialog', `전부 허용이지만 ${risk} 라 물어봄: ${ev.tool_name}`, sid)
    note(sid, `⚠️ *전부 허용*이지만 ${risk}라서 물어봐요.`, 'warn')
    return null
  }
  emit({ t: 'card', sid, card: { id: crypto.randomUUID(), kind: 'permission', open: false, auto: true, at: Date.now(), title: `${ev.tool_name} 권한 요청`, tool, result: '자동 허용' } })
  log('info', 'dialog', `전부 허용: ${ev.tool_name} 을 훅에서 허용`, sid)
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
}

/**
 * What a bridged session is told about where its answers are read. There is no channel to say it through, so it
 * goes in with the system prompt.
 */
const BRIDGE_PROMPT = 'This session is also read and driven from a web page (claude-bridge), often on a phone. When you want the person to pick between a few short options, end your answer with a fenced block tagged `choices`, one option per line, at most 6; the page shows them as buttons. Do not use it for anything else. For work of three or more steps, keep the page\'s to-do panel current with the `mcp__bridge__todos` tool: the whole list each time, one item in_progress while you work on it, completed as soon as it is done.'

async function launch(sid, s, claudeArgs) {
  // While claude is being started its terminal may not exist yet: that is not a session that ended.
  s.launching = true
  try {
    await launchNow(sid, s, claudeArgs)
  } finally {
    s.launching = false
  }
}
async function launchNow(sid, s, claudeArgs) {
  await requireReady()
  // Another Claude account runs with its own config folder (agent/accounts.mjs). What was added to the main folder
  // since (a new skills folder) is linked in now; nothing that is there is replaced.
  const accountEnv = []
  if (s.account) {
    const dir = accountDir(s.account)
    if (!dir) throw new Error('이 세션의 Claude 계정이 이 맥에 없어요. 설정 → Claude 계정에서 확인하거나 세션을 다른 계정으로 옮겨 주세요')
    prepareAccountDir(dir, { mainDir: CLAUDE_DIR, mainConfig: MAIN_CONFIG })
    accountEnv.push('-e', `CLAUDE_CONFIG_DIR=${dir}`)
  }
  writeHookSettings()
  s.tmux = `cb-${config.hostId.slice(0, 4)}-${sid.slice(0, 8)}`
  // Whatever terminal this session had goes, in the program it ran in; the new one starts in zeropty when it is
  // there (a session that was in tmux moves over when it is opened again), and a leftover of the same name there goes too.
  await tmux('kill-session', '-t', `=${s.tmux}`)
  s.mux = newMux()
  placeTerminal(s.tmux, s.mux)
  await tmux('kill-session', '-t', `=${s.tmux}`)
  resetRuntime(s)
  s.starting = true
  s.launchedAt = Date.now()
  s.pluginsAt = 0
  clearTimeout(s.slowStart)
  s.slowStart = setTimeout(() => s.starting && note(sid, '⏳ 세션이 아직 뜨는 중입니다 (예상보다 오래 걸리고 있습니다). 터미널 창은 열려 있으니 조금만 더 기다려 주세요.'), 90_000)
  s.slowStart.unref?.()
  // What a running Claude Code hands its children is dropped first: with its parent's CLAUDE_PID or CLAUDE_EFFORT
  // the new session behaves as a child of whatever session started tmux. Only those: a person's own CLAUDE_*
  // settings (a config dir, a cloud provider) must reach claude as they set them.
  const clean = 'unset CLAUDECODE CLAUDE_PID CLAUDE_EFFORT CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_CODE_SESSION_ATTENDED CLAUDE_CODE_SESSION_ID CLAUDE_CODE_SSE_PORT'
  // The trailer keeps the pane for a few seconds after claude exits, so a failed start can be read off the screen.
  // Pictures sent from the page are saved outside the working folder. Without this, reading each one would ask.
  const imagesDir = path.join(STATE_DIR, 'images')
  fs.mkdirSync(imagesDir, { recursive: true, mode: 0o700 })
  // The system prompt is read from a file by the shell when claude starts: on the tmux command line it would
  // count against tmux's limit (about 16 KB), and a default prompt of 8,000 Korean characters is about 24 KB.
  const promptsDir = path.join(STATE_DIR, 'prompts')
  fs.mkdirSync(promptsDir, { recursive: true, mode: 0o700 })
  const promptFile = path.join(promptsDir, `${sid}.txt`)
  fs.writeFileSync(promptFile, sessionPrompt(BRIDGE_PROMPT, s), { mode: 0o600 })
  // The bridge MCP server (agent/mcp.mjs): its tools hand work to a session on another Mac (REQ-F-760). Its address
  // names this session, so each session gets its own file.
  const mcpFile = path.join(promptsDir, `${sid}.mcp.json`)
  writeJson(mcpFile, { mcpServers: { bridge: { type: 'stdio', command: process.execPath, args: [path.join(AGENT_DIR, 'mcp.mjs')], env: { CB_DELEGATE: `http://127.0.0.1:${config.port}/delegate?sid=${sid}`, CB_KEY_FILE: hookHeaderPath } } } })
  fs.chmodSync(mcpFile, 0o600)
  // The tools this process starts with: a session started before a tool was added does not have it until it is
  // reopened, and the page offers to reopen it (REQ-F-778, 할 일 정리).
  s.bridgeTools = BRIDGE_TOOLS.map((t) => t.name)
  const cmd = `${clean}; export PATH=${shq(sudoBinDir)}:"$PATH"; ${ttyPrefix(s.mux)}${CLAUDE_BIN} --settings ${shq(hookSettingsPath)} --mcp-config ${shq(mcpFile)} --add-dir ${shq(imagesDir)} --append-system-prompt "$(cat ${shq(promptFile)})" ${claudeArgs.map(shq).join(' ')}; echo "[claude exited $?]"; sleep 6`
  // Tall, so Claude Code draws more of the answer it is writing (the preview is read off the screen).
  const r = await tmux('new-session', '-d', '-s', s.tmux, '-x', '220', '-y', '80', '-c', s.cwd, '-e', `CB_HOOK=http://127.0.0.1:${config.port}/hook?sid=${sid}`,
    // The suggested next prompt is drawn in the input box like typed text: an idle prompt would not read as empty.
    '-e', 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false', ...accountEnv, cmd)
  if (!r.ok) throw new Error(`${s.mux}: ${r.err}`)
  await sleep(3000)
  const screen = await term.capture(pane(s))
  if (!(await alive(s)) || /\[claude exited \d+\]/.test(screen)) {
    throw new Error(`claude 가 바로 끝났습니다: ${screen.split('\n').filter((l) => l.trim()).slice(-6).join(' / ') || '출력 없음'}`)
  }
  s.alive = true
  s.aliveAt = Date.now()
  log('info', 'session', `터미널: ${s.mux}`, sid)
}

/** Everything about a session that does not survive its terminal: a fresh start has none of it. */
function resetRuntime(s) {
  clearTimeout(s.check?.timer)
  for (const r of s.retries?.values() ?? []) r.cancelled = true
  Object.assign(s, { starting: false, hooks: false, turn: null, running: new Map(), wait: null, held: s.refreshing || s.restored || s.keepHeld ? (s.held ?? []) : [], check: null, card: null, lastTool: null, asking: null, preview: '', activityAt: Date.now(), statusKey: null, sigSeen: new Map(), retries: new Map(), gone: 0, autoTries: 0 })
}
// Read back from disk after a restart: what was held then is still owed to the session.
for (const s of sessions.values()) (s.restored = true), resetRuntime(s), delete s.restored

/**
 * What only this process knew about the work going on (a turn, the tools running, an open card, what it waits
 * for), written just before it restarts for an update and taken back by the next one, so a restart in the middle
 * of work is not noticed: the turn stays a turn, an open card stays the same card (not raised a second time).
 * Hooks that fire while no agent listens are sent again by the hook command (curl --retry) once it is back.
 */
const handoffPath = path.join(STATE_DIR, 'handoff.json')
function writeHandoff() {
  const out = {}
  for (const [sid, s] of sessions) {
    // What was read off Claude Code (its context use, the account's usage, the transcript's size) is still true
    // after the restart, but is read again only when Claude Code next shows it: dropping it took the gauges off
    // the page and put them back, moving the page (and usage came back only with the next turn).
    const seen = { context: s.context ?? null, usage: s.usage ?? null, size: s.size ?? null }
    if (!s.turn && !s.card?.open && !s.wait && !s.hooks) {
      out[sid] = { seen }
      continue
    }
    out[sid] = { seen, hooks: !!s.hooks, turn: s.turn, running: [...(s.running ?? new Map())], wait: s.wait, card: s.card?.open ? s.card : null, answered: s.answered ?? null, asking: s.asking ?? null, lastTool: s.lastTool ?? null }
  }
  writeJson(handoffPath, { at: Date.now(), sessions: out })
  log('info', 'agent', `다시 시작 전 넘겨줄 상태: 세션 ${Object.keys(out).length}개 (일하는 세션 ${Object.values(out).filter((x) => 'hooks' in x).length}개, 턴 ${Object.values(out).filter((x) => x.turn).length}개)`)
}
{
  const h = readJson(handoffPath, null)
  fs.rmSync(handoffPath, { force: true })
  // Only a handoff from a moment ago: an old file says nothing about now.
  if (h && Date.now() - h.at < 120_000)
    for (const [sid, r] of Object.entries(h.sessions ?? {})) {
      const s = sessions.get(sid)
      if (!s) continue
      // `hooks`: without it the new process judges turns by the screen alone, and a moment without the spinner
      // ended a turn that was still going (seen in the restart test).
      Object.assign(s, { context: r.seen?.context ?? undefined, usage: r.seen?.usage ?? undefined, size: r.seen?.size ?? undefined })
      if (!('hooks' in r)) continue
      log('info', 'agent', `넘겨받은 상태: 턴 ${r.turn ? '진행 중' : '없음'}, 도구 ${r.running?.length ?? 0}개, 카드 ${r.card ? '열림' : '없음'}`, sid)
      Object.assign(s, { hooks: !!r.hooks, turn: r.turn ?? null, running: new Map(r.running ?? []), wait: r.wait ?? null, card: r.card ?? null, answered: r.answered ?? null, asking: r.asking ?? null, lastTool: r.lastTool ?? null })
    }
}

// ---------- what the control page is told ----------

const WAIT_LABEL = { permission: '권한 요청', question: '질문', plan: '플랜 승인', dialog: '터미널 확인', keyed: '터미널 확인', stuck: '지시 대기' }

/** starting → idle ⇄ busy ⇄ waiting → ended. Waiting wins over busy: a person is needed. */
function phaseOf(s) {
  if (s.alive === false) return 'ended'
  if (s.starting) return 'starting'
  if (s.wait) return 'waiting'
  return s.turn ? 'busy' : 'idle'
}

let skillUsage = null
let skillUsageRun = null
/** The GitHub accounts gh is logged in with: a person's own plugin marketplaces are the ones with their name in the address. */
let githubUsers = []
githubAccounts().then((u) => (githubUsers = u), () => {})
/** Which version of the person's own plugins this session runs, and whether a refresh would bring a newer one. */
function pluginsOf(sid, s) {
  if (!githubUsers.length) return []
  if (Date.now() - (s.pluginsAt ?? 0) < 30_000) return s.plugins ?? []
  s.pluginsAt = Date.now()
  try {
    const file = transcriptPath(s, sid)
    if (s.skillReader?.file !== file) s.skillReader = Object.assign(new SkillLineReader(file), { file })
    s.plugins = sessionPlugins({ user: githubUsers, processStart: s.launchedAt, reader: s.skillReader })
  } catch {
    s.plugins = []
  }
  return s.plugins
}

/**
 * How many background shells the session's Claude process really has: its `sh -c` children. The server's list of
 * background commands is built from the transcript, which does not say when one dies; this is the ceiling for it
 * Looked at only while the server counts some, every fifteen seconds.
 */
async function countShells(s) {
  if (!(s.bgCount > 0)) return void (s.shells = undefined)
  if (Date.now() - (s.shellsAt ?? 0) < 15_000) return
  s.shellsAt = Date.now()
  const pane = await tmux('display-message', '-p', '-t', `=${s.tmux}:`, '#{pane_pid}')
  const ps = await run('ps', ['-A', '-o', 'pid=,ppid=,command='])
  if (!pane.ok || !ps.ok) return void (s.shells = undefined)
  const rows = ps.out.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: m[1], ppid: m[2], cmd: m[3] }))
  // The pane runs a shell that runs claude: claude is the process below the pane whose command is claude itself.
  const under = (pid) => rows.filter((r) => r.ppid === pid)
  let claude = null
  for (let level = [pane.out.trim()], depth = 0; level.length && depth < 4 && !claude; depth++) {
    const kids = level.flatMap(under)
    claude = kids.find((r) => /(^|\/)claude(\s|$)/.test(r.cmd) || /claude-code|\bcli\.js\b/.test(r.cmd))?.pid ?? null
    level = kids.map((r) => r.pid)
  }
  s.shells = claude ? under(claude).filter((r) => /^(\S*\/)?(ba|z|da)?sh\s+-c\b/.test(r.cmd)).length : undefined
}

// ---------- the session's own hand-over file ----------
//
// Each session writes what a later session needs (a light copy's hand-over, the summary of a compaction) into a
// file of its own in its folder: SESSION.md when that is free, else SESSION-<first 8 of its id>.md. A file the
// agent writes starts with MD_MARK naming the session; a SESSION.md without it was written by someone else (a
// person, another tool) and is not taken over.

const ownMdName = (sid) => `SESSION-${sid.slice(0, 8)}.md`
const isMdName = (n) => n === 'SESSION.md' || /^SESSION-[0-9a-f]{8}\.md$/.test(String(n))
const MD_MARK_RE = /^<!-- claude-bridge: .*?세션 ([0-9a-f]{8})/
/** The session a file's mark names: its 8-letter id, '' when the file has no mark, null when there is no file. */
function mdMark(file) {
  try {
    return MD_MARK_RE.exec(fs.readFileSync(file, 'utf8').slice(0, 400))?.[1] ?? ''
  } catch {
    return null
  }
}

/**
 * The file a session's hand-over goes in. Decided the first time it is written (claim) and kept in sessions.json;
 * before that, the name it would get. SESSION.md is the session's when no other session here holds it and it is
 * missing or marked by this session or by one this agent no longer has. A session that once wrote its own
 * SESSION-<id8>.md keeps it.
 */
function mdFileOf(sid, s, { claim = false } = {}) {
  if (isMdName(s.mdFile)) return s.mdFile
  const here = path.resolve(s.cwd)
  let name = ownMdName(sid)
  if (!fs.existsSync(path.join(s.cwd, name))) {
    const held = [...sessions].some(([id, o]) => id !== sid && o.mdFile === 'SESSION.md' && o.cwd && path.resolve(o.cwd) === here)
    const mark = mdMark(path.join(s.cwd, 'SESSION.md'))
    const markedByGone = !!mark && ![...sessions.keys()].some((id) => id.startsWith(mark))
    if (!held && (mark === null || mark === sid.slice(0, 8) || markedByGone)) name = 'SESSION.md'
  }
  if (claim) {
    s.mdFile = name
    saveSessions()
    if (name !== 'SESSION.md') excludeMdFromGit(s.cwd)
  }
  return name
}

/** SESSION-*.md files stay out of `git status`: in the repository's own exclude list (this Mac only, not committed). */
async function excludeMdFromGit(cwd) {
  const r = await run('git', [...GIT_SAFE, '-C', cwd, 'rev-parse', '--git-path', 'info/exclude'], { timeout: 5000 })
  if (!r.ok || !r.out) return
  const file = path.isAbsolute(r.out) ? r.out : path.join(cwd, r.out)
  try {
    const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    if (now.split('\n').includes('SESSION-*.md')) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${now && !now.endsWith('\n') ? '\n' : ''}# claude-bridge: 세션마다의 인수인계 파일\nSESSION-*.md\n`)
  } catch {}
}

/**
 * After a compaction (automatic or /compact): the summary Claude Code wrote for the next context is the
 * hand-over, word for word, into the session's file. No turn is spent and nothing is typed into the session.
 */
async function saveCompactSummary(sid, s) {
  // The summary line is written around the SessionStart that announces it: looked for for a few seconds.
  for (let i = 0; i < 10; i++) {
    await sleep(i ? 1000 : 300)
    let text = ''
    let uuid = ''
    try {
      const file = transcriptPath(s, sid)
      const size = fs.statSync(file).size
      const fd = fs.openSync(file, 'r')
      const len = Math.min(size, 8 * 1024 * 1024)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, size - len)
      fs.closeSync(fd)
      for (const line of buf.toString('utf8').split('\n').reverse()) {
        if (!line.includes('"isCompactSummary":true')) continue
        const o = JSON.parse(line)
        const c = o.message?.content
        text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : ''
        uuid = o.uuid ?? ''
        break
      }
    } catch {}
    if (!text.trim() || uuid === s.summaryUuid) continue
    s.summaryUuid = uuid
    const name = mdFileOf(sid, s, { claim: true })
    const body = `<!-- claude-bridge: compact 요약을 자동으로 옮김 · 세션 ${sid.slice(0, 8)} · ${new Date().toISOString()} -->\n\n# 세션 인수인계 (자동)\n\n${text.trim()}\n`
    try {
      // Not through a link in its place (R1-L9): writePlain throws on one, and nothing is written.
      writePlain(path.join(s.cwd, name), body)
      s.mdAt = 0
      note(sid, `📝 compact 요약을 ${name} 에 저장했어요`)
      log('info', 'session', `compact 요약 → ${name} (${Buffer.byteLength(body)} byte)`, sid)
    } catch (e) {
      log('error', 'session', `compact 요약을 ${name} 에 쓰지 못함: ${e.message}`, sid)
    }
    return publish(sid, s)
  }
  log('warn', 'session', 'compact 요약을 대화 기록에서 찾지 못함', sid)
}

/**
 * A session that is ended takes its hand-over file with it, into the Trash (moved, never deleted: it can be put
 * back). Only a file the session holds (mdFile): one it never wrote, a hand-written SESSION.md, or the file a light
 * copy handed on to the new session is not its own and stays.
 */
function trashMdFile(sid, s) {
  if (!isMdName(s.mdFile) || !s.cwd) return
  const from = path.join(s.cwd, s.mdFile)
  if (!fs.existsSync(from)) return
  try {
    const bin = path.join(HOME, '.Trash')
    fs.mkdirSync(bin, { recursive: true })
    let to = path.join(bin, s.mdFile)
    if (fs.existsSync(to)) to = path.join(bin, `${s.mdFile.replace(/\.md$/, '')} ${new Date().toISOString().replace(/[:.]/g, '-')}.md`)
    fs.renameSync(from, to)
    log('info', 'session', `종료하며 ${s.mdFile} 를 휴지통으로 옮김`, sid)
  } catch (e) {
    log('warn', 'session', `종료하며 ${s.mdFile} 를 휴지통으로 옮기지 못함: ${e.message}`, sid)
  }
}

/** How big the session's hand-over file is, and its name; looked at no more than every ten seconds. */
function sessionMdBytes(sid, s) {
  if (Date.now() - (s.mdAt ?? 0) < 10_000) return s.mdBytes ?? null
  s.mdAt = Date.now()
  s.mdName = mdFileOf(sid, s)
  try {
    s.mdBytes = fs.statSync(path.join(s.cwd, s.mdName)).size
  } catch {
    s.mdBytes = 0
  }
  return s.mdBytes
}

const kb = (n) => `${Math.round(n / 1000)}KB`

function publish(sid, s) {
  const tool = [...s.running.values()].at(-1)
  const status = {
    alive: s.alive !== false,
    phase: phaseOf(s),
    waiting: s.wait ? WAIT_LABEL[s.wait.reason] ?? '응답 대기' : null,
    waitingSince: s.wait?.since ?? null,
    held: s.held.map(({ id, text, at }) => ({ id, text, at })),
    tool: tool ? { name: tool.name, title: tool.title, at: tool.at } : null,
    tools: s.running.size,
    running: [...s.running.values()].map((r) => r.title).filter(Boolean).slice(0, 20),
    sessionMd: sessionMdBytes(sid, s),
    mdFile: s.mdName ?? null,
    mdMax: mdMaxOf(s),
    plugins: pluginsOf(sid, s),
    servers: (s.servers ?? []).map(({ port, title }) => ({ port, title })),
    ...(typeof s.shells === 'number' ? { shells: s.shells } : {}),
    turnAt: s.turn?.at ?? null,
    mode: s.mode ?? null,
    effort: s.effort ?? null,
    context: s.context ?? null,
    autoAllow: !!s.autoAllow,
    model: s.model ?? null,
    refreshAfter: !!s.refreshAfter,
    bridgeTools: s.bridgeTools ?? null,
    size: s.size ?? null,
    handedOffTo: s.handedOffTo ?? null,
    usage: s.usage ?? null,
    cache: cacheStatus(s.cache),
    // A turn that has shown nothing new for a minute and a half: the page says so instead of just "working".
    quietSince: s.turn && !s.wait && Date.now() - s.activityAt >= 90_000 ? s.activityAt : null,
    card: s.card?.open ? s.card.id : null,
  }
  const key = JSON.stringify(status)
  if (key === s.statusKey) return
  s.statusKey = key
  emit({ t: 'status', sid, ...status })
}

/** A line in the conversation that comes from the agent, not from Claude. */
const note = (sid, text, tone = 'info') => emit({ t: 'note', sid, text, tone, at: Date.now() })
/** Something only the person who just pressed a button needs to read. */
const toast = (sid, text) => emit({ t: 'toast', sid, text })

function setPreview(sid, s, text) {
  if (text === s.preview) return
  s.preview = text
  emit({ t: 'preview', sid, text })
}

// ---------- turns ----------

function beginTurn(sid, s) {
  s.turn = { at: Date.now() }
  s.running = new Map()
  s.starting = false
  s.activityAt = Date.now()
  // The screen that asked may already be gone; its card must not stay looking unanswered.
  if (s.card?.open) foldCard(sid, s, '넘어감 (새 턴이 시작됐습니다)')
  s.wait = null
  setPreview(sid, s, '')
}

function endTurn(sid, s, why) {
  if (!s.turn) return
  s.turn = null
  s.running = new Map()
  s.asking = null
  setPreview(sid, s, '')
  s.folderAt = 0 // a turn just ended: sync the folder now
  tail(sid, s)
  if (why) log('info', 'turn', why, sid)
  if (s.refreshAfter) return void maybeRefresh(sid, s)
  releaseHeld(sid, s, 'turn ended')
}

/**
 * A refresh that was asked for "when the work is done": done means no turn, nothing asking, and no background
 * work the reopening would cut off. Looked at when a turn ends, when the background count changes, and every
 * minute in between.
 */
function maybeRefresh(sid, s) {
  if (!s.refreshAfter || s.refreshing) return
  if (s.turn || s.starting || (s.card?.open && s.card.kind !== 'stuck')) return
  if ((s.bgCount ?? 0) > 0) {
    if (!s.bgSaid) note(sid, '🔄 작업과 백그라운드 작업이 끝나면 새로고침할게요. 그사이 보낸 메시지는 새로고침한 세션에 전달해요')
    s.bgSaid = true
    return
  }
  s.bgSaid = false
  refresh(sid, s).catch((e) => log('error', 'refresh', e.message, sid))
}
setInterval(() => sessions.forEach((s, sid) => maybeRefresh(sid, s)), 60_000).unref()

// ---------- messages in ----------

const isSlash = (text) => /^\/[\w:-]+(\s|$)/.test(text) && !text.includes('\n')

/**
 * A message for the session. While a turn runs it is held and handed over when the running tool finishes, so it
 * neither interrupts the work nor gets typed into a confirmation that happens to be on screen. A question or plan that is waiting is closed first: the message is the answer.
 */
async function inject(sid, s, text, id) {
  // Being reopened: there is no terminal for a moment, and what is said now is for the session that comes back.
  if (s.refreshing) return hold(sid, s, text, id)
  // Still starting: a start-up dialog may be on screen, and what is typed now would go into it.
  if (s.starting) return (toast(sid, '세션이 뜨면 바로 전달할게요'), hold(sid, s, text, id))
  if (!(await alive(s))) return toast(sid, '세션이 이 맥에서 돌고 있지 않아 전달하지 못했습니다.')
  tail(sid, s)
  const card = s.card?.open ? s.card : null
  if (card && (card.kind === 'permission' || card.kind === 'keyed')) return hold(sid, s, text, id)
  if (card && card.kind !== 'stuck') {
    await closeOpenDialog(s)
    foldCard(sid, s, '메시지로 답함')
    return delivered(sid, [id], deliver(sid, s, text))
  }
  if (s.refreshAfter || s.refreshing) return hold(sid, s, text, id)
  if (s.turn && !s.wait) return hold(sid, s, text, id)
  return delivered(sid, [id], deliver(sid, s, text))
}
/** Say which messages have been handed to the session, once they have: the page marks them as delivered. */
async function delivered(sid, ids, done) {
  await done
  const known = ids.filter(Boolean)
  if (known.length) emit({ t: 'delivered', sid, ids: known })
}

function hold(sid, s, text, id) {
  s.held.push({ id: id || crypto.randomUUID(), text, at: Date.now() })
  saveSessions()
  log('info', 'send', s.running.size ? 'held while a tool runs' : 'held while the turn runs', sid)
  publish(sid, s)
}

/** Esc until the numbered dialog is gone, so the message is not typed into it. */
async function closeOpenDialog(s) {
  for (let i = 0; i < 5; i++) {
    const d = parseDialog(await term.capture(pane(s)))
    // A yes/no permission dialog that came up meanwhile is not closed: Esc there means "deny".
    if (!d || isProceedDialog(d)) return
    await term.sendKeys(pane(s), ['Escape'])
    await sleep(150)
  }
}

async function deliver(sid, s, text, attempts = 1) {
  const slash = isSlash(text)
  if (slash && /^\/model\b/.test(text.trim())) s.modelAskAt = Date.now()
  if (!slash && !s.turn) beginTurn(sid, s)
  if (slash) {
    // Typed, not pasted, with a moment for the command list to draw before Enter picks from it.
    await tmux('send-keys', '-t', pane(s), '-l', text)
    await sleep(150)
  } else {
    // Unique per message: two sessions sending in the same millisecond must not share one (R1-L12).
    const buffer = `cb-${crypto.randomUUID()}`
    // Through a file: as an argument, a long message makes tmux refuse the command ("command too long") and
    // nothing is pasted, while the Enter after it still goes out.
    const file = path.join(STATE_DIR, `${buffer}.txt`)
    fs.writeFileSync(file, text, { mode: 0o600 })
    const loaded = await muxAt(s.tmux, 'load-buffer', '-b', buffer, file)
    fs.rmSync(file, { force: true })
    if (!loaded.ok) throw new Error(`글을 터미널에 올리지 못했습니다: ${loaded.err}`)
    // -p brackets the paste so a newline inside stays part of the message; -d drops the buffer afterwards.
    await tmux('paste-buffer', '-p', '-d', '-b', buffer, '-t', pane(s))
    // A long paste takes the terminal a moment to take in; Enter before that is lost.
    await sleep(200 + Math.min(1500, Math.floor(text.length / 20)))
  }
  await term.sendKeys(pane(s), ['Enter'])
  log('info', 'send', `delivered by keys (${text.length}자)`, sid)
  if (!slash) watchInjected(sid, s, text, attempts)
  publish(sid, s)
}

/** Hand over everything held as one message, once nothing is running that it could cut into. */
function releaseHeld(sid, s, reason) {
  if (!s.held.length || s.starting) return
  if (s.refreshAfter || s.refreshing) return
  if (s.turn && s.running.size) return
  if (s.card?.open && (s.card.kind === 'permission' || s.card.kind === 'keyed')) return
  const held = s.held.splice(0)
  saveSessions()
  const texts = held.map((h) => h.text)
  log('info', 'send', `releasing held messages (${reason})`, sid)
  delivered(sid, held.map((h) => h.id), deliver(sid, s, texts.join('\n\n'))).catch((e) => log('error', 'send', `붙잡은 메시지를 전달하지 못함: ${e.message}`, sid))
}

/**
 * A paste followed by Enter does not always start a turn: the Enter can arrive before the paste has settled,
 * and the text then sits in the input box. Nothing says so, so the agent looks.
 */
function watchInjected(sid, s, text, attempts, at = Date.now()) {
  clearTimeout(s.check?.timer)
  s.check = { text, attempts, at, timer: setTimeout(() => verifyInjected(sid, s).catch((e) => log('warn', 'send', `verify failed: ${e.message}`, sid)), VERIFY_MS) }
}

/** The prompt Claude Code says it received is the one that was pasted: nothing to verify any more. */
function confirmInjected(sid, s, prompt) {
  if (!s.check) return
  if (!normalizeMessage(prompt).includes(normalizeMessage(s.check.text).slice(0, 200))) {
    // Lengths only (no words in the log): what differed shows whether the hook carries the message in another form.
    return log('warn', 'send', `UserPromptSubmit 의 글이 보낸 글과 다름 (훅 ${normalizeMessage(prompt).length}자, 보낸 글 ${normalizeMessage(s.check.text).length}자)`, sid)
  }
  clearTimeout(s.check.timer)
  s.check = null
}

async function verifyInjected(sid, s) {
  const check = s.check
  s.check = null
  if (!check || !(await alive(s))) return
  const screen = await term.capture(pane(s))
  const head = check.text.split('\n')[0].slice(0, 30)
  if (inputBoxHas(screen, head)) {
    if (check.attempts >= 3) return log('warn', 'send', '글이 입력칸에 남아 있고 Enter 를 세 번 눌러도 보내지지 않음', sid)
    log('warn', 'send', '글이 입력칸에 남아 있어 Enter 를 다시 누름', sid)
    await term.sendKeys(pane(s), ['Enter'])
    return watchInjected(sid, s, check.text, check.attempts + 1, check.at)
  }
  // With hooks, an open turn means the prompt was taken (or Claude Code queued it behind the running one).
  if (s.hooks ? s.running.size || WORKING_RE.test(screen) : s.turn) return
  if (stuckState(screen) !== 'idle') return
  if (transcriptTurnLooksOpen(transcriptPath(s, sid))) return
  // A turn short enough to be over within VERIFY_MS looks like no turn at all; the transcript says it was taken
  // (without this the message went a second time, 1.180).
  if (transcriptHasPrompt(transcriptPath(s, sid), check.text, check.at - 1000)) return log('info', 'send', '대화 기록에 들어가 있어 다시 보내지 않음 (훅 확인 없음)', sid)
  if (check.attempts < 2) {
    log('warn', 'send', '턴이 시작되지 않아 한 번 더 보냄', sid)
    s.turn = null
    return deliver(sid, s, check.text, check.attempts + 1)
  }
  log('error', 'send', '보낸 글이 세션에 전달되지 않음', sid)
  endTurn(sid, s)
  note(sid, '⚠️ 방금 메시지가 세션에 전달되지 않은 것 같습니다 (두 번 보냈지만 응답이 시작되지 않음). 화면을 확인해 주세요.', 'warn')
}

// ---------- hooks ----------

function toolTitle(name, input) {
  const v = input?.command ?? input?.file_path ?? input?.pattern ?? input?.description ?? input?.url ?? input?.query ?? ''
  return `${name}${v ? ` ${String(v).split('\n')[0].slice(0, 80)}` : ''}`
}

/** A hook says what happened; the screen and the transcript fill in the rest. */
async function onHook(sid, ev) {
  const s = sessions.get(sid)
  if (!s) return
  s.hooks = true
  s.activityAt = Date.now()
  const name = ev.hook_event_name
  if (ev.transcript_path && ev.session_id === (s.conv || sid)) s.transcript = ev.transcript_path
  if (name === 'SessionStart') {
    s.starting = false
    setTimeout(() => releaseHeld(sid, s, 'started'), 1500)
    if (ev.session_id && ev.session_id !== (s.conv || sid)) switchConversation(sid, s, ev)
    else if (ev.source === 'compact') note(sid, '📦 컨텍스트 압축 완료')
    if (ev.source === 'compact') saveCompactSummary(sid, s).catch((e) => log('error', 'session', e.message, sid))
  } else if (name === 'UserPromptSubmit') {
    confirmInjected(sid, s, ev.prompt ?? '')
    beginTurn(sid, s)
  } else if (name === 'PreToolUse' && ev.tool_name) {
    if (!s.turn) beginTurn(sid, s)
    s.turn.tools = (s.turn.tools ?? 0) + 1
    s.lastTool = { key: ev.tool_use_id ?? ev.tool_name, name: ev.tool_name, input: ev.tool_input, at: Date.now() }
    s.running.set(s.lastTool.key, { name: ev.tool_name, title: toolTitle(ev.tool_name, ev.tool_input), at: Date.now() })
    if (ev.tool_name === 'AskUserQuestion') s.asking = { kind: 'question', key: s.lastTool.key, answered: 0, questions: (Array.isArray(ev.tool_input?.questions) ? ev.tool_input.questions : []).slice(0, 8).map((q) => ({ header: String(q.header ?? '').slice(0, 40), question: String(q.question ?? ''), multi: q.multiSelect === true })) }
    if (ev.tool_name === 'ExitPlanMode') s.asking = { kind: 'plan', key: s.lastTool.key, plan: typeof ev.tool_input?.plan === 'string' ? ev.tool_input.plan : '' }
    // A confirmation, if this tool needs one, is drawn right after: look soon instead of at the next poll.
    setTimeout(() => watch(sid, s).catch(() => {}), 400)
  } else if (name === 'PostToolUse' || name === 'PostToolUseFailure') {
    const key = ev.tool_use_id ?? ev.tool_name
    s.running.delete(key)
    if (s.asking?.key === key) s.asking = null
    tail(sid, s)
    releaseHeld(sid, s, 'tool finished')
  } else if (name === 'Stop') {
    // The Stop of a turn that was just interrupted can arrive after the next message started a new one.
    if (s.escAt && Date.now() - s.escAt < 5000 && s.turn && s.turn.at >= s.escAt && !s.turn.tools) log('info', 'turn', 'late Stop of the interrupted turn ignored', sid)
    else endTurn(sid, s)
  } else if (name === 'Notification') {
    setTimeout(async () => {
      await watch(sid, s).catch(() => {})
      // Claude Code says it waits for input, and the screen shows no dialog the agent can read: say so anyway.
      if (/^(elicitation_dialog|agent_needs_input)$/.test(ev.notification_type ?? '') && !s.card?.open && ev.message) note(sid, `⏸️ 터미널에서 입력을 기다리는 중: ${String(ev.message).slice(0, 500)}`, 'warn')
    }, 300)
  } else if (name === 'SessionEnd' && ev.reason !== 'clear') {
    log('info', 'session', `claude 가 끝남 (${ev.reason ?? 'unknown'})`, sid)
  }
  publish(sid, s)
}

/**
 * `/clear` starts a new conversation under a new id while the terminal, and so the bridge session, stays.
 * The transcript to sync and to resume from is the new one from here on.
 */
function switchConversation(sid, s, ev) {
  const fresh = ev.source === 'clear' || ev.source === 'compact'
  Object.assign(s, { conv: ev.session_id, transcript: ev.transcript_path || null, offset: 0, lineNo: 0, skip: 0, lineBase: 0 })
  saveSessions()
  log('info', 'session', `대화가 바뀜 (${ev.source ?? '?'}) → ${ev.session_id.slice(0, 8)}`, sid)
  // A resumed conversation that got a new id starts with a copy of the old lines: synced, but not shown twice.
  emit({ t: 'conv', sid, conv: ev.session_id, replay: !fresh })
  if (ev.source === 'clear') note(sid, '🧹 /clear · 대화가 초기화됐어요')
  if (ev.source === 'compact') note(sid, '📦 컨텍스트 압축 완료')
}

// ---------- cards: what the terminal asks, as buttons ----------

function openCard(sid, s, card) {
  s.card = { id: crypto.randomUUID(), open: true, at: Date.now(), ...card }
  s.wait = { reason: card.kind, since: s.wait?.since ?? Date.now() }
  s.gone = 0
  const { sig: _sig, ...shown } = s.card
  emit({ t: 'card', sid, card: shown })
  // Not the title: it is Claude's question or the command, and operators read host logs too (R1-M5).
  log('info', 'card', `${card.kind} (제목 ${String(card.title ?? '').length}자)`, sid)
}

function foldCard(sid, s, result) {
  if (!s.card?.open) return
  s.card.open = false
  s.answered = { sig: s.card.sig, at: Date.now() }
  emit({ t: 'card', sid, card: { id: s.card.id, open: false, result, at: Date.now() } })
  s.wait = null
  s.activityAt = Date.now()
  // Messages that waited behind this card go on once it is answered.
  if (s.held?.length) setTimeout(() => releaseHeld(sid, s, 'card answered'), 800)
}

/**
 * Look for a dialog on the screen and show it as a card. Returns true when the screen holds one (shown now or
 * already). Every numbered dialog becomes a card with the options that are on screen, whatever asked for it:
 * a tool confirmation, AskUserQuestion, a plan, or something this agent has never seen. The hooks only say
 * which kind it is and what the tool was about.
 */
async function surfaceDialog(sid, s, screen) {
  const d = parseDialog(screen)
  if (!d) {
    const k = parseKeyedDialog(screen)
    if (!k) return false
    const sig = `keyed|${k.question}|${k.body ?? ''}`
    if (s.card?.sig === sig) return ((s.gone = 0), true)
    if (s.card?.open) foldCard(sid, s, '다른 확인 창으로 넘어감')
    openCard(sid, s, { kind: 'keyed', sig, title: k.question, description: k.body, footer: k.footer, selected: k.selected, options: k.options.map((label, n) => ({ n, label, kind: 'other' })) })
    return true
  }
  const proceed = isProceedDialog(d)
  const tool = s.lastTool && s.running.has(s.lastTool.key) ? { name: s.lastTool.name, input: s.lastTool.input } : null
  // Two confirmations in a row read the same ("Do you want to proceed?"): the tool call tells them apart.
  const unticked = (label) => String(label).replace(/^\[[^\]]?\]\s*/, '')
  const sig = `${d.question}|${d.options.map((o) => unticked(o.label)).join('|')}${proceed && tool ? `|${s.lastTool.key}` : ''}`
  if (s.card?.open && s.card.sig === sig) return ((s.gone = 0), true)
  // Just answered and not yet redrawn: not a new question.
  if (s.answered?.sig === sig && Date.now() - s.answered.at < 3000) return true
  const guarded = s.guarded && Date.now() - s.guarded.at < 120_000 ? s.guarded.reason : null
  const risk = s.autoAllow && proceed ? guarded ?? (tool ? riskyCall(tool, { cwd: s.cwd, home: os.homedir() }) : null) : null
  if (risk && !guarded) note(sid, `⚠️ *전부 허용*이지만 ${risk}라서 물어봐요.`, 'warn')
  if (s.autoAllow && proceed && !risk) {
    // 전부 허용: the widest allow that ends with the session, never one that is written into the settings.
    const r = await driver.answerProceed(pane(s), 'auto')
    if (r === 'answered') {
      s.autoTries = 0
      emit({ t: 'card', sid, card: { id: crypto.randomUUID(), kind: 'permission', open: false, auto: true, at: Date.now(), title: d.question, context: d.context, tool, result: '자동 허용' } })
      return true
    }
    if (r === 'unfocused' && ++s.autoTries <= 3) return true
    s.autoTries = 0
  }
  // The same dialog coming back after it was answered is a setting that needs a restart, not a question.
  const kind = proceed ? 'permission' : (s.asking?.kind ?? 'dialog')
  const seen = s.sigSeen.get(sig)
  const count = kind !== 'dialog' ? 1 : seen && Date.now() - seen.at < REPEAT_WINDOW_MS ? seen.n + 1 : 1
  s.sigSeen.set(sig, { n: count, at: Date.now() })
  if (count > 2) {
    if (count === 3) note(sid, '같은 확인 창이 되풀이됩니다. 답해도 다시 뜨는 창이라 카드를 더 올리지 않습니다. 설정을 바꿨다면 세션을 다시 열어야 반영됩니다. 터미널 화면에서 직접 확인해 주세요.', 'warn')
    s.wait = { reason: 'dialog', since: s.wait?.since ?? Date.now() }
    return true
  }
  const flat = (t) => String(t ?? '').replace(/\s+/g, ' ').trim()
  // Several questions asked at once end on Claude Code's own "Submit answers" line. Every question was answered
  // from a card: that line is pressed for the person, not shown as one more question (REQ-F-027).
  if (kind === 'question' && s.asking?.questions?.length) {
    const submit = d.options.find((o) => /submit answers?/i.test(o.label))
    if (submit && s.asking.answered >= s.asking.questions.length) {
      const r = await driver.answerNumber(pane(s), String(submit.n))
      log('info', 'dialog', `submit answers: ${r}`, sid)
      if (r === 'answered') return true
    }
  }
  const asked = kind === 'question' ? s.asking?.questions?.find((q) => q.question && flat(d.question).includes(flat(q.question).slice(0, 60))) : null
  if (s.card?.open) foldCard(sid, s, '다른 확인 창으로 넘어감')
  openCard(sid, s, {
    kind,
    sig,
    ...(asked?.header ? { header: asked.header } : {}),
    ...(asked?.multi ? { multi: true } : {}),
    title: d.question,
    description: d.description,
    context: d.context,
    // Under the last option of a multi-select sits its "Submit" line: that is the card's 확정 button, not a description.
    options: d.options.map((o) => ({ n: o.n, label: asked?.multi ? unticked(o.label) : o.label, description: asked?.multi && /^Submit$/.test(String(o.description ?? '').trim()) ? undefined : o.description, kind: classifyOption(o.label) })),
    ...(proceed && tool ? { tool } : {}),
    ...(kind === 'plan' && s.asking?.plan ? { plan: s.asking.plan.slice(0, 40_000) } : {}),
  })
  return true
}

/**
 * The dialog is up but the prompt has the keyboard (a background agent asked while the main loop is mid-turn):
 * a digit pressed now would be typed into the prompt and sent as the message "1". Wait for the prompt to let
 * go, press once, and say nothing if the dialog was answered some other way meanwhile.
 */
function retryWhenFocused(sid, s, key, attempt, done) {
  const prev = s.retries.get(key)
  if (prev) prev.cancelled = true
  const me = { cancelled: false }
  s.retries.set(key, me)
  const started = Date.now()
  const tick = async () => {
    if (me.cancelled || !sessions.has(sid) || !(await alive(s))) return s.retries.delete(key)
    const screen = await term.capture(pane(s))
    if (!parseDialog(screen) && !parseKeyedDialog(screen)) {
      s.retries.delete(key)
      return log('info', 'dialog', 'dialog gone before the prompt let go; nothing to press', sid)
    }
    if (!promptHoldsFocus(screen)) {
      s.retries.delete(key)
      log('info', 'dialog', 'retried once the prompt let go', sid)
      return done(await attempt())
    }
    if (Date.now() - started >= FOCUS_WAIT_MS) {
      s.retries.delete(key)
      log('warn', 'dialog', '1분을 기다려도 프롬프트가 키보드를 쥐고 있어 확인 창을 누르지 못함', sid)
      return toast(sid, '1분을 기다렸지만 터미널이 계속 프롬프트 입력을 받고 있어 확인 창을 대신 누르지 못했습니다. 응답이 끝난 뒤 다시 눌러 주세요.')
    }
    setTimeout(() => tick().catch(() => {}), 500)
  }
  setTimeout(() => tick().catch(() => {}), 500)
}

/** A button on a card. It only presses when that card is still the open one and its option is on screen. */
async function answerCard(sid, s, cardId, n) {
  const card = s.card
  if (!card?.open || card.id !== cardId) return toast(sid, '이 선택은 이미 끝났습니다 (다른 카드로 넘어갔습니다).')
  const option = card.options?.find((o) => String(o.n) === String(n))
  // A confirmation's answer in the reader's words; anything else by the label that was on screen.
  const label = (card.kind === 'permission' && { 'allow-once': '허용', 'allow-session': '이 세션 동안 허용', 'allow-always': '항상 허용', deny: '거부' }[option?.kind]) || `선택: ${option?.label ?? `${n}번`}`
  if (card.kind === 'stuck') return
  const flat = (t) => String(t ?? '').replace(/\s+/g, ' ').trim()
  if (card.kind === 'keyed') {
    // The button was drawn for one question. If the screen has moved on, it is not pressed (REQ-F-095).
    const now = parseKeyedDialog(await term.capture(pane(s)))
    if (!now) {
      foldCard(sid, s, '이미 닫힌 창')
      return toast(sid, '이미 닫힌 창이에요')
    }
    if (flat(now.question) !== flat(card.title)) return toast(sid, '이미 다른 질문으로 바뀌었어요. 지금 화면을 확인해 주세요')
    if (n === 'esc') {
      await term.sendKeys(pane(s), ['Escape'])
      return foldCard(sid, s, '취소함 (Esc)')
    }
    // Arrows from wherever the cursor is now to the line with that label, then Enter.
    const target = now.options.findIndex((l) => flat(l) === flat(option?.label))
    if (target < 0) return toast(sid, '이미 다른 질문으로 바뀌었어요. 지금 화면을 확인해 주세요')
    await term.sendKeys(pane(s), cursorKeys(target - now.selected))
    return foldCard(sid, s, '답함')
  }
  if (card.multi) {
    // Several may be chosen: a number only ticks its line, and 확정 is what answers the question.
    // As Claude Code draws it (seen on 2.1.289): a digit alone ticks or unticks its line, with no Enter; the
    // answer is given on an unnumbered "Submit" line under the options, reached with the down arrow.
    const ticked = (screen) => screen.split('\n').filter((l) => /^\s*(❯\s*)?\d+\.\s*\[[^\] ]\]/.test(l)).map((l) => l.replace(/^\s*(❯\s*)?\d+\.\s*\[[^\]]\]\s*/, '').trim())
    if (n === 'enter') {
      let screen = await term.capture(pane(s))
      if (!parseDialog(screen)) return (foldCard(sid, s, '이미 닫힌 창'), toast(sid, '이미 닫힌 창이에요'))
      const chosen = ticked(screen)
      for (let i = 0; i < 12 && !/^\s*❯\s+Submit\s*$/m.test(screen); i++) {
        await term.sendKeys(pane(s), ['Down'])
        await sleep(120)
        screen = await term.capture(pane(s))
      }
      if (!/^\s*❯\s+Submit\s*$/m.test(screen)) return toast(sid, '확정할 자리를 찾지 못했어요. 화면을 확인해 주세요')
      await term.sendKeys(pane(s), ['Enter'])
      if (s.asking) s.asking.answered++
      foldCard(sid, s, `선택: ${chosen.join(', ') || '없음'}`)
      return publish(sid, s)
    }
    if (n !== 'esc') {
      if (promptHoldsFocus(await term.capture(pane(s))) || !parseDialog(await term.capture(pane(s)))?.options.some((o) => String(o.n) === String(n))) return toast(sid, '이미 닫힌 창이에요')
      await term.sendKeys(pane(s), [String(n)])
      await sleep(300)
      const now = ticked(await term.capture(pane(s)))
      return toast(sid, now.length ? `고른 것: ${now.join(', ')} · 다 고르면 확정을 누르세요` : '고른 것이 없어요')
    }
  }
  if (n === 'esc') {
    // Only while that dialog is still up: an old card's Esc must not stop a turn that is running now.
    if (!parseDialog(await term.capture(pane(s)))) {
      foldCard(sid, s, '이미 닫힌 창')
      return toast(sid, '이미 닫힌 창이에요')
    }
    await term.sendKeys(pane(s), ['Escape'])
    return foldCard(sid, s, '취소함 (Esc)')
  }
  const finish = (r) => {
    if (r === 'answered') {
      if (card.kind === 'question' && s.asking) s.asking.answered++
      return (foldCard(sid, s, label), publish(sid, s))
    }
    if (r === 'gone') {
      foldCard(sid, s, '확인 창이 이미 닫혔습니다')
      toast(sid, '그 확인 창이 이미 사라졌습니다. 터미널 화면으로 확인해 주세요.')
      return publish(sid, s)
    }
  }
  const press = () => driver.answerNumber(pane(s), String(n))
  const r = await press()
  if (r !== 'unfocused') return finish(r)
  toast(sid, '⏳ 터미널이 프롬프트 입력을 받는 중이라 확인 창을 아직 못 눌렀습니다. 응답이 끝나는 대로 자동으로 누릅니다.')
  retryWhenFocused(sid, s, `answer:${cardId}`, press, finish)
}

/**
 * One Esc, a second to settle, then say what the screen shows. Never a second Esc:
 * by then a new message may already have started the next turn, and that Esc would stop it instead.
 */
/** Whether anything at all is typed in the input box (the lines between the last two rules on the screen). */
function unsentInBox(screen) {
  const lines = screen.split('\n')
  const rules = lines.map((l, i) => (/^[\s─━]*[─━]{20,}[\s─━]*$/.test(l) ? i : -1)).filter((i) => i >= 0)
  return rules.length >= 2 && lines.slice(rules.at(-2) + 1, rules.at(-1)).some((l) => /^\s*❯\s*\S/.test(l))
}
async function interrupt(sid, s) {
  const turn = s.turn
  await term.sendKeys(pane(s), ['Escape'])
  if (turn) s.escAt = Date.now()
  log('info', 'esc', 'sent', sid)
  await sleep(1000)
  const screen = await term.capture(pane(s))
  const state = stuckState(screen)
  // An idle-looking prompt is only "stopped" if the transcript agrees: between two steps the screen looks idle too.
  const stopped = state === 'interrupted' || (state === 'idle' && !!turn && !transcriptTurnLooksOpen(transcriptPath(s, sid)))
  if (stopped) {
    if (s.card?.open && s.card.kind !== 'stuck') foldCard(sid, s, '취소함 (Esc)')
    // Only the turn that was running when Esc was pressed: one that began since is not this Esc's to end.
    if (s.turn === turn) endTurn(sid, s, 'interrupted')
    return toast(sid, `⏹️ 멈췄어요. 다음 지시를 기다려요${unsentInBox(screen) ? ' 입력칸에 보내지 않은 글이 남아 있어요' : ''}`)
  }
  if (!turn && !WORKING_RE.test(screen)) return toast(sid, '이미 쉬고 있었어요. 멈출 작업이 없어요')
  toast(sid, 'Esc 를 보냈지만 터미널에 아직 작업 표시가 남아 있어요. 잠시 뒤 화면을 확인하세요')
}

// ---------- model, effort, permission mode; refresh ----------

const MODES = ['default', 'acceptEdits', 'plan', 'auto']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
/** What a copy is told to start with instead of the original's (the person's defaults, 설정): the valid ones only. */
const launchOver = (o) => ({
  ...(/^[\w.[\]-]{1,60}$/.test(o?.model || '') ? { model: o.model } : {}),
  ...(EFFORTS.includes(o?.effort) ? { effort: o.effort } : {}),
  ...(MODES.includes(o?.mode) ? { mode: o.mode } : {}),
})
/** The longest first prompt passed on claude's command line, in bytes; a longer one is pasted after start. */
const FIRST_PROMPT_MAX = 8000
/** The arguments that start a session the way it is set now: what a refresh or a move must not lose. */
/**
 * The launch flags kept with a session. Claude in Chrome: a session turned off on its own gets --no-chrome (over the
 * person's own default); otherwise --chrome while the agent's `chrome` is on (default), so a session can read sites
 * only the person's signed-in Chrome can. Every session that has it shares the one Chrome extension.
 */
const settingsArgs = (s) => [...(/^[\w.[\]-]+$/.test(s.model || '') ? ['--model', s.model] : []), ...(EFFORTS.includes(s.effort) ? ['--effort', s.effort] : []), ...(MODES.includes(s.mode) ? ['--permission-mode', s.mode] : []), ...(s.chrome === false ? ['--no-chrome'] : config.chrome !== false ? ['--chrome'] : [])]

/**
 * `/model x` and `/effort x` are typed into the terminal; the permission mode is reached by shift+tab, read off
 * the status line after every press. A value already set is not typed again.
 */
async function setSetting(sid, s, kind, value) {
  if (kind === 'model' || kind === 'effort') {
    if (kind === 'effort' && !EFFORTS.includes(value)) return
    if (!/^[\w.[\]-]{1,60}$/.test(value)) return
    if (s[kind] === value) return toast(sid, `이미 ${kind} ${value} 입니다.`)
    await deliver(sid, s, `/${kind} ${value}`)
    s[kind] = value
    saveSessions()
    toast(sid, `→ /${kind} ${value}`)
    // A model switch asks before dropping the prompt cache. The person already chose: the watcher says yes.
    for (let i = 0; i < 10; i++) {
      await sleep(300)
      await watch(sid, s).catch(() => {})
    }
    return
  }
  if (kind !== 'mode' || !MODES.includes(value)) return
  const read = await cycleToMode(s, value)
  toast(sid, read === value ? '권한 모드를 바꿨어요' : `⚠️ 권한 모드를 ${value}로 못 바꿨습니다 (현재 ${read ?? '?'}). 화면을 확인하세요.`)
}

/** shift+tab until the status line reads the mode asked for, five presses at most. Returns the mode it ends on. */
async function cycleToMode(s, value) {
  let read = null
  for (let i = 0; i < 5; i++) {
    read = detectPermissionMode(await term.capture(pane(s)))
    if (!read || read === value) break
    await term.sendKeys(pane(s), ['BTab'])
    for (let t = 0; t < 12; t++) {
      await sleep(100)
      const now = detectPermissionMode(await term.capture(pane(s)))
      if (now && now !== read) break
    }
  }
  read = detectPermissionMode(await term.capture(pane(s))) ?? read
  if (read) s.mode = read
  return read
}

/**
 * Close the terminal and open the same conversation again in the same place: what was installed since (skills,
 * plugins, MCP servers) is picked up, and the conversation goes on. Held messages are
 * carried over and handed to the new process.
 */
async function refresh(sid, s) {
  if (s.refreshing) return
  s.refreshing = true
  s.refreshAfter = false
  // Reopened in the middle of work (a turn going, or waiting on a question): the work is cut off with the old
  // process, so the session that comes back is told first to go on with it.
  const working = !!(s.turn || s.wait)
  log('info', 'refresh', `refreshing on request${working ? ' (mid-turn: will be told to go on)' : ''}`, sid)
  note(sid, working ? '🔄 세션을 다시 엽니다 — 하던 작업이 끊기니, 다시 뜨면 이어서 하라고 전할게요.' : '🔄 세션을 다시 엽니다 — 대화는 그대로 이어지고, 새로 설치한 스킬·플러그인·MCP가 반영됩니다.')
  try {
    tail(sid, s)
    await tmux('kill-session', '-t', `=${s.tmux}`)
    await launch(sid, s, ['--resume', s.conv || sid, ...settingsArgs(s)])
    if (working) s.held.unshift({ id: crypto.randomUUID(), at: Date.now(), text: '[새로고침] 세션을 다시 여느라 하던 작업이 중간에 끊겼어요. 끊기기 전에 하던 작업을 이어서 진행해 주세요.' })
    if (s.interrupted?.length) s.held.unshift({ id: crypto.randomUUID(), at: Date.now(), text: `[새로고침] 세션을 다시 열면서 백그라운드 작업이 끊겼어요.\n${s.interrupted.map((x) => `- ${x}`).join('\n')}\n필요한 것만 다시 걸고, 걸었으면 짧게 알려 줘요.${s.interrupted.some((x) => x.startsWith('에이전트:')) ? '\n끊긴 백그라운드 에이전트는 SendMessage 로 이어받을 수 없어요(기록이 없어요). 이미 끝낸 부분은 그 에이전트의 출력 파일에서 확인하고, 남은 일만 새 에이전트(Agent, run_in_background)로 다시 띄워 주세요.' : ''}` })
    s.interrupted = null
    // What was held before, and what was said while it was closed, goes to the session that came back.
    setTimeout(() => releaseHeld(sid, s, 'refreshed'), 2500)
  } catch (e) {
    log('error', 'refresh', `세션을 다시 열지 못함: ${e.message}`, sid)
    note(sid, `❌ 세션을 다시 열지 못했습니다. ${e.message}`, 'warn')
  } finally {
    s.refreshing = false
    publish(sid, s)
  }
}

// ---------- the screen, watched ----------

/**
 * One look at a session's terminal: is it alive, is something asking, is it stuck. Runs every STATUS_MS and
 * right after a hook that usually means a dialog.
 */
async function watch(sid, s) {
  if (s.watching) return
  s.watching = true
  try {
    const isAlive = await alive(s)
    if (!isAlive && (s.refreshing || s.reviving || s.launching)) return
    if (!isAlive) {
      if (s.alive !== false) {
        log('warn', 'session', `claude 가 끝남 (${muxOf(s)} 세션 없음)`, sid)
        if (s.card?.open) foldCard(sid, s, '세션이 끝남')
        const lost = s.held.splice(0).length
        note(sid, '세션이 끝났어요 (claude 가 종료됨). 글을 보내면 대화 그대로 다시 엽니다.', 'warn')
        if (lost) note(sid, `⚠️ 세션이 끝나 붙잡아 둔 메시지 ${lost}개는 전달하지 못했습니다.`, 'warn')
        // Kept on disk: an agent that restarts (an update) knows it already said so, and does not say it again.
        s.alive = false
        saveSessions()
        s.turn = null
        s.running = new Map()
        s.wait = null
        setPreview(sid, s, '')
        tail(sid, s)
      }
      s.alive = false
      return publish(sid, s)
    }
    s.alive = true
    const screen = await term.capture(pane(s))

    // Nobody is at the terminal to accept folder trust, and a model switch was already chosen. A project MCP
    // server is not accepted here: its dialog becomes a card (R1-M1).
    // Only when such a dialog is expected: while the session starts (folder trust, the Chrome and channel notices),
    // and for a model switch the person just asked for. At any other time a dialog-shaped answer is not one (R1-H2).
    const expected = s.starting ? null : Date.now() - (s.modelAskAt ?? 0) < 30_000 ? ['model-switch'] : []
    const known = await driver.confirmKnown(pane(s), screen, expected)
    if (known) {
      log('info', 'dialog', `auto-confirmed ${known}`, sid)
      if (!s.starting) note(sid, `↩️ 터미널 확인 창(${known})을 자동으로 넘겼습니다`)
      return publish(sid, s)
    }
    const stuck = stuckState(screen)
    if (s.starting && (stuck === 'idle' || WORKING_RE.test(screen))) (s.starting = false), releaseHeld(sid, s, 'started')
    s.mode = detectPermissionMode(screen) ?? s.mode
    await countShells(s).catch(() => {})
    // 전부 허용 holds only over manual mode: looked at every half minute, put back if it moved, turned off if it will not go back.
    if (s.autoAllow && s.mode && s.mode !== 'default' && Date.now() - (s.autoCheckAt ?? 0) > 30_000) {
      s.autoCheckAt = Date.now()
      const moved = s.mode
      if ((await cycleToMode(s, 'default')) === 'default') note(sid, `🔁 전부 허용인데 터미널이 ${moved} 모드여서 manual 로 되돌렸습니다.`)
      else {
        s.autoAllow = false
        saveSessions()
        note(sid, `⚠️ 터미널이 ${moved} 모드라 전부 허용을 껐습니다.`, 'warn')
      }
    }
    s.effort = detectEffort(screen) ?? s.effort
    s.context = detectContext(screen) ?? s.context

    if (await surfaceDialog(sid, s, screen)) return publish(sid, s)
    // The card's dialog is no longer drawn: someone answered it at the terminal. Two looks, since a redraw can blank it.
    if (s.card?.open && s.card.kind !== 'stuck' && ++s.gone >= 2) foldCard(sid, s, '터미널에서 답함')
    if (s.wait && !s.card?.open) s.wait = null

    const working = WORKING_RE.test(screen)
    if (working) s.activityAt = Date.now()
    // An old Claude Code without these hooks: the screen is all there is to go by.
    if (!s.hooks) {
      if (working && !s.turn) beginTurn(sid, s)
      else if (!working && s.turn && stuck) endTurn(sid, s)
    }
    if (stuck === 'interrupted') {
      // Esc does not fire a Stop hook. The words are on screen; say so instead of showing a busy session.
      if (s.turn) endTurn(sid, s, 'interrupted (read off the screen)')
      if (s.card?.sig !== 'stuck|interrupted') openCard(sid, s, { kind: 'stuck', sig: 'stuck|interrupted', title: '작업이 중단된 채 다음 지시를 기다리고 있습니다', description: '이어서 하려면 계속해 를 누르거나 새 지시를 쓰세요.', options: [] })
    } else {
      if (s.card?.open && s.card.kind === 'stuck') foldCard(sid, s, '이어서 진행')
      if (s.card?.sig === 'stuck|interrupted') s.card = null
      if (s.turn && stuck === 'idle' && Date.now() - s.activityAt >= IDLE_CLOSE_MS && !transcriptTurnLooksOpen(transcriptPath(s, sid))) {
        log('warn', 'turn', 'idle prompt with an open turn; closing it (Stop hook missed?)', sid)
        endTurn(sid, s)
      }
    }
    publish(sid, s)
  } finally {
    s.watching = false
  }
}

/** What Claude is writing right now. The transcript only gets a block when it is finished. */
async function readPreview(sid, s) {
  if (!s.turn || s.wait || s.alive === false) return
  const text = writingPreview(await term.captureAnsi(pane(s)), s.preview)
  // '' while busy is a thinking pause, or the block scrolled away: what was shown stays.
  if (text) setPreview(sid, s, text)
}

// ---------- transcript tail ----------

function tail(sid, s) {
  const file = transcriptPath(s, sid)
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return
  }
  if (stat.size < (s.offset ?? 0)) Object.assign(s, { offset: 0, lineNo: s.lineBase ?? 0 })
  s.offset ??= 0
  s.lineNo ??= 0
  s.skip ??= 0
  if (stat.size === s.offset) return
  // Read from the start (a new agent, a rewind, a transcript that shrank): the cache counts start over with it.
  if (s.offset === 0 || !s.cache) s.cache = emptyCache()
  const fd = fs.openSync(file, 'r')
  try {
    const start = s.offset
    const buf = Buffer.alloc(Math.min(stat.size - s.offset, 8 * 1024 * 1024))
    const n = fs.readSync(fd, buf, 0, buf.length, s.offset)
    const end = buf.lastIndexOf(0x0a, n - 1)
    if (end < 0) return
    const lines = buf.subarray(0, end).toString('utf8').split('\n')
    s.offset += end + 1
    let batch = []
    let size = 0
    let from = s.lineNo
    const flush = () => {
      if (batch.length) emit({ t: 'lines', sid, from, lines: batch })
      from += batch.length
      batch = []
      size = 0
    }
    for (const line of lines) {
      // Every line, the ones the server already has too: the counts cover the whole conversation.
      countLine(s.cache, line)
      if (s.lineNo < s.skip) {
        s.lineNo++
        from = s.lineNo
        continue
      }
      // Its pictures stay here: the server keeps none (REQ-S-069).
      try {
        saveLineImages(line, IMAGES_DIR)
      } catch {}
      if (size + line.length > MAX_CHUNK) flush()
      batch.push(line)
      size += line.length
      s.lineNo++
    }
    flush()
    // Read to the end and still short of what the server has: lines were taken out of the file with nothing kept to
    // say how many (대화 기록 정리 by an agent before 1.304, a trimmed copy from another Mac). The server has every
    // line here, so numbering goes on from its count; otherwise every new line, the answers too, is skipped as sent.
    if (s.lineNo < s.skip && n === stat.size - start) {
      log('warn', 'tail', `대화 파일이 서버보다 ${s.skip - s.lineNo}줄 짧아 줄 번호를 서버에 맞춤`, sid)
      s.lineBase = (s.lineBase ?? 0) + s.skip - s.lineNo
      s.lineNo = s.skip
      saveSessions()
    }
    s.activityAt = Date.now()
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * A conversation's file on this Mac, wherever an account keeps it: the place it had before, else any account's
 * project folder that has `<conv>.jsonl`. Null when this Mac does not have it.
 */
function findTranscript(conv, before) {
  if (!safeConvId(conv)) return null
  if (before && fs.existsSync(before)) return before
  for (const { dir } of allProjects()) {
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {}
    for (const n of names) {
      const p = path.join(dir, n, `${conv}.jsonl`)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

/**
 * Re-read the transcript from the start, sending only the lines the server does not have yet. The file's first line
 * is line lineBase: what 대화 기록 정리 took out of it still counts.
 */
function rewind(s, serverLines) {
  Object.assign(s, { offset: 0, lineNo: s.lineBase ?? 0, skip: serverLines })
}

// ---------- working folder ----------

async function repoInfo(dir, label, s, allowPush) {
  const branch = (await git(dir, 'symbolic-ref', '--short', '-q', 'HEAD')).out || null
  const sha = (await git(dir, 'rev-parse', 'HEAD')).out || null
  const origin = stripCreds((await git(dir, 'remote', 'get-url', 'origin')).out) || null
  const dirty = (await git(dir, 'status', '--porcelain')).out !== ''
  const info = { dir: label, branch, sha, origin, dirty, push: 'off', pushed: false }
  if (!sha) return info
  info.pr = await prOf(dir, branch, s)
  const onRemote = async () => (await git(dir, 'branch', '-r', '--contains', sha)).out !== ''
  info.pushed = await onRemote()
  if (!origin) info.push = 'no-remote'
  else if (!branch) info.push = 'detached'
  else if (DEFAULT_BRANCHES.includes(branch)) info.push = 'default-branch'
  else if (!allowPush) info.push = 'off'
  else if (info.pushed) info.push = 'ok'
  else {
    s.pushTried ??= {}
    // One attempt per commit: a rejected push is not retried every tick. Never forced.
    if (s.pushTried[label] !== sha) {
      s.pushTried[label] = sha
      const r = await git(dir, 'push', '-u', 'origin', `${branch}:${branch}`)
      s.pushError = { ...s.pushError, [label]: r.ok ? null : hideRemotes(r.err.split('\n').slice(-2).join(' ')) }
      log(r.ok ? 'info' : 'warn', 'push', `${label} ${branch} ${sha.slice(0, 7)}: ${r.ok ? '푸시됨' : `실패 — ${r.err}`}`)
      info.pushed = await onRemote()
    }
    info.push = info.pushed ? 'ok' : `failed: ${s.pushError?.[label] || '거절됨'}`
  }
  return info
}

/**
 * The pull request of a branch, asked of `gh`. An open one is asked about again after
 * 90 seconds; a merged or closed one is remembered. No gh, no PR, a default branch: nothing.
 */
async function prOf(dir, branch, s) {
  if (!branch || DEFAULT_BRANCHES.includes(branch)) return null
  s.prs ??= {}
  const key = `${dir}:${branch}`
  const had = s.prs[key]
  if (had && (['MERGED', 'CLOSED'].includes(had.pr?.state) || Date.now() - had.at < 90_000)) return had.pr
  const r = await run('gh', ['pr', 'view', branch, '--json', 'number,url,state,isDraft,title'], { cwd: dir, timeout: 15_000 })
  let pr = null
  try {
    const j = JSON.parse(r.out)
    if (r.ok && j.url) pr = { number: j.number, url: String(j.url), state: j.isDraft && j.state === 'OPEN' ? 'DRAFT' : String(j.state), title: String(j.title ?? '').slice(0, 120) }
  } catch {}
  s.prs[key] = { at: Date.now(), pr }
  return pr
}

async function snapshotFolder(s) {
  const allowPush = s.autoPush !== false
  const folder = { git: false, files: {}, repos: [], at: Date.now() }
  if (!fs.existsSync(s.cwd)) return folder
  folder.git = (await git(s.cwd, 'rev-parse', '--is-inside-work-tree')).out === 'true'
  if (folder.git) folder.repos.push(await repoInfo(s.cwd, '.', s, allowPush))
  else {
    // Not through a link that leads out of the folder: its target would go to the server (R1-L9).
    for (const name of INSTRUCTION_FILES) {
      const text = readPlain(path.join(s.cwd, name), MAX_FILE, s.cwd)
      if (text != null) folder.files[name] = text
    }
  }
  // The session's own hand-over file goes along in a repository too: SESSION-*.md is kept out of git.
  if (isMdName(s.mdFile) && !folder.files[s.mdFile]) {
    const text = readPlain(path.join(s.cwd, s.mdFile), MAX_FILE, s.cwd)
    if (text != null) folder.files[s.mdFile] = text
  }
  let entries = []
  try {
    entries = fs.readdirSync(s.cwd, { withFileTypes: true })
  } catch {}
  for (const e of entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').slice(0, 60)) {
    const dir = path.join(s.cwd, e.name)
    if (fs.existsSync(path.join(dir, '.git'))) folder.repos.push(await repoInfo(dir, e.name, s, allowPush))
  }
  return folder
}

async function syncFolder(sid, s) {
  s.folderAt = Date.now()
  try {
    // A conversation this large is slow to resume and to move: the page warns at 50 MB and stops taking text at 100.
    s.size = fs.statSync(transcriptPath(s, sid)).size
  } catch {}
  const folder = await snapshotFolder(s)
  emit({ t: 'folder', sid, folder })
  return folder
}

/** Bring a repository to the synced branch and commit. Returns warnings; never touches uncommitted work. */
async function loadRepo(dir, repo) {
  const tag = repo.dir === '.' ? '작업 폴더' : repo.dir
  if (!fs.existsSync(dir)) {
    if (!repo.origin) return [`${tag}: 폴더가 없고 원격 주소도 없어 불러오지 못했습니다`]
    const r = await run('git', [...GIT_SAFE, 'clone', '--', repo.origin, dir], { timeout: 300_000 })
    if (!r.ok) return [`${tag}: clone 실패 (${r.err.split('\n').pop()})`]
  }
  if ((await git(dir, 'rev-parse', '--is-inside-work-tree')).out !== 'true') return [`${tag}: git 저장소가 아닙니다`]
  if (!repo.sha) return []
  if ((await git(dir, 'rev-parse', 'HEAD')).out === repo.sha && (!repo.branch || (await git(dir, 'symbolic-ref', '--short', '-q', 'HEAD')).out === repo.branch)) return []
  if ((await git(dir, 'status', '--porcelain')).out !== '') return [`${tag}: 커밋 안 된 변경이 있어 건드리지 않았습니다 (${repo.branch || repo.sha.slice(0, 7)} 를 불러오지 않음)`]
  await run('git', [...GIT_SAFE, '-C', dir, 'fetch', 'origin'], { timeout: 120_000 })
  if (!(await git(dir, 'cat-file', '-e', `${repo.sha}^{commit}`)).ok) return [`${tag}: 커밋 ${repo.sha.slice(0, 7)} 을 불러올 수 없습니다 (원격에 푸시되지 않음)`]
  if (!repo.branch) {
    const r = await git(dir, 'checkout', '--detach', repo.sha)
    return r.ok ? [] : [`${tag}: checkout 실패 (${r.err.split('\n').pop()})`]
  }
  const hasBranch = (await git(dir, 'rev-parse', '--verify', '-q', `refs/heads/${repo.branch}`)).ok
  const r = hasBranch ? await git(dir, 'checkout', repo.branch) : await git(dir, 'checkout', '-b', repo.branch, repo.sha)
  if (!r.ok) return [`${tag}: checkout 실패 (${r.err.split('\n').pop()})`]
  if ((await git(dir, 'rev-parse', 'HEAD')).out !== repo.sha) {
    const ff = await git(dir, 'merge', '--ff-only', repo.sha)
    if (!ff.ok) return [`${tag}: 브랜치 ${repo.branch} 가 이 기기에서 갈라져 있어 ${repo.sha.slice(0, 7)} 로 맞추지 못했습니다`]
  }
  return []
}

function backup(file, sid) {
  const dir = path.join(STATE_DIR, 'overwritten')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const to = path.join(dir, `${sid}-${Date.now()}-${path.basename(file)}`)
  fs.copyFileSync(file, to)
  // A conversation or a folder's notes: for this user only (R1-L11).
  fs.chmodSync(to, 0o600)
}

// ---------- commands from the server ----------

/**
 * Asked of the server for the bridge MCP server (REQ-F-760): the agent's own request, answered by 'delegated' with
 * the same areq. A wait on another session can be long; the server answers within its own limit.
 */
const delegating = new Map()
function delegate(sid, op, args) {
  const areq = crypto.randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => delegating.delete(areq) && resolve({ ok: false, error: '브릿지 서버가 답하지 않았어요' }), 1_920_000)
    delegating.set(areq, (r) => (clearTimeout(timer), delegating.delete(areq), resolve(r)))
    emit({ t: 'delegate', areq, sid, op: String(op).slice(0, 40), args: args && typeof args === 'object' ? args : {} })
  })
}

/**
 * 관리자 권한 (REQ-F-764): the admin password the person typed on the web, in memory for SUDO_WINDOW_MS from when it
 * was typed. Never written to disk or a log, and not handed to the next agent (handoff): a restart closes it.
 * Every use is asked of the server first, which refuses a session worked on in Slack and, when no password is
 * kept, shows the person the window to type it in.
 */
let sudoPass = null // { pw, until, timer }
const SUDO_ASK_MS = 120_000
const SUDO_RUN_MS = 300_000
const sudoWaits = new Map()
const sudoState = () => emit({ t: 'sudostate', until: sudoPass?.until ?? 0, waiting: [...sudoWaits.keys()] })
function sudoForget() {
  clearTimeout(sudoPass?.timer)
  sudoPass = null
  sudoState()
}
/** Asks the server whether this session may use root now; resolves { ok, error }. */
function sudoAsk(sid, what) {
  const areq = crypto.randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sudoWaits.delete(areq)
      emit({ t: 'sudogone', areq })
      resolve({ ok: false, error: '비밀번호를 기다리다 2분이 지났어요' })
    }, SUDO_ASK_MS)
    sudoWaits.set(areq, (r) => (clearTimeout(timer), sudoWaits.delete(areq), resolve(r)))
    emit({ t: 'sudoask', areq, sid, what: String(what ?? '').slice(0, 300), need: !sudoPass })
  })
}
/** Runs sudo with the password on its stdin; resolves { code, out }. -k: a cached sudo ticket is never what lets it through. */
function sudoSpawn(pw, args, { cwd = HOME, ms = 15_000 } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let p
    try {
      p = spawn('/usr/bin/sudo', ['-S', '-k', '-p', '', ...args], { cwd: fs.existsSync(cwd) ? cwd : HOME, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ code: -1, out: e.message })
    }
    const add = (d) => {
      out += d
      if (out.length > 400_000) out = out.slice(-200_000)
    }
    p.stdout.on('data', add)
    p.stderr.on('data', add)
    const timer = setTimeout(() => ((out += `\n(${Math.round(ms / 1000)}초가 지나 멈춤)`), p.kill('SIGTERM')), ms)
    p.on('error', (e) => add(e.message))
    p.on('close', (code) => (clearTimeout(timer), resolve({ code: code ?? -1, out })))
    p.stdin.on('error', () => {})
    p.stdin.end(`${pw}\n`)
  })
}

const commands = {
  delegated({ areq, ok, result, error }) {
    delegating.get(areq)?.({ ok: ok === true, ...(ok ? { result } : { error: String(error ?? '실패했어요') }) })
  },
  /** The server's answer to sudoAsk. */
  sudoans({ areq, ok, error }) {
    sudoWaits.get(areq)?.(ok === true && sudoPass ? { ok: true } : { ok: false, error: String(error ?? '관리자 권한을 쓸 수 없어요') })
  },
  /** The admin password typed on the web: checked with sudo, then kept SUDO_WINDOW_MS. */
  async sudopass({ reqId, password }) {
    const pw = String(password ?? '')
    if (!pw || pw.length > 1024 || /[\r\n]/.test(pw)) return emit({ t: 'sudopass', reqId, ok: false, error: '비밀번호가 올바르지 않아요' })
    const r = await sudoSpawn(pw, ['-v'])
    if (r.code !== 0) {
      log('warn', 'sudo', '관리자 비밀번호가 맞지 않음')
      return emit({ t: 'sudopass', reqId, ok: false, error: /not in the sudoers|may not run sudo/.test(r.out) ? '이 맥의 사용자는 관리자(sudo)가 아니에요' : '비밀번호가 맞지 않아요' })
    }
    clearTimeout(sudoPass?.timer)
    const until = Date.now() + SUDO_WINDOW_MS
    sudoPass = { pw, until, timer: setTimeout(sudoForget, SUDO_WINDOW_MS) }
    sudoPass.timer.unref?.()
    log('info', 'sudo', `관리자 권한을 ${SUDO_WINDOW_MS / 60_000}분 열었음`)
    emit({ t: 'sudopass', reqId, ok: true, until })
    sudoState()
  },
  /** 닫기 on the web: the password is forgotten now. */
  sudooff({ reqId }) {
    if (sudoPass) log('info', 'sudo', '관리자 권한을 닫았음')
    sudoForget()
    emit({ t: 'sudooff', reqId, ok: true })
  },
  /** `:sudo <command>` typed in a session (REQ-F-764): run as root in the session's folder, what it printed sent back. */
  async sudo({ reqId, sid, command }) {
    const s = sessions.get(sid)
    const c = String(command ?? '').trim()
    if (!s || !c) return emit({ t: 'sudo', reqId, ok: false, error: !s ? '이 세션을 에이전트가 모릅니다' : '명령이 비어 있어요' })
    const a = await sudoAsk(sid, c)
    if (!a.ok || !sudoPass) return emit({ t: 'sudo', reqId, ok: false, error: a.error ?? '관리자 권한이 닫혔어요' })
    const started = Date.now()
    log('info', 'sudo', `관리자 권한으로 명령 실행 (${c.length}자)`, sid)
    const r = await sudoSpawn(sudoPass.pw, ['--', '/bin/sh', '-c', c], { cwd: s.cwd, ms: SUDO_RUN_MS })
    emit({ t: 'sudo', reqId, ok: true, code: r.code, out: tailOf(r.out), ms: Date.now() - started })
  },
  /** Events the server numbered, to keep (REQ-S-069). Told back by lid once on disk. */
  log({ sid, lid, events }) {
    try {
      store.append(sid, events)
      if (typeof lid === 'string') keptLids.push(lid)
      if (sessions.has(sid) || store.has(sid)) sendStats(sid, false, Array.isArray(events) && events.some((e) => e?.k === 'status' && e.phase !== 'busy') ? STATS_TURN_MS : STATS_MS)
    } catch (e) {
      log('error', 'store', `세션 기록을 저장하지 못함: ${e.message}`, sid)
    }
  },
  /** A picture the server had from before (the move of its copies to this Mac). */
  putimg({ lid, id, data }) {
    try {
      if (imageIdOk(id) && typeof data === 'string') saveImage(IMAGES_DIR, id, Buffer.from(data, 'base64'))
      if (typeof lid === 'string') keptLids.push(lid)
    } catch (e) {
      log('error', 'store', `그림을 저장하지 못함: ${e.message}`)
    }
  },
  /** The server let the session go (removed from the list): its log goes too. */
  forget({ sid }) {
    store.remove(sid)
    statsSent.delete(sid)
  },
  /** A page of a session's log, for a page that asked the server. */
  events({ reqId, sid, after, before, limit, kinds }) {
    try {
      const page = store.page(sid, { after: after == null ? undefined : Number(after), before: before == null ? undefined : Number(before), limit, kinds: Array.isArray(kinds) ? kinds.map(String).slice(0, 10) : undefined })
      emit({ t: 'events', reqId, ok: true, ...page, last: store.lastSeq(sid) })
    } catch (e) {
      emit({ t: 'events', reqId, ok: false, error: e.message })
    }
  },
  /**
   * The session's transcript, a part at a time from byte `from`, for its move to another Mac: the server passes it
   * on to the receiving Mac's open without keeping it (REQ-S-069).
   */
  export({ reqId, sid, conv, from }) {
    const s = sessions.get(sid)
    try {
      // A session that ended was let go here: its conversation is found by its id, in any account's folder.
      const file = s ? transcriptPath(s, sid) : findTranscript(conv, null)
      if (!file) throw new Error('이 맥에 그 대화 파일이 없어요')
      const fd = fs.openSync(file, 'r')
      try {
        const size = fs.fstatSync(fd).size
        const at = Math.max(0, Math.min(size, Number(from) || 0))
        const buf = Buffer.alloc(Math.min(EXPORT_PART, size - at))
        fs.readSync(fd, buf, 0, buf.length, at)
        emit({ t: 'export', reqId, ok: true, data: buf.toString('base64'), size, done: at + buf.length >= size })
      } finally {
        fs.closeSync(fd)
      }
    } catch (e) {
      emit({ t: 'export', reqId, ok: false, error: e.code === 'ENOENT' ? '이 맥에 대화 파일이 없어요' : e.message })
    }
  },
  /** A picture by its id, for a page that asked the server. */
  img({ reqId, id }) {
    if (!imageIdOk(id)) return emit({ t: 'img', reqId, ok: false, error: '그림 id 가 올바르지 않아요' })
    try {
      const bytes = fs.readFileSync(path.join(IMAGES_DIR, id))
      emit({ t: 'img', reqId, ok: true, type: IMAGE_TYPES[id.split('.').pop()], data: bytes.toString('base64') })
    } catch {
      emit({ t: 'img', reqId, ok: false, error: '이 맥에 그 그림이 없어요' })
    }
  },
  welcome({ sessions: known }) {
    for (const [sid, s] of sessions) {
      const k = known[sid]
      if (k && !k.mine) commands.release({ sid })
      else rewind(s, k?.lines ?? 0)
      s.statusKey = null
    }
    welcomed = true
    // What the server shows for this Mac's 관리자 권한: a new agent has none open and asks nothing.
    sudoState()
    health()
    refreshAccounts().catch((e) => log('warn', 'account', `계정 상태를 읽지 못함: ${e.message}`))
    testflightSent = ''
    reportTestflight()
    sendAllStats()
    for (const [sid, s] of sessions) {
      if (!s.revived) continue
      note(sid, '🔁 맥이 다시 켜져서 세션을 같은 대화로 다시 열었어요.')
      s.revived = false
    }
  },
  async check() {
    await runChecks()
    await health()
  },
  ping({ ts }) {
    emit({ t: 'pong', ts })
  },
  rehello: hello,
  async new({ reqId, sid, cwd, prompt, autoPush, model, effort, mode, create, sysPrompt, chrome, account }) {
    try {
      if (!safeAccountId(account ?? '') || accountDir(account ?? '') === null) throw new Error('이 맥에 그 Claude 계정이 없어요')
      const want = expandHome(cwd || '~')
      if (!path.isAbsolute(want)) throw new Error(`작업 폴더는 / 또는 ~ 로 시작하는 경로여야 합니다: ${cwd}`)
      if (!fs.existsSync(want) && create === true) fs.mkdirSync(want, { recursive: true })
      if (!fs.existsSync(want)) throw Object.assign(new Error(`이 맥에 그 폴더가 없습니다: ${want}`), { missing: true })
      if (!fs.statSync(want).isDirectory()) throw new Error(`폴더가 아닙니다: ${want}`)
      try {
        fs.readdirSync(want)
      } catch (e) {
        throw new Error(`폴더를 읽을 권한이 없습니다: ${want} (${e.code}). 데스크탑·문서·다운로드 폴더라면 시스템 설정 → 개인정보 보호 및 보안 → 파일 및 폴더에서 에이전트를 켠 터미널 앱에 권한을 주세요`)
      }
      const dir = fs.realpathSync(want)
      const s = { cwd: dir, autoPush: autoPush !== false, conv: sid, sysPrompt: String(sysPrompt ?? '').slice(0, 8000), ...(/^[\w.[\]-]{1,60}$/.test(model || '') ? { model } : {}), ...(EFFORTS.includes(effort) ? { effort } : {}) }
      if (['default', 'acceptEdits', 'plan', 'auto'].includes(mode)) s.mode = mode
      if (chrome === false) s.chrome = false
      if (account) s.account = account
      // In the map before claude starts: its first hooks (SessionStart, the first prompt) arrive while it launches.
      resetRuntime(s)
      sessions.set(sid, s)
      // tmux refuses a command line much over 16 KB: a longer first prompt waits as a held message and is
      // pasted when claude is up, like any other.
      const onLine = !!prompt && Buffer.byteLength(prompt) <= FIRST_PROMPT_MAX
      // Held before claude starts, so the release that follows its start (SessionStart) delivers it.
      if (prompt && !onLine) Object.assign(s, { keepHeld: true, held: [{ id: crypto.randomUUID(), at: Date.now(), text: prompt }] })
      try {
        await launch(sid, s, ['--session-id', sid, ...settingsArgs(s), ...(onLine ? [prompt] : [])])
      } catch (e) {
        sessions.delete(sid)
        throw e
      } finally {
        delete s.keepHeld
      }
      // The first prompt is on the command line: the turn it starts is this session's first.
      if (onLine && !s.hooks) beginTurn(sid, s)
      saveSessions()
      emit({ t: 'opened', reqId, sid, ok: true, cwd: dir, warnings: [], account: s.account ?? '' })
    } catch (e) {
      log('error', 'new', `세션을 시작하지 못함: ${e.message}`, sid)
      emit({ t: 'opened', reqId, sid, ok: false, error: e.message, missing: !!e.missing })
    }
  },
  /** Take over a session from the server's copy: load the folder state, write the transcript, resume. */
  async open({ reqId, sid, conv, cwd, home, folder, transcript, local, autoPush, autoAllow, model, effort, mode, sysPrompt, chrome, mdFile, account }) {
    try {
      // Ids go into file names (the transcript): no path in them (R1-L7).
      if (!safeConvId(sid) || (conv && !safeConvId(conv))) throw new Error('세션 id 가 올바르지 않아요')
      const warnings = []
      let dir = expandHome(home && (cwd === home || cwd.startsWith(`${home}/`)) ? path.join(HOME, cwd.slice(home.length)) : cwd)
      const root = folder?.repos?.find((r) => r.dir === '.')
      if (root) warnings.push(...(await loadRepo(dir, root)))
      fs.mkdirSync(dir, { recursive: true })
      dir = fs.realpathSync(dir)
      // One plain name inside the folder, never `..` (R1-L7).
      for (const repo of folder?.repos ?? []) if (repo.dir !== '.' && safeDirName(repo.dir)) warnings.push(...(await loadRepo(path.join(dir, repo.dir), repo)))
      for (const [name, content] of Object.entries(folder?.files ?? {})) {
        if (!INSTRUCTION_FILES.includes(name) && !(isMdName(name) && name === mdFile)) continue
        const p = path.join(dir, name)
        // A link in its place is left alone: writing would overwrite whatever it points at (R1-L9).
        if (isLink(p)) {
          warnings.push(`${name}: 링크라서 덮어쓰지 않았습니다`)
          continue
        }
        if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') !== content) backup(p, sid)
        writePlain(p, content)
      }
      const old = sessions.get(sid)
      // Checked before the running session is stopped: a refused account leaves it where it was.
      if (!safeAccountId(account ?? '') || accountDir(account ?? '') === null) throw new Error('이 맥에 그 Claude 계정이 없어요')
      if (account && accountAuth.get(account)?.loggedIn === false) throw new Error('그 Claude 계정은 로그인돼 있지 않아요. 설정 → Claude 계정에서 먼저 로그인해 주세요')
      if (old) await tmux('kill-session', '-t', `=${old.tmux}`)
      const s = { cwd: dir, autoPush: autoPush !== false, autoAllow: !!autoAllow, conv: conv || sid, sysPrompt: String(sysPrompt ?? '').slice(0, 8000), ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(mode ? { mode } : {}), ...(chrome === false ? { chrome: false } : {}), ...(isMdName(mdFile) ? { mdFile } : {}), ...(account ? { account } : {}) }
      // Moving to another account on this Mac: what Claude Code keeps beside the transcript goes along.
      if (old && (old.account ?? '') !== (account ?? '') && accountDir(old.account ?? '')) {
        const copied = copySessionState(s.conv, accountDir(old.account ?? ''), accountDir(account ?? ''))
        // The folder's auto memory too, file by file: what the other account already has there is kept.
        const memory = path.join(projectDir(old.cwd, old.account ?? ''), 'memory')
        if (fs.existsSync(memory)) (fs.cpSync(memory, path.join(projectDir(dir, account ?? ''), 'memory'), { recursive: true, force: false }), copied.push('memory'))
        log('info', 'open', `계정 ${old.account || '기본'} → ${account || '기본'}${copied.length ? ` (함께 옮김: ${copied.join(', ')})` : ''}`, sid)
      }
      const file = transcriptPath(s, sid)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      // `local`: this Mac's own copy is the one (a reopen, another account here). A bridge tab from before 1.277
      // still hands over whatever the server gave, an empty text then: it is not taken for the conversation.
      if (typeof transcript === 'string' && !local) {
        // A copy handed over from another Mac is the latest: what this machine had is overwritten, after keeping a copy.
        if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== transcript) backup(file, sid)
        fs.writeFileSync(file, transcript)
        // Its pictures are kept here too: the page asks this Mac for them from now on (REQ-S-069).
        for (const line of transcript.split('\n')) if (line.includes('"base64"')) saveLineImages(line, IMAGES_DIR)
      } else if (!fs.existsSync(file)) {
        // None handed over (REQ-S-069): this Mac's own file, from another account's folder when the session moves
        // between accounts here.
        const found = findTranscript(s.conv, old ? transcriptPath(old, sid) : null)
        if (found) fs.copyFileSync(found, file)
      }
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
      // Where the copy ends is where reading resumes, set before claude can append to the file.
      Object.assign(s, { offset: Buffer.byteLength(text), lineNo: text.split('\n').length - 1, skip: 0, lineBase: 0 })
      // In the map before claude starts, so its first hooks are not dropped.
      resetRuntime(s)
      sessions.set(sid, s)
      try {
        await launch(sid, s, ['--resume', s.conv, ...settingsArgs(s)])
      } catch (e) {
        old ? sessions.set(sid, old) : sessions.delete(sid)
        throw e
      }
      saveSessions()
      for (const w of warnings) log('warn', 'open', w, sid)
      log('info', 'open', `폴더(${dir.length}자)에서 이어서 엶 (${s.lineNo}줄)`, sid)
      emit({ t: 'opened', reqId, sid, ok: true, cwd: dir, warnings, account: s.account ?? '' })
    } catch (e) {
      log('error', 'open', `세션을 열지 못함: ${e.message}`, sid)
      emit({ t: 'opened', reqId, sid, ok: false, error: e.message })
    }
  },
  async send({ sid, text, id, files, videos }) {
    const s = sessions.get(sid)
    if (!s) return
    // Pictures become files on this Mac, and the message says where they are: Claude reads them from there.
    // The name is the picture's id on the server, which is how its copy there is found again (REQ-F-014).
    const lines = []
    // Videos the bridge tab already put here (/file, REQ-F-761). Claude cannot watch one: it is told how to look.
    for (const v of Array.isArray(videos) ? videos.slice(0, 3) : []) {
      const ok = typeof v?.path === 'string' && insideAny(v.path, [path.join(STATE_DIR, 'images')])
      lines.push(ok ? `[Video attached: ${v.path}] (영상은 바로 볼 수 없어요. 필요하면 ffmpeg 로 장면을 뽑아 보세요)` : `[영상을 받지 못했어요: ${String(v?.name ?? '').slice(0, 120)}. 연동 탭을 새로 고친 뒤 다시 보내 주세요]`)
    }
    for (const f of Array.isArray(files) ? files.slice(0, 8) : []) {
      if (!/^[0-9a-f]{40}\.(png|jpg|gif|webp)$/.test(f.id || '')) continue
      const dir = path.join(STATE_DIR, 'images')
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(dir, f.id), Buffer.from(String(f.data), 'base64'))
      lines.push(`[Image attached: ${path.join(dir, f.id)}]`)
    }
    const body = [String(text ?? '').trim(), ...lines].filter(Boolean).join('\n')
    await inject(sid, s, body, id)
  },
  /** Stop what is running and hand the held messages over now. */
  async sendnow({ sid }) {
    const s = sessions.get(sid)
    if (!s) return
    if (!s.held.length) return toast(sid, '붙잡아 둔 메시지가 없습니다. 이미 전달된 메시지의 안내라서 지웠습니다.')
    if (s.turn) {
      await term.sendKeys(pane(s), ['Escape'])
      s.escAt = Date.now()
      await sleep(500)
      s.turn = null
      s.running = new Map()
    }
    releaseHeld(sid, s, 'send now')
  },
  /** Take a held message back (to edit it), or all of them. */
  dropheld({ reqId, sid, id }) {
    const s = sessions.get(sid)
    if (!s) return reqId && emit({ t: 'dropped', reqId, sid, ids: [] })
    const gone = s.held.filter((h) => !id || h.id === id).map((h) => h.id)
    s.held = s.held.filter((h) => !gone.includes(h.id))
    saveSessions()
    log('info', 'send', `held messages dropped (${gone.length})`, sid)
    emit({ t: 'dropped', reqId, sid, ids: gone })
    publish(sid, s)
  },
  /** The last message was sent by mistake: stop what it started, and tell the session not to follow it. */
  async retract({ sid, quoted }) {
    const s = sessions.get(sid)
    if (!s) return
    await interrupt(sid, s)
    note(sid, `↩️ 웹: '${quoted}' 를 잘못 보냈다고 알렸습니다.`)
    await deliver(sid, s, `[정정] 방금 보낸 "${quoted}" 는 잘못 보낸 메시지예요. 그 지시는 따르지 마세요. 이미 파일을 바꾸거나 명령을 실행했다면 무엇을 했는지만 짧게 알려 주세요.`)
    publish(sid, s)
  },
  async esc({ sid }) {
    const s = sessions.get(sid)
    if (s) await interrupt(sid, s)
    if (s) publish(sid, s)
  },
  async answer({ sid, card, n }) {
    const s = sessions.get(sid)
    if (s) await answerCard(sid, s, card, n)
    if (s) publish(sid, s)
  },
  async key({ sid, keys }) {
    const s = sessions.get(sid)
    if (!s) return
    for (const k of keys.filter((k) => KEYS.has(k)).slice(0, 20)) await tmux('send-keys', '-t', `=${s.tmux}:`, k)
  },
  /** The terminal as it looks: with its colours (SGR codes), for the page to draw. */
  async screen({ sid, reqId }) {
    const s = sessions.get(sid)
    const out = s ? await tmuxRaw('capture-pane', '-p', '-e', '-t', pane(s)) : ''
    emit({ t: 'screen', sid, reqId, text: out.replace(/\n+$/, '') })
  },
  /** Send everything not yet synced, then answer: the server moves the session only after this. */
  async flush({ reqId, sid }) {
    const s = sessions.get(sid)
    if (s) {
      await sleep(TAIL_MS)
      tail(sid, s)
    }
    // The notes (SESSION/AGENTS/CLAUDE.md) are not kept on the server: a move takes them from this answer.
    const folder = s ? await syncFolder(sid, s) : null
    emit({ t: 'flushed', reqId, sid, ok: !!s, ...(folder ? { folder } : {}) })
  },
  async set({ sid, autoPush, autoAllow }) {
    const s = sessions.get(sid)
    if (!s) return
    if (typeof autoPush === 'boolean') Object.assign(s, { autoPush, folderAt: 0 })
    if (autoAllow === true && (await alive(s))) {
      // Allowing everything here only means something while the terminal itself asks: in another mode Claude
      // Code decides on its own, and what it refuses there never reaches the agent.
      const read = await cycleToMode(s, 'default')
      if (read && read !== 'default') {
        note(sid, `⚠️ 터미널을 manual 모드로 바꾸지 못해 전부 허용을 켜지 않았습니다 (지금 ${read} 모드). 화면을 확인하세요.`, 'warn')
        return publish(sid, s)
      }
    }
    if (typeof autoAllow === 'boolean') {
      s.autoAllow = autoAllow
      log('info', 'session', `auto-allow ${autoAllow ? 'on' : 'off'}`, sid)
      note(sid, autoAllow ? '⚡ *전부 허용* 켬 · 권한 요청을 에이전트가 바로 허용하고, 허용한 내용은 여기에 남깁니다.' : '🔐 *전부 허용* 끔 · 권한 요청을 다시 버튼으로 묻습니다.')
      // Whatever is already asking is answered by the next look at the screen.
      if (autoAllow && s.card?.open && s.card.kind === 'permission') (foldCard(sid, s, '전부 허용으로 넘김'), (s.answered = null))
    }
    saveSessions()
    publish(sid, s)
  },
  async close({ sid }) {
    const s = sessions.get(sid)
    if (!s) return
    await tmux('kill-session', '-t', `=${s.tmux}`)
    trashMdFile(sid, s)
    resetRuntime(s)
    sessions.delete(sid)
    saveSessions()
    fs.rmSync(path.join(STATE_DIR, 'prompts', `${sid}.txt`), { force: true })
    emit({ t: 'closed', sid })
  },
  /** The session now runs on another host: stop it here and forget it. The transcript file stays. */
  async release({ sid }) {
    const s = sessions.get(sid)
    if (!s) return
    await tmux('kill-session', '-t', `=${s.tmux}`)
    resetRuntime(s)
    sessions.delete(sid)
    saveSessions()
    fs.rmSync(path.join(STATE_DIR, 'prompts', `${sid}.txt`), { force: true })
    log('info', 'release', '다른 호스트로 옮겨져 이 기기에서 내려놓음', sid)
  },
  async setting({ sid, kind, value }) {
    const s = sessions.get(sid)
    if (s) await setSetting(sid, s, kind, String(value ?? ''))
    if (s) publish(sid, s)
  },
  /** now: reopen at once. later: when the running work is done. cancel: forget the reservation. */
  /** How many background tasks the server counts for this session: a pending refresh waits for none. */
  bg({ sid, n }) {
    const s = sessions.get(sid)
    if (!s) return
    s.bgCount = Number(n) || 0
    maybeRefresh(sid, s)
  },
  async refresh({ sid, when, sysPrompt, interrupted, bg }) {
    const s = sessions.get(sid)
    if (!s) return
    // What runs in the background is cut off by reopening: the session that comes back is told what it lost.
    if (when !== 'cancel' && Array.isArray(interrupted) && interrupted.length) s.interrupted = interrupted.slice(0, 20).map((x) => String(x).slice(0, 200))
    // A reopened session takes the default prompt as it is now.
    if (typeof sysPrompt === 'string') s.sysPrompt = sysPrompt.slice(0, 8000)
    if (typeof bg === 'number') s.bgCount = bg
    if (when === 'cancel') {
      if (s.refreshAfter) toast(sid, '새로고침 예약을 취소했어요')
      s.refreshAfter = false
      s.bgSaid = false
    } else if (when === 'later') {
      s.refreshAfter = true
      if (s.turn) note(sid, '⏳ 작업이 끝나면 새로고침합니다. 그동안 보낸 메시지는 붙잡아 두었다가 다시 연 세션에 넘깁니다.')
      maybeRefresh(sid, s)
    } else await refresh(sid, s)
    saveSessions()
    publish(sid, s)
    if (when === 'cancel') releaseHeld(sid, s, 'refresh cancelled')
  },
  /** A second session that starts from a copy of this conversation, in the same folder. The original goes on. */
  async fork({ reqId, sid, newSid, sysPrompt, launch: defaults, copyLog }) {
    const from = sessions.get(sid)
    try {
      if (!from) throw new Error('이 맥에 그 세션이 없습니다')
      // A session that is being reopened is copied once it is back: its transcript is in use until then.
      for (let i = 0; i < 60 && from.refreshing; i++) await sleep(500)
      tail(sid, from)
      const s = { cwd: from.cwd, autoPush: from.autoPush, conv: newSid, sysPrompt: String(sysPrompt ?? from.sysPrompt ?? '').slice(0, 8000), ...(from.model ? { model: from.model } : {}), ...(from.effort ? { effort: from.effort } : {}), ...(from.mode ? { mode: from.mode } : {}), ...(from.chrome === false ? { chrome: false } : {}), ...(from.account ? { account: from.account } : {}), ...launchOver(defaults) }
      // Copied while the original works: that work stays the original's, and the copy is told so (sessionPrompt).
      if (from.turn || from.running?.size) s.forkOf = sid.slice(0, 8)
      resetRuntime(s)
      sessions.set(newSid, s)
      try {
        await launch(newSid, s, ['--resume', from.conv || sid, '--fork-session', '--session-id', newSid, ...settingsArgs(s)])
      } catch (e) {
        sessions.delete(newSid)
        throw e
      }
      saveSessions()
      // The log so far comes along, its cards not (their buttons belong to the original); and the ids of the copied
      // lines, which the server does not draw a second time (REQ-S-069).
      if (Number.isInteger(copyLog)) store.copy(sid, newSid, copyLog)
      let uuids = []
      try {
        uuids = [...fs.readFileSync(transcriptPath(from, sid), 'utf8').matchAll(/"uuid":"([0-9a-f-]{36})"/g)].map((m) => m[1])
      } catch {}
      emit({ t: 'opened', reqId, sid: newSid, ok: true, cwd: s.cwd, warnings: [], account: s.account ?? '', uuids })
    } catch (e) {
      log('error', 'fork', `세션을 복제하지 못함: ${e.message}`, sid)
      emit({ t: 'opened', reqId, sid: newSid, ok: false, error: e.message })
    }
  },
  /**
   * A light copy: the session writes what matters into SESSION.md, and a new session starts from that file
   * instead of from the whole conversation. The original goes on in its terminal.
   */
  async lightfork({ reqId, sid, newSid, sysPrompt, mode, launch: defaults }) {
    const from = sessions.get(sid)
    const fail = (error, more = {}) => emit({ t: 'opened', reqId, sid: newSid, ok: false, error, ...more })
    if (!from) return fail('이 맥에 그 세션이 없습니다')
    if (from.lightforking) return fail('이미 가벼운 복제를 하고 있습니다')
    from.lightforking = true
    try {
      // The session's own hand-over file: SESSION.md, or SESSION-<id8>.md when that one is another session's.
      const name = mdFileOf(sid, from, { claim: true })
      const file = path.join(from.cwd, name)
      const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
      let content = ''
      if (mode === 'cut') content = before
      else {
        note(sid, mode === 'shrink' ? `📝 ${name} 를 줄여 달라고 요청했어요…` : `📝 지금까지 대화를 ${name} 에 정리해 달라고 요청했어요…`)
        await inject(sid, from, mode === 'shrink' ? `${name} 를 ${kb(mdMaxOf(from))} 안으로 줄여 다시 써 주세요. 다음 세션이 바로 이어받을 핵심만 남기세요.` : `지금까지의 대화를 이어받을 다음 세션이 읽을 ${name} 파일을 이 폴더에 써 주세요(있으면 덮어쓰기). 다른 이름의 SESSION*.md 는 다른 세션의 것이니 건드리지 마세요. 무엇을 하고 있었는지, 왜, 지금 어디까지 됐는지, 내린 결정과 이유, 관련 파일, 다음에 할 일을 정리해 주세요. ${kb(mdMaxOf(from))} 를 넘기지 마세요.`)
        // Written when the same non-empty content is read twice in a row, a second apart.
        let last = ''
        for (const start = Date.now(); Date.now() - start < 180_000; ) {
          await sleep(1000)
          const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
          if (now.trim() && now !== before && now === last && !from.turn) {
            content = now
            break
          }
          last = now
        }
      }
      if (!content.trim()) throw new Error(mode === 'cut' ? `${name} 가 없어요` : `${name} 를 3분 넘게 쓰지 못했어요. 직접 작성을 요청하거나 다시 시도하세요.`)
      // Too long to hand over whole: the person chooses between a shorter one and its first part. Not cut silently.
      const bytes = Buffer.byteLength(content)
      const max = mdMaxOf(from)
      if (bytes > max && mode !== 'cut') return fail(`${name} 가 너무 커요`, { tooBig: bytes, max, name })
      if (bytes > max) content = Buffer.from(content).subarray(0, max).toString('utf8').replace(/\uFFFD+$/, '')
      // The new session carries the work on, so the file goes with it; the original, if used again, gets its own.
      const s = { cwd: from.cwd, autoPush: from.autoPush, conv: newSid, mdFile: name, sysPrompt: String(sysPrompt ?? from.sysPrompt ?? '').slice(0, 8000), ...(from.model ? { model: from.model } : {}), ...(from.effort ? { effort: from.effort } : {}), ...(from.mode ? { mode: from.mode } : {}), ...(from.chrome === false ? { chrome: false } : {}), ...(from.account ? { account: from.account } : {}), ...launchOver(defaults) }
      resetRuntime(s)
      sessions.set(newSid, s)
      try {
        // The hand-over is pasted once the session is up, not passed on the command line: tmux refuses a command
        // that long ("command too long"), which made every light copy of a big SESSION.md fail.
        await launch(newSid, s, ['--session-id', newSid, ...settingsArgs(s)])
        hold(newSid, s, `[이전 대화에서 이어감 — 원래 세션: ${sid.slice(0, 8)}, 같은 내용이 이 폴더의 ${name} 에 있습니다. 이 세션의 인수인계 파일은 앞으로도 ${name} 입니다]\n\n${content}`)
        // Up already (its start was seen while launching) or not yet: either way it goes in once the prompt is there.
        releaseHeld(newSid, s, 'handover')
      } catch (e) {
        sessions.delete(newSid)
        throw e
      }
      from.handedOffTo = newSid
      delete from.mdFile
      saveSessions()
      note(sid, '🧵 가벼운 새 세션으로 넘겼어요. 이 세션은 터미널에서 그대로 쓸 수 있어요.')
      publish(sid, from)
      emit({ t: 'opened', reqId, sid: newSid, ok: true, cwd: s.cwd, warnings: [], account: s.account ?? '' })
    } catch (e) {
      log('error', 'lightfork', e.message, sid)
      note(sid, `❌ 가벼운 복제로 새 세션을 열지 못했어요. ${e.message}`, 'warn')
      fail(e.message)
    } finally {
      from.lightforking = false
    }
  },
  /**
   * 대화 기록 정리 (REQ-F-793): a compaction shrinks the context but only adds to the transcript, so a long session
   * grows past the 100 MB where the page stops taking text. What came before the last compaction is never read again
   * (trimTranscript): it is moved out to TRIMMED_DIR whole, and the session is opened again on what is left. The
   * page's log keeps every line: the trimmed file is read on from its end, nothing is sent again.
   */
  async trimlog({ reqId, sid }) {
    const s = sessions.get(sid)
    const mb = (n) => `${(n / 1048576).toFixed(1)}MB`
    try {
      if (!s) throw new Error('이 맥에 그 세션이 없습니다')
      if (s.turn || s.wait || s.refreshing || s.lightforking || s.launching || s.alive === false) throw new Error('쉬고 있는 세션만 기록을 정리할 수 있어요')
      const file = transcriptPath(s, sid)
      if (!trimTranscript(fs.readFileSync(file, 'utf8'))) throw new Error('압축한 적이 없어 덜어 낼 기록이 없어요. 먼저 "지금 압축" 을 하세요')
      s.refreshing = true
      try {
        // Stopped first: a running Claude Code would go on writing into the file that is moved away.
        tail(sid, s)
        await tmux('kill-session', '-t', `=${s.tmux}`)
        tail(sid, s)
        const text = fs.readFileSync(file, 'utf8')
        const kept = trimTranscript(text)
        const backup = path.join(TRIMMED_DIR, `${path.basename(file, '.jsonl')}-${Date.now()}.jsonl`)
        fs.mkdirSync(TRIMMED_DIR, { recursive: true })
        fs.writeFileSync(`${file}.trim`, kept)
        fs.renameSync(file, backup)
        fs.renameSync(`${file}.trim`, file)
        // Read on from the new end: the lines kept were all sent already. Numbering goes on where it was (the server
        // counts every line it was sent), so the file's first line is now line lineBase, kept for a later rewind.
        s.lineBase = s.lineNo - (kept.match(/\n/g)?.length ?? 0)
        saveSessions()
        s.offset = fs.statSync(file).size
        s.size = s.offset
        const before = Buffer.byteLength(text)
        log('info', 'trimlog', `${mb(before)} → ${mb(s.size)}, 원본 ${backup}`, sid)
        note(sid, `🧹 대화 기록을 정리했어요: ${mb(before)} → ${mb(s.size)}. 마지막 압축 앞부분은 맥의 ${TRIMMED_DIR.startsWith(`${HOME}/`) ? `~${TRIMMED_DIR.slice(HOME.length)}` : TRIMMED_DIR}/ 에 그대로 두었어요. 이 화면의 대화는 그대로예요.`)
        await launch(sid, s, ['--resume', s.conv || sid, ...settingsArgs(s)])
        setTimeout(() => releaseHeld(sid, s, 'trimmed'), 2500)
        emit({ t: 'trimlog', reqId, ok: true, before, after: s.size })
      } finally {
        s.refreshing = false
        publish(sid, s)
      }
    } catch (e) {
      log('error', 'trimlog', e.message, sid)
      emit({ t: 'trimlog', reqId, ok: false, error: e.message })
    }
  },
  /** What ending the session and throwing its folder away would lose, per repository. Nothing is touched. */
  async trashinfo({ reqId, sid }) {
    const s = sessions.get(sid)
    try {
      if (!s) throw new Error('이 맥에 그 세션이 없습니다')
      trashable(s.cwd, sid)
      const repos = []
      const walk = (dir, depth) => {
        if (fs.existsSync(path.join(dir, '.git'))) repos.push(dir)
        if (depth >= 2) return
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(dir, e.name), depth + 1)
      }
      walk(s.cwd, 0)
      const out = []
      for (const dir of repos.slice(0, 30)) {
        const lines = (r) => r.out.split('\n').filter((l) => l.trim()).length
        out.push({ dir: dir === HOME || dir.startsWith(`${HOME}/`) ? `~${dir.slice(HOME.length)}` : dir, uncommitted: lines(await git(dir, 'status', '--porcelain')), unpushed: lines(await git(dir, 'log', '--branches', '--not', '--remotes', '--oneline')) })
      }
      emit({ t: 'trashinfo', reqId, ok: true, cwd: s.cwd === HOME || s.cwd.startsWith(`${HOME}/`) ? `~${s.cwd.slice(HOME.length)}` : s.cwd, repos: out })
    } catch (e) {
      emit({ t: 'trashinfo', reqId, ok: false, error: e.message })
    }
  },
  /** End the session and move its folder to the Trash. Moved, never deleted: it can be put back. */
  async trash({ reqId, sid }) {
    const s = sessions.get(sid)
    try {
      if (!s) throw new Error('이 맥에 그 세션이 없습니다')
      trashable(s.cwd, sid)
      await tmux('kill-session', '-t', `=${s.tmux}`)
      await sleep(500)
      const bin = path.join(HOME, '.Trash')
      let to = path.join(bin, path.basename(s.cwd))
      if (fs.existsSync(to)) to = `${to} ${new Date().toISOString().replace(/[:.]/g, '-')}`
      fs.renameSync(s.cwd, to)
      resetRuntime(s)
      sessions.delete(sid)
      saveSessions()
      log('info', 'trash', `폴더(${s.cwd.length}자)를 휴지통으로 옮기고 종료`, sid)
      emit({ t: 'trashed', reqId, ok: true, to })
    } catch (e) {
      log('error', 'trash', e.message, sid)
      emit({ t: 'trashed', reqId, ok: false, error: e.message })
    }
  },
  /** AGENTS.md (or CLAUDE.md) of the working folder: what the session was told to follow. */
  /** The person's own pull requests (created, and merged), for the usage statistics. Read only; 100 at a time, ten pages at most. */
  async prsearch({ reqId }) {
    const search = async (q) => {
      const out = []
      let after = null
      for (let page = 0; page < 10; page++) {
        const query = 'query($q:String!,$after:String){search(query:$q,type:ISSUE,first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{... on PullRequest{url createdAt mergedAt additions deletions}}}}'
        const r = await run('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `q=${q}`, ...(after ? ['-f', `after=${after}`] : [])], { timeout: 30_000 })
        if (!r.ok) throw new Error(r.err || 'gh 가 답하지 않았어요')
        const got = JSON.parse(r.out).data.search
        out.push(...got.nodes.filter((n) => n && n.url))
        if (!got.pageInfo.hasNextPage) break
        after = got.pageInfo.endCursor
      }
      return out
    }
    try {
      const [merged, created] = await Promise.all([search('is:pr author:@me is:merged'), search('is:pr author:@me')])
      const byUrl = new Map()
      for (const p of created) byUrl.set(p.url, { url: p.url, createdAt: p.createdAt, additions: p.additions, deletions: p.deletions })
      for (const p of merged) byUrl.set(p.url, { url: p.url, createdAt: p.createdAt, mergedAt: p.mergedAt ?? undefined, additions: p.additions, deletions: p.deletions })
      emit({ t: 'prsearch', reqId, ok: true, prs: [...byUrl.values()].slice(0, 2000) })
    } catch (e) {
      emit({ t: 'prsearch', reqId, ok: false, error: e.message })
    }
  },
  /** Where a few pull requests stand (open, draft, merged, closed, or not found), for the PR chips. Read only. */
  async prstates({ reqId, urls }) {
    const list = (Array.isArray(urls) ? urls : []).filter((u) => /^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(String(u))).slice(0, 8)
    const prs = await Promise.all(
      list.map(async (url) => {
        const r = await run('gh', ['pr', 'view', url, '--json', 'number,title,state,isDraft'], { timeout: 12_000 })
        try {
          const j = JSON.parse(r.out)
          return { url, number: j.number, title: String(j.title ?? '').slice(0, 120), state: j.isDraft && j.state === 'OPEN' ? 'DRAFT' : String(j.state) }
        } catch {
          return { url, number: Number(url.split('/').pop()), title: '', state: 'MISSING' }
        }
      }),
    )
    emit({ t: 'prstates', reqId, ok: true, prs })
  },
  readfile({ reqId, sid, which }) {
    const s = sessions.get(sid)
    // The session's own hand-over file (SESSION.md or SESSION-<id8>.md), shown from its gauge.
    if (which === 'session') {
      // The name its gauge shows (looked at every ten seconds), else worked out now.
      const name = s && (s.mdName ?? mdFileOf(sid, s))
      const file = name && path.join(s.cwd, name)
      const content = file ? readPlain(file, 512 * 1024, s.cwd) : null
      if (typeof content === 'string') return emit({ t: 'file', reqId, ok: true, name, path: file, content })
      return emit({ t: 'file', reqId, ok: false, error: `이 세션의 ${name || 'SESSION.md'} 가 아직 없어요` })
    }
    for (const name of ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md']) {
      const file = s && path.join(s.cwd, name)
      const content = file ? readPlain(file, 512 * 1024, s.cwd) : null
      if (typeof content === 'string') return emit({ t: 'file', reqId, ok: true, name, path: file, content })
    }
    emit({ t: 'file', reqId, ok: false, error: '이 폴더에 AGENTS.md 나 CLAUDE.md 가 없어요' })
  },
  /** A picture on this Mac that an answer names by its path (a screenshot it took), for the page to show. */
  readimage({ reqId, path: want }) {
    const file = String(want ?? '').replace(/^~(?=\/)/, HOME)
    const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
    const type = types[/\.([a-z]+)$/i.exec(file)?.[1]?.toLowerCase()]
    if (!path.isAbsolute(file) || !type) return emit({ t: 'image', reqId, ok: false, error: '그림 파일 경로가 아니에요' })
    // Only where a session's pictures are: its folders, the pictures sent to it, temporary files (a screenshot it
    // took). An answer that names some other picture on this Mac does not send it to the server (R1-L8).
    const roots = [path.join(STATE_DIR, 'images'), os.tmpdir(), '/tmp', '/private/tmp', ...[...sessions.values()].filter((x) => x.alive !== false && x.cwd && path.resolve(x.cwd) !== HOME).map((x) => x.cwd)]
    if (!insideAny(file, roots)) return emit({ t: 'image', reqId, ok: false, error: '세션 폴더나 임시 폴더 밖의 그림은 보이지 않아요' })
    try {
      const st = fs.statSync(file)
      if (!st.isFile() || st.size > 8 * 1024 * 1024) return emit({ t: 'image', reqId, ok: false, error: '그림이 너무 커요' })
      const bytes = fs.readFileSync(file)
      // Only what really is a picture: the extension alone could name any file.
      const magic = bytes.subarray(0, 12).toString('latin1')
      const real = magic.startsWith('\x89PNG') ? 'image/png' : magic.startsWith('\xff\xd8\xff') ? 'image/jpeg' : magic.startsWith('GIF8') ? 'image/gif' : magic.startsWith('RIFF') && magic.slice(8) === 'WEBP' ? 'image/webp' : null
      if (!real) return emit({ t: 'image', reqId, ok: false, error: '그림 파일이 아니에요' })
      emit({ t: 'image', reqId, ok: true, type: real, data: bytes.toString('base64') })
    } catch {
      emit({ t: 'image', reqId, ok: false, error: '그 파일이 없어요' })
    }
  },
  /**
   * What this folder can call with a slash:the person's own skills and commands, the project's (this folder and
   * the ones above it, up to home), and enabled plugins'. The same name is kept once.
   */
  /**
   * One request to a web server a session started, for a page on another device (the site's local preview). Only
   * to the ports the scan found: nothing else listening on this Mac is reachable this way.
   */
  /**
   * Stop a web server the session started (the computer button's 끄기): SIGTERM to the process that listens, SIGKILL
   * if it is still there after 3 s. Only a process the scan found for this session, still listening on that port.
   */
  async killserver({ reqId, sid, port }) {
    const server = sessions.get(sid)?.servers?.find((x) => x.port === Number(port))
    if (!server) return emit({ t: 'killserver', reqId, ok: false, error: `이 세션이 띄운 ${port} 포트 서버가 없어요` })
    // The scan may be ten seconds old: the pid must still be the one listening (a pid can be reused).
    const now = await run('lsof', ['-nP', `-iTCP:${server.port}`, '-sTCP:LISTEN', '-t'])
    if (!now.out.split('\n').map(Number).includes(server.pid)) return emit({ t: 'killserver', reqId, ok: false, error: `localhost:${port} 서버가 이미 꺼졌어요` })
    const alivePid = () => {
      try {
        return process.kill(server.pid, 0), true
      } catch {
        return false
      }
    }
    try {
      process.kill(server.pid, 'SIGTERM')
    } catch (e) {
      return emit({ t: 'killserver', reqId, ok: false, error: `끄지 못했어요 (${e.code})` })
    }
    for (let i = 0; i < 30 && alivePid(); i++) await sleep(100)
    const forced = alivePid()
    if (forced) process.kill(server.pid, 'SIGKILL')
    log('info', 'servers', `localhost:${port} 서버를 끔 (pid ${server.pid}${forced ? ', SIGKILL' : ''})`, sid)
    emit({ t: 'killserver', reqId, ok: true, note: `localhost:${port} 서버를 껐어요` })
    // The button goes at once, not at the next scan.
    serversAt = Date.now()
    await sleep(300)
    await scanServers().catch(() => {})
  },
  /**
   * One end of a local preview's WebSocket (a dev server's HMR): open it to localhost, pass messages both ways,
   * close it. Commands carry a number per socket: the bridge tab hands them over in parallel, so they may arrive
   * out of order and are put back in order here.
   */
  ws(cmd) {
    const id = String(cmd.id)
    let c = wsConns.get(id)
    if (!c) wsConns.set(id, (c = { ws: null, next: 0, waiting: new Map() }))
    c.waiting.set(Number(cmd.seq) || 0, cmd)
    while (c.waiting.has(c.next)) {
      const m = c.waiting.get(c.next)
      c.waiting.delete(c.next++)
      wsStep(id, c, m)
    }
  },
  async http({ reqId, port, method, path: want, headers, body }) {
    const server = [...sessions.values()].flatMap((s) => s.servers ?? []).find((x) => x.port === Number(port))
    if (!server) return emit({ t: 'http', reqId, ok: false, error: `이 맥에 세션이 띄운 ${port} 포트 서버가 없어요` })
    const m = /^[A-Z]{3,7}$/.test(String(method)) ? method : 'GET'
    try {
      const r = await fetch(`http://${server.host}:${server.port}${String(want).startsWith('/') ? want : '/'}`, {
        method: m,
        headers: Object.fromEntries(Object.entries(headers ?? {}).filter(([k, v]) => typeof v === 'string' && /^[a-z0-9-]+$/.test(k))),
        body: body && m !== 'GET' && m !== 'HEAD' ? Buffer.from(body, 'base64') : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      })
      const chunks = []
      let size = 0
      for await (const c of r.body ?? []) {
        size += c.length
        if (size > HTTP_MAX) return r.body.cancel().catch(() => {}), emit({ t: 'http', reqId, ok: false, status: 502, error: `응답이 ${HTTP_MAX / 1048576}MB 를 넘어요` })
        chunks.push(c)
      }
      // fetch has already undone the compression and the chunking: those headers no longer describe the body.
      const out = [...r.headers].filter(([k]) => !/^(content-encoding|content-length|transfer-encoding|connection|keep-alive|set-cookie)$/i.test(k))
      emit({ t: 'http', reqId, ok: true, status: r.status, headers: out, cookies: r.headers.getSetCookie(), body: Buffer.concat(chunks).toString('base64') })
    } catch (e) {
      emit({ t: 'http', reqId, ok: false, status: 502, error: `localhost:${port} 가 답하지 않아요 (${e.cause?.code ?? e.name})` })
    }
  },
  /** The models this Mac's Claude Code offers (its own catalog), for the site's model list. */
  async models({ reqId }) {
    emit({ t: 'models', reqId, ...(await claudeModels()) })
  },

  async skills({ reqId, sid }) {
    const s = sessions.get(sid)
    if (!s) return emit({ t: 'skills', reqId, ok: false, error: '이 맥에 그 세션이 없습니다' })
    try {
      // Counted across every conversation on this Mac, kept between calls: only what was added is read again.
      skillUsage ??= new SkillUsage({ statePath: path.join(STATE_DIR, 'skill-usage.json'), projectsDir: path.join(CLAUDE_DIR, 'projects') })
      await (skillUsageRun ??= skillUsage.update().finally(() => (skillUsageRun = null)))
      const menu = skillMenu(availableSkills(s.cwd, { home: HOME, claudeDir: CLAUDE_DIR }), skillUsage.counts())
      const cut = (list) => list.slice(0, 300)
      emit({ t: 'skills', reqId, ok: true, menu: { direct: cut(menu.direct), auto: cut(menu.auto), other: cut(menu.other) } })
    } catch (e) {
      emit({ t: 'skills', reqId, ok: false, error: e.message })
    }
  },

  /**
   * A side question: `/btw` answers from what the session already knows, in a panel over the terminal, and
   * leaves nothing in the conversation. It is typed even while the session works; the answer is read off the
   * panel, and the panel is closed.
   */
  async btw({ reqId, sid, text }) {
    const s = sessions.get(sid)
    if (!s) return emit({ t: 'btw', reqId, ok: false, error: '이 맥에 그 세션이 없습니다' })
    const q = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000)
    await tmux('send-keys', '-t', pane(s), '-l', `/btw ${q}`)
    await sleep(200)
    await term.sendKeys(pane(s), ['Enter'])
    // The panel: a ▔ rule, the question echoed, the answer indented under it, and a footer with "Esc to close".
    let answer = ''
    let last = ''
    for (const start = Date.now(); Date.now() - start < 60_000; ) {
      await sleep(400)
      const lines = (await term.capture(pane(s))).split('\n')
      const foot = lines.findLastIndex((l) => /Esc to close/.test(l))
      const head = lines.findLastIndex((l, i) => i < foot && /^\s*\/btw\s/.test(l))
      if (foot < 0 || head < 0) continue
      const body = lines.slice(head + 1, foot).map((l) => l.replace(/^ {0,6}/, '')).join('\n').trim()
      // Still thinking: the panel shows only a spinner line. That is not the answer.
      if (/^\S\s*Answering…?$/.test(body)) continue
      // Read when the same non-empty text is seen twice: it is written as it is generated.
      if (body && body === last) {
        answer = body
        break
      }
      last = body
    }
    await term.sendKeys(pane(s), ['Escape'])
    answer ||= last
    emit(answer ? { t: 'btw', reqId, ok: true, answer } : { t: 'btw', reqId, ok: false, error: '답을 화면에서 읽지 못했어요. 화면을 확인하세요' })
  },
  /** The folders under a path on this Mac, for choosing where a new session works. Names only, never contents. */
  dirs({ reqId, path: where }) {
    try {
      const dir = fs.realpathSync(expandHome(where || '~'))
      const dirs = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        .map((e) => ({ name: e.name, git: fs.existsSync(path.join(dir, e.name, '.git')) }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 500)
      const shown = dir === HOME || dir.startsWith(`${HOME}/`) ? `~${dir.slice(HOME.length)}` : dir
      emit({ t: 'dirs', reqId, ok: true, path: shown, parent: dir === '/' ? null : path.dirname(shown === '~' ? HOME : shown), dirs })
    } catch (e) {
      emit({ t: 'dirs', reqId, ok: false, error: e.code === 'ENOENT' ? '그 폴더가 없어요' : e.code === 'EACCES' || e.code === 'EPERM' ? '폴더를 읽을 권한이 없어요' : e.message })
    }
  },
  /**
   * The Claude Code conversations on this Mac that no bridge session holds: started in a terminal, or by another
   * tool. Newest first. Only the start and the end of each file are read (a transcript can be large).
   */
  recent({ reqId, exclude, include }) {
    try {
      // Asked for by id (a prepared list of conversations to carry on): listed however old they are.
      const wanted = new Set((Array.isArray(include) ? include : []).map(String))
      const skip = new Set([...(Array.isArray(exclude) ? exclude : []), ...[...sessions.values()].map((s) => s.conv)].map(String))
      const files = []
      // Every account's conversations: each is listed with the account it is in, and taken in that account.
      for (const { account, dir: root } of allProjects()) {
        if (!fs.existsSync(root)) continue
        for (const d of fs.readdirSync(root, { withFileTypes: true })) {
          if (!d.isDirectory()) continue
          const dir = path.join(root, d.name)
          for (const f of fs.readdirSync(dir)) {
            const m = /^([0-9a-f-]{36})\.jsonl$/.exec(f)
            if (!m || skip.has(m[1])) continue
            try {
              const st = fs.statSync(path.join(dir, f))
              if (st.size > 0) files.push({ conv: m[1], file: path.join(dir, f), mtime: st.mtimeMs, size: st.size, account })
            } catch {}
          }
        }
      }
      files.sort((a, b) => b.mtime - a.mtime)
      const list = []
      for (const f of [...files.slice(0, 80), ...files.slice(80).filter((x) => wanted.has(x.conv))]) {
        const info = conversationInfo(f.file, f.size)
        if (!info.cwd) continue
        list.push({ conv: f.conv, cwd: info.cwd, title: info.title, first: info.first, last: info.last, mtime: f.mtime, size: f.size, active: Date.now() - f.mtime < 60_000, exists: fs.existsSync(info.cwd), account: f.account })
      }
      emit({ t: 'recent', reqId, ok: true, home: HOME, conversations: list })
    } catch (e) {
      emit({ t: 'recent', reqId, ok: false, error: e.code === 'ENOENT' ? '이 맥에 Claude Code 대화 기록이 없어요' : e.message })
    }
  },
  /** Take a conversation this Mac already has into a bridge session: `claude --resume` in its own folder. */
  async adopt({ reqId, sid, conv, cwd, autoPush, sysPrompt }) {
    try {
      if (!/^[0-9a-f-]{36}$/.test(String(conv))) throw new Error('대화 id 가 올바르지 않습니다')
      if ([...sessions.values()].some((x) => x.conv === conv)) throw new Error('이미 bridge 세션으로 열려 있는 대화입니다')
      const want = expandHome(String(cwd || ''))
      if (!want || !fs.existsSync(want) || !fs.statSync(want).isDirectory()) throw new Error(`이 대화의 폴더가 이 맥에 없습니다: ${cwd}`)
      // Looked for in every account: the session runs in the account whose folder has the conversation.
      let file = null
      let account = ''
      for (const { account: a, dir: root } of allProjects()) {
        if (!fs.existsSync(root)) continue
        file = [path.join(projectDir(want, a), `${conv}.jsonl`), ...fs.readdirSync(root).map((d) => path.join(root, d, `${conv}.jsonl`))].find((f) => fs.existsSync(f))
        if (file) {
          account = a
          break
        }
      }
      if (!file) throw new Error('이 맥에서 그 대화의 기록을 찾지 못했습니다')
      const s = { cwd: fs.realpathSync(want), autoPush: autoPush !== false, conv, transcript: file, sysPrompt: String(sysPrompt ?? '').slice(0, 8000), ...(account ? { account } : {}) }
      // The whole conversation so far is read and synced from its first line: the server's copy is what a move
      // to another Mac resumes from.
      Object.assign(s, { offset: 0, lineNo: 0, skip: 0 })
      resetRuntime(s)
      sessions.set(sid, s)
      try {
        await launch(sid, s, ['--resume', conv, ...settingsArgs(s)])
      } catch (e) {
        sessions.delete(sid)
        throw e
      }
      saveSessions()
      log('info', 'adopt', `폴더(${s.cwd.length}자)의 대화 ${conv.slice(0, 8)} 를 이어서 엶`, sid)
      emit({ t: 'opened', reqId, sid, ok: true, cwd: s.cwd, warnings: [], account })
    } catch (e) {
      log('error', 'adopt', `대화를 가져오지 못함: ${e.message}`, sid)
      emit({ t: 'opened', reqId, sid, ok: false, error: e.message })
    }
  },
  /** Claude accounts on this Mac (설정 → Claude 계정): list, add, rename, sign in and out, sync, remove. */
  async account({ reqId, op, id, name, code }) {
    const done = (more = {}) => emit({ t: 'account', reqId, ok: true, accounts: accountList(), ...more })
    try {
      if (op === 'list') return (await refreshAccounts(), done())
      if (op === 'add') {
        const label = accountName(name)
        if (!label) throw new Error('계정 이름을 적어 주세요')
        if (accounts.length >= 10) throw new Error('계정은 10개까지 더할 수 있어요')
        const nid = newAccountId()
        const dir = path.join(STATE_DIR, 'accounts', nid)
        const linked = prepareAccountDir(dir, { mainDir: CLAUDE_DIR, mainConfig: MAIN_CONFIG })
        accounts.push({ id: nid, name: label, dir })
        saveAccounts()
        log('info', 'account', `Claude 계정 추가: ${label} (공유: ${linked.join(', ') || '없음'})`)
        await refreshAccounts(nid)
        return done({ id: nid })
      }
      if (!safeAccountId(id) || accountDir(id) === null) throw new Error('이 맥에 그 Claude 계정이 없어요')
      const busy = [...sessions.values()].filter((s) => (s.account ?? '') === id)
      if (op === 'rename') {
        const label = accountName(name)
        if (!label) throw new Error('계정 이름을 적어 주세요')
        if (!id) (config.mainAccountName = label), writeJson(configPath, config)
        else (accounts.find((a) => a.id === id).name = label), saveAccounts()
        emit({ t: 'accounts', accounts: accountList() })
        return done()
      }
      if (op === 'login') {
        const url = await startLogin(id)
        log('info', 'account', `Claude 계정 로그인 시작: ${id || '기본'}`)
        return done({ url })
      }
      if (op === 'code') {
        if (!safeLoginCode(code)) throw new Error('붙여 넣은 코드가 올바르지 않아요. 로그인 화면에 나온 코드를 그대로 붙여 넣어 주세요')
        await finishLogin(id, code)
        log('info', 'account', `Claude 계정 로그인 완료: ${id || '기본'}`)
        return done()
      }
      if (op === 'cancel') {
        await tmux('kill-session', '-t', `=${loginTmux(id)}`)
        logins.delete(id)
        return done()
      }
      if (op === 'logout') {
        const r = await runClaude(['auth', 'logout'], accountEnvOf(id))
        await refreshAccounts(id)
        if (!r.ok) throw new Error(`로그아웃하지 못했어요: ${r.err.slice(0, 200)}`)
        log('info', 'account', `Claude 계정 로그아웃: ${id || '기본'}`)
        return done()
      }
      if (op === 'sync') {
        if (!id) throw new Error('기본 계정이 원본이라 맞출 게 없어요')
        // Claude Code writes its .claude.json while it runs: it would put back what was just copied.
        if (busy.some((s) => s.alive)) throw new Error('이 계정으로 도는 세션이 있어요. 그 세션들을 끝내거나 다른 계정으로 옮긴 뒤 다시 해 주세요')
        prepareAccountDir(accountDir(id), { mainDir: CLAUDE_DIR, mainConfig: MAIN_CONFIG })
        syncAccountConfig(accountDir(id), MAIN_CONFIG)
        log('info', 'account', `Claude 계정 공유 설정 다시 맞춤: ${id}`)
        return done()
      }
      if (op === 'remove') {
        if (!id) throw new Error('기본 계정은 뺄 수 없어요')
        if (busy.length) throw new Error(`이 계정을 쓰는 세션이 ${busy.length}개 있어요. 다른 계정으로 옮기거나 끝낸 뒤 빼 주세요`)
        // Signed out first, so the keychain item goes too. The folder (its conversations) is kept aside, not deleted.
        await runClaude(['auth', 'logout'], accountEnvOf(id))
        const dir = accountDir(id)
        const aside = path.join(STATE_DIR, 'accounts-removed', `${id}-${Date.now()}`)
        fs.mkdirSync(path.dirname(aside), { recursive: true, mode: 0o700 })
        fs.renameSync(dir, aside)
        accounts = accounts.filter((a) => a.id !== id)
        saveAccounts()
        accountAuth.delete(id)
        log('info', 'account', `Claude 계정 뺌: ${id} (폴더는 accounts-removed 에 둠)`)
        emit({ t: 'accounts', accounts: accountList() })
        return done()
      }
      throw new Error('모르는 계정 동작이에요')
    } catch (e) {
      log('warn', 'account', `${op}: ${e.message}`)
      emit({ t: 'account', reqId, ok: false, error: e.message, accounts: accountList() })
    }
  },
  /** 헤드리스 연동 모드: keep a headless browser on the site's bridge page. `login` is a one-time sign-in link. */
  /**
   * A recording from the input box to words (REQ-F-754): the page sends it, the words go back, and the page sends
   * them like anything typed. Nothing here touches a session.
   */
  async voice({ reqId, audio, opts }) {
    try {
      const dir = whisperDir()
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      whisper ??= new LocalWhisper({ dir, log })
      const r = await voiceTranscribe(Buffer.from(String(audio ?? ''), 'base64'), opts, { dir, local: whisper, log })
      emit({ t: 'voice', reqId, ok: true, ...r })
    } catch (e) {
      if (!e.code) log('error', 'voice', `실패: ${e.stack || e.message}`)
      emit({ t: 'voice', reqId, ok: false, code: e.code || 'error', error: e.message })
    }
  },

  async background({ reqId, on, login }) {
    config.background = !!on
    writeJson(configPath, config)
    if (on) {
      // Exactly the site's own QR sign-in address: the agent key goes on it (R1-M7).
      const ok = siteLogin(login, config.site)
      if (ok) bg.login = ok
      bg.restarts = 0
      stopBackground()
      startBackground()
    } else stopBackground()
    emit({ t: 'background', reqId, ok: !on || !!bg.child, ...backgroundState(), ...(on && !bg.child ? { error: bg.error ?? '헤드리스 연동 모드의 브라우저를 띄우지 못했습니다' } : {}) })
    health().catch(() => {})
  },
  /** "지금 복구" from the site: one repair, now. */
  async heal({ reqId, action }) {
    let text = ''
    if (action === 'background-restart') {
      if (!config.background) text = '헤드리스 연동 모드가 꺼져 있어요'
      else {
        bg.restarts = 0
        stopBackground()
        setTimeout(startBackground, 2000)
        text = '헤드리스 브라우저를 다시 띄워요'
      }
    } else if (action === 'awake-apply') {
      lidActive = !config.keepLidAwake
      if (keepAwake && !config.keepAwake) keepAwake.kill()
      await applyAwake()
      text = '잠자기 설정을 다시 적용했어요'
    } else if (action === 'check') {
      await runChecks()
      text = '다시 점검했어요'
    } else if (action === 'restart') {
      if (!asService) text = '터미널에서 실행 중인 에이전트는 사이트에서 다시 시작할 수 없어요'
      else {
        // launchd starts it again. Work in progress is handed over (writeHandoff); only the agent's own few-second actions are waited for.
        restartWanted = Date.now()
        text = '에이전트를 다시 시작해요(일하는 세션은 그대로 이어져요)'
      }
    } else if (action === 'rekey') {
      const why = rotateKey('사이트에서 요청')
      if (why) return emit({ t: 'heal', reqId, ok: false, error: why })
      text = '에이전트 키를 새로 만들어 연동 탭에 넘겼어요. 다른 브라우저의 연동 탭은 15분 안에 새로고침하거나 연동 링크를 다시 열어 주세요'
    } else return emit({ t: 'heal', reqId, ok: false, error: '모르는 복구 동작이에요' })
    repaired(action, `사이트에서 요청: ${text}`)
    emit({ t: 'heal', reqId, ok: true, note: text })
    health().catch(() => {})
  },
  /** The site's switches for staying awake. Kept in agent.json; applied at once. */
  async awake({ reqId, idle, lid }) {
    if (typeof idle === 'boolean') config.keepAwake = idle
    if (typeof lid === 'boolean') config.keepLidAwake = lid
    writeJson(configPath, config)
    await applyAwake().catch((e) => log('error', 'awake', e.message))
    const ready = await lidReady()
    emit({ t: 'awake', reqId, ok: !(config.keepLidAwake && !lidActive), idle: !!keepAwake, lid: lidActive, lidReady: ready, ...(config.keepLidAwake && !lidActive ? { error: ready ? '덮개 닫힘 잠자기를 막지 못했어요. 에이전트 로그를 확인해 주세요' : '덮개를 닫아도 켜 두려면 그 맥의 터미널에서 한 번 설정해야 해요. 명령은 맥 화면의 안내에서 복사할 수 있어요' } : {}) })
    health().catch(() => {})
  },
  /** The site's choice of when sessions compact (REQ-F-775): a number of tokens, or null for Claude Code's own. */
  compact({ reqId, window }) {
    if (window !== null && !compactWindowOf(window)) return emit({ t: 'compact', reqId, ok: false, error: `압축 시점은 ${COMPACT_MIN.toLocaleString()}~${COMPACT_MAX.toLocaleString()} 토큰이에요` })
    if (window === null) delete config.compactWindow
    else config.compactWindow = window
    writeJson(configPath, config)
    writeHookSettings()
    log('info', 'compact', window ? `자동 압축 시점 ${window} 토큰` : '자동 압축 시점: Claude Code 설정을 따름')
    emit({ t: 'compact', reqId, ok: true, window: compactWindowOf(config.compactWindow) })
    health().catch(() => {})
  },
  /** Say where the session stands, even if nothing changed since it was last said. */
  report({ sid }) {
    const s = sessions.get(sid)
    if (s) ((s.statusKey = null), publish(sid, s))
  },
  /** The server hands out a newer agent: keep it until the sessions are at rest, then become it. */
  update({ build, files, msig, seq }) {
    if (build === BUILD) return
    if (noAutoUpdate) return log('info', 'update', `새 버전(${build})이 있지만 --no-auto-update 로 켜져 있어 그대로 둠`)
    // A checkout being worked on is not an installation: its files are the developer's, not the server's.
    if (path.resolve(AGENT_DIR) !== path.resolve(STATE_DIR)) return log('info', 'update', `새 버전(${build})이 있지만 설치본(${STATE_DIR})이 아닌 곳에서 실행 중이라 그대로 둠`)
    if (config.updateTried?.build === build && Date.now() - config.updateTried.at < 600_000) return
    const names = Object.keys(files ?? {})
    if (!names.includes('agent.mjs') || names.some((n) => !/^[a-z]+\.mjs$/.test(n) || typeof files[n] !== 'string')) return log('error', 'update', '받은 업데이트의 파일 목록이 올바르지 않음')
    // What arrived must be exactly what the server says it serves.
    const got = names.reduce((h, n) => h.update(files[n]), crypto.createHash('sha1')).digest('hex').slice(0, 12)
    if (got !== build) return log('error', 'update', `받은 파일의 지문(${got})이 서버가 말한 것(${build})과 달라 버림`)
    // Signed by the maintainer, not just served by the server: a server or a site page that is broken into cannot
    // hand this agent code of its own (R1-I1). The signature covers every file's name, length and SHA-256 (R5-H1,
    // R5-M1), after a number that only grows: an older signed agent is not taken back (R5-L1).
    // Each refusal is said once in ten minutes: the server offers the same update on every reconnect (R7-L3).
    const refuse = (why) => {
      const key = `${got}|${why}`
      if (lastRefusal?.key === key && Date.now() - lastRefusal.at < 600_000) return
      lastRefusal = { key, at: Date.now() }
      log('error', 'update', why)
    }
    if (!manifestSigned(files, seq, msig)) return refuse(`새 버전(${got})에 관리자 서명이 없거나 맞지 않아 버림`)
    // Also against an update already taken and waiting to be put in place (R8-I1).
    const floor = Math.max(config.updateSeq ?? 0, pendingUpdate?.seq ?? 0)
    if (seq < floor) return refuse(`새 버전(${got})이 지금 것보다 먼저 서명된 것(${seq} < ${floor})이라 버림`)
    // The number is kept only once the update is in place (applyUpdate): a failed install leaves it, so the version
    // before can still be sent to this Mac (R7-L1).
    pendingUpdate = { build, files, seq, at: Date.now() }
    log('info', 'update', `새 버전 ${build} 을 받음(관리자 서명 확인 · 순번 ${seq}). 곧 바꿉니다(일하는 세션은 그대로 이어짐)`)
  },
  resync({ sid, lines }) {
    const s = sessions.get(sid)
    if (s) rewind(s, lines)
  },
}

/**
 * A new agent key (R1-M8). It goes straight to the linked tab over its own stream from 127.0.0.1, never through the
 * server, and that tab keeps it where every page of the site in this browser reads it. The old key still opens the
 * agent for OLD_KEY_MS, for tabs of other browsers on this Mac. The headless browser, when it is not the linked tab,
 * is started again with the new key on its address. Returns why it could not, or null.
 */
function rotateKey(reason) {
  if (!client || !clientRekey) return '키를 넘겨받을 수 있는 연동 탭이 연결돼 있지 않아요(연동 페이지를 새로고침한 뒤 다시 해 주세요)'
  const key = crypto.randomBytes(24).toString('base64url')
  config.oldKey = { key: config.key, until: Date.now() + OLD_KEY_MS }
  config.retiredKeys = retireKey(config.retiredKeys, config.key)
  config.key = key
  config.keyGen = KEY_GEN
  config.keyAt = Date.now()
  writeJson(configPath, config)
  client.write(`data: ${JSON.stringify({ t: 'rekey', key })}\n\n`)
  clientOldKey = false
  log('info', 'link', `에이전트 키를 바꿈 (${reason})`)
  if (config.background && !clientBg) {
    fs.rmSync(path.join(BG_PROFILE, '.linked'), { force: true })
    bg.restarts = 0
    stopBackground()
    setTimeout(startBackground, 2000)
  }
  return null
}

/** The key's state for the operator page: no key or key print, only when it changed and how the tabs follow it. */
const keyState = () => ({
  gen: config.keyGen ?? 1,
  latest: KEY_GEN,
  at: config.keyAt ?? null,
  oldUntil: config.oldKey && Date.now() < config.oldKey.until ? config.oldKey.until : null,
  retired: (config.retiredKeys ?? []).length,
  linked: client ? (clientOldKey ? 'old' : 'current') : null,
  stale: stats.staleKey ?? null,
  reopen: stats.reopen ?? null,
})

/** When the link page was last opened again in each browser, for a tab that came back with a retired key. */
const reopened = new Map()
const REOPEN_MS = 10 * 60_000
/**
 * A tab came with a key this agent retired: its browser was closed while the key changed and cannot get the new one
 * by itself. The link page opens in that browser with the current key, on this Mac only (the key never goes through
 * the server), and every tab of that browser takes it from there. At most once per REOPEN_MS per browser.
 */
function reopenLink(ua) {
  const app = browserApp(ua)
  stats.staleKey = { at: Date.now(), app }
  if (!app || process.platform !== 'darwin' || !config.site) return
  if (Date.now() - (reopened.get(app) ?? 0) < REOPEN_MS) return
  reopened.set(app, Date.now())
  execFile('open', ['-b', app, bridgeLink()], (err) => {
    stats.reopen = { at: Date.now(), app, ok: !err }
    log(err ? 'warn' : 'info', 'link', err ? `예전 키로 온 ${app} 에 연동 페이지를 다시 열지 못함` : `예전 키로 온 ${app} 에 연동 페이지를 새 키로 다시 엶`)
  })
}

/** Folders that are never thrown away: the home folder, anything above it, and where Claude and this agent keep their own files. */
function trashable(dir, sid) {
  const f = path.resolve(dir)
  const real = fs.existsSync(f) && fs.statSync(f).isDirectory() ? fs.realpathSync(f) : null
  const home = fs.realpathSync(HOME)
  if (!real) throw new Error('폴더가 없어요')
  if (!real.startsWith(`${home}/`)) throw new Error('홈 폴더 밖이거나 홈 폴더 자체라서 버릴 수 없어요')
  if (path.dirname(real) === home) throw new Error('홈 바로 아래 폴더는 버릴 수 없어요')
  const trash = path.join(home, '.Trash')
  if (real === trash || real.startsWith(`${trash}/`)) throw new Error('이미 휴지통 안에 있어요')
  // What the agent and Claude Code themselves live in, wherever that is.
  for (const keep of [CLAUDE_DIR, STATE_DIR, AGENT_DIR].map((d) => (fs.existsSync(d) ? fs.realpathSync(d) : d))) {
    if (real === keep || keep.startsWith(`${real}/`)) throw new Error('기본 세션 폴더는 버릴 수 없어요')
  }
  for (const [id, o] of sessions) {
    if (id !== sid && o.cwd && !o.closed && path.resolve(o.cwd) === f) throw new Error('다른 살아 있는 세션이 쓰는 폴더라 버릴 수 없어요')
  }
  return real
}

// ---------- health ----------

/** What the server needs to tell whether this agent is well: tools, load, link, and each session's sync position. */
async function health() {
  // Problems are re-checked every minute so a fix shows up by itself; a healthy Mac only every ten.
  if (Date.now() - checkedAt > (checks.some((c) => c.level !== 'ok') ? 60_000 : 600_000)) await runChecks()
  const list = []
  for (const [sid, s] of sessions) {
    let size = null
    try {
      size = fs.statSync(transcriptPath(s, sid)).size
    } catch {}
    list.push({ id: sid, cwd: s.cwd, tmux: s.tmux, mux: muxOf(s), alive: s.alive ?? null, phase: phaseOf(s), hooks: !!s.hooks, held: s.held?.length ?? 0, lines: s.lineNo ?? 0, offset: s.offset ?? 0, transcriptBytes: size, folderAt: s.folderAt || null, autoPush: s.autoPush !== false, pushError: Object.values(s.pushError ?? {}).filter(Boolean)[0] ?? null })
  }
  emit({
    t: 'health',
    version: VERSION,
    uptime: Date.now() - STARTED,
    tools: stats.tools,
    checks,
    checkedAt,
    keepAwake: !!keepAwake,
    background: backgroundState(),
    features: await features(),
    voice: voiceStatus({ dir: whisperDir(), local: whisper }),
    repairs: repairs.slice(0, 30),
    compactWindow: compactWindowOf(config.compactWindow),
    awake: { idle: !!config.keepAwake, idleActive: !!keepAwake, lid: !!config.keepLidAwake, lidActive, lidReady: await lidReady(), kind: config.kind },
    load: os.loadavg()[0],
    memFree: os.freemem(),
    memTotal: os.totalmem(),
    rss: process.memoryUsage().rss,
    sent: stats.sent,
    commands: stats.commands,
    lastCommand: stats.lastCommand,
    lastError: stats.lastError,
    lastTail: stats.lastTail,
    pageConnectedAt: stats.pageConnectedAt,
    pageConnects: stats.pageConnects,
    keyState: keyState(),
    pendingLogs: pendingLogs.length,
    sessions: list,
  })
}
setInterval(() => client && welcomed && health().catch((e) => log('error', 'health', e.message)), HEALTH_MS)

// ---------- TestFlight (REQ-F-781) ----------

/** What scripts/testflight.sh last wrote on a Mac that uploads the iOS app: only its one line, overwritten each run. */
const TESTFLIGHT_RESULT = path.join(STATE_DIR, 'testflight', 'result')
/** `YYYY-MM-DD HH:MM:SS 올림 <sha7> build <N>` (local time) as { build, at }; a failed run's line is not one. */
function testflightUpload(text) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) 올림 [0-9a-f]{7,40} build (\d+)\s*$/m.exec(String(text))
  if (!m) return null
  const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
  return Number.isFinite(at) ? { build: Number(m[7]), at } : null
}
let testflightSent = ''
/** Told at each welcome (sent = '') and whenever the file says something new; the server keeps it only from an operator. */
function reportTestflight() {
  let v = null
  try {
    v = testflightUpload(fs.readFileSync(TESTFLIGHT_RESULT, 'utf8'))
  } catch {}
  const key = v ? `${v.build}@${v.at}` : ''
  if (!v || key === testflightSent) return
  testflightSent = key
  emit({ t: 'testflight', ...v })
}
setInterval(() => client && welcomed && reportTestflight(), 60_000)

// ---------- checks ----------

/** Run `claude` as a plain command: a Claude Code session that started this agent must not leak into it. */
const claudeEnv = () => {
  const env = { ...process.env }
  delete env.CLAUDECODE
  return env
}
const runClaudeOnce = (argv, env = {}) => new Promise((resolve) => execFile(CLAUDE_BIN, argv, { timeout: 20_000, env: { ...claudeEnv(), ...env }, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, code: err?.code, out: String(stdout).trim(), err: String(stderr).trim() || (err ? String(err.message) : '') })))
/**
 * Claude Code's model catalog: the answer to `initialize` from a print-mode session that is given no prompt, so
 * nothing is sent to a model. Ended as soon as the answer is read (30 s at most).
 */
function claudeModels() {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { cwd: HOME, env: claudeEnv(), stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = ''
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        child.stdin.end()
        child.kill('SIGTERM')
      } catch {}
      resolve(r)
    }
    const timer = setTimeout(() => finish({ ok: false, error: '30초 안에 모델 목록을 주지 않았습니다' }), 30_000)
    child.on('error', (e) => finish({ ok: false, error: `claude 를 실행하지 못했습니다: ${e.message}` }))
    child.on('exit', () => finish({ ok: false, error: '모델 목록을 주기 전에 claude 가 끝났습니다' }))
    child.stdin.on('error', () => {})
    child.stdout.on('data', (d) => {
      buf += d
      for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let j
        try {
          j = JSON.parse(line)
        } catch {
          continue
        }
        if (j.type !== 'control_response' || j.response?.request_id !== 'models') continue
        const r = j.response.response ?? {}
        if (j.response.subtype !== 'success' || !Array.isArray(r.models)) return finish({ ok: false, error: j.response.error || '모델 목록이 비어 있습니다' })
        const text = (v, n) => String(v ?? '').slice(0, n)
        return finish({ ok: true, version: text(r.claude_code_version, 40), models: r.models.slice(0, 60).map((m) => ({ value: text(m.value, 80), resolved: text(m.resolvedModel ?? m.value, 80), name: text(m.displayName ?? m.value, 80), description: text(m.description, 200) })) })
      }
    })
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } })}\n`)
  })
}
/** Claude Code replaces its own binary when it updates: a "not found" in that instant is retried once. */
async function runClaude(argv, env) {
  const r = await runClaudeOnce(argv, env)
  if (r.ok || r.code !== 'ENOENT') return r
  await sleep(1500)
  return runClaudeOnce(argv, env)
}

// ---------- Claude accounts: sign-in and status ----------

/** The environment that points claude at an account's config folder. The main one keeps what the agent has. */
const accountEnvOf = (id) => (id ? { CLAUDE_CONFIG_DIR: accountDir(id) } : process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: CLAUDE_DIR } : {})

/** Every account as the page shows it: its name, its sign-in, and how many of this Mac's sessions use it. */
function accountList() {
  const used = (id) => [...sessions.values()].filter((s) => (s.account ?? '') === id).length
  return [{ id: '', name: config.mainAccountName || '기본 계정', main: true }, ...accounts.map(({ id, name }) => ({ id, name, main: false }))].map((a) => ({ ...a, ...(accountAuth.get(a.id) ?? { loggedIn: null }), sessions: used(a.id), signingIn: logins.has(a.id) }))
}
/** Asks each account (or one) who is signed in, then tells the server. */
async function refreshAccounts(only) {
  for (const a of [{ id: '' }, ...accounts]) {
    if (only !== undefined && a.id !== only) continue
    const r = await runClaude(['auth', 'status', '--json'], accountEnvOf(a.id))
    accountAuth.set(a.id, authOf(r.out))
  }
  emit({ t: 'accounts', accounts: accountList() })
}

const loginTmux = (id) => `cb-login-${config.hostId.slice(0, 4)}-${id || 'main'}`
/** The last lines of a sign-in screen, without the address (it carries the sign-in's state). */
const loginTail = (screen) => screen.split('\n').filter((l) => l.trim() && !/https?:\/\//.test(l)).slice(-4).join(' / ') || '출력 없음'

/**
 * Starts `claude auth login` for an account in a terminal of its own and returns the sign-in address it prints.
 * The person opens it on any device, signs in, and pastes the code they are shown back on the page
 * (finishLogin). BROWSER points at a command that does nothing, so no browser opens on the Mac itself.
 */
async function startLogin(id) {
  const name = loginTmux(id)
  await tmux('kill-session', '-t', `=${name}`)
  logins.delete(id)
  const mux = newMux()
  placeTerminal(name, mux)
  const env = Object.entries({ ...accountEnvOf(id), BROWSER: '/usr/bin/true' }).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  // Waits 15 minutes for the code, then the terminal goes away by itself.
  const r = await tmux('new-session', '-d', '-s', name, '-x', '200', '-y', '50', ...env, `unset CLAUDECODE; ${ttyPrefix(mux)}${shq(CLAUDE_BIN)} auth login; echo "[login exited $?]"; sleep 900`)
  if (!r.ok) throw new Error(`${mux}: ${r.err}`)
  let screen = ''
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    // -J joins the address that the terminal wrapped onto several lines.
    screen = await tmuxRaw('capture-pane', '-p', '-J', '-t', `=${name}:`)
    const url = loginUrlOf(screen)
    if (url) {
      logins.set(id, { name, at: Date.now() })
      return url
    }
    if (/\[login exited \d+\]/.test(screen)) break
  }
  await tmux('kill-session', '-t', `=${name}`)
  throw new Error(`로그인 주소를 받지 못했어요: ${loginTail(screen)}`)
}
/** Types the code from the sign-in page into the waiting `claude auth login`, and reads whether it worked. */
async function finishLogin(id, code) {
  const l = logins.get(id)
  if (!l) throw new Error('로그인을 먼저 시작해 주세요')
  const typed = await tmux('send-keys', '-t', `=${l.name}:`, '-l', code.trim())
  if (!typed.ok) {
    logins.delete(id)
    throw new Error('로그인 창이 닫혔어요(15분이 지났을 수 있어요). 로그인을 다시 시작해 주세요')
  }
  await sleep(300)
  await tmux('send-keys', '-t', `=${l.name}:`, 'Enter')
  let screen = ''
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    screen = await tmuxRaw('capture-pane', '-p', '-J', '-t', `=${l.name}:`)
    if (/\[login exited \d+\]/.test(screen)) break
  }
  await tmux('kill-session', '-t', `=${l.name}`)
  logins.delete(id)
  await refreshAccounts(id)
  if (accountAuth.get(id)?.loggedIn !== true) throw new Error(`로그인하지 못했어요: ${loginTail(screen)}`)
}

/**
 * Everything that has to be true on this Mac for sessions to work, each with what to do when it is not.
 * `blocks` checks stop a session from starting; the rest are warnings.
 * @type {Array<{ id: string, level: 'ok'|'warn'|'fail', title: string, detail: string, fix?: string, blocks?: boolean }>}
 */
let checks = []
let checkedAt = 0

async function runChecks() {
  const out = []
  const add = (id, level, title, detail, fix, blocks) => out.push({ id, level, title, detail, ...(level !== 'ok' && fix ? { fix } : {}), ...(blocks ? { blocks: true } : {}) })

  const startedAt = Date.now()
  // zeropty is where new sessions run (REQ-F-794); tmux is what they fall back to, and where older sessions stay.
  zeroptyReady = zeroptyInstalled(ZP)
  const zv = zeroptyReady ? await run(ZP.bin, ['-V']) : null
  stats.tools.zeropty = zv?.ok ? ZEROPTY.version : null
  const keepTmux = config.mux === 'tmux'
  if (zv?.ok) add('zeropty', 'ok', 'zeropty', `${ZEROPTY.version}${keepTmux ? ' (이 맥은 tmux 로 고정: --mux tmux)' : ''}`)
  else add('zeropty', 'warn', 'zeropty', zeroptyReady ? `${ZEROPTY.version} 가 실행되지 않습니다. 새 세션은 tmux 로 엽니다` : `${ZEROPTY.version} 를 아직 받지 못했습니다. 새 세션은 tmux 로 엽니다 (에이전트가 다시 받아 봅니다)`)
  const tm = await run('tmux', ['-V'])
  stats.tools.tmux = tm.ok ? tm.out : null
  if (tm.ok) add('tmux', 'ok', 'tmux', tm.out)
  else if (zv?.ok && !keepTmux) add('tmux', 'warn', 'tmux', '설치돼 있지 않습니다. 세션은 zeropty 에서 돌고, tmux 는 zeropty 가 안 될 때의 대비입니다', 'brew install tmux')
  else add('tmux', 'fail', 'tmux', '설치돼 있지 않습니다. zeropty 가 없거나 tmux 로 고정해 세션은 tmux 안에서 돕니다', 'brew install tmux', true)

  const gt = await run('git', ['--version'])
  stats.tools.git = gt.ok ? gt.out : null
  if (gt.ok) add('git', 'ok', 'git', gt.out)
  else add('git', 'warn', 'git', /xcode-select|xcrun|developer tools/i.test(gt.err) ? 'Xcode 명령줄 도구가 설치돼 있지 않아 git 을 쓸 수 없습니다. 브랜치·커밋 싱크와 자동 push 가 빠집니다' : '설치돼 있지 않습니다. 브랜치·커밋 싱크와 자동 push 가 빠집니다', 'xcode-select --install')

  const cv = await runClaude(['--version'])
  stats.tools.claude = cv.ok ? cv.out.split('\n')[0].slice(0, 60) : null
  if (!cv.ok) add('claude', 'fail', 'claude', `실행할 수 없습니다 (${cv.err.split('\n')[0].slice(0, 120)})`, 'curl -fsSL https://claude.ai/install.sh | bash', true)
  else {
    add('claude', 'ok', 'claude', stats.tools.claude)
    const help = await runClaude(['--help'])
    if (help.ok && !(help.out.includes('--session-id') && help.out.includes('--resume'))) add('claude-version', 'fail', 'claude 버전', '이 버전에는 --session-id 또는 --resume 이 없어 세션을 시작하거나 옮길 수 없습니다', 'claude update', true)
    const auth = await runClaude(['auth', 'status'])
    let info = null
    try {
      info = JSON.parse(auth.out)
    } catch {}
    if (info?.projectsDirectory) projectsDir = info.projectsDirectory
    if (info?.loggedIn === true) add('claude-login', 'ok', 'claude 로그인', `로그인됨 (${info.authMethod ?? '확인됨'})`)
    else if (info?.loggedIn === false) add('claude-login', 'fail', 'claude 로그인', '로그인돼 있지 않습니다. 세션을 열면 로그인 화면에서 멈춥니다', '이 맥의 터미널에서 claude 를 실행하고 /login', true)
    else add('claude-login', 'warn', 'claude 로그인', '로그인 상태를 확인하지 못했습니다 (이 버전은 `claude auth status` 가 없을 수 있음)', '이 맥의 터미널에서 claude 를 한 번 실행해 로그인돼 있는지 확인')
  }

  for (const [id, title, dir] of [['state-dir', '에이전트 폴더', STATE_DIR], ['claude-dir', 'claude 기록 폴더', projectsDir]]) {
    try {
      if (!doctorOnly) fs.mkdirSync(dir, { recursive: true })
      else if (!fs.existsSync(dir)) {
        add(id, 'ok', title, `${dir} (아직 없음, 처음 켤 때 만들어짐)`)
        continue
      }
      fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK)
      add(id, 'ok', title, dir)
    } catch (e) {
      add(id, 'fail', title, `${dir} 에 쓸 수 없습니다 (${e.code})`, `chmod u+rwx ${shq(dir)}`, true)
    }
  }

  try {
    const st = fs.statfsSync(HOME)
    const free = st.bavail * st.bsize
    const gb = `${(free / 1e9).toFixed(1)}GB 남음`
    free < 1e9 ? add('disk', 'fail', '디스크', `${gb}. 대화 기록을 쓰지 못할 수 있습니다`, '디스크 공간을 1GB 이상 비워 주세요') : free < 5e9 ? add('disk', 'warn', '디스크', gb, '디스크 공간이 얼마 남지 않았습니다') : add('disk', 'ok', '디스크', gb)
  } catch {}

  if (process.platform === 'darwin') {
    const pm = await run('/usr/bin/pmset', ['-g'])
    const sleepMin = Number(/^\s*sleep\s+(\d+)/m.exec(pm.out)?.[1] ?? 0)
    if (config.keepAwake) add('sleep', keepAwake ? 'ok' : 'warn', '잠자기', keepAwake ? '에이전트가 켜져 있는 동안 잠들지 않게 막는 중 (화면은 꺼질 수 있음)' : 'caffeinate 를 실행하지 못했습니다')
    else if (sleepMin > 0) add('sleep', 'warn', '잠자기', `이 맥은 ${sleepMin}분 동안 쓰지 않으면 잠듭니다. 잠들면 연결이 끊기고 세션이 멈춥니다`, '사이트의 기기 화면에서 "잠자기 막기" 를 켜면 에이전트가 켜진 동안 잠들지 않습니다 (맥북은 "덮개를 닫아도 켜 두기" 도 켜야 합니다)')
    else add('sleep', 'ok', '잠자기', '자동으로 잠들지 않게 설정돼 있음')

    const chrome = ['/Applications/Google Chrome.app', path.join(HOME, 'Applications/Google Chrome.app')].some((p) => fs.existsSync(p))
    chrome ? add('browser', 'ok', '브라우저', 'Chrome 있음') : add('browser', 'warn', '브라우저', 'Chrome 이 없습니다. Safari 는 연동 페이지가 이 맥의 에이전트(127.0.0.1)에 붙는 것을 막을 수 있습니다', 'Chrome 을 설치하고 연동 링크를 Chrome 에서 열기')
  }

  if (process.platform === 'darwin') {
    if (asService || serviceCmd === 'install') add('service', 'ok', '실행 방식', '백그라운드 서비스 (로그인하면 자동으로 켜짐)')
    else if (doctorOnly) add('service', 'ok', '실행 방식', fs.existsSync(PLIST) ? '백그라운드 서비스가 설치돼 있음' : '백그라운드 서비스가 설치돼 있지 않음')
    else add('service', 'warn', '실행 방식', '터미널에서 실행 중입니다. 이 터미널을 닫으면 에이전트가 꺼집니다', `node ${SELF} service install 로 설치하면 터미널 없이 로그인할 때 자동으로 켜집니다`)
  }

  // Say it once when something breaks and once when it is fixed, not on every round.
  const before = new Map(checks.map((c) => [c.id, c]))
  for (const c of out) {
    const was = before.get(c.id)?.level
    if (c.level !== 'ok' && was !== c.level) log(c.level === 'fail' ? 'error' : 'warn', 'check', `${c.title}: ${c.detail}${c.fix ? ` → ${c.fix}` : ''}`)
    if (c.level === 'ok' && was && was !== 'ok') log('info', 'check', `해결됨 — ${c.title}: ${c.detail}`)
  }
  checks = out
  checkedAt = zeroptyAt >= startedAt ? 0 : Date.now()
  return out
}

/** Refuse to start a session with a message that says what to fix, instead of a spawn error. */
async function requireReady() {
  const blocking = (await runChecks()).filter((c) => c.blocks && c.level === 'fail')
  if (blocking.length) throw new Error(`이 맥에서 먼저 해결할 것이 있습니다 — ${blocking.map((c) => `${c.title}: ${c.detail}${c.fix ? ` (해결: ${c.fix})` : ''}`).join(' / ')}`)
}

function printChecks() {
  console.log('점검:')
  for (const c of checks) console.log(`  ${c.level === 'ok' ? '✓' : c.level === 'warn' ? '!' : '✗'} ${c.title}: ${c.detail}${c.fix ? `\n      → ${c.fix}` : ''}`)
}

// ---------- staying awake ----------
// Two switches, set from the site per host (and kept in agent.json):
// - keepAwake: no idle sleep while the agent runs (caffeinate -i). The display may still turn off.
// - keepLidAwake: no sleep when a MacBook's lid is closed (pmset disablesleep 1), the display turned off when it closes
//   (watchLid). That needs root: a sudoers rule
//   that allows exactly "pmset -a disablesleep 0|1" is set up once from a terminal (`agent.mjs awake setup`).
//   Whatever the agent turned on it turns off when it stops, and on start if it is no longer wanted.
let keepAwake = null
const SUDOERS = '/etc/sudoers.d/claude-bridge-pmset'
const pmsetSleep = (on) => run('/usr/bin/sudo', ['-n', '/usr/bin/pmset', '-a', 'disablesleep', on ? '1' : '0'])
/** Whether this agent may switch lid sleep without a password (the sudoers rule is in place). */
async function lidReady() {
  if (process.platform !== 'darwin') return false
  return (await run('/usr/bin/sudo', ['-n', '-l', '/usr/bin/pmset', '-a', 'disablesleep', '1'])).ok
}
let lidActive = false
async function applyAwake() {
  if (process.platform !== 'darwin' || doctorOnly) return
  if (config.keepAwake && !keepAwake) {
    keepAwake = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
    keepAwake.on('error', () => (keepAwake = null))
    keepAwake.on('exit', () => (keepAwake = null))
  } else if (!config.keepAwake && keepAwake) {
    keepAwake.kill()
    keepAwake = null
  }
  const wantLid = !!config.keepLidAwake
  if (wantLid !== lidActive || (!wantLid && config.lidApplied)) {
    if (wantLid && !(await lidReady())) return log('warn', 'awake', '덮개를 닫아도 켜 두려면 터미널에서 한 번 설정해야 합니다: node ~/.claude-bridge/agent.mjs awake setup')
    const r = await pmsetSleep(wantLid)
    if (!r.ok) return log('error', 'awake', `덮개 닫힘 잠자기를 ${wantLid ? '막지' : '되돌리지'} 못함: ${r.err}`)
    lidActive = wantLid
    config.lidApplied = wantLid
    writeJson(configPath, config)
    log('info', 'awake', wantLid ? '덮개를 닫아도 잠들지 않게 함' : '덮개를 닫으면 잠들게 되돌림')
  }
}
/** What was turned on for the lid is turned off when the agent stops: a closed MacBook must not stay awake for nothing. */
function releaseLid() {
  if (!keepBrowser) stopBackground()
  if (!lidActive) return
  try {
    execFileSync('/usr/bin/sudo', ['-n', '/usr/bin/pmset', '-a', 'disablesleep', '0'], { stdio: 'ignore', timeout: 5000 })
    config.lidApplied = false
    writeJson(configPath, config)
  } catch {}
  lidActive = false
}
/**
 * With lid sleep turned off (disablesleep 1), closing a MacBook's lid no longer sleeps the Mac, and macOS also
 * leaves the built-in display lit behind the closed lid: it heats up and burns battery for nothing. So while
 * the lid is kept awake, the agent looks at the lid every few seconds and, once it is closed, sleeps the display
 * only (pmset displaysleepnow, no root needed) — again every minute it stays closed, in case something woke it.
 */
const LID_MS = 3_000
let lidClosed = false
let lidDimmedAt = 0
async function watchLid() {
  if (!lidActive) return void (lidClosed = false)
  const r = await run('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '1'], { timeout: 5_000 })
  const closed = /"AppleClamshellState"\s*=\s*Yes/.test(r.out)
  if (closed && (!lidClosed || Date.now() - lidDimmedAt > 60_000)) {
    const s = await run('/usr/bin/pmset', ['displaysleepnow'], { timeout: 5_000 })
    lidDimmedAt = Date.now()
    if (!lidClosed) log(s.ok ? 'info' : 'warn', 'awake', s.ok ? '덮개가 닫혀 화면을 껐어요(맥은 켜 둠)' : `덮개가 닫혔는데 화면을 끄지 못함: ${s.err}`)
  }
  lidClosed = closed
}
// ---------- macOS 허락 창 ----------
// A privacy prompt of macOS (TCC) stops the tool that asked until someone at the Mac answers it, and nothing on the
// session's screen says so. While a session works, the agent looks at the window list every 30 s (about 0.1 s, no
// permission needed) and tells the server when such an alert opens or closes; the server pushes it to the phone.
const SYSDIALOG_MS = 30_000
const SYSDIALOG_JXA = 'ObjC.import("CoreGraphics");JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly,0))).map(w=>({o:w.kCGWindowOwnerName,l:w.kCGWindowLayer,b:w.kCGWindowBounds})))'
let sysDialogAt = 0
async function watchSysDialog() {
  const working = [...sessions.entries()].filter(([, s]) => s.turn).map(([sid]) => sid)
  if (!working.length && !sysDialogAt) return
  const out = await new Promise((resolve) => execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SYSDIALOG_JXA], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout))))
  if (out == null) return
  let open
  try { open = sysDialogOpen(JSON.parse(out)) } catch { return }
  if (open === !!sysDialogAt) return
  sysDialogAt = open ? Date.now() : 0
  emit({ t: 'sysdialog', on: open, at: Date.now(), sids: working })
  log(open ? 'warn' : 'info', 'sysdialog', open ? `맥에 시스템 허락 창이 떴어요(일하는 세션 ${working.length}개)` : '시스템 허락 창이 닫혔어요')
  if (open) for (const sid of working) note(sid, '⚠️ 맥에 시스템 허락 창이 떠 있어요. 맥에서 직접 눌러 주기 전까지 이 세션이 멈춰 있을 수 있어요', 'warn')
}

if (!doctorOnly && !serviceCmd && !linkOnly && !awakeCmd) {
  applyAwake().catch((e) => log('error', 'awake', e.message))
  setInterval(() => watchLid().catch(() => {}), LID_MS).unref()
  setInterval(() => watchSysDialog().catch(() => {}), SYSDIALOG_MS).unref()
  process.on('exit', releaseLid)
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => (releaseLid(), process.exit(0)))
}

// ---------- 헤드리스 연동 모드: a headless browser keeps the bridge page ----------
// The link to the server is a page of the site running in a browser on this Mac (P2). 헤드리스 연동 모드 (switched
// per host from the site) has the agent keep such a page itself: this Mac's Chrome, headless, with a profile of
// its own (~/.claude-bridge/browser). It is signed in once with a one-time code the server hands over, and
// keeps the agent's port and key in that profile, so they are on its command line only the first time.
// Local network access from the site to 127.0.0.1 is allowed in that profile only (LocalNetworkAccessChecks):
// nobody is there to answer Chrome's question.
const CHROME_BIN = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(HOME, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')].find((p) => fs.existsSync(p)) ?? null
const BG_PROFILE = path.join(STATE_DIR, 'browser')
const bg = { child: null, startedAt: null, restarts: 0, error: null, login: null, timer: null, firstKey: false }
/**
 * A restart of the agent (an update, the site's "restart") leaves the headless browser running, and the next agent
 * takes it over: closing it dropped the link to the server for the seconds a new Chrome takes to load and link, and
 * every page showed the Mac as gone and back (badges, banners, a disabled composer). The page in it reaches the
 * agent again by itself (its EventSource reconnects).
 */
const BG_PID = path.join(STATE_DIR, 'browser.pid')
let keepBrowser = false
/**
 * The main process of a Chrome running on this profile, found by its command line. browser.pid can name a Chrome
 * that already ended while another still holds the profile (a new Chrome started while the old one was still
 * quitting ends at once with code 21, "profile in use", and its pid was written over the live one's): every new
 * start then ends with 21 again, for good. Such a Chrome is taken over instead.
 */
function profileChrome() {
  let out = ''
  try {
    out = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 5000 })
  } catch {}
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (m && m[2].includes(`--user-data-dir=${BG_PROFILE} `) && !m[2].includes('--type=')) return Number(m[1])
  }
  return 0
}
function adoptBackground() {
  let pid = Number(fs.existsSync(BG_PID) ? fs.readFileSync(BG_PID, 'utf8') : 0)
  let cmd = ''
  try {
    if (pid) cmd = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  } catch {}
  // Only that Chrome of this profile: a pid can be another process's by now.
  if (!cmd.includes(`--user-data-dir=${BG_PROFILE}`)) {
    fs.rmSync(BG_PID, { force: true })
    pid = profileChrome()
    if (!pid) return null
    fs.writeFileSync(BG_PID, String(pid))
  }
  const child = Object.assign(new EventEmitter(), { pid, kill: (sig) => process.kill(pid, sig) })
  const watch = setInterval(() => {
    try {
      process.kill(pid, 0)
    } catch {
      clearInterval(watch)
      child.emit('exit', null)
    }
  }, 2000)
  watch.unref()
  log('info', 'background', `앞선 에이전트의 헤드리스 브라우저를 이어받음 (pid ${pid})`)
  return child
}
function startBackground() {
  if (bg.child || !config.background || doctorOnly || serviceCmd || linkOnly || awakeCmd) return
  if (!CHROME_BIN) return void (bg.error = 'Chrome 이 없습니다. https://www.google.com/chrome 에서 설치해 주세요')
  const kept = bg.login ? null : adoptBackground()
  if (kept) return watchBackground(kept)
  // The key goes on the command line only while the profile does not have it yet (first start, or a new sign-in).
  const withKey = bg.login || !fs.existsSync(path.join(BG_PROFILE, '.linked'))
  const fragment = `#port=${config.port}${withKey ? `&key=${encodeURIComponent(config.key)}` : ''}&bg=1`
  const target = `${bg.login ?? `${config.site}/bridge`}${fragment}`
  bg.login = null
  fs.mkdirSync(BG_PROFILE, { recursive: true, mode: 0o700 })
  const child = spawn(CHROME_BIN, [
    '--headless=new',
    `--user-data-dir=${BG_PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=LocalNetworkAccessChecks',
    // A headless Chrome cannot answer the keychain's prompt, and without the keychain it keeps no cookies, so the
    // sign-in would be gone after a restart. Cookies of this profile are kept under a fixed key instead: the
    // profile folder (0700) is then what holds the sign-in.
    '--use-mock-keychain',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--mute-audio',
    target,
  ], { stdio: 'ignore', detached: true })
  if (withKey) fs.writeFileSync(path.join(BG_PROFILE, '.linked'), String(Date.now()))
  if (child.pid) fs.writeFileSync(BG_PID, String(child.pid))
  log('info', 'background', `헤드리스 브라우저를 띄움 (pid ${child.pid})`)
  child.on('error', (e) => (bg.error = `Chrome 을 띄우지 못했습니다: ${e.message}`))
  watchBackground(child)
}
function watchBackground(child) {
  bg.child = child
  bg.startedAt = Date.now()
  bg.error = null
  child.on('exit', (code) => {
    if (bg.child !== child) return
    bg.child = null
    if (!config.background) return
    // Back after 5 s, then 10, 20, 40, 60 s at most: a Chrome that keeps dying must not spin.
    const wait = Math.min(60_000, 5_000 * 2 ** Math.min(bg.restarts, 4))
    bg.restarts++
    bg.error = `헤드리스 브라우저가 끝남 (코드 ${code}). ${Math.round(wait / 1000)}초 뒤 다시 띄웁니다`
    log('warn', 'background', bg.error)
    clearTimeout(bg.timer)
    bg.timer = setTimeout(startBackground, wait)
  })
}
function stopBackground() {
  clearTimeout(bg.timer)
  const child = bg.child
  bg.child = null
  fs.rmSync(BG_PID, { force: true })
  if (!child) return
  // Chrome itself is asked to quit (SIGTERM to its main process): it then writes its cookies, the sign-in among
  // them, before it goes. Only if it is still there 5 s later does its whole process group go.
  try {
    child.kill('SIGTERM')
  } catch {}
  const force = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }, 5000)
  force.unref()
  child.once('exit', () => clearTimeout(force))
  log('info', 'background', '헤드리스 브라우저를 닫음')
}
/** Linked through the background page, or still waiting for it (a sign-in that ran out shows here). */
function backgroundState() {
  const connected = !!client && clientBg
  const waiting = !!bg.child && !connected && bg.startedAt && Date.now() - bg.startedAt > 90_000
  return { on: !!config.background, running: !!bg.child, connected, chrome: !!CHROME_BIN, since: bg.startedAt, restarts: bg.restarts, error: bg.error ?? (waiting ? '헤드리스 브라우저가 90초 넘게 붙지 않았습니다. 로그인이 끝났을 수 있으니 기기 화면에서 "헤드리스 연동 모드" 를 껐다가 다시 켜 주세요' : null) }
}

// ---------- diagnosis and self-repair ----------
// Every minute the agent looks at each of its parts and repairs what it can by itself: a caffeinate that died,
// lid sleep that drifted from what was asked, a headless browser that died or stopped linking. What only a person
// can do (sign in again, install a tool) is reported with how. The site shows both (health.features, repairs).
const repairs = []
const HEAL_MS = 60_000
let bgRepairAt = 0
let restartWanted = false
function repaired(id, text, ok = true) {
  repairs.unshift({ at: Date.now(), id, text, ok })
  repairs.splice(30)
  log(ok ? 'info' : 'warn', 'heal', text)
}
/** pmset's SleepDisabled as it is now: true, false, or null when it cannot be read. */
async function sleepDisabledNow() {
  if (process.platform !== 'darwin') return null
  const m = /SleepDisabled\s+(\d)/.exec((await run('/usr/bin/pmset', ['-g'])).out)
  return m ? m[1] === '1' : null
}
async function heal() {
  if (doctorOnly || serviceCmd || linkOnly || awakeCmd) return
  if (config.keepAwake && !keepAwake && process.platform === 'darwin') {
    await applyAwake()
    repaired('awake', keepAwake ? '잠자기 막기(caffeinate)가 꺼져 있어 다시 띄움' : '잠자기 막기(caffeinate)를 다시 띄우지 못함', !!keepAwake)
  }
  if (config.keepLidAwake || lidActive) {
    const now = await sleepDisabledNow()
    if (now !== null && now !== !!config.keepLidAwake && (await lidReady())) {
      lidActive = !config.keepLidAwake
      await applyAwake()
      repaired('lid', `덮개 잠자기 설정이 바뀌어 있어(SleepDisabled ${now ? 1 : 0}) 다시 적용함`, lidActive === !!config.keepLidAwake)
    }
  }
  if (config.background && CHROME_BIN && !(client && clientBg)) {
    const since = bg.startedAt ?? 0
    if (!bg.child && Date.now() - since > 90_000) {
      startBackground()
      repaired('background', '헤드리스 브라우저가 떠 있지 않아 다시 띄움', !!bg.child)
    } else if (bg.child && Date.now() - since > 120_000 && Date.now() - bgRepairAt > 600_000) {
      // Up but not linking for two minutes: once in ten minutes, it is started again from scratch.
      bgRepairAt = Date.now()
      stopBackground()
      setTimeout(startBackground, 2000)
      repaired('background', '헤드리스 브라우저가 2분 넘게 연동하지 않아 다시 띄움')
    }
  }
}
if (!doctorOnly && !serviceCmd && !linkOnly && !awakeCmd) setInterval(() => heal().catch((e) => log('error', 'heal', e.message)), HEAL_MS).unref()

/**
 * Each part of the agent, where it stands, and what fixes it. state: ok | warn | fail | off.
 * action: what the site's "지금 복구" button runs (command heal), when there is one.
 */
async function features() {
  const out = []
  const add = (id, title, state, detail, extra = {}) => out.push({ id, title, state, detail, ...extra })
  add('link', '연동', client ? 'ok' : 'fail', client ? (clientBg ? '헤드리스 브라우저가 연동 중' : '브라우저 탭이 연동 중') : '연동 페이지가 붙어 있지 않음', client ? {} : { fix: '이 맥의 Chrome 에서 사이트를 열거나 헤드리스 연동 모드를 켜세요' })
  const b = backgroundState()
  add('background', '헤드리스 연동 모드', !b.on ? 'off' : !b.chrome ? 'fail' : b.connected ? 'ok' : b.error ? 'fail' : 'warn', !b.on ? '꺼짐' : !b.chrome ? 'Chrome 이 없음' : b.connected ? `연동 중 · 다시 띄운 횟수 ${b.restarts}` : (b.error ?? '띄우는 중이거나 연결을 기다리는 중'), { ...(b.on ? { action: 'background-restart' } : {}), ...(!b.chrome ? { fix: 'Chrome 을 설치하세요: https://www.google.com/chrome' } : b.on && !b.connected ? { fix: '기기 화면에서 헤드리스 연동 모드를 껐다가 다시 켜세요(다시 로그인)' } : {}) })
  if (process.platform === 'darwin') {
    add('awake', '잠자기 막기', !config.keepAwake ? 'off' : keepAwake ? 'ok' : 'fail', !config.keepAwake ? '꺼짐 (쓰지 않으면 잠들 수 있음)' : keepAwake ? `caffeinate 실행 중 (pid ${keepAwake.pid})` : 'caffeinate 가 떠 있지 않음', config.keepAwake ? { action: 'awake-apply' } : {})
    const ready = await lidReady()
    const now = await sleepDisabledNow()
    if (config.kind === 'macbook' || config.keepLidAwake) {
      const st = !config.keepLidAwake ? 'off' : !ready ? 'fail' : now === true ? 'ok' : 'warn'
      add('lid', '덮개를 닫아도 켜 두기', st, !config.keepLidAwake ? `꺼짐${now ? ' (그런데 pmset SleepDisabled 가 1 임)' : ''}` : !ready ? '설정이 필요함' : now ? `pmset SleepDisabled 1 · ${lidClosed ? '덮개 닫힘 — 화면 끔' : '덮개 열림'}` : `pmset SleepDisabled ${now === false ? 0 : '?'} (다시 적용 필요)`, { ...(config.keepLidAwake ? { action: 'awake-apply' } : {}), ...(!ready && config.keepLidAwake ? { fix: 'node ~/.claude-bridge/agent.mjs awake setup' } : {}) })
    }
  }
  const offChrome = [...sessions.values()].filter((x) => x.chrome === false).length
  add('chrome', 'Claude in Chrome', config.chrome === false ? 'off' : 'ok', config.chrome === false ? '꺼짐 (새 세션을 --chrome 없이 띄움)' : `새 세션을 --chrome 으로 띄움${offChrome ? ` · 이 세션만 끈 것 ${offChrome}개` : ''}`, config.chrome === false ? { fix: '에이전트를 --chrome 으로 한 번 띄우면 켜져요(agent.json 의 chrome)' } : {})
  const list = [...sessions.values()]
  const alive = list.filter((x) => x.alive).length
  const deaf = list.filter((x) => x.alive && !x.hooks && !x.starting && Date.now() - (x.launchedAt ?? 0) > 120_000).length
  add('sessions', '세션', deaf ? 'warn' : 'ok', `살아 있음 ${alive} · 멈춤 ${list.length - alive}${deaf ? ` · 훅이 오지 않는 세션 ${deaf}` : ''}`, deaf ? { fix: '그 세션의 메뉴에서 새로고침하세요(훅 설정을 다시 읽음)' } : {})
  const bad = checks.filter((c) => c.level !== 'ok')
  add('checks', '도구·환경 점검', bad.some((c) => c.level === 'fail') ? 'fail' : bad.length ? 'warn' : 'ok', bad.length ? bad.map((c) => `${c.title}: ${c.detail}`).join(' / ') : `모두 정상 (${checks.length}개)`, { action: 'check', ...(bad.find((c) => c.fix) ? { fix: bad.find((c) => c.fix).fix } : {}) })
  add('update', '자동 업데이트', noAutoUpdate ? 'off' : pendingUpdate ? 'warn' : 'ok', noAutoUpdate ? '꺼짐 (--no-auto-update)' : pendingUpdate ? `새 버전 ${pendingUpdate.build ?? ''} 을 받음 · 곧 바꿈` : `build ${BUILD}`)
  // The key that opens this agent to the site's pages: when it was made, and a button to change it (R1-M8).
  add('key', '에이전트 키', (config.keyGen ?? 1) < KEY_GEN ? 'warn' : 'ok', (config.keyGen ?? 1) < KEY_GEN ? '1.140 이전에 만든 키 · 연동 탭이 이어지면 한 번 바꿔요' : `${config.keyAt ? `${new Date(config.keyAt).toLocaleDateString('sv-SE')} 에 바꿈` : '새 키'}${config.oldKey && Date.now() < config.oldKey.until ? ' · 이전 키는 곧 끝남' : ''}`, { action: 'rekey' })
  add('agent', '에이전트', 'ok', `${asService ? '백그라운드 서비스' : '터미널에서 실행'} · 켜진 지 ${Math.round((Date.now() - STARTED) / 60_000)}분 · 메모리 ${Math.round(process.memoryUsage().rss / 1e6)}MB${restartWanted ? ' · 세션이 쉬면 다시 시작함' : ''}`, asService ? { action: 'restart' } : {})
  return out
}

// ---------- self-update ----------

let pendingUpdate = null
/** The last update refusal logged, so the same one is not logged on every reconnect. */
let lastRefusal = null
/** Nothing in flight that lives only in this process: a turn, a held message, an open card, an unverified send. */
const atRest = () => [...sessions.values()].every((s) => !s.turn && !s.held?.length && !s.card?.open && !s.check && !s.starting)
/**
 * Whether the agent itself is in the middle of something that takes a few seconds and cannot be picked up again
 * by a new process: checking that a message started a turn, starting or reopening a session, a light copy. A turn
 * that is going on, an open card or held messages are not in the way (they are handed over, see handoff).
 * Waiting for every session to rest meant waiting forever: there is nearly always one at work, and a session
 * stuck on a dialog the old agent could not read kept the very fix for it from arriving.
 */
/** whisper.cpp kept up between recordings (voice.mjs); stopped with the agent. */
let whisper = null
const whisperDir = () => path.join(STATE_DIR, 'whisper')
process.on('exit', () => whisper?.stop())
const midAction = () => [...sessions.values()].some((s) => s.check || s.starting || s.refreshing || s.lightforking)
/** How long an update or a restart waits for those few-second actions before going anyway. */
const RESTART_WAIT_MS = 60_000

/**
 * Run with node --experimental-vm-modules --input-type=module -e LINK_CHECK <entry>: links <entry> and every file
 * it imports without running any of them, so a missing file or a missing named export fails here instead of at
 * the next start. A node without vm.SourceTextModule skips the check rather than refuse every update.
 */
const LINK_CHECK = `
import vm from 'node:vm'
import fs from 'node:fs'
import path from 'node:path'
if (vm.SourceTextModule) {
  const mods = new Map()
  const local = (file) => mods.get(file) ?? mods.set(file, new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), { identifier: file })).get(file)
  const linker = async (spec, from) => {
    if (!spec.startsWith('.')) {
      if (!mods.has(spec)) {
        const ns = await import(spec)
        const names = Object.keys(ns)
        mods.set(spec, new vm.SyntheticModule(names, function () { for (const n of names) this.setExport(n, ns[n]) }, { identifier: spec }))
      }
      return mods.get(spec)
    }
    const file = path.resolve(path.dirname(from.identifier), spec)
    if (!fs.existsSync(file)) throw new Error(path.basename(from.identifier) + ' 이 가져오는 ' + spec + ' 이 업데이트에 없음')
    return local(file)
  }
  await local(path.resolve(process.argv[1])).link(linker)
}
`

/**
 * Replace this agent's files and start again. Sessions run in tmux and are not touched; what would be lost is
 * only what this process remembers about a turn in progress, which is why it waits for a quiet moment.
 */
async function applyUpdate() {
  const { build, files, seq } = pendingUpdate
  pendingUpdate = null
  config.updateTried = { build, at: Date.now() }
  writeJson(configPath, config)
  const tmp = fs.mkdtempSync(path.join(STATE_DIR, '.update-'))
  try {
    for (const [name, text] of Object.entries(files)) {
      fs.writeFileSync(path.join(tmp, name), text)
      // A file that does not even parse must never replace one that runs.
      execFileSync(process.execPath, ['--check', path.join(tmp, name)], { stdio: 'pipe' })
    }
    // Nor one that parses but cannot start: an import of a file the update left out killed the agent for good
    // (launchd runs agent.mjs itself, so nothing of ours runs to roll it back).
    execFileSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '--input-type=module', '-e', LINK_CHECK, path.join(tmp, 'agent.mjs')], { stdio: 'pipe', timeout: 20_000 })
    for (const name of Object.keys(files)) fs.renameSync(path.join(tmp, name), path.join(AGENT_DIR, name))
    if (Number.isSafeInteger(seq)) config.updateSeq = seq
    writeJson(configPath, config)
  } catch (e) {
    log('error', 'update', `업데이트를 적용하지 못함 (지금 버전으로 계속): ${String(e.stderr || e.message).slice(0, 300)}`)
    return
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  log('info', 'update', `build ${BUILD} → ${build} 로 바꿈. 다시 시작합니다`)
  saveSessions()
  writeHandoff()
  keepBrowser = true
  flushLogs()
  await sleep(700)
  // The service is brought back by launchd. In a terminal the agent starts its own successor, once the port is free.
  if (asService) process.exit(0)
  client?.end()
  server.closeAllConnections?.()
  server.close(() => {
    spawn(process.execPath, [SELF, config.site, '--no-open', ...(config.keepAwake ? ['--keep-awake'] : [])], { stdio: 'inherit', detached: true }).unref()
    process.exit(0)
  })
}

// ---------- conversations on this Mac ----------

/** Where a conversation ran, what it is called and how it started and ended, from the first and last 64 KB. */
function conversationInfo(file, size) {
  const read = (from, len) => {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(Math.min(len, size))
      const n = fs.readSync(fd, buf, 0, buf.length, from)
      return buf.subarray(0, n).toString('utf8').split('\n')
    } finally {
      fs.closeSync(fd)
    }
  }
  const parse = (l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  }
  const said = (o) => {
    if (o?.type !== 'user' || o.isMeta || o.isSidechain || o.isCompactSummary) return ''
    const c = o.message?.content
    const t = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((x) => x.type === 'text')?.text ?? '') : ''
    return /^\s*</.test(t) || /^Caveat: /.test(t) ? '' : t.replace(/\s+/g, ' ').trim().slice(0, 160)
  }
  const head = read(0, 65536).map(parse).filter(Boolean)
  const end = (size > 65536 ? read(size - 65536, 65536).slice(1) : []).map(parse).filter(Boolean)
  const all = [...head, ...end]
  const named = all.filter((o) => (o.type === 'custom-title' && o.customTitle) || (o.type === 'ai-title' && o.aiTitle)).at(-1)
  return {
    cwd: all.find((o) => typeof o.cwd === 'string')?.cwd ?? '',
    title: String(named?.customTitle ?? named?.aiTitle ?? '').slice(0, 80),
    first: head.map(said).find(Boolean) ?? '',
    last: [...all].reverse().map(said).find(Boolean) ?? '',
  }
}

// ---------- after a restart of the Mac ----------

/**
 * When each session was last seen running is written down every minute; one that ended is crossed out at once.
 * So after the Mac restarts, a session whose terminal is gone but was running until shortly before is one the
 * restart took: it is opened again on the same conversation. One that a person ended is left alone.
 */
const REVIVE_WITHIN = 12 * 3_600_000
const REVIVE_MAX = 5
setInterval(async () => {
  let changed = false
  for (const s of sessions.values()) {
    if (s.reviving || s.refreshing || s.starting) continue
    if (await alive(s)) {
      if (Date.now() - (s.aliveAt ?? 0) > 50_000) (s.aliveAt = Date.now()), (changed = true)
    } else if (s.aliveAt) (delete s.aliveAt), (changed = true)
  }
  if (changed) saveSessions()
}, 60_000).unref()

async function reviveAfterRestart() {
  const due = []
  for (const [sid, s] of sessions) if (s.aliveAt && Date.now() - s.aliveAt < REVIVE_WITHIN && !(await alive(s))) due.push([sid, s])
  due.sort((a, b) => b[1].aliveAt - a[1].aliveAt)
  for (const [sid, s] of due.slice(REVIVE_MAX)) {
    delete s.aliveAt
    log('warn', 'revive', `다시 켜진 뒤 되살릴 세션이 ${REVIVE_MAX}개를 넘어 이 세션은 그대로 둠 (글을 보내면 다시 열림)`, sid)
  }
  for (const [sid, s] of due.slice(0, REVIVE_MAX)) {
    s.reviving = true
    log('info', 'revive', `맥이 다시 켜진 것 같아 같은 대화로 다시 엶 (마지막으로 살아 있던 때: ${new Date(s.aliveAt).toLocaleString('ko-KR')})`, sid)
    try {
      await refresh(sid, s)
      // Said in the conversation now if the page is linked, else as soon as it is (welcome).
      if (await alive(s)) client && welcomed ? note(sid, '🔁 맥이 다시 켜져서 세션을 같은 대화로 다시 열었어요.') : (s.revived = true)
    } finally {
      s.reviving = false
    }
  }
  if (due.length) saveSessions()
}

// ---------- the web servers a session started ----------
//
// A session that runs a dev server (npm run dev, python -m http.server) gets a computer button on its page: the
// page opens http://localhost:<port> itself on this Mac, or through the site (the `http` command) anywhere else.
// A server is the session's when its process descends from the session's terminal; failing that, when it runs in the
// session's folder or in a folder inside it of the same git repository (the closest session folder wins).

const SERVERS_MS = 10_000
/** The largest answer the `http` command carries back (it goes as base64 through the bridge tab). */
const HTTP_MAX = 16 * 1024 * 1024
let serversAt = 0
let scanning = false
/** `${pid}:${port}` -> { http, title, at }: whether a listener answers HTTP, asked once a minute. */
const probed = new Map()

/** A local preview's WebSockets to localhost: id -> { ws, next, waiting }. */
const wsConns = new Map()

function wsStep(id, c, m) {
  const say = (msg) => emit({ t: 'ws', id, ...msg })
  if (m.op === 'open') {
    const server = [...sessions.values()].flatMap((s) => s.servers ?? []).find((x) => x.port === Number(m.port))
    if (!server) return wsConns.delete(id), say({ op: 'error', error: `이 맥에 세션이 띄운 ${m.port} 포트 서버가 없어요` })
    if (typeof WebSocket !== 'function') return wsConns.delete(id), say({ op: 'error', error: '이 맥의 Node 에 WebSocket 이 없어요(22 이상)' })
    let ws
    try {
      ws = c.ws = new WebSocket(`ws://${server.host}:${server.port}${String(m.path).startsWith('/') ? m.path : '/'}`, (m.protocols ?? []).map(String))
    } catch (e) {
      return wsConns.delete(id), say({ op: 'error', error: e.message })
    }
    ws.binaryType = 'arraybuffer'
    let opened = false
    ws.onopen = () => ((opened = true), say({ op: 'open', protocol: ws.protocol }))
    ws.onmessage = (e) => (typeof e.data === 'string' ? say({ op: 'msg', data: e.data }) : say({ op: 'msg', binary: true, data: Buffer.from(e.data).toString('base64') }))
    ws.onclose = (e) => wsConns.get(id) === c && (wsConns.delete(id), say(opened ? { op: 'close', code: e.code, reason: e.reason } : { op: 'error', error: `localhost:${server.port} 가 웹소켓을 받지 않아요` }))
    ws.onerror = () => {}
    return
  }
  if (m.op === 'send' && c.ws?.readyState === 1) return void c.ws.send(m.binary ? Buffer.from(String(m.data), 'base64') : String(m.data))
  if (m.op === 'close') {
    wsConns.delete(id)
    const code = Number(m.code)
    try {
      c.ws?.close(code === 1000 || (code >= 3000 && code < 5000) ? code : 1000)
    } catch {}
  }
}

async function probe(host, port) {
  try {
    const r = await fetch(`http://${host}:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(1500) })
    let title = ''
    if (/html/i.test(r.headers.get('content-type') ?? '')) title = /<title[^>]*>([^<]{1,120})/i.exec((await r.text()).slice(0, 65_536))?.[1]?.trim() ?? ''
    else r.body?.cancel().catch(() => {})
    return { http: true, title }
  } catch {
    return { http: false, title: '' }
  }
}

async function scanServers() {
  if (scanning || ![...sessions.values()].some((s) => s.alive !== false)) return
  scanning = true
  try {
    // Listening sockets that a browser on this Mac reaches as localhost: loopback or every address.
    const ls = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { timeout: 10_000 })
    const byPort = new Map()
    let pid = 0
    for (const line of ls.out.split('\n')) {
      if (line[0] === 'p') pid = Number(line.slice(1))
      const m = line[0] === 'n' && /^(.*):(\d+)$/.exec(line.slice(1))
      if (!m || !['*', '127.0.0.1', '[::1]', '0.0.0.0', '[::]'].includes(m[1])) continue
      const port = Number(m[2])
      if (pid === process.pid || port === config.port) continue
      const prev = byPort.get(port)
      // Asked for by number: 127.0.0.1 when the server listens there at all, [::1] only when that is all it has.
      if (!prev || (prev.host === '[::1]' && m[1] !== '[::1]')) byPort.set(port, { pid, port, host: m[1] === '[::1]' ? '[::1]' : '127.0.0.1' })
    }
    const found = [...byPort.values()]
    const ps = await run('ps', ['-A', '-o', 'pid=,ppid='])
    const parent = new Map(ps.out.split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter((r) => r.length === 2))
    const pids = [...new Set(found.map((f) => f.pid))]
    const cwds = new Map()
    if (pids.length) {
      const c = await run('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'], { timeout: 10_000 })
      let p = 0
      for (const line of c.out.split('\n')) line[0] === 'p' ? (p = Number(line.slice(1))) : line[0] === 'n' && cwds.set(p, line.slice(1))
    }
    // Whose terminal each server descends from: that session's alone, whatever its folder says.
    const live = [...sessions].filter(([, s]) => s.alive !== false)
    const panes = new Map()
    for (const [sid, s] of live) panes.set(Number((await tmux('display-message', '-p', '-t', pane(s), '#{pane_pid}')).out) || 0, sid)
    const owner = new Map()
    for (const f of found) {
      for (let p = f.pid, n = 0; p > 1 && n < 64 && !owner.has(f); p = parent.get(p) ?? 0, n++) if (panes.has(p)) owner.set(f, panes.get(p))
    }
    // The rest by folder: the session's folder itself, or a folder inside it in the same git repository. A session in a
    // folder of projects (~/projects) does not get every project's server; the closest session folder wins.
    const top = new Map()
    const gitTop = async (dir) => {
      if (!top.has(dir)) top.set(dir, (await git(dir, 'rev-parse', '--show-toplevel')).out || null)
      return top.get(dir)
    }
    for (const f of found) {
      const cwd = cwds.get(f.pid)
      if (owner.has(f) || !cwd) continue
      let best = null
      for (const [sid, s] of live) {
        // Home or / says nothing: every server is in there.
        const folder = s.cwd && s.cwd !== HOME && s.cwd !== '/' ? path.resolve(s.cwd) : null
        if (!folder || !(cwd === folder || cwd.startsWith(`${folder}/`))) continue
        if (cwd !== folder && (!(await gitTop(cwd)) || (await gitTop(cwd)) !== (await gitTop(folder)))) continue
        if (!best || folder.length > best.len) best = { sid, len: folder.length }
      }
      if (best) owner.set(f, best.sid)
    }
    // Asked only of servers a session started: every other program listening on this Mac is left alone (R1-I5).
    for (const f of found.filter((x) => owner.has(x))) {
      const k = `${f.pid}:${f.port}`
      if (!probed.has(k) || Date.now() - probed.get(k).at > 60_000) probed.set(k, { ...(await probe(f.host, f.port)), at: Date.now() })
    }
    for (const k of probed.keys()) if (!found.some((f) => owner.has(f) && `${f.pid}:${f.port}` === k)) probed.delete(k)
    for (const [sid, s] of live) {
      const mine = found.filter((f) => owner.get(f) === sid && probed.get(`${f.pid}:${f.port}`)?.http)
      const servers = mine.sort((a, b) => a.port - b.port).map((f) => ({ port: f.port, host: f.host, pid: f.pid, title: probed.get(`${f.pid}:${f.port}`).title }))
      if (JSON.stringify(servers) !== JSON.stringify(s.servers ?? [])) (s.servers = servers), publish(sid, s)
    }
  } finally {
    scanning = false
  }
}

// ---------- loops ----------

let ticking = false
setInterval(async () => {
  if (ticking || !client || !welcomed) return
  ticking = true
  try {
    if (pendingUpdate && (!midAction() || Date.now() - pendingUpdate.at > RESTART_WAIT_MS)) return await applyUpdate()
    if (restartWanted && (!midAction() || Date.now() - restartWanted > RESTART_WAIT_MS)) {
      log('info', 'agent', '사이트의 요청으로 다시 시작합니다 (launchd 가 다시 띄움)')
      saveSessions()
      writeHandoff()
      keepBrowser = true
      releaseLid()
      return setTimeout(() => process.exit(0), 300)
    }
    stats.lastTail = Date.now()
    // Not waited for: lsof can take a second, and the conversations must not.
    if (Date.now() - serversAt >= SERVERS_MS) (serversAt = Date.now()), scanServers().catch((e) => log('warn', 'servers', e.message))
    for (const [sid, s] of sessions) {
      tail(sid, s)
      if (Date.now() - (s.statusAt ?? 0) >= STATUS_MS) {
        s.statusAt = Date.now()
        await watch(sid, s)
      }
      await readPreview(sid, s)
      if (s.alive && Date.now() - (s.folderAt ?? 0) >= FOLDER_MS) await syncFolder(sid, s)
    }
  } catch (e) {
    log('error', 'tick', e.stack || e.message)
  } finally {
    ticking = false
  }
}, TAIL_MS)

// ---------- http (loopback only) ----------

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin
  // Only the configured site's pages may talk to this agent.
  if (origin && origin !== SITE_ORIGIN) return res.writeHead(403).end()
  const cors = {
    'Access-Control-Allow-Origin': SITE_ORIGIN,
    'Access-Control-Allow-Headers': 'content-type, x-bridge-key',
    'Access-Control-Allow-Private-Network': 'true',
    Vary: 'Origin',
  }
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end()
  const url = new URL(req.url, 'http://127.0.0.1')
  const key = req.headers['x-bridge-key'] || url.searchParams.get('key') || ''
  // Compared as bytes: a key of the right length in characters but not in bytes must not throw (and end the agent).
  const given = Buffer.from(String(key))
  const same = (k) => {
    const mine = Buffer.from(k)
    return given.length === mine.length && crypto.timingSafeEqual(given, mine)
  }
  // A hook may also come with the agent's key: a session started before the hook key keeps sending that until it ends.
  const hookPath = req.method === 'POST' && (url.pathname === '/hook' || url.pathname === '/statusline' || url.pathname === '/delegate' || url.pathname === '/askpass')
  const keyOk = same(config.key) || (config.oldKey && Date.now() < config.oldKey.until && same(config.oldKey.key)) || (hookPath && same(config.hookKey))
  // Lets a second agent started on the same port recognise this one. Says nothing else.
  if (req.method === 'GET' && url.pathname === '/ping') return res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end('{"agent":"claude-bridge"}')
  if (!keyOk) {
    if (key && (config.retiredKeys ?? []).includes(keyPrint(key))) reopenLink(req.headers['user-agent'])
    return res.writeHead(401, cors).end()
  }
  // Which host this is, for a page of the site on this Mac: it opens a session's localhost server directly.
  if (req.method === 'GET' && url.pathname === '/host') return res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ hostId: config.hostId }))

  // Claude Code's hooks, from this Mac only (with the hook key, read by curl from a file).
  if (req.method === 'POST' && url.pathname === '/hook') {
    const chunks = []
    for await (const c of req) chunks.push(c)
    let ev = null
    try {
      ev = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {}
    const sid = url.searchParams.get('sid') || ''
    // Answered before the hook is handled: Claude Code waits on this answer to run the tool.
    let answer = null
    try {
      if (ev?.hook_event_name === 'PreToolUse') answer = await langGuard(sid, ev)
      else if (ev?.hook_event_name === 'PermissionRequest') answer = autoAllowAnswer(sid, ev)
    } catch (e) {
      log('warn', 'lang', e.message, sid)
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer ?? {}))
    try {
      if (!ev) throw new Error('JSON 이 아님')
      await onHook(sid, ev)
    } catch (e) {
      log('warn', 'hook', `훅을 처리하지 못함: ${e.message}`)
    }
    return
  }
  // A video for a message, from the bridge tab (REQ-F-761): saved with the pictures, where a session may read.
  if (req.method === 'POST' && url.pathname === '/file') {
    const id = url.searchParams.get('id') || ''
    if (!/^[0-9a-f]{40}\.(mp4|mov|webm|m4v)$/.test(id)) return void res.writeHead(400, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: '영상 id 가 올바르지 않아요' }))
    const name = String(url.searchParams.get('name') || 'video').replace(/[^\w.가-힣 -]/g, '_').slice(0, 120) || 'video'
    const dir = path.join(STATE_DIR, 'images')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const ext = id.split('.').pop()
    const file = path.join(dir, `${id.slice(0, 8)}-${name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`}`)
    const out = fs.createWriteStream(file, { mode: 0o600 })
    let size = 0
    try {
      for await (const c of req) {
        size += c.length
        if (size > 600 * 1024 * 1024) throw new Error('영상이 너무 커요')
        if (!out.write(c)) await new Promise((r) => out.once('drain', r))
      }
      await new Promise((ok, bad) => out.end((e) => (e ? bad(e) : ok())))
    } catch (e) {
      out.destroy()
      fs.rmSync(file, { force: true })
      return void res.writeHead(413, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: e.message }))
    }
    log('info', 'send', `영상 받음 (${Math.round(size / 1024)} KB)`, url.searchParams.get('sid') || undefined)
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, path: file }))
    return
  }
  // sudo in a session, through its helper (agent/guard.mjs askpassScript): the password, once the server says this
  // session may have it (REQ-F-764). Nothing printed, and sudo fails as it would without a terminal, otherwise.
  if (req.method === 'POST' && url.pathname === '/askpass') {
    for await (const _ of req);
    const sid = url.searchParams.get('sid') || ''
    const s = sessions.get(sid)
    if (!s) return void res.writeHead(403).end()
    const what = s.lastTool?.name === 'Bash' ? String(s.lastTool.input?.command ?? '') : ''
    const a = await sudoAsk(sid, what || 'sudo')
    if (!a.ok || !sudoPass) {
      note(sid, `🔐 sudo 에 비밀번호를 넘기지 않았어요: ${a.error ?? '관리자 권한이 닫혔어요'}`, 'warn')
      return void res.writeHead(403).end()
    }
    log('info', 'sudo', '세션의 sudo 에 관리자 비밀번호를 넘김', sid)
    return void res.writeHead(200, { 'Content-Type': 'text/plain' }).end(sudoPass.pw)
  }
  // The bridge MCP server of a session asks here (REQ-F-760); the server does the work and answers 'delegated'.
  if (req.method === 'POST' && url.pathname === '/delegate') {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const sid = url.searchParams.get('sid') || ''
    let b = null
    try {
      b = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {}
    const answer = !sessions.has(sid) ? { ok: false, error: '이 세션을 에이전트가 모릅니다' } : !b || typeof b.op !== 'string' ? { ok: false, error: '요청이 올바르지 않아요' } : await delegate(sid, b.op, b.args)
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer))
    return
  }
  if (req.method === 'POST' && url.pathname === '/statusline') {
    const chunks = []
    for await (const c of req) chunks.push(c)
    let line = 'claude'
    try {
      const d = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const sid = url.searchParams.get('sid') || ''
      const s = sessions.get(sid)
      const pct = (v) => (typeof v === 'number' ? Math.round(v) : null)
      const usage = { context: pct(d.context_window?.used_percentage), window: Number(d.context_window?.context_window_size) || null, fiveHour: pct(d.rate_limits?.five_hour?.used_percentage), week: pct(d.rate_limits?.seven_day?.used_percentage), fiveHourResetsAt: Number(d.rate_limits?.five_hour?.resets_at) * 1000 || null, weekResetsAt: Number(d.rate_limits?.seven_day?.resets_at) * 1000 || null, cost: typeof d.cost?.total_cost_usd === 'number' ? Math.round(d.cost.total_cost_usd * 100) / 100 : null }
      if (s) {
        s.usage = usage
        if (d.effort?.level) s.effort = String(d.effort.level)
        if (usage.context != null) s.context = `${usage.context}%`
        publish(sid, s)
      }
      line = [d.model?.display_name, usage.cost != null ? `$${usage.cost}` : null, usage.context != null ? `ctx ${usage.context}%` : null].filter(Boolean).join(' · ') || 'claude'
    } catch {}
    return res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(line)
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    // One tab at a time. A tab the agent just opened (takeover) wins; any other tab is turned away while the
    // current one is alive, so a forgotten tab's automatic reconnect cannot pull the agent away from it.
    const tab = url.searchParams.get('tab') || ''
    const isBg = url.searchParams.get('bg') === '1'
    const alive = client && Date.now() - clientSeen < 45_000
    // While 헤드리스 연동 모드 is on, the headless browser's tab holds the link: a visible tab, even one the
    // agent opened, waits behind it (else the two would take the link from each other in turn).
    // `headless` tells the page the link is in good hands, so it says nothing instead of a warning.
    if (alive && clientTab !== tab && clientBg && !isBg && config.background) return res.end('data: {"t":"busy","headless":true}\n\n')
    if (alive && clientTab !== tab && !isBg && url.searchParams.get('takeover') !== '1') return res.end(`data: ${JSON.stringify({ t: 'busy', ...(clientBg ? { headless: true } : {}) })}\n\n`)
    client?.end('data: {"t":"replaced"}\n\n')
    client = res
    clientTab = tab
    clientBg = isBg
    clientRekey = url.searchParams.get('rekey') === '1'
    clientOldKey = !same(config.key)
    // Asked again when the timer fires: two tabs linking within those 3 s would otherwise change the key twice, and
    // the second change drops the first key at once instead of letting it work OLD_KEY_MS longer.
    if ((config.keyGen ?? 1) < KEY_GEN && clientRekey) setTimeout(() => (config.keyGen ?? 1) < KEY_GEN && rotateKey('1.140 이전에 만든 키라 한 번 바꿈'), 3000).unref?.()
    // The headless browser keeps the page it opened, so its relay can be older than the site's and never offer to
    // take a new key. Started again (once per agent build) it loads the current page, and the key changes then.
    else if ((config.keyGen ?? 1) < KEY_GEN && isBg && config.background && config.bgRelayRestart !== BUILD) {
      config.bgRelayRestart = BUILD
      writeJson(configPath, config)
      log('info', 'link', '헤드리스 연동 페이지가 옛 버전이라 다시 띄움 (에이전트 키를 바꾸려고)')
      setTimeout(() => {
        bg.restarts = 0
        stopBackground()
        setTimeout(startBackground, 2000)
      }, 3000).unref?.()
    }
    clientSeen = Date.now()
    for (const s of sessions.values()) s.statusKey = null
    log('info', 'link', '연동 페이지 연결됨')
    Object.assign(stats, { pageConnectedAt: Date.now(), pageConnects: stats.pageConnects + 1 })
    // A named event the page can hear (a comment line is invisible to it): silence then means a stalled stream.
    const ping = setInterval(() => res.write('event: beat\ndata: 1\n\n'), 5_000)
    req.on('close', () => {
      clearInterval(ping)
      if (client === res) {
        client = null
        welcomed = false
        log('warn', 'link', '연동 페이지 끊김')
      }
    })
    return hello()
  }
  if (req.method === 'POST' && url.pathname === '/cmd') {
    const chunks = []
    let size = 0
    for await (const c of req) {
      size += c.length
      if (size > 256 * 1024 * 1024) return res.writeHead(413, cors).end()
      chunks.push(c)
    }
    let cmd
    try {
      cmd = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return res.writeHead(400, cors).end()
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end('{"ok":true}')
    if ((url.searchParams.get('tab') || clientTab) === clientTab) clientSeen = Date.now()
    const fn = commands[cmd.t]
    if (!fn) return
    const quiet = ['voice', 'welcome', 'rehello', 'screen', 'resync', 'ping', 'check', 'report', 'dirs', 'trashinfo', 'skills', 'readfile', 'http', 'ws', 'log', 'putimg', 'events', 'img', 'forget', 'export'].includes(cmd.t)
    if (cmd.t !== 'ping') ((stats.commands++), (stats.lastCommand = { t: cmd.t, sid: cmd.sid, ts: Date.now() }))
    if (!quiet) log('info', cmd.t, cmd.t === 'send' ? `글 ${String(cmd.text).length}자${cmd.files?.length ? ` + 그림 ${cmd.files.length}장` : ''}` : cmd.t === 'key' ? cmd.keys.join(' ') : cmd.t === 'answer' ? `${cmd.n}번` : cmd.cwd ? `폴더 ${String(cmd.cwd).length}자` : '요청 받음', cmd.sid)
    try {
      await fn(cmd)
    } catch (e) {
      log('error', cmd.t, `실패: ${e.stack || e.message}`, cmd.sid)
      emit({ t: 'error', sid: cmd.sid, reqId: cmd.reqId, message: e.message })
    }
    return
  }
  res.writeHead(404, cors).end()
})

if (doctorOnly) {
  await runChecks()
  printChecks()
  const bad = checks.filter((c) => c.level === 'fail')
  console.log(bad.length ? `\n해결할 것 ${bad.length}개. 고친 뒤 다시 실행해 보세요.` : '\n세션을 시작할 수 있는 상태입니다.')
  process.exit(bad.length ? 1 : 0)
}

if (serviceCmd === 'install') {
  if (process.platform !== 'darwin') {
    console.error('백그라운드 서비스 설치는 macOS 에서만 됩니다.')
    process.exit(1)
  }
  await runChecks()
  printChecks()
  // Whatever agent runs now (one left in a terminal, or an older service) gives way to the service.
  launchctl('bootout', `${DOMAIN}/${LABEL}`)
  const oldPid = Number(readJson(PID_FILE, 0))
  // A pid file can outlive its process and the number can be reused: only an agent is ever signalled.
  if (oldPid && oldPid !== process.pid && (await run('/bin/ps', ['-p', String(oldPid), '-o', 'command='])).out.includes('agent.mjs')) {
    try {
      process.kill(oldPid, 'SIGTERM')
    } catch {}
  }
  for (let i = 0; i < 20 && (await pingAgent()); i++) await sleep(250)
  const x = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // launchd starts programs with a bare PATH: the service gets the one this terminal has, where tmux, git and claude were found.
  const env = { PATH: process.env.PATH, HOME, LANG: process.env.LANG || 'en_US.UTF-8', ...(process.env.CLAUDE_BRIDGE_HOME ? { CLAUDE_BRIDGE_HOME: STATE_DIR } : {}), ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: CLAUDE_DIR } : {}), ...(process.env.CLAUDE_BRIDGE_LABEL ? { CLAUDE_BRIDGE_LABEL: LABEL } : {}) }
  // The `node` on PATH rather than the resolved binary: a Homebrew upgrade moves the latter to a new versioned folder.
  const found = (await run('/usr/bin/which', ['node'])).out
  const nodePath = found && fs.existsSync(found) ? found : process.execPath
  const logFile = path.join(STATE_DIR, 'service.log')
  fs.mkdirSync(path.dirname(PLIST), { recursive: true })
  fs.writeFileSync(
    PLIST,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${x(LABEL)}</string>
  <key>ProgramArguments</key><array><string>${x(nodePath)}</string><string>${x(SELF)}</string><string>--service</string></array>
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${x(k)}</key><string>${x(v)}</string>`).join('')}</dict>
  <key>WorkingDirectory</key><string>${x(HOME)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${x(logFile)}</string>
  <key>StandardErrorPath</key><string>${x(logFile)}</string>
</dict></plist>
`,
  )
  const boot = launchctl('bootstrap', DOMAIN, PLIST)
  if (!boot.ok && !serviceLoaded()) launchctl('load', '-w', PLIST)
  let up = false
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(250)
    // The service moves to the next port when this one is taken, and writes that down.
    config.port = readJson(configPath, config).port
    up = await pingAgent()
  }
  if (!up) {
    console.error(`\n서비스를 등록했지만 에이전트가 응답하지 않습니다. 로그를 확인해 주세요: ${logFile}\n  ${boot.ok ? '' : boot.out.trim()}`)
    process.exit(1)
  }
  console.log(`
백그라운드 서비스로 설치했습니다. 이 터미널은 닫아도 됩니다.
  · 맥에 로그인하면 에이전트가 자동으로 켜집니다. 화면에는 아무것도 뜨지 않습니다.
  · 에이전트는 혼자서는 바깥과 통신하지 않습니다. 이 맥의 브라우저에 연동 페이지를 열어 둔 동안만 사이트에 연결됩니다:
      ${config.site}/bridge
  · 상태: node ${SELF} service status     제거: node ${SELF} service uninstall
`)
  if (!noOpen) spawn('open', [bridgeLink()], { stdio: 'ignore', detached: true }).unref()
  process.exit(0)
}

let portTries = 0
server.on('error', async (e) => {
  if (e.code !== 'EADDRINUSE') {
    console.error(e.message)
    process.exit(1)
  }
  const ours = await fetch(`http://127.0.0.1:${config.port}/ping`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => null)
  if (ours?.agent === 'claude-bridge') {
    console.error(`이 맥에 에이전트가 이미 켜져 있습니다 (포트 ${config.port}). 백그라운드 서비스로 설치했다면 따로 켤 필요가 없습니다.\n  상태: node ${SELF} service status     링크 다시 열기: node ${SELF} link`)
    process.exit(1)
  }
  if (++portTries > 10) {
    console.error(`포트 ${config.port} 근처에 빈 포트가 없습니다. --port 로 직접 정해 주세요.`)
    process.exit(1)
  }
  console.log(`포트 ${config.port} 은 다른 프로그램이 쓰고 있어 ${config.port + 1} 로 바꿉니다.`)
  config.port++
  writeJson(configPath, config)
  server.listen(config.port, '127.0.0.1')
})
server.on('listening', async () => {
  const link = bridgeLink()
  fs.writeFileSync(PID_FILE, String(process.pid))
  console.log(`claude-bridge agent ${VERSION} — ${config.name} (${KINDS[config.kind]})`)
  log('info', 'agent', `시작: ${config.name} (${config.kind}), node ${process.version}, 포트 ${config.port}, build ${BUILD}`)
  // A new version may hook more events (PermissionRequest for 전부 허용): sessions already running read the file too.
  writeHookSettings()
  // In the background: the agent works without it, and new sessions start in tmux until it is there.
  ensureZeropty().catch((e) => log('warn', 'zeropty', e.message))
  await runChecks()
  printChecks()
  reviveAfterRestart().catch((e) => log('error', 'revive', e.message))
  // A browser left running for this agent while 헤드리스 연동 모드 was turned off in between: it goes.
  if (!config.background && !doctorOnly && !serviceCmd && !linkOnly && !awakeCmd && (bg.child = adoptBackground())) stopBackground()
  startBackground()
  // The link carries this agent's key. A terminal shows it to the person who ran the agent; the background
  // service writes to a log file, where a key has no business: there it says how to open the link instead.
  if (asService) console.log(`\n127.0.0.1:${config.port} 에서 듣는 중. 이 맥의 브라우저(Chrome)에 ${config.site}/bridge 를 열어 두세요.\n처음 연동하는 브라우저라면 터미널에서: node ${path.join(STATE_DIR, 'agent.mjs')} link\n`)
  else console.log(`\n127.0.0.1:${config.port} 에서 듣는 중. 이 맥의 브라우저(Chrome)에 아래 연동 페이지를 열어 두세요:\n\n  ${link}\n`)
  if (!noOpen && !asService && process.platform === 'darwin') {
    // The person's own default browser, where they are signed in to the site, unless that is Safari,
    // which may refuse the page's connection to 127.0.0.1: then Chrome, when it is installed.
    const handlers = await run('/usr/bin/defaults', ['read', 'com.apple.LaunchServices/com.apple.launchservices.secure', 'LSHandlers'])
    const https = /LSHandlerRoleAll = "([^"]+)";\s*LSHandlerURLScheme = https;/.exec(handlers.out)?.[1] ?? 'com.apple.safari'
    const chrome = checks.find((c) => c.id === 'browser')?.level === 'ok'
    spawn('open', /safari/i.test(https) && chrome ? ['-a', 'Google Chrome', link] : [link], { stdio: 'ignore', detached: true }).unref()
  }
  setTimeout(() => {
    if (!client && !asService) console.log('연동 페이지가 아직 연결되지 않았습니다. 위 링크를 Chrome 에서 열고, 사이트에 로그인돼 있는지, Chrome 이 "로컬 네트워크의 기기에 연결" 을 물으면 허용했는지 확인해 주세요.')
  }, 45_000)
})
server.listen(config.port, '127.0.0.1')
