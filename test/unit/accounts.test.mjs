import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sharedConfig, mergedConfig, prepareAccountDir, syncAccountConfig, copySessionState, safeAccountId, newAccountId, accountName, loginUrlOf, safeLoginCode, authOf, SHARED, keychainService, linkPath, linkDirWhy, linkCandidates, linkedAuth, linkedSettingsNotes } from '../../agent/accounts.mjs'
import crypto from 'node:crypto'

const MAIN = {
  oauthAccount: { emailAddress: 'a@b.c' },
  userID: 'u',
  anonymousId: 'x',
  hasCompletedOnboarding: true,
  lastOnboardingVersion: '2.1.0',
  cachedGrowthBookFeatures: { a: 1 },
  modelAccessCache: {},
  passesEligibilityCache: {},
  overageCreditGrantCache: {},
  mcpServers: { ctx: { command: 'npx' } },
  projects: { '/w': { hasTrustDialogAccepted: true, allowedTools: ['Bash'], lastCost: 3, lastSessionId: 's' } },
}

test('sharedConfig leaves out the account and its caches, keeps the welcome marks and MCP servers', () => {
  const c = sharedConfig(MAIN)
  for (const k of ['oauthAccount', 'userID', 'anonymousId', 'cachedGrowthBookFeatures', 'modelAccessCache', 'passesEligibilityCache', 'overageCreditGrantCache']) assert.equal(k in c, false, k)
  assert.equal(c.hasCompletedOnboarding, true)
  assert.equal(c.lastOnboardingVersion, '2.1.0')
  assert.deepEqual(c.mcpServers, MAIN.mcpServers)
  // A folder keeps its trust and allowed tools, not what the last session there cost.
  assert.deepEqual(c.projects, { '/w': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] } })
})

test('mergedConfig takes the main MCP servers and trust, keeps the account its own', () => {
  const own = { oauthAccount: { emailAddress: 'other@x' }, mcpServers: { old: {} }, numStartups: 9, projects: { '/w': { lastCost: 1 }, '/mine': { hasTrustDialogAccepted: true } } }
  const m = mergedConfig(own, MAIN)
  assert.deepEqual(m.oauthAccount, own.oauthAccount)
  assert.equal(m.numStartups, 9)
  assert.deepEqual(m.mcpServers, MAIN.mcpServers)
  assert.deepEqual(m.projects['/w'], { lastCost: 1, hasTrustDialogAccepted: true, allowedTools: ['Bash'] })
  assert.deepEqual(m.projects['/mine'], { hasTrustDialogAccepted: true })
})

test('prepareAccountDir links what is shared and writes a config once, never replacing a file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-acc-'))
  const main = path.join(root, 'main')
  fs.mkdirSync(path.join(main, 'skills'), { recursive: true })
  fs.writeFileSync(path.join(main, 'settings.json'), '{}')
  fs.writeFileSync(path.join(root, 'main.json'), JSON.stringify(MAIN))
  const dir = path.join(root, 'acc')
  assert.deepEqual(prepareAccountDir(dir, { mainDir: main, mainConfig: path.join(root, 'main.json') }).sort(), ['settings.json', 'skills'])
  assert.equal(fs.lstatSync(path.join(dir, 'skills')).isSymbolicLink(), true)
  assert.equal(fs.readlinkSync(path.join(dir, 'settings.json')), path.join(main, 'settings.json'))
  const written = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'))
  assert.equal(written.oauthAccount, undefined)
  assert.equal(written.hasCompletedOnboarding, true)
  // Made later in the main folder: linked the next time. What the account has is left alone.
  fs.mkdirSync(path.join(main, 'commands'))
  fs.writeFileSync(path.join(dir, '.claude.json'), '{"mine":1}')
  assert.deepEqual(prepareAccountDir(dir, { mainDir: main, mainConfig: path.join(root, 'main.json') }), ['commands'])
  assert.equal(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'), '{"mine":1}')
  syncAccountConfig(dir, path.join(root, 'main.json'))
  const synced = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'))
  assert.equal(synced.mine, 1)
  assert.deepEqual(synced.mcpServers, MAIN.mcpServers)
  assert.ok(SHARED.includes('plugins') && !SHARED.includes('projects'))
  fs.rmSync(root, { recursive: true, force: true })
})

test('copySessionState copies the rewind copies of that conversation only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-acc-'))
  const conv = '3e1cd894-74a0-43d3-8524-d9e3a47770fc'
  fs.mkdirSync(path.join(root, 'a', 'file-history', conv), { recursive: true })
  fs.writeFileSync(path.join(root, 'a', 'file-history', conv, 'abc@v1'), 'x')
  fs.mkdirSync(path.join(root, 'a', 'file-history', 'other'), { recursive: true })
  assert.deepEqual(copySessionState(conv, path.join(root, 'a'), path.join(root, 'b')), ['file-history'])
  assert.equal(fs.readFileSync(path.join(root, 'b', 'file-history', conv, 'abc@v1'), 'utf8'), 'x')
  assert.equal(fs.existsSync(path.join(root, 'b', 'file-history', 'other')), false)
  assert.deepEqual(copySessionState('none', path.join(root, 'a'), path.join(root, 'b')), [])
  fs.rmSync(root, { recursive: true, force: true })
})

test('ids, names, codes and the sign-in address', () => {
  assert.equal(safeAccountId(''), true)
  assert.equal(safeAccountId(newAccountId()), true)
  for (const bad of ['../x', 'a1234567', 'aZZZZZZZZ', null, 'main']) assert.equal(safeAccountId(bad), false, String(bad))
  assert.equal(accountName('  회사\n 계정 '), '회사 계정')
  assert.equal(accountName('x'.repeat(60)).length, 40)
  assert.equal(safeLoginCode('AbC_123-xyz#state-9.~'), true)
  for (const bad of ['short', 'has space inside', 'a;rm -rf /x', 'x'.repeat(600), 42]) assert.equal(safeLoginCode(bad), false, String(bad))
  const screen = 'Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=c&state=s\nPaste code here if prompted >'
  assert.equal(loginUrlOf(screen), 'https://claude.com/cai/oauth/authorize?code=true&client_id=c&state=s')
  assert.equal(loginUrlOf('no address'), null)
})

test('authOf keeps what the page shows', () => {
  assert.deepEqual(authOf('{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","subscriptionType":"max","extra":1}'), { loggedIn: true, method: 'claude.ai', email: 'a@b.c', plan: 'max', org: null })
  assert.equal(authOf('{"loggedIn":false,"authMethod":"none"}').loggedIn, false)
  assert.deepEqual(authOf('not json'), { loggedIn: null })
})

test('keychainService is the folder string hashed as it is, so a link or a trailing slash is another sign-in', () => {
  const want = `Claude Code-credentials-${crypto.createHash('sha256').update('/Users/me/.tool/claude').digest('hex').slice(0, 8)}`
  assert.equal(keychainService('/Users/me/.tool/claude', {}), want)
  assert.notEqual(keychainService('/Users/me/.tool/claude/', {}), want)
  // CLAUDE_SECURESTORAGE_CONFIG_DIR names the item as claude does: empty is the main one's.
  assert.equal(keychainService('/Users/me/.tool/claude', { CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }), 'Claude Code-credentials')
  assert.equal(keychainService('/x', { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/Users/me/.tool/claude' }), want)
})

test('linkPath expands ~, drops the trailing slash and refuses relative paths', () => {
  assert.equal(linkPath('~/.tool/claude/', '/Users/me'), '/Users/me/.tool/claude')
  assert.equal(linkPath('/x/y', '/h'), '/x/y')
  assert.equal(linkPath('rel/x', '/h'), null)
  assert.equal(linkPath('', '/h'), null)
  assert.equal(linkPath('/a\0b', '/h'), null)
})

test('linkDirWhy takes only another config folder of this user with a .claude.json', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-link-'))
  const mainDir = path.join(home, '.claude')
  const stateDir = path.join(home, '.claude-bridge')
  const tool = path.join(home, '.tool', 'claude')
  for (const d of [mainDir, stateDir, path.join(stateDir, 'accounts', 'a12345678'), tool]) fs.mkdirSync(d, { recursive: true })
  const opts = { home, mainDir, stateDir, accountDirs: [path.join(stateDir, 'accounts', 'a12345678')] }
  assert.match(linkDirWhy(tool, opts), /\.claude\.json 이 없어요/)
  fs.writeFileSync(path.join(tool, '.claude.json'), '{}')
  assert.equal(linkDirWhy(tool, opts), null)
  // The same folder through a link is the same folder.
  fs.symlinkSync(mainDir, path.join(home, 'main-link'))
  fs.writeFileSync(path.join(mainDir, '.claude.json'), '{}')
  assert.match(linkDirWhy(path.join(home, 'main-link'), opts), /기본 계정/)
  assert.match(linkDirWhy(mainDir, opts), /기본 계정/)
  assert.match(linkDirWhy(path.join(stateDir, 'accounts', 'a12345678'), opts), /에이전트 폴더/)
  assert.match(linkDirWhy(home, opts), /품은 폴더/)
  assert.match(linkDirWhy(path.join(home, 'nope'), opts), /없어요/)
  assert.match(linkDirWhy(null, opts), /절대 경로/)
  assert.match(linkDirWhy(tool, { ...opts, accountDirs: [tool] }), /다른 계정/)
  assert.match(linkDirWhy(tool, { ...opts, uid: -5 }), /사용자의 폴더가 아니에요/)
  fs.writeFileSync(path.join(home, 'file'), 'x')
  assert.match(linkDirWhy(path.join(home, 'file'), opts), /폴더가 아니에요/)
  fs.rmSync(home, { recursive: true, force: true })
})

test('linkDirWhy sees the main folder through another case and refuses a folder inside it', () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-case-')))
  const mainDir = path.join(home, '.claude')
  const stateDir = path.join(home, '.claude-bridge')
  fs.mkdirSync(path.join(mainDir, 'inner'), { recursive: true })
  fs.writeFileSync(path.join(mainDir, '.claude.json'), '{}')
  fs.writeFileSync(path.join(mainDir, 'inner', '.claude.json'), '{}')
  const opts = { home, mainDir, stateDir }
  const insensitive = fs.existsSync(path.join(home, '.CLAUDE'))
  if (insensitive) assert.match(linkDirWhy(path.join(home, '.CLAUDE'), opts), /기본 계정/)
  assert.match(linkDirWhy(path.join(mainDir, 'inner'), opts), /기본 계정의 설정 폴더 안/)
  assert.ok(linkCandidates('/a/b').includes('/a/b/'))
  fs.rmSync(home, { recursive: true, force: true })
})

test('linkedAuth reads a linked folder without running claude, and its settings notes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-la-'))
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'tool@example.com' } }))
  const before = fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')
  let asked = null
  assert.deepEqual(await linkedAuth(dir, async (svc) => ((asked = svc), true)), { loggedIn: true, method: '키체인 로그인', email: 'tool@example.com', plan: null, org: null })
  assert.equal(asked, keychainService(dir))
  assert.equal((await linkedAuth(dir, async () => false)).loggedIn, false)
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{}')
  assert.equal((await linkedAuth(dir, async () => false)).method, '로그인 파일')
  assert.equal(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'), before)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.claude.json', '.credentials.json'])
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ disableAllHooks: true, permissions: { defaultMode: 'bypassPermissions' } }))
  assert.equal(linkedSettingsNotes(dir).length, 2)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('copySessionState keeps what a linked folder already has', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-keep-'))
  const [from, to] = [path.join(root, 'from'), path.join(root, 'to')]
  fs.mkdirSync(path.join(from, 'file-history', 'c1'), { recursive: true })
  fs.mkdirSync(path.join(to, 'file-history', 'c1'), { recursive: true })
  fs.writeFileSync(path.join(from, 'file-history', 'c1', 'f'), 'new')
  fs.writeFileSync(path.join(to, 'file-history', 'c1', 'f'), 'theirs')
  copySessionState('c1', from, to, { keep: true })
  assert.equal(fs.readFileSync(path.join(to, 'file-history', 'c1', 'f'), 'utf8'), 'theirs')
  copySessionState('c1', from, to)
  assert.equal(fs.readFileSync(path.join(to, 'file-history', 'c1', 'f'), 'utf8'), 'new')
  fs.rmSync(root, { recursive: true, force: true })
})
