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
export function copySessionState(conv, fromDir, toDir) {
  const copied = []
  for (const sub of ['file-history']) {
    const from = path.join(fromDir, sub, conv)
    if (!fs.existsSync(from)) continue
    fs.mkdirSync(path.join(toDir, sub), { recursive: true })
    fs.cpSync(from, path.join(toDir, sub, conv), { recursive: true, force: true })
    copied.push(sub)
  }
  return copied
}
