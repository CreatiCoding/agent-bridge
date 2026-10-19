// 스킬 저장소 (REQ-F-792): no repo by default; an operator saves one in the 운영 tab, and SKILLS_REPO wins over it.
import { test, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startServer } from './server-harness.mjs'

// A token so /skills could turn on; the API address goes nowhere, and nothing here reads it.
const env = { SKILLS_REPO: undefined, SKILLS_GITHUB_APP_ID: undefined, SKILLS_GITHUB_APP_KEY: undefined, SKILLS_GITHUB_TOKEN: 't', SKILLS_GITHUB_API: 'http://127.0.0.1:9' }

describe('without SKILLS_REPO', () => {
  let srv
  after(() => srv?.stop())

  test('off by default, quietly, and only the operator may set it', async () => {
    srv = await startServer({ env })
    await srv.login('boss')
    await srv.login('alice')
    let r = await srv.api('boss', '/api/admin/skills')
    assert.deepEqual(r.json, { repo: '', env: false, auth: 'token', on: false })
    assert.equal((await srv.api('alice', '/api/skills')).status, 503)
    assert.equal((await fetch(`${srv.origin}/skills/version`)).status, 503)
    assert.ok(!/skills/i.test(srv.log()), 'nothing about skills in the log')
    assert.equal((await srv.api('alice', '/api/admin/skills', { method: 'POST', body: { repo: 'a/b' } })).status, 403)
  })

  test('owner/repo is checked, saved, and turns /skills on; empty turns it off', async () => {
    for (const repo of ['nope', 'a/b/c', '-a/b', 'a b/c', 'a/']) assert.equal((await srv.api('boss', '/api/admin/skills', { method: 'POST', body: { repo } })).status, 400, repo)
    let r = await srv.api('boss', '/api/admin/skills', { method: 'POST', body: { repo: ' me/skills ' } })
    assert.deepEqual(r.json, { repo: 'me/skills', env: false, auth: 'token', on: true })
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(srv.data, 'skills-repo.json'), 'utf8')), { repo: 'me/skills' })
    r = await srv.api('boss', '/api/admin/skills', { method: 'POST', body: { repo: '' } })
    assert.equal(r.json.on, false)
  })
})

describe('with SKILLS_REPO', () => {
  let srv
  after(() => srv?.stop())

  test('the environment wins over the saved repo and cannot be changed', async () => {
    srv = await startServer({ env: { ...env, SKILLS_REPO: 'env/repo' }, seed: { 'skills-repo.json': { repo: 'saved/repo' } } })
    await srv.login('boss')
    assert.deepEqual((await srv.api('boss', '/api/admin/skills')).json, { repo: 'env/repo', env: true, auth: 'token', on: true })
    assert.equal((await srv.api('boss', '/api/admin/skills', { method: 'POST', body: { repo: 'x/y' } })).status, 409)
  })
})
