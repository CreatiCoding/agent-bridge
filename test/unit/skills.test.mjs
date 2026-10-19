import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { appJwt, appKey, codeHash, createSkills, frontMatter, safePath, SKILLS_FILES, upstreamOf } from '../../server/skills.mjs'

test('front matter: quoted, folded and plain values', () => {
  const { meta, body } = frontMatter(`---
name: 'submit-pr'
description: >
  Use when user asks to "PR 생성",
  or needs a pull request.
argument-hint: '[PR번호]'
allowed-tools: Bash(git diff:*), Read
---
# 본문
`)
  assert.equal(meta.name, 'submit-pr')
  assert.equal(meta.description, 'Use when user asks to "PR 생성", or needs a pull request.')
  assert.equal(meta['argument-hint'], '[PR번호]')
  assert.equal(meta['allowed-tools'], 'Bash(git diff:*), Read')
  assert.equal(body, '# 본문\n')
})

test('front matter: double-quoted one line value', () => {
  assert.equal(frontMatter('---\nname: a11y-react\ndescription: "React 접근성: (1) 버튼"\n---\nx').meta.description, 'React 접근성: (1) 버튼')
})

test('front matter: none', () => {
  assert.deepEqual(frontMatter('# just markdown'), { meta: {}, body: '# just markdown' })
})

test('upstream: git-subdir entries on GitHub only', () => {
  assert.deepEqual(upstreamOf({ source: 'git-subdir', url: 'https://github.com/obra/superpowers.git', path: 'skills/verify/' }), { repo: 'obra/superpowers', path: 'skills/verify', ref: 'HEAD' })
  assert.deepEqual(upstreamOf({ source: 'git-subdir', url: 'git@github.com:a/b', path: './x', sha: 'f00' }), { repo: 'a/b', path: 'x', ref: 'f00' })
  assert.equal(upstreamOf('review'), null)
  assert.equal(upstreamOf({ source: 'github', repo: 'a/b' }), null)
  assert.equal(upstreamOf({ source: 'git-subdir', url: 'https://gitlab.com/a/b.git', path: 'x' }), null)
})

test('skills: own skills from the repo, linked ones from the upstream repo', async (t) => {
  const market = {
    name: 'm',
    metadata: { pluginRoot: './plugins' },
    plugins: [
      { name: 'review', source: 'review', category: 'coding' },
      { name: 'verify', source: { source: 'git-subdir', url: 'https://github.com/o/r.git', path: 'skills/verify', sha: 'p1n' }, strict: false, skills: ['./'] },
      { name: 'calm', source: { source: 'git-subdir', url: 'https://github.com/o/r.git', path: 'styles', sha: 'p1n' }, strict: false, outputStyles: ['./a.md', './b.md'] },
    ],
  }
  const files = {
    'https://api.test/repos/me/skills/commits/HEAD': JSON.stringify({ sha: 'abc' }),
    'https://api.test/repos/me/skills/contents/.claude-plugin/marketplace.json?ref=abc': JSON.stringify(market),
    'https://api.test/repos/me/skills/contents/plugins/review/skills/review/SKILL.md?ref=abc': '---\nname: review\n---\nmine',
    'https://api.test/repos/me/skills/contents/install.sh?ref=abc': '#!/bin/sh',
    'https://api.test/repos/me/skills/contents/status.json?ref=upstream-status': '{"checkedAt":"2026-10-11T04:25:58Z","ok":true,"run":"r"}',
    'https://raw.test/o/r/p1n/skills/verify/SKILL.md': '---\nname: verify\nlicense: MIT\n---\ntheirs',
    'https://raw.test/o/r/p1n/styles/a.md': '---\nname: Calm\ndescription: short\n---\nbe brief',
    'https://raw.test/o/r/p1n/styles/b.md': '---\nname: Plain\ndescription: plain\n---\nbe plain',
  }
  t.mock.method(globalThis, 'fetch', async (url) => (url in files ? new Response(files[url]) : new Response('', { status: 404 })))
  const c = await createSkills({ token: 't', repo: 'me/skills', api: 'https://api.test', raw: 'https://raw.test' }).current()
  assert.deepEqual(c.check, { checkedAt: '2026-10-11T04:25:58Z', ok: true, run: 'r' })
  const [own, linked, style] = c.skills
  assert.equal(own.body, 'mine')
  assert.equal(own.upstream, null)
  assert.equal(linked.body, 'theirs')
  assert.equal(linked.license, 'MIT')
  assert.deepEqual(linked.upstream, { repo: 'o/r', sha: 'p1n', url: 'https://github.com/o/r/tree/p1n/skills/verify' })
  assert.deepEqual(linked.outputStyles, [])
  assert.deepEqual(style.outputStyles, ['calm:Calm', 'calm:Plain'])
  assert.equal(style.description, 'Calm: short / Plain: plain')
  assert.equal(style.body, '## Calm\n\nbe brief\n\n## Plain\n\nbe plain\n')
})

test('code hash: changes with any /skills file', () => {
  const files = Object.fromEntries(SKILLS_FILES.map((f) => [f, `contents of ${f}`]))
  const a = codeHash((f) => files[f])
  assert.match(a, /^[0-9a-f]{12}$/)
  assert.equal(codeHash((f) => files[f]), a)
  files['web/skills.css'] += ' '
  assert.notEqual(codeHash((f) => files[f]), a)
})

test('skills: no upstream check yet is null, not an error', async (t) => {
  const market = { name: 'm', plugins: [] }
  const files = {
    'https://api.test/repos/me/skills/commits/HEAD': JSON.stringify({ sha: 'abc' }),
    'https://api.test/repos/me/skills/contents/.claude-plugin/marketplace.json?ref=abc': JSON.stringify(market),
    'https://api.test/repos/me/skills/contents/install.sh?ref=abc': '#!/bin/sh',
  }
  t.mock.method(globalThis, 'fetch', async (url) => (url in files ? new Response(files[url]) : new Response('', { status: 404 })))
  const c = await createSkills({ token: 't', repo: 'me/skills', api: 'https://api.test' }).current()
  assert.equal(c.check, null)
})

test('skills: a GitHub App reads the repo with an installation token it makes from its key (1.254)', async (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' })
  // The variable may hold the PEM with escaped newlines, or the PEM in base64.
  for (const v of [pem, pem.replace(/\n/g, '\\n'), Buffer.from(pem).toString('base64')]) assert.equal(appKey(v).asymmetricKeyType, 'rsa')
  assert.throws(() => appKey('not a key'))

  const jwtOk = (h) => {
    const [head, body, sig] = h.replace(/^Bearer /, '').split('.')
    const claims = JSON.parse(Buffer.from(body, 'base64url'))
    return crypto.verify('sha256', Buffer.from(`${head}.${body}`), publicKey, Buffer.from(sig, 'base64url')) && claims.iss === '42' && claims.exp - claims.iat === 600
  }
  const asked = []
  let minted = 0
  const files = {
    'https://api.test/repos/me/skills/commits/HEAD': JSON.stringify({ sha: 'abc' }),
    'https://api.test/repos/me/skills/contents/.claude-plugin/marketplace.json?ref=abc': JSON.stringify({ name: 'm', plugins: [] }),
    'https://api.test/repos/me/skills/contents/install.sh?ref=abc': '#!/bin/sh',
  }
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const authz = init.headers?.Authorization ?? ''
    if (url === 'https://api.test/repos/me/skills/installation') return jwtOk(authz) ? Response.json({ id: 7 }) : new Response('', { status: 401 })
    if (url === 'https://api.test/app/installations/7/access_tokens') {
      if (init.method !== 'POST' || !jwtOk(authz)) return new Response('', { status: 401 })
      asked.push(JSON.parse(init.body))
      minted++
      return Response.json({ token: `inst-${minted}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 })
    }
    if (authz !== 'Bearer inst-1') return new Response('', { status: 401 })
    return url in files ? new Response(files[url]) : new Response('', { status: 404 })
  })
  const s = createSkills({ token: '', app: { id: '42', key: appKey(pem) }, repo: 'me/skills', api: 'https://api.test' })
  assert.equal(s.auth, 'app')
  assert.equal((await s.current()).sha, 'abc')
  // Every read of that load shared one token, asked for this repo and Contents read only.
  assert.equal(minted, 1)
  assert.deepEqual(asked, [{ repositories: ['skills'], permissions: { contents: 'read', metadata: 'read' } }])
  assert.equal(createSkills({ token: 't', repo: 'me/skills' }).auth, 'token')
})

test('skills: the App JWT is RS256 with iss and a 10 minute window back-dated a minute', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const [head, body, sig] = appJwt(123, privateKey, 1_000_000_000_000).split('.')
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { alg: 'RS256', typ: 'JWT' })
  assert.deepEqual(JSON.parse(Buffer.from(body, 'base64url')), { iat: 999_999_940, exp: 1_000_000_540, iss: '123' })
  assert.ok(crypto.verify('sha256', Buffer.from(`${head}.${body}`), publicKey, Buffer.from(sig, 'base64url')))
})

test('skills: paths from marketplace.json never take the token out of the repo (1.297)', async (t) => {
  const evil = ['../../../victim/private/contents/x#', '..', '%2e%2e/x', 'a/../../b', 'x#', 'x?ref=main', '/abs/path', 'a\\..\\b', './', '.']
  const market = {
    name: 'm',
    plugins: [
      { name: 'ok', source: 'ok' },
      ...evil.map((s) => ({ name: 'n', source: s })),
      ...evil.map((s) => ({ name: s, source: 'fine' })),
      { name: 'up', source: { source: 'git-subdir', url: 'https://github.com/o/r.git', path: '../../victim/x', sha: 'p1n' } },
      { name: 'up2', source: { source: 'git-subdir', url: 'https://github.com/o/r.git', path: 'x', sha: '../../a' } },
    ],
  }
  const files = {
    'https://api.test/repos/me/skills/commits/HEAD': JSON.stringify({ sha: 'abc' }),
    'https://api.test/repos/me/skills/contents/.claude-plugin/marketplace.json?ref=abc': JSON.stringify(market),
    'https://api.test/repos/me/skills/contents/ok/skills/ok/SKILL.md?ref=abc': '---\nname: ok\n---\nmine',
    'https://api.test/repos/me/skills/contents/install.sh?ref=abc': '#!/bin/sh',
  }
  const asked = []
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    asked.push({ url, token: !!init.headers?.Authorization })
    return url in files ? new Response(files[url]) : new Response('', { status: 404 })
  })
  const logs = []
  const c = await createSkills({ token: 't', repo: 'me/skills', api: 'https://api.test', raw: 'https://raw.test', log: (...a) => logs.push(a.join(' ')) }).current()
  assert.deepEqual(
    c.skills.map((s) => s.name),
    ['ok'],
  )
  for (const a of asked.filter((x) => x.token)) assert.ok(new URL(a.url).pathname.startsWith('/repos/me/skills/'), a.url)
  assert.ok(asked.every((a) => !/victim/.test(a.url)))
  // The skip is logged without the repo's name.
  const skips = logs.filter((l) => /건너뜀/.test(l))
  assert.ok(skips.length && skips.every((l) => !l.includes('me/skills')))
})

test('skills: a pluginRoot that leaves the repo fails the load (1.297)', async (t) => {
  for (const root of ['../../victim', 'a/#', '%2e%2e']) {
    const files = {
      'https://api.test/repos/me/skills/commits/HEAD': JSON.stringify({ sha: 'abc' }),
      'https://api.test/repos/me/skills/contents/.claude-plugin/marketplace.json?ref=abc': JSON.stringify({ name: 'm', metadata: { pluginRoot: root }, plugins: [{ name: 'x', source: 'x' }] }),
    }
    const asked = []
    t.mock.method(globalThis, 'fetch', async (url) => (asked.push(url), url in files ? new Response(files[url]) : new Response('', { status: 404 })))
    await assert.rejects(createSkills({ token: 't', repo: 'me/skills', api: 'https://api.test' }).current())
    assert.ok(asked.every((u) => new URL(u).pathname.startsWith('/repos/me/skills/')))
    t.mock.restoreAll()
  }
})

test('skills: a renamed or moved repo (301) is not followed (1.297)', async (t) => {
  const inits = []
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    inits.push(init)
    return new Response('', { status: 301, headers: { Location: 'https://api.test/repositories/99' } })
  })
  await assert.rejects(createSkills({ token: 't', repo: 'me/skills', api: 'https://api.test' }).current(), /저장소를 찾을 수 없어요/)
  assert.ok(inits.length && inits.every((i) => i.redirect === 'manual'))
})

test('safePath: plain segments only', () => {
  assert.equal(safePath('plugins/a.b_c-d'), 'plugins/a.b_c-d')
  assert.equal(safePath('', { allowEmpty: true }), '')
  for (const s of ['', '..', '.', 'a/..', '%2e', 'a#', 'a?b', '/a', 'a/', 'a\\b', 'a//b', null, 3]) assert.equal(safePath(s), null, String(s))
})
