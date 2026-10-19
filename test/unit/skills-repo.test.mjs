// 스킬 저장소 (REQ-F-792): each person sets their own repo (one they own on GitHub); SKILLS_REPO is the default for
// everyone who set none; the server-wide repo of 1.294 moves to its owner at start.
import { test, after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { startServer } from './server-harness.mjs'

// A GitHub stand-in serving one marketplace per repo: `boss/skills` has two skills, `env/repo` one.
const markets = { 'boss/skills': ['review', 'verify'], 'env/repo': ['shared'] }
let gh
let ghOrigin
before(async () => {
  gh = http.createServer((req, res) => {
    const m = /^\/repos\/([^/]+\/[^/]+)\/(.*)$/.exec(new URL(req.url, 'http://x').pathname)
    const names = m && markets[m[1].toLowerCase()]
    if (!names) return res.writeHead(404).end()
    const rest = m[2]
    if (rest === 'commits/HEAD') return res.end(JSON.stringify({ sha: 'abc1234', commit: { committer: { date: '2026-10-19T00:00:00Z' } } }))
    if (rest === 'contents/.claude-plugin/marketplace.json') return res.end(JSON.stringify({ name: 'm', plugins: names.map((name) => ({ name, source: name })) }))
    if (rest === 'contents/install.sh') return res.end(`#!/bin/sh\n# ${m[1]}\n`)
    const sk = /^contents\/([a-z]+)\/skills\/([a-z]+)\/SKILL\.md$/.exec(rest)
    if (sk) return res.end(`---\nname: ${sk[2]}\ndescription: d\n---\nbody`)
    res.writeHead(404).end()
  })
  await new Promise((r) => gh.listen(0, '127.0.0.1', r))
  ghOrigin = `http://127.0.0.1:${gh.address().port}`
})
after(() => gh?.close())

const envOf = (more = {}) => ({ SKILLS_REPO: undefined, SKILLS_GITHUB_APP_ID: undefined, SKILLS_GITHUB_APP_KEY: undefined, SKILLS_GITHUB_TOKEN: 't', SKILLS_GITHUB_API: ghOrigin, ...more })
const prefs = (srv, login) => {
  const f = path.join(srv.data, 'u', `dev-${login}`, 'prefs.json')
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}
}

describe('per person, without SKILLS_REPO', () => {
  let srv
  after(() => srv?.stop())

  test('off for everyone at first, quietly; the 운영 endpoint is gone', async () => {
    srv = await startServer({ env: envOf() })
    await srv.login('boss')
    await srv.login('alice')
    assert.deepEqual((await srv.api('alice', '/api/prefs/skills')).json, { repo: '', fallback: false, login: 'alice', auth: 'token', on: false })
    const r = await srv.api('alice', '/api/skills')
    assert.equal(r.status, 503)
    assert.match(r.json.error, /설정 → 더 보기 → 스킬 저장소/)
    assert.deepEqual(Object.keys(await (await fetch(`${srv.origin}/skills/version`)).json()), ['code'])
    assert.equal((await srv.api('boss', '/api/admin/skills')).status, 404)
    assert.ok(!/skills/i.test(srv.log()), 'nothing about skills in the log')
  })

  test('only a repo of one’s own GitHub login is saved', async () => {
    for (const repo of ['nope', 'a/b/c', '-a/b', 'a b/c', 'a/']) assert.equal((await srv.api('alice', '/api/prefs/skills', { method: 'POST', body: { repo } })).status, 400, repo)
    const other = await srv.api('alice', '/api/prefs/skills', { method: 'POST', body: { repo: 'boss/skills' } })
    assert.equal(other.status, 400)
    assert.match(other.json.error, /alice/)
    assert.equal(prefs(srv, 'alice').skillsRepo, undefined)
    const r = await srv.api('boss', '/api/prefs/skills', { method: 'POST', body: { repo: ' BOSS/skills ' } })
    assert.deepEqual(r.json, { repo: 'BOSS/skills', fallback: false, login: 'boss', auth: 'token', on: true })
    assert.equal(prefs(srv, 'boss').skillsRepo, 'BOSS/skills')
  })

  test('each sees their own: the owner their list, the others nothing', async () => {
    const mine = await srv.api('boss', '/api/skills')
    assert.equal(mine.status, 200)
    assert.deepEqual(mine.json.skills.map((s) => s.name), ['review', 'verify'])
    assert.equal((await srv.api('alice', '/api/skills')).status, 503)
    const v = (await srv.api('boss', '/skills/version')).json
    assert.equal(v.repo, 'BOSS/skills')
    assert.equal(v.skills, 2)
    const anon = await (await fetch(`${srv.origin}/skills/version`)).json()
    assert.deepEqual(Object.keys(anon), ['code'])
    assert.deepEqual(Object.keys((await srv.api('alice', '/skills/version')).json), ['code'])
  })

  let install
  test('install.sh only at the signed address /api/skills gives the owner (1.297)', async () => {
    install = (await srv.api('boss', '/api/skills')).json.install
    assert.match(install, /\/skills\/install\.sh\?repo=BOSS\/skills&t=[\w-]{32}$/)
    assert.equal((await srv.api('alice', '/api/skills')).json.install, undefined)
    const u = new URL(install)
    let r = await fetch(`${srv.origin}${u.pathname}${u.search}`)
    assert.equal(r.status, 200)
    assert.match(await r.text(), /^#!\/bin\/sh/)
    // The same repo in other letters is the same signature; without it, a wrong one, or for another repo: 404.
    assert.equal((await fetch(`${srv.origin}/skills/install.sh?repo=boss/skills&t=${u.searchParams.get('t')}`)).status, 200)
    for (const q of ['?repo=boss/skills', `?repo=boss/skills&t=${'A'.repeat(32)}`, '?repo=boss/skills&t=', `?repo=env/repo&t=${u.searchParams.get('t')}`, `?repo=boss/other&t=${u.searchParams.get('t')}`, '', '?repo=a/b'])
      assert.equal((await fetch(`${srv.origin}/skills/install.sh${q}`)).status, 404, q)
  })

  test('empty clears it', async () => {
    const r = await srv.api('boss', '/api/prefs/skills', { method: 'POST', body: { repo: '' } })
    assert.equal(r.json.on, false)
    assert.equal(prefs(srv, 'boss').skillsRepo, undefined)
    // A signed address of a repo nobody uses any more is 404 too.
    const u = new URL(install)
    assert.equal((await fetch(`${srv.origin}${u.pathname}${u.search}`)).status, 404)
  })
})

describe('SKILLS_REPO is the default', () => {
  let srv
  after(() => srv?.stop())

  test('for whoever set none; one’s own wins', async () => {
    srv = await startServer({ env: envOf({ SKILLS_REPO: 'env/repo' }) })
    await srv.login('boss')
    await srv.login('alice')
    assert.deepEqual((await srv.api('alice', '/api/prefs/skills')).json, { repo: '', fallback: true, login: 'alice', auth: 'token', on: true })
    assert.deepEqual((await srv.api('alice', '/api/skills')).json.skills.map((s) => s.name), ['shared'])
    await srv.api('boss', '/api/prefs/skills', { method: 'POST', body: { repo: 'boss/skills' } })
    assert.deepEqual((await srv.api('boss', '/api/skills')).json.skills.map((s) => s.name), ['review', 'verify'])
    const u = new URL((await srv.api('alice', '/api/skills')).json.install)
    assert.equal(u.searchParams.get('repo'), 'env/repo')
    assert.equal((await fetch(`${srv.origin}${u.pathname}${u.search}`)).status, 200)
    assert.equal((await fetch(`${srv.origin}/skills/install.sh`)).status, 404)
    assert.equal((await fetch(`${srv.origin}/skills/install.sh?repo=env/repo`)).status, 404)
  })
})

describe('the server-wide repo of 1.294 moves to its owner', () => {
  const users = { 'dev-boss': { login: 'boss', name: 'boss', avatar: '' }, 'dev-alice': { login: 'alice', name: 'alice', avatar: '' } }
  let srv
  after(() => srv?.stop())

  test('to the person whose login owns it; the file is renamed', async () => {
    srv = await startServer({ env: envOf(), seed: { 'users.json': users, 'skills-repo.json': { repo: 'Boss/skills' } } })
    assert.equal(prefs(srv, 'boss').skillsRepo, 'Boss/skills')
    assert.ok(!fs.existsSync(path.join(srv.data, 'skills-repo.json')))
    assert.ok(fs.existsSync(path.join(srv.data, 'skills-repo.json.migrated')))
    assert.ok(!fs.existsSync(path.join(srv.data, 'u', 'dev-alice', 'prefs.json')))
    assert.ok(!/Boss\/skills/.test(srv.log()), 'the repo name is not logged')
    await srv.stop()
    srv = null
  })

  test('a repo the owner already set is kept', async () => {
    srv = await startServer({ env: envOf(), seed: { 'users.json': users, 'skills-repo.json': { repo: 'boss/old' }, 'u/dev-boss/prefs.json': { skillsRepo: 'boss/skills' } } })
    assert.equal(prefs(srv, 'boss').skillsRepo, 'boss/skills')
    assert.ok(fs.existsSync(path.join(srv.data, 'skills-repo.json.migrated')))
    await srv.stop()
    srv = null
  })

  test('with no such person the file stays', async () => {
    srv = await startServer({ env: envOf(), seed: { 'users.json': users, 'skills-repo.json': { repo: 'carol/skills' } } })
    assert.ok(fs.existsSync(path.join(srv.data, 'skills-repo.json')))
    assert.ok(!fs.existsSync(path.join(srv.data, 'skills-repo.json.migrated')))
  })
})

describe('an Apple account has no GitHub login', () => {
  let srv
  after(() => srv?.stop())

  test('and cannot set a repo', async () => {
    const token = 'apple-test-token'
    const uid = 'ap0123456789abcdef01234567'
    const users = { [uid]: { login: 'apple_0123456789', name: 'A', avatar: '', apple: true } }
    const logins = { [crypto.createHash('sha256').update(token).digest('hex')]: { uid, exp: Date.now() + 86_400_000 } }
    srv = await startServer({ env: envOf(), seed: { 'users.json': users, 'logins.json': logins, 'access.json': { apple_0123456789: { login: 'apple_0123456789', status: 'allowed' } } } })
    const call = (p, init = {}) => fetch(`${srv.origin}${p}`, { ...init, headers: { cookie: `cb=${token}`, 'content-type': 'application/json', origin: srv.origin } })
    assert.equal((await (await call('/api/prefs/skills')).json()).login, null)
    const r = await call('/api/prefs/skills', { method: 'POST', body: JSON.stringify({ repo: 'apple-0123456789/x' }) })
    assert.equal(r.status, 400)
    assert.match((await r.json()).error, /GitHub 로 로그인한 계정만/)
  })
})
