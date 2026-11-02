// Several Claude accounts on one Mac. Claude Code keeps one login per config folder (CLAUDE_CONFIG_DIR): the
// keychain item is named after the folder ("Claude Code-credentials-<sha256 of it, 8 letters>"), and the
// conversations go under its projects/. So an account here is a folder of its own. What the person set up once
// (settings, CLAUDE.md, skills, commands, agents, plugins) is linked from the main folder, and the global config
// (.claude.json, which holds the MCP servers and the "seen the welcome screens" marks) is copied without what
// belongs to the account. A new folder without those marks starts with the theme picker, where a session would stop.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** Linked from the main config folder into each added account's: the same for every account. */
export const SHARED = ['settings.json', 'settings.local.json', 'CLAUDE.md', 'skills', 'commands', 'agents', 'plugins', 'output-styles', 'hooks']

/** Keys of .claude.json that belong to the signed-in account, or are caches of what it may use: never copied. */
const ACCOUNT_KEY = /^(oauthAccount|userID|anonymousId|hasAvailableSubscription|subscriptionNoticeCount|penguinModeOrgEnabled|claudeAiMcpEverConnected|projects)$|[cC]ache|^passes|^overage/
/** What is kept of each folder's entry in .claude.json: the trust, the allowed tools and its MCP choices. */
const PROJECT_KEYS = new Set(['allowedTools', 'hasTrustDialogAccepted', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'mcpServers', 'hasClaudeMdExternalIncludesApproved', 'hasClaudeMdExternalIncludesWarningShown'])

/** The main account's .claude.json without what belongs to the account (see ACCOUNT_KEY). */
export function sharedConfig(src) {
  const out = Object.fromEntries(Object.entries(src ?? {}).filter(([k]) => !ACCOUNT_KEY.test(k)))
  out.projects = Object.fromEntries(Object.entries(src?.projects ?? {}).map(([p, o]) => [p, Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => PROJECT_KEYS.has(k)))]))
  return out
}

/**
 * An account's .claude.json brought up to date with the main one: its MCP servers and each folder's trust and MCP
 * choices are the main account's; everything else in it (its own sign-in, its caches, its marks) stays.
 */
export function mergedConfig(own, main) {
  const shared = sharedConfig(main)
  const projects = { ...(own?.projects ?? {}) }
  for (const [p, o] of Object.entries(shared.projects)) projects[p] = { ...(projects[p] ?? {}), ...o }
  return { ...shared, ...(own ?? {}), mcpServers: shared.mcpServers ?? {}, projects }
}

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
const writeJsonFile = (p, v) => {
  const tmp = `${p}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, p)
}

/**
 * Makes `dir` a config folder for an added account, or fills in what is missing in one: links to the main
 * folder's shared items that exist and are not there yet, and a .claude.json when there is none. Never replaces
 * a file that is there. Returns the names it linked.
 */
export function prepareAccountDir(dir, { mainDir, mainConfig }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const linked = []
  for (const name of SHARED) {
    const from = path.join(mainDir, name)
    const to = path.join(dir, name)
    if (!fs.existsSync(from)) continue
    try {
      fs.lstatSync(to)
      continue
    } catch {}
    fs.symlinkSync(from, to)
    linked.push(name)
  }
  const own = path.join(dir, '.claude.json')
  if (!fs.existsSync(own)) writeJsonFile(own, sharedConfig(readJson(mainConfig) ?? {}))
  return linked
}

/** Copies the main account's MCP servers and folder trust into an account's .claude.json (공유 설정 다시 맞추기). */
export function syncAccountConfig(dir, mainConfig) {
  const own = path.join(dir, '.claude.json')
  writeJsonFile(own, mergedConfig(readJson(own) ?? {}, readJson(mainConfig) ?? {}))
}

/**
 * The keychain item Claude Code keeps a config folder's sign-in in. The folder is the CLAUDE_CONFIG_DIR string as it
 * is (NFC, never resolved): a link to the same folder, or a trailing `/`, is another sign-in.
 */
export function keychainService(dir, env = process.env) {
  // As claude does: CLAUDE_SECURESTORAGE_CONFIG_DIR, when set, names the item instead (empty: the main one's).
  const over = env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  const key = over !== undefined ? over.normalize('NFC') : String(dir).normalize('NFC')
  return over === '' ? 'Claude Code-credentials' : `Claude Code-credentials-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 8)}`
}

/** A path a person typed for a folder to link: `~` expanded, NFC, no trailing `/`. Null when it cannot be one. */
export function linkPath(typed, home) {
  let p = String(typed ?? '').trim().normalize('NFC')
  if (!p || p.length > 1024 || p.includes('\0')) return null
  if (p === '~' || p.startsWith('~/')) p = path.join(home, p.slice(1))
  if (!path.isAbsolute(p)) return null
  p = p.replace(/\/+$/, '')
  return p || null
}

const isIn = (p, root) => p === root || p.startsWith(`${root}${path.sep}`)
/**
 * The real path, with the case the disk has: APFS does not mind case, and fs.realpathSync keeps the case it was
 * given (`~/.CLAUDE` would pass for another folder than `~/.claude`). The native one asks the disk.
 */
export const realNative = (p) => {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return p
  }
}
const realOrSelf = realNative

/**
 * Why a folder cannot be linked as an account (another tool's Claude Code config folder), or null. `p` is linkPath's.
 * It must be a folder of this user's with a .claude.json (bridge never writes one there), and not the main folder,
 * an account folder already, the agent's own folder, the home folder or a folder above any of those.
 */
export function linkDirWhy(p, { home, mainDir, stateDir, accountDirs = [], uid = process.getuid?.() }) {
  if (!p) return '폴더 경로를 절대 경로나 ~ 로 시작하게 적어 주세요'
  let st
  try {
    st = fs.statSync(p)
  } catch {
    return `그 폴더가 없어요: ${p}`
  }
  if (!st.isDirectory()) return '폴더가 아니에요'
  if (uid !== undefined && st.uid !== uid) return '이 맥 사용자의 폴더가 아니에요'
  const real = realOrSelf(p)
  const guarded = [mainDir, stateDir, home].map(realOrSelf)
  if (real === realOrSelf(mainDir)) return '기본 계정의 설정 폴더예요. 따로 연결하지 않아도 기본 계정으로 보여요'
  if (isIn(real, realOrSelf(mainDir))) return '기본 계정의 설정 폴더 안이에요'
  if (isIn(real, realOrSelf(stateDir))) return 'bridge 에이전트 폴더 안이에요. 새 계정은 "계정 추가" 로 만들어 주세요'
  if (guarded.some((g) => isIn(g, real))) return '홈 폴더나 기본 설정 폴더를 품은 폴더는 연결하지 않아요'
  for (const d of accountDirs.map(realOrSelf)) if (isIn(real, d) || isIn(d, real)) return '이미 이 맥의 다른 계정이 쓰는 폴더예요'
  let cfg
  try {
    cfg = fs.lstatSync(path.join(p, '.claude.json'))
  } catch {}
  if (!cfg?.isFile()) return '그 폴더에 .claude.json 이 없어요. 그 폴더로 claude 를 한 번 띄워 처음 설정을 마친 뒤 연결해 주세요'
  return null
}

/**
 * The ways a person or a tool may have written a folder's path, each a different keychain item (keychainService):
 * as typed, with a trailing `/`, and its real path. The one the keychain has an item for is the one in use.
 */
export const linkCandidates = (p) => [...new Set([p, `${p}/`, realNative(p), `${realNative(p)}/`])]

/**
 * A linked folder's sign-in, read without running claude (`claude auth status` writes migrations, a lock and
 * backups into the folder): whether the keychain item (or the credentials file) is there, and the address the
 * folder's .claude.json names. `hasItem(service)` asks the keychain.
 */
export async function linkedAuth(dir, hasItem) {
  let email = null
  try {
    const a = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'))?.oauthAccount
    if (typeof a?.emailAddress === 'string') email = a.emailAddress.slice(0, 200)
  } catch {}
  const file = fs.existsSync(path.join(dir, '.credentials.json'))
  const item = file || (await hasItem(keychainService(dir)))
  return { loggedIn: !!item, method: file ? '로그인 파일' : item ? '키체인 로그인' : null, email: item ? email : null, plan: null, org: null }
}

/**
 * What in a linked folder's settings changes a bridge session: said to the person when the folder is linked.
 * bridge's hooks come in by --settings, so a folder that turns every hook off leaves the page without a session's state.
 */
export function linkedSettingsNotes(dir) {
  let st = null
  try {
    st = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
  } catch {}
  const notes = []
  if (st?.disableAllHooks === true) notes.push('그 폴더 설정이 훅을 모두 끄고 있어(disableAllHooks) 세션 상태가 화면에 늦게 보일 수 있어요')
  if (st?.permissions?.defaultMode === 'bypassPermissions') notes.push('그 폴더 설정이 권한 확인을 건너뛰어요(bypassPermissions)')
  if (st?.apiKeyHelper) notes.push('그 폴더 설정이 apiKeyHelper 로 로그인해요')
  return notes
}

/** An id for a new account: short, safe in a path and in a tmux name. */
export const newAccountId = () => `a${crypto.randomBytes(4).toString('hex')}`
export const safeAccountId = (id) => id === '' || (typeof id === 'string' && /^a[0-9a-f]{8}$/.test(id))
/** A name a person gave an account, cleaned: one line, at most 40 characters. */
export const accountName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)

/** The sign-in address `claude auth login` prints (its lines joined), or null. */
export const loginUrlOf = (screen) => /https:\/\/\S+\/oauth\/authorize\?\S+/.exec(String(screen))?.[0] ?? null
/** What a person pastes back from the sign-in page: the code, often with `#state` after it. Nothing else. */
export const safeLoginCode = (code) => typeof code === 'string' && /^[A-Za-z0-9_\-#.~]{8,512}$/.test(code.trim())

/** What `claude auth status --json` says, kept to what the page shows. */
export function authOf(out) {
  let j = null
  try {
    j = JSON.parse(out)
  } catch {}
  if (!j || typeof j !== 'object') return { loggedIn: null }
  const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null)
  return { loggedIn: j.loggedIn === true, method: text(j.authMethod, 40), email: text(j.email, 200), plan: text(j.subscriptionType, 40), org: text(j.orgName, 100) }
}

/**
 * A session's Claude Code state that is kept outside its transcript and named by the conversation id: the copies
 * of edited files a rewind restores (file-history/<conv>). Copied when the session moves to another account on
 * the same Mac; the transcript itself is written from the server's copy, as for any move.
 */
export function copySessionState(conv, fromDir, toDir, { keep = false } = {}) {
  const copied = []
  for (const sub of ['file-history']) {
    const from = path.join(fromDir, sub, conv)
    if (!fs.existsSync(from)) continue
    fs.mkdirSync(path.join(toDir, sub), { recursive: true })
    // keep: into a linked folder, what is there already is the other tool's and is not replaced.
    fs.cpSync(from, path.join(toDir, sub, conv), { recursive: true, force: !keep })
    copied.push(sub)
  }
  return copied
}
