// claude-bridge web server: GitHub login, host registry, relay between bridge pages and control pages,
// and the on-disk copy of every session (transcript + folder state). It never runs Claude itself.
// No dependencies; needs node >= 20.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { lineToEvents } from './events.mjs'
import { threadOf, toCsEvent, toCsSession, cardMessage } from './cs.mjs'
import { plugins } from './plugins.mjs'
import { modelsFromCatalog } from './models.mjs'
import { prSummary } from './prview.mjs'
import { appKey, codeHash, createSkills, RepoGone } from './skills.mjs'
import { createHandover } from './handover.mjs'
import { createPreview } from './preview.mjs'
import { clipClient, fixPrompt } from './report-prompt.mjs'
import { loadPins, claimLogin, heldBy } from './login-pin.mjs'
import { dropRoot, tightenTree } from './drop-root.mjs'
import { manifestSigned } from '../agent/guard.mjs'
import { cleanFolder, hidePaths, hideRemotes } from '../agent/scrub.mjs'
import { cleanStats, addStats, sessionStats } from '../agent/stats.mjs'
import { cleanFolderBase, defaultFolder, folderPart, FOLDER_BASE, FOLDER_NO_GROUP } from './folder.mjs'
import { createDemoMac, demoHostOf, demoPrefs, DEMO_LOGIN_NAME, DEMO_REFUSED, isDemoHost, isDemoUid, newDemoUid } from './demo.mjs'
import { APP_NAME, DEMO_BUTTON, FOOTER, pendingPage, SOURCE_URL, supportPage } from './pages.mjs'
import { AppleTokenError, appleClient, appleIds, appleKeys, isAppleLogin, sha256hex, verifyIdentityToken } from './apple.mjs'
import { APNS_DEVICES, APNS_ENVS, APNS_TOKEN, apnsClient, apnsPayload, deadToken, deviceOf, webTargets } from './apns.mjs'

const VERSION = '0.2.0'
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.PORT || 4300)
const DATA = path.resolve(process.env.BRIDGE_DATA || path.join(ROOT, 'data'))
/** Public origin of the site, e.g. https://bridge.example.com. Derived from the request when unset. */
const ORIGIN = (process.env.BRIDGE_ORIGIN || '').replace(/\/+$/, '')
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || ''
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || ''
// A public server (GitHub sign-in on) states its own origin: taken from Host and X-Forwarded-Proto, it decided the
// Origin check, the Secure cookie flag and the addresses it hands out (R1-L16). Without it the server does not start;
// a deploy then keeps the running one.
if (GITHUB_CLIENT_ID && !ORIGIN) {
  console.error('BRIDGE_ORIGIN 이 없습니다. GitHub 로그인을 쓰는 서버는 사이트 주소(예: https://bridge.example.com)를 BRIDGE_ORIGIN 으로 정해야 합니다.')
  process.exit(1)
}
/** Comma-separated GitHub logins that may use this server. `*` allows any GitHub account. Empty allows nobody. */
const ALLOWED = (process.env.GITHUB_ALLOWED_LOGINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
/** Local development only: lets /api/auth/dev?login=<name> sign in without GitHub. Never set this on a public server. */
const DEV_LOGIN = process.env.BRIDGE_DEV_LOGIN === '1'
/** GitHub logins that may see every user's hosts, their status and their logs (never conversations). */
const ADMINS = (process.env.BRIDGE_ADMIN_LOGINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
/**
 * /skills: a skill marketplace repo, read as a GitHub App installed on it (SKILLS_GITHUB_APP_ID + _KEY, nothing
 * expires) or with a read-only token. Each person sets their own repo in 설정 (REQ-F-792, prefs `skillsRepo`), one
 * they own; SKILLS_REPO is the default for everyone who set none. With no repo or no credentials the page says it is
 * off, and nothing is logged.
 */
const SKILLS_REPO_ENV = (process.env.SKILLS_REPO || '').trim()
const SKILLS_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/
const SKILLS_TOKEN = process.env.SKILLS_GITHUB_TOKEN || ''
const SKILLS_APP = (() => {
  if (!process.env.SKILLS_GITHUB_APP_ID || !process.env.SKILLS_GITHUB_APP_KEY) return null
  try {
    return { id: process.env.SKILLS_GITHUB_APP_ID.trim(), key: appKey(process.env.SKILLS_GITHUB_APP_KEY) }
  } catch (e) {
    console.error(`SKILLS_GITHUB_APP_KEY 를 읽지 못했습니다(${e.message}). ${SKILLS_TOKEN ? 'SKILLS_GITHUB_TOKEN 으로 읽습니다' : '/skills 는 꺼집니다'}.`)
    return null
  }
})()
/** 공개 데모 (REQ-F-766): on only when BRIDGE_DEMO is `1` (1.291). No id or password: anyone may press 데모로 둘러보기. */
const demoOn = process.env.BRIDGE_DEMO === '1'
/**
 * Apple로 로그인 (REQ-F-772): the iOS app's bundle id, which Apple's identity tokens must be for. The Sign in with
 * Apple key (team, key id, the .p8's text) is optional: with it, deleting an account revokes its Apple token.
 */
const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || 'dev.creco.bridge'
const apple = (() => {
  try {
    return appleClient({ teamId: process.env.APPLE_TEAM_ID, keyId: process.env.APPLE_KEY_ID, privateKey: (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'), clientId: APPLE_CLIENT_ID })
  } catch (e) {
    console.error(`APPLE_PRIVATE_KEY 를 읽지 못했습니다(${e.message}). 계정 삭제 때 Apple 토큰 취소를 건너뜁니다.`)
    return null
  }
})()
/**
 * 앱 알림 (REQ-F-775): APNs takes a key of its own (APNS_KEY_ID + APNS_PRIVATE_KEY) or the Sign in with Apple one when
 * that key also has APNs turned on. Without either, devices register and nothing is sent.
 */
const apns = (() => {
  const own = process.env.APNS_KEY_ID && process.env.APNS_PRIVATE_KEY
  try {
    return apnsClient({
      teamId: process.env.APPLE_TEAM_ID,
      keyId: own ? process.env.APNS_KEY_ID : process.env.APPLE_KEY_ID,
      privateKey: ((own ? process.env.APNS_PRIVATE_KEY : process.env.APPLE_PRIVATE_KEY) || '').replace(/\\n/g, '\n'),
      topic: APPLE_CLIENT_ID,
      // Tests (dev login only) stand a local HTTP/2 server in for Apple's.
      ...(DEV_LOGIN && process.env.APNS_TEST_ORIGIN ? { origins: { production: process.env.APNS_TEST_ORIGIN, sandbox: process.env.APNS_TEST_ORIGIN } } : {}),
    })
  } catch (e) {
    console.error(`APNs 키를 읽지 못했습니다(${e.message}). 앱 알림을 보내지 않습니다.`)
    return null
  }
})()
// Tests (dev login only) hand the server their own keys instead of Apple's.
const appleKeyOf = DEV_LOGIN && process.env.APPLE_TEST_JWKS ? appleKeys({ fetchJson: async () => JSON.parse(process.env.APPLE_TEST_JWKS) }) : appleKeys()
const HEARTBEAT_MS = 15_000
const STALE_MS = 50_000
const GOT_MS = 12_000
/** Prints every message that crosses a bridge tab, by type, to stdout. For finding where a relay stops. */
const TRACE = process.env.BRIDGE_TRACE === '1'
/** The Dokploy this deployment's people use, named in the MCP guide. Unset, the guide shows a placeholder. */
const GUIDE_DOKPLOY_URL = (process.env.BRIDGE_GUIDE_DOKPLOY_URL || 'https://<Dokploy 주소>').replace(/\/+$/, '')
const trace = (hostId, text) => TRACE && console.log(`${new Date().toISOString()} TRACE user=${users[hosts[hostId]?.uid]?.login} host=${hosts[hostId]?.name} ${text}`)
const LOGIN_DAYS = 30
const META_FLUSH_MS = 5_000
/** One page of a conversation's events: what a page asks for when it opens a session or scrolls back. */
const EVENTS_PAGE = 500
/** The files that make up the agent; install.sh downloads exactly these. */
/** What the prompt cache did in a session (REQ-F-773), as the agent counted it from the transcript: numbers only. */
const CACHE_KINDS = ['start', 'cold', 'idle', 'model', 'compact', 'other']
function cacheOf(c) {
  if (!c || typeof c !== 'object') return null
  const n = (v) => (Number.isFinite(v) && v >= 0 ? v : 0)
  const out = Object.fromEntries(['calls', 'read', 'write', 'input', 'output', 'ctx', 'at'].map((k) => [k, n(c[k])]))
  out.hit = Math.min(100, n(c.hit))
  out.events = (Array.isArray(c.events) ? c.events : []).slice(-5).filter((e) => CACHE_KINDS.includes(e?.kind)).map((e) => ({ at: n(e.at), kind: e.kind, tokens: n(e.tokens), gap: n(e.gap) }))
  return out
}
const AGENT_FILES = ['agent.mjs', 'dialog.mjs', 'preview.mjs', 'screen.mjs', 'plugins.mjs', 'skills.mjs', 'split.mjs', 'guard.mjs', 'accounts.mjs', 'voice.mjs', 'mcp.mjs', 'cache.mjs', 'scrub.mjs', 'store.mjs', 'stats.mjs', 'mux.mjs', 'keys.mjs']

fs.mkdirSync(DATA, { recursive: true })
const log = (...a) => console.log(new Date().toISOString(), ...a)
// A deploy starts the new server while the old one still runs. The state is taken over from it before any of it is
// read (server/handover.mjs); when no other server is alive this returns at once.
const handover = createHandover(DATA, log)
await handover.takeOver()
// The state is this server's now and the old one writes nothing: the data folder goes to the node user (R1-L5).
log(`user: ${dropRoot(DATA)}`)
// Files written before their mode was set stay readable by others until made 0600 here (R1-L6).
log(`data: ${tightenTree(DATA)}개의 권한을 0600/0700 으로 맞춤`)
/** Set once this server has given its state to a newer one: from then on it writes nothing. */
let frozen = false
const SKILLS_CODE = codeHash((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
const LOG_ROTATE = 5 * 1024 * 1024
const LOG_VIEW = 400
const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}
/** The one server-wide repo of 1.294 and before, saved in the 운영 tab: moved to its owner's prefs at start (1.295). */
const SKILLS_FILE = path.join(DATA, 'skills-repo.json')
/** owner/repo (lowercased) -> its reader, made on first use and kept: each keeps its own copy of the repo. */
const skillsByRepo = new Map()
const skillsFor = (repo) => {
  if (!repo || !(SKILLS_APP || SKILLS_TOKEN)) return null
  const k = repo.toLowerCase()
  if (!skillsByRepo.has(k)) skillsByRepo.set(k, createSkills({ token: SKILLS_TOKEN, app: SKILLS_APP, repo, api: process.env.SKILLS_GITHUB_API || undefined, log }))
  return skillsByRepo.get(k)
}
/**
 * The key that signs install commands (REQ-S-078): /skills/install.sh is fetched by curl without the sign-in cookie,
 * so it hands out a repo's installer only with the signature /api/skills gave that repo's owner. Made once, kept in
 * the data folder (both servers of a handover share it), never shown.
 */
const SKILLS_INSTALL_KEY = (() => {
  const f = path.join(DATA, 'skills-install.secret')
  try {
    fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
  } catch {}
  try {
    return fs.readFileSync(f, 'utf8').trim()
  } catch {
    return crypto.randomBytes(32).toString('hex')
  }
})()
const skillsInstallSig = (repo) => crypto.createHmac('sha256', SKILLS_INSTALL_KEY).update(`skills-install\0${repo.toLowerCase()}`).digest('base64url').slice(0, 32)
const skillsInstallOk = (repo, t) => {
  const want = Buffer.from(skillsInstallSig(repo))
  const got = Buffer.from(String(t))
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}
const writeJson = (p, v) => {
  if (frozen) return
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
  // Some of these hold secrets (a Slack bot's tokens, sign-in tokens): readable by the server's user only (R1-L6).
  // A name of its own: in a container the old and the new server are both pid 1 (R10-L3).
  const tmp = `${p}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 })
  fs.renameSync(tmp, p)
}
/** Fingerprint of the agent this server hands out; an agent reporting another one is behind (or ahead in development). */
const AGENT_BUILD = AGENT_FILES.reduce((h, f) => h.update(fs.readFileSync(path.join(ROOT, 'agent', f))), crypto.createHash('sha1')).digest('hex').slice(0, 12)
/**
 * The maintainer's signature of the agent (scripts/sign-agent.mjs): `msig` over the files' manifest under `seq`,
 * which agents from 1.165 check, and `legacy` over AGENT_BUILD, which agents of 1.161~1.164 check (R1-I1, R5-H1).
 */
const AGENT_SIG = (() => {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'agent/agent.sig'), 'utf8').trim()
    return raw.startsWith('{') ? JSON.parse(raw) : { legacy: raw }
  } catch {
    return {}
  }
})()
/** Whether the agent this server hands out is signed as it is (R5-L2): an unsigned deploy would stop every update. */
const AGENT_SIG_OK = manifestSigned(Object.fromEntries(AGENT_FILES.map((f) => [f, fs.readFileSync(path.join(ROOT, 'agent', f), 'utf8')])), AGENT_SIG.seq, AGENT_SIG.msig)
/**
 * The largest seq this server's data has handed out (R7-M1): a deploy whose agent was signed with a smaller one (a
 * worktree's agent.sig kept in a rebase conflict) would be refused by every Mac. Such a deploy sends no update at all
 * and says so in /api/health, instead of having every Mac log a refusal.
 */
const SEQ_FILE = path.join(DATA, 'agent-seq.json')
const SEQ_SEEN = (() => {
  if (!fs.existsSync(SEQ_FILE)) return 0
  const v = Number(readJson(SEQ_FILE, null)?.max)
  if (Number.isSafeInteger(v) && v > 0) return v
  // Unreadable is not the same as a first deploy (R9-L2): kept aside and said, then started over from this deploy.
  console.error('agent-seq.json 을 읽지 못해 agent-seq.json.broken 으로 옮깁니다. 이번 배포의 순번부터 다시 셉니다')
  try {
    fs.renameSync(SEQ_FILE, `${SEQ_FILE}.broken`)
  } catch {}
  return 0
})()
const AGENT_SEQ_BACK = AGENT_SIG_OK && AGENT_SIG.seq < SEQ_SEEN
if (AGENT_SEQ_BACK) console.error(`agent/agent.sig 의 순번(${AGENT_SIG.seq})이 전에 내보낸 것(${SEQ_SEEN})보다 작습니다. 맥들이 거절하므로 업데이트를 보내지 않습니다(node scripts/sign-agent.mjs 로 다시 서명).`)
const AGENT_SIGNED = AGENT_SIG_OK && !AGENT_SEQ_BACK
let seqRecorded = false
if (!AGENT_SIG_OK) console.error(`agent/agent.sig 가 에이전트 파일(build ${AGENT_BUILD})의 서명이 아닙니다. 맥들은 이 업데이트를 받지 않습니다(node scripts/sign-agent.mjs).`)
/** Fingerprint of the connect page's files: a bridge tab that was open before a deploy sees a different one and reloads. */
const WEB_HASH = (() => {
  try {
    return ['bridge.html', 'bridge.js', 'relay.js', 'app.css', 'theme.js'].reduce((h, f) => h.update(fs.readFileSync(path.join(ROOT, 'web', f))), crypto.createHash('sha256')).digest('hex').slice(0, 12)
  } catch {
    return ''
  }
})()
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
const isAdmin = (uid) => !isDemoUid(uid) && !!users[uid] && !isAppleLogin(users[uid].login) && ADMINS.includes(users[uid].login.toLowerCase())
/** Who set a login's access: the server's configuration, or an operator on the access page. */
function accessOf(login) {
  const l = login.toLowerCase()
  // An Apple account (REQ-F-772) is let in by an operator only: the lists in the configuration are GitHub names,
  // and `*` means any GitHub account.
  if (isAppleLogin(l)) return access[l]?.status === 'allowed' ? { allowed: true, by: 'operator' } : { allowed: false, by: access[l]?.status === 'denied' ? 'operator' : 'none' }
  if (ADMINS.includes(l)) return { allowed: true, by: 'admin' }
  if (ALLOWED.includes(l)) return { allowed: true, by: 'config' }
  const status = access[l]?.status
  if (status === 'allowed') return { allowed: true, by: 'operator' }
  if (status === 'denied') return { allowed: false, by: 'operator' }
  return { allowed: ALLOWED.includes('*'), by: ALLOWED.includes('*') ? 'config' : 'none' }
}
const isAllowed = (login) => accessOf(login).allowed
const safeId = (s) => typeof s === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(s)

// ---------- store ----------

/** uid -> { login, name, avatar } */
const users = readJson(path.join(DATA, 'users.json'), {})
/** sha256(token) -> { uid, exp } */
const logins = readJson(path.join(DATA, 'logins.json'), {})
/**
 * lowercased GitHub login -> { login, name, avatar, status: 'pending'|'allowed'|'denied', firstAt, lastAt, attempts, decidedBy, decidedAt }.
 * Everyone who tried to sign in without being allowed lands here as pending, for an operator to decide.
 */
const access = readJson(path.join(DATA, 'access.json'), {})
/** lowercased GitHub login -> the `gh<id>` that first signed in with it (server/login-pin.mjs, R1-L1). */
const pins = (() => {
  const file = path.join(DATA, 'login-pins.json')
  if (!fs.existsSync(file)) return loadPins(null, readJson(path.join(DATA, 'users.json'), {}))
  // There but unreadable: kept aside, and made again from users.json, where a name an operator let go is
  // `<name>#released` and stays free (R4-M2). Leaving the pins empty instead freed every name (R8-L2).
  const saved = readJson(file, undefined)
  if (saved !== undefined) return loadPins(saved, {})
  console.error('login-pins.json 을 읽지 못해 login-pins.json.broken 으로 옮기고 users.json 으로 다시 만듭니다')
  try {
    fs.renameSync(file, `${file}.broken`)
  } catch {}
  return loadPins(null, readJson(path.join(DATA, 'users.json'), {}))
})()
/** hostId -> { uid, name, home, lastSeen } */
const hosts = readJson(path.join(DATA, 'hosts.json'), {})
/** sid -> meta. Loaded once; the transcript itself stays on disk. */
const sessions = new Map()
const dirty = new Set()

const userDir = (uid) => path.join(DATA, 'u', uid)
const sessionDir = (meta) => path.join(userDir(meta.uid), 's', meta.id)
/**
 * The copy of the conversation Claude Code would resume from. `/clear` starts a new conversation (a new id) in
 * the same session, and from then on that one is the copy; the first conversation keeps the old file name.
 */
const transcriptFile = (meta) => path.join(sessionDir(meta), !meta.conv || meta.conv === meta.id ? 'transcript.jsonl' : `transcript-${meta.conv}.jsonl`)
const eventsFile = (meta) => path.join(sessionDir(meta), 'events.jsonl')
/** What is known about a session whose agent is not reporting. */
const noState = () => ({ alive: false, phase: 'ended', waiting: null, waitingSince: null, held: [], tool: null, tools: 0, turnAt: null, mode: null, effort: null, context: null, autoAllow: false })
/** In memory only: rebuilt from the agent's reports, never written to meta.json. */
const volatile = () => ({ state: noState(), moving: null, card: null, writing: '' })

for (const uid of fs.existsSync(path.join(DATA, 'u')) ? fs.readdirSync(path.join(DATA, 'u')) : []) {
  const dir = path.join(DATA, 'u', uid, 's')
  for (const sid of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const meta = readJson(path.join(dir, sid, 'meta.json'), null)
    if (!meta) continue
    // Names that were never names: a placeholder the adopt list once sent, and Claude Code's own interruption
    // line taken for the first thing said. Cleared, so the first real words or Claude Code's title take their place.
    const noName = /^(\(제목 없음\)|\[Request interrupted by user(?: for tool use)?\])$/
    if (!meta.manualTitle && noName.test(meta.title ?? '')) meta.title = ''
    if (noName.test(meta.preview ?? '')) meta.preview = ''
    // A remote address kept with a token in it loses the token at once (REQ-S-073). The note contents an older
    // server kept wait aside, untouched, for the operator to clear them (REQ-S-075).
    if (meta.folder && typeof meta.folder === 'object') {
      const files = meta.folder.files && typeof meta.folder.files === 'object' ? meta.folder.files : {}
      if (Object.keys(files).length) meta._legacy = { ...meta._legacy, folderFiles: files }
      const clean = cleanFolder(meta.folder)
      if (JSON.stringify(clean) !== JSON.stringify(meta.folder)) (meta.folder = clean), dirty.add(sid)
    }
    // Sets do not survive JSON: the tool calls in flight and the silent ones start empty after a restart.
    sessions.set(sid, { ...meta, ...volatile(), openTools: new Set(), silentTools: new Set() })
  }
}

let globalsDirty = false
const touchGlobals = () => (globalsDirty = true)
const touch = (meta) => {
  meta.updatedAt = Date.now()
  dirty.add(meta.id)
  broadcastState(meta.uid)
}

/** The periodic sync to disk. Transcript lines are appended as they arrive; everything else lands here. */
function flushToDisk() {
  if (frozen) return
  for (const sid of dirty) {
    const meta = sessions.get(sid)
    // The latest words and pictures read off the Mac stay in memory; a locked session keeps not even its first
    // words or a title it was not given by hand (REQ-S-070).
    if (meta) writeJson(path.join(sessionDir(meta), 'meta.json'), { ...meta, state: undefined, moving: undefined, card: undefined, writing: undefined, cardIndex: undefined, echo: undefined, openTools: undefined, silentTools: undefined, logSize: undefined, cardWant: undefined, last: undefined, localImgs: undefined, ...(meta.lock ? { preview: undefined, ...(meta.manualTitle ? {} : { title: undefined }) } : {}) })
  }
  dirty.clear()
  if (globalsDirty) {
    // The demo account and its Mac are made again at every start: never written, so a start without 데모 모드 has neither.
    const kept = (o, drop) => Object.fromEntries(Object.entries(o).filter(([k, v]) => !drop(k, v)))
    writeJson(path.join(DATA, 'users.json'), kept(users, (id) => isDemoUid(id)))
    writeJson(path.join(DATA, 'logins.json'), logins)
    // A Mac's Claude account e-mail and plan are shown while it is connected and never written (REQ-S-074).
    writeJson(path.join(DATA, 'hosts.json'), Object.fromEntries(Object.entries(kept(hosts, (id) => isDemoHost(id))).map(([id, h]) => [id, { ...h, ...(h.accounts ? { accounts: h.accounts.map(({ email: _e, plan: _p, ...a }) => a) } : {}), ...(h.info ? { info: (({ hostname: _h, ...i }) => i)(h.info) } : {}) }])))
    writeJson(path.join(DATA, 'access.json'), access)
    writeJson(path.join(DATA, 'login-pins.json'), pins)
    globalsDirty = false
  }
}
setInterval(flushToDisk, META_FLUSH_MS)
for (const sig of ['SIGTERM', 'SIGINT'])
  process.on(sig, () => {
    flushToDisk()
    const ms = handover.linger()
    if (!ms) process.exit(0)
    // A deploy is swapping this server out: the requests the router still sends here go on to the new one for a
    // few seconds more, instead of being refused the moment the stop is ordered (that refusal is a 502 to the page).
    log(`handover: ${sig} while a newer server takes over; staying ${ms} ms for the requests still arriving`)
    setTimeout(() => process.exit(0), ms).unref?.()
  })

// ---------- what a person arranged: groups, order, the default prompt ----------

const prefsFile = (uid) => path.join(userDir(uid), 'prefs.json')
const prefsCache = new Map()
/** uid -> { groups: [{id, name, items: [sid]}], loose: [sid], defaultPrompt }. A session is in one place at most. */
/** What a new session is told when the person has written nothing of their own (the built-in text). */
const BUILTIN_DEFAULT_PROMPT = '나는 한국어를 읽어. 페이지에 보이는 글은 모두 한국어로 써 줘: 최종 답, 도구를 쓰는 사이사이 쓰는 짧은 설명까지. 코드·명령·파일 경로·식별자·인용한 출력은 원래 그대로 둬.'
const sysPromptOf = (uid) => prefsOf(uid).defaultPrompt?.trim() || BUILTIN_DEFAULT_PROMPT
/**
 * What a new session and a copy (복제·가벼운 복제) start with when nothing else is said: the person's own defaults
 * (설정 → 새 세션·복제 기본값). An empty value is "not set": a new session then takes the Mac's own default, a
 * copy what the original runs with.
 */
const LAUNCH_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// autoAllow (전부 허용) is not a Claude Code mode: the terminal starts in manual (default) and the agent then
// allows every request itself, as when it is turned on from the session's menu.
const LAUNCH_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'autoAllow']
/** The mode claude is started with, and whether 전부 허용 is turned on once it is up. */
const startMode = (mode) => (mode === 'autoAllow' ? { mode: 'default', autoAllow: true } : { mode, autoAllow: false })
/** 전부 허용 on a session that has just been launched. */
const turnOnAutoAllow = (meta) => {
  meta.autoAllow = true
  toHost(meta.hostId, { t: 'set', sid: meta.id, autoAllow: true })
}
function cleanLaunch(v) {
  const model = String(v?.model ?? '').trim()
  const effort = String(v?.effort ?? '').trim()
  const mode = String(v?.mode ?? '').trim()
  return {
    model: /^[\w.[\]-]{1,60}$/.test(model) ? model : '',
    effort: LAUNCH_EFFORTS.includes(effort) ? effort : '',
    mode: LAUNCH_MODES.includes(mode) ? mode : '',
    folderBase: cleanFolderBase(v?.folderBase) || FOLDER_BASE,
    folderNoGroup: folderPart(v?.folderNoGroup) || FOLDER_NO_GROUP,
  }
}
const launchOf = (uid) => cleanLaunch(prefsOf(uid).launch)
// The icons' size (px) and how much of their box the drawings fill (1 = as drawn), kept with the account so
// every device shows the same. Anything else falls back to the defaults (REQ-F-728).
const ICON_SIZES = [14, 16, 18, 20, 22, 24]
const ICON_FILLS = [0.87, 1, 1.09, 1.17]
const cleanIcons = (v) => ({ size: ICON_SIZES.includes(Number(v?.size)) ? Number(v.size) : 18, fill: ICON_FILLS.includes(Number(v?.fill)) ? Number(v.fill) : 1 })
// 음성 입력 (REQ-F-754), kept with the account: every device records into the same settings. Which microphone and
// how the button works are the device's own (the page keeps them).
const VOICE_MODELS = ['large-v3-turbo-q5_0', 'large-v3-turbo', 'medium', 'small', 'base']
const VOICE_LANGS = ['ko', 'en', 'auto']
const cleanVoice = (v) => ({
  on: v?.on === true,
  model: VOICE_MODELS.includes(v?.model) ? v.model : VOICE_MODELS[0],
  language: VOICE_LANGS.includes(v?.language) ? v.language : 'ko',
  denoise: v?.denoise !== false,
  tidy: v?.tidy !== false,
  terms: String(v?.terms ?? '').slice(0, 4000),
})
/**
 * One Mac's own choice over the account's (REQ-F-758): '' follows the account. Speech is always turned into words on
 * the Mac (1.231): a 'backend' saved before then is read past, never sent on.
 */
const cleanVoiceHost = (v) => ({ model: VOICE_MODELS.includes(v?.model) ? v.model : '' })
/** The defaults that are set, and only those: what a copy is told to start with instead of the original's. */
const launchOver = (uid) => {
  const o = Object.fromEntries(Object.entries(launchOf(uid)).filter(([, v]) => v))
  if (o.mode) o.mode = startMode(o.mode).mode
  return o
}
/** Whether a copy (or a new session that says nothing) turns 전부 허용 on once it is up. */
const launchAutoAllow = (uid) => launchOf(uid).mode === 'autoAllow'
function prefsOf(uid) {
  if (!prefsCache.has(uid)) prefsCache.set(uid, { groups: [], loose: [], defaultPrompt: '', ...readJson(prefsFile(uid), {}) })
  return prefsCache.get(uid)
}
const savePrefs = (uid) => (writeJson(prefsFile(uid), prefsOf(uid)), broadcastState(uid))
/** The GitHub login of a person signed in with GitHub; null for Apple and demo accounts, which have none. */
const githubLoginOf = (uid) => (!isDemoUid(uid) && users[uid] && !users[uid].apple && !isAppleLogin(users[uid].login) ? users[uid].login : null)
/** 스킬 저장소 (REQ-F-792): the person's own, else SKILLS_REPO, else none. */
const skillsRepoOf = (uid) => (typeof prefsOf(uid).skillsRepo === 'string' && prefsOf(uid).skillsRepo) || SKILLS_REPO_ENV
const skillsView = (uid) => {
  const own = typeof prefsOf(uid).skillsRepo === 'string' ? prefsOf(uid).skillsRepo : ''
  return { repo: own, fallback: !own && !!SKILLS_REPO_ENV, login: githubLoginOf(uid), auth: SKILLS_APP ? 'app' : SKILLS_TOKEN ? 'token' : null, on: !!skillsFor(skillsRepoOf(uid)) }
}
const SPLITS_MAX = 20
/** 분할 조합 (REQ-F-790): [{id, name, ids: [sid, sid(, sid)]}]. */
const splitsOf = (uid) => (Array.isArray(prefsOf(uid).splits) ? prefsOf(uid).splits : []).filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string' && Array.isArray(x.ids))

/** Group operations, on session ids. Throws a Refuse(400) with what was wrong. */
/** A copy of a session goes where the original is: the same group, right after it. */
function besideInGroup(uid, original, copy) {
  const g = prefsOf(uid)
  const list = g.groups.find((x) => x.items.includes(original))?.items ?? (g.loose.includes(original) ? g.loose : null)
  if (list && !list.includes(copy)) list.splice(list.indexOf(original) + 1, 0, copy)
}
/** Groups can hold groups, three levels deep at most (a group, a group in it, and one more). */
const GROUP_DEPTH = 3
function groupOp(uid, b) {
  const g = prefsOf(uid)
  const clean = (name) => String(name ?? '').trim().slice(0, 40)
  const find = (id) => g.groups.find((x) => x.id === id)
  const bad = (text) => {
    throw new Refuse(400, text)
  }
  // How deep a group sits (1 at the top), and how many levels it and what is inside it take up.
  const depthOf = (id, seen = 0) => (!id || !find(id) || seen > 10 ? 0 : 1 + depthOf(find(id).parent, seen + 1))
  const heightOf = (id, seen = 0) => (seen > 10 ? 1 : 1 + Math.max(0, ...g.groups.filter((x) => x.parent === id).map((x) => heightOf(x.id, seen + 1))))
  const inside = (id, of) => (id === of ? true : !!find(id)?.parent && inside(find(id).parent, of))
  /** Put a group under another (or at the top, parent null), checking the depth and that it does not go inside itself. */
  const placeUnder = (it, parent) => {
    if (parent && !find(parent)) bad('그룹을 찾지 못했어요.')
    if (parent && inside(parent, it.id)) bad('그룹을 자기 안으로 넣을 수는 없어요.')
    if (depthOf(parent) + heightOf(it.id) > GROUP_DEPTH) bad(`그룹은 ${GROUP_DEPTH}단계까지만 넣을 수 있어요.`)
    if (parent) it.parent = parent
    else delete it.parent
  }
  if (b.op === 'create') {
    const name = clean(b.name)
    if (!name) bad('그룹 이름이 비어 있어요.')
    if (g.groups.length >= 50) bad('그룹이 너무 많아요.')
    if (b.parent && !find(b.parent)) bad('그룹을 찾지 못했어요.')
    if (b.parent && depthOf(b.parent) >= GROUP_DEPTH) bad(`그룹은 ${GROUP_DEPTH}단계까지만 넣을 수 있어요.`)
    const id = crypto.randomBytes(4).toString('hex')
    g.groups.push({ id, name, items: [], ...(b.parent ? { parent: b.parent } : {}) })
    return { note: '그룹을 만들었어요.', id }
  }
  if (b.op === 'rename') {
    const name = clean(b.name)
    if (!find(b.id) || !name) bad('그룹을 찾지 못했거나 이름이 비어 있어요.')
    find(b.id).name = name
  } else if (b.op === 'delete') {
    const it = find(b.id)
    if (!it) bad('그룹을 찾지 못했어요.')
    // What it held goes up one level: its sessions to the group around it (or out of any group), its groups too.
    ;(it.parent && find(it.parent) ? find(it.parent).items : g.loose).push(...it.items)
    for (const x of g.groups) if (x.parent === it.id) it.parent ? (x.parent = it.parent) : delete x.parent
    g.groups = g.groups.filter((x) => x.id !== b.id)
    g.collapsed = (g.collapsed ?? []).filter((x) => x !== b.id)
  } else if (b.op === 'empty') {
    // What it and the groups inside it hold, for the caller to delete; the groups themselves stay.
    if (!find(b.id)) bad('그룹을 찾지 못했어요.')
    return { held: g.groups.filter((x) => inside(x.id, b.id)).flatMap((x) => x.items) }
  } else if (b.op === 'fold') {
    // Whether a group is folded is kept with the groups, so every device shows the same. 'loose' is the
    // 그룹 없음 section (group ids are 8 hex, so it never names a group).
    if (b.id !== 'loose' && !find(b.id)) bad('그룹을 찾지 못했어요.')
    g.collapsed = (g.collapsed ?? []).filter((x) => x !== b.id)
    if (b.open === false) g.collapsed.push(b.id)
  } else if (b.op === 'clearRecent') {
    // The list is emptied by remembering when: nothing is deleted, and what ends later shows again.
    g.recentClearedAt = Date.now()
    return { note: '이어서 하기 목록을 비웠어요. 대화 파일은 맥에 그대로예요' }
  } else if (b.op === 'move') {
    if (!safeId(b.session)) bad('세션을 찾지 못했어요.')
    if (b.group && !find(b.group)) bad('그룹을 찾지 못했어요.')
    g.loose = g.loose.filter((x) => x !== b.session)
    for (const x of g.groups) x.items = x.items.filter((i) => i !== b.session)
    const list = b.group ? find(b.group).items : g.loose
    const at = b.before ? list.indexOf(b.before) : -1
    at >= 0 ? list.splice(at, 0, b.session) : list.push(b.session)
  } else if (b.op === 'nest') {
    // Into another group (parent), or out to the top (parent null); last among its new siblings.
    const it = find(b.id)
    if (!it) bad('그룹을 찾지 못했어요.')
    placeUnder(it, b.parent || null)
    g.groups = [...g.groups.filter((x) => x.id !== b.id), it]
  } else if (b.op === 'order') {
    const it = find(b.id)
    if (!it) bad('그룹을 찾지 못했어요.')
    // Placed before another group: beside it, at its level.
    if (b.before && find(b.before) && b.before !== b.id) placeUnder(it, find(b.before).parent ?? null)
    g.groups = g.groups.filter((x) => x.id !== b.id)
    const at = b.before ? g.groups.findIndex((x) => x.id === b.before) : -1
    at >= 0 ? g.groups.splice(at, 0, it) : g.groups.push(it)
  } else if (b.op === 'loose') {
    const order = [...new Set((Array.isArray(b.order) ? b.order : []).filter(safeId))].slice(0, 500)
    for (const x of g.groups) x.items = x.items.filter((i) => !order.includes(i))
    g.loose = order
  } else bad('알 수 없는 동작이에요.')
  return { note: '' }
}

// ---------- 보관 기한 (REQ-S-071, REQ-S-072, REQ-S-074 (8), REQ-S-075) ----------

const NOTICE_KEEP_MS = 30 * 86_400_000
const REPORT_KEEP_MS = 90 * 86_400_000
const ACCESS_KEEP_MS = 90 * 86_400_000
const RETENTION_SWEEP_MS = 3_600_000
/**
 * When these limits started on this server. What was made before is left alone until the operator, having seen how
 * much there is, clears it (REQ-S-075): deleting it cannot be undone.
 */
const RETENTION = (() => {
  const file = path.join(DATA, 'retention.json')
  const saved = readJson(file, null)
  if (Number(saved?.since) > 0) return saved
  const fresh = { since: Date.now() }
  writeJson(file, fresh)
  return fresh
})()
/** Whether something made at `at` is past `keep` and made under these limits. */
const pastKeep = (at, keep, now = Date.now()) => Number(at) >= RETENTION.since && now - Number(at) > keep
/** Whether something made at `at` is past `keep` at all: what the operator's clearing takes. */
const pastAny = (at, keep, now = Date.now()) => now - (Number(at) || 0) > keep

// ---------- notices: what a person should know even when not looking at that session ----------

const noticesFile = (uid) => path.join(userDir(uid), 'notices.json')
const noticeCache = new Map()
/** A person's notices, without those past NOTICE_KEEP_MS (REQ-S-071). */
function noticesOf(uid, past = pastKeep) {
  if (!noticeCache.has(uid)) noticeCache.set(uid, readJson(noticesFile(uid), []))
  const list = noticeCache.get(uid)
  const now = Date.now()
  if (list.some((n) => past(n.at, NOTICE_KEEP_MS, now))) {
    list.splice(0, list.length, ...list.filter((n) => !past(n.at, NOTICE_KEEP_MS, now)))
    writeJson(noticesFile(uid), list)
  }
  return list
}
/**
 * Newest first, thirty kept for 30 days, saved across restarts. The same key is raised once: a
 * background job that finished is told once, a decision is told once until it is answered.
 * @param {{ sid: string, key: string, title: string, text: string, tone: 'ok'|'fail'|'info', push?: boolean }} n
 */
// ---------- session locks ----------
// A session can be locked with a password. The page sends only a hash of it (the proof); the server keeps
// that proof stretched with a salt. While locked, nothing of the conversation leaves the server without an
// unlock token: not in the list, not on the live stream, not in a notice, not to a plugin or the older page.

const LOCKED = '🔒 잠긴 세션이에요. 비밀번호로 연 뒤에 볼 수 있어요.'
/** sha256 hex of the proof -> { uid, sid, exp }. In memory: a restart asks for the password again. */
const unlocks = new Map()
const LOCK_TOKEN_MS = 12 * 3_600_000
// Off the event loop: 120,000 rounds take long enough that a run of attempts would hold every other request (R1-M4).
const stretch = (proof, salt) => new Promise((resolve, reject) => crypto.pbkdf2(String(proof), Buffer.from(salt, 'hex'), 120_000, 32, 'sha256', (e, key) => (e ? reject(e) : resolve(key.toString('hex')))))
const proofOk = async (meta, proof) => {
  if (!meta.lock || !/^[0-9a-f]{64}$/.test(String(proof ?? ''))) return false
  const a = Buffer.from(await stretch(proof, meta.lock.salt), 'hex')
  const b = Buffer.from(meta.lock.hash, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
function lockToken(meta) {
  const token = crypto.randomBytes(24).toString('base64url')
  unlocks.set(sha256(token), { uid: meta.uid, sid: meta.id, exp: Date.now() + LOCK_TOKEN_MS })
  return token
}
/** Whether this request may see and drive a locked session. A session that is not locked is always open. */
function unlockedBy(req, meta) {
  if (!meta.lock) return true
  const t = unlocks.get(sha256(String(req.headers?.['x-lock'] ?? '')))
  return !!t && t.uid === meta.uid && t.sid === meta.id && t.exp > Date.now()
}
/** A session as the list and every device sees it: the lock itself never leaves, and a locked one says only that. */
function shielded(meta) {
  const { lock, ...m } = meta
  if (!lock) return m
  const st = m.state ?? {}
  return {
    ...m,
    locked: true,
    // A name a person gave stays; one made from the conversation (its first words, Claude Code's title) does not.
    title: m.manualTitle ? m.title : '잠긴 세션',
    cwd: '',
    last: '',
    preview: '',
    writing: '',
    // Words from the conversation kept for other uses: what was just sent, background commands, PR titles.
    echo: [],
    bg: (m.bg ?? []).map((t) => ({ kind: t.kind, label: '' })),
    // No longer kept (PR states are cached by address now), but an older meta on disk may still carry it.
    prMentions: null,
    todoHidden: undefined,
    // What the folder holds says what the work is about: only whether a push failed is left.
    folder: m.folder ? { repos: (m.folder.repos ?? []).map((r) => ({ dir: '', branch: '', sha: '', remote: '', pushError: r.pushError ? '(가림)' : null, pr: null })) } : m.folder,
    card: m.card ? { id: m.card.id, kind: m.card.kind, open: m.card.open } : null,
    state: { ...st, held: (st.held ?? []).map((h) => ({ id: h.id, at: h.at, text: '' })), tool: st.tool ? { name: st.tool.name, title: null, at: st.tool.at } : null, running: [] },
  }
}

function addNotice(uid, n) {
  // A locked session's notice says only that there is something to see, not even its name (REQ-S-071).
  if (n.sid && sessions.get(n.sid)?.lock) n = { ...n, title: '잠긴 세션', text: '확인할 것이 있어요' }
  const list = noticesOf(uid)
  if (list.some((x) => x.key === n.key)) return
  const kept = { id: crypto.randomBytes(6).toString('hex'), at: Date.now(), sid: n.sid, key: n.key, title: String(n.title).slice(0, 80), text: String(n.text).slice(0, 200), tone: n.tone }
  list.unshift(kept)
  list.splice(30)
  writeJson(noticesFile(uid), list)
  broadcastState(uid)
  if (n.push) pushTo(uid, kept, n.push === 'always')
}
function dropNotices(uid, match) {
  const list = noticesOf(uid)
  const kept = list.filter((x) => !match(x))
  if (kept.length === list.length) return
  list.splice(0, list.length, ...kept)
  writeJson(noticesFile(uid), list)
  broadcastState(uid)
}

// ---------- web push ----------

/**
 * A push carries no content: it only wakes the page's service worker, which asks this server (signed in, same
 * origin) what there is to say. So nothing about a session ever passes through a push service, and no payload
 * encryption is needed. The request is authorised with a VAPID token signed by a key made on first start.
 */
const vapidFile = path.join(DATA, 'vapid.json')
let vapid = readJson(vapidFile, null)
if (!vapid) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  vapid = { publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url'), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
  writeJson(vapidFile, vapid)
}
const subsFile = (uid) => path.join(userDir(uid), 'push.json')
const subsOf = (uid) => readJson(subsFile(uid), [])
/** uid -> when one of its control pages last said it was on screen. A person looking at the page needs no push. */
const lookingAt = new Map()
/** uid -> Map(sid -> when a page last said it shows that conversation). Its cards need no notice. */
const viewing = new Map()
const isViewing = (uid, sid) => [...(viewing.get(uid) ?? new Map())].some(([s, at]) => s === sid && Date.now() - at < 45_000)

/**
 * A browser's push service (Chrome/Edge via FCM, Firefox, Safari, Windows): the only hosts the server posts a push
 * to (R1-L13). Any https address used to be taken, and the server posted there for whoever subscribed it.
 */
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/
function pushService(endpoint) {
  try {
    const u = new URL(endpoint)
    return u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname)
  } catch {
    return false
  }
}

/** `always`: sent even while a page is in front (a desk's open tab says nothing about where the person is). */
async function pushTo(uid, n, always = false) {
  if (!always && Date.now() - (lookingAt.get(uid) ?? 0) < 45_000) return
  const devices = devicesOf(uid)
  apnsTo(uid, n, devices)
  const subs = subsOf(uid)
  const gone = []
  for (const sub of webTargets(subs, devices).filter((x) => pushService(x.endpoint))) {
    try {
      const aud = new URL(sub.endpoint).origin
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
      const head = `${b64({ typ: 'JWT', alg: 'ES256' })}.${b64({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: `mailto:noreply@${new URL(ORIGIN || 'http://localhost').hostname}` })}`
      const sig = crypto.sign('sha256', Buffer.from(head), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
      const r = await fetch(sub.endpoint, { method: 'POST', headers: { TTL: '3600', Urgency: 'high', Authorization: `vapid t=${head}.${sig}, k=${vapid.publicKey}` }, redirect: 'manual', signal: AbortSignal.timeout(10_000) })
      if (r.status === 404 || r.status === 410) gone.push(sub.endpoint)
    } catch (e) {
      log('push failed', e.message)
    }
  }
  if (gone.length) writeJson(subsFile(uid), subs.filter((x) => !gone.includes(x.endpoint)))
}

// ---------- app push (APNs, REQ-F-775) ----------

/**
 * The iOS app's devices: [{ token, env: 'production'|'sandbox', dev: 'iphone'|'ipad', at }]. Unlike a web push, an
 * APNs notification has to carry its words (the app has no worker to ask the server), so a notice's title and text
 * pass through Apple; a locked session's notice says only that there is something to see (addNotice).
 */
const devicesFile = (uid) => path.join(userDir(uid), 'apns.json')
const devicesOf = (uid) => readJson(devicesFile(uid), [])
let apnsSkipSaid = false
async function apnsTo(uid, n, devices) {
  // 공개 데모 (REQ-F-766) has no devices to send to; this holds even if one were written by hand.
  if (!devices.length || isDemoUid(uid)) return
  if (!apns) {
    if (!apnsSkipSaid) log('앱 알림 건너뜀: 서버에 APNs 키가 없습니다 (APPLE_TEAM_ID 와 APNS_KEY_ID·APNS_PRIVATE_KEY 또는 APPLE_KEY_ID·APPLE_PRIVATE_KEY)')
    apnsSkipSaid = true
    return
  }
  const gone = []
  await Promise.all(
    devices.map(async (d) => {
      try {
        const r = await apns.send({ token: d.token, env: d.env, payload: apnsPayload(n ?? {}), collapseId: n?.sid })
        if (deadToken(r.status, r.reason)) gone.push(d.token)
        else if (r.status !== 200) log(`apns ${r.status} ${r.reason}`)
      } catch (e) {
        log('apns failed', e.message)
      }
    }),
  )
  if (gone.length) {
    log(`apns: 기기 토큰 ${gone.length}개를 지움 (더 쓰이지 않음)`)
    writeJson(devicesFile(uid), devicesOf(uid).filter((d) => !gone.includes(d.token)))
  }
}

// ---------- pictures ----------

const IMG_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const imgDir = (uid) => path.join(userDir(uid), 'img')
/**
 * Keep a picture under the hash of its bytes and return its id (`<sha1>.<ext>`). The same picture sent twice,
 * or read by a tool in two turns, is stored once.
 */
/** Width and height read off the file's own header (PNG, GIF, JPEG, WebP), so the page can leave room before it loads. */
function imageSize(b) {
  try {
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
    if (b.length > 10 && b.toString('latin1', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) }
    if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      const kind = b.toString('latin1', 12, 16)
      if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) }
      if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff }
      if (kind === 'VP8L') {
        const n = b.readUInt32LE(21)
        return { w: 1 + (n & 0x3fff), h: 1 + ((n >> 14) & 0x3fff) }
      }
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      for (let i = 2; i + 9 < b.length; ) {
        if (b[i] !== 0xff) return null
        const m = b[i + 1]
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) }
        i += 2 + b.readUInt16BE(i + 2)
      }
    }
  } catch {}
  return null
}
/** uid -> { imageId: { w, h, bytes, name } }: what the page wants to know about a picture before it has it. */
const imgInfoCache = new Map()
const imgInfoFile = (uid) => path.join(imgDir(uid), 'index.json')
// Read from the index an older server wrote; never written again (REQ-S-069).
const imgInfoOf = (uid) => (imgInfoCache.has(uid) ? imgInfoCache : imgInfoCache.set(uid, readJson(imgInfoFile(uid), {}))).get(uid)
// ---------- 영상 (REQ-F-761)

/** Videos a page may send, as they are, to be handed to the session's Mac by its bridge tab. */
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v']
const VIDEO_EXT = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-m4v': 'm4v' }
const UPLOAD_MAX = 500 * 1024 * 1024
/** How long an upload is kept for its Mac to take: a message sent later than this has to send it again. */
const UPLOAD_TTL_MS = 24 * 3600_000
const uploadsDir = (uid) => path.join(DATA, 'u', uid, 'uploads')
const uploadId = (s) => typeof s === 'string' && /^[0-9a-f]{40}\.(mp4|mov|webm|m4v)$/.test(s)
const uploadName = (s) => String(s ?? '').replace(/[^\w.가-힣 -]/g, '_').slice(0, 120) || 'video'

/** The request's body straight into a file (not held in memory), up to UPLOAD_MAX. */
async function saveUpload(uid, req, url) {
  const type = String(req.headers['content-type']).split(';')[0].trim()
  const id = `${crypto.randomBytes(20).toString('hex')}.${VIDEO_EXT[type]}`
  const dir = uploadsDir(uid)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, id)
  const out = fs.createWriteStream(file, { mode: 0o600 })
  let size = 0
  try {
    for await (const c of req) {
      size += c.length
      if (size > UPLOAD_MAX) throw new Refuse(413, `영상은 ${UPLOAD_MAX / 1024 / 1024}MB 까지 보낼 수 있어요`)
      if (!out.write(c)) await new Promise((r) => out.once('drain', r))
    }
    await new Promise((ok, bad) => out.end((e) => (e ? bad(e) : ok())))
  } catch (e) {
    out.destroy()
    fs.rmSync(file, { force: true })
    throw e
  }
  if (!size) throw (fs.rmSync(file, { force: true }), new Refuse(400, '영상이 비어 있어요'))
  const name = uploadName(url.searchParams.get('name'))
  writeJson(`${file}.json`, { name, type, size, at: Date.now() })
  return { id, name, size }
}
/** An upload of this person's, with what was said of it; null when it is not there (or too old). */
function uploadOf(uid, id) {
  if (!uploadId(id)) return null
  const file = path.join(uploadsDir(uid), id)
  const info = readJson(`${file}.json`, null)
  if (!info || !fs.existsSync(file) || Date.now() - info.at > UPLOAD_TTL_MS) return null
  return { id, file, name: info.name, type: info.type, size: info.size }
}
/** Uploads older than UPLOAD_TTL_MS go. */
function dropOldUploads() {
  for (const uid of fs.existsSync(path.join(DATA, 'u')) ? fs.readdirSync(path.join(DATA, 'u')) : []) {
    const dir = uploadsDir(uid)
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!f.endsWith('.json')) continue
      const info = readJson(path.join(dir, f), null)
      if (info && Date.now() - info.at <= UPLOAD_TTL_MS) continue
      fs.rmSync(path.join(dir, f), { force: true })
      fs.rmSync(path.join(dir, f.slice(0, -5)), { force: true })
    }
  }
}
setInterval(dropOldUploads, 3600_000).unref()
/**
 * message id -> the uploads it carried, as [uid, upload id]. The Mac has a message's videos before it says the message
 * is delivered (the bridge tab hands them over first), so they go then instead of after UPLOAD_TTL_MS (REQ-S-074).
 */
const sentUploads = new Map()
function dropSentUploads(msgIds) {
  for (const id of msgIds) {
    for (const [uid, up] of sentUploads.get(id) ?? []) if (uploadId(up)) (fs.rmSync(path.join(uploadsDir(uid), up), { force: true }), fs.rmSync(path.join(uploadsDir(uid), `${up}.json`), { force: true }))
    sentUploads.delete(id)
  }
}

/**
 * A picture's id (`<sha1>.<ext>`) and, in memory, its size and name for the page. The bytes are not kept here: the
 * Mac has them (it read them off the transcript, or was handed them with the message) and the page asks it through
 * /api/img (REQ-S-069).
 */
function imageRef(uid, mediaType, base64, name) {
  const ext = IMG_TYPES[mediaType]
  if (!ext) return null
  const bytes = Buffer.from(base64, 'base64')
  if (!bytes.length || bytes.length > 12 * 1024 * 1024) return null
  const id = `${crypto.createHash('sha1').update(bytes).digest('hex')}.${ext}`
  const info = imgInfoOf(uid)
  if (!info[id] || (name && !info[id].name)) info[id] = { ...imageSize(bytes), bytes: bytes.length, ...info[id], ...(name ? { name: String(name).slice(0, 120) } : {}) }
  return id
}
/** Pictures passed on lately, so a page drawing the same one again does not ask the Mac again. Memory only. */
const imgPassing = new Map()
const IMG_PASSING_BYTES = 32 * 1024 * 1024
function passImage(id, type, bytes) {
  imgPassing.delete(id)
  imgPassing.set(id, { type, bytes })
  let total = 0
  for (const v of imgPassing.values()) total += v.bytes.length
  for (const [k, v] of imgPassing) {
    if (total <= IMG_PASSING_BYTES) break
    imgPassing.delete(k)
    total -= v.bytes.length
  }
}
/** A picture from the person's Macs: the one asked first, then the others that are connected and keep logs. */
async function imageFromMacs(uid, id, first) {
  const hit = imgPassing.get(id)
  if (hit) return hit
  const macs = Object.keys(hosts).filter((h) => hosts[h].uid === uid && online(h) && storeOn(h)).sort((a, b) => (b === first) - (a === first))
  for (const hostId of macs) {
    const r = await ask(hostId, { t: 'img', id }, 30_000)
    if (!r.ok || typeof r.data !== 'string') continue
    const got = { type: IMG_TYPES[r.type] ? r.type : Object.keys(IMG_TYPES).find((t) => IMG_TYPES[t] === id.split('.')[1]), bytes: Buffer.from(r.data, 'base64') }
    passImage(id, got.type, got.bytes)
    return got
  }
  return null
}

// ---------- event log ----------

/**
 * Every session has its own numbered log of what happened in it: what was said, tool calls, the cards that
 * asked for a decision, moves between hosts. The control page draws from it and, after a dropped connection,
 * asks only for what came after the last number it has.
 * The numbers belong to the session, not to a transcript: they keep counting across `/clear` and across hosts.
 */
/**
 * What moves a session up the 최신순 list: the conversation itself. Notices, status lines and marks (a Mac's
 * agent restarting says "세션이 끝났어요" again in every session) do not.
 */
const MOVES = new Set(['user', 'text', 'tool', 'tool_end', 'card', 'card_end', 'local', 'side', 'todos'])
const movedAt = (events) => events.findLast((e) => MOVES.has(e.k))?.at

/** The highest seq among the last lines of a log file (0 when there is none). */
function lastSeqIn(file, size) {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(Math.min(size, 64 * 1024))
  try {
    fs.readSync(fd, buf, 0, buf.length, size - buf.length)
  } finally {
    fs.closeSync(fd)
  }
  let max = 0
  for (const m of buf.toString('utf8').matchAll(/"seq":(\d+)/g)) max = Math.max(max, Number(m[1]))
  return max
}

function logEvents(meta, events) {
  if (!events.length) return
  const now = Date.now()
  // During a deploy the server being replaced still writes for a few seconds, and this one started from a meta.json
  // up to META_FLUSH_MS old: a log longer than this server last left it is counted on from its own last number,
  // so two servers never hand out the same numbers (the page dropped one of each pair and drew repeats).
  const file = eventsFile(meta)
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {}
  if (size && size !== meta.logSize) meta.seq = Math.max(meta.seq ?? 0, lastSeqIn(file, size))
  for (const e of events) {
    e.seq = meta.seq = (meta.seq ?? 0) + 1
    e.at ??= now
    if (e.k === 'text') meta.lastMine = false
    if (e.k === 'text' || e.k === 'user') meta.last = e.text.replace(/\s+/g, ' ').slice(0, PREVIEW_MAX) || (e.images ? `이미지 ${e.images.length}장` : '')
    if (e.k === 'user' && !e.command && !meta.preview) meta.preview = e.text.replace(/\s+/g, ' ').slice(0, PREVIEW_MAX)
  }
  meta.lastAt = movedAt(events) ?? meta.lastAt ?? meta.createdAt
  // Not written here: the Mac keeps the log (REQ-S-069). This server holds the newest few in memory.
  meta.logSize = size
  remember(meta, events)
  touch(meta)
  toControls(meta.uid, { t: 'ev', sid: meta.id, events })
  handDown(meta.hostId, { t: 'log', sid: meta.id, events })
}

// ---------- the logs go to the Mac (REQ-S-069) ----------

/** How much of a session's first words the server keeps (REQ-S-070). */
const PREVIEW_MAX = 80
/**
 * sid -> the session's newest events, in memory only: what the server itself looks back at (the open card after a
 * dropped link, the last answer for Slack, a turn handed work, the message taken back). Bounded per session and in
 * sessions; a restart starts empty and fills from the Mac when needed (recentEvents).
 */
const tails = new Map()
const TAIL_MAX = 1000
const TAIL_DEMO_MAX = 5000
const TAIL_SESSIONS = 200
function remember(meta, events, older = false) {
  let t = tails.get(meta.id) ?? []
  tails.delete(meta.id)
  if (older) {
    const have = new Set(t.map((e) => e.seq))
    t = [...events.filter((e) => !have.has(e.seq)), ...t].sort((a, b) => a.seq - b.seq)
  } else t = t.concat(events)
  const max = isDemoHost(meta.hostId) ? TAIL_DEMO_MAX : TAIL_MAX
  if (t.length > max) t = t.slice(-max)
  tails.set(meta.id, t)
  for (const k of tails.keys()) {
    if (tails.size <= TAIL_SESSIONS) break
    if (k !== meta.id && !isDemoHost(sessions.get(k)?.hostId)) tails.delete(k)
  }
}
/** The session's events this server can see now: the copy an older server wrote, if not yet moved, and the newest in memory. */
function readEvents(meta, keep = true) {
  const tail = tails.get(meta.id) ?? []
  if (meta.agentLog || !fs.existsSync(eventsFile(meta))) return tail
  const old = readLegacyEvents(meta, keep)
  const last = old.at(-1)?.seq ?? 0
  return tail.length ? old.concat(tail.filter((e) => e.seq > last)) : old
}
/** The newest events, asked of the Mac when this server has none in memory (it started since). */
async function recentEvents(meta, kinds) {
  const have = readEvents(meta)
  const wanted = kinds ? have.filter((e) => kinds.includes(e.k)) : have
  if (wanted.length || !online(meta.hostId) || !storeOn(meta.hostId)) return wanted
  const r = await ask(meta.hostId, { t: 'events', sid: meta.id, limit: kinds ? 50 : 500, ...(kinds ? { kinds } : {}) }, 15_000)
  if (!r.ok || !Array.isArray(r.events)) return wanted
  if (!kinds) remember(meta, r.events, true)
  return r.events
}
/** Events handed to the Mac and not yet heard kept there: added to what the Mac answers, so a page misses none. */
function handedNotKept(meta) {
  const out = []
  for (const cmd of logOut.get(meta.hostId)?.values() ?? []) if (cmd.t === 'log' && cmd.sid === meta.id) out.push(...cmd.events)
  return out
}

/**
 * hostId -> Map(lid -> command): events and pictures handed to a Mac and not yet heard kept there. Sent again when
 * it comes back; memory only. Bounded: what falls out of a full queue is counted, and in 3a the copy on disk is
 * moved over again (meta.agentLog = false).
 */
const logOut = new Map()
const LOG_OUT_MAX = 5000
const LOG_OUT_BYTES = 32 * 1024 * 1024
/** lid -> resolve, for the move of the old copies (migrateSession), which waits for each to be kept. */
const lidWaits = new Map()
const storeOn = (hostId) => !!live(hostId).caps?.includes('store')
function handDown(hostId, cmd) {
  if (!hostId || !hosts[hostId] || isDemoHost(hostId)) return null
  const lid = crypto.randomBytes(9).toString('base64url')
  let out = logOut.get(hostId)
  if (!out) logOut.set(hostId, (out = Object.assign(new Map(), { bytes: 0 })))
  const msg = { ...cmd, lid }
  msg.size = JSON.stringify(msg).length
  out.set(lid, msg)
  out.bytes += msg.size
  while (out.size > LOG_OUT_MAX || out.bytes > LOG_OUT_BYTES) {
    const [old, dropped] = out.entries().next().value
    out.delete(old)
    out.bytes -= dropped.size
    lidWaits.get(old)?.(false)
    const m = dropped.sid && sessions.get(dropped.sid)
    if (m && m.agentLog) (m.agentLog = false), dirty.add(m.id)
  }
  if (online(hostId) && storeOn(hostId)) toHost(hostId, { ...cmd, lid })
  return lid
}
function heardKept(hostId, lids) {
  const out = logOut.get(hostId)
  for (const lid of lids) {
    const msg = out?.get(lid)
    if (msg) (out.delete(lid), (out.bytes -= msg.size))
    lidWaits.get(lid)?.(true)
  }
}
const waitKept = (lid, ms) =>
  new Promise((resolve) => {
    const t = setTimeout(() => (lidWaits.delete(lid), resolve(false)), ms)
    lidWaits.set(lid, (ok) => (clearTimeout(t), lidWaits.delete(lid), resolve(ok)))
  })

/**
 * The copies this server kept before (events.jsonl, the pictures they name) go to the session's Mac once it can keep
 * them, one session at a time, a few hand-overs in flight. The copies here stay until the operator clears them
 * (REQ-S-075). A Mac that goes away stops it; its next hello starts it again from the session not yet done.
 */
const migrating = new Set()
async function migrateHost(uid, hostId) {
  if (migrating.has(hostId)) return
  migrating.add(hostId)
  const failed = new Set()
  try {
    for (;;) {
      if (!online(hostId) || !storeOn(hostId)) break
      const meta = [...sessions.values()].find((m) => m.uid === uid && m.hostId === hostId && !m.agentLog && !m.moving && !failed.has(m.id))
      if (!meta) break
      if (meta.carryFrom) {
        const ok = hosts[meta.carryFrom] && storeOn(meta.carryFrom) && (await carryLog(meta, meta.carryFrom, hostId))
        if (ok && meta.hostId === hostId) (meta.agentLog = true), (meta.carryFrom = undefined), dirty.add(meta.id)
        else failed.add(meta.id)
      } else if (!(await migrateSession(meta, hostId))) failed.add(meta.id)
    }
  } catch (e) {
    log('error', 'migrate', e)
  } finally {
    migrating.delete(hostId)
  }
}
async function migrateSession(meta, hostId) {
  const events = fs.existsSync(eventsFile(meta)) ? readLegacyEvents(meta, false) : []
  const upTo = meta.seq ?? 0
  let flight = []
  const send = async (cmd) => {
    const lid = handDown(hostId, cmd)
    if (!lid) return false
    flight.push(waitKept(lid, 120_000))
    if (flight.length < 4) return true
    const ok = (await Promise.all(flight)).every(Boolean)
    flight = []
    return ok
  }
  let chunk = []
  let size = 0
  let ok = true
  for (const e of events) {
    if (e.seq > upTo) break
    chunk.push(e)
    size += JSON.stringify(e).length
    if (chunk.length >= 500 || size > 800_000) (ok = ok && (await send({ t: 'log', sid: meta.id, events: chunk }))), (chunk = []), (size = 0)
    if (!ok) break
  }
  if (ok && chunk.length) ok = await send({ t: 'log', sid: meta.id, events: chunk })
  let pics = 0
  for (const id of ok ? new Set(events.flatMap((e) => (Array.isArray(e.images) ? e.images : []))) : []) {
    const file = path.join(imgDir(meta.uid), String(id))
    if (!/^[0-9a-f]{40}\.(png|jpg|gif|webp)$/.test(String(id)) || !fs.existsSync(file)) continue
    ok = await send({ t: 'putimg', id, data: fs.readFileSync(file).toString('base64') })
    pics++
    if (!ok) break
  }
  if (ok && flight.length) ok = (await Promise.all(flight)).every(Boolean)
  if (!ok || !sessions.has(meta.id) || meta.hostId !== hostId) return false
  meta.agentLog = true
  dirty.add(meta.id)
  if (events.length) record(meta.uid, hostId, { area: 'store', sid: meta.id, text: `서버에 있던 세션 기록 ${events.length}개와 그림 ${pics}장을 이 맥으로 옮김` })
  return true
}

/**
 * A forked conversation starts as a copy of the original's lines, same uuids. The fork is given the original's
 * events up front (so it does not look empty until its first turn), and the copied lines, when they arrive,
 * are kept in the transcript copy but not drawn a second time.
 */
const forkSkip = new Map()
const forkSkipFile = (meta) => path.join(sessionDir(meta), 'fork-skip.txt')
function copiedInFork(meta) {
  if (!meta.forked) return null
  if (!forkSkip.has(meta.id)) forkSkip.set(meta.id, new Set(fs.existsSync(forkSkipFile(meta)) ? fs.readFileSync(forkSkipFile(meta), 'utf8').split('\n') : []))
  return forkSkip.get(meta.id)
}
const uuidOf = (line) => /"uuid":"([0-9a-f-]{36})"/.exec(line)?.[1]

/**
 * What the session started in the background and has not finished: a shell command, a Monitor, an agent
 * Reopening the session cuts these off, so the person is told before, and the
 * session after. A job that ends is also worth a notice: it is usually what the person was waiting for.
 */
const BG_START = [
  [/^Command running in background with ID: (\S+?)\.?(?:\s|$)/, 'bash'],
  [/^Command [^\n]{0,120}?moved to the background \(ID: ([^)]+)\)/, 'bash'],
  [/^Monitor started \(task (\S+?),/, 'monitor'],
  [/^Async agent launched/, 'agent'],
]
const bgLabels = new Map()
function trackBackground(meta, line) {
  trackTodosTool(meta, line)
  const before = (meta.bg ?? []).length
  trackBackgroundLine(meta, line)
  // A monitor ends on its own after its timeout (five minutes unless it asked for another); nothing in the transcript says so.
  meta.bg = (meta.bg ?? []).filter((t) => t.kind !== 'monitor' || Date.now() < (t.at ?? 0) + (t.timeout ?? 300_000))
  if ((meta.bg ?? []).length !== before && online(meta.hostId)) toHost(meta.hostId, { t: 'bg', sid: meta.id, n: meta.bg.length })
}
/** To-dos taken off one session's panel (REQ-F-784): the newest kept, each at most this many characters. */
const TODO_HIDDEN_MAX = 200
const TODO_KEY_MAX = 300
/**
 * Whether the session's Claude has the bridge todos tool (REQ-F-778), seen in its own transcript: offered among its
 * deferred tools, or called. For sessions an agent started before it reported its tools (status bridgeTools).
 * Only these two shapes: the request "지금까지 한 일로 정리" names the tool too.
 */
function trackTodosTool(meta, line) {
  if (meta.sawTodosTool || !line.includes('mcp__bridge__todos')) return
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return
  }
  const offered = o.type === 'attachment' && o.attachment?.type === 'deferred_tools_delta' && (o.attachment.addedNames ?? []).includes('mcp__bridge__todos')
  const called = o.type === 'assistant' && Array.isArray(o.message?.content) && o.message.content.some((b) => b?.type === 'tool_use' && b.name === 'mcp__bridge__todos')
  if (offered || called) meta.sawTodosTool = true
}
function trackBackgroundLine(meta, line) {
  // Not while an old session's log is being built at startup: what finished long ago is not news.
  if (meta.seq == null) return
  if (!/tool_use|tool_result|task-notification/.test(line)) return
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return
  }
  const content = o.message?.content
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (c.type === 'text' ? c.text : '')).join('\n') : typeof o.content === 'string' ? o.content : typeof o.attachment?.prompt === 'string' ? o.attachment.prompt : ''
  // Only the harness delivers task notifications; one in Claude's own answer is made up and ends nothing.
  for (const m of o.type === 'assistant' ? [] : text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const pick = (tag) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(m[1])?.[1]?.trim()
    const status = pick('status')
    if (!status || status === 'running') continue
    const id = pick('tool-use-id')
    const task = (meta.bg ?? []).find((t) => t.toolUseId === id) ?? (meta.bg ?? []).find((t) => t.id && t.id === pick('task-id'))
    meta.bg = (meta.bg ?? []).filter((t) => t !== task)
    const ok = status === 'completed'
    addNotice(meta.uid, { sid: meta.id, key: `${id ?? pick('task-id') ?? m.index}|${status}`, title: meta.title || '세션', text: pick('summary') || `백그라운드 작업이 끝났어요 (${status})`, tone: ok ? 'ok' : 'fail', push: true })
  }
  if (!Array.isArray(content)) return
  for (const c of content) {
    if (o.type === 'assistant' && c.type === 'tool_use') {
      const i = c.input ?? {}
      bgLabels.set(c.id, { name: c.name, label: String(i.description ?? i.command ?? i.prompt ?? c.name).replace(/\s+/g, ' ').slice(0, 120), timeout: Number(i.timeout_ms) > 0 ? Number(i.timeout_ms) : undefined, taskId: c.name === 'TaskStop' ? String(i.task_id ?? i.shell_id ?? '') : undefined })
      if (bgLabels.size > 2000) bgLabels.delete(bgLabels.keys().next().value)
    } else if (o.type === 'user' && c.type === 'tool_result') {
      const tag = bgLabels.get(c.tool_use_id)
      bgLabels.delete(c.tool_use_id)
      const body = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => x.text ?? '').join('\n') : ''
      if (tag?.name === 'TaskStop') {
        if (!c.is_error && /^Successfully stopped/.test(body.trim())) meta.bg = (meta.bg ?? []).filter((t) => t.id !== tag.taskId)
        continue
      }
      // A background agent that had finished, woken again with a message ("Resuming agent …"): it runs again, and a
      // refresh would cut it off. Not counting it let a refresh drop it without a word.
      if (tag?.name === 'SendMessage') {
        let r = null
        try {
          r = JSON.parse(body)
        } catch {}
        const id = r?.success && typeof r.resumedAgentId === 'string' ? r.resumedAgentId : null
        if (id && !(meta.bg ?? []).some((t) => t.kind === 'agent' && t.id === id))
          meta.bg = [...(meta.bg ?? []), { toolUseId: c.tool_use_id, id, kind: 'agent', label: meta.agentLabels?.[id] ?? 'agent', at: o.timestamp ? Date.parse(o.timestamp) : Date.now() }].slice(-50)
        continue
      }
      const first = body.split('\n')[0].slice(0, 400)
      for (const [re, kind] of BG_START) {
        const m = re.exec(first)
        if (!m) continue
        const id = kind === 'agent' ? /agentId: (\w+)/.exec(body)?.[1] : m[1]
        meta.bg = [...(meta.bg ?? []), { toolUseId: c.tool_use_id, id, kind, label: tag?.label ?? kind, ...(tag?.timeout ? { timeout: tag.timeout } : {}), at: o.timestamp ? Date.parse(o.timestamp) : Date.now() }].slice(-50)
        // An agent's name, for when it is woken again later (SendMessage names only its id).
        if (kind === 'agent' && id) meta.agentLabels = Object.fromEntries([...Object.entries(meta.agentLabels ?? {}), [id, tag?.label ?? kind]].slice(-50))
        break
      }
    }
  }
}

/**
 * A message sent from the page is logged when it is sent, so the page shows it at once
 * and can say whether it is held or delivered. When the same words come back in the transcript they are that
 * message, not a new one. Messages held together come back joined, so each waiting one is looked for in the text.
 */
const normal = (t) => String(t ?? '').replace(/\[(?:Image|File) attached: [^\]]+\]/g, '').replace(/\[Image #\d+\]/g, '').replace(/\s+/g, ' ').trim()
function isEcho(meta, text) {
  const now = Date.now()
  meta.echo = (meta.echo ?? []).filter((x) => now - x.at < 30 * 60_000)
  const said = normal(text)
  const hit = meta.echo.filter((x) => (x.norm ? said.includes(x.norm.slice(0, 200)) : said === ''))
  if (!hit.length) return false
  meta.echo = meta.echo.filter((x) => !hit.includes(x))
  return true
}
/** Log what a person said from the page (or Slack), and expect it back from the transcript. */
function logSaid(meta, id, text, { via = 'web', images } = {}) {
  meta.echo = [...(meta.echo ?? []), { id, norm: normal(text), at: Date.now() }].slice(-50)
  meta.lastMine = true
  logEvents(meta, [{ k: 'user', id, via, text, ...(images?.length ? { images } : {}) }])
}

/** Transcript lines → events, taking the title and the model out as facts about the session. */
function convert(meta, lines) {
  const out = []
  const copied = copiedInFork(meta)
  for (const line of lines) {
    trackBackground(meta, line)
    if (copied?.size && copied.has(uuidOf(line))) continue
    for (const e of lineToEvents(line, { cwd: meta.cwd, home: meta.home, silent: (meta.silentTools ??= new Set()), image: (type, data) => imageRef(meta.uid, type, data) })) {
      if (e.k === 'user' && isEcho(meta, e.text)) continue
      // What the bridge itself typed into the session (a correction, what a refresh cut off, a hand-over) is not
      // something the person said.
      // Claude Code writes the typed line and the command line both.
      if (e.k === 'user' && e.text === COMPACT_TEXT) continue
      if (e.k === 'user' && /^(\[정정\] |\[새로고침\] |\[이전 대화에서 이어감 |지금까지의 대화를 이어받을 다음 세션이 읽을 SESSION\.md|Write SESSION\.md in the working folder now|Continue the work described in this handover)/.test(e.text)) continue
      // What the list says about a working session: which calls are open, whether it writes code, whether it
      // is in a PR review loop (the 코딩 중 and PR 리뷰 루프 badges).
      if (e.k === 'tool') {
        ;(meta.openTools ??= new Set()).add(e.tool)
        if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(e.name)) meta.coding = true
        if (e.name === 'Skill' && /pr-review-loop/.test(e.label ?? '')) meta.reviewLoop = true
      } else if (e.k === 'tool_end') {
        meta.openTools?.delete(e.tool)
        if (meta.reviewLoop && /ROUND_CLEAN|ROUND_ABORT/.test(e.text ?? '')) meta.reviewLoop = false
      } else if (e.k === 'text' && meta.reviewLoop && /ROUND_CLEAN|ROUND_ABORT/.test(e.text ?? '')) meta.reviewLoop = false
      if (e.k === 'text' && meta.reportAuto && REPORT_DONE_RE.test(e.text ?? '')) meta.reportDeployed = true
      if (e.k === 'title') meta.manualTitle || (meta.title = e.title)
      else if (e.k === 'model') {
        // The model actually answering differs in family from the one asked for: what was asked for is stale.
        const family = (m) => /(opus|sonnet|haiku|fable)/.exec(m || '')?.[1]
        if (meta.launchModel && family(meta.launchModel) && family(e.model) && family(meta.launchModel) !== family(e.model)) meta.launchModel = ''
        meta.model = e.model
      }
      else out.push(e)
    }
  }
  return out
}

/**
 * A session's event log, parsed. Kept for the sessions read lately: the file only grows (logEvents appends), so a
 * later read parses only the lines added since. Before this every page of a long conversation re-read and
 * re-parsed the whole file (8,000 events: 8 ms each, 35 ms at ten at once, and garbage enough to triple the
 * process's memory). A file that is shorter than before, or replaced, is read again whole. The array is shared:
 * callers filter and slice it, never change it.
 */
const EVENT_CACHE_MAX = 24
const eventCache = new Map() // file -> { size, ino, rest, events }
/** The events.jsonl an older server wrote (REQ-S-075): read until it is moved to the Mac and cleared, never written. */
function readLegacyEvents(meta, keep = true) {
  const file = eventsFile(meta)
  let st
  try {
    st = fs.statSync(file)
  } catch {
    eventCache.delete(file)
    return []
  }
  let hit = eventCache.get(file)
  if (hit && (hit.ino !== st.ino || st.size < hit.size)) hit = null
  if (!hit) hit = { size: 0, ino: st.ino, rest: '', events: [] }
  if (st.size > hit.size) {
    const fd = fs.openSync(file, 'r')
    let text
    try {
      const buf = Buffer.alloc(st.size - hit.size)
      fs.readSync(fd, buf, 0, buf.length, hit.size)
      text = hit.rest + buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
    const lines = text.split('\n')
    // A line cut where the file ended is kept for the next read, when the rest of it has arrived.
    hit.rest = lines.pop() ?? ''
    for (const l of lines) {
      if (!l) continue
      try {
        hit.events.push(JSON.parse(l))
      } catch {}
    }
    hit.size = st.size
  }
  // A sweep over every session (the statistics) uses what is kept but does not push the open conversations out.
  if (!keep && !eventCache.has(file)) return hit.events
  eventCache.delete(file)
  eventCache.set(file, hit)
  if (eventCache.size > EVENT_CACHE_MAX) eventCache.delete(eventCache.keys().next().value)
  return hit.events
}

// Sessions from before the event log start counting from nothing: their old transcript copy is not read again
// (REQ-S-069: the server keeps no conversation; the operator clears that copy, REQ-S-075).
for (const meta of sessions.values()) {
  if (meta.seq != null || fs.existsSync(eventsFile(meta))) continue
  meta.seq = 0
  dirty.add(meta.id)
}

// lastAt from before MOVES counted every notice: worked out again once from the end of each log.
for (const meta of sessions.values()) {
  if (meta.lastAtV === 2) continue
  try {
    const file = eventsFile(meta)
    const size = fs.statSync(file).size
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(Math.min(size, 256 * 1024))
    try {
      fs.readSync(fd, buf, 0, buf.length, size - buf.length)
    } finally {
      fs.closeSync(fd)
    }
    const tail = buf.toString('utf8').split('\n').slice(buf.length < size ? 1 : 0).flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
    const at = movedAt(tail)
    if (at) meta.lastAt = at
  } catch {}
  meta.lastAtV = 2
  dirty.add(meta.id)
}

// ---------- usage statistics ----------

/**
 * Counted from every session's event log. A turn is from "busy" to the next state that
 * is not; one left open counts up to now if its last event is within 30 minutes, and never longer than 30.
 */
const prSearches = new Map()
async function prStatsOf(uid, days) {
  let got = prSearches.get(uid)
  if (!got || Date.now() - got.at > 600_000) {
    const hostId = Object.keys(hosts).find((h) => hosts[h].uid === uid && online(h))
    if (!hostId) return null
    got = { at: Date.now(), run: ask(hostId, { t: 'prsearch' }, 120_000).then((r) => (r.ok ? r.prs : null), () => null) }
    prSearches.set(uid, got)
  }
  const prs = await got.run
  if (!prs) return (prSearches.delete(uid), null)
  const mine = new Set(prs.map((p) => p.url))
  const linked = new Set()
  // The links each Mac found in its conversations (REQ-S-070), and the newest ones not yet reported.
  for (const m of sessions.values()) {
    if (m.uid !== uid) continue
    for (const u of m.prLinks ?? []) if (mine.has(u)) linked.add(u)
    for (const e of readEvents(m)) if (e.k === 'user' || e.k === 'text') for (const u of String(e.text ?? '').match(/https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) ?? []) if (mine.has(u)) linked.add(u)
  }
  return { ...prSummary(prs, Date.now(), days), linked: linked.size }
}

/** The statistics, kept 30 s per person and range: the window is opened and its range switched, not watched. */
const statsCache = new Map()
function computeStats(uid, days) {
  const key = `${uid}|${days}`
  const hit = statsCache.get(key)
  if (hit && Date.now() - hit.at < 30_000) return hit.value
  const value = computeStatsFresh(uid, days)
  statsCache.set(key, { at: Date.now(), value })
  for (const [k, v] of statsCache) if (Date.now() - v.at > 60_000) statsCache.delete(k)
  return value
}
/**
 * The statistics from the numbers each Mac worked out (REQ-S-070). A session the Mac has not reported yet is counted
 * once from the copy an older server kept, while there is one.
 */
const legacyStats = new Map()
function computeStatsFresh(uid, days) {
  const now = Date.now()
  const list = []
  for (const meta of sessions.values()) {
    if (meta.uid !== uid || (meta.lastAt ?? meta.updatedAt) < now - days * 86_400_000) continue
    let stats = meta.stats
    if (!stats && !meta.agentLog && fs.existsSync(eventsFile(meta))) {
      const hit = legacyStats.get(meta.id)
      stats = hit && now - hit.at < 600_000 ? hit.stats : sessionStats(readLegacyEvents(meta, false), now)
      if (!hit || hit.stats !== stats) legacyStats.set(meta.id, { at: now, stats })
    }
    if (stats) list.push({ stats, cwd: meta.cwd, id: meta.id })
  }
  return addStats(list, days, now)
}

// ---------- per-host live status ----------

/** hostId -> what the server currently knows about that host's agent and bridge page. In memory only. */
const liveStatus = new Map()
function live(hostId) {
  if (!liveStatus.has(hostId)) liveStatus.set(hostId, { connectedAt: null, disconnectedAt: null, connects: 0, health: null, healthAt: null, page: null, pageAt: null, rtt: null, rttAt: null, stale: false, errors: 0, lastError: null })
  return liveStatus.get(hostId)
}

// ---------- per-host log ----------

const hostLogFile = (uid, hostId) => path.join(userDir(uid), 'hosts', `${hostId}.log`)

/**
 * One line in a host's log: what happened, on whose which host, during what, for which session.
 * Agent lines (src 'agent'), bridge page lines ('page') and the server's own view of that host ('server') share the file,
 * and every line is also printed to stdout with the user and host named, for whoever runs the server, without what it
 * says (REQ-S-074): that stays in the owner's log.
 */
function record(uid, hostId, entry) {
  const e = {
    ts: Number(entry.ts) || Date.now(),
    src: entry.src || 'server',
    level: ['info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info',
    area: String(entry.area || '').slice(0, 40),
    sid: safeId(entry.sid) ? entry.sid : undefined,
    // An older agent still sends a git error with the token in the remote address as written.
    text: hideRemotes(entry.text).slice(0, 2000),
  }
  const file = hostLogFile(uid, hostId)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (fs.existsSync(file) && fs.statSync(file).size > LOG_ROTATE) fs.renameSync(file, `${file}.1`)
    fs.appendFileSync(file, `${JSON.stringify(e)}\n`, { mode: 0o600 })
  } catch (err) {
    log('log write failed', err.message)
  }
  if (e.level === 'error') {
    const st = live(hostId)
    st.errors++
    st.lastError = { ts: e.ts, src: e.src, area: e.area, sid: e.sid, text: e.text.slice(0, 300) }
  }
  console.log(`${new Date(e.ts).toISOString()} ${e.level.toUpperCase().padEnd(5)} user=${users[uid]?.login ?? uid} host=${hosts[hostId]?.name ?? hostId.slice(0, 8)} src=${e.src} [${e.area}]${e.sid ? ` sid=${e.sid.slice(0, 8)}` : ''}`)
}

function readHostLog(uid, hostId, { sid, level }) {
  const file = hostLogFile(uid, hostId)
  const lines = [`${file}.1`, file].flatMap((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n') : []))
  const out = []
  for (let i = lines.length - 1; i >= 0 && out.length < LOG_VIEW; i--) {
    if (!lines[i]) continue
    try {
      const e = JSON.parse(lines[i])
      if ((!sid || e.sid === sid) && (!level || e.level === level || (level === 'warn' && e.level === 'error'))) out.push(e)
    } catch {}
  }
  return out.reverse()
}

// ---------- live connections ----------

/** hostId -> SSE response of that host's bridge page */
const bridges = new Map()
/** uid -> Set of SSE responses of control pages */
const controls = new Map()
/** reqId -> { resolve, timer } */
const pending = new Map()

const online = (hostId) => bridges.has(hostId)
/** The connected Macs that are real: the demo Mac (REQ-F-766) is never asked anything for the whole server. */
const realBridges = () => [...bridges.keys()].filter((h) => !isDemoHost(h))
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)

function toHost(hostId, cmd) {
  const res = bridges.get(hostId)
  if (!res) return false
  const flushed = sse(res, cmd)
  trace(hostId, `down ${cmd.t}${cmd.reqId ? ` req=${cmd.reqId.slice(0, 8)}` : ''} buffered=${!flushed} writable=${res.writable} pendingBytes=${res.writableLength}`)
  return true
}

/**
 * When the host's link is down for a moment (the bridge tab reconnecting, its page reloading after a deploy), a
 * command waits for it to come back instead of failing at once: up to HOST_BACK_MS, then it is sent.
 */
const HOST_BACK_MS = 20_000
async function hostBack(hostId) {
  for (const until = Date.now() + HOST_BACK_MS; !bridges.has(hostId) && Date.now() < until; ) await new Promise((r) => setTimeout(r, 250))
  return bridges.has(hostId)
}

/** Send a command to a host and wait for the reply that carries the same reqId. */
async function ask(hostId, cmd, timeoutMs) {
  if (!bridges.has(hostId) && hosts[hostId]) await hostBack(hostId)
  return new Promise((resolve) => {
    const reqId = crypto.randomUUID()
    // The host asked: an answer is taken only from it (R1-I4).
    const entry = { resolve, got: false, hostId }
    const give = (error) => {
      clearTimeout(entry.timer)
      clearTimeout(entry.gotTimer)
      pending.delete(reqId)
      record(hosts[hostId].uid, hostId, { level: 'error', area: cmd.t, sid: cmd.sid, text: error })
      resolve({ ok: false, error })
    }
    // The bridge tab acknowledges a command as soon as it has it. No acknowledgement means the tab is not running,
    // which is a different problem from an agent that is slow to answer, and is known within seconds.
    entry.gotTimer = setTimeout(() => give('그 맥의 연동 탭이 명령을 받지 못했습니다. 탭이 멈췄거나 가려져 있을 수 있습니다 — 그 맥에서 연동 탭을 앞으로 가져오거나 새로고침해 주세요'), GOT_MS)
    entry.timer = setTimeout(() => give('에이전트가 명령을 받았지만 제때 답하지 않았습니다'), timeoutMs)
    const timer = entry.timer
    pending.set(reqId, entry)
    if (!toHost(hostId, { ...cmd, reqId })) {
      clearTimeout(entry.gotTimer)
      clearTimeout(timer)
      pending.delete(reqId)
      resolve({ ok: false, error: '호스트가 연결돼 있지 않습니다' })
    }
  })
}

function toControls(uid, obj) {
  const locked = obj.sid && sessions.get(obj.sid)?.lock
  if (locked && ['ev', 'preview', 'screen'].includes(obj.t)) {
    if (obj.t === 'ev') for (const res of controls.get(uid) ?? []) sse(res, { t: 'ev', sid: obj.sid, locked: true, last: sessions.get(obj.sid).seq ?? 0 })
    return
  }
  for (const res of controls.get(uid) ?? []) (obj.t === 'state' ? sendState(res, obj) : sse(res, obj))
  if (obj.t === 'ev' && sessions.get(obj.sid)) {
    const meta = sessions.get(obj.sid)
    for (const e of obj.events) plug.event(uid, csIds(meta).thread, csEvent(meta, e))
  }
}

// ---------- Slack-shaped sessions ----------
// The Slack plugin reads sessions as Slack threads: a row, its events, its cards as blocks (server/cs.mjs). What
// follows translates; nothing here decides anything.

let pidSeq = readJson(path.join(DATA, 'pid.json'), { n: 1000 }).n
/** The Slack plugin addresses a session by a thread key and a pid. Both are made once and kept with the session. */
function csIds(meta) {
  if (!meta.thread) (meta.thread = threadOf(meta)), dirty.add(meta.id)
  if (!meta.pid) {
    meta.pid = ++pidSeq
    writeJson(path.join(DATA, 'pid.json'), { n: pidSeq })
    dirty.add(meta.id)
  }
  return meta
}
const byThread = (uid, thread) => [...sessions.values()].find((m) => m.uid === uid && csIds(m).thread === thread)
const byPid = (uid, pid) => [...sessions.values()].find((m) => m.uid === uid && csIds(m).pid === Number(pid))
const csRow = (meta) => toCsSession(shielded(csIds(meta)), { thread: meta.thread, pid: meta.pid, host: hosts[meta.hostId], online: online(meta.hostId) })
const csRows = (uid) => [...sessions.values()].filter((m) => m.uid === uid && !m.closed).sort((a, b) => a.createdAt - b.createdAt).map(csRow)
/** The cards of a session by id: a fold is drawn from the card it folds. Built from the log once, then kept up. */
const cardsOf = (meta) => (meta.cardIndex ??= new Map(readEvents(meta).filter((e) => e.k === 'card').map((e) => [e.card.id, e.card])))
const csEvent = (meta, e) => toCsEvent(e, { pid: csIds(meta).pid, cards: cardsOf(meta), image: (id) => imgInfoOf(meta.uid)[id] })
/** Groups hold session ids here; GET /api/groups gives them as thread keys. */
function csGroups(uid) {
  const pf = prefsOf(uid)
  const key = (sid) => {
    const m = sessions.get(sid)
    return m && m.uid === uid ? csIds(m).thread : null
  }
  return { groups: pf.groups.map((g) => ({ id: g.id, name: g.name, items: g.items.map(key).filter(Boolean) })), loose: pf.loose.map(key).filter(Boolean), collapsed: pf.collapsed ?? [] }
}

/** Run one of the session routes for a caller that is not that HTTP request: a plugin, another route. */
async function sessionOp(uid, meta, op, data, method = 'POST', query = '') {
  let out = {}
  const res = { writeHead: () => res, end: (text) => (out = text ? JSON.parse(text) : {}), headersSent: false }
  const req = { method, headers: {}, internal: true, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(data ?? {})) } }
  await api(req, res, new URL(`http://x/api/sessions/${meta.id}${op ? `/${op}` : ''}${query}`), uid)
  return out
}

const CS_OPTIONS = {
  models: [['Fable 5.1 (1M)', 'claude-fable-5-1[1m]'], ['Fable 5.1', 'claude-fable-5-1'], ['Opus 5.5 (1M)', 'claude-opus-5-5[1m]'], ['Opus 5.5', 'claude-opus-5-5'], ['Sonnet 5.5', 'claude-sonnet-5-5'], ['Haiku 5.5', 'claude-haiku-5-5'], ['Opus 5', 'claude-opus-5'], ['Sonnet 5', 'claude-sonnet-5'], ['Haiku 4.5', 'claude-haiku-4-5-20251001'], ['Opus plan / Sonnet work', 'opusplan'], ['Default', 'default']].map(([label, value]) => ({ label, value })),
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  modes: [['manual · 편집·명령마다 물어봄', 'default'], ['acceptEdits · 파일 편집은 자동 승인', 'acceptEdits'], ['plan · 계획만 세우고 실행 안 함', 'plan'], ['auto · 거의 모두 자동 승인', 'auto'], ['전부 허용', 'autoAllow']].map(([label, value]) => ({ label, value })),
}

// The model list the new-session page offers. It starts as CS_OPTIONS.models and, while `auto` is on (the
// operator's switch, on by default), follows Claude Code's own catalog: a Mac is asked for it (agent `models`)
// every MODELS_EVERY_MS and when the operator presses 지금 확인. Kept in models.json.
const MODELS_FILE = path.join(DATA, 'models.json')
const MODELS_EVERY_MS = 6 * 3_600_000
const models = { auto: true, list: null, checkedAt: null, changedAt: null, source: null, error: null, added: [], removed: [], ...readJson(MODELS_FILE, {}) }
const modelList = () => (Array.isArray(models.list) && models.list.length ? models.list : CS_OPTIONS.models)

let modelsRun = null
/** Ask one Mac (the operators' first, else any connected one) for the catalog and keep the list it makes. */
function refreshModels(why) {
  return (modelsRun ??= (async () => {
    const online = realBridges().filter((h) => hosts[h])
    const hostId = online.find((h) => isAdmin(hosts[h].uid)) ?? online[0]
    models.checkedAt = Date.now()
    if (!hostId) {
      models.error = '연결된 맥이 없어 확인하지 못했어요'
      return writeJson(MODELS_FILE, models)
    }
    const r = await ask(hostId, { t: 'models' }, 45_000)
    if (!r.ok || !Array.isArray(r.models) || !r.models.length) {
      models.error = `${hosts[hostId].name}: ${r.error || '모델 목록을 받지 못했어요'}${/답하지|응답/.test(r.error ?? '') ? ' (에이전트가 예전 버전이면 새 버전으로 바뀐 뒤 돼요)' : ''}`
      return writeJson(MODELS_FILE, models)
    }
    const before = modelList()
    const next = modelsFromCatalog(r.models, before)
    models.error = null
    models.source = { hostId, name: hosts[hostId].name, version: String(r.version ?? '') }
    if (JSON.stringify(next) !== JSON.stringify(before)) {
      models.added = next.filter((m) => !before.some((b) => b.value === m.value)).map((m) => m.label)
      models.removed = before.filter((b) => !next.some((m) => m.value === b.value)).map((b) => b.label)
      models.list = next
      models.changedAt = Date.now()
      log(`models (${why}): ${next.length}개로 바꿈 · 더함 ${models.added.join(', ') || '없음'} · 뺌 ${models.removed.join(', ') || '없음'}`)
    }
    writeJson(MODELS_FILE, models)
  })().finally(() => (modelsRun = null)))
}
// Looked at every 10 minutes; a Mac is asked only when the last check is MODELS_EVERY_MS old (or never made).
setInterval(() => models.auto && Date.now() - (models.checkedAt ?? 0) >= MODELS_EVERY_MS && realBridges().length && refreshModels('auto').catch((e) => log('models', e)), 600_000).unref?.()
const modelsView = () => ({ auto: models.auto, list: modelList(), checkedAt: models.checkedAt, changedAt: models.changedAt, source: models.source, error: models.error, added: models.added, removed: models.removed, everyMs: MODELS_EVERY_MS })

// ---------- where a session is driven from ----------
// A session is driven from one place at a time: the bridge (the web pages) or Slack (the Slack plugin). The
// other place shows it and points to where it went, and nothing typed there reaches the session.
const seatOf = (meta) => (meta.seat?.where === 'slack' ? 'slack' : 'web')
const SEAT_AWAY = {
  slack: '이 세션은 Slack 에서 작업 중이에요. 웹에서는 읽기만 할 수 있어요. 브릿지로 가져온 뒤 보내 주세요.',
  web: '이 세션은 브릿지에서 작업 중이에요. Slack 으로 가져온 뒤 보내 주세요.',
}
/** Refuses what comes from the place the session is not in. `via` is 'slack' for the Slack plugin, else the web. */
function seatGuard(meta, via) {
  const where = seatOf(meta)
  if ((via === 'slack' ? 'slack' : 'web') !== where) throw Object.assign(new Refuse(409, SEAT_AWAY[where]), { extra: { seat: where } })
}
/** What a page may not do to a session that is worked on in Slack: everything that drives it. */
const SEAT_DRIVES = new Set(['say', 'do', 'send', 'retract', 'sendnow', 'esc', 'dropheld', 'answer', 'setting', 'refresh', 'report', 'btw', 'trash', 'resume', 'lightfork', 'trimlog', 'fork', 'key', 'move', 'cwd'])
/** The page of a session, for a link from elsewhere. */
const sessionLink = (meta) => `${ORIGIN || `http://localhost:${PORT}`}/s/${meta.id}`

/**
 * Moves a session to the bridge or to Slack. Into Slack, the plugin makes (or reuses) the thread and gives back
 * its address; out of it, the plugin says in the thread where the work went. Both sides keep the whole conversation:
 * the session's log has what was said in Slack, and the thread links back to the session's page.
 */
async function moveSeat(uid, meta, to) {
  if (to !== 'web' && to !== 'slack') throw new Refuse(400, '옮길 곳이 올바르지 않아요')
  const from = seatOf(meta)
  if (from === to) return { ok: true, note: to === 'slack' ? '이미 Slack 에서 작업 중이에요' : '이미 브릿지에서 작업 중이에요', url: meta.seat?.url ?? null }
  const thread = csIds(meta).thread
  if (to === 'slack') {
    if (meta.lock) throw new Refuse(409, '잠긴 세션은 Slack 으로 옮길 수 없어요. 잠금을 없앤 뒤 옮겨 주세요')
    const place = plug.instance(uid, 'slack')
    if (!place?.moveIn || place.status?.().state !== 'on') throw new Refuse(409, 'Slack 플러그인이 켜져 있지 않아요. 설정 → 플러그인에서 켜 주세요')
    let url = null
    try {
      url = (await place.moveIn(thread)).url ?? null
    } catch (e) {
      throw new Refuse(502, `Slack 으로 옮기지 못했어요: ${e.message}`)
    }
    // Said while the seat is still here, so the plugin does not post it into the thread it just set up.
    logEvents(meta, [{ k: 'notice', icon: 'move', text: `Slack 으로 옮겼어요. 이제 Slack 스레드에서 이어서 작업해요. 여기서는 읽기만 할 수 있어요.${url ? ` [Slack 스레드 열기](${url})` : ''}` }])
    meta.seat = { where: 'slack', at: Date.now(), url }
  } else {
    const url = meta.seat?.url ?? null
    meta.seat = { where: 'web', at: Date.now(), url }
    logEvents(meta, [{ k: 'notice', icon: 'move', text: `브릿지로 옮겼어요. Slack 에서 나눈 대화도 이 화면에 그대로 있어요.${url ? ` [Slack 스레드 열기](${url})` : ''}` }])
    plug.instance(uid, 'slack')?.moveOut?.(thread)
  }
  touch(meta)
  broadcastState(uid)
  return { ok: true, note: to === 'slack' ? 'Slack 으로 옮겼어요' : '브릿지로 옮겼어요', url: meta.seat.url ?? null }
}

/**
 * What 지금 압축 (REQ-F-776) types into the session: a /compact that says what to keep. It is the bridge's, not the
 * person's words: the conversation shows a notice instead, and the command line the transcript records for it is
 * left out (convert).
 */
const COMPACT_TEXT = '/compact 이어서 할 수 있게 지금까지의 결정과 이유, 관련 파일, 진행 상황, 다음에 할 일을 남겨 주세요'

/** A command as a Slack card or a `:` line sends it: `<pid>:<what> [arguments]`. Returns the note to show. */
async function csCommand(uid, value, opts = {}) {
  const m = /^(\d+):(\S+)\s*([\s\S]*)$/.exec(String(value ?? ''))
  const meta = m && byPid(uid, m[1])
  if (!meta) throw new Refuse(400, '이미 끝난 세션이에요')
  if (meta.lock && !opts.unlocked) throw new Refuse(423, LOCKED)
  seatGuard(meta, opts.via)
  const [cmd, arg] = [m[2], m[3].trim()]
  const op = (name, data) => sessionOp(uid, meta, name, data)
  if (cmd === 'card') {
    const [card, n] = arg.split(/\s+/)
    if (n === 'esc' || n === 'enter') await op('answer', { card, n })
    else await op('answer', { card, n: Number(n) })
  } else if (cmd === 'sendnow' || cmd === 'esc') await op(cmd)
  else if (cmd === 'dropheld') await op('dropheld', {})
  else if (cmd === 'continue') await csSend(uid, meta, '계속해', [], undefined, opts)
  else if (cmd === 'refresh') await op('refresh', { when: ['later', 'cancel'].includes(arg) ? arg : 'now' })
  else if (cmd === 'exit') await op('close', {})
  else if (cmd === 'status') {
    await op('report', {})
    const st = meta.state
    const head = st.phase === 'busy' ? '⏳ 작업 중' : st.phase === 'waiting' ? '⏸ 응답 대기' : '🟢 대기'
    logEvents(meta, [{ k: 'line', text: [head, `모델 ${meta.launchModel || meta.model || '?'}`, st.effort && `effort ${st.effort}`, st.mode && `권한 ${st.mode}`, st.context && `컨텍스트 ${st.context}`].filter(Boolean).join(' · ') }])
  }
  else if (cmd === 'lightfork') {
    // It takes minutes (the session writes SESSION.md first): the press is answered now, and a failure is said
    // in the conversation when it is known.
    op('lightfork', { mode: arg }).then(
      (r) => {
        if (!r.ok) return
        // The work goes on in the new session: the original is put to rest.
        meta.resting = true
        touch(meta)
        broadcastState(uid)
      },
      (e) => logEvents(meta, [{ k: 'line', text: `❌ 가벼운 복제로 새 세션을 열지 못했어요. ${e.message}` }]),
    )
    return arg === 'cut' ? '앞부분만 넘겨요' : `가벼운 복제를 시작했어요. 이 세션이 ${meta.mdFile || meta.state?.mdFile || 'SESSION.md'} 를 쓰고 나면 새 세션이 떠요`
  }
  else if (cmd === 'auto') {
    await op('settings', { autoAllow: arg === 'on' })
    return arg === 'on' ? '전부 허용을 켰어요' : '전부 허용을 껐어요'
  } else if (cmd === 'rest') {
    await op('settings', { resting: arg === 'on' })
    return arg === 'on' ? '휴면으로 뒀어요' : '휴면을 풀었어요'
  } else if (cmd === 'mode' && arg === 'autoAllow') {
    // Not a Claude Code mode: the agent answers the permission requests itself.
    await op('settings', { autoAllow: true })
    return '전부 허용을 켰어요'
  } else if (['model', 'effort', 'mode'].includes(cmd)) {
    if (cmd === 'mode' && (meta.state.autoAllow || meta.autoAllow)) await op('settings', { autoAllow: false })
    await op('setting', { kind: cmd, value: arg })
    return cmd === 'mode' ? '권한 모드를 바꿨어요' : '눌렀어요'
  } else if (cmd === 'compact') {
    if (!meta.state.alive || meta.state.phase !== 'idle') throw new Refuse(409, '쉬고 있는 세션만 압축할 수 있어요')
    toHost(liveHost(meta), { t: 'send', sid: meta.id, id: crypto.randomUUID(), text: COMPACT_TEXT })
    logEvents(meta, [{ k: 'notice', tone: 'info', text: '🗜️ 컨텍스트 압축을 요청했어요. 끝나면 이 세션에서 그대로 이어가요' }])
    return '압축을 요청했어요'
  } else if (cmd === 'screen') {
    // The 화면 button on a card: what the terminal shows now, said in the conversation.
    const r = await ask(liveHost(meta), { t: 'screen', sid: meta.id }, 15_000)
    logEvents(meta, [{ k: 'local', text: String(r.text ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s+$/gm, '').trim().split('\n').slice(-60).join('\n') || '(빈 화면)' }])
  }
  else throw new Refuse(400, '알 수 없는 명령이에요')
  return '눌렀어요'
}

/** A message from the page: a side question goes its own way, everything else is sent as it is. */
async function csSend(uid, meta, text, images, via, opts = {}) {
  if (meta.lock && !opts.unlocked) throw new Refuse(423, LOCKED)
  // The commands below ("계속해", ":esc", …) come from the same place as the message.
  opts = { ...opts, via: via ?? opts.via }
  seatGuard(meta, opts.via)
  const btw = /^[/:]btw\s+([\s\S]+)/.exec(text.trim())
  // A line that starts with ":" is a command for the bridge, not something to say to the session (REQ-F-057).
  const colon = !btw && /^:([a-z]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (colon) {
    const [cmd, arg] = [colon[1], (colon[2] ?? '').trim()]
    const pid = csIds(meta).pid
    if (cmd === 'rename') {
      if (!arg) throw new Refuse(400, '이름이 비어 있어요')
      await sessionOp(uid, meta, 'settings', { title: arg })
      logEvents(meta, [{ k: 'line', text: `✏️ 이름: *${arg.slice(0, 80)}*` }])
    } else if (cmd === 'retract') await sessionOp(uid, meta, 'retract', {})
    else if (cmd === 'answer') {
      if (!meta.card?.open || !/^\d+$/.test(arg)) throw new Refuse(400, '답할 질문이 없거나 번호가 아니에요. 예: :answer 2')
      await csCommand(uid, `${pid}:card ${meta.card.id} ${arg}`, opts)
    } else if (cmd === 'kill') await sessionOp(uid, meta, 'close', {})
    else if (cmd === 'sudo' || cmd === 'root') sudoCommand(uid, meta, arg, opts)
    else if (['esc', 'sendnow', 'dropheld', 'refresh', 'exit', 'status', 'lightfork', 'compact', 'auto', 'rest', 'screen', 'model', 'effort', 'mode', 'continue'].includes(cmd)) await csCommand(uid, `${pid}:${cmd} ${arg}`, opts)
    else throw new Refuse(400, `모르는 명령이에요: :${cmd}. 쓸 수 있는 것: :status :screen :esc :sendnow :dropheld :refresh :retract :rename 이름 :answer 번호 :auto on|off :model 값 :effort 값 :mode 값 :lightfork :compact :rest :kill :btw 질문 :sudo 명령`)
    return { ok: true }
  }
  if (!btw) return sessionOp(uid, meta, 'send', { text, images, via, ...(opts.videos?.length ? { videos: opts.videos } : {}) })
  const id = crypto.randomUUID()
  const q = btw[1].trim()
  logEvents(meta, [{ k: 'side', id, q }])
  sessionOp(uid, meta, 'btw', { text: q }).then(
    (r) => logEvents(meta, [{ k: 'side', id, q, update: true, ...(r.ok ? { answer: r.answer } : { error: r.error || '답을 화면에서 읽지 못했어요. 화면을 확인하세요' }) }]),
    (e) => logEvents(meta, [{ k: 'side', id, q, update: true, error: e.message }]),
  )
  return { ok: true }
}

// ---------- plugins ----------
// What a person added to their own bridge (server/plugins.mjs). A plugin is lent these calls and nothing else:
// it acts as that person, through the same routes the page uses.
const pluginsFile = (uid) => path.join(userDir(uid), 'plugins.json')
const pluginCache = new Map()
const plug = plugins({
  load: (uid) => (pluginCache.has(uid) ? pluginCache : pluginCache.set(uid, readJson(pluginsFile(uid), {}))).get(uid),
  store: (uid, all) => (fs.mkdirSync(userDir(uid), { recursive: true }), writeJson(pluginsFile(uid), all)),
  log,
  // A plugin turned on or off changes what the session menu offers (Slack 으로 옮기기).
  changed: (uid) => broadcastState(uid),
  host: (uid) => ({
    origin: ORIGIN || `http://localhost:${PORT}`,
    code: () => crypto.randomBytes(16).toString('hex'),
    sessions: () => csRows(uid),
    find: (thread) => (byThread(uid, thread) ? csRow(byThread(uid, thread)) : null),
    command: (value) => csCommand(uid, value, { via: 'slack' }),
    /** Where the session is driven from, and the page to go to for it. */
    seat(thread) {
      const meta = byThread(uid, thread)
      return meta ? { where: seatOf(meta), link: sessionLink(meta), closed: !!meta.closed } : null
    },
    /** What a thread says about a session when it comes in from the bridge. */
    summary(thread) {
      const meta = byThread(uid, thread)
      if (!meta) return null
      const said = readEvents(meta).slice(-400).filter((e) => e.k === 'text' && e.text).at(-1)
      return { title: meta.title || '', host: hosts[meta.hostId]?.name ?? '', cwd: tilde(meta) ?? '', last: said?.text ?? (meta.lastMine ? '' : meta.last ?? ''), link: sessionLink(meta) }
    },
    /** A thread's address once it is known: the session page links to it. */
    seatUrl(thread, url) {
      const meta = byThread(uid, thread)
      if (!meta || seatOf(meta) !== 'slack' || typeof url !== 'string') return
      meta.seat = { ...meta.seat, url: url.slice(0, 500) }
      touch(meta)
      broadcastState(uid)
    },
    moveTo: (thread, to) => {
      const meta = byThread(uid, thread)
      if (!meta) throw new Refuse(400, '세션을 찾지 못했어요')
      return moveSeat(uid, meta, to)
    },
    async send(thread, text, images) {
      const meta = byThread(uid, thread)
      if (!meta || meta.closed) throw new Refuse(400, '이미 끝난 세션이에요')
      return csSend(uid, meta, text, images ?? [], 'slack')
    },
    // `places` (set with buttons in the plugin's settings): {main: hostId, dirs: {hostId: folder}}. On the main Mac
    // when it is connected, else the first connected one, in the folder set for that Mac (else `cwd`). A folder that
    // is not there yet is made.
    async start({ prompt, cwd, places }) {
      const ids = Object.keys(hosts).filter((h) => hosts[h].uid === uid && online(h))
      if (!ids.length) throw new Refuse(400, '연결된 맥이 없어요. 맥의 브라우저에서 Agent Bridge 를 열어 두세요.')
      let pl = {}
      try {
        pl = JSON.parse(places || '{}') ?? {}
      } catch {}
      const hostId = ids.includes(pl.main) ? pl.main : ids[0]
      const dir = typeof pl.dirs?.[hostId] === 'string' && pl.dirs[hostId] ? pl.dirs[hostId] : cwd
      let out = {}
      const fres = { writeHead: () => fres, end: (t) => (out = JSON.parse(t)), headersSent: false }
      const freq = { method: 'POST', headers: {}, internal: true, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ hostId, cwd: dir, prompt, via: 'slack', create: true })) } }
      await api(freq, fres, new URL('http://x/api/sessions'), uid)
      return { thread: csIds(sessions.get(out.id)).thread }
    },
  }),
})

/** A session's folder the short way: the home folder as ~. */
const tilde = (meta) => {
  const home = meta.home || hosts[meta.hostId]?.home
  return home && (meta.cwd === home || meta.cwd?.startsWith(`${home}/`)) ? `~${meta.cwd.slice(home.length)}` : meta.cwd
}

/** The same thing asked twice within a moment (a double tap, a retry that crossed its answer) is done once. */
const recentKeys = new Map()
function seenJustNow(key, ms = 1500) {
  const now = Date.now()
  for (const [k, t] of recentKeys) if (now - t > ms) recentKeys.delete(k)
  if (recentKeys.has(key)) return true
  recentKeys.set(key, now)
  return false
}

// A PR's state as gh last told it, by its address: { at, pr }. Shared by every session that mentions it.
const prStates = new Map()
const PR_PAGE = 8

/**
 * The folder's own pull requests, then the ones the conversation mentions, the most recently mentioned first. Only
 * the first `limit` mentioned are looked up (their state asked of gh on the Mac, 8 to a call); `more` counts the rest.
 */
async function sessionLinks(meta, limit = PR_PAGE) {
  const own = (meta.folder?.repos ?? []).filter((x) => x.pr).map((x) => ({ url: x.pr.url, label: `#${x.pr.number} ${x.pr.title}`, state: x.pr.state, number: x.pr.number }))
  let mentioned = []
  let more = 0
  if (online(meta.hostId)) {
    // The Mac's list (newest first, REQ-S-070) after what this server saw since, newest first too.
    const found = readEvents(meta).slice(-2000).filter((e) => e.k === 'text' || e.k === 'user').flatMap((e) => String(e.text ?? '').match(/https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) ?? [])
    const urls = [...new Set([...found.reverse(), ...(meta.prLinks ?? [])])].filter((u) => !own.some((o) => o.url === u))
    const want = urls.slice(0, Math.max(1, Math.min(100, limit)))
    more = urls.length - want.length
    const stale = want.filter((u) => !(Date.now() - (prStates.get(u)?.at ?? 0) < 60_000))
    const chunks = []
    for (let i = 0; i < stale.length; i += PR_PAGE) chunks.push(stale.slice(i, i + PR_PAGE))
    await Promise.all(
      chunks.map(async (part) => {
        const r = await ask(meta.hostId, { t: 'prstates', urls: part }, 15_000).catch(() => null)
        if (r?.ok) for (const pr of r.prs) prStates.set(pr.url, { at: Date.now(), pr })
      }),
    )
    mentioned = want.flatMap((u) => {
      const x = prStates.get(u)?.pr
      return x ? [{ url: x.url, label: `#${x.number}${x.title ? ` ${x.title}` : ''}`, state: x.state, number: x.number }] : []
    })
  }
  return { prs: [...own, ...mentioned], more, threads: [] }
}
const linksLimit = (url) => Number(url.searchParams.get('limit')) || PR_PAGE

let qualityCache = null
/** The plugin, new-session option and group routes. Returns true when the request was one of them. */
async function pageApi(req, res, url, uid) {
  const p = url.pathname
  const get = req.method === 'GET'
  const post = req.method === 'POST'
  const ok = (note = '', more = {}) => json(res, 200, { ok: true, note, ...more })
  const fail = (e) => {
    if (!(e instanceof Refuse)) throw e
    return json(res, 400, { ok: false, note: e.message, ...(e.extra ?? {}) })
  }

  if (get && p === '/api/plugins') return json(res, 200, { plugins: plug.list(uid) }), true
  // R1-M2: opening the link only asks; connecting is a form post from this page (its Origin is checked where the
  // request comes in). A link someone else got for their own Slack id, opened by the owner, connects nobody.
  if ((get || post) && p === '/api/plugins/slack/link') {
    const html = (note) => res.writeHead(200, { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(page('Slack 연결', note))
    const inst = plug.instance(uid, 'slack')
    if (!inst?.link) return html('Slack 플러그인이 꺼져 있어요.'), true
    if (post) {
      const code = new URLSearchParams(await rawBody(req, 4096)).get('code') ?? ''
      return html(escHtml(inst.link(code))), true
    }
    const code = String(url.searchParams.get('code') ?? '')
    const who = await inst.who(code)
    if (!who) return html('링크가 만료됐어요. Slack 채널에 글을 다시 써 주세요.'), true
    return html(`Slack 사용자 <b>${escHtml(who.name)}</b> (${escHtml(who.user)}) 를 내 Agent Bridge 계정(${escHtml(users[uid]?.login ?? '')})에 연결할까요? 연결하면 이 Slack 사용자가 채널에서 내 맥에 세션을 띄우고 글을 보낼 수 있어요. 내 Slack 계정이 아니면 연결하지 마세요.</p><form method="post"><input type="hidden" name="code" value="${escHtml(code)}"><button type="submit">연결</button></form><p>`), true
  }
  const pc = /^\/api\/plugins\/([a-z0-9-]{1,40})\/choices$/.exec(p)
  if (post && pc) {
    const b = await body(req, 16 * 1024)
    try {
      return json(res, 200, { ok: true, choices: await plug.choices(uid, pc[1], String(b.key ?? ''), b.config) }), true
    } catch (e) {
      return json(res, 400, { ok: false, note: e.message }), true
    }
  }
  const pl = /^\/api\/plugins\/([a-z0-9-]{1,40})$/.exec(p)
  if (post && pl) {
    const b = await body(req, 16 * 1024)
    let notes = []
    try {
      if (b.remove === true) await plug.remove(uid, pl[1])
      else notes = (await plug.set(uid, pl[1], { enabled: b.enabled, config: b.config })).notes
    } catch (e) {
      return json(res, 400, { ok: false, note: e.message }), true
    }
    return ok([b.remove === true ? '플러그인을 뺐어요' : b.enabled === false ? '껐어요' : '저장했어요', ...notes].join('. '), { plugins: plug.list(uid) }), true
  }
  if (get && p === '/api/options') return json(res, 200, { ...CS_OPTIONS, models: modelList() }), true
  if (get && p === '/api/groups') return json(res, 200, csGroups(uid)), true
  if (post && p === '/api/groups') {
    try {
      const b = await body(req, 64 * 1024)
      const sid = (t) => byThread(uid, String(t ?? ''))?.id
      const r = groupOp(uid, { ...b, ...(b.op === 'move' ? { session: b.session ?? sid(b.thread), before: b.before ? (sid(b.before) ?? b.before) : null } : {}), ...(b.op === 'loose' ? { order: (Array.isArray(b.order) ? b.order : []).map(sid).filter(Boolean) } : {}) })
      if (r.held) {
        // Emptying a group deletes every session in it and in the groups inside it, as 목록에서 지우기 does one:
        // a live one is ended first, and the Mac's conversation files stay. A locked or moving one is left.
        const pf = prefsOf(uid)
        const gone = r.held.filter((id) => sessions.get(id)?.uid !== uid)
        for (const x of pf.groups) x.items = x.items.filter((i) => !gone.includes(i))
        const all = r.held.map((id) => sessions.get(id)).filter((m) => m?.uid === uid)
        const kept = all.filter((m) => m.lock || m.moving)
        for (const m of all) if (!kept.includes(m)) await sessionOp(uid, m, '', null, 'DELETE')
        const n = all.length - kept.length
        r.note = !all.length ? '그룹이 이미 비어 있어요.' : `세션 ${n}개를 지웠어요.${kept.length ? ` 잠겼거나 옮기는 중인 세션 ${kept.length}개는 남겼어요.` : ''}`
      }
      savePrefs(uid)
      return ok(r.note, r.id ? { id: r.id } : {}), true
    } catch (e) {
      return fail(e), true
    }
  }
  return false
}

/** Reopen a session in place (the conversation goes on) with the default prompt as it is now. */
function refreshSession(uid, meta, hostId, when = 'now') {
  toHost(hostId, { t: 'refresh', sid: meta.id, bg: (meta.bg ?? []).length, sysPrompt: sysPromptOf(uid), interrupted: (meta.bg ?? []).map((t) => `${{ agent: '에이전트', monitor: 'Monitor', bash: '백그라운드 명령' }[t.kind]}: ${t.label}`), when })
  // Reopened now: what ran in the background went with the old process.
  if (when === 'now') meta.bg = []
}

/**
 * A changed default prompt is taken by every session that is up, at once: each is reopened (refresh), and one
 * that was at work is told by its agent to go on once it is back. Locked sessions, ones being moved or handed
 * over, and ones on a Mac that is not linked keep theirs until they are next reopened. Returns what to say.
 */
function setDefaultPrompt(uid, text) {
  const changed = sysPromptOf(uid) !== (text.trim() || BUILTIN_DEFAULT_PROMPT)
  prefsOf(uid).defaultPrompt = text
  savePrefs(uid)
  if (!changed) return '바뀐 내용이 없어 세션은 그대로예요.'
  let done = 0
  let working = 0
  let kept = 0
  for (const meta of sessions.values()) {
    if (meta.uid !== uid || meta.closed || !meta.state.alive) continue
    if (meta.lock || meta.moving || meta.state.handedOffTo || !online(meta.hostId)) {
      kept++
      continue
    }
    if (['busy', 'waiting'].includes(meta.state.phase)) working++
    record(uid, meta.hostId, { area: 'prompt', sid: meta.id, text: `기본 프롬프트가 바뀌어 다시 엶 (${meta.state.phase})` })
    refreshSession(uid, meta, meta.hostId)
    done++
  }
  if (!done) return kept ? `잠겼거나 연결이 끊긴 세션 ${kept}개는 다음에 다시 열 때 적용돼요.` : '새로 띄우는 세션부터 적용돼요.'
  return `세션 ${done}개를 새로고침해 바로 적용했어요${working ? ` · 일하던 ${working}개는 다시 뜬 뒤 하던 작업을 이어가요` : ''}${kept ? ` · 잠겼거나 연결이 끊긴 ${kept}개는 다음에 다시 열 때 적용돼요` : ''}.`
}

/**
 * An agent's health as an operator may see it on someone else's Mac (R8-L3, R10-L1): every text that can name a folder
 * (checks, the feature rows built from them, repairs, the headless browser's error) without its paths.
 */
function maskHealth(h) {
  const hide = (o, ...keys) => ({ ...o, ...Object.fromEntries(keys.filter((k) => o?.[k]).map((k) => [k, hidePaths(o[k])])) })
  return {
    ...h,
    checks: (h.checks ?? []).map((c) => hide(c, 'detail', 'fix')),
    features: (h.features ?? []).map((f) => hide(f, 'detail', 'fix')),
    repairs: (h.repairs ?? []).map((r) => hide(r, 'text')),
    ...(h.background ? { background: hide(h.background, 'error') } : {}),
  }
}

/** A Mac at a glance. `masked`: for an operator looking at someone else's Mac, the error texts lose their paths (R8-L3). */
/** A Claude account id on a Mac: '' is its main account, an added one is `a` and 8 hex letters (agent/accounts.mjs). */
const safeAccount = (id) => id === '' || (typeof id === 'string' && /^a[0-9a-f]{8}$/.test(id))
/** What an agent says about its Claude accounts, kept to known fields. */
function cleanAccounts(list) {
  const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null)
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && safeAccount(a.id))
    .slice(0, 11)
    .map((a) => ({ id: a.id, name: text(a.name, 40) || (a.id ? '계정' : '기본 계정'), main: a.id === '', loggedIn: typeof a.loggedIn === 'boolean' ? a.loggedIn : null, email: text(a.email, 200), plan: text(a.plan, 40), method: text(a.method, 40), sessions: Number(a.sessions) || 0, signingIn: a.signingIn === true }))
}
const ACCOUNT_OP_NAMES = { list: '목록', add: '추가', rename: '이름 바꾸기', login: '로그인 시작', code: '로그인 코드 입력', cancel: '로그인 취소', logout: '로그아웃', sync: '공유 설정 다시 맞추기', remove: '빼기' }
const ACCOUNT_OPS = Object.keys(ACCOUNT_OP_NAMES)
/** A host's accounts without the e-mail addresses: for the session list and the move dialog. */
const accountsBrief = (h) => (h.accounts ?? []).map(({ email: _e, ...a }) => a)

/** What a Mac says it has for speech (REQ-F-758), only the known fields: null from an agent that says nothing. */
function cleanVoiceStatus(v) {
  if (!v || typeof v !== 'object') return null
  const names = (a) => (Array.isArray(a) ? a.filter((m) => typeof m === 'string' && /^[\w.-]{1,64}$/.test(m)).slice(0, 20) : [])
  return { whisper: v.whisper === true, models: names(v.models), vadModel: v.vadModel === true, vad: ['on', 'off', 'idle'].includes(v.vad) ? v.vad : null, ffmpeg: v.ffmpeg === true }
}

/** What an agent says about its key (agent keyState), kept to known fields: times, counts and browser ids only. */
function cleanKeyState(k) {
  if (!k || typeof k !== 'object') return null
  const num = (v) => (Number.isFinite(v) ? v : null)
  const app = (v) => (typeof v === 'string' && /^[\w.-]{1,64}$/.test(v) ? v : null)
  const event = (e) => (e && typeof e === 'object' && num(e.at) ? { at: e.at, app: app(e.app), ...(typeof e.ok === 'boolean' ? { ok: e.ok } : {}) } : null)
  return { gen: num(k.gen), latest: num(k.latest), at: num(k.at), oldUntil: num(k.oldUntil), retired: num(k.retired) ?? 0, linked: ['current', 'old'].includes(k.linked) ? k.linked : null, stale: event(k.stale), reopen: event(k.reopen) }
}

function hostSummary(id, h, masked = false) {
  const st = live(id)
  const failing = (st.health?.checks ?? []).filter((c) => c.level === 'fail')
  const problem = failing[0] ? `${failing[0].title}: ${failing[0].detail}` : null
  const lastError = st.lastError && masked ? { ...st.lastError, text: hidePaths(st.lastError.text) } : st.lastError
  const background = st.health?.background ?? null
  return { id, name: h.name, kind: h.kind ?? 'other', info: h.info ?? null, awake: st.health?.awake ?? null, voice: masked ? null : cleanVoiceStatus(st.health?.voice), takesWork: !delegateOff(h.uid).has(id), sudo: masked ? null : sudoView(id), background: masked && background?.error ? { ...background, error: hidePaths(background.error) } : background, // Behind, and this server will hand it the new one: not when it sends none (unsigned, seq went back, R9-I1).
    outdated: !!h.info && h.info.build !== AGENT_BUILD && AGENT_SIGNED,
    // Behind, but this server sends no update (R10-I2): said as such, not as "최신".
    updateBlocked: !!h.info && h.info.build !== AGENT_BUILD && !AGENT_SIGNED, key: cleanKeyState(st.health?.keyState), problems: failing.length, problem: masked && problem ? hidePaths(problem) : problem, online: online(id), stale: online(id) && st.stale, lastSeen: h.lastSeen, healthAt: st.healthAt, rtt: st.rtt, errors: st.errors, lastError, accounts: masked ? accountsBrief(h).map(({ name: _n, ...a }) => a) : accountsBrief(h) }
}

/** Everything known about one host, for the host screen and for the operator. */
/**
 * A Mac's state for its owner, or for an operator looking at someone else's Mac (R1-M5): then each session is shown
 * as if locked, with no title either. The operator sees that sessions are there and how they are doing, not what
 * they say (titles, folders, messages waiting, what a tool is doing).
 */
function hostDetail(hostId, viewer) {
  const h = hosts[hostId]
  const other = viewer !== h.uid
  const st = live(hostId)
  const agentSessions = new Map((st.health?.sessions ?? []).map((s) => [s.id, s]))
  return {
    // The e-mail each account signs in with is for the Mac's owner only.
    host: { ...hostSummary(hostId, h, other), user: users[h.uid]?.login ?? h.uid, home: other ? '' : h.home, latest: AGENT_BUILD, ...(other ? {} : { accounts: h.accounts ?? [] }) },
    link: { connectedAt: st.connectedAt, disconnectedAt: st.disconnectedAt, connects: st.connects, rtt: st.rtt, rttAt: st.rttAt },
    // For an operator on someone else's Mac the agent's own checks lose their paths too: they name its home folder (R8-L3).
    health: st.health && { ...(other ? maskHealth(st.health) : st.health), sessions: undefined, at: st.healthAt },
    page: st.page && { ...st.page, at: st.pageAt },
    sessions: [...sessions.values()]
      .filter((m) => m.hostId === hostId && !m.closed)
      .map((m) => {
        const a = agentSessions.get(m.id)
        const shown = shielded(other ? { ...m, lock: m.lock || true, manualTitle: false } : m)
        return { id: m.id, title: other ? '' : shown.title, cwd: shown.cwd, state: shown.state, locked: !!m.lock, hooks: a?.hooks ?? null, serverLines: m.lines, agentLines: a?.lines ?? null, behind: a ? Math.max(0, a.lines - m.lines) : null, syncedAt: m.syncedAt, transcriptBytes: a?.transcriptBytes ?? null, tmux: a?.tmux ?? null, mux: a?.mux ?? null, folderAt: a?.folderAt ?? null, pushError: other ? (a?.pushError ? '(가림)' : null) : (a?.pushError ?? null), knownToAgent: !!a }
      }),
  }
}

// Ping every connected host through its bridge page, and notice the ones whose agent has gone quiet.
setInterval(() => {
  for (const hostId of bridges.keys()) {
    const st = live(hostId)
    toHost(hostId, { t: 'ping', ts: Date.now() })
    const quiet = Date.now() - Math.max(st.healthAt ?? 0, st.connectedAt ?? 0)
    if (!st.stale && quiet > STALE_MS) {
      st.stale = true
      record(hosts[hostId].uid, hostId, { level: 'warn', area: 'heartbeat', text: `연동 페이지는 붙어 있는데 에이전트가 ${Math.round(quiet / 1000)}초째 상태를 보내지 않음 (탭이 멈췄거나 에이전트가 죽었을 수 있음)` })
      broadcastState(hosts[hostId].uid)
    }
  }
}, HEARTBEAT_MS)

function stateOf(uid) {
  return {
    t: 'state',
    hosts: Object.entries(hosts)
      .filter(([, h]) => h.uid === uid)
      .map(([id, h]) => hostSummary(id, h)),
    groups: { groups: prefsOf(uid).groups, loose: prefsOf(uid).loose, collapsed: prefsOf(uid).collapsed ?? [] },
    splits: splitsOf(uid),
    notices: noticesOf(uid).map(({ key: _k, ...n }) => n),
    // The places a session can be moved to besides the bridge: a plugin that is on and takes sessions.
    places: ['slack'].filter((id) => plug.instance(uid, id)?.moveIn && plug.instance(uid, id).status?.().state === 'on'),
    // The page this server hands out now (its entry file): a page that runs another one reloads itself (REQ-F-732).
    ui: uiBuild(),
    sessions: [...sessions.values()]
      .filter((m) => m.uid === uid)
      .map((meta) => {
        const { uid: _uid, silentUntil: _s, stats: _st, prLinks: _pl, agentLog: _al, _legacy: _lg, ...m } = shielded(meta)
        return m
      })
      .sort((a, b) => a.createdAt - b.createdAt),
  }
}

/**
 * The state to one page. The first is whole; after that only what changed: the session rows that differ, the
 * order when it changed, and the other parts (hosts, groups, notices, places) that differ. A rename used to send
 * all 40 rows (33 KB) and redraw every row; now one row (about 1 KB), and the page keeps the other rows as they
 * were, so React leaves them alone.
 */
const STATE_PARTS = ['hosts', 'groups', 'splits', 'notices', 'places', 'ui']
function sendState(res, st) {
  const rows = new Map(st.sessions.map((r) => [r.id, JSON.stringify(r)]))
  const parts = Object.fromEntries(STATE_PARTS.map((k) => [k, JSON.stringify(st[k])]))
  const last = res.lastState
  res.lastState = { rows, parts }
  if (!last || !res.wantsDelta) return sse(res, st)
  const d = { t: 'state_delta' }
  for (const k of STATE_PARTS) if (parts[k] !== last.parts[k]) d[k] = st[k]
  const changed = st.sessions.filter((r) => last.rows.get(r.id) !== rows.get(r.id))
  if (changed.length) d.changed = changed
  const order = [...rows.keys()]
  const before = [...last.rows.keys()]
  if (order.length !== before.length || order.some((id, i) => id !== before[i])) d.order = order
  if (Object.keys(d).length > 1) sse(res, d)
}

const stateTimers = new Map()
function broadcastState(uid) {
  if (stateTimers.has(uid)) return
  stateTimers.set(
    uid,
    setTimeout(() => {
      stateTimers.delete(uid)
      toControls(uid, stateOf(uid))
    }, 150),
  )
}

// ---------- messages from agents (through the bridge page) ----------

function newMeta(uid, id, hostId, fields) {
  const meta = {
    id,
    uid,
    hostId,
    prevHostId: null,
    title: '',
    cwd: '',
    home: hosts[hostId]?.home ?? '',
    lines: 0,
    syncedAt: null,
    autoPush: true,
    folder: null,
    closed: false,
    moves: [],
    conv: id,
    seq: 0,
    lastAt: Date.now(),
    last: '',
    preview: '',
    model: '',
    autoAllow: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // Its events go to its Mac as they happen (REQ-S-069): nothing from before to move there.
    agentLog: true,
    ...volatile(),
    ...fields,
  }
  sessions.set(id, meta)
  return meta
}

/** sid -> the timer that reminds of a decision nobody has answered. */
const reminders = new Map()

/** The host a session runs on, or the one it is being opened on right now: both may speak for it. */
const owns = (meta, uid, hostId) => !!meta && meta.uid === uid && (meta.hostId === hostId || meta.moving?.to === hostId)

/**
 * The newest iOS build sent to TestFlight (REQ-F-781): told by an operator's Mac that uploads it, read by the app's
 * page to ask for an update. Anyone else's agent is not heard: it would make every app ask for a build that is not there.
 */
const APP_BUILD_FILE = path.join(DATA, 'app-build.json')
const cleanAppBuild = (o) => {
  const build = Number(o?.build)
  const at = Number(o?.at)
  return Number.isSafeInteger(build) && build > 0 && build < 1e7 && Number.isSafeInteger(at) && at > 0 && at < Date.now() + 86_400_000 ? { build, at } : null
}
let appBuild = cleanAppBuild(readJson(APP_BUILD_FILE, null))

const fromAgent = {
  /** The Mac's last TestFlight upload (REQ-F-781): kept only from an operator, and never an older build. */
  testflight(uid, hostId, msg) {
    const v = cleanAppBuild(msg)
    if (!v || !isAdmin(uid) || (appBuild && (v.build < appBuild.build || (v.build === appBuild.build && v.at === appBuild.at)))) return
    appBuild = v
    writeJson(APP_BUILD_FILE, appBuild)
    record(uid, hostId, { area: 'update', text: `TestFlight 최신 빌드 ${v.build} (${new Date(v.at).toISOString()})` })
  },
  /** A session's bridge MCP server asks (REQ-F-760); answered with the same areq, however long it takes. */
  delegate(uid, hostId, msg) {
    if (typeof msg.areq !== 'string' || !msg.areq) return
    runDelegate(uid, hostId, msg).then(
      (result) => toHost(hostId, { t: 'delegated', areq: msg.areq, ok: true, result }),
      (e) => toHost(hostId, { t: 'delegated', areq: msg.areq, ok: false, error: String(e?.message || e).slice(0, 500) }),
    )
  },
  /** One end of a local preview's WebSocket (server/preview.mjs). */
  ws(uid, hostId, msg) {
    preview.fromAgent(hostId, msg)
  },
  /** The Claude accounts on the Mac changed (added, signed in or out, renamed): kept with the host. */
  accounts(uid, hostId, msg) {
    hosts[hostId].accounts = cleanAccounts(msg.accounts)
    touchGlobals()
    broadcastState(uid)
  },
  hello(uid, hostId, msg) {
    live(hostId).caps = Array.isArray(msg.caps) ? msg.caps.filter((c) => typeof c === 'string').slice(0, 20) : []
    // Preview WebSockets the agent no longer has (it started again) are closed, so the page's dev client reconnects.
    preview.hostGone(hostId, Array.isArray(msg.ws) ? msg.ws.map(String) : [])
    Object.assign(hosts[hostId], { name: String(msg.name || '').slice(0, 60) || hosts[hostId].name, kind: String(msg.kind || 'other').slice(0, 20), home: String(msg.home || ''), lastSeen: Date.now(), info: { version: String(msg.version || ''), build: String(msg.build || ''), node: String(msg.info?.node || ''), os: String(msg.info?.os || '') } })
    record(uid, hostId, { area: 'link', text: `에이전트 연결됨: ${hosts[hostId].name} (${hosts[hostId].kind}), agent ${msg.version}, node ${msg.info?.node}, ${msg.info?.os}, 세션 ${msg.sessions?.length ?? 0}개` })
    touchGlobals()
    const known = {}
    const listed = new Set()
    for (const s of Array.isArray(msg.sessions) ? msg.sessions : []) {
      if (!safeId(s.id)) continue
      listed.add(s.id)
      let meta = sessions.get(s.id)
      if (meta && meta.uid !== uid) continue
      // A session the agent has but the server has never seen: take it as this host's.
      meta ??= newMeta(uid, s.id, hostId, { cwd: String(s.cwd || ''), autoPush: s.autoPush !== false, conv: safeId(s.conv) ? s.conv : s.id })
      const mine = meta.hostId === hostId && !meta.closed
      // The agent moved on to another conversation (`/clear`) while it was away from the server.
      if (mine && safeId(s.conv) && s.conv !== (meta.conv ?? meta.id)) Object.assign(meta, { conv: s.conv, lines: 0 })
      // The account it runs in is the Mac's to say (an agent from before accounts says nothing).
      if (mine && typeof s.account === 'string' && safeAccount(s.account)) meta.account = s.account
      known[s.id] = { lines: meta.lines, mine }
      if (mine) meta.state.alive = !!s.alive
      // A server that started from an older meta.json (a deploy) counts on from the Mac's last number (REQ-S-069).
      if (mine && Number.isInteger(s.seq) && s.seq > (meta.seq ?? 0)) (meta.seq = s.seq), dirty.add(meta.id)
    }
    for (const meta of sessions.values()) if (meta.uid === uid && meta.hostId === hostId && !listed.has(meta.id)) Object.assign(meta, volatile())
    toHost(hostId, { t: 'welcome', sessions: known })
    // What it did not say it kept goes again, then the copies this server kept before (REQ-S-069).
    if (storeOn(hostId)) {
      for (const cmd of logOut.get(hostId)?.values() ?? []) toHost(hostId, (({ size: _s, ...c }) => c)(cmd))
      void migrateHost(uid, hostId)
      // Sessions that moved away from this Mac before all their log went with them.
      for (const to of new Set([...sessions.values()].filter((m) => m.carryFrom === hostId && !m.agentLog).map((m) => m.hostId))) if (online(to)) void migrateHost(uid, to)
    }
    // An agent that is not the one this server hands out is given the current files by its own bridge tab,
    // and replaces itself when its sessions are at rest. Installing once is enough.
    // Not an agent the Macs would refuse (unsigned, or signed with a seq that went back): they keep theirs (R7-M1).
    if (hosts[hostId].info.build !== AGENT_BUILD && AGENT_SIGNED) {
      record(uid, hostId, { area: 'update', text: `에이전트 build ${hosts[hostId].info.build || '?'} → ${AGENT_BUILD} 로 업데이트를 보냄` })
      // The largest seq is recorded when a Mac is first sent it, not before: a deploy that never handed out its agent
      // (it died, or the old server stayed) does not raise it (R9-L2, R10-I1).
      if (!seqRecorded && AGENT_SIG.seq > SEQ_SEEN) (writeJson(SEQ_FILE, { max: AGENT_SIG.seq }), (seqRecorded = true))
      toHost(hostId, { t: 'update', build: AGENT_BUILD, names: AGENT_FILES, sig: AGENT_SIG.legacy ?? '', msig: AGENT_SIG.msig ?? '', seq: AGENT_SIG.seq ?? 0 })
    }
    broadcastState(uid)
  },
  lines(uid, hostId, msg) {
    const meta = sessions.get(msg.sid)
    if (!meta || meta.uid !== uid || !Array.isArray(msg.lines)) return
    if (!owns(meta, uid, hostId)) return void toHost(hostId, { t: 'release', sid: meta.id })
    if (msg.from !== meta.lines) return void toHost(hostId, { t: 'resync', sid: meta.id, lines: meta.lines })
    // Read into events and let go: the transcript stays on the Mac (REQ-S-069).
    const lines = msg.lines.filter((l) => typeof l === 'string' && !l.includes('\n'))
    // A conversation resumed under a new id begins with a copy of lines already shown: kept, not drawn again.
    const silent = Math.max(0, Math.min(lines.length, (meta.silentUntil ?? 0) - meta.lines))
    const events = convert(meta, lines.slice(silent))
    meta.lines += lines.length
    meta.syncedAt = Date.now()
    if (!meta.title && !meta.manualTitle) meta.title = (events.find((e) => e.k === 'user' && !e.command)?.text ?? '').replace(/\s+/g, ' ').slice(0, 80)
    touch(meta)
    logEvents(meta, events)
    closeWhenReportDone(meta)
    // The Mac reports the turn's end before the transcript line with its answer: the answer that lands after counts too.
    if (meta.delegatedBy && ['idle', 'ended'].includes(meta.state.phase) && events.some((e) => e.k === 'text' && e.text)) followDelegate(meta)
  },
  status(uid, hostId, msg) {
    const meta = sessions.get(msg.sid)
    if (!owns(meta, uid, hostId)) return
    const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : null)
    const was = meta.state.phase
    meta.state = {
      alive: !!msg.alive,
      phase: ['starting', 'idle', 'busy', 'waiting', 'ended'].includes(msg.phase) ? msg.phase : 'idle',
      waiting: str(msg.waiting, 40),
      waitingSince: Number(msg.waitingSince) || null,
      held: (Array.isArray(msg.held) ? msg.held : []).slice(0, 50).map((h) => ({ id: String(h.id), text: String(h.text).slice(0, 100_000), at: Number(h.at) || Date.now() })),
      tool: msg.tool ? { name: str(msg.tool.name, 80), title: str(msg.tool.title), at: Number(msg.tool.at) || null } : null,
      tools: Number(msg.tools) || 0,
      running: (Array.isArray(msg.running) ? msg.running : []).slice(0, 20).map((t) => String(t).slice(0, 200)),
      sessionMd: typeof msg.sessionMd === 'number' ? msg.sessionMd : null,
      mdFile: /^SESSION(-[0-9a-f]{8})?\.md$/.test(String(msg.mdFile ?? '')) ? msg.mdFile : null,
      // What a light copy hands over at most (an agent from before it sends none: 20 KB, as it then cuts at).
      mdMax: Math.min(100_000, Math.max(20_000, Number(msg.mdMax) || 20_000)),
      plugins: (Array.isArray(msg.plugins) ? msg.plugins : []).slice(0, 10).map((x) => ({ market: String(x.market).slice(0, 60), version: String(x.version).slice(0, 40), ...(x.latest ? { latest: String(x.latest).slice(0, 40) } : {}) })),
      turnAt: Number(msg.turnAt) || null,
      mode: str(msg.mode, 40),
      effort: str(msg.effort, 20),
      context: str(msg.context, 20),
      autoAllow: !!msg.autoAllow,
      refreshAfter: !!msg.refreshAfter,
      // The bridge MCP tools the session's process started with; null from an agent before 1.245.
      bridgeTools: Array.isArray(msg.bridgeTools) ? msg.bridgeTools.slice(0, 50).map((t) => String(t).slice(0, 80)) : null,
      size: Number(msg.size) || null,
      quietSince: Number(msg.quietSince) || null,
      usage: msg.usage && typeof msg.usage === 'object' ? Object.fromEntries(['context', 'window', 'fiveHour', 'week', 'cost', 'fiveHourResetsAt', 'weekResetsAt'].map((k) => [k, typeof msg.usage[k] === 'number' ? msg.usage[k] : null])) : null,
      handedOffTo: safeId(msg.handedOffTo) ? msg.handedOffTo : null,
      cache: cacheOf(msg.cache),
      // The web servers the session started on its Mac (localhost), for the page's computer button.
      servers: (Array.isArray(msg.servers) ? msg.servers : []).filter((x) => Number.isInteger(x?.port) && x.port > 0 && x.port < 65536).slice(0, 20).map((x) => ({ port: x.port, title: str(x.title, 120) ?? '' })),
    }
    // The session's own hand-over file, kept with it: a move tells the other Mac, which then keeps using it.
    if (meta.state.mdFile) meta.mdFile = meta.state.mdFile
    // When work starts and stops, kept in the log: the usage statistics are counted from these.
    if (meta.state.alive && meta.state.phase !== was && (meta.state.phase === 'busy' || was === 'busy')) logEvents(meta, [{ k: 'status', phase: meta.state.phase }])
    if (meta.state.phase !== 'busy') meta.coding = false
    // A session that was handed work ended a turn: the one that handed it over hears of it (REQ-F-760 rule 11).
    if (meta.delegatedBy && was === 'busy' && ['idle', 'ended'].includes(meta.state.phase)) followDelegate(meta)
    // The Mac counted the shells Claude really has: the list of background commands cannot be longer than that.
    // The oldest go first, and nothing that started in the last half minute (the count may be older than it).
    if (typeof msg.shells === 'number' && meta.bg?.length) {
      const before = meta.bg.length
      meta.bg = meta.bg.filter((t) => t.kind !== 'monitor' || Date.now() < (t.at ?? 0) + (t.timeout ?? 300_000))
      const shells = meta.bg.filter((t) => t.kind !== 'agent')
      const settled = shells.filter((t) => Date.now() - (t.at ?? 0) > 30_000)
      const over = shells.length - msg.shells
      if (over > 0) {
        const gone = new Set(settled.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).slice(0, over))
        meta.bg = meta.bg.filter((t) => !gone.has(t))
      }
      if (meta.bg.length !== before && online(meta.hostId)) toHost(meta.hostId, { t: 'bg', sid: meta.id, n: meta.bg.length })
    }
    // A turn that ended with tool calls still open (stopped, refreshed, killed) closes them, a moment later:
    // the last results may still be on their way from the transcript.
    // Only a turn that is over: one waiting for an answer (a question, a permission) has its call open on purpose.
    if (was === 'busy' && ['idle', 'ended'].includes(meta.state.phase) && meta.openTools?.size) {
      setTimeout(() => {
        if (!['idle', 'ended'].includes(meta.state.phase) || !meta.openTools?.size) return
        const open = [...meta.openTools]
        meta.openTools.clear()
        logEvents(meta, open.map((tool) => ({ k: 'tool_end', tool, error: true, text: '(중단됨)' })))
      }, 5000).unref()
    }
    // Put to rest is only a mark: the session working again takes it off.
    if (meta.resting && meta.state.phase === 'busy') meta.resting = false
    // What the session was switched to by hand wins over what the last answer happened to be written with.
    if (typeof msg.model === 'string' && msg.model) meta.launchModel = msg.model.slice(0, 60)
    if (!msg.card) (meta.card = null), (meta.cardWant = null)
    // A dropped link empties meta.card, and the Mac then says only the open card's id again: put the card back
    // from the log, or the page draws that open card as already answered ("답함") with no buttons.
    else if (meta.card?.id !== msg.card) {
      const c = cardsOf(meta).get(String(msg.card))
      if (c && !c.auto) meta.card = { ...c, open: true }
      // Started since: the card is in the Mac's log (REQ-S-069).
      else if (!c && storeOn(hostId)) {
        const want = (meta.cardWant = String(msg.card))
        void recentEvents(meta, ['card']).then((evs) => {
          const found = evs.findLast((e) => e.card?.id === want)?.card
          if (!found || found.auto || meta.cardWant !== want || meta.card?.id === want) return
          cardsOf(meta).set(found.id, found)
          meta.card = { ...found, open: true }
          broadcastState(uid)
        })
      }
    }
    // A message the Mac is holding wears an hourglass; one that left the hold without being delivered was taken back.
    const now = new Set(meta.state.held.map((h) => h.id))
    const before = new Set(meta.heldIds ?? [])
    const marks = []
    for (const id of now) if (!before.has(id)) marks.push({ k: 'react', id, name: 'hourglass_flowing_sand', on: true })
    meta.heldIds = [...now]
    // And one card for the lot, with what can be done about it: send now, or drop them.
    if (now.size !== (meta.heldCard?.n ?? 0)) {
      const first = !meta.heldCard
      const id = meta.heldCard?.id ?? crypto.randomUUID()
      marks.push({ k: 'held', id, n: now.size, ...(first ? { first: true } : {}) })
      meta.heldCard = now.size ? { id, n: now.size } : null
    }
    if (marks.length) logEvents(meta, marks)
    broadcastState(uid)
    closeWhenReportDone(meta)
  },
  delivered(uid, hostId, msg) {
    const meta = sessions.get(msg.sid)
    if (!owns(meta, uid, hostId)) return
    const ids = (Array.isArray(msg.ids) ? msg.ids : []).filter((x) => typeof x === 'string').slice(0, 50)
    dropSentUploads(ids)
    // The hold may already be reported as empty by the time this arrives: the hourglass comes off either way.
    logEvents(meta, ids.flatMap((id) => [{ k: 'react', id, name: 'hourglass_flowing_sand', on: false }, { k: 'react', id, name: 'eyes', on: true }]))
    meta.heldIds = (meta.heldIds ?? []).filter((x) => !ids.includes(x))
  },
  /** A decision the terminal is waiting for, as a card with buttons; or the same card, answered. */
  card(uid, hostId, msg) {
    const meta = sessions.get(msg.sid)
    const c = msg.card
    if (!owns(meta, uid, hostId) || !c || !safeId(c.id)) return
    const label = { permission: '권한 요청', question: '질문', plan: '플랜 승인', dialog: '터미널 확인', keyed: '터미널 확인', stuck: '지시 대기' }[c.kind] ?? '응답 대기'
    cardsOf(meta).set(c.id, c.open || c.auto ? c : (cardsOf(meta).get(c.id) ?? c))
    if (c.open) {
      meta.card = c
      logEvents(meta, [{ k: 'card', card: c, at: Number(c.at) || Date.now() }])
      // Someone has that conversation open: the card is in front of them, a notice on top of it is noise.
      if (!isViewing(uid, meta.id)) addNotice(uid, { sid: meta.id, key: `card|${c.id}`, title: meta.title || '세션', text: `${label} — ${String(c.tool?.name ? `${c.tool.name}: ` : '')}${String(c.title ?? '').slice(0, 120)}`, tone: 'info', push: true })
      // Still unanswered after five minutes, and again after ten: the session has been standing still all that time.
      clearTimeout(reminders.get(meta.id))
      const remind = (n) =>
        reminders.set(
          meta.id,
          setTimeout(() => {
            if (meta.card?.id !== c.id) return
            addNotice(uid, { sid: meta.id, key: `remind|${c.id}|${n}`, title: meta.title || '세션', text: c.kind === 'permission' ? `⏰ ${n * 5}분째 *${c.tool?.name ?? '도구'}* 권한 응답을 기다리고 있습니다. 세션이 그동안 멈춰 있습니다.` : `⏰ ${n * 5}분째 ${{ question: '질문 대기', plan: '플랜 승인 대기', stuck: '지시 대기' }[c.kind] ?? '터미널 확인 대기'} 중입니다. 세션이 그동안 멈춰 있습니다.`, tone: 'info', push: true })
            if (n < 2 && c.kind === 'permission') remind(n + 1)
          }, 300_000),
        )
      remind(1)
    } else {
      clearTimeout(reminders.get(meta.id))
      dropNotices(uid, (x) => x.key === `card|${c.id}` || x.key.startsWith(`remind|${c.id}|`))
      if (meta.card?.id === c.id) meta.card = null
      // An automatic allow was never open: it is logged as one line with what was allowed.
      logEvents(meta, [c.auto ? { k: 'card', card: c } : { k: 'card_end', id: c.id, result: String(c.result ?? '').slice(0, 200) }])
    }
  },
  note(uid, hostId, msg) {
    const meta = sessions.get(msg.sid)
    if (!owns(meta, uid, hostId)) return
    logEvents(meta, [{ k: 'notice', text: String(msg.text ?? '').slice(0, 2000), tone: msg.tone === 'warn' ? 'warn' : 'info' }])
  },
  toast(uid, hostId, msg) {
    toControls(uid, { t: 'notice', sid: msg.sid, text: sessions.get(msg.sid)?.lock ? '🔒 잠긴 세션에서 알림이 있어요' : String(msg.text ?? '').slice(0, 300) })
  },
  /** What Claude is writing right now, read off the terminal. Shown while it lasts, never stored. */
  preview(uid, hostId, msg) {
    const meta = sessions.get(msg.sid)
    if (!owns(meta, uid, hostId)) return
    meta.writing = String(msg.text ?? '').slice(0, 40_000)
    toControls(uid, { t: 'preview', sid: meta.id, text: meta.writing })
  },
  /** The session went on to another conversation: its transcript copy starts over under the new id. */
  conv(uid, hostId, msg) {
    const meta = sessions.get(msg.sid)
    if (!owns(meta, uid, hostId) || !safeId(msg.conv)) return
    Object.assign(meta, { conv: msg.conv, silentUntil: msg.replay ? meta.lines : 0, lines: 0 })
    fs.rmSync(transcriptFile(meta), { force: true })
    touch(meta)
  },
  /** Log hand-overs the Mac has on disk now (REQ-S-069). */
  logged(uid, hostId, msg) {
    heardKept(hostId, (Array.isArray(msg.lids) ? msg.lids : []).filter((x) => typeof x === 'string').slice(0, 1000))
  },
  /** A session's numbers for the statistics and the pull requests it names, worked out on the Mac (REQ-S-070). */
  stats(uid, hostId, msg) {
    const meta = sessions.get(msg.sid)
    if (!owns(meta, uid, hostId)) return
    const s = cleanStats(msg.stats)
    if (s) meta.stats = s
    if (Array.isArray(msg.prs)) meta.prLinks = msg.prs.filter((u) => typeof u === 'string' && /^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(u)).slice(0, 100)
    dirty.add(meta.id)
  },
  folder(uid, hostId, msg) {
    const meta = sessions.get(msg.sid)
    if (!owns(meta, uid, hostId)) return
    meta.folder = cleanFolder(msg.folder)
    meta.syncedAt = Date.now()
    touch(meta)
  },
  screen(uid, hostId, msg) {
    toControls(uid, { t: 'screen', sid: msg.sid, text: String(msg.text ?? '').slice(0, 200_000) })
  },
  closed(uid, hostId, msg) {
    const meta = sessions.get(msg.sid)
    if (!meta || meta.uid !== uid || meta.hostId !== hostId) return
    Object.assign(meta, volatile())
    broadcastState(uid)
  },
  health(uid, hostId, msg) {
    const st = live(hostId)
    const { t: _t, ...health } = msg
    if (st.stale) record(uid, hostId, { area: 'heartbeat', text: '에이전트가 다시 상태를 보냄' })
    Object.assign(st, { health, healthAt: Date.now(), stale: false })
    broadcastState(uid)
  },
  page(uid, hostId, msg) {
    const st = live(hostId)
    const was = st.page?.visible
    const n = (k) => Number(msg[k]) || 0
    st.page = { visible: String(msg.visible), queue: n('queue'), ua: String(msg.ua || '').slice(0, 200), openedAt: n('openedAt') || null, fromServer: n('fromServer'), toAgentOk: n('toAgentOk'), toAgentFail: n('toAgentFail'), fromAgent: n('fromAgent'), upOk: n('upOk'), upFail: n('upFail'), agentReconnects: n('agentReconnects'), lastError: msg.lastError ? { ts: Number(msg.lastError.ts), text: String(msg.lastError.text).slice(0, 200) } : null }
    st.pageAt = Date.now()
    if (was && was !== st.page.visible) record(uid, hostId, { area: 'page', src: 'page', text: st.page.visible === 'visible' ? '연동 탭이 앞으로 나옴' : '연동 탭이 백그라운드로 감' })
  },
  pong(uid, hostId, msg) {
    const st = live(hostId)
    Object.assign(st, { rtt: Date.now() - Number(msg.ts), rttAt: Date.now() })
  },
  logs(uid, hostId, msg) {
    for (const e of Array.isArray(msg.entries) ? msg.entries.slice(0, 200) : []) record(uid, hostId, { ...e, src: msg.src === 'page' ? 'page' : 'agent' })
  },
  error(uid, hostId, msg) {
    toControls(uid, { t: 'notice', sid: msg.sid, text: sessions.get(msg.sid)?.lock ? '🔒 잠긴 세션에서 호스트 오류가 났어요' : `호스트 오류: ${String(msg.message).slice(0, 300)}` })
  },
}

/** What a host's bridge tab passed up (/api/bridge/up), or the demo Mac (server/demo.mjs) in its place. */
function fromBridge(uid, hostId, msgs, origin = ORIGIN) {
  for (const msg of msgs) {
    if (msg.t === 'got') {
      const p = pending.get(msg.reqId)
      if (p && p.hostId === hostId) (clearTimeout(p.gotTimer), (p.got = true))
      continue
    }
    if (msg.t === 'relayfail') {
      // An agent that stays away is dead or cannot start (launchd keeps trying): only installing it again helps.
      const gone = /돌아오지 않았습니다/.test(String(msg.error)) ? ` 그 맥의 에이전트가 꺼져 있거나 뜨지 못하고 있어요. 그 맥의 터미널에서 curl -fsSL ${origin}/install.sh | bash 로 다시 설치해 주세요.` : ''
      reply({ reqId: msg.reqId, ok: false, error: `연동 탭이 그 맥의 에이전트(127.0.0.1)에 명령을 전달하지 못했습니다: ${String(msg.error).slice(0, 200)}${gone}` }, hostId)
      continue
    }
    if (msg.reqId && reply(msg, hostId)) continue
    try {
      fromAgent[msg.t]?.(uid, hostId, msg)
    } catch (e) {
      // Logged and skipped: answering 500 would make the tab send the whole batch again, the good ones twice.
      log('error', `from agent ${msg.t}`, e)
      record(uid, hostId, { level: 'error', area: 'up', sid: safeId(msg.sid) ? msg.sid : undefined, text: `서버가 에이전트 메시지(${String(msg.t).slice(0, 20)})를 처리하지 못함: ${String(e.message).slice(0, 200)}` })
    }
  }
}

function reply(msg, from) {
  const p = pending.get(msg.reqId)
  if (!p || (from && p.hostId !== from)) return false
  clearTimeout(p.timer)
  clearTimeout(p.gotTimer)
  pending.delete(msg.reqId)
  p.resolve(msg.t === 'error' ? { ok: false, error: String(msg.message) } : msg)
  return true
}

// ---------- session operations ----------

class Refuse extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// ---------- 제보 ----------
/** A report from someone using the page: what they wrote, their pictures, and what was around them then. */
const REPORTS = path.join(DATA, 'reports')
const REPORT_IMAGES = 8
const reportFile = (id) => path.join(REPORTS, `${id}.json`)
/** A report's videos (REQ-F-735): moved out of the uploads (which go after a day) and kept as long as the report. */
const REPORT_VIDEOS = 3
const reportVideoFile = (id) => path.join(REPORTS, 'video', id)
/**
 * A report's pictures (from 1.272) are kept with the reports, not in the person's picture store, so that they stay
 * the 90 days a report is kept even when the account goes (REQ-S-072). Older reports' pictures are in that store.
 */
const reportImgId = (s) => typeof s === 'string' && /^[0-9a-f]{40}\.(png|jpg|gif|webp)$/.test(s)
const reportImgFile = (r, id) => {
  const own = path.join(REPORTS, 'img', id)
  return fs.existsSync(own) ? own : path.join(imgDir(r.uid), id)
}
function saveReportImage(mediaType, base64) {
  const ext = IMG_TYPES[mediaType]
  const bytes = Buffer.from(base64, 'base64')
  if (!ext || !bytes.length || bytes.length > 12 * 1024 * 1024) return null
  const id = `${crypto.createHash('sha1').update(bytes).digest('hex')}.${ext}`
  fs.mkdirSync(path.join(REPORTS, 'img'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(REPORTS, 'img', id), bytes, { mode: 0o600 })
  return id
}
/** The record goes, and its videos and its own pictures with it (a picture another report also has stays). */
function dropReport(r) {
  for (const v of r.videos ?? []) if (uploadId(v.id)) fs.rmSync(reportVideoFile(v.id), { force: true })
  fs.rmSync(reportFile(r.id), { force: true })
  const others = new Set(readReports().flatMap((x) => x.images ?? []))
  for (const id of r.images ?? []) if (reportImgId(id) && !others.has(id)) fs.rmSync(path.join(REPORTS, 'img', id), { force: true })
}
/** A video played in the page: Safari plays nothing that cannot be asked for in parts. */
function sendVideo(req, res, file, type) {
  if (!fs.existsSync(file)) throw new Refuse(404, '영상이 없습니다')
  const size = fs.statSync(file).size
  const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' }
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (start > end || start >= size) return res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
    return fs.createReadStream(file, { start, end }).pipe(res)
  }
  res.writeHead(200, { ...head, 'Content-Length': size })
  return fs.createReadStream(file).pipe(res)
}
/** What a report carries besides the words: the page's own account of itself, and the server's of the person's Macs. */
function reportDebug(uid, b) {
  const client = clipClient(b.client)
  const own = Object.entries(hosts).filter(([, h]) => h.uid === uid)
  const meta = safeId(b.sid) ? sessions.get(b.sid) : null
  const seen = meta && meta.uid === uid ? meta : null
  // Kept 90 days, past the account (REQ-S-072): no folder paths or remote addresses in it (REQ-S-074).
  const logOf = (hostId, sid) => readHostLog(uid, hostId, { sid }).slice(-REPORT_LOG).map((e) => ({ ...e, text: hidePaths(e.text) }))
  return {
    client,
    server: { version: VERSION, agentBuild: AGENT_BUILD, page: PAGE_BUILD(), at: Date.now() },
    // Not what root was asked for (REQ-F-764): a command line is the person's own.
    hosts: own.map(([id, h]) => ({ ...hostSummary(id, h, true), sudo: undefined, sessions: [...sessions.values()].filter((m) => m.hostId === id && !m.closed).length })),
    session: seen ? { id: seen.id, title: seen.title, cwd: hidePaths(seen.cwd), host: hosts[seen.hostId]?.name ?? null, hostId: seen.hostId, closed: !!seen.closed, resting: !!seen.resting, state: { phase: seen.state?.phase ?? null, alive: !!seen.state?.alive, tool: seen.state?.tool?.name ?? null, size: seen.state?.size ?? null, model: seen.state?.model ?? null }, lastAt: seen.lastAt } : null,
    logs: {
      ...(seen ? { session: logOf(seen.hostId, seen.id) } : {}),
      ...Object.fromEntries(own.map(([id, h]) => [h.name || id, logOf(id, null).filter((e) => e.level === 'error' || e.level === 'warn')])),
    },
  }
}
const REPORT_LOG = 40
/** The group a session started to fix a report goes in. */
const REPORT_GROUP = 'Bridge 제보 대응'
/**
 * The id of uid's group named so (one at the top first, else one at any level), made at the top when there is none.
 * Undefined when it cannot be made (too many groups): the session is then just not in a group.
 */
function namedGroup(uid, name) {
  const pf = prefsOf(uid)
  const named = (x) => x.name === name
  const found = (pf.groups.find((x) => named(x) && !x.parent) ?? pf.groups.find(named))?.id
  if (found) return found
  try { return groupOp(uid, { op: 'create', name }).id } catch { return undefined }
}
const readReports = () => (fs.existsSync(REPORTS) ? fs.readdirSync(REPORTS).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(REPORTS, f), null)).filter(Boolean) : [])
/**
 * Starts a session on one of uid's connected Macs (hostId if it is one, else the first) and sends it the report
 * (text, debugging details, pictures) as its first message: held by the agent until claude is up. Returns its id.
 * 자동 대응 starts it with 전부 허용, so no permission prompt stops it on the way to the deploy, but only for a
 * report an operator sent. Anyone else's report (its words become the session's prompt) starts in manual mode, by
 * 자동 대응 or by hand, so each command and push waits for the operator (R1-H1).
 */
async function fixReport(r, uid, { hostId: want, cwd, auto = false }, req = {}) {
  const mine = Object.keys(hosts).filter((h) => hosts[h].uid === uid && online(h))
  const hostId = mine.includes(want) ? want : mine[0]
  if (!hostId) throw new Refuse(409, '연결된 내 맥이 없어요. 맥을 연결한 뒤 다시 해 주세요')
  const group = namedGroup(uid, REPORT_GROUP)
  // A folder not on that Mac yet is made, as when a session is started from Slack.
  const said1 = (r.text || (r.images.length ? '그림 제보' : '영상 제보')).replace(/\s+/g, ' ').trim()
  // The operator's own report, on that operator's Mac: anyone else's (another operator's too) is not trusted (R1-H1).
  const trusted = r.uid === uid && isAdmin(uid)
  const mode = !trusted ? 'default' : auto ? 'autoAllow' : undefined
  const sid = await startSession(uid, { hostId, cwd: String(cwd || '~').slice(0, 1000), create: true, title: auto ? said1.slice(0, 80) : `제보 고치기:${said1.slice(0, 60)}`, prompt: '', group, ...(mode ? { mode } : {}) }, req)
  const meta = sessions.get(sid)
  // Closed by itself once it says the deploy is done (closeWhenReportDone). Its name is the report's own words,
  // kept as if a person gave it: the one Claude Code comes up with later does not replace it.
  if (auto) Object.assign(meta, { reportAuto: r.id, manualTitle: true }), touch(meta)
  const files = r.images.map((id) => {
    const file = reportImgFile(r, id)
    if (!fs.existsSync(file)) return null
    const data = fs.readFileSync(file).toString('base64')
    return { id: imageRef(uid, Object.keys(IMG_TYPES).find((t) => IMG_TYPES[t] === id.split('.')[1]), data), data }
  }).filter((f) => f?.id)
  // Videos go the way a message's do (REQ-F-761): a fresh upload of uid's, fetched by that Mac's bridge tab.
  const videos = (r.videos ?? []).map((v) => {
    const from = reportVideoFile(v.id)
    if (!uploadId(v.id) || !fs.existsSync(from)) return null
    const id = `${crypto.randomBytes(20).toString('hex')}.${v.id.split('.')[1]}`
    const file = path.join(uploadsDir(uid), id)
    fs.mkdirSync(uploadsDir(uid), { recursive: true, mode: 0o700 })
    fs.copyFileSync(from, file)
    writeJson(`${file}.json`, { name: v.name, type: v.type, size: v.size, at: Date.now() })
    return { id, name: v.name, type: v.type, size: v.size }
  }).filter(Boolean)
  const said = crypto.randomUUID()
  const text = fixPrompt(r, { auto, trusted, done: REPORT_DONE })
  logSaid(meta, said, [text, ...videos.map((v) => `🎬 ${v.name}`)].join('\n'), { images: files.map((f) => f.id) })
  if (videos.length) sentUploads.set(said, videos.map((v) => [uid, v.id]))
  toHost(hostId, { t: 'send', sid, id: said, text, ...(files.length ? { files } : {}), ...(videos.length ? { videos } : {}) })
  r.status = 'fixing'
  r.fix = { sid, at: Date.now(), by: users[uid]?.login ?? '?', ...(auto ? { auto: true } : {}) }
  writeJson(reportFile(r.id), r)
  return sid
}

// 자동 대응 (REQ-F-738): an operator's switch. While on, each new report is handed to a session on that operator's
// Mac at once; one that could not be (no Mac connected) is tried again every REPORT_AUTO_RETRY_MS, REPORT_AUTO_TRIES
// times in all. Turning it on also sets off the reports already waiting as new, each with a fresh REPORT_AUTO_TRIES.
const REPORT_AUTO_FILE = path.join(DATA, 'report-auto.json')
const REPORT_AUTO_TRIES = 3
const REPORT_AUTO_RETRY_MS = 60_000
// hostId: the Mac the operator picked for it (null: the first one connected). One that is not connected then falls
// back to the first one connected, as fixReport does.
const reportAuto = { on: false, uid: null, by: null, since: null, cwd: '~/projects/claude-bridge', hostId: null, ...readJson(REPORT_AUTO_FILE, {}) }
const reportAutoView = () => ({ on: reportAuto.on, by: reportAuto.by, since: reportAuto.since, cwd: reportAuto.cwd, hostId: reportAuto.hostId ?? null })
const autoRunning = new Set()
async function autoFix(r) {
  if (!reportAuto.on || !reportAuto.uid || r.status !== 'new' || autoRunning.has(r.id)) return
  autoRunning.add(r.id)
  try {
    r.auto = { tries: (r.auto?.tries ?? 0) + 1, at: Date.now(), error: null }
    writeJson(reportFile(r.id), r)
    const sid = await fixReport(r, reportAuto.uid, { hostId: reportAuto.hostId, cwd: reportAuto.cwd, auto: true })
    log(`report ${r.id}: 자동 대응 세션 ${sid}`)
  } catch (e) {
    r.auto.error = String(e?.message ?? e).slice(0, 300)
    writeJson(reportFile(r.id), r)
    log(`report ${r.id}: 자동 대응 실패 (${r.auto.tries}/${REPORT_AUTO_TRIES}) ${r.auto.error}`)
  } finally {
    autoRunning.delete(r.id)
  }
}
setInterval(() => {
  if (!reportAuto.on) return
  for (const r of readReports()) if (r.status === 'new' && (r.auto?.tries ?? 0) < REPORT_AUTO_TRIES && Date.now() - (r.auto?.at ?? 0) >= REPORT_AUTO_RETRY_MS) void autoFix(r)
}, REPORT_AUTO_RETRY_MS).unref?.()

// REQ-F-740: a report whose fix session has been deployed and has ended leaves the list on its own. Every push to
// main redeploys this server, so a fix session that began before this server started has seen a deploy. While
// 자동 대응 is on (REQ-F-738 rule 6), any fix session that has ended is taken as done, deploy seen or not.
const SERVER_AT = Date.now()
const REPORT_SWEEP_MS = 60_000
function sweepReports() {
  for (const r of readReports()) {
    if (r.status !== 'fixing' || !r.fix?.sid || !(reportAuto.on || r.fix.at < SERVER_AT)) continue
    const meta = sessions.get(r.fix.sid)
    if (meta && !meta.closed) continue
    dropReport(r)
    log(`report ${r.id}: 고치기 세션이 ${r.fix.at < SERVER_AT ? '배포 뒤 ' : ''}끝나 목록에서 지움`)
  }
}
setTimeout(sweepReports, 1000).unref?.()
setInterval(sweepReports, REPORT_SWEEP_MS).unref?.()

const userIds = () => (fs.existsSync(path.join(DATA, 'u')) ? fs.readdirSync(path.join(DATA, 'u')).filter((u) => !u.startsWith('.')) : [])
const accessAt = (a) => Number(a?.lastAt) || Number(a?.firstAt) || 0
const accessStale = (a, past) => (a?.status === 'pending' || a?.status === 'denied') && past(accessAt(a), ACCESS_KEEP_MS)
/**
 * Notices past 30 days, reports past 90 and access requests (waiting or refused) past 90 go (REQ-S-071, REQ-S-072,
 * REQ-S-074 (8)). `past` is pastKeep for the hourly sweep (only what was made under these limits) and pastAny when the
 * operator clears what came before (REQ-S-075).
 */
function sweepRetention(past = pastKeep) {
  const n = { notices: 0, reports: 0, access: 0 }
  for (const uid of userIds()) {
    if (!fs.existsSync(noticesFile(uid))) continue
    const before = (noticeCache.get(uid) ?? readJson(noticesFile(uid), [])).length
    n.notices += before - noticesOf(uid, past).length
  }
  for (const r of readReports()) if (past(r.at, REPORT_KEEP_MS)) (dropReport(r), n.reports++)
  for (const [k, a] of Object.entries(access)) if (accessStale(a, past)) (delete access[k], n.access++)
  if (n.access) touchGlobals()
  if (n.notices || n.reports || n.access) log(`retention: 알림 ${n.notices}개, 제보 ${n.reports}개, 접근 요청 ${n.access}개 지움`)
  return n
}
setTimeout(sweepRetention, 2000).unref?.()
setInterval(sweepRetention, RETENTION_SWEEP_MS).unref?.()

/**
 * Whether the conversation files an older server kept may be cleared: only once this server no longer reads or
 * writes them (REQ-S-069, 3b, 1.277). The event logs of sessions not yet moved to their Mac are kept even then.
 */
const CONVERSATION_PURGE_READY = true
/** What the operator's clearing would take (REQ-S-075), counted on disk: files and bytes for each kind. */
function purgeTargets() {
  const t = {}
  const add = (key, file) => {
    t[key] ??= { files: 0, bytes: 0 }
    t[key].files++
    try {
      t[key].bytes += fs.statSync(file).size
    } catch {}
  }
  const now = Date.now()
  for (const uid of userIds()) {
    const sdir = path.join(DATA, 'u', uid, 's')
    for (const sid of fs.existsSync(sdir) ? fs.readdirSync(sdir) : []) {
      let names = []
      try {
        names = fs.readdirSync(path.join(sdir, sid))
      } catch {}
      for (const f of names) {
        const file = path.join(sdir, sid, f)
        if (/^transcript.*\.jsonl$/.test(f)) add('transcripts', file)
        else if (f === 'events.jsonl') {
          add('events', file)
          // Not on its Mac yet: kept by the clearing until it is (the Mac connects and takes it).
          if (sessions.get(sid)?.agentLog === false) t.events.notMoved = (t.events.notMoved ?? 0) + 1
        }
      }
    }
    const idir = imgDir(uid)
    for (const f of fs.existsSync(idir) ? fs.readdirSync(idir) : []) add('images', path.join(idir, f))
    const list = fs.existsSync(noticesFile(uid)) ? readJson(noticesFile(uid), []) : []
    const old = list.filter((x) => pastAny(x.at, NOTICE_KEEP_MS, now)).length
    if (old) (t.notices ??= { files: 0, bytes: 0, items: 0 }), (t.notices.items += old), t.notices.files++
  }
  for (const m of sessions.values()) if (m._legacy) (t.legacyMeta ??= { files: 0, bytes: 0 }), t.legacyMeta.files++, (t.legacyMeta.bytes += JSON.stringify(m._legacy).length)
  for (const r of readReports()) {
    if (!pastAny(r.at, REPORT_KEEP_MS, now)) continue
    add('reports', reportFile(r.id))
    for (const v of r.videos ?? []) if (uploadId(v.id) && fs.existsSync(reportVideoFile(v.id))) add('reports', reportVideoFile(v.id))
    for (const id of r.images ?? []) if (reportImgId(id) && fs.existsSync(path.join(REPORTS, 'img', id))) add('reports', path.join(REPORTS, 'img', id))
  }
  const oldAccess = Object.values(access).filter((a) => accessStale(a, pastAny)).length
  if (oldAccess) t.access = { files: 0, bytes: 0, items: oldAccess }
  return t
}
const PURGE_KINDS = { transcripts: '대화 원본 줄', events: '화면 이벤트(맥으로 옮긴 세션만)', images: '대화 그림', legacyMeta: '옛 세션 정보(지침 본문 등)', notices: '30일 지난 알림', reports: '90일 지난 제보', access: '90일 지난 접근 요청' }
const CONVERSATION_KINDS = ['transcripts', 'events', 'images']
/** Clear the kinds asked for (REQ-S-075). Called only with BRIDGE_PURGE=1 and an operator's request. */
function purge(kinds) {
  const done = {}
  if (kinds.some((k) => ['notices', 'reports', 'access'].includes(k))) {
    const n = sweepRetention(pastAny)
    for (const k of ['notices', 'reports', 'access']) if (kinds.includes(k)) done[k] = n[k]
  }
  if (kinds.includes('legacyMeta')) {
    done.legacyMeta = 0
    for (const m of sessions.values()) if (m._legacy) (delete m._legacy, dirty.add(m.id), done.legacyMeta++)
  }
  for (const k of kinds.filter((x) => CONVERSATION_KINDS.includes(x))) {
    done[k] = 0
    for (const uid of userIds()) {
      if (k === 'images') {
        if (fs.existsSync(imgDir(uid))) (fs.rmSync(imgDir(uid), { recursive: true, force: true }), imgInfoCache.delete(uid), done[k]++)
        continue
      }
      const sdir = path.join(DATA, 'u', uid, 's')
      for (const sid of fs.existsSync(sdir) ? fs.readdirSync(sdir) : []) {
        let names = []
        try {
          names = fs.readdirSync(path.join(sdir, sid))
        } catch {}
        for (const f of names) {
          const hit = k === 'transcripts' ? /^transcript.*\.jsonl$/.test(f) : f === 'events.jsonl' && sessions.get(sid)?.agentLog !== false
          if (hit) (fs.rmSync(path.join(sdir, sid, f), { force: true }), done[k]++)
        }
      }
    }
  }
  log(`purge: ${Object.entries(done).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  return done
}

/** 종료: claude stops on its Mac; the session stays in the list and its folder is left alone. */
function closeSession(meta, text = '종료') {
  // What it handed to other Macs stops with it (REQ-F-760).
  for (const c of delegatesOf(meta)) closeSession(c, '맡긴 세션이 닫혀 같이 닫음')
  toHost(meta.hostId, { t: 'close', sid: meta.id })
  meta.closed = true
  meta.closedAt = Date.now()
  Object.assign(meta, volatile())
  logEvents(meta, [{ k: 'end', text }])
}

/** 제거: the server's copy of a session goes (its folder and conversation on the Mac stay). Prefs are not saved. */
function forgetSession(meta) {
  if (meta.hostId && !isDemoHost(meta.hostId)) toHost(meta.hostId, { t: 'forget', sid: meta.id })
  sessions.delete(meta.id)
  dirty.delete(meta.id)
  dropNotices(meta.uid, (x) => x.sid === meta.id)
  fs.rmSync(sessionDir(meta), { recursive: true, force: true })
  const pf = prefsOf(meta.uid)
  pf.loose = pf.loose.filter((x) => x !== meta.id)
  for (const x of pf.groups) x.items = x.items.filter((i) => i !== meta.id)
}

// REQ-F-742: an ended session is kept in 이어서 하기 for 7 days, then removed like 제거. Checked once a day, and a
// minute after the server starts (every push to main restarts it, so a day may never pass in one run).
const ENDED_KEEP_MS = 7 * 86_400_000
const ENDED_SWEEP_MS = 86_400_000
const endedAt = (m) => Math.max(m.lastAt ?? 0, m.closedAt ?? m.updatedAt ?? 0)
function sweepEnded(now = Date.now()) {
  const uids = new Set()
  let n = 0
  for (const meta of [...sessions.values()]) {
    if (!meta.closed || meta.moving || now - endedAt(meta) < ENDED_KEEP_MS) continue
    forgetSession(meta)
    uids.add(meta.uid)
    n++
    log(`session ${meta.id}: 끝난 지 7일이 지나 이어서 하기에서 지움`)
  }
  for (const uid of uids) savePrefs(uid)
  return n
}
setTimeout(sweepEnded, 60_000).unref?.()
setInterval(sweepEnded, ENDED_SWEEP_MS).unref?.()

// A 자동 대응 session that said the deploy is done (REPORT_DONE on a line of its own) is closed once its turn is
// over: a moment after, so the last lines of the report land first. Kept in meta.json, so a deploy that restarts
// the server in between does not lose it.
const REPORT_DONE = '[제보 대응: 배포 완료]'
const REPORT_DONE_RE = /^[ \t]*\[제보 대응: 배포 완료\][ \t]*$/m
const REPORT_CLOSE_MS = 5000
const reportClosing = new Set()
function closeWhenReportDone(meta) {
  if (!meta.reportDeployed || meta.closed || reportClosing.has(meta.id)) return
  reportClosing.add(meta.id)
  setTimeout(() => {
    reportClosing.delete(meta.id)
    if (meta.closed || meta.moving || sessions.get(meta.id) !== meta || !['idle', 'ended'].includes(meta.state.phase)) return
    closeSession(meta, '종료(자동 대응: 배포 완료)')
    touch(meta)
    log(`report ${meta.reportAuto}: 배포 완료, 자동 대응 세션 ${meta.id} 종료`)
  }, REPORT_CLOSE_MS).unref?.()
}

function ownSession(uid, sid) {
  const meta = sessions.get(sid)
  if (!meta || meta.uid !== uid) throw new Refuse(404, '세션이 없습니다')
  return meta
}
/** Starts a session on one of the person's Macs (새 세션, 제보의 "이 오류 고치기"). Returns its id. */
// ---------- 다른 맥에 맡기기 (REQ-F-760)

/** At most this many sessions one session has handed work to that are still open. */
const DELEGATE_MAX = 3
/** The group a session handed work by another session goes in (made at the top when there is none). */
const DELEGATE_GROUP = 'Bridge 맡긴 세션'
const DELEGATE_WAIT_MAX = 1_800_000
/** Macs the person turned off for work from other Macs (설정 → 맥). */
const delegateOff = (uid) => new Set(prefsOf(uid).delegateOff ?? [])
/** The open sessions a session handed work to. */
const delegatesOf = (meta) => (meta.delegates ?? []).map((id) => sessions.get(id)).filter((c) => c && !c.closed && c.delegatedBy === meta.id)

/** Where a session handed work to stands, from the events after `since`: done once a turn ended with an answer. */
function delegateState(meta, since) {
  const after = readEvents(meta).filter((e) => e.seq > since)
  const answer = after.filter((e) => e.k === 'text' && e.text).at(-1)?.text ?? ''
  const phase = meta.state?.phase ?? 'ended'
  const state = meta.closed ? 'closed' : phase === 'waiting' ? 'waiting' : ['idle', 'ended'].includes(phase) && answer ? 'done' : 'working'
  return { state, phase, ...(state === 'waiting' && meta.card?.title ? { waitingOn: String(meta.card.title).slice(0, 200) } : {}), answer: answer.length > 20_000 ? `${answer.slice(0, 20_000)}\n…(잘림)` : answer }
}
/** How long a turn must stay ended before it counts: a session is briefly idle between tool calls too. */
const DELEGATE_SETTLE_MS = 5000
/** sid → tool calls waiting on that session right now. In memory only: a call does not outlive the server. */
const awaited = new Map()
async function waitTurn(meta, since, ms) {
  const end = Date.now() + ms
  let doneSince = 0
  awaited.set(meta.id, (awaited.get(meta.id) ?? 0) + 1)
  try {
    for (;;) {
      const st = delegateState(meta, since)
      doneSince = st.state === 'done' ? doneSince || Date.now() : 0
      if ((doneSince && Date.now() - doneSince >= DELEGATE_SETTLE_MS) || st.state === 'closed' || Date.now() >= end) {
        // The call hands this answer over itself: the follow-up message below does not send it again.
        if (st.state === 'done') meta.reportedSeq = meta.seq ?? 0
        return st
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
  } finally {
    const n = (awaited.get(meta.id) ?? 1) - 1
    if (n > 0) awaited.set(meta.id, n)
    else awaited.delete(meta.id)
  }
}

/**
 * A session that was handed work and finished a turn tells the session that handed it over (1.236): its answer
 * goes into that conversation as a message, so its Claude picks the work up again without being asked. Nothing is
 * sent while a tool call is waiting on it (that call returns the answer), for a turn without new text, or to a
 * parent that is closed or not running. Before this, only a call that waited heard of the end; a Claude that
 * watched with its own polling script missed it whenever its script's test did not match the answer.
 */
const DELEGATE_REPORT_MAX = 6000
const followTimers = new Map()
function followDelegate(c) {
  clearTimeout(followTimers.get(c.id))
  followTimers.set(c.id, setTimeout(() => {
    followTimers.delete(c.id)
    const parent = sessions.get(c.delegatedBy ?? '')
    if (c.closed || !parent || parent.closed || parent.uid !== c.uid || awaited.get(c.id)) return
    const st = delegateState(c, c.reportedSeq ?? 0)
    if (st.state !== 'done') return
    c.reportedSeq = c.seq ?? 0
    touch(c)
    const host = hosts[c.hostId]?.name ?? '다른 맥'
    const answer = st.answer.length > DELEGATE_REPORT_MAX ? `${st.answer.slice(0, DELEGATE_REPORT_MAX)}\n…(잘림, 전체는 delegate_status)` : st.answer
    const text = `↪ ${host} 에 맡긴 세션의 턴이 끝났어요 (id ${c.id}, "${(c.title || '').replace(/^↪\s*/, '').slice(0, 60)}")\n\n${answer}`
    if (!parent.state.alive || !online(parent.hostId)) {
      logEvents(parent, [{ k: 'notice', tone: 'info', text: `↪ ${host} 에 맡긴 세션이 끝났어요. 이 세션이 멈춰 있어 전하지 못했어요` }])
      return
    }
    sessionOp(parent.uid, parent, 'send', { text, via: 'delegated' })
      .then(() => record(parent.uid, parent.hostId, { level: 'info', area: 'delegate', sid: parent.id, text: `맡긴 세션 ${c.id.slice(0, 8)} 의 답을 전함` }))
      .catch((e) => log(`delegate follow ${c.id}: ${e.message}`))
  }, DELEGATE_SETTLE_MS))
  followTimers.get(c.id).unref?.()
}

/** One request of a session's bridge MCP server, through its Mac's agent (agent/mcp.mjs). */
async function runDelegate(uid, hostId, msg) {
  const parent = sessions.get(String(msg.sid ?? ''))
  if (!parent || parent.uid !== uid || parent.hostId !== hostId || parent.closed) throw new Error('이 세션을 서버가 모릅니다')
  const a = msg.args && typeof msg.args === 'object' ? msg.args : {}
  const ms = Math.min(DELEGATE_WAIT_MAX, Math.max(10, Number(a.timeout_s) || 600) * 1000)
  const brief = (c, st) => ({ id: c.id, host: hosts[c.hostId]?.name ?? '', ...st })
  const child = () => {
    const c = sessions.get(String(a.id ?? ''))
    if (!c || c.uid !== uid || c.delegatedBy !== parent.id) throw new Error('이 세션이 맡긴 세션이 아니에요')
    return c
  }
  const own = Object.entries(hosts).filter(([, h]) => h.uid === uid)
  if (msg.op === 'hosts') return own.map(([id, h]) => ({ name: h.name, online: online(id), takesWork: !delegateOff(uid).has(id), thisMac: id === hostId }))
  if (msg.op === 'delegate') {
    // One level only: a session that was handed work does not hand it on, so no two Macs pass work in a circle.
    if (parent.delegatedBy) throw new Error('맡겨진 세션은 다른 맥에 다시 맡길 수 없어요')
    const name = String(a.host ?? '').trim().toLowerCase()
    const found = own.find(([id, h]) => id === a.host || String(h.name).toLowerCase() === name)
    if (!found) throw new Error(`그런 맥이 없어요: ${a.host}. hosts 로 이름을 확인하세요`)
    const [target, h] = found
    if (delegateOff(uid).has(target)) throw new Error(`${h.name} 은 다른 맥의 일을 받지 않게 꺼져 있어요(맥 화면에서 켤 수 있어요)`)
    if (!online(target)) throw new Error(`${h.name} 이 연결돼 있지 않아요`)
    const task = String(a.task ?? '').trim()
    if (!task) throw new Error('task 가 비어 있어요')
    if (delegatesOf(parent).length >= DELEGATE_MAX) throw new Error(`이미 ${DELEGATE_MAX}개를 맡겨 두었어요. 끝난 것은 delegate_stop 으로 닫으세요`)
    // It follows this session's permission policy: 전부 허용 here is 전부 허용 there (REQ-F-759 still asks).
    // No folder named: a new one under the person's default folder, in the group of the session handing it over.
    // The session itself goes in the group "Bridge 맡긴 세션" (made when there is none), apart from people's own.
    const L = launchOf(uid)
    const cwd = String(a.cwd ?? '').trim() || defaultFolder({ base: L.folderBase, noGroup: L.folderNoGroup, group: prefsOf(uid).groups.find((g) => g.items.includes(parent.id))?.name })
    const sid = await startSession(uid, { hostId: target, cwd, create: !String(a.cwd ?? '').trim(), prompt: task, title: `↪ ${task.replace(/\s+/g, ' ').slice(0, 70)}`, mode: parent.autoAllow ? 'autoAllow' : 'default', via: 'delegate', group: namedGroup(uid, DELEGATE_GROUP) }, { internal: true })
    const c = sessions.get(sid)
    const from = hosts[hostId]?.name ?? ''
    c.delegatedBy = parent.id
    parent.delegates = [...(parent.delegates ?? []).filter((id) => sessions.has(id)), sid]
    logEvents(c, [{ k: 'notice', tone: 'info', text: `↪ ${from} 의 세션 "${parent.title || parent.id.slice(0, 8)}" 이 맡긴 일이에요. 허용 정책은 그 세션을 따라가요.` }])
    logEvents(parent, [{ k: 'notice', tone: 'info', text: `↪ ${h.name} 에 일을 맡겼어요: ${task.replace(/\s+/g, ' ').slice(0, 120)}` }])
    addNotice(uid, { sid, key: `delegate-${sid}`, title: '다른 맥에 일을 맡겼어요', text: `${from} → ${h.name}: ${task.replace(/\s+/g, ' ').slice(0, 100)}`, tone: 'info', push: true })
    record(uid, target, { level: 'info', area: 'delegate', sid, text: `${from} 의 세션이 일을 맡김` })
    touch(c)
    touch(parent)
    return brief(c, a.wait === false ? delegateState(c, 0) : await waitTurn(c, 0, ms))
  }
  if (msg.op === 'delegate_status') {
    const c = child()
    return brief(c, a.wait ? await waitTurn(c, 0, ms) : delegateState(c, 0))
  }
  if (msg.op === 'delegate_send') {
    const c = child()
    if (c.closed) throw new Error('닫힌 세션이에요')
    const text = String(a.text ?? '').trim()
    if (!text) throw new Error('text 가 비어 있어요')
    const since = c.seq ?? 0
    await sessionOp(uid, c, 'send', { text, via: 'delegate' })
    return brief(c, a.wait === false ? delegateState(c, since) : await waitTurn(c, since, ms))
  }
  if (msg.op === 'delegate_stop') {
    const c = child()
    if (!c.closed) closeSession(c, '맡긴 세션이 닫음')
    broadcastState(uid)
    return brief(c, { state: 'closed' })
  }
  throw new Error(`모르는 요청: ${msg.op}`)
}

// ---------- 관리자 권한 (REQ-F-764)
// The admin password stays on the Mac (agent memory, 5 minutes). Here only what the page shows: until when root is
// open on each Mac, and who is waiting for the password. The password passes through once and is never kept or logged.

/** hostId → { until, asks: Map(areq → { sid, title, what, at }) } */
const sudoHosts = new Map()
const sudoOf = (hostId) => sudoHosts.get(hostId) ?? sudoHosts.set(hostId, { until: 0, asks: new Map() }).get(hostId)
const SUDO_SLACK = 'Slack 에서 작업 중인 세션은 관리자 권한을 쓸 수 없어요. 브릿지로 옮긴 뒤 다시 해 주세요'
function sudoView(hostId) {
  const st = sudoHosts.get(hostId)
  if (!st) return null
  const until = st.until > Date.now() ? st.until : 0
  return { until, asks: [...st.asks].map(([id, a]) => ({ id, ...a })) }
}
/** Answers one agent's waiting sudo request and takes it off the page. */
function sudoAnswer(hostId, areq, ok, error) {
  const st = sudoOf(hostId)
  st.asks.delete(areq)
  toHost(hostId, { t: 'sudoans', areq, ok, ...(error ? { error } : {}) })
  const uid = hosts[hostId]?.uid
  if (uid) dropNotices(uid, (n) => n.key === `sudo-${areq}`)
}
const sudoFromAgent = {
  /** A session wants root: refused when it is worked on in Slack; let through, or asked of the person when no password is kept. */
  sudoask(uid, hostId, msg) {
    if (typeof msg.areq !== 'string' || !msg.areq) return
    const meta = sessions.get(String(msg.sid ?? ''))
    if (!owns(meta, uid, hostId) || meta.closed) return sudoAnswer(hostId, msg.areq, false, '이 세션을 서버가 모릅니다')
    if (seatOf(meta) === 'slack') {
      logEvents(meta, [{ k: 'notice', tone: 'warn', text: `🔐 ${SUDO_SLACK}` }])
      return sudoAnswer(hostId, msg.areq, false, SUDO_SLACK)
    }
    if (!msg.need) return sudoAnswer(hostId, msg.areq, true)
    const what = String(msg.what ?? '').slice(0, 300)
    sudoOf(hostId).asks.set(msg.areq, { sid: meta.id, title: meta.title || '', what, at: Date.now() })
    addNotice(uid, { sid: meta.id, key: `sudo-${msg.areq}`, title: '관리자 비밀번호가 필요해요', text: `${hosts[hostId]?.name ?? ''} · ${what}`, tone: 'warn', push: true })
    broadcastState(uid)
  },
  /** The agent stopped waiting (2 minutes passed). */
  sudogone(uid, hostId, msg) {
    if (!sudoOf(hostId).asks.delete(String(msg.areq))) return
    dropNotices(uid, (n) => n.key === `sudo-${msg.areq}`)
    broadcastState(uid)
  },
  /** Until when root is open on that Mac, and which requests it still waits on (a restarted agent waits on none). */
  sudostate(uid, hostId, msg) {
    const st = sudoOf(hostId)
    st.until = Number(msg.until) || 0
    const waiting = new Set(Array.isArray(msg.waiting) ? msg.waiting.map(String) : [])
    for (const areq of [...st.asks.keys()]) if (!waiting.has(areq)) st.asks.delete(areq)
    broadcastState(uid)
  },
}
Object.assign(fromAgent, sudoFromAgent)
/** macOS shows one of its own alerts (a privacy prompt) while sessions work: they wait on it until someone at the Mac answers. */
fromAgent.sysdialog = (uid, hostId, msg) => {
  const key = `sysdialog-${hostId}`
  if (!msg.on) return dropNotices(uid, (n) => n.key === key)
  const sid = (Array.isArray(msg.sids) ? msg.sids.map(String) : []).find((id) => owns(sessions.get(id), uid, hostId))
  addNotice(uid, { sid, key, title: '맥에 시스템 허락 창이 떠 있어요', text: `${hosts[hostId]?.name ?? ''} · 맥에서 직접 눌러 주세요. 그동안 일하던 세션이 멈춰 있을 수 있어요`, tone: 'warn', push: 'always' })
}


/** `:sudo <command>` (REQ-F-764): runs as root on the session's Mac; what it printed goes into the conversation. */
function sudoCommand(uid, meta, command, opts) {
  if (opts.via === 'slack' || seatOf(meta) === 'slack') throw new Refuse(403, SUDO_SLACK)
  if (!command) throw new Refuse(400, '실행할 명령을 적어 주세요. 예: :sudo whoami')
  const hostId = liveHost(meta)
  logEvents(meta, [{ k: 'line', text: `🔐 관리자 권한으로 실행: \`${command.replace(/\s+/g, ' ').slice(0, 200)}\`` }])
  ask(hostId, { t: 'sudo', sid: meta.id, command }, 10 * 60_000).then((r) => {
    const out = String(r.out ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s+$/, '')
    const text = r.ok ? `# ${command}\n${out || '(출력 없음)'}${r.code ? `\n(종료 코드 ${r.code})` : ''}` : `🔐 실행하지 않았어요: ${r.error ?? '실패했어요'}`
    logEvents(meta, [r.ok ? { k: 'local', text, error: r.code !== 0 } : { k: 'notice', tone: 'warn', text }])
    record(uid, hostId, { level: r.ok ? 'info' : 'warn', area: 'sudo', sid: meta.id, text: r.ok ? `관리자 권한으로 명령 실행 (종료 코드 ${r.code})` : `관리자 권한 명령 실패: ${r.error ?? ''}` })
  })
  return '관리자 권한으로 실행해요'
}

async function startSession(uid, b, req = {}) {
  ownHost(uid, b.hostId)
  if (!online(b.hostId)) throw new Refuse(409, '호스트가 연결돼 있지 않습니다')
  const sid = crypto.randomUUID()
  const prompt = String(b.prompt || '').slice(0, 100_000)
  // The session exists from here on, as "starting": what the agent reports while claude launches (its first
  // hooks, the first lines) has somewhere to go, and the list shows it at once.
  const meta = newMeta(uid, sid, b.hostId, { title: String(b.title || '').slice(0, 80) || prompt.replace(/\s+/g, ' ').slice(0, 80) })
  meta.state = { ...noState(), alive: true, phase: 'starting' }
  // One started from a Slack message is worked on in Slack until it is moved.
  if (b.via === 'slack' && req.internal) meta.seat = { where: 'slack', at: Date.now(), url: null }
  // Claude in Chrome turned off for this session (새 세션 화면): kept, so a move or reopen keeps it off.
  if (b.chrome === false) meta.chrome = false
  // Started from a group's menu (이 그룹에 새 세션): it goes in that group, last. A group that is gone is ignored.
  const into = typeof b.group === 'string' ? prefsOf(uid).groups.find((x) => x.id === b.group) : null
  if (into && !into.items.includes(sid)) into.items.push(sid)
  // The first prompt is said now, before claude starts: its echo in the transcript must find it already logged.
  if (prompt.trim()) logSaid(meta, crypto.randomUUID(), prompt.trim(), { via: b.via === 'slack' ? 'slack' : b.via === 'delegate' && req.internal ? 'delegate' : 'web' })
  if (into) savePrefs(uid)
  else broadcastState(uid)
  // A field the request leaves out takes the person's default (설정); one sent empty means the Mac's own default.
  const L = launchOf(uid)
  for (const k of ['model', 'effort', 'mode']) if (b[k] === undefined) b[k] = L[k]
  // The Claude account it runs in (새 세션 화면); none named is the Mac's main account.
  const account = safeAccount(b.account) ? b.account : ''
  const r = await ask(b.hostId, { t: 'new', sid, sysPrompt: sysPromptOf(uid), create: b.create === true, cwd: String(b.cwd || '~').slice(0, 1000), prompt, autoPush: true, model: String(b.model || '').slice(0, 60), effort: String(b.effort || '').slice(0, 10), mode: startMode(String(b.mode || '').slice(0, 20)).mode, ...(b.chrome === false ? { chrome: false } : {}), ...(account ? { account } : {}) }, 60_000)
  if (!r.ok) {
    sessions.delete(sid)
    dirty.delete(sid)
    fs.rmSync(sessionDir(meta), { recursive: true, force: true })
    if (into) (into.items = into.items.filter((x) => x !== sid)), savePrefs(uid)
    broadcastState(uid)
    record(uid, b.hostId, { level: 'error', area: 'new', sid, text: `세션을 시작하지 못함: ${r.error}` })
    throw Object.assign(new Refuse(r.missing ? 404 : 502, r.error || '세션을 시작하지 못했습니다'), { extra: r.missing ? { missing: true } : {} })
  }
  meta.cwd = r.cwd
  meta.account = safeAccount(r.account) ? r.account : account
  if (b.model) meta.launchModel = String(b.model).slice(0, 60)
  if (startMode(String(b.mode || '')).autoAllow) turnOnAutoAllow(meta)
  touch(meta)
  // Anything it said before this point may have been said to nobody: have it say where it stands.
  toHost(b.hostId, { t: 'report', sid })
  return sid
}

function ownHost(uid, hostId) {
  if (!hosts[hostId] || hosts[hostId].uid !== uid) throw new Refuse(404, '호스트가 없습니다')
  return hosts[hostId]
}
/**
 * A host's status and log may be read, and its agent's own switches (지금 복구, 헤드리스 연동 모드, 잠자기 막기) used,
 * by its owner and by an operator. Its sessions, folders and conversations stay its owner's.
 */
function readableHost(uid, hostId) {
  if (!hosts[hostId] || (hosts[hostId].uid !== uid && !isAdmin(uid))) throw new Refuse(404, '호스트가 없습니다')
  return hosts[hostId]
}
/** A log line without the paths in it, for an operator reading someone else's Mac (R1-M5). */
/** Said after a host log line when an operator did it on someone else's Mac. */
const byOperator = (uid, h) => (h.uid === uid ? '' : ` · 운영자 ${users[uid]?.login ?? uid}`)
function liveHost(meta) {
  if (meta.closed) throw new Refuse(409, '끝난 세션입니다')
  if (meta.moving) throw new Refuse(409, '세션을 옮기는 중입니다')
  if (!online(meta.hostId)) throw new Refuse(409, '세션의 호스트가 연결돼 있지 않습니다')
  return meta.hostId
}

/**
 * Move a session to another host. The same path serves a user-initiated move, a switch after a disconnect,
 * and going back to a host that returned: the target is always overwritten with the server's latest copy.
 */
async function moveSession(meta, target, toAccount, { cwd: newCwd } = {}) {
  if (meta.moving) throw new Refuse(409, '이미 옮기는 중입니다')
  if (meta.closed) throw new Refuse(409, '끝난 세션입니다')
  if (!online(target)) throw new Refuse(409, '받는 호스트가 연결돼 있지 않습니다')
  const source = meta.hostId
  const fromAccount = meta.account ?? ''
  // The Claude account on the receiving Mac: the one asked for, else the same one on the same Mac, else its main one.
  // Another folder on the same Mac (REQ-F-785): the same account, the conversation written beside the new folder.
  const relocate = typeof newCwd === 'string'
  if (relocate && target !== source) throw new Refuse(400, '작업 폴더는 같은 맥에서만 바꿀 수 있어요')
  const account = relocate ? fromAccount : safeAccount(toAccount) ? toAccount : target === source ? fromAccount : ''
  if (account && !(hosts[target].accounts ?? []).some((a) => a.id === account)) throw new Refuse(409, '받는 맥에 그 Claude 계정이 없습니다')
  if (account && (hosts[target].accounts ?? []).find((a) => a.id === account)?.loggedIn === false) throw new Refuse(409, '그 Claude 계정은 로그인돼 있지 않습니다. 설정 → Claude 계정에서 먼저 로그인해 주세요')
  // Another account on the same Mac: the conversation goes over like a move, and the Mac stays.
  const switching = !relocate && target === source && account !== fromAccount
  const accountName = (hostId, id) => (hosts[hostId]?.accounts ?? []).find((a) => a.id === id)?.name ?? (id ? '다른 계정' : '기본 계정')
  // Reopening on the same host (claude exited, or the Mac restarted) is a move with no sender.
  const reopen = !relocate && target === source && !switching
  if (reopen && meta.state.alive) throw new Refuse(409, '이미 그 호스트에서 돌고 있습니다')
  const sourceOnline = !reopen && online(source)
  // The conversation comes from the sending Mac itself: the server keeps no copy to switch from (REQ-S-069).
  if (!reopen && !switching && !relocate && !sourceOnline) throw new Refuse(409, `${hosts[source]?.name ?? '보내는 맥'} 이 연결돼 있지 않아 옮길 수 없어요. 서버는 대화 사본을 갖고 있지 않아요. 그 맥을 켜고 연동한 뒤 다시 해 주세요`)
  if (!reopen && !switching && !relocate && !storeOn(source)) throw new Refuse(409, `${hosts[source]?.name ?? '보내는 맥'} 의 에이전트가 업데이트되면 옮길 수 있어요`)
  if (sourceOnline && meta.state.alive && meta.state.phase === 'busy') throw new Refuse(409, '작업 중입니다. 턴이 끝난 뒤에 옮겨 주세요')
  // A confirmation in the middle of a turn would be lost with the terminal it is drawn on. An interrupted session is at rest.
  if (sourceOnline && meta.state.alive && meta.card && meta.card.kind !== 'stuck') throw new Refuse(409, '응답을 기다리는 확인 창이 있습니다. 답한 뒤에 옮겨 주세요')
  meta.moving = { to: target, at: Date.now() }
  broadcastState(meta.uid)
  const note = (level, text) => {
    record(meta.uid, target, { level, area: 'move', sid: meta.id, text })
    if (target !== source) record(meta.uid, source, { level, area: 'move', sid: meta.id, text })
  }
  note('info', relocate ? `작업 폴더 바꾸기 시작 (사본 ${meta.lines}줄)` : reopen ? `${hosts[target].name} 에서 다시 열기 시작` : switching ? `Claude 계정 ${accountName(source, fromAccount)} → ${accountName(target, account)} 옮기기 시작 (사본 ${meta.lines}줄)` : `${hosts[source]?.name} → ${hosts[target].name} 옮기기 시작 (보내는 쪽 ${sourceOnline ? '연결됨' : '끊김'}, 사본 ${meta.lines}줄)`)
  try {
    // An ended session taken to another account on its Mac has nothing left there to flush.
    // The folder as the sending Mac has it now, notes included: the server keeps no note contents (REQ-S-073).
    // A new folder takes nothing from the old one: its repos and notes stay where they are.
    let folder = relocate ? null : meta.folder
    if (sourceOnline && !((switching || relocate) && !meta.state.alive)) {
      const flushed = await ask(source, { t: 'flush', sid: meta.id }, 90_000)
      if (flushed.folder && !relocate) folder = flushed.folder
      if (!flushed.ok) (note('error', `보내는 호스트의 마지막 싱크 실패: ${flushed.error ?? ''}`), (() => { throw new Refuse(502, `보내는 호스트에서 마지막 싱크를 하지 못했습니다: ${flushed.error ?? ''}`) })())
    }
    // To another Mac: the sending Mac's transcript passes through memory to the receiving Mac's open (REQ-S-069).
    const local = reopen || switching || relocate
    if (!local) {
      const parts = []
      for (let from = 0, n = 0; n < 200; n++) {
        const r = await ask(source, { t: 'export', sid: meta.id, conv: meta.conv ?? meta.id, from }, 120_000)
        if (!r.ok) (note('error', `보내는 맥에서 대화를 받지 못함: ${r.error ?? ''}`), (() => { throw new Refuse(502, `보내는 맥에서 대화를 받지 못했어요: ${r.error ?? ''}`) })())
        const part = Buffer.from(String(r.data ?? ''), 'base64')
        parts.push(part)
        from += part.length
        if (r.done || !part.length) break
      }
      moveCopies.set(meta.id, Buffer.concat(parts).toString('utf8'))
    }
    const opened = await ask(target, { t: 'open', ...(local ? { local: true } : {}), sysPrompt: sysPromptOf(meta.uid), sid: meta.id, conv: meta.conv ?? meta.id, cwd: relocate ? newCwd : meta.cwd, home: relocate ? undefined : meta.home, folder, autoPush: meta.autoPush, autoAllow: meta.autoAllow, model: meta.launchModel || '', effort: meta.state.effort || '', mode: meta.state.mode || '', ...(meta.mdFile ? { mdFile: meta.mdFile } : {}), ...(meta.chrome === false ? { chrome: false } : {}), ...(account ? { account } : {}) }, 600_000)
    // Nothing has changed on the source yet: a failure here leaves the session where it was.
    if (!opened.ok) (note('error', `받는 호스트에서 열지 못함: ${opened.error ?? ''}. 세션은 원래 자리에 그대로 있음`), (() => { throw new Refuse(502, `받는 호스트에서 열지 못했습니다: ${opened.error ?? ''}`) })())
    note(opened.warnings?.length ? 'warn' : 'info', `완료${opened.warnings?.length ? ` — 확인할 것: ${opened.warnings.join(' / ')}` : ''}`)
    // The log so far goes from the sending Mac to the receiving one, through memory; one still only on this server
    // goes from here (migrateHost, below).
    const hadLog = !!meta.agentLog
    let carried = hadLog
    if (!local && hadLog) {
      carried = await carryLog(meta, source, target)
      if (!carried) note('warn', '세션 기록을 받는 맥으로 다 옮기지 못함: 보내는 맥이 다시 연결되면 이어서 옮김')
    }
    Object.assign(meta, volatile())
    meta.state = { ...noState(), alive: true, phase: 'idle' }
    // The move is part of the conversation: when, from where to where, and up to which synced line.
    const where = relocate ? `작업 폴더를 ${opened.cwd ?? newCwd} 로 바꿨습니다` : reopen ? `${hosts[target].name} 에서 다시 열었습니다` : switching ? `Claude 계정 ${accountName(source, fromAccount)} → ${accountName(target, account)} 로 옮겼습니다` : `${hosts[source]?.name ?? '알 수 없는 기기'} → ${hosts[target].name} 로 옮겼습니다`
    const notice = { k: 'notice', tone: opened.warnings?.length ? 'warn' : 'info', ...(switching ? { icon: 'move' } : {}), text: `${where} · 사본 ${meta.lines}줄 기준${opened.warnings?.length ? ` · 확인할 것: ${opened.warnings.join(' / ')}` : ''}` }
    meta.account = safeAccount(opened.account) ? opened.account : account
    if (relocate) Object.assign(meta, { cwd: opened.cwd ?? newCwd, folder: null })
    if (switching) meta.moves.push({ at: Date.now(), from: source, to: target, lines: meta.lines, sourceOnline, warnings: opened.warnings ?? [], fromAccount, account })
    // Released only on another Mac: on this one the open above already took the session over from the old account.
    if (!reopen && !switching && !relocate) {
      meta.moves.push({ at: Date.now(), from: source, to: target, lines: meta.lines, sourceOnline, warnings: opened.warnings ?? [] })
      Object.assign(meta, { prevHostId: source, hostId: target, cwd: opened.cwd, home: hosts[target].home, folder: null, agentLog: !!carried })
      // Not all of it came over: the rest follows when both Macs are connected again (migrateHost).
      if (!carried && hadLog) meta.carryFrom = source
      toHost(source, { t: 'release', sid: meta.id })
    }
    // Logged on the Mac the session is on now.
    logEvents(meta, [notice])
    toHost(target, { t: 'report', sid: meta.id })
    if (!meta.agentLog && storeOn(target)) setTimeout(() => void migrateHost(meta.uid, target), 0)
    return { ok: true, warnings: opened.warnings ?? [] }
  } finally {
    moveCopies.delete(meta.id)
    meta.moving = null
    touch(meta)
  }
}
/** sid -> the transcript passing from the sending Mac to the receiving one during a move. Memory only. */
const moveCopies = new Map()
/** A session's log from one Mac to another, a page at a time, each page kept before the next (REQ-S-069). */
async function carryLog(meta, from, to) {
  let after = 0
  for (let n = 0; n < 10_000; n++) {
    if (!online(from) || !online(to)) return false
    const r = await ask(from, { t: 'events', sid: meta.id, after, limit: 500 }, 30_000)
    if (!r.ok || !Array.isArray(r.events)) return false
    if (r.events.length) {
      const lid = handDown(to, { t: 'log', sid: meta.id, events: r.events })
      if (!lid || !(await waitKept(lid, 120_000))) return false
      after = r.events.at(-1).seq
    }
    if (!r.more) return true
  }
  return false
}

// ---------- http ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
// A session's localhost server, shown on another device: its own origin (server/preview.mjs).
const preview = createPreview({
  dataDir: DATA,
  origin: ORIGIN,
  port: PORT,
  ask,
  toHost: (hostId, cmd) => toHost(hostId, cmd),
  log,
  canUse: (uid, hostId, sid) => (hosts[hostId]?.uid !== uid ? '이 미리보기의 기기를 찾지 못했어요.' : sessions.get(sid)?.uid !== uid || sessions.get(sid).closed ? '이 미리보기를 연 세션이 끝났어요. 세션 화면의 컴퓨터 버튼으로 다시 열어 주세요.' : online(hostId) ? null : '그 맥이 지금 연결돼 있지 않아요. 맥이 켜져 있고 연동 탭이나 헤드리스 연동이 돌고 있는지 봐 주세요.'),
})

const SECURITY = {
  // Inline styles are allowed for the HTML previews: a preview is written into a sandboxed frame that inherits
  // this policy, and its own stricter one (no scripts, no network) goes in ahead of its content.
  'Content-Security-Policy': `default-src 'self'; img-src 'self' data: blob: https://avatars.githubusercontent.com; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:*; frame-src 'self' ${preview.ORIGINS.join(' ')}; frame-ancestors 'self'`,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

/** Which build of the page (ui/dist) this server sends, for a report: its index.html names every hashed file. */
let pageBuild = null
function PAGE_BUILD() {
  try {
    const file = path.join(UI, 'index.html')
    const stamp = fs.statSync(file).mtimeMs
    if (pageBuild?.stamp !== stamp) pageBuild = { stamp, id: crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 10) }
    return pageBuild.id
  } catch {
    return ''
  }
}

/**
 * Text sent compressed when the browser takes it: Brotli, else gzip. The page's script was 404 KB on the wire
 * uncompressed (127 KB gzip, less with Brotli). Static files are compressed once per version and kept; a JSON
 * answer of 1 KB or more is gzipped as it goes (fast level: a few ms for the largest event page).
 */
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest\+json)|image\/svg\+xml)/
const encodingOf = (req) => {
  const a = String(req?.headers?.['accept-encoding'] ?? '')
  return /\bbr\b/.test(a) ? 'br' : /\bgzip\b/.test(a) ? 'gzip' : null
}
const compressedFiles = new Map() // file -> { mtime, raw, br?, gzip? }
/**
 * Read a file once per version and compress it off the main thread (Brotli at its best level takes about
 * 600 ms for the page's script: done synchronously it held every other request up). Until the Brotli copy is
 * ready a fast gzip copy is sent.
 */
function fileEntry(file, st, type) {
  let hit = compressedFiles.get(file)
  if (hit?.mtime === st.mtimeMs) return hit
  const raw = fs.readFileSync(file)
  hit = { mtime: st.mtimeMs, raw }
  compressedFiles.set(file, hit)
  if (COMPRESSIBLE.test(type) && raw.length >= 1024) {
    hit.gzip = zlib.gzipSync(raw, { level: 6 })
    zlib.brotliCompress(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }, (err, out) => !err && (hit.br = out))
    zlib.gzip(raw, { level: 9 }, (err, out) => !err && (hit.gzip = out))
  }
  return hit
}
function sendFile(res, file, cache = 'no-cache') {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return res.writeHead(404).end('not found')
    const type = MIME[path.extname(file)] ?? 'application/octet-stream'
    const hit = fileEntry(file, st, type)
    const want = hit.gzip ? encodingOf(res.req) : null
    const enc = want === 'br' && !hit.br ? (/\bgzip\b/.test(String(res.req?.headers?.['accept-encoding'] ?? '')) ? 'gzip' : null) : want
    res.writeHead(200, { ...SECURITY, 'Content-Type': type, 'Cache-Control': cache, Vary: 'Accept-Encoding', ...(enc ? { 'Content-Encoding': enc } : {}) }).end(enc ? hit[enc] : hit.raw)
  })
}
/** At start: the control page's files are read and compressed before anyone asks for them. */
setImmediate(() => {
  try {
    for (const name of fs.readdirSync(path.join(ROOT, 'ui', 'dist', 'assets'))) {
      const file = path.join(ROOT, 'ui', 'dist', 'assets', name)
      fileEntry(file, fs.statSync(file), MIME[path.extname(file)] ?? 'application/octet-stream')
    }
  } catch {}
})

/** The control page (ui/, built into ui/dist). Read once per build; it carries no inline script. */
const UI = path.join(ROOT, 'ui', 'dist')
let uiCache = null
/** The entry file of the page in ui/dist (`index-<hash>.js`), read again when index.html changes. null without a build. */
let uiBuildCache = null
function uiBuild() {
  try {
    const file = path.join(UI, 'index.html')
    const mtime = fs.statSync(file).mtimeMs
    if (uiBuildCache?.mtime !== mtime) uiBuildCache = { mtime, name: /\/assets\/(index-[\w-]+\.js)/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? null }
    return uiBuildCache.name
  } catch {
    return null
  }
}
function sendUi(res) {
  const file = path.join(UI, 'index.html')
  const mtime = fs.statSync(file).mtimeMs
  if (uiCache?.mtime !== mtime) uiCache = { mtime, body: fs.readFileSync(file) }
  res.writeHead(200, { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }).end(uiCache.body)
}
const json = (res, status, obj, headers = {}) => {
  const body = JSON.stringify(obj)
  const enc = body.length >= 1024 && /\bgzip\b/.test(String(res.req?.headers?.['accept-encoding'] ?? '')) ? 'gzip' : null
  if (!enc) return res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }).end(body)
  // gzip even when Brotli is offered: at a fast level it is the cheaper of the two for answers made per request.
  return res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', 'Content-Encoding': 'gzip', ...headers }).end(zlib.gzipSync(body, { level: 4 }))
}

const originOf = (req) => ORIGIN || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]))
/** Every value a cookie name has in the request: a cookie planted for a parent domain comes along with ours. */
const cookieAll = (req, name) => (req.headers.cookie || '').split(/;\s*/).filter((c) => c.slice(0, c.indexOf('=')) === name).map((c) => c.slice(c.indexOf('=') + 1))
/** A page that may hold Secure cookies: https, or this machine (browsers count http://localhost as secure). */
const secureSite = (req) => {
  const u = new URL(originOf(req))
  return u.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
}
// Sign-in cookies are `__Host-` (REQ-S-080): Secure, Path=/, no Domain, so a page of another subdomain (the preview
// origins lp*.<site>) cannot plant one and sign a visitor in as someone else. Plain http elsewhere keeps the bare
// name: it cannot hold a Secure cookie at all.
const cname = (req, base) => (secureSite(req) ? `__Host-${base}` : base)
const cookie = (req, name, value, maxAge) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${name.startsWith('__Host-') || originOf(req).startsWith('https:') ? '; Secure' : ''}`
/** Until then a sign-in still carried by the old `cb` is moved to `__Host-cb` instead of being signed out (REQ-S-080). */
const LEGACY_CB_UNTIL = Date.parse('2026-11-02T00:00:00Z')
/** Set-Cookie lines that drop the old `cb` the request carries: ours (host only) and any planted for this host or a parent domain. */
function legacyCbClears(req) {
  if (!secureSite(req) || !cookieAll(req, 'cb').length) return []
  const host = new URL(originOf(req)).hostname
  const parts = host.split('.')
  const domains = /^[\d.]+$|^\[|^localhost$/.test(host) ? [] : parts.slice(0, -1).map((_, i) => parts.slice(i).join('.'))
  const base = 'cb=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure'
  return [base, ...domains.map((d) => `${base}; Domain=${d}`)]
}
/** The sign-in token of a request; a moved one (migrateLegacyCb) counts in the same request. */
const sessionToken = (req) => req.movedCb ?? cookies(req)[cname(req, 'cb')]

/**
 * The move from `cb` to `__Host-cb` (REQ-S-080), until LEGACY_CB_UNTIL. Only when there is no `__Host-cb`: one that
 * is there always wins, and the old name is dropped. Only one `cb` that is a live sign-in is moved: two (ours and one
 * planted for a parent domain) cannot be told apart, so neither counts.
 */
function migrateLegacyCb(req, res) {
  if (!secureSite(req)) return
  const old = cookieAll(req, 'cb')
  if (!old.length) return
  const clears = legacyCbClears(req)
  if (!cookies(req)['__Host-cb'] && Date.now() < LEGACY_CB_UNTIL && old.length === 1) {
    const login = logins[sha256(old[0])]
    if (login && login.exp > Date.now()) {
      req.movedCb = old[0]
      return res.setHeader('Set-Cookie', [cookie(req, '__Host-cb', old[0], Math.max(1, Math.floor((login.exp - Date.now()) / 1000))), ...clears])
    }
  }
  res.setHeader('Set-Cookie', clears)
}

function whoami(req) {
  const token = sessionToken(req)
  const login = token && logins[sha256(token)]
  if (!login || login.exp < Date.now()) return null
  // Known by its uid, never by a name: it is no GitHub account and no allow-list speaks for it (REQ-S-068).
  // A demo sign-in never runs out while 데모 모드 is on: an account cleared since (a restart, too many at once) is
  // made again from the seed.
  if (isDemoUid(login.uid)) return demoOn ? demoTouch(login.uid) : null
  if (!users[login.uid]) return null
  // The allow-list is checked on every request, so removing a login from it takes effect at once.
  if (!isAllowed(users[login.uid].login)) return null
  return login.uid
}

function signIn(req, res, uid, next, more = []) {
  const token = crypto.randomBytes(32).toString('base64url')
  logins[sha256(token)] = { uid, exp: Date.now() + LOGIN_DAYS * 86_400_000 }
  touchGlobals()
  res.writeHead(302, { Location: next, 'Set-Cookie': [cookie(req, cname(req, 'cb'), token, LOGIN_DAYS * 86_400), cookie(req, cname(req, 'cb_state'), '', 0), ...more, ...legacyCbClears(req)] }).end()
}
/** Sign-ins past their end go every hour (REQ-S-074): a hash no one can use is no reason to keep whose it was. */
function dropExpiredLogins() {
  const now = Date.now()
  let n = 0
  for (const [k, v] of Object.entries(logins)) if (!(v?.exp > now)) (delete logins[k], n++)
  if (n) touchGlobals()
}
dropExpiredLogins()
setInterval(dropExpiredLogins, 3600_000).unref()

/**
 * sha256(code) -> { uid, exp, sid }. A code shown as a QR on a signed-in screen: scanning it signs the phone in
 * as the same account. Five minutes, one use, never written to disk.
 */
const qrCodes = new Map()
const QR_MS = 5 * 60_000

const attempts = new Map()
/** Requests per address in the last 60,000 ms, counted per kind (sign-in and lock attempts do not share a count). */
/**
 * Where a request comes from. Behind the site's proxy the last X-Forwarded-For entry is the one that proxy wrote;
 * the ones before it are whatever the client sent (R1-M4: the first was used, so changing it got round every limit).
 */
const clientIp = (req) => String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean).at(-1) || req.socket?.remoteAddress || ''
/** One more try under key; true when there have been more than max in the last minute. */
function hit(key, max) {
  const now = Date.now()
  const a = attempts.get(key)?.filter((t) => now - t < 60_000) ?? []
  a.push(now)
  attempts.set(key, a)
  return a.length > max
}
const limited = (req, max = 20, kind = 'auth') => hit(`${kind}|${clientIp(req)}`, max)
// Keys whose tries are all over a minute old are dropped, so addresses that came once do not pile up.
setInterval(() => {
  const now = Date.now()
  for (const [k, a] of attempts) if (!a.some((t) => now - t < 60_000)) attempts.delete(k)
}, 60_000).unref?.()

/** A request's body as text, up to limit bytes. */
async function rawBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new Refuse(413, '요청이 너무 큽니다')
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

async function body(req, limit) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new Refuse(413, '요청이 너무 큽니다')
    chunks.push(c)
  }
  let value
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Refuse(400, 'JSON 이 아닙니다')
  }
  // Every route reads fields of an object: null, a number or a list would fail later as a server error.
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Refuse(400, 'JSON 객체가 아닙니다')
  return value
}

// A path on this site only: "//host/…" would be read by the browser as another site.
const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)[a-zA-Z0-9/_-]*(?:\?[\w=&,-]*)?$/.test(n) ? n : '/')
/** The control page's own addresses (ui/src/lib/router.ts matchRoute): each is served the same page. */
const APP_PATH = /^\/(?:s\/[\w-]+|new|stats|quality|hosts(?:\/[\w-]+)?|admin(?:\/reports\/[\w-]+)?|settings(?:\/[a-z]+)?|split|guide(?:\/(?:move|accounts))?)$/
/** The five font sizes of the app (ui/src/styles.css), for the small pages the server writes itself. */
const FONT_TOKENS = ':root{--fs-xsmall:12px;--fs-small:13px;--fs-medium:14px;--fs-large:16px;--fs-xlarge:20px}'
const page = (title, text) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${FONT_TOKENS}</style><body style="font:var(--fs-large) system-ui;max-width:32rem;margin:15vh auto;padding:0 16px"><h1 style="font-size:var(--fs-xlarge)">${title}</h1><p>${text}</p><p><a href="/">처음으로</a></p>`

/** A sign-in by an account that is not allowed becomes a request an operator can decide on. */
function requestAccess(login, name, avatar) {
  const a = (access[login.toLowerCase()] ??= { login, status: 'pending', firstAt: Date.now(), attempts: 0 })
  Object.assign(a, { login, name: name || login, avatar: avatar || '', lastAt: Date.now(), attempts: a.attempts + 1 })
  touchGlobals()
  log(`login refused: ${login} (${a.status}, attempt ${a.attempts})`)
  return a
}

/** Hashes of nonces already used by a sign-in, until their tokens could no longer be in date (ten minutes). */
const appleUsed = new Map()
/** Same-site form or fetch: under this site's no-referrer policy a form says so in Sec-Fetch-Site, not Origin. */
const sameSite = (req) => req.headers.origin === originOf(req) || ((!req.headers.origin || req.headers.origin === 'null') && req.headers['sec-fetch-site'] === 'same-origin')

/**
 * Apple로 로그인 (REQ-F-772), from the iOS app (web/apple-login.js). POST /api/auth/apple/nonce gives the page the
 * sha256 of a fresh nonce for the app's request and keeps the nonce itself in a ten-minute cookie; POST
 * /api/auth/apple (a form: token, code, name) checks the identity token Apple gave against it and signs in, or lands
 * on the same waiting page as a GitHub account an operator has not let in.
 */
async function appleAuth(req, res, url) {
  if (req.method !== 'POST') return res.writeHead(405).end()
  if (!sameSite(req)) return res.writeHead(403).end()
  if (url.pathname === '/api/auth/apple/nonce') {
    const raw = crypto.randomBytes(24).toString('base64url')
    return json(res, 200, { nonce: sha256hex(raw) }, { 'Set-Cookie': cookie(req, cname(req, 'cb_apple'), raw, 600) })
  }
  const clear = cookie(req, cname(req, 'cb_apple'), '', 0)
  const html = (status, title, text) => res.writeHead(status, { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': clear }).end(page(title, text))
  const f = Object.fromEntries(new URLSearchParams(await rawBody(req, 16 * 1024)))
  const raw = cookies(req)[cname(req, 'cb_apple')] || ''
  const now = Date.now()
  for (const [k, exp] of appleUsed) if (exp < now) appleUsed.delete(k)
  let claims
  try {
    if (!raw || appleUsed.has(sha256hex(raw))) throw new AppleTokenError('로그인 요청이 만료됐습니다')
    claims = await verifyIdentityToken(f.token, { audience: APPLE_CLIENT_ID, nonce: sha256hex(raw), keyOf: appleKeyOf })
  } catch (e) {
    if (!(e instanceof AppleTokenError)) log(`apple sign-in: keys: ${e.message}`)
    log(`apple sign-in refused: ${e.message}`)
    return e instanceof AppleTokenError ? html(401, 'Apple 로그인에 실패했습니다', `${escHtml(e.message)}. 앱에서 다시 시도해 주세요.`) : html(502, 'Apple 로그인에 실패했습니다', 'Apple 의 서명 키를 받아 오지 못했습니다. 잠시 뒤 다시 시도해 주세요.')
  }
  appleUsed.set(sha256hex(raw), now + 600_000)
  const { uid, login } = appleIds(claims.sub)
  // The name comes once, at the first sign-in; the e-mail (often Apple's relay address) comes every time.
  const given = String(f.name ?? '').trim().slice(0, 80)
  const name = given || users[uid]?.name || access[login]?.name || (typeof claims.email === 'string' ? claims.email : '') || 'Apple 사용자'
  if (!isAllowed(login)) {
    const a = requestAccess(login, name, '')
    return a.status === 'denied'
      ? html(403, '허용되지 않은 계정입니다', `Apple 계정 <b>${escHtml(name)}</b> 은 이 서버를 쓸 수 없습니다.`)
      : res.writeHead(403, { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': clear }).end(pendingPage({ login: name, demo: demoOn, apple: true }))
  }
  users[uid] = { login, name, avatar: '', apple: true }
  // Kept so that deleting the account can revoke it (REQ-F-770); the code is good for five minutes, so only now.
  if (apple && f.code) {
    try {
      const refresh = await apple.refreshToken(f.code)
      if (refresh) writeJson(path.join(userDir(uid), 'apple.json'), { refresh })
      else log(`apple sign-in: ${login}: no refresh token`)
    } catch (e) {
      log(`apple sign-in: ${login}: token: ${e.message}`)
    }
  }
  log(`apple sign-in: ${login}`)
  return signIn(req, res, uid, '/', [clear])
}

async function auth(req, res, url) {
  if (limited(req)) return res.writeHead(429).end('too many requests')
  if (url.pathname === '/api/auth/github') {
    if (!GITHUB_CLIENT_ID) return res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('GitHub 로그인이 설정되지 않았습니다', '서버에 GITHUB_CLIENT_ID 와 GITHUB_CLIENT_SECRET 을 넣어 주세요.'))
    const state = crypto.randomBytes(16).toString('hex')
    const to = new URL('https://github.com/login/oauth/authorize')
    to.search = new URLSearchParams({ client_id: GITHUB_CLIENT_ID, redirect_uri: `${originOf(req)}/api/auth/github/callback`, state, allow_signup: 'false' })
    return res.writeHead(302, { Location: to.href, 'Set-Cookie': cookie(req, cname(req, 'cb_state'), `${state}.${encodeURIComponent(safeNext(url.searchParams.get('next')))}`, 600) }).end()
  }
  if (url.pathname === '/api/auth/github/callback') {
    const [state, next] = (cookies(req)[cname(req, 'cb_state')] || '').split('.')
    const html = (status, title, text) => res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': cookie(req, cname(req, 'cb_state'), '', 0) }).end(page(title, text))
    if (!state || state !== url.searchParams.get('state')) return html(400, '로그인을 다시 시도해 주세요', '로그인 요청이 만료됐거나 맞지 않습니다.')
    const tok = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code: url.searchParams.get('code'), redirect_uri: `${originOf(req)}/api/auth/github/callback` }),
    }).then((r) => r.json())
    if (!tok.access_token) return html(502, 'GitHub 로그인에 실패했습니다', 'GitHub 가 토큰을 주지 않았습니다. 다시 시도해 주세요.')
    const gh = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${tok.access_token}`, 'User-Agent': 'claude-bridge', Accept: 'application/vnd.github+json' } }).then((r) => r.json())
    if (!gh.login || !gh.id) return html(502, 'GitHub 로그인에 실패했습니다', 'GitHub 계정 정보를 읽지 못했습니다.')
    // The name another GitHub account signed in with first stays that account's (R1-L1).
    const holder = heldBy(pins, `gh${gh.id}`, gh.login)
    if (holder) {
      log(`login refused: ${gh.login} is held by ${holder}, not gh${gh.id}`)
      // On the access page, with a way for an operator to let the name go (R3-L2). Kept apart from the row's own name
      // and picture, which stay the holder's: a stranger's face on an operator's row invites the wrong press (R4-L3).
      const a = (access[gh.login.toLowerCase()] ??= { login: gh.login, status: 'pending', firstAt: Date.now(), attempts: 0 })
      Object.assign(a, { heldBy: holder, heldAttempt: { id: `gh${gh.id}`, name: gh.name || gh.login, avatar: gh.avatar_url || '', at: Date.now() } })
      touchGlobals()
      return html(403, '다른 계정이 쓰던 이름입니다', `GitHub 계정 <b>${gh.login.replace(/[<>&]/g, '')}</b> 은 이 서버에서 다른 GitHub 계정이 먼저 쓰던 이름이라 로그인할 수 없습니다. 운영자에게 알려 주세요.`)
    }
    if (!isAllowed(gh.login)) {
      const a = requestAccess(gh.login, gh.name, gh.avatar_url)
      const who = `GitHub 계정 <b>${gh.login.replace(/[<>&]/g, '')}</b>`
      return a.status === 'denied'
        ? html(403, '허용되지 않은 계정입니다', `${who} 은 이 서버를 쓸 수 없습니다.`)
        : res.writeHead(403, { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': cookie(req, cname(req, 'cb_state'), '', 0) }).end(pendingPage({ login: gh.login, demo: demoOn }))
    }
    const uid = `gh${gh.id}`
    claimLogin(pins, uid, gh.login)
    users[uid] = { login: gh.login, name: gh.name || gh.login, avatar: gh.avatar_url || '' }
    return signIn(req, res, uid, safeNext(decodeURIComponent(next || '/')))
  }
  if (url.pathname === '/api/auth/apple/nonce' || url.pathname === '/api/auth/apple') return await appleAuth(req, res, url)
  const qr = /^\/api\/auth\/qr\/([a-f0-9]{32})$/.exec(url.pathname)
  if (qr) {
    const key = sha256(qr[1])
    const entry = qrCodes.get(key)
    // Opening the address only asks (R1-L14): signed in as someone else or not signed in at all, a GET that signed
    // in let anyone sign another person in as themselves. Saying yes is a form post from this page; the code is used
    // up only then. The headless browser's code (given only to the agent) signs in on the GET.
    const current = whoami(req)
    // A code made for a host with no screen of its own (REQ-F-798) is pasted into its terminal and opened by its headless
    // browser, with no one there to press a button. Any other browser only learns what it is for: such a code signing
    // in an ordinary browser would hand that browser's Mac to whoever made the code.
    if (entry && entry.server && !/HeadlessChrome\//.test(req.headers['user-agent'] ?? ''))
      return res
        .writeHead(200, { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(page('서버에 붙여 넣는 주소예요', '이 주소는 화면 없는 기기의 터미널에서 <code>node ~/.claude-bridge/agent.mjs headless \'주소\'</code> 로 넘기는 주소예요. 브라우저로는 로그인되지 않아요.'))
    if (entry && entry.exp >= Date.now() && users[entry.uid] && !entry.headless && current !== entry.uid) {
      if (req.method !== 'POST') {
        const who = escHtml(users[entry.uid].login)
        const text = current
          ? `지금 <b>${escHtml(users[current]?.login ?? '')}</b> 로 로그인돼 있어요. 이 QR 코드는 <b>${who}</b> 의 것이에요. 바꾸면 이 브라우저는 그 계정으로 로그인돼요. 직접 만든 QR 코드가 아니면 바꾸지 마세요.`
          : `이 QR 코드는 <b>${who}</b> 의 것이에요. 로그인하면 이 브라우저에서 그 계정의 세션을 다룰 수 있어요. 직접 만든 QR 코드가 아니면 로그인하지 마세요.`
        return res
          .writeHead(200, { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          .end(page(current ? '다른 계정으로 로그인할까요?' : `${who} 로 로그인할까요?`, `${text}</p><form method="post"><button type="submit">${current ? `${who} 로 바꾸기` : '로그인'}</button></form><p>`))
      }
      if (req.headers.origin !== originOf(req)) return res.writeHead(403).end()
    }
    qrCodes.delete(key)
    if (!entry || entry.exp < Date.now() || !users[entry.uid] || !isAllowed(users[entry.uid].login))
      return res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('QR 코드를 쓸 수 없습니다', '만료됐거나 이미 한 번 쓰인 코드입니다. 컴퓨터 화면에서 폰 아이콘을 다시 눌러 새 코드를 받아 주세요.'))
    log(`qr sign-in: ${users[entry.uid].login}`)
    return signIn(req, res, entry.uid, entry.next ?? (entry.sid ? `/s/${entry.sid}` : '/'))
  }
  if (url.pathname === '/api/auth/demo') {
    // 공개 데모 (REQ-F-766): one press, no id or password, into a demo of the visitor's own.
    if (!demoOn) return res.writeHead(404).end()
    if (req.method !== 'POST') return res.writeHead(405).end()
    // A form on this site's own page: under its no-referrer policy the browser sends `Origin: null` with it, and says
    // where it came from in Sec-Fetch-Site instead. A form on another site gets neither past here.
    const origin = req.headers.origin
    if (origin !== originOf(req) && !((!origin || origin === 'null') && req.headers['sec-fetch-site'] === 'same-origin')) return res.writeHead(403).end()
    const html = (status, text) => res.writeHead(status, { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(page('데모로 둘러보기', text))
    if (demoTooMany(clientIp(req))) return html(429, `데모는 한 곳에서 1시간에 ${DEMO_PER_IP_HOUR}번까지 열 수 있어요. 잠시 뒤에 다시 해 주세요.`)
    const uid = newDemoUid()
    if (!demoOpen(uid)) return html(503, '지금 데모를 쓰는 사람이 많아요. 잠시 뒤에 다시 해 주세요.')
    demoTrimLogins()
    log(`demo: ${uid}`)
    return signIn(req, res, uid, '/')
  }
  if (url.pathname === '/api/auth/dev' && DEV_LOGIN) {
    const login = (url.searchParams.get('login') || 'dev').replace(/[^a-zA-Z0-9-]/g, '')
    if (!isAllowed(login)) return res.writeHead(403).end(`not allowed (${requestAccess(login).status})`)
    users[`dev-${login}`] = { login, name: login, avatar: '' }
    return signIn(req, res, `dev-${login}`, safeNext(url.searchParams.get('next')))
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    if (req.headers.origin && req.headers.origin !== originOf(req)) throw new Refuse(403, '다른 출처의 요청입니다')
    delete logins[sha256(sessionToken(req) || '')]
    touchGlobals()
    return json(res, 200, { ok: true }, { 'Set-Cookie': [cookie(req, cname(req, 'cb'), '', 0), ...legacyCbClears(req)] })
  }
  res.writeHead(404).end()
}

function openStream(req, res, onClose) {
  // no-transform and identity keep proxies from compressing the stream, which would hold small events back in a buffer.
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'Content-Encoding': 'identity', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' })
  res.socket?.setNoDelay(true)
  res.write(': ok\n\n')
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
  req.on('close', () => {
    clearInterval(ping)
    onClose()
  })
}

async function api(req, res, url, uid) {
  const p = url.pathname
  const get = req.method === 'GET'
  const post = req.method === 'POST'

  const im = /^\/api\/img\/([0-9a-f]{40}\.(png|jpg|gif|webp))$/.exec(p)
  if (get && im) {
    const type = Object.keys(IMG_TYPES).find((t) => IMG_TYPES[t] === im[2])
    // A copy an older server kept, until the operator clears it (REQ-S-075); else from the Macs (REQ-S-069).
    const file = path.join(imgDir(uid), im[1])
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' })
      return fs.createReadStream(file).pipe(res)
    }
    const s = url.searchParams.get('s')
    const got = await imageFromMacs(uid, im[1], safeId(s) && sessions.get(s)?.uid === uid ? sessions.get(s).hostId : null)
    if (!got) throw new Refuse(404, Object.keys(hosts).some((h) => hosts[h].uid === uid && online(h)) ? '그림이 없습니다' : '맥이 연결돼 있지 않아 그림을 가져오지 못했어요')
    res.writeHead(200, { 'Content-Type': got.type || type, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' })
    return res.end(got.bytes)
  }
  if (post && p === '/api/qr') {
    const b = await body(req, 4096)
    for (const [k, v] of qrCodes) if (v.exp < Date.now()) qrCodes.delete(k)
    const code = crypto.randomBytes(16).toString('hex')
    // headless: a sign-in for a host with no screen (REQ-F-798), only for its headless browser, landing on /bridge.
    if (b.headless === true) qrCodes.set(sha256(code), { uid, exp: Date.now() + QR_MS, sid: null, next: '/bridge', headless: true, server: true })
    else qrCodes.set(sha256(code), { uid, exp: Date.now() + QR_MS, sid: safeId(b.sid) && sessions.get(b.sid)?.uid === uid ? b.sid : null })
    return json(res, 200, { url: `${originOf(req)}/api/auth/qr/${code}`, exp: Date.now() + QR_MS })
  }
  // 계정 삭제 (REQ-F-770): the person types their login name to say they mean it. The demo account goes back to its start.
  if (post && p === '/api/account/delete') {
    const b = await body(req, 4096)
    // An Apple account (REQ-F-772) has no name of its own to type: it types 삭제 instead.
    const login = users[uid]?.apple ? '삭제' : users[uid]?.login
    if (!login || String(b.login ?? '').trim().toLowerCase() !== login.toLowerCase()) throw new Refuse(400, users[uid]?.apple ? '삭제 라고 적어 주세요' : '로그인 이름이 맞지 않아요')
    // A demo account (REQ-F-766) is not deleted: only it goes back to the seed, other reviewers' stay as they are.
    if (isDemoUid(uid)) {
      demoOpen(uid)
      log(`demo: ${uid} 계정 삭제를 눌러 처음 상태로 되돌림`)
      return json(res, 200, { ok: true, demo: true })
    }
    await deleteAccount(uid)
    return json(res, 200, { ok: true }, { 'Set-Cookie': [cookie(req, cname(req, 'cb'), '', 0), ...legacyCbClears(req)] })
  }
  if (get && p === '/api/me') return json(res, 200, { user: users[uid], admin: isAdmin(uid), ...(isDemoUid(uid) ? { demo: true } : appBuild ? { appBuild } : {}), version: VERSION, origin: originOf(req), source: SOURCE_URL, icons: cleanIcons(prefsOf(uid).icons), voice: cleanVoice(prefsOf(uid).voice) })

  // ----- skills -----
  const sk = /^\/api\/skills(?:\/([a-z0-9-]+))?$/.exec(p)
  if (get && sk) {
    if (!(SKILLS_APP || SKILLS_TOKEN)) throw new Refuse(503, '스킬 저장소가 설정되지 않았습니다 (SKILLS_GITHUB_APP_ID·SKILLS_GITHUB_APP_KEY 또는 SKILLS_GITHUB_TOKEN)')
    const skills = skillsFor(skillsRepoOf(uid))
    if (!skills) throw new Refuse(503, '스킬 저장소가 없어요. 설정 → 더 보기 → 스킬 저장소에 내 GitHub 저장소(owner/repo)를 넣어 주세요')
    const c = await skills.current().catch((e) => {
      throw e instanceof RepoGone ? new Refuse(404, e.message) : e
    })
    // repo is SKILLS_REPO_RE-checked (owner/repo of plain characters): no quoting needed inside the URL.
    const install = `${originOf(req)}/skills/install.sh?repo=${c.repo}&t=${skillsInstallSig(c.repo)}`
    const base = { repo: c.repo, market: c.market, sha: c.sha, date: c.date, check: c.check, origin: originOf(req), install }
    if (!sk[1]) return json(res, 200, { ...base, skills: c.skills.map(({ body, ...s }) => s) })
    const s = c.skills.find((x) => x.name === sk[1])
    if (!s) throw new Refuse(404, '없는 스킬입니다')
    return json(res, 200, { ...base, skill: s })
  }

  // ----- bridge page -----
  if (post && p === '/api/bridge/hello') {
    const b = await body(req, 16 * 1024)
    if (!safeId(b.hostId)) throw new Refuse(400, 'hostId 가 올바르지 않습니다')
    // The demo Macs' ids (REQ-S-068): played by this server, never a Mac's.
    if (isDemoHost(b.hostId)) throw new Refuse(403, '이 호스트는 다른 계정에 등록돼 있습니다')
    if (hosts[b.hostId] && hosts[b.hostId].uid !== uid) throw new Refuse(403, '이 호스트는 다른 계정에 등록돼 있습니다')
    hosts[b.hostId] ??= { uid, name: String(b.name || 'Mac').slice(0, 60), home: '', lastSeen: Date.now() }
    // The tab that says hello last is the host's bridge. Its token is what the stream and uploads must carry,
    // so an older tab that is still open cannot take the host back by reconnecting.
    hosts[b.hostId].conn = crypto.randomBytes(12).toString('hex')
    touchGlobals()
    // A sign-in that has less than 7 days left is extended to 30 again: a bridge tab (the agent's background
    // browser of 헤드리스 연동 모드 above all) has nobody to sign it in when it runs out.
    const token = sessionToken(req)
    const login = token && logins[sha256(token)]
    const renew = login && login.exp - Date.now() < 7 * 86_400_000
    if (renew) login.exp = Date.now() + LOGIN_DAYS * 86_400_000
    return json(res, 200, { ok: true, conn: hosts[b.hostId].conn }, renew ? { 'Set-Cookie': cookie(req, cname(req, 'cb'), token, LOGIN_DAYS * 86_400) } : {})
  }
  if (get && p === '/api/bridge/stream') {
    const hostId = url.searchParams.get('hostId')
    if (ownHost(uid, hostId).conn !== url.searchParams.get('conn')) throw new Refuse(409, '이 탭은 더 이상 이 호스트의 연동 탭이 아닙니다')
    // The page it replaces is told so, or its EventSource would reconnect and take the host back.
    bridges.get(hostId)?.end('data: {"t":"replaced"}\n\n')
    openStream(req, res, () => {
      if (bridges.get(hostId) !== res) return
      bridges.delete(hostId)
      Object.assign(live(hostId), { disconnectedAt: Date.now(), stale: false, rtt: null })
      hosts[hostId].lastSeen = Date.now()
      touchGlobals()
      // What the host last said stays (it may come straight back), but nothing is being written or asked through a dead link.
      for (const m of sessions.values()) if (m.hostId === hostId) Object.assign(m, { card: null, writing: '' })
      record(uid, hostId, { level: 'warn', area: 'link', text: '연동 페이지와의 연결이 끊김' })
      broadcastState(uid)
    })
    bridges.set(hostId, res)
    // Which web files this server has: a bridge tab that heard another one before reloads to run the new relay.
    res.write(`data: ${JSON.stringify({ t: 'web', hash: WEB_HASH })}\n\n`)
    trace(hostId, `stream open via HTTP/${req.httpVersion} ua=${String(req.headers['user-agent']).slice(0, 120)} enc=${req.headers['accept-encoding']}`)
    Object.assign(live(hostId), { connectedAt: Date.now(), connects: live(hostId).connects + 1, health: null, healthAt: null, page: null })
    record(uid, hostId, { area: 'link', text: '연동 페이지 연결됨' })
    broadcastState(uid)
    return
  }
  if (post && p === '/api/bridge/up') {
    const b = await body(req, 32 * 1024 * 1024)
    if (ownHost(uid, b.hostId).conn !== b.conn) throw new Refuse(409, '이 탭은 더 이상 이 호스트의 연동 탭이 아닙니다')
    trace(b.hostId, `up ${(b.msgs ?? []).map((m) => m.t + (m.t === 'page' ? `(${m.visible},srv${m.fromServer},agent${m.fromAgent})` : '')).join(',')} via ${req.httpVersion}`)
    fromBridge(uid, b.hostId, Array.isArray(b.msgs) ? b.msgs : [], originOf(req))
    return json(res, 200, { ok: true })
  }
  if (post && p === '/api/bridge/bye') {
    const b = await body(req, 4096)
    // The tab closes its stream in the same breath, so the stream may already be gone when this arrives.
    if (ownHost(uid, b.hostId).conn === b.conn) {
      record(uid, b.hostId, { level: 'warn', area: 'link', src: 'page', text: '연동 탭이 닫히거나 다른 페이지로 이동함' })
      bridges.get(b.hostId)?.end()
    }
    return json(res, 200, { ok: true })
  }
  if (get && p === '/api/bridge/upload') {
    // A video for a message (REQ-F-761), fetched by the Mac's bridge tab to hand to its agent.
    const hostId = url.searchParams.get('hostId')
    if (ownHost(uid, hostId).conn !== url.searchParams.get('conn')) throw new Refuse(409, '이 탭은 더 이상 이 호스트의 연동 탭이 아닙니다')
    const up = uploadOf(uid, url.searchParams.get('id'))
    if (!up) throw new Refuse(404, '영상이 없어요')
    res.writeHead(200, { 'Content-Type': up.type, 'Content-Length': up.size, 'Cache-Control': 'no-store' })
    fs.createReadStream(up.file).pipe(res)
    return
  }
  if (get && p === '/api/bridge/transcript') {
    const meta = ownSession(uid, url.searchParams.get('sid'))
    // Only for the bridge tab of the host that is opening this session: a copy of the conversation is not
    // something any page of the account may read (a locked session's words would leave that way).
    // It is handed out only while a host is opening the session (a move, a switch, a reopen). A tab that says
    // which host it is must be that host's current bridge tab; tabs from before that rule say nothing.
    if (!meta.moving) throw new Refuse(409, '이 세션을 여는 중이 아닙니다')
    // The tab says which host it is; one that does not (from before that rule) gets nothing (R1-L2).
    const hostId = url.searchParams.get('hostId')
    if (!hostId || (!hosts[hostId] || hosts[hostId].uid !== uid || hosts[hostId].conn !== url.searchParams.get('conn') || meta.moving.to !== hostId)) throw new Refuse(409, '이 탭은 더 이상 이 호스트의 연동 탭이 아닙니다')
    // The copy passing from the sending Mac (moveSession); none when the Mac opens its own (204, REQ-S-069).
    const copy = moveCopies.get(meta.id)
    if (copy == null) return res.writeHead(204, { 'Cache-Control': 'no-store' }).end()
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    return res.end(copy)
  }

  // ----- control page -----
  if (await pageApi(req, res, url, uid)) return
  if (get && p === '/api/classic/stream') {
    if (!controls.has(uid)) controls.set(uid, new Set())
    openStream(req, res, () => controls.get(uid)?.delete(res))
    controls.get(uid).add(res)
    // Only a page that says it can merge them gets deltas; any other stream is sent the whole state each time.
    res.wantsDelta = url.searchParams.get('delta') === '1'
    return sendState(res, stateOf(uid))
  }
  if (post && p === '/api/sessions') return json(res, 200, { ok: true, id: await startSession(uid, await body(req, 256 * 1024), req) })
  const hl = /^\/api\/hosts\/([a-zA-Z0-9-]+)\/logs$/.exec(p)
  if (get && hl) {
    const h = readableHost(uid, hl[1])
    const entries = readHostLog(h.uid, hl[1], { sid: url.searchParams.get('sid'), level: url.searchParams.get('level') })
    // An operator reading someone else's Mac sees no paths: error messages and stacks name folders (R1-M5).
    return json(res, 200, { entries: h.uid === uid ? entries : entries.map((e) => ({ ...e, text: hidePaths(e.text) })) })
  }
  if (get && p === '/api/notices') return json(res, 200, { notices: noticesOf(uid).map(({ key: _k, ...n }) => n) })
  if (post && p === '/api/notices/dismiss') {
    const id = (await body(req, 4096)).id
    dropNotices(uid, (x) => !id || x.id === id)
    return json(res, 200, { ok: true })
  }
  if (get && p === '/api/push/key') return json(res, 200, { key: vapid.publicKey, apns: !!apns })
  if (post && p === '/api/push/subscribe') {
    const b = await body(req, 8192)
    if (!/^https:\/\/[^\s]{10,1000}$/.test(String(b.endpoint ?? '')) || !pushService(b.endpoint)) throw new Refuse(400, '구독 정보가 올바르지 않습니다')
    const subs = subsOf(uid).filter((x) => x.endpoint !== b.endpoint)
    // Which kind of device subscribed, so the app on the same kind does not get it twice (REQ-F-775).
    const dev = deviceOf(req.headers['user-agent'])
    if (b.off !== true) subs.push({ endpoint: b.endpoint, at: Date.now(), ...(dev ? { dev } : {}) })
    writeJson(subsFile(uid), subs.slice(-20))
    return json(res, 200, { ok: true, count: subs.length })
  }
  // 앱 알림 (REQ-F-775): whether this phone's token is registered for this person, and whether the server can send.
  if (get && p === '/api/push/apns') {
    const token = String(url.searchParams.get('token') ?? '').toLowerCase()
    return json(res, 200, { on: APNS_TOKEN.test(token) && devicesOf(uid).some((d) => d.token === token), apns: !!apns })
  }
  // 앱 알림 (REQ-F-775): the iOS app's device token, sent by the page after the app got it from the system.
  if (post && p === '/api/push/apns') {
    if (isDemoUid(uid)) throw new Refuse(403, DEMO_REFUSED)
    const b = await body(req, 4096)
    const token = String(b.token ?? '').toLowerCase()
    if (!APNS_TOKEN.test(token)) throw new Refuse(400, '기기 토큰이 올바르지 않습니다')
    if (b.off !== true && (!APNS_ENVS.includes(b.env) || !APNS_DEVICES.includes(b.device))) throw new Refuse(400, '기기 정보가 올바르지 않습니다')
    // A phone is one person's: signing in as someone else there takes the token from whoever had it.
    for (const other of Object.keys(users)) {
      if (other === uid || !fs.existsSync(devicesFile(other))) continue
      const theirs = devicesOf(other)
      if (theirs.some((d) => d.token === token)) writeJson(devicesFile(other), theirs.filter((d) => d.token !== token))
    }
    const list = devicesOf(uid).filter((d) => d.token !== token)
    if (b.off !== true) list.push({ token, env: b.env, dev: b.device, at: Date.now() })
    writeJson(devicesFile(uid), list.slice(-10))
    return json(res, 200, { ok: true, count: Math.min(list.length, 10), apns: !!apns })
  }
  // Tests only (dev login): raise a notice as a session would, so its push can be watched.
  if (DEV_LOGIN && post && p === '/api/dev/notice') {
    const b = await body(req, 4096)
    addNotice(uid, { sid: safeId(b.sid) ? b.sid : '', key: `dev|${crypto.randomBytes(4).toString('hex')}`, title: String(b.title ?? ''), text: String(b.text ?? ''), tone: 'info', push: true })
    return json(res, 200, { ok: true })
  }
  if (post && p === '/api/focus') {
    const b = await body(req, 1024)
    b.visible ? lookingAt.set(uid, Date.now()) : lookingAt.delete(uid)
    if (!viewing.has(uid)) viewing.set(uid, new Map())
    const v = viewing.get(uid)
    for (const [s, at] of v) if (Date.now() - at > 45_000) v.delete(s)
    if (b.visible && safeId(b.sid)) v.set(b.sid, Date.now())
    if (b.was && safeId(b.was)) v.delete(b.was)
    return json(res, 200, { ok: true })
  }
  // The quality report (설정 → 더 보기 → 성능 리포트): the scores of every measurement run, kept in the repository
  // (server/quality.json) and shipped with each deploy.
  if (get && p === '/api/quality') {
    const file = path.join(ROOT, 'server', 'quality.json')
    try {
      const st = fs.statSync(file)
      if (qualityCache?.mtime !== st.mtimeMs) qualityCache = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(file, 'utf8')) }
      return json(res, 200, qualityCache.data)
    } catch {
      return json(res, 200, { pages: [], runs: [] })
    }
  }
  if (get && p === '/api/stats') {
    const days = [1, 7, 30, 90].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 7
    const base = computeStats(uid, days)
    // The person's pull requests are asked of gh on one of their Macs, and kept ten minutes. A slow answer does
    // not hold the window up: the block is there the next time it opens.
    const pr = await Promise.race([prStatsOf(uid, days), new Promise((r) => setTimeout(() => r(null), 8000))]).catch(() => null)
    return json(res, 200, pr ? { ...base, pr } : base)
  }
  if (post && p === '/api/groups') {
    const r = groupOp(uid, await body(req, 64 * 1024))
    savePrefs(uid)
    return json(res, 200, { ok: true, ...r })
  }
  if (p === '/api/prefs/launch') {
    if (get) return json(res, 200, launchOf(uid))
    if (!post) throw new Refuse(405, '지원하지 않는 요청입니다')
    const b = await body(req, 4096)
    const v = cleanLaunch(b)
    // A value sent that is not one the list offers is refused, not quietly dropped.
    for (const [k, label] of [['model', '모델'], ['effort', 'effort'], ['mode', '권한 모드']]) if (String(b[k] ?? '').trim() && !v[k]) throw new Refuse(400, `${label} 값이 올바르지 않아요`)
    if (String(b.folderBase ?? '').trim() && !cleanFolderBase(b.folderBase)) throw new Refuse(400, '기본 폴더는 ~ 나 / 로 시작하고 .. 이 없어야 해요')
    prefsOf(uid).launch = v
    savePrefs(uid)
    return json(res, 200, { ok: true, note: '저장했어요. 다음에 띄우는 새 세션과 복제부터 적용돼요.', ...v })
  }
  // 스킬 저장소 (REQ-F-792): the repo this person's /skills reads. Only one the person owns on GitHub, so this server's
  // App or token never reads someone else's repo for them; Apple and demo accounts have no GitHub login and cannot.
  if (p === '/api/prefs/skills') {
    if (post) {
      const b = await body(req, 4096)
      const repo = typeof b.repo === 'string' ? b.repo.trim() : null
      if (repo === null) throw new Refuse(400, 'repo 가 필요해요')
      const gh = githubLoginOf(uid)
      if (!gh) throw new Refuse(400, 'GitHub 로 로그인한 계정만 스킬 저장소를 정할 수 있어요')
      if (repo && !SKILLS_REPO_RE.test(repo)) throw new Refuse(400, 'owner/repo 형식으로 적어 주세요')
      if (repo && repo.split('/')[0].toLowerCase() !== gh.toLowerCase()) throw new Refuse(400, `내 GitHub 계정(${gh})의 저장소만 넣을 수 있어요`)
      if (repo) prefsOf(uid).skillsRepo = repo
      else delete prefsOf(uid).skillsRepo
      savePrefs(uid)
    } else if (!get) throw new Refuse(405, '지원하지 않는 요청입니다')
    return json(res, 200, skillsView(uid))
  }
  if (p === '/api/prefs/voice') {
    if (get) return json(res, 200, cleanVoice(prefsOf(uid).voice))
    if (!post) throw new Refuse(405, '지원하지 않는 요청입니다')
    const b = await body(req, 8 * 1024)
    // A 'backend' from a page older than 1.231 is ignored, not refused: there is one way now, on the Mac.
    for (const [k, list, label] of [['model', VOICE_MODELS, '모델'], ['language', VOICE_LANGS, '언어']]) if (b[k] != null && !list.includes(b[k])) throw new Refuse(400, `${label} 값이 올바르지 않아요`)
    prefsOf(uid).voice = cleanVoice(b)
    savePrefs(uid)
    return json(res, 200, { ok: true, ...prefsOf(uid).voice })
  }
  if (p === '/api/prefs/voice/hosts') {
    // Per Mac, over the account's: only the person's own Macs, and an entry that follows the account in both is dropped.
    const own = (id) => hosts[id]?.uid === uid
    const list = () => Object.fromEntries(Object.entries(prefsOf(uid).voiceHosts ?? {}).filter(([id]) => own(id)).map(([id, v]) => [id, cleanVoiceHost(v)]).filter(([, v]) => v.model))
    if (get) return json(res, 200, { hosts: list() })
    if (!post) throw new Refuse(405, '지원하지 않는 요청입니다')
    const b = await body(req, 4 * 1024)
    if (!safeId(b.host) || !own(b.host)) throw new Refuse(404, '그 맥이 없어요')
    if (b.model && !VOICE_MODELS.includes(b.model)) throw new Refuse(400, '모델 값이 올바르지 않아요')
    const v = cleanVoiceHost(b)
    const all = { ...(prefsOf(uid).voiceHosts ?? {}) }
    if (v.model) all[b.host] = v
    else delete all[b.host]
    prefsOf(uid).voiceHosts = all
    savePrefs(uid)
    return json(res, 200, { ok: true, hosts: list() })
  }
  if (p === '/api/prefs/icons') {
    if (get) return json(res, 200, cleanIcons(prefsOf(uid).icons))
    if (!post) throw new Refuse(405, '지원하지 않는 요청입니다')
    const b = await body(req, 1024)
    if (!ICON_SIZES.includes(Number(b.size)) || !ICON_FILLS.includes(Number(b.fill))) throw new Refuse(400, '아이콘 값이 올바르지 않아요')
    prefsOf(uid).icons = cleanIcons(b)
    savePrefs(uid)
    return json(res, 200, { ok: true, ...prefsOf(uid).icons })
  }
  if (p === '/api/prefs/splits') {
    // 분할 조합 (REQ-F-790): named sets of 2~3 sessions to open side by side again. A session that has gone stays
    // in the set; the page leaves it out when it opens one.
    if (get) return json(res, 200, { splits: splitsOf(uid) })
    if (!post) throw new Refuse(405, '지원하지 않는 요청입니다')
    const b = await body(req, 4 * 1024)
    let list = splitsOf(uid)
    if (b.op === 'remove') list = list.filter((x) => x.id !== b.id)
    else if (b.op === 'move') {
      // One step up (-1) or down (+1); past either end it stays.
      const at = list.findIndex((x) => x.id === b.id)
      const to = at + (b.by === -1 ? -1 : b.by === 1 ? 1 : NaN)
      if (at < 0) throw new Refuse(404, '그 조합이 없어요')
      if (!Number.isInteger(to)) throw new Refuse(400, '알 수 없는 요청이에요')
      if (to >= 0 && to < list.length) {
        list = [...list]
        ;[list[at], list[to]] = [list[to], list[at]]
      }
    } else if (b.op === 'save') {
      const ids = [...new Set(Array.isArray(b.ids) ? b.ids.filter(safeId) : [])]
      const name = String(b.name ?? '').trim().slice(0, 40)
      if (!name) throw new Refuse(400, '이름을 적어 주세요')
      if (ids.length < 2 || ids.length > 3) throw new Refuse(400, '조합은 세션 2~3개예요')
      const at = list.findIndex((x) => x.id === b.id)
      if (at < 0 && list.length >= SPLITS_MAX) throw new Refuse(400, `조합은 ${SPLITS_MAX}개까지 저장해요`)
      const item = { id: at < 0 ? crypto.randomUUID() : list[at].id, name, ids }
      list = at < 0 ? [...list, item] : list.map((x, i) => (i === at ? item : x))
    } else throw new Refuse(400, '알 수 없는 요청이에요')
    prefsOf(uid).splits = list
    savePrefs(uid)
    return json(res, 200, { ok: true, splits: list })
  }
  if (p === '/api/prefs/prompt') {
    if (get) return json(res, 200, { text: prefsOf(uid).defaultPrompt })
    if (!post) throw new Refuse(405, '지원하지 않는 요청입니다')
    const text = String((await body(req, 64 * 1024)).text ?? '').trim().slice(0, 8000)
    const said = setDefaultPrompt(uid, text)
    return json(res, 200, { ok: true, note: `${text ? '저장했어요' : '비웠어요'}. ${said}` })
  }
  const hd = /^\/api\/hosts\/([a-zA-Z0-9-]+)\/dirs$/.exec(p)
  if (get && hd) {
    ownHost(uid, hd[1])
    if (!online(hd[1])) throw new Refuse(409, '호스트가 연결돼 있지 않습니다')
    const r = await ask(hd[1], { t: 'dirs', path: String(url.searchParams.get('path') || '~').slice(0, 1000) }, 15_000)
    if (!r.ok) throw new Refuse(404, r.error || '폴더를 읽지 못했습니다')
    return json(res, 200, { ok: true, path: r.path, parent: r.parent, dirs: r.dirs })
  }
  const hr = /^\/api\/hosts\/([a-zA-Z0-9-]+)\/recent$/.exec(p)
  if (get && hr) {
    ownHost(uid, hr[1])
    if (!online(hr[1])) throw new Refuse(409, '호스트가 연결돼 있지 않습니다')
    // Conversations a bridge session of this person already holds (running or ended) are not offered again.
    const exclude = [...sessions.values()].filter((m) => m.uid === uid).map((m) => m.conv)
    const include = String(url.searchParams.get('include') ?? '').split(',').filter(safeId).slice(0, 200)
    const r = await ask(hr[1], { t: 'recent', exclude, include }, 30_000)
    if (!r.ok) throw new Refuse(502, r.error || '대화 목록을 읽지 못했습니다')
    return json(res, 200, { ok: true, home: r.home, conversations: r.conversations })
  }
  const ha = /^\/api\/hosts\/([a-zA-Z0-9-]+)\/adopt$/.exec(p)
  if (post && ha) {
    const b = await body(req, 16 * 1024)
    ownHost(uid, ha[1])
    if (!online(ha[1])) throw new Refuse(409, '호스트가 연결돼 있지 않습니다')
    if (!safeId(b.conv)) throw new Refuse(400, '대화 id 가 올바르지 않습니다')
    if ([...sessions.values()].some((m) => m.uid === uid && m.conv === b.conv && !m.closed)) throw new Refuse(409, '이미 bridge 세션으로 열려 있는 대화입니다')
    const sid = crypto.randomUUID()
    const meta = newMeta(uid, sid, ha[1], { conv: b.conv, cwd: String(b.cwd || '').slice(0, 1000), title: String(b.title || '').replace(/\s+/g, ' ').slice(0, 80) })
    meta.state = { ...noState(), alive: true, phase: 'starting' }
    broadcastState(uid)
    const r = await ask(ha[1], { t: 'adopt', sid, conv: b.conv, cwd: meta.cwd, sysPrompt: sysPromptOf(uid), autoPush: true }, 90_000)
    if (!r.ok) {
      sessions.delete(sid)
      dirty.delete(sid)
      fs.rmSync(sessionDir(meta), { recursive: true, force: true })
      broadcastState(uid)
      record(uid, ha[1], { level: 'error', area: 'adopt', sid, text: `대화를 가져오지 못함: ${r.error}` })
      throw new Refuse(502, r.error || '대화를 가져오지 못했습니다')
    }
    meta.cwd = r.cwd
    meta.account = safeAccount(r.account) ? r.account : ''
    touch(meta)
    record(uid, ha[1], { area: 'adopt', sid, text: `맥의 대화 ${b.conv.slice(0, 8)} 를 bridge 세션으로 가져옴` })
    toHost(ha[1], { t: 'report', sid })
    return json(res, 200, { ok: true, id: sid })
  }
  // The Claude accounts on one of the person's Macs (설정 → Claude 계정). Its owner only: an operator does not sign
  // someone else's Mac in or out.
  const hacc = /^\/api\/hosts\/([a-zA-Z0-9-]+)\/accounts$/.exec(p)
  if (post && hacc) {
    const b = await body(req, 4096)
    const h = ownHost(uid, hacc[1])
    if (!ACCOUNT_OPS.includes(b.op)) throw new Refuse(400, '모르는 계정 동작이에요')
    if (b.op !== 'list' && b.op !== 'add' && !safeAccount(b.id)) throw new Refuse(400, '계정 id 가 올바르지 않아요')
    if (!online(hacc[1])) throw new Refuse(409, '호스트가 연결돼 있지 않습니다')
    // Signing in waits for the address (up to 20 s); taking the code waits for claude to finish (up to 30 s).
    const r = await ask(hacc[1], { t: 'account', op: b.op, id: b.id ?? '', name: String(b.name ?? '').slice(0, 100), ...(b.op === 'code' ? { code: String(b.code ?? '').slice(0, 600) } : {}) }, 90_000)
    if (Array.isArray(r.accounts)) (h.accounts = cleanAccounts(r.accounts)), touchGlobals(), broadcastState(uid)
    // The code itself is never written down.
    if (b.op !== 'list') record(uid, hacc[1], { level: r.ok ? 'info' : 'warn', area: 'account', text: `Claude 계정 ${ACCOUNT_OP_NAMES[b.op]}${b.id ? ` (${b.id})` : ''}${r.ok ? '' : ` 실패: ${r.error ?? ''}`}` })
    if (!r.ok) throw new Refuse(409, r.error || '계정 동작을 하지 못했어요')
    return json(res, 200, { ok: true, accounts: h.accounts ?? [], ...(typeof r.url === 'string' && /^https:\/\//.test(r.url) ? { url: r.url } : {}), ...(safeAccount(r.id) ? { id: r.id } : {}) })
  }
  const hh = /^\/api\/hosts\/([a-zA-Z0-9-]+)\/heal$/.exec(p)
  if (post && hh) {
    const b = await body(req, 1024)
    const h = readableHost(uid, hh[1])
    if (!['background-restart', 'awake-apply', 'check', 'restart', 'rekey'].includes(b.action)) throw new Refuse(400, '모르는 복구 동작이에요')
    if (!online(hh[1])) throw new Refuse(409, '호스트가 연결돼 있지 않습니다')
    const r = await ask(hh[1], { t: 'heal', action: b.action }, 30_000)
    record(h.uid, hh[1], { level: r.ok ? 'info' : 'warn', area: 'heal', text: `지금 복구(${b.action}): ${r.ok ? r.note : r.error}${byOperator(uid, h)}` })
    if (!r.ok) throw new Refuse(409, r.error || '복구하지 못했습니다')
    return json(res, 200, { ok: true, note: r.note })
  }
  // 관리자 권한 (REQ-F-764): the password typed in the window opens root on that Mac for 5 minutes; 닫기 closes it,
  // 취소 turns away who was waiting. Its owner only: an operator never types a password into someone else's Mac.
  const hsu = /^\/api\/hosts\/([a-zA-Z0-9-]+)\/sudo$/.exec(p)
  if (post && hsu) {
    const b = await body(req, 4096)
    const hostId = hsu[1]
    ownHost(uid, hostId)
    const st = sudoOf(hostId)
    if (b.cancel === true) {
      for (const areq of [...st.asks.keys()]) sudoAnswer(hostId, areq, false, '비밀번호를 묻는 창을 닫았어요')
      broadcastState(uid)
      return json(res, 200, { ok: true })
    }
    if (!online(hostId)) throw new Refuse(409, '호스트가 연결돼 있지 않습니다')
    if (b.off === true) {
      await ask(hostId, { t: 'sudooff' }, 15_000)
      st.until = 0
      record(uid, hostId, { area: 'sudo', text: '관리자 권한을 닫음' })
      broadcastState(uid)
      return json(res, 200, { ok: true })
    }
    const password = typeof b.password === 'string' ? b.password : ''
    if (!password || password.length > 1024) throw new Refuse(400, '비밀번호를 넣어 주세요')
    const r = await ask(hostId, { t: 'sudopass', password }, 30_000)
    if (!r.ok) throw new Refuse(403, r.error || '관리자 권한을 열지 못했어요')
    st.until = Number(r.until) || Date.now() + 300_000
    for (const areq of [...st.asks.keys()]) sudoAnswer(hostId, areq, true)
    record(uid, hostId, { area: 'sudo', text: '관리자 권한을 5분 열었음' })
    broadcastState(uid)
    return json(res, 200, { ok: true, until: st.until })
  }
  const hb = /^\/api\/hosts\/([a-zA-Z0-9-]+)\/background$/.exec(p)
  if (post && hb) {
    const b = await body(req, 1024)
    const h = readableHost(uid, hb[1])
    if (!online(hb[1])) throw new Refuse(409, '호스트가 연결돼 있지 않습니다. 그 맥의 브라우저에서 이 사이트를 한 번 연 뒤 켜 주세요')
    let login
    if (b.on === true) {
      // A one-time sign-in for the headless browser (헤드리스 연동 모드), like the phone QR code (5 minutes, once), landing on /bridge.
      // Always as the Mac's owner, even when an operator turns it on: the code goes only to that Mac's agent.
      for (const [k, v] of qrCodes) if (v.exp < Date.now()) qrCodes.delete(k)
      const code = crypto.randomBytes(16).toString('hex')
      // For the headless browser, which nobody is at to press a button: given only to the agent, never shown (R1-L14).
      qrCodes.set(sha256(code), { uid: h.uid, exp: Date.now() + QR_MS, sid: null, next: '/bridge', headless: true })
      login = `${originOf(req)}/api/auth/qr/${code}`
    }
    const r = await ask(hb[1], { t: 'background', on: b.on === true, ...(login ? { login } : {}) }, 15_000)
    record(h.uid, hb[1], { level: r.ok ? 'info' : 'warn', area: 'background', text: `헤드리스 연동 모드 ${b.on === true ? '켬' : '끔'}${r.ok ? '' : ` · ${r.error ?? ''}`}${byOperator(uid, h)}` })
    if (!r.ok) throw new Refuse(409, r.error || '헤드리스 연동 모드를 바꾸지 못했습니다')
    return json(res, 200, { ok: true, on: !!r.on, running: !!r.running })
  }
  const hw = /^\/api\/hosts\/([a-zA-Z0-9-]+)\/awake$/.exec(p)
  if (post && hw) {
    const b = await body(req, 1024)
    const h = readableHost(uid, hw[1])
    if (!online(hw[1])) throw new Refuse(409, '호스트가 연결돼 있지 않습니다')
    const r = await ask(hw[1], { t: 'awake', ...(typeof b.idle === 'boolean' ? { idle: b.idle } : {}), ...(typeof b.lid === 'boolean' ? { lid: b.lid } : {}) }, 15_000)
    record(h.uid, hw[1], { level: r.ok ? 'info' : 'warn', area: 'awake', text: `잠자기 막기 ${r.idle ? '켬' : '끔'} · 덮개 닫아도 켜 두기 ${r.lid ? '켬' : '끔'}${r.ok ? '' : ` · ${r.error ?? ''}`}${byOperator(uid, h)}` })
    if (!r.ok) throw new Refuse(409, r.error || '잠자기 설정을 바꾸지 못했습니다')
    return json(res, 200, { ok: true, idle: !!r.idle, lid: !!r.lid, lidReady: !!r.lidReady })
  }
  const hcw = /^\/api\/hosts\/([a-zA-Z0-9-]+)\/compact$/.exec(p)
  if (post && hcw) {
    // When this Mac's sessions compact their context (REQ-F-775): tokens, or null for Claude Code's own setting.
    const b = await body(req, 1024)
    const h = readableHost(uid, hcw[1])
    const w = b.window === null ? null : Number.isInteger(b.window) && b.window >= 100_000 && b.window <= 1_000_000 ? b.window : undefined
    if (w === undefined) throw new Refuse(400, '압축 시점은 100,000~1,000,000 토큰이거나 null 이에요')
    if (!online(hcw[1])) throw new Refuse(409, '호스트가 연결돼 있지 않습니다')
    const r = await ask(hcw[1], { t: 'compact', window: w }, 15_000)
    if (!r.ok) throw new Refuse(409, r.error || '압축 시점을 바꾸지 못했습니다')
    record(h.uid, hcw[1], { level: 'info', area: 'compact', text: `자동 압축 시점 ${r.window ? `${Math.round(r.window / 1000)}k 토큰` : 'Claude Code 설정'}${byOperator(uid, h)}` })
    return json(res, 200, { ok: true, window: r.window ?? null })
  }
  const hdel = /^\/api\/hosts\/([a-zA-Z0-9-]+)\/delegate$/.exec(p)
  if (post && hdel) {
    // Whether this Mac takes work handed over from the person's other Macs (REQ-F-760). On unless turned off.
    ownHost(uid, hdel[1])
    const b = await body(req, 1024)
    if (typeof b.on !== 'boolean') throw new Refuse(400, 'on 값이 필요해요')
    const off = delegateOff(uid)
    if (b.on) off.delete(hdel[1])
    else off.add(hdel[1])
    prefsOf(uid).delegateOff = [...off].filter((id) => hosts[id])
    savePrefs(uid)
    return json(res, 200, { ok: true, on: b.on })
  }
  const hc = /^\/api\/hosts\/([a-zA-Z0-9-]+)\/check$/.exec(p)
  if (post && hc) {
    readableHost(uid, hc[1])
    if (!toHost(hc[1], { t: 'check' })) throw new Refuse(409, '호스트가 연결돼 있지 않습니다')
    return json(res, 200, { ok: true })
  }
  const hs = /^\/api\/hosts\/([a-zA-Z0-9-]+)\/status$/.exec(p)
  if (get && hs) {
    readableHost(uid, hs[1])
    return json(res, 200, hostDetail(hs[1], uid))
  }
  if (p === '/api/admin/access') {
    if (!isAdmin(uid)) throw new Refuse(403, '운영자만 볼 수 있습니다')
    if (post) {
      const b = await body(req, 16 * 1024)
      const l = String(b.login || '').toLowerCase()
      if (!/^[a-z0-9-]{1,39}$/.test(l) && !isAppleLogin(l)) throw new Refuse(400, 'GitHub 계정 이름이 올바르지 않습니다')
      if (b.status !== 'release' && (ADMINS.includes(l) || ALLOWED.includes(l))) throw new Refuse(409, '서버 설정으로 허용된 계정입니다. 설정(환경 변수)에서 바꿔야 합니다')
      if (b.status === 'remove') delete access[l]
      // Lets a name go that another GitHub account first signed in with: the next account to sign in with it gets it.
      else if (b.status === 'release') {
        // The account that held it no longer goes by it: its sign-ins and connections end, and it is known by that
        // name no more until it signs in again under whatever it is called now (R4-L2: two accounts, one name).
        const holder = pins[l]
        delete pins[l]
        if (access[l]) delete access[l].heldBy
        if (holder && users[holder] && users[holder].login.toLowerCase() === l) {
          users[holder].login = `${users[holder].login}#released`
          for (const [k, v] of Object.entries(logins)) if (v.uid === holder) delete logins[k]
          for (const res of controls.get(holder) ?? []) res.end()
          for (const [hid, h] of Object.entries(hosts)) if (h.uid === holder) bridges.get(hid)?.end()
        }
      } else if (['allowed', 'denied', 'pending'].includes(b.status)) {
        const a = (access[l] ??= { login: String(b.login), firstAt: Date.now(), attempts: 0 })
        Object.assign(a, { status: b.status, decidedBy: users[uid].login, decidedAt: Date.now() })
      } else throw new Refuse(400, '없는 상태입니다')
      touchGlobals()
      log(`access: ${users[uid].login} set ${l} -> ${b.status}`)
      // Taking access away ends that account's sign-ins and live connections at once.
      if (!isAllowed(l)) {
        for (const [id, u] of Object.entries(users)) {
          if (u.login.toLowerCase() !== l) continue
          for (const [k, v] of Object.entries(logins)) if (v.uid === id) delete logins[k]
          for (const res of controls.get(id) ?? []) res.end()
          for (const [hid, h] of Object.entries(hosts)) if (h.uid === id) bridges.get(hid)?.end()
        }
      }
    }
    // The demo account is not a GitHub account: it is never a row here (REQ-S-068).
    const known = new Map(Object.entries(users).filter(([id]) => !isDemoUid(id)).map(([, u]) => [u.login.toLowerCase(), u]))
    const names = new Set([...ADMINS, ...ALLOWED.filter((x) => x !== '*'), ...Object.keys(access), ...[...known.keys()].filter((k) => !k.endsWith('#released'))])
    return json(res, 200, {
      open: ALLOWED.includes('*'),
      entries: [...names].map((l) => {
        const a = access[l]
        const u = known.get(l)
        const acc = accessOf(l)
        return { login: u?.login ?? a?.login ?? l, name: u?.name ?? a?.name ?? '', avatar: u?.avatar ?? a?.avatar ?? '', allowed: acc.allowed, by: acc.by, status: acc.allowed ? 'allowed' : (a?.status ?? 'pending'), admin: ADMINS.includes(l), signedUp: !!u, firstAt: a?.firstAt ?? null, lastAt: a?.lastAt ?? null, attempts: a?.attempts ?? 0, decidedBy: a?.decidedBy ?? null, decidedAt: a?.decidedAt ?? null, hosts: Object.values(hosts).filter((h) => users[h.uid]?.login.toLowerCase() === l).length, heldBy: (a?.heldBy && pins[l] === a.heldBy) ? a.heldBy : null, heldAttempt: (a?.heldBy && pins[l] === a.heldBy) ? a.heldAttempt ?? null : null }
      }),
    })
  }
  if (p === '/api/admin/models') {
    if (!isAdmin(uid)) throw new Refuse(403, '운영자만 볼 수 있습니다')
    if (post) {
      const b = await body(req, 4096)
      if (typeof b.auto === 'boolean') (models.auto = b.auto), writeJson(MODELS_FILE, models)
      if (b.refresh === true) await refreshModels('운영자')
    }
    return json(res, 200, modelsView())
  }
  if (get && p === '/api/admin/overview') {
    if (!isAdmin(uid)) throw new Refuse(403, '운영자만 볼 수 있습니다')
    return json(res, 200, {
      pending: Object.values(access).filter((a) => a.status === 'pending' && !isAllowed(a.login)).length,
      // github, originSet, root, agentSigned, agentSeqBack: said in /api/health until 1.296 (REQ-S-079), the flags only (R1-L16, R1-L5).
      server: { version: VERSION, agentBuild: AGENT_BUILD, github: !!GITHUB_CLIENT_ID, originSet: !!ORIGIN, root: process.getuid?.() === 0, agentSigned: AGENT_SIGNED, agentSeqBack: AGENT_SEQ_BACK, uptime: Math.round(process.uptime() * 1000), rss: process.memoryUsage().rss, bridges: realBridges().length, controls: [...controls.values()].reduce((n, s) => n + s.size, 0), sessions: sessions.size },
      users: Object.entries(users).filter(([id]) => !isDemoUid(id)).map(([id, u]) => ({
        login: u.login,
        allowed: isAllowed(u.login),
        hosts: Object.entries(hosts).filter(([, h]) => h.uid === id).map(([hid, h]) => ({ ...hostSummary(hid, h, id !== uid), agent: h.info?.version ?? null, build: h.info?.build ?? null, sessions: [...sessions.values()].filter((m) => m.hostId === hid && !m.closed).length })),
      })),
    })
  }
  // ---------- 제보 (REQ-F-735 ~ REQ-F-737) ----------
  // A video for a report, sent as it is before the report (as a message's are, REQ-F-761).
  if (post && p === '/api/reports/upload') {
    if (limited(req, 20, 'report-upload')) throw new Refuse(429, '너무 자주 올렸어요. 잠시 뒤에 다시 해 주세요')
    return json(res, 200, { ok: true, ...(await saveUpload(uid, req, url)) })
  }
  if (post && p === '/api/reports') {
    if (limited(req, 10, 'report')) throw new Refuse(429, '너무 자주 제보했어요. 잠시 뒤에 다시 해 주세요')
    const b = await body(req, 4 * 1024 * 1024)
    const text = String(b.text ?? '').trim().slice(0, 20_000)
    const pics = Array.isArray(b.images) ? b.images.slice(0, REPORT_IMAGES) : []
    const images = pics.map((x) => {
      const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(x?.data ?? ''))
      const id = m && saveReportImage(m[1], m[2])
      if (!id) throw new Refuse(400, '지원하지 않는 그림 형식이에요')
      return id
    })
    const vids = Array.isArray(b.videos) ? b.videos : []
    if (vids.length > REPORT_VIDEOS) throw new Refuse(400, `영상은 ${REPORT_VIDEOS}개까지 붙일 수 있어요`)
    const ups = vids.map((v) => uploadOf(uid, String(v?.id ?? '')) ?? (() => { throw new Refuse(400, '올린 영상을 찾지 못했어요. 다시 골라 주세요') })())
    if (!text && !images.length && !ups.length) throw new Refuse(400, '보낼 내용이 없어요')
    const report = { id: crypto.randomUUID(), at: Date.now(), uid, login: users[uid]?.login ?? '?', text, images, videos: ups.map(({ id, name, type, size }) => ({ id, name, type, size })), status: 'new', debug: reportDebug(uid, b) }
    fs.mkdirSync(path.dirname(reportVideoFile('x')), { recursive: true, mode: 0o700 })
    for (const u of ups) fs.renameSync(u.file, reportVideoFile(u.id)), fs.rmSync(`${u.file}.json`, { force: true })
    writeJson(reportFile(report.id), report)
    log(`report ${report.id} from ${report.login}`)
    if (reportAuto.on) void autoFix(report)
    return json(res, 200, { ok: true, id: report.id })
  }
  // 기존 데이터 정리 (REQ-S-075): counted for the operator; cleared only when the server was started with BRIDGE_PURGE=1.
  if (p === '/api/admin/purge') {
    if (!isAdmin(uid)) throw new Refuse(403, '운영자만 볼 수 있습니다')
    const enabled = process.env.BRIDGE_PURGE === '1'
    if (post) {
      if (!enabled) throw new Refuse(409, '정리는 꺼져 있어요. 서버 환경 변수 BRIDGE_PURGE=1 로 다시 시작한 뒤에 할 수 있어요')
      const b = await body(req, 4096)
      const kinds = (Array.isArray(b.kinds) ? b.kinds : []).filter((k) => k in PURGE_KINDS)
      if (!kinds.length) throw new Refuse(400, '지울 종류를 골라 주세요')
      if (!CONVERSATION_PURGE_READY && kinds.some((k) => CONVERSATION_KINDS.includes(k))) throw new Refuse(409, '대화 파일 정리는 서버가 대화를 더 저장하지 않게 된 뒤에 할 수 있어요')
      log(`purge by ${users[uid]?.login ?? uid}: ${kinds.join(', ')}`)
      return json(res, 200, { ok: true, done: purge(kinds), targets: purgeTargets() })
    }
    if (!get) throw new Refuse(405, '지원하지 않는 요청이에요')
    return json(res, 200, { enabled, since: RETENTION.since, conversationReady: CONVERSATION_PURGE_READY, kinds: PURGE_KINDS, targets: purgeTargets() })
  }
  if (p === '/api/admin/reports/auto') {
    if (!isAdmin(uid)) throw new Refuse(403, '운영자만 볼 수 있습니다')
    if (post) {
      const b = await body(req, 4096)
      if (typeof b.cwd === 'string' && b.cwd.trim()) reportAuto.cwd = b.cwd.trim().slice(0, 1000)
      // The Mac to start them on, or '' / null for the first one connected: one of the Macs of whoever turned it on
      // (while on), else of the operator asking (who becomes that person on turning it on).
      if (b.hostId === null || b.hostId === '') reportAuto.hostId = null
      else if (typeof b.hostId === 'string') {
        if (hosts[b.hostId]?.uid !== (reportAuto.on && b.on !== false ? reportAuto.uid : uid)) throw new Refuse(400, '자동 대응을 켠 운영자의 맥이 아니에요')
        reportAuto.hostId = b.hostId
      }
      // Sessions are started on the Mac of whoever turned it on, last.
      const turnedOn = b.on === true && !reportAuto.on
      if (typeof b.on === 'boolean' && b.on !== reportAuto.on) Object.assign(reportAuto, b.on ? { on: true, uid, by: users[uid]?.login ?? '?', since: Date.now() } : { on: false })
      if (turnedOn && reportAuto.hostId && hosts[reportAuto.hostId]?.uid !== uid) reportAuto.hostId = null
      writeJson(REPORT_AUTO_FILE, reportAuto)
      // The backlog starts at once, oldest first, and a report given up on while it was on gets its tries back.
      if (turnedOn) for (const r of readReports().filter((r) => r.status === 'new').sort((a, b) => a.at - b.at)) { delete r.auto; void autoFix(r) }
      sweepReports()
    } else if (!get) throw new Refuse(405, '지원하지 않는 요청이에요')
    return json(res, 200, reportAutoView())
  }
  // One's own reports, to read again and to remove (REQ-F-739). The operator may remove anyone's.
  const mr = /^\/api\/reports(?:\/([a-zA-Z0-9-]+)(?:\/(?:img\/([0-9a-f]{40}\.(?:png|jpg|gif|webp))|video\/([0-9a-f]{40}\.(?:mp4|mov|webm|m4v))))?)?$/.exec(p)
  if (mr) {
    if (!mr[1]) {
      if (!get) throw new Refuse(405, '지원하지 않는 요청이에요')
      const list = fs.existsSync(REPORTS) ? fs.readdirSync(REPORTS).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(REPORTS, f), null)).filter((r) => r && r.uid === uid) : []
      list.sort((a, b) => b.at - a.at)
      return json(res, 200, { reports: list.map((r) => ({ id: r.id, at: r.at, text: r.text, images: r.images, videos: (r.videos ?? []).map(({ id, name }) => ({ id, name })), status: r.status })) })
    }
    const r = safeId(mr[1]) ? readJson(reportFile(mr[1]), null) : null
    if (!r || (r.uid !== uid && !(req.method === 'DELETE' && isAdmin(uid)))) throw new Refuse(404, '제보가 없습니다')
    const video = get && mr[3] && r.videos?.find((v) => v.id === mr[3])
    if (video) return sendVideo(req, res, reportVideoFile(video.id), video.type)
    if (get && mr[2] && r.images.includes(mr[2])) {
      const file = reportImgFile(r, mr[2])
      if (!fs.existsSync(file)) throw new Refuse(404, '그림이 없습니다')
      res.writeHead(200, { 'Content-Type': Object.keys(IMG_TYPES).find((t) => IMG_TYPES[t] === mr[2].split('.')[1]), 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' })
      return fs.createReadStream(file).pipe(res)
    }
    if (req.method === 'DELETE' && !mr[2] && !mr[3]) {
      // The record, its videos and its own pictures go; an older report's pictures stay in the person's picture store.
      dropReport(r)
      log(`report ${r.id} removed by ${users[uid]?.login ?? '?'}`)
      return json(res, 200, { ok: true })
    }
    throw new Refuse(405, '지원하지 않는 요청이에요')
  }
  const rp = /^\/api\/admin\/reports(?:\/([a-zA-Z0-9-]+)(?:\/(fix|img|video)(?:\/([0-9a-f]{40}\.(?:png|jpg|gif|webp|mp4|mov|webm|m4v)))?)?)?$/.exec(p)
  if (rp) {
    if (!isAdmin(uid)) throw new Refuse(403, '운영자만 볼 수 있습니다')
    if (!rp[1]) {
      if (!get) throw new Refuse(405, '읽기만 됩니다')
      sweepReports()
      const list = readReports()
      list.sort((a, b) => b.at - a.at)
      return json(res, 200, { reports: list.map((r) => ({ id: r.id, at: r.at, login: r.login, text: r.text.slice(0, 200), images: r.images.length, videos: r.videos?.length ?? 0, status: r.status, fix: r.fix ?? null, auto: r.auto ?? null, where: r.debug?.client?.path ?? null, host: r.debug?.session?.host ?? null })), auto: reportAutoView() })
    }
    const r = safeId(rp[1]) ? readJson(reportFile(rp[1]), null) : null
    if (!r) throw new Refuse(404, '제보가 없습니다')
    if (get && !rp[2]) return json(res, 200, { report: { ...r, fix: r.fix ? { ...r.fix, open: !!sessions.get(r.fix.sid) && !sessions.get(r.fix.sid).closed } : null } })
    if (get && rp[2] === 'img' && rp[3] && r.images.includes(rp[3])) {
      const file = reportImgFile(r, rp[3])
      if (!fs.existsSync(file)) throw new Refuse(404, '그림이 없습니다')
      res.writeHead(200, { 'Content-Type': Object.keys(IMG_TYPES).find((t) => IMG_TYPES[t] === rp[3].split('.')[1]), 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' })
      return fs.createReadStream(file).pipe(res)
    }
    const video = get && rp[2] === 'video' && rp[3] && r.videos?.find((v) => v.id === rp[3])
    if (video) return sendVideo(req, res, reportVideoFile(video.id), video.type)
    if (post && rp[2] === 'fix') {
      const b = await body(req, 8192)
      // On the operator's own Mac: the one asked for, else the first one connected.
      const sid = await fixReport(r, uid, { hostId: b.hostId, cwd: b.cwd }, req)
      return json(res, 200, { ok: true, id: sid })
    }
    throw new Refuse(405, '지원하지 않는 요청이에요')
  }
  const m = /^\/api\/sessions\/([a-zA-Z0-9-]+)(?:\/(\w+))?$/.exec(p)
  if (m) {
    const meta = ownSession(uid, m[1])
    const op = m[2]
    if (post && ['lock', 'unlock', 'lockclear'].includes(op)) {
      // Per address, and per session whatever address the attempts claim (R1-M4).
      if (limited(req, 10, 'lock') || hit(`lock-session|${meta.id}`, 10)) throw new Refuse(429, '너무 자주 시도했어요. 잠시 뒤에 다시 해 주세요')
      const b = await body(req, 4096)
      if (op === 'unlock') {
        if (!meta.lock) return json(res, 200, { ok: true, token: null })
        if (!(await proofOk(meta, b.proof))) throw new Refuse(403, '비밀번호가 맞지 않아요')
        return json(res, 200, { ok: true, token: lockToken(meta) })
      }
      if (op === 'lockclear') {
        if (!meta.lock) return json(res, 200, { ok: true })
        if (!(await proofOk(meta, b.proof))) throw new Refuse(403, '비밀번호가 맞지 않아요')
        delete meta.lock
        for (const [k, t] of unlocks) if (t.sid === meta.id) unlocks.delete(k)
        touch(meta)
        broadcastState(uid)
        return json(res, 200, { ok: true, note: '잠금을 없앴어요' })
      }
      // Locking an already locked session (a new password) needs it unlocked first.
      if (meta.lock && !unlockedBy(req, meta)) throw new Refuse(423, LOCKED)
      // Its conversation is in a Slack thread already: a lock here would hide nothing.
      if (seatOf(meta) === 'slack') throw new Refuse(409, 'Slack 에서 작업 중인 세션은 잠글 수 없어요. 브릿지로 가져온 뒤 잠가 주세요')
      if (!/^[0-9a-f]{64}$/.test(String(b.proof ?? ''))) throw new Refuse(400, '비밀번호가 올바르지 않아요')
      const salt = crypto.randomBytes(16).toString('hex')
      meta.lock = { salt, hash: await stretch(b.proof, salt), at: Date.now() }
      for (const [k, t] of unlocks) if (t.sid === meta.id) unlocks.delete(k)
      touch(meta)
      broadcastState(uid)
      // Whoever locked it keeps it open in that tab.
      return json(res, 200, { ok: true, token: lockToken(meta), note: '잠갔어요. 다른 기기와 탭에서는 비밀번호를 물어요' })
    }
    // Calls made inside the server for a request that was already let through carry no headers: only the
    // routes a page or a plugin reaches directly are checked here.
    if (meta.lock && !req.internal && !unlockedBy(req, meta)) throw Object.assign(new Refuse(423, LOCKED), { extra: { locked: true } })
    // While it is worked on in Slack, a page only reads it; moving it back (seat) is the way in. What the Slack
    // plugin does comes through csSend and csCommand, which check the same thing.
    if (post && !req.internal && SEAT_DRIVES.has(op)) seatGuard(meta, 'web')
    if (post && op === 'seat') {
      const b = await body(req, 16 * 1024)
      return json(res, 200, await moveSeat(uid, meta, b.to))
    }
    if (post && op === 'voice') {
      // A recording to words, on the Mac the session is on (REQ-F-754). Only the words come back: the page then
      // sends them through 'say', like anything typed.
      const b = await body(req, 4 * 1024 * 1024)
      const prefs = cleanVoice(prefsOf(uid).voice)
      if (!prefs.on) throw new Refuse(409, '음성 입력이 꺼져 있어요. 설정 → 음성에서 켜 주세요')
      const audio = String(b.audio ?? '')
      if (!audio || !/^[A-Za-z0-9+/]+=*$/.test(audio)) throw new Refuse(400, '녹음이 비어 있어요')
      const hostId = liveHost(meta)
      // This Mac's own choice, where it made one (REQ-F-758).
      const over = cleanVoiceHost(prefsOf(uid).voiceHosts?.[hostId])
      const r = await ask(hostId, { t: 'voice', audio, opts: { model: over.model || prefs.model, language: prefs.language, denoise: prefs.denoise, tidy: prefs.tidy, terms: prefs.terms } }, 90_000)
      if (!r.ok) throw Object.assign(new Refuse(r.code === 'silent' || r.code === 'audio' ? 422 : 502, r.error || '받아쓰지 못했어요'), { extra: { code: r.code ?? 'error' } })
      return json(res, 200, { ok: true, raw: String(r.raw ?? ''), text: String(r.text ?? ''), sec: r.sec, backend: r.backend, model: r.model, denoise: r.denoise, ms: r.ms })
    }
    if (post && op === 'preview') {
      // An address on the preview origin for one of the servers the session started (REQ-F-650).
      const b = await body(req, 4096)
      const port = Number(b.port)
      liveHost(meta)
      if (!meta.state.servers?.some((x) => x.port === port)) throw new Refuse(404, `이 세션이 띄운 ${b.port} 포트 서버가 없어요`)
      return json(res, 200, { ok: true, url: preview.url({ uid, hostId: meta.hostId, port, sid: meta.id }) })
    }
    if (post && op === 'killserver') {
      // The computer button's 끄기: the Mac stops one of the servers the session started (REQ-F-728).
      const b = await body(req, 4096)
      const port = Number(b.port)
      const hostId = liveHost(meta)
      if (!meta.state.servers?.some((x) => x.port === port)) throw new Refuse(404, `이 세션이 띄운 ${b.port} 포트 서버가 없어요`)
      const r = await ask(hostId, { t: 'killserver', sid: meta.id, port }, 15_000)
      if (!r.ok) throw new Refuse(409, r.error || '서버를 끄지 못했어요')
      return json(res, 200, { ok: true, note: r.note })
    }
    if (get && op === 'events') {
      // `after`: what a page missed while it was away, oldest first. `before`: one page further back.
      // Neither: the newest page. `more` says there is more in the direction that was asked for.
      // The log is on the session's Mac (REQ-S-069): asked of it, with what it has not said it kept yet. A Mac that
      // is not connected: nothing to show from here, the page draws what it has kept and says so.
      // Read when answering: what was logged while the Mac was asked is then known to be there (the page asks after it).
      const extra = () => ({ last: meta.seq ?? 0, lines: meta.lines, writing: meta.writing || '', card: meta.card })
      const params = Object.fromEntries(['after', 'before'].filter((k) => url.searchParams.has(k)).map((k) => [k, Number(url.searchParams.get(k))]))
      if (meta.agentLog && !isDemoHost(meta.hostId)) {
        if (!online(meta.hostId)) return json(res, 409, { error: '맥 연결 끊김', offline: true, ...extra() })
        if (storeOn(meta.hostId)) {
          const r = await ask(meta.hostId, { t: 'events', sid: meta.id, limit: EVENTS_PAGE, ...params }, 15_000)
          if (!r.ok) return json(res, 502, { error: r.error || '맥에서 세션 기록을 읽지 못했어요', ...extra() })
          const bySeq = new Map((Array.isArray(r.events) ? r.events : []).map((e) => [e.seq, e]))
          const lo = params.after ?? -Infinity
          const hi = params.before ?? Infinity
          const top = r.events?.at(-1)?.seq ?? 0
          // Handed down, not yet kept: inside the page asked for (or past its end when it is the newest).
          for (const e of handedNotKept(meta)) if (e.seq > lo && e.seq < hi && !bySeq.has(e.seq) && (params.after != null ? !r.more || e.seq < top : true)) bySeq.set(e.seq, e)
          let page = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
          let more = !!r.more
          if (page.length > EVENTS_PAGE) (more = true), (page = params.after != null ? page.slice(0, EVENTS_PAGE) : page.slice(-EVENTS_PAGE))
          if (params.after == null && params.before == null) remember(meta, page, true)
          return json(res, 200, { events: page, more, ...extra() })
        }
      }
      const all = readEvents(meta)
      const after = Number(url.searchParams.get('after'))
      const before = Number(url.searchParams.get('before'))
      let page
      let more
      if (url.searchParams.has('after')) {
        const rest = all.filter((e) => e.seq > after)
        page = rest.slice(0, EVENTS_PAGE)
        more = rest.length > page.length
      } else {
        const older = url.searchParams.has('before') ? all.filter((e) => e.seq < before) : all
        page = older.slice(-EVENTS_PAGE)
        more = older.length > page.length
      }
      return json(res, 200, { events: page, more, last: meta.seq ?? 0, lines: meta.lines, writing: meta.writing || '', card: meta.card })
    }
    if (get && op === 'agentsmd') {
      const which = url.searchParams.get('file') === 'session' ? 'session' : null
      const r = await ask(liveHost(meta), { t: 'readfile', sid: meta.id, ...(which ? { which } : {}) }, 15_000)
      if (!r.ok) throw new Refuse(404, r.error || '파일을 읽지 못했습니다')
      // An agent from before `which` answers with AGENTS.md: not what was asked for.
      if (which && !/^SESSION(-[0-9a-f]{8})?\.md$/.test(String(r.name))) throw new Refuse(404, '에이전트가 업데이트되면 볼 수 있어요')
      return json(res, 200, { ok: true, name: r.name, path: r.path, content: String(r.content).slice(0, 512 * 1024) })
    }
    if (get && op === 'localimg') {
      // A picture an answer names by its path on the Mac: fetched once, then kept like any other picture.
      const want = String(url.searchParams.get('path') ?? '')
      if (!/^(~|\/)[^\0\n]{1,1000}\.(png|jpe?g|gif|webp)$/i.test(want)) throw new Refuse(400, '그림 파일 경로가 아니에요')
      // Read from the Mac each time and passed on, not kept (REQ-S-069); the browser keeps it for an hour.
      if (!online(meta.hostId)) throw new Refuse(409, '세션의 호스트가 연결돼 있지 않습니다')
      const r = await ask(meta.hostId, { t: 'readimage', sid: meta.id, path: want }, 30_000)
      if (!r.ok) throw new Refuse(404, r.error || '그림을 읽지 못했습니다')
      const bytes = Buffer.from(String(r.data ?? ''), 'base64')
      if (!IMG_TYPES[r.type] || !bytes.length || bytes.length > 12 * 1024 * 1024) throw new Refuse(404, '그림을 읽지 못했습니다')
      res.writeHead(200, { 'Content-Type': r.type, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' })
      return res.end(bytes)
    }
    if (get && op === 'skills') {
      const r = await ask(liveHost(meta), { t: 'skills', sid: meta.id }, 20_000)
      if (!r.ok) throw new Refuse(502, r.error || '스킬 목록을 읽지 못했습니다')
      // An older agent still sends a flat list; a newer one sends the menu the page draws.
      const menu = r.menu ?? { direct: [], auto: [], other: (r.skills ?? []).map((x) => ({ name: x.name, kind: 'skill', source: x.source, count: 0, description: x.description })) }
      const flat = [...menu.direct.map((x) => ({ ...x, direct: x.count, auto: 0 })), ...menu.auto.map((x) => ({ ...x, direct: 0, auto: x.count })), ...menu.other.map((x) => ({ ...x, direct: 0, auto: 0 }))]
      return json(res, 200, { ok: true, menu, skills: flat })
    }
    if (get && op === 'screen') {
      const r = await ask(liveHost(meta), { t: 'screen', sid: meta.id }, 15_000)
      if (!r.ok && r.error) throw new Refuse(502, r.error)
      return json(res, 200, { ok: true, text: String(r.text ?? '').slice(0, 200_000) })
    }
    if (get && op === 'links') return json(res, 200, await sessionLinks(meta, linksLimit(url)))
    if (get && op === 'trash') {
      const r = await ask(liveHost(meta), { t: 'trashinfo', sid: meta.id }, 30_000)
      if (!r.ok) throw new Refuse(409, r.error || '폴더를 살펴보지 못했습니다')
      return json(res, 200, { ok: true, cwd: r.cwd, repos: r.repos })
    }
    if (req.method === 'DELETE' && !op) {
      if (meta.moving) throw new Refuse(409, '세션을 옮기는 중입니다')
      toHost(meta.hostId, { t: 'close', sid: meta.id })
      forgetSession(meta)
      savePrefs(uid)
      return json(res, 200, { ok: true })
    }
    if (!post) throw new Refuse(405, '지원하지 않는 요청입니다')
    if (op === 'upload') return json(res, 200, { ok: true, ...(await saveUpload(uid, req, url)) })
    const b = await body(req, op === 'send' || op === 'say' ? 6 * 1024 * 1024 : 256 * 1024)
    if (op === 'say') {
      // What the page's input sends: a /btw side question and a ":" command go their own way, the rest is said.
      const key = `${uid}|say|${meta.id}|${String(b.text ?? '')}|${(b.images ?? []).length}|${(b.videos ?? []).length}`
      if (seenJustNow(key)) return json(res, 200, { ok: true, note: '같은 글을 방금 보냈어요' })
      const r = await csSend(uid, meta, String(b.text ?? ''), Array.isArray(b.images) ? b.images : [], b.via === 'slack' ? 'slack' : undefined, { unlocked: true, videos: Array.isArray(b.videos) ? b.videos : [] }).catch((e) => {
        recentKeys.delete(key)
        throw e
      })
      return json(res, 200, { ok: true, ...(r?.note ? { note: r.note } : {}) })
    } else if (op === 'do') {
      // A command from the session menu or a card, the same words the input's ":" commands take.
      const cmd = String(b.cmd ?? '')
      if (!/^[a-z]{2,20}$/.test(cmd)) throw new Refuse(400, '알 수 없는 명령이에요')
      const key = `${uid}|do|${meta.id}|${cmd}|${b.arg ?? ''}`
      if (seenJustNow(key)) return json(res, 200, { ok: true, note: '' })
      const note = await csCommand(uid, `${csIds(meta).pid}:${cmd} ${String(b.arg ?? '').slice(0, 200)}`, { unlocked: true }).catch((e) => {
        recentKeys.delete(key)
        throw e
      })
      return json(res, 200, { ok: true, note: note === '눌렀어요' ? '' : note })
    } else if (op === 'send') {
      const text = String(b.text || '')
      // Pictures: 8 at most, 3 MiB of base64 together, the four types a browser can make. All or nothing.
      const pics = Array.isArray(b.images) ? b.images : []
      if (pics.length > 8) throw new Refuse(400, '이미지는 한 번에 8장까지 보낼 수 있어요')
      const files = pics.map((x) => {
        const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(x?.data ?? ''))
        if (!m) throw new Refuse(400, '지원하지 않는 그림 형식이에요')
        return { type: m[1], data: m[2], name: typeof x?.name === 'string' ? x.name : undefined }
      })
      if (files.reduce((n, f) => n + f.data.length, 0) > 3_145_728) throw new Refuse(413, '이 메시지에 담기에는 그림이 너무 커요')
      // Videos (REQ-F-761): sent before, by id; the bridge tab fetches each and hands it to the Mac.
      const vids = Array.isArray(b.videos) ? b.videos : []
      if (vids.length > 3) throw new Refuse(400, '영상은 한 번에 3개까지 보낼 수 있어요')
      const videos = vids.map((v) => uploadOf(uid, String(v?.id ?? '')) ?? (() => { throw new Refuse(400, '올린 영상을 찾지 못했어요. 다시 골라 주세요') })())
      if (!text.trim() && !files.length && !videos.length) throw new Refuse(400, '보낼 내용이 없어요')
      if (meta.state.handedOffTo && sessions.get(meta.state.handedOffTo) && !sessions.get(meta.state.handedOffTo).closed && !/^[/:]/.test(text.trim())) throw new Refuse(409, '🧵 이 세션은 더 가벼운 새 세션으로 넘겨졌어요. 거기서 이어가세요.')
      if (!meta.state.alive) {
        if (meta.closed || meta.moving || !online(meta.hostId)) throw new Refuse(409, meta.closed ? '이미 끝난 세션이에요' : '세션이 멈춰 있습니다. 다시 연 뒤 보내 주세요')
        logEvents(meta, [{ k: 'line', text: '🔄 끊긴 세션을 대화 그대로 이어서 다시 엽니다.' }])
        // What ran in the background went with the old process.
        meta.bg = []
        await moveSession(meta, meta.hostId)
      }
      const hostId = liveHost(meta)
      // Past 100 MB the conversation takes no more text from here (a slash command still goes through):
      // every turn makes it slower to resume and to move. A light copy carries the work on.
      if ((meta.state.size ?? 0) >= 100 * 1024 * 1024 && !/^\//.test(text.trim())) throw new Refuse(409, '🚫 대화 기록이 100MB 를 넘어 입력을 막았어요. 세션 메뉴의 대화 기록 정리(압축한 뒤)나 가벼운 복제를 쓰거나, 터미널에서 직접 입력하세요.')
      meta.resting = false
      for (const f of files) f.id = imageRef(uid, f.type, f.data, f.name)
      const id = crypto.randomUUID()
      // Logged now, as said from the page; its echo from the transcript is recognised and not logged again.
      // 'delegate': said by the session that handed this one its work (REQ-F-760), never from a page.
      // 'delegated': the answer of a session this one handed work to, when its turn ended (rule 11).
      logSaid(meta, id, [text.trim(), ...videos.map((v) => `🎬 ${v.name}`)].filter(Boolean).join('\n'), { via: b.via === 'slack' ? 'slack' : (b.via === 'delegate' || b.via === 'delegated') && req.internal ? b.via : 'web', images: files.map((f) => f.id).filter(Boolean) })
      if (videos.length) sentUploads.set(id, videos.map((v) => [uid, v.id]))
      toHost(hostId, { t: 'send', sid: meta.id, id, text: text.slice(0, 100_000), ...(files.length ? { files: files.map(({ id, data }) => ({ id, data })) } : {}), ...(videos.length ? { videos: videos.map(({ id, name, type, size }) => ({ id, name, type, size })) } : {}) })
    } else if (op === 'retract') {
      // The newest thing the person said, quoted back so the session knows which one is meant.
      // The message that was pressed; without one, the newest thing the person said. Quoted back (80 characters)
      // so the session knows which is meant, and marked so every device fades it.
      const said = (await recentEvents(meta)).slice(-3000).filter((e) => e.k === 'user' && !e.command && !/^\[정정\]/.test(e.text))
      const last = typeof b.ts === 'string' && b.ts ? said.find((e) => (e.id ?? `u${e.seq}`) === b.ts) : said.at(-1)
      if (!last) throw new Refuse(400, '그 메시지를 찾지 못했어요')
      const quoted = last.text.replace(/\s+/g, ' ').trim()
      toHost(liveHost(meta), { t: 'retract', sid: meta.id, quoted: quoted.length > 80 ? `${quoted.slice(0, 79)}…` : quoted })
      logEvents(meta, [{ k: 'react', id: last.id ?? `u${last.seq}`, name: 'x', on: true }])
      return json(res, 200, { ok: true, note: '멈추고 잘못 보냈다고 알렸어요' })
    } else if (op === 'sendnow' || op === 'esc') {
      toHost(liveHost(meta), { t: op, sid: meta.id })
      // Stopping a session stops what it handed to other Macs too (REQ-F-760).
      if (op === 'esc') for (const c of delegatesOf(meta)) toHost(c.hostId, { t: 'esc', sid: c.id })
    } else if (op === 'dropheld') {
      // The Mac says which ones it still had: only those are marked as taken back.
      const r = await ask(liveHost(meta), { t: 'dropheld', sid: meta.id, id: typeof b.id === 'string' ? b.id.slice(0, 64) : undefined }, 10_000)
      const ids = (Array.isArray(r.ids) ? r.ids : []).filter((x) => typeof x === 'string').slice(0, 50)
      if (ids.length) logEvents(meta, ids.flatMap((id) => [{ k: 'react', id, name: 'hourglass_flowing_sand', on: false }, { k: 'react', id, name: 'x', on: true }]))
      meta.heldIds = (meta.heldIds ?? []).filter((x) => !ids.includes(x))
      meta.echo = (meta.echo ?? []).filter((x) => !ids.includes(x.id))
      return json(res, 200, { ok: true, ids })
    } else if (op === 'answer') {
      if (!safeId(b.card)) throw new Refuse(400, '카드가 올바르지 않습니다')
      toHost(liveHost(meta), { t: 'answer', sid: meta.id, card: b.card, n: b.n === 'esc' || b.n === 'enter' ? b.n : Number(b.n) })
    } else if (op === 'setting') {
      if (!['model', 'effort', 'mode'].includes(b.kind)) throw new Refuse(400, '없는 설정입니다')
      toHost(liveHost(meta), { t: 'setting', sid: meta.id, kind: b.kind, value: String(b.value ?? '').slice(0, 60) })
    } else if (op === 'refresh') {
      refreshSession(uid, meta, liveHost(meta), ['later', 'cancel'].includes(b.when) ? b.when : 'now')
    } else if (op === 'report') {
      toHost(liveHost(meta), { t: 'report', sid: meta.id })
    } else if (op === 'btw') {
      const q = String(b.text ?? '').trim()
      if (!q) throw new Refuse(400, '질문을 적어 주세요')
      const r = await ask(liveHost(meta), { t: 'btw', sid: meta.id, text: q }, 150_000)
      return json(res, 200, r.ok ? { ok: true, answer: String(r.answer).slice(0, 20_000) } : { ok: false, error: r.error })
    } else if (op === 'trash') {
      const r = await ask(liveHost(meta), { t: 'trash', sid: meta.id }, 60_000)
      if (!r.ok) throw new Refuse(409, r.error || '폴더를 휴지통으로 옮기지 못했습니다')
      meta.closed = true
      meta.closedAt = Date.now()
      Object.assign(meta, volatile())
      logEvents(meta, [{ k: 'end', text: '폴더를 휴지통으로 옮김' }])
      return json(res, 200, { ok: true, note: `세션을 끝내고 폴더를 휴지통으로 옮겼어요 · ${r.to}` })
    } else if (op === 'resume') {
      // A session that was ended is opened again on the host the person picks: its own Mac's copy, or carried from
      // that Mac to another (REQ-S-069).
      if (!meta.closed) throw new Refuse(409, '끝난 세션이 아닙니다')
      const target = typeof b.hostId === 'string' ? b.hostId : meta.hostId
      ownHost(uid, target)
      meta.closed = false
      meta.resting = false
      const same = target === meta.hostId
      try {
        // Its old host has let go of it; whichever host opens it now does so like a move.
        if (same) meta.state = noState()
        const r = await moveSession(meta, target, safeAccount(b.account) ? b.account : undefined)
        return json(res, 200, r)
      } catch (e) {
        meta.closed = true
        touch(meta)
        throw e
      }
    } else if (op === 'trimlog') {
      // 대화 기록 정리 (REQ-F-793): the Mac cuts the transcript at its last compaction and opens the session again.
      if (!meta.state.alive || meta.state.phase !== 'idle') throw new Refuse(409, '쉬고 있는 세션만 기록을 정리할 수 있어요')
      const r = await ask(liveHost(meta), { t: 'trimlog', sid: meta.id }, 120_000)
      if (!r.ok) throw new Refuse(409, r.error || '대화 기록을 정리하지 못했어요')
      const after = Number(r.after) || 0
      meta.state.size = after
      broadcastState(uid)
      return json(res, 200, { ok: true, before: Number(r.before) || 0, after, note: `대화 기록을 ${Math.round((Number(r.before) || 0) / 1048576)}MB → ${Math.max(1, Math.round(after / 1048576))}MB 로 정리했어요` })
    } else if (op === 'lightfork') {
      const hostId = liveHost(meta)
      const sid = crypto.randomUUID()
      // The person's defaults (설정) win over what the original runs with; what is not set is the original's.
      const over = launchOver(uid)
      const copy = newMeta(uid, sid, hostId, { cwd: meta.cwd, title: (meta.title || '세션').slice(0, 80), manualTitle: true, launchModel: over.model || meta.launchModel || '', autoPush: meta.autoPush, account: meta.account ?? '' })
      copy.state = { ...noState(), alive: true, phase: 'starting' }
      const r = await ask(hostId, { t: 'lightfork', sid: meta.id, newSid: sid, sysPrompt: sysPromptOf(uid), mode: ['shrink', 'cut'].includes(b.mode) ? b.mode : undefined, launch: over }, 240_000)
      if (!r.ok) {
        sessions.delete(sid)
        dirty.delete(sid)
        broadcastState(uid)
        if (r.tooBig) {
          // A choice, not a silent cut: shorten it, or hand over its first part (up to the session's limit).
          const text = `${/^SESSION(-[0-9a-f]{8})?\.md$/.test(String(r.name ?? '')) ? r.name : 'SESSION.md'} 가 ${Math.round(r.tooBig / 1000)} KB 예요(넘길 수 있는 건 ${Math.round((Number(r.max) || 20_000) / 1000)} KB) · 줄여서 넘길까요?`
          const pid = csIds(meta).pid
          const btn = (label, value, style) => ({ type: 'button', text: { type: 'plain_text', text: label, emoji: true }, action_id: 'ctl_btn', value, ...(style ? { style } : {}) })
          logEvents(meta, [{ k: 'line', text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }, { type: 'actions', block_id: `lightfork_${pid}`, elements: [btn('줄이기', `${pid}:lightfork shrink`, 'primary'), btn('앞부분만', `${pid}:lightfork cut`)] }] }])
          return json(res, 200, { ok: false, tooBig: true })
        }
        throw new Refuse(502, r.error || '가벼운 복제를 하지 못했습니다')
      }
      if (launchAutoAllow(uid)) turnOnAutoAllow(copy)
      touch(copy)
      besideInGroup(uid, meta.id, sid)
      savePrefs(uid)
      toHost(hostId, { t: 'report', sid })
      return json(res, 200, { ok: true, id: sid })
    } else if (op === 'fork') {
      const hostId = liveHost(meta)
      const sid = crypto.randomUUID()
      const over = launchOver(uid)
      const copy = newMeta(uid, sid, hostId, { cwd: meta.cwd, title: `${meta.title || '세션'}의 사본`.slice(0, 80), manualTitle: true, launchModel: over.model || meta.launchModel || '', autoPush: meta.autoPush, account: meta.account ?? '' })
      copy.state = { ...noState(), alive: true, phase: 'starting' }
      fs.mkdirSync(sessionDir(copy), { recursive: true })
      // The conversation comes along; its cards do not (their buttons belong to the original). The Mac copies its own
      // log (copyLog) and says which lines it copied (REQ-S-069). A log still only on this server goes down from here.
      const legacy = !meta.agentLog && fs.existsSync(eventsFile(meta))
      Object.assign(copy, { forked: meta.id, seq: meta.seq ?? 0, last: meta.last, preview: meta.preview, lastAt: Date.now(), model: meta.model, agentLog: true })
      besideInGroup(uid, meta.id, sid)
      savePrefs(uid)
      const r = await ask(hostId, { t: 'fork', sid: meta.id, newSid: sid, sysPrompt: sysPromptOf(uid), launch: over, ...(legacy ? {} : { copyLog: meta.seq ?? 0 }) }, 60_000)
      if (r.ok) {
        const uuids = (Array.isArray(r.uuids) ? r.uuids : []).filter((u) => typeof u === 'string' && /^[0-9a-f-]{36}$/.test(u))
        // Ids only, no words: kept so a restart still knows which lines were copied.
        fs.writeFileSync(forkSkipFile(copy), uuids.join('\n'))
        forkSkip.set(sid, new Set(uuids))
        if (legacy) {
          const keep = readLegacyEvents(meta, false).filter((e) => !['card', 'card_end', 'react', 'status', 'held'].includes(e.k))
          for (let i = 0; i < keep.length; i += 500) handDown(hostId, { t: 'log', sid, events: keep.slice(i, i + 500) })
        }
        logEvents(copy, [{ k: 'notice', icon: 'undo', text: `여기까지 복제한 대화예요 (${meta.id.slice(0, 8)} 에서). 이 아래부터 새 세션이에요` }])
      }
      if (!r.ok) {
        sessions.delete(sid)
        dirty.delete(sid)
        fs.rmSync(sessionDir(copy), { recursive: true, force: true })
        broadcastState(uid)
        throw new Refuse(502, r.error || '세션을 복제하지 못했습니다')
      }
      if (launchAutoAllow(uid)) turnOnAutoAllow(copy)
      touch(copy)
      toHost(hostId, { t: 'report', sid })
      return json(res, 200, { ok: true, id: sid })
    } else if (op === 'key') {
      toHost(liveHost(meta), { t: 'key', sid: meta.id, keys: Array.isArray(b.keys) ? b.keys.map(String).slice(0, 20) : [] })
    } else if (op === 'screen') {
      toHost(liveHost(meta), { t: 'screen', sid: meta.id })
    } else if (op === 'cwd') {
      // Another working folder on the same Mac (REQ-F-785): / or ~ first, made when missing.
      const cwd = typeof b.cwd === 'string' ? b.cwd.trim().replace(/\/+$/, '') || '/' : ''
      if (!/^(\/|~(\/|$))/.test(cwd) || cwd.length > 1000 || /[\0\n\r]/.test(cwd) || cwd.split('/').includes('..')) throw new Refuse(400, '작업 폴더는 / 또는 ~ 로 시작하는 경로여야 해요')
      ownHost(uid, meta.hostId)
      return json(res, 200, await moveSession(meta, meta.hostId, undefined, { cwd }))
    } else if (op === 'move') {
      // hostId: the Mac to move to (the same one to only change the Claude account). account: the account there.
      const hostId = b.hostId ?? meta.hostId
      ownHost(uid, hostId)
      if (b.account !== undefined && !safeAccount(b.account)) throw new Refuse(400, '계정 id 가 올바르지 않습니다')
      return json(res, 200, await moveSession(meta, hostId, b.account))
    } else if (op === 'settings') {
      // A name, a rest, a group are the page's; how the session runs is for the place it is worked on.
      if (!req.internal && (typeof b.autoAllow === 'boolean' || typeof b.autoPush === 'boolean')) seatGuard(meta, 'web')
      if (typeof b.autoPush === 'boolean') {
        meta.autoPush = b.autoPush
        toHost(meta.hostId, { t: 'set', sid: meta.id, autoPush: b.autoPush })
      }
      if (typeof b.autoAllow === 'boolean') {
        // The sessions it handed work to follow its permission policy (REQ-F-760).
        for (const m of [meta, ...delegatesOf(meta)]) {
          m.autoAllow = b.autoAllow
          toHost(m.hostId, { t: 'set', sid: m.id, autoAllow: b.autoAllow })
          if (m !== meta) touch(m)
        }
      }
      // A name a person gave wins over the one Claude Code comes up with later.
      if (typeof b.resting === 'boolean') meta.resting = b.resting
      // A favourite goes to the top of the newest-first list (REQ-F-782); unset leaves no field behind.
      if (typeof b.favorite === 'boolean') b.favorite ? (meta.favorite = true) : delete meta.favorite
      // To-dos the person took off the panel (REQ-F-784), by their words; the page sends the whole list each time.
      if (Array.isArray(b.todoHidden)) {
        const keys = [...new Set(b.todoHidden.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim().slice(0, TODO_KEY_MAX)))].slice(-TODO_HIDDEN_MAX)
        keys.length ? (meta.todoHidden = keys) : delete meta.todoHidden
      }
      if (typeof b.title === 'string') Object.assign(meta, { title: b.title.trim().slice(0, 80), manualTitle: !!b.title.trim() })
      touch(meta)
    } else if (op === 'close') {
      if (meta.moving) throw new Refuse(409, '세션을 옮기는 중입니다')
      closeSession(meta)
    } else throw new Refuse(404, '없는 동작입니다')
    return json(res, 200, { ok: true })
  }
  throw new Refuse(404, '없는 경로입니다')
}

const RECOVERY = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><link rel="icon" href="/icon.svg" type="image/svg+xml"><title>문제가 생겼을 때 · Agent Bridge</title>
<style>${FONT_TOKENS}body{font:var(--fs-large)/1.65 -apple-system,system-ui,sans-serif;max-width:680px;margin:0 auto;padding:24px 16px 64px}h1{font-size:var(--fs-xlarge)}h2{font-size:var(--fs-large);margin-top:28px}code{background:rgba(127,127,127,.18);padding:1px 5px;border-radius:5px;overflow-wrap:anywhere}li{margin:6px 0}a{color:inherit}</style>
<h1>문제가 생겼을 때</h1>
<p>세션은 맥에서 돌고, 이 사이트는 맥의 브라우저에 열린 페이지를 거쳐 그 맥과 이어집니다. 대부분의 문제는 그 연결이 끊긴 것입니다.</p>
<h2>기기가 "연결 끊김" 일 때</h2><ol><li>그 맥의 Chrome 에서 이 사이트를 엽니다. 열려 있는 동안 연결됩니다.</li><li>그래도 안 되면 <a href="/bridge">기기와 연동 상태</a> 에서 에이전트와 서버 어느 쪽이 끊겼는지 봅니다.</li><li>에이전트가 꺼져 있으면 맥의 터미널에서 다시 설치합니다: <code>curl -fsSL __ORIGIN__/install.sh | bash</code></li></ol>
<h2>세션이 멈춘 것 같을 때</h2><ol><li>세션의 <b>화면</b> 칩으로 터미널이 무엇을 기다리는지 봅니다.</li><li>메뉴의 <b>새로고침</b> 은 대화를 그대로 두고 세션만 다시 엽니다.</li><li>맥이 꺼져 있으면 세션 화면의 안내에서 다른 맥으로 이어서 열 수 있습니다.</li></ol>
<h2>화면이 이상할 때</h2><ol><li>새로고침합니다.</li><li>브라우저의 사이트 데이터를 지우고 다시 로그인합니다. 대화는 서버에 있어 사라지지 않습니다.</li></ol>
<p><a href="/">← 돌아가기</a></p></html>`

// ---------- 데모 모드 (REQ-F-766, REQ-S-068) ----------
// Each demo sign-in gets an account of its own (`demo-<12 hex>`) with one Mac, played inside this server
// (server/demo.mjs), and nothing else. Every API is refused to it but the ones listed here, and those only for its own
// Mac and sessions.

/** Demos one address may open in an hour (each press of 데모로 둘러보기 makes one). */
const DEMO_PER_IP_HOUR = 10
/** Demo accounts kept at once. When full, one unused for DEMO_EVICT_IDLE_MS makes room; if none, a new demo waits. */
const DEMO_MAX = 50
const DEMO_EVICT_IDLE_MS = 15 * 60_000
/** A demo unused this long is cleared (its sign-in still works and starts it anew). Looked at every DEMO_SWEEP_MS. */
const DEMO_IDLE_MS = 24 * 3_600_000
const DEMO_SWEEP_MS = 10 * 60_000
/** Demo sign-ins kept in logins.json: the oldest go past this. */
const DEMO_LOGINS_MAX = 1000
/** What one demo may send: this long a text at most, this many sends (messages, new sessions, copies, recordings) a minute. */
const DEMO_TEXT_MAX = 2000
const DEMO_SENDS_PER_MIN = 20
/** Sessions one demo may have. */
const DEMO_SESSIONS_MAX = 20
/** A recording for the voice screen (about 25 s of 16 kHz speech in base64); every other demo body. */
const DEMO_VOICE_BYTES = 1_572_864
const DEMO_BODY_BYTES = 64 * 1024
/** The iOS app (REQ-F-756) says so in its user agent; only there can the page ask for an Apple ID (REQ-F-772). */
const inApp = (req) => /\bAgentBridge\//.test(String(req.headers['user-agent'] ?? ''))
/**
 * Apple로 로그인 (REQ-F-772), drawn as Apple's guidelines ask: black (white in dark mode), Apple's logo, the same
 * size as the GitHub button and above it (App Store guideline 4.8). web/apple-login.js does the rest.
 */
const APPLE_BUTTON = `<style>.sign-pair .btn{display:flex;width:100%;height:44px;justify-content:center;font-weight:600}.btn.apple{gap:8px;background:#000;color:#fff;border-color:#000}.btn.apple svg{width:18px;height:18px;fill:currentColor}@media (prefers-color-scheme:dark){:root:not([data-theme=light]) .btn.apple{background:#fff;color:#000;border-color:#fff}}:root[data-theme=dark] .btn.apple{background:#fff;color:#000;border-color:#fff}.apple-error{color:var(--red,#c00);margin:6px 0 0;font-size:var(--fs-small)}</style><button type="button" class="btn apple" id="apple-login" aria-label="Apple로 로그인"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.37 12.6c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.48.83-.72 0-1.82-.81-3-.79-1.54.02-2.96.9-3.76 2.27-1.6 2.78-.41 6.9 1.15 9.15.76 1.1 1.67 2.34 2.86 2.3 1.15-.05 1.58-.74 2.97-.74 1.38 0 1.78.74 2.99.72 1.24-.02 2.02-1.12 2.77-2.23.87-1.28 1.23-2.52 1.25-2.58-.03-.01-2.4-.92-2.42-3.67zM14.1 5.86c.63-.77 1.06-1.83.94-2.89-.91.04-2.02.61-2.67 1.37-.58.67-1.1 1.76-.96 2.8 1.02.08 2.06-.52 2.69-1.28z"/></svg>Apple로 로그인</button><p class="apple-error" id="apple-error" hidden></p><script src="/apple-login.js"></script>`
/** What a demo account may call: [method, path]. `S` is one of its sessions, `H` its Mac. */
const DEMO_ALLOW = [
  ['GET', /^\/api\/(me|classic\/stream|options|notices|groups|stats|quality|plugins)$/],
  ['GET', /^\/api\/prefs\/(launch|voice|voice\/hosts|icons|prompt|splits)$/],
  ['POST', /^\/api\/prefs\/(launch|voice|voice\/hosts|icons|prompt|splits)$/],
  ['GET', /^\/api\/img\/[0-9a-f]{40}\.(png|jpg|gif|webp)$/],
  ['POST', /^\/api\/(notices\/dismiss|groups|focus|sessions|account\/delete)$/],
  ['GET', /^\/api\/sessions\/S\/(events|links|skills|screen)$/],
  ['POST', /^\/api\/sessions\/S\/(say|send|do|answer|esc|sendnow|dropheld|retract|settings|setting|close|resume|report|refresh|btw|screen|voice|fork)$/],
  ['DELETE', /^\/api\/sessions\/S$/],
  ['GET', /^\/api\/hosts\/H\/(status|dirs|logs)$/],
  ['POST', /^\/api\/hosts\/H\/check$/],
]
/** Bodies a demo request may carry: a recording for the voice screen, small JSON for the rest. */
const demoBodyMax = (shape) => (/\/voice$/.test(shape) ? DEMO_VOICE_BYTES : DEMO_BODY_BYTES)
/** ip -> when it opened demos (the last hour); uid -> when it sent (the last minute). */
const demoMade = new Map()
const demoSent = new Map()
function demoTooMany(ip) {
  const now = Date.now()
  const a = (demoMade.get(ip) ?? []).filter((t) => now - t < 3_600_000)
  if (a.length >= DEMO_PER_IP_HOUR) return (demoMade.set(ip, a), true)
  demoMade.set(ip, [...a, now])
  return false
}
const demoRefuse = (text = DEMO_REFUSED) => {
  throw new Refuse(403, text)
}
/**
 * Lets a request of the demo account `uid` through, or refuses it with 403 (REQ-S-068). A session or Mac named in
 * the path or the body that is not its own is refused here, before any route looks it up. A body is read here and
 * handed on to the route as it was.
 */
async function demoGate(req, url, uid) {
  const p = url.pathname
  const sid = /^\/api\/sessions\/([^/]+)/.exec(p)?.[1]
  const hid = /^\/api\/hosts\/([^/]+)/.exec(p)?.[1]
  if (sid && sessions.get(sid)?.uid !== uid) demoRefuse()
  if (hid && hosts[hid]?.uid !== uid) demoRefuse()
  const shape = p.replace(/^(\/api\/sessions\/)[^/]+/, '$1S').replace(/^(\/api\/hosts\/)[^/]+/, '$1H')
  if (!DEMO_ALLOW.some(([m, re]) => m === req.method && re.test(shape))) demoRefuse()
  if (req.method === 'GET') return
  const raw = await rawBody(req, demoBodyMax(shape))
  let b = {}
  try {
    b = JSON.parse(raw || '{}') ?? {}
  } catch {}
  for (const k of ['hostId', 'host']) if (b[k] != null && b[k] !== '' && hosts[b[k]]?.uid !== uid) demoRefuse()
  for (const k of ['sid', 'session']) if (b[k] != null && b[k] !== '' && sessions.get(b[k])?.uid !== uid) demoRefuse()
  if ((Array.isArray(b.images) && b.images.length) || (Array.isArray(b.videos) && b.videos.length)) demoRefuse('데모에서는 그림이나 영상을 보낼 수 없어요')
  // Root on the Mac (REQ-F-764), however it is asked for.
  if (/^\s*[:/](sudo|root)\b/i.test(String(b.text ?? '')) || /^(sudo|root)$/i.test(String(b.cmd ?? ''))) demoRefuse()
  // A public demo is not a place to send much.
  for (const k of ['text', 'prompt', 'title', 'name']) if (String(b[k] ?? '').length > DEMO_TEXT_MAX) throw new Refuse(413, `데모에서는 글을 ${DEMO_TEXT_MAX.toLocaleString()}자까지 보낼 수 있어요`)
  if (shape === '/api/sessions' || /^\/api\/sessions\/S\/(say|send|btw|voice|fork|resume)$/.test(shape)) {
    const now = Date.now()
    const a = (demoSent.get(uid) ?? []).filter((t) => now - t < 60_000)
    if (a.length >= DEMO_SENDS_PER_MIN) throw new Refuse(429, `데모에서는 1분에 ${DEMO_SENDS_PER_MIN}번까지 보낼 수 있어요. 잠시 뒤에 다시 해 주세요`)
    demoSent.set(uid, [...a, now])
  }
  if ((shape === '/api/sessions' || shape === '/api/sessions/S/fork') && [...sessions.values()].filter((m) => m.uid === uid).length >= DEMO_SESSIONS_MAX) demoRefuse(`데모에서는 세션을 ${DEMO_SESSIONS_MAX}개까지 만들 수 있어요. 안 쓰는 세션을 지운 뒤 다시 해 주세요`)
  req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(raw)
  }
}

/** uid -> { mac, hostId, at }: the demo accounts there are now, in memory only. */
const demoAccounts = new Map()
/** Everything of a demo account goes: its sessions, files, groups, settings, notices, pictures, Mac. */
function demoForget(uid) {
  demoAccounts.get(uid)?.mac.stop()
  for (const meta of [...sessions.values()]) {
    if (meta.uid !== uid) continue
    clearTimeout(reminders.get(meta.id))
    reminders.delete(meta.id)
    eventCache.delete(eventsFile(meta))
    tails.delete(meta.id)
    sessions.delete(meta.id)
    dirty.delete(meta.id)
  }
  fs.rmSync(userDir(uid), { recursive: true, force: true })
  for (const m of [prefsCache, noticeCache, imgInfoCache, pluginCache, prSearches, lookingAt, viewing]) m.delete(uid)
  for (const k of [...statsCache.keys()]) if (k.startsWith(`${uid}|`)) statsCache.delete(k)
  const hostId = demoHostOf(uid)
  bridges.delete(hostId)
  liveStatus.delete(hostId)
  delete hosts[hostId]
  delete users[uid]
  demoAccounts.delete(uid)
}
/**
 * 계정 삭제 (REQ-F-770): everything the server keeps about one account goes, and every sign-in and connection of it
 * ends at once (its Macs' bridge tabs carry the same sign-in, so they cannot come back either). What is on the Macs
 * (claude, its conversations, the folders) is not touched. Kept on purpose: the login-pins entry (name -> GitHub id),
 * so another GitHub account cannot take the name the allow-list knows (R1-L1) while the same person can sign up again.
 */
async function deleteAccount(uid) {
  const login = users[uid]?.login ?? ''
  const hostIds = Object.entries(hosts).filter(([, h]) => h.uid === uid).map(([id]) => id)
  for (const [k, v] of Object.entries(logins)) if (v.uid === uid) delete logins[k]
  for (const res of controls.get(uid) ?? []) res.end()
  controls.delete(uid)
  for (const id of hostIds) {
    bridges.get(id)?.end()
    bridges.delete(id)
    liveStatus.delete(id)
    sudoHosts.delete(id)
    delete hosts[id]
  }
  for (const meta of [...sessions.values()]) {
    if (meta.uid !== uid) continue
    clearTimeout(reminders.get(meta.id))
    reminders.delete(meta.id)
    eventCache.delete(eventsFile(meta))
    tails.delete(meta.id)
    forkSkip.delete(meta.id)
    sessions.delete(meta.id)
    dirty.delete(meta.id)
  }
  clearTimeout(stateTimers.get(uid))
  stateTimers.delete(uid)
  await plug.stopUser(uid)
  await revokeApple(uid)
  // Sessions, transcripts, events, pictures, videos, settings, notices, push subscriptions, plugins, host logs.
  fs.rmSync(userDir(uid), { recursive: true, force: true })
  for (const m of [prefsCache, noticeCache, imgInfoCache, pluginCache, prSearches, lookingAt, viewing]) m.delete(uid)
  for (const k of [...statsCache.keys()]) if (k.startsWith(`${uid}|`)) statsCache.delete(k)
  for (const [k, v] of qrCodes) if (v.uid === uid) qrCodes.delete(k)
  for (const [k, v] of unlocks) if (v.uid === uid) unlocks.delete(k)
  // Reports stay their 90 days, as the report screen says before sending (REQ-S-072); sweepRetention takes them.
  if (reportAuto.uid === uid) {
    Object.assign(reportAuto, { on: false, uid: null, by: null, since: null, hostId: null })
    writeJson(REPORT_AUTO_FILE, reportAuto)
  }
  if (login) delete access[login.toLowerCase()]
  delete users[uid]
  touchGlobals()
  flushToDisk()
  log(`account deleted: ${uid} (${hostIds.length} host(s))`)
}

/**
 * An Apple account's refresh token is revoked when it is deleted (App Store guideline 5.1.1(v)): the app then no
 * longer appears under the person's Apple ID. Skipped, and said in the log, without the key or a token.
 */
async function revokeApple(uid) {
  if (!users[uid]?.apple) return
  const refresh = readJson(path.join(userDir(uid), 'apple.json'), null)?.refresh
  if (!apple || !refresh) return log(`account deleted: ${uid}: Apple 토큰 취소 건너뜀 (${apple ? '토큰 없음' : 'APPLE_PRIVATE_KEY 없음'})`)
  try {
    log(`account deleted: ${uid}: Apple 토큰 취소 ${(await apple.revoke(refresh)) ? '됨' : '실패'}`)
  } catch (e) {
    log(`account deleted: ${uid}: Apple 토큰 취소 실패: ${e.message}`)
  }
}

/** A demo account from the seed (REQ-F-766 rule 5): its Mac connected, three sessions, a group. */
function demoOpen(uid) {
  if (demoAccounts.has(uid)) demoForget(uid)
  if (demoAccounts.size >= DEMO_MAX) {
    // Room only from a demo nobody has used lately: a visitor cannot clear one somebody is looking at.
    const idle = [...demoAccounts].filter(([, a]) => Date.now() - a.at >= DEMO_EVICT_IDLE_MS).sort((a, b) => a[1].at - b[1].at)
    if (!idle.length) return null
    demoForget(idle[0][0])
  }
  const hostId = demoHostOf(uid)
  users[uid] = { login: DEMO_LOGIN_NAME, name: DEMO_LOGIN_NAME, avatar: '' }
  hosts[hostId] = { uid, name: '데모 맥', home: '/Users/demo', lastSeen: Date.now(), conn: crypto.randomBytes(12).toString('hex') }
  const mac = createDemoMac({ build: AGENT_BUILD, up: (msgs) => fromBridge(uid, hostId, msgs), log })
  demoAccounts.set(uid, { mac, hostId, at: Date.now() })
  bridges.set(hostId, mac.res)
  Object.assign(live(hostId), { connectedAt: Date.now(), connects: 1 })
  // The groups name the seed's sessions, so they are set before the Mac lists them.
  const ids = mac.reset()
  prefsCache.set(uid, demoPrefs(ids))
  savePrefs(uid)
  return demoAccounts.get(uid)
}
/** A signed-in demo account, made again from the seed when it is not there (a restart, or cleared for room). */
function demoTouch(uid) {
  const a = demoAccounts.get(uid) ?? demoOpen(uid)
  if (!a) return null
  a.at = Date.now()
  return uid
}
// Demos unused for DEMO_IDLE_MS go, and the counts of addresses and accounts that have gone quiet.
setInterval(() => {
  const now = Date.now()
  for (const [uid, a] of [...demoAccounts]) if (now - a.at >= DEMO_IDLE_MS) demoForget(uid)
  for (const [k, v] of demoMade) if (!v.some((t) => now - t < 3_600_000)) demoMade.delete(k)
  for (const [k, v] of demoSent) if (!v.some((t) => now - t < 60_000)) demoSent.delete(k)
}, DEMO_SWEEP_MS).unref?.()
/** A new demo sign-in's token: the oldest demo ones go when there are too many. */
function demoTrimLogins() {
  const mine = Object.entries(logins).filter(([, v]) => isDemoUid(v.uid)).sort((a, b) => a[1].exp - b[1].exp)
  for (const [k] of mine.slice(0, Math.max(0, mine.length - DEMO_LOGINS_MAX))) delete logins[k]
}
// What an earlier run left (and the single `demo` account of 1.212) goes at every start; accounts come back on use.
for (const meta of [...sessions.values()]) if (isDemoUid(meta.uid) || meta.uid === 'demo') sessions.delete(meta.id)
for (const uid of fs.existsSync(path.join(DATA, 'u')) ? fs.readdirSync(path.join(DATA, 'u')) : []) if (isDemoUid(uid) || uid === 'demo') fs.rmSync(userDir(uid), { recursive: true, force: true })
for (const id of Object.keys(hosts)) if (isDemoHost(id) || hosts[id].uid === 'demo') delete hosts[id]
for (const uid of Object.keys(users)) if (isDemoUid(uid) || uid === 'demo') delete users[uid]
if (demoOn) log('공개 데모 켜짐: 데모로 둘러보기(BRIDGE_DEMO=1)')
// The server-wide skills repo of 1.294 goes to the person whose GitHub login owns it (REQ-F-792), unless they set
// one of their own already; the file is then renamed so this happens once. With no such person it stays for later.
{
  const old = readJson(SKILLS_FILE, null)?.repo
  if (typeof old === 'string' && SKILLS_REPO_RE.test(old)) {
    const owner = old.split('/')[0].toLowerCase()
    const uid = Object.keys(users).find((u) => githubLoginOf(u)?.toLowerCase() === owner)
    if (uid) {
      if (!prefsOf(uid).skillsRepo) (prefsOf(uid).skillsRepo = old), writeJson(prefsFile(uid), prefsOf(uid))
      fs.renameSync(SKILLS_FILE, `${SKILLS_FILE}.migrated`)
      log(`skills: 서버 하나의 스킬 저장소를 ${users[uid].login} 의 설정으로 옮김`)
    }
  }
}


const server = http.createServer(async (req, res) => {
  try {
    // While a newer server takes over, a request waits and is then answered by it. Nothing is refused.
    if (await handover.intercept(req, res)) return
    if (preview.is(req)) return await preview.handle(req, res)
    // Just after taking over, the Macs that were connected are still reconnecting (a fraction of a second).
    // What would be told "기기가 연결돼 있지 않습니다" in that moment waits for them instead.
    // Held in a local: several requests wait here at once, and the first one through clears `settling`.
    const wait = settling
    if (wait && req.url.startsWith('/api/') && !/^\/api\/(bridge|auth|health)/.test(req.url)) {
      while (Date.now() < wait.until && wait.hosts.some((h) => !bridges.has(h))) await new Promise((r) => setTimeout(r, 40))
      if (settling === wait) settling = null
    }
    const url = new URL(req.url, 'http://x')
    const p = url.pathname
    // Open to anyone, for deploy checks and the handover: only what says a server is up and which one (REQ-S-079).
    // How it runs (BRIDGE_ORIGIN given, root, agent signed) is for the operator, in /api/admin/overview.
    if (p === '/api/health') return json(res, 200, { ok: true, version: VERSION, instance: handover.id })
    migrateLegacyCb(req, res)
    if (p.startsWith('/api/auth/')) return await auth(req, res, url)
    if (p.startsWith('/api/')) {
      // Changes must come from this site's own pages as JSON: a form on another site can do neither.
      // One exception: the Slack link page's own form (R1-M2), which must then say it comes from this site.
      const form = req.method === 'POST' && p === '/api/plugins/slack/link'
      // And a video sent as it is (REQ-F-761): from this site's page only, as a video type no form can send.
      const upload = req.method === 'POST' && (/^\/api\/sessions\/[\w-]+\/upload$/.test(p) || p === '/api/reports/upload')
      if (req.method !== 'GET') {
        if ((req.headers.origin || form || upload) && req.headers.origin !== originOf(req)) throw new Refuse(403, '다른 출처의 요청입니다')
        if (upload && !VIDEO_TYPES.includes(String(req.headers['content-type']).split(';')[0].trim())) throw new Refuse(415, '지원하지 않는 영상 형식이에요')
        if (req.method === 'POST' && !upload && !String(req.headers['content-type']).startsWith(form ? 'application/x-www-form-urlencoded' : 'application/json')) throw new Refuse(415, 'application/json 만 받습니다')
      }
      const uid = whoami(req)
      if (!uid) throw new Refuse(401, '로그인이 필요합니다')
      if (isDemoUid(uid)) await demoGate(req, url, uid)
      return await api(req, res, url, uid)
    }
    if (req.method !== 'GET') return res.writeHead(405).end()
    if (p === '/' && !whoami(req)) return res.writeHead(200, { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${APP_NAME}</title><script src="/old-hash.js"></script><script src="/theme.js"></script><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/login.css"><body class="bridge-login"><div class="panel"><h1>${APP_NAME}</h1><p class="muted">맥에서 도는 Claude 세션을 옮기고, 어디서든 이어서 조작합니다.</p>${inApp(req) ? `<div class="sign-pair">${APPLE_BUTTON}<a class="btn primary" href="/api/auth/github">GitHub 로 로그인</a></div>` : '<a class="btn primary" href="/api/auth/github">GitHub 로 로그인</a>'}${demoOn ? DEMO_BUTTON : ''}<p class="muted" style="margin:16px 0 0">처음이세요? <a href="/guide">시작 가이드</a></p>${FOOTER}</div></body></html>`)
    if (p === '/') return fs.existsSync(path.join(UI, 'index.html')) ? sendUi(res) : res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('화면이 빌드되지 않았어요 (cd ui && corepack yarn build)\n')
    // The page's other addresses (/s/<id>, /settings, …) are the same page. Signed out, the guide is the page that
    // says what this is (web/start.html); any other comes back to where it was after signing in.
    if (APP_PATH.test(p)) {
      if (whoami(req)) return fs.existsSync(path.join(UI, 'index.html')) ? sendUi(res) : res.writeHead(302, { Location: '/' }).end()
      if (p.startsWith('/guide')) return sendFile(res, path.join(ROOT, 'web/start.html'))
      return res.writeHead(302, { Location: GITHUB_CLIENT_ID ? `/api/auth/github?next=${encodeURIComponent(safeNext(p + url.search))}` : '/' }).end()
    }
    // The old control pages' addresses, still in bookmarks: the page they lead to now.
    if (p === '/cs' || p === '/classic') return res.writeHead(302, { Location: '/' }).end()
    // The page's own built files: names carry their content hash, so they never change and are kept a year.
    const asset = /^\/assets\/([\w.-]+\.(?:js|css|svg|png|woff2))$/.exec(p)
    if (asset) return sendFile(res, path.join(UI, 'assets', asset[1]), 'public, max-age=31536000, immutable')
    if (p === '/prepaint.js') return sendFile(res, path.join(UI, 'prepaint.js'))
    if (p === '/bridge') return sendFile(res, path.join(ROOT, 'web/bridge.html'))
    // What /skills is serving, for checking a deploy: a hash of this server's /skills code (scripts/skills-code-hash.mjs
    // computes the same hash for any git ref), open to anyone. Which repo, its commit and how many skills only to the
    // person signed in, and only their own (REQ-F-792).
    if (p === '/skills/version') {
      const who = whoami(req)
      const skills = who ? skillsFor(skillsRepoOf(who)) : null
      if (!skills) return json(res, 200, { code: SKILLS_CODE })
      const c = await skills.current()
      return json(res, 200, { code: SKILLS_CODE, repo: c.repo, sha: c.sha, date: c.date, skills: c.skills.length, check: c.check, auth: skills.auth })
    }
    // ?repo=owner/repo&t=<signature>: the install command /api/skills gave (REQ-S-078). Without a right signature,
    // or for a repo nobody here uses any more, 404, so nobody can probe which repos (and users) this server has.
    if (p === '/skills/install.sh') {
      const want = (url.searchParams.get('repo') ?? '').trim().toLowerCase()
      const repo = want && skillsInstallOk(want, url.searchParams.get('t') ?? '') && [SKILLS_REPO_ENV, ...Object.keys(users).map((u) => prefsOf(u).skillsRepo)].find((r) => typeof r === 'string' && r && r.toLowerCase() === want)
      if (!repo) return res.writeHead(404).end('not found\n')
      if (!(SKILLS_APP || SKILLS_TOKEN)) return res.writeHead(503).end('skills not configured\n')
      const skills = skillsFor(repo)
      const c = await skills.current()
      return res.writeHead(200, { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-cache' }).end(c.install)
    }
    if (p === '/guide/mcp') {
      if (!whoami(req)) return res.writeHead(302, { Location: GITHUB_CLIENT_ID ? `/api/auth/github?next=${encodeURIComponent(p)}` : '/' }).end()
      const html = fs.readFileSync(path.join(ROOT, 'web/guide-mcp.html'), 'utf8').replaceAll('__DOKPLOY_URL__', GUIDE_DOKPLOY_URL.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`))
      return res.writeHead(200, { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }).end(html)
    }
    if (p === '/skills' || /^\/skills\/[a-z0-9-]+$/.test(p)) {
      if (!whoami(req)) return res.writeHead(302, { Location: GITHUB_CLIENT_ID ? `/api/auth/github?next=${encodeURIComponent(p)}` : '/' }).end()
      return sendFile(res, path.join(ROOT, 'web/skills.html'))
    }
    const af = /^\/agent\/([a-z]+\.mjs)$/.exec(p)
    if (p === '/agent.mjs' || (af && AGENT_FILES.includes(af[1]))) return sendFile(res, path.join(ROOT, 'agent', af ? af[1] : 'agent.mjs'))
    if (p === '/install.sh') {
      const script = fs.readFileSync(path.join(ROOT, 'agent/install.sh'), 'utf8').replaceAll('__ORIGIN__', originOf(req)).replaceAll('__FILES__', AGENT_FILES.join(' '))
      return res.writeHead(200, { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-cache' }).end(script)
    }
    // 개인정보 처리방침 (REQ-F-767): readable signed out, by anyone, including the App Store reviewer.
    if (p === '/privacy') return sendFile(res, path.join(ROOT, 'web/privacy.html'))
    // 지원 (REQ-F-783): the App Store support URL, readable signed out.
    if (p === '/support') return res.writeHead(200, { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }).end(supportPage())
    if (p === '/recovery') return res.writeHead(200, { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }).end(RECOVERY.replaceAll('__ORIGIN__', originOf(req)))
    // Browsers ask for /favicon.ico on pages without an icon link; answered with the icon instead of a 404 (a
    // console error on every such page).
    if (p === '/favicon.ico') return sendFile(res, path.join(ROOT, 'web/icon.svg'))
    if (p === '/manifest.webmanifest') return res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' }).end(JSON.stringify({ name: APP_NAME, short_name: APP_NAME, start_url: '/', display: 'standalone', background_color: '#262624', theme_color: '#1f1e1d', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] }))
    if (/^\/[a-z-]+\.(js|css|svg)$/.test(p)) return sendFile(res, path.join(ROOT, 'web', p))
    res.writeHead(404).end('not found')
  } catch (e) {
    // The path without its query: a query can carry a token or what was searched for (REQ-S-074).
    if (!(e instanceof Refuse)) log('error', req.method, String(req.url).split('?')[0], e)
    if (res.headersSent) return res.end()
    json(res, e instanceof Refuse ? e.status : 500, { ok: false, error: e instanceof Refuse ? e.message : '서버 오류', ...(e.extra ?? {}) })
  }
})

/** After a takeover: the Macs the old server had connected, and how long to wait for them to come back. */
let settling = handover.carried()?.online?.length ? { hosts: handover.carried().online.filter((h) => hosts[h]), until: Date.now() + 6000 } : null

/** Every open stream ends with a short retry hint, so its page reconnects at once (and lands on the new server). */
function cutStreams() {
  const all = [...bridges.values(), ...[...controls.values()].flatMap((s) => [...s])]
  for (const res of all) {
    try {
      res.end('retry: 300\n\n')
    } catch {}
  }
}

// A local preview's WebSockets (a dev server's HMR). Nothing else on this server takes an upgrade.
server.on('upgrade', (req, socket, head) => {
  if (preview.is(req) && handover.state() === 'running') return void preview.upgrade(req, socket, head).catch(() => socket.destroy())
  socket.destroy()
})

server.listen(PORT, () => {
  handover.serve({
    port: PORT,
    // Giving the state to a newer server: let commands in flight finish (briefly), stop what talks to the outside,
    // write everything, and write nothing after that.
    async drain() {
      for (let i = 0; i < 30 && pending.size; i++) await new Promise((r) => setTimeout(r, 100))
      await plug.stopAll()
      flushToDisk()
      frozen = true
      return { online: realBridges() }
    },
    async resume() {
      frozen = false
      await plug.startAll(Object.keys(users)).catch((e) => log('plugins', e))
    },
    cut: cutStreams,
  })
  plug.startAll(Object.keys(users)).catch((e) => log('plugins', e))
  log(`claude-bridge ${VERSION} on :${PORT}, data ${DATA}, allowed logins: ${ALLOWED.join(', ') || '(none)'}, admins: ${ADMINS.join(', ') || '(none)'}`)
  if (DEV_LOGIN) log('WARNING: BRIDGE_DEV_LOGIN=1 — anyone who can reach this server can sign in without GitHub')
})
