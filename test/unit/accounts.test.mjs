import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sharedConfig, mergedConfig, prepareAccountDir, syncAccountConfig, copySessionState, safeAccountId, newAccountId, accountName, loginUrlOf, safeLoginCode, authOf, SHARED } from '../../agent/accounts.mjs'

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
