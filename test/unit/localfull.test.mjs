// 로컬 전체 화면 (local --full, REQ-F-900~902, REQ-S-103~105): the signed Mac builds of the server, what the agent
// takes and runs, the one-time links, the agent's link to its local server, and the terminal's commands.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { lfDocOf, lfSign, lfSigned, lfVerify, LocalFull, localFullOf, archOf, sseMessages, Relay, localFullCli, LF_ARCHES, fetchBuild, readBuildFiles, listenersOf, heldOnlyBy, portFree, helloOk, lfHelloMac, releaseBuild, LF_RELEASES, groupsStep, GROUPS_MAX } from '../../agent/localfull.mjs'
import { classOf } from '../../agent/trust.mjs'
import { docOf, signDoc } from '../../agent/localui.mjs'
import { localFullSrc, savedLocalFull } from '../../scripts/sign-agent.mjs'

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const KEYS = [publicKey.export({ type: 'spki', format: 'der' }).toString('base64')]
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cb-lf-'))
const signed = (bytes, seq, arch = 'darwin-arm64', key = privateKey) => {
  const doc = lfDocOf(bytes, seq, arch)
  return { doc, sig: lfSign(doc, key), bytes }
}

test('a build is taken only with the maintainer signature over its document, for this machine, with the same bytes', () => {
  const b = Buffer.from('a mac build')
  const ok = lfVerify(signed(b, 5), { arch: 'darwin-arm64', keys: KEYS })
  assert.equal(ok.ok, true)
  assert.equal(ok.d.seq, 5)
  assert.match(lfVerify({ ...signed(b, 5), bytes: Buffer.from('a mac build!') }, { arch: 'darwin-arm64', keys: KEYS }).why, /해시/)
  assert.equal(lfVerify(signed(b, 5), { arch: 'darwin-amd64', keys: KEYS }).ok, false, '다른 아키텍처의 문서')
  const other = crypto.generateKeyPairSync('ed25519').privateKey
  assert.match(lfVerify(signed(b, 5, 'darwin-arm64', other), { arch: 'darwin-arm64', keys: KEYS }).why, /서명/)
  // Domain separation: a local screen bundle's signature (same key, its own prefix) is not a build's.
  const doc = lfDocOf(b, 5, 'darwin-arm64')
  assert.equal(lfSigned(doc, signDoc(doc, privateKey), KEYS), false)
})

test('the build on the Mac: installed after the check, never one signed before it (floor), checked again from disk', () => {
  const lf = new LocalFull({ dir: tmp(), arch: 'darwin-arm64', keys: KEYS })
  assert.equal(lf.installed().ok, false)
  assert.equal(lf.install({ ...signed(Buffer.from('v1'), 10), bytes: Buffer.from('tampered') }).result, 'verify_failed')
  assert.equal(lf.install(signed(Buffer.from('v1'), 10)).result, 'installed')
  assert.equal((fs.statSync(lf.binPath).mode & 0o777).toString(8), '700')
  assert.equal((fs.statSync(lf.dir).mode & 0o777).toString(8), '700')
  assert.equal(lf.install(signed(Buffer.from('v1'), 10)).result, 'same')
  assert.equal(lf.install(signed(Buffer.from('v0'), 9)).result, 'old', '먼저 서명된 빌드는 받지 않음')
  assert.equal(lf.install(signed(Buffer.from('v2'), 11)).result, 'installed')
  assert.equal(lf.installed().d.seq, 11)
  fs.writeFileSync(lf.binPath, 'changed on disk')
  assert.match(lf.installed().why, /해시/, '디스크에서 바뀐 빌드는 쓰지 않음')
})

test('one-time links are kept as their SHA-256 only, five at most (the local server takes them)', () => {
  const lf = new LocalFull({ dir: tmp(), arch: 'darwin-arm64', keys: KEYS })
  const t = lf.newTicket()
  assert.match(t, /^[A-Za-z0-9_-]{43}$/)
  const list = JSON.parse(fs.readFileSync(lf.ticketsPath, 'utf8'))
  assert.equal(list[0].h, crypto.createHash('sha256').update(t).digest('hex'))
  assert.ok(!fs.readFileSync(lf.ticketsPath, 'utf8').includes(t))
  for (let i = 0; i < 7; i++) lf.newTicket()
  assert.equal(JSON.parse(fs.readFileSync(lf.ticketsPath, 'utf8')).length, 5)
  lf.dropTickets()
  assert.equal(fs.existsSync(lf.ticketsPath), false)
})

test('agent.json localFull: off unless turned on, its port the agent port + 10', () => {
  assert.deepEqual(localFullOf({}, 4317), { on: false, port: 4327, sessionHours: 12, releases: LF_RELEASES, groups: true })
  assert.deepEqual(localFullOf({ localFull: { on: true, port: 80, sessionHours: 999 } }, 4400), { on: true, port: 4410, sessionHours: 168, releases: LF_RELEASES, groups: true })
  assert.equal(localFullOf({ localFull: { releases: 'https://mirror.example/lf/' } }).releases, 'https://mirror.example/lf/', '미러')
  assert.equal(localFullOf({ localFull: { releases: 'http://mirror.example/lf/' } }).releases, LF_RELEASES, 'https 만')
  assert.equal(localFullOf({ localFull: { on: 'yes' } }).on, false)
  assert.equal(archOf('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(archOf('darwin', 'x64'), 'darwin-amd64')
  assert.equal(archOf('linux', 'x64'), null)
})

test('the stream reader splits SSE blocks and keeps the unfinished rest', () => {
  const { msgs, rest } = sseMessages('data: {"t":"a"}\n\n: comment\n\nevent: beat\ndata: 1\n\ndata: {"t":"b"')
  assert.deepEqual(msgs, [{ t: 'a' }, 1])
  assert.equal(rest, 'data: {"t":"b"')
})

test("the agent's link carries the run's secret on every request and passes commands to the agent", async () => {
  const seen = []
  const ran = []
  let streamCtl
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, auth: init.headers?.Authorization })
    if (url.endsWith('/api/bridge/hello')) return new Response(JSON.stringify({ ok: true, conn: 'c1' }), { status: 200 })
    if (url.includes('/api/bridge/stream')) return new Response(new ReadableStream({ start: (c) => (streamCtl = c) }), { status: 200 })
    if (url.endsWith('/api/bridge/up')) return new Response('{"ok":true}', { status: 200 })
    return new Response('', { status: 404 })
  }
  const relay = new Relay({ base: 'http://127.0.0.1:4399', secret: 'S'.repeat(43), toAgent: async (c) => ran.push(c), saveFile: async () => '/x', fetchImpl })
  relay.start()
  relay.fromAgent({ t: 'hello', hostId: 'h1', name: 'mac' })
  for (let i = 0; i < 50 && !streamCtl; i++) await new Promise((r) => setTimeout(r, 10))
  streamCtl.enqueue(new TextEncoder().encode('data: {"t":"key","sid":"s","keys":["Enter"],"reqId":"r1"}\n\n'))
  for (let i = 0; i < 50 && !ran.length; i++) await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(ran[0], { t: 'key', sid: 's', keys: ['Enter'], reqId: 'r1' })
  for (let i = 0; i < 50 && !seen.some((s) => s.url.endsWith('/up')); i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(seen.length >= 3 && seen.every((s) => s.auth === `Bearer ${'S'.repeat(43)}`), '모든 요청에 비밀')
  await relay.stop()
  assert.ok(seen.some((s) => s.url.endsWith('/api/bridge/bye')))
})

test('local --full on takes a signed build from the site and turns it on; a build signed before the one here is refused', async () => {
  const dir = tmp()
  const configPath = path.join(dir, 'agent.json')
  fs.writeFileSync(configPath, '{}')
  const lf = new LocalFull({ dir: path.join(dir, 'localfull'), arch: 'darwin-arm64', keys: KEYS })
  let serve = signed(Buffer.from('v5'), 5)
  const fetchImpl = async (url) => (url.endsWith('.json') ? new Response(JSON.stringify({ doc: serve.doc, sig: serve.sig })) : new Response(serve.bytes))
  const log = console.log
  console.log = () => {}
  try {
    const base = { configPath, lf, site: 'https://bridge.example', agentPort: 4317, open: null, running: async () => false, fetchImpl, checkPort: async () => ({ ok: true }) }
    assert.equal(await localFullCli(['on'], base), 0)
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).localFull.on, true)
    assert.equal(lf.installed().d.seq, 5)
    serve = signed(Buffer.from('v4'), 4)
    assert.equal(await localFullCli(['on'], base), 0, '이미 받은 빌드로 켬')
    assert.equal(lf.installed().d.seq, 5, '먼저 서명된 빌드로 바뀌지 않음')
    assert.equal(await localFullCli(['off'], base), 0)
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).localFull.on, false)
    assert.equal(await localFullCli(['open'], base), 1, '꺼져 있으면 링크를 주지 않음')
  } finally {
    console.log = log
  }
})

test('server/localfull.json: both Mac builds signed with a trusted key, from the sources as they are (run node scripts/sign-agent.mjs)', () => {
  const j = savedLocalFull()
  assert.ok(j, 'server/localfull.json 이 없습니다: node scripts/sign-agent.mjs')
  for (const a of LF_ARCHES) {
    assert.ok(j[a] && lfSigned(j[a].doc, j[a].sig), `${a} 의 서명이 맞지 않습니다`)
    const d = JSON.parse(j[a].doc)
    assert.equal(d.name, `localfull-${a}`)
    assert.ok(Number.isSafeInteger(d.seq) && d.seq > 0)
  }
  assert.equal(j.src, localFullSrc(), '맥용 서버의 소스(server·ui·web·Dockerfile)가 바뀌었습니다. node scripts/sign-agent.mjs 로 다시 만들어 서명하세요(이미지 빌드가 서명과 다른 빌드를 거절합니다)')
})

test('a site behind a sign-in gate: its login redirect is told apart, and the two files a browser took go in with install (REQ-F-903)', async () => {
  const seen = []
  const gate = async (url, opt) => (seen.push(opt?.redirect), new Response('', { status: 302, headers: { Location: 'https://sso.example/login' } }))
  await assert.rejects(fetchBuild('https://bridge.example', 'darwin-arm64', gate), /로그인 화면으로 넘김 \(HTTP 302\).*install/)
  assert.deepEqual(seen, ['manual'], '리다이렉트를 따라가지 않음')
  const page = async () => new Response('<html>login</html>', { status: 200 })
  await assert.rejects(fetchBuild('https://bridge.example', 'darwin-arm64', page), /JSON 이 아님.*install/)

  const dir = tmp()
  const configPath = path.join(dir, 'agent.json')
  fs.writeFileSync(configPath, '{}')
  const lf = new LocalFull({ dir: path.join(dir, 'localfull'), arch: 'darwin-arm64', keys: KEYS })
  const b = signed(Buffer.from('v7'), 7)
  const bin = path.join(dir, 'darwin-arm64')
  const doc = path.join(dir, 'darwin-arm64.json')
  fs.writeFileSync(bin, b.bytes)
  fs.writeFileSync(doc, JSON.stringify({ doc: b.doc, sig: b.sig }))
  assert.deepEqual(readBuildFiles(bin, doc), { doc: b.doc, sig: b.sig, bytes: b.bytes })
  const log = console.log
  const err = console.error
  console.log = console.error = () => {}
  try {
    const base = { configPath, lf, site: 'https://bridge.example', agentPort: 4317, open: null, running: async () => false, fetchImpl: gate, checkPort: async () => ({ ok: true }) }
    assert.equal(await localFullCli(['install'], base), 1, '파일 없이는 사용법')
    fs.writeFileSync(path.join(dir, 'bad'), Buffer.from('v7!'))
    assert.equal(await localFullCli(['install', path.join(dir, 'bad'), doc], base), 1, '해시가 다른 파일은 넣지 않음')
    assert.equal(lf.installed().ok, false)
    assert.equal(await localFullCli(['install', bin, doc], base), 0)
    assert.equal(lf.installed().d.seq, 7)
    // The site still answers with its login page: on turns on with the build put in by hand.
    assert.equal(await localFullCli(['on'], base), 0)
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).localFull.on, true)
  } finally {
    console.log = log
    console.error = err
  }
})

test('the secret goes only to a port the started server holds alone, not to whatever answers /api/health (REQ-S-104)', () => {
  assert.deepEqual(listenersOf(4327, () => '812\n'), [812])
  assert.deepEqual(listenersOf(4327, () => '812\n812\n'), [812])
  assert.equal(heldOnlyBy(listenersOf(4327, () => '812\n'), 812), true)
  assert.equal(heldOnlyBy(listenersOf(4327, () => '900\n'), 812), false, '다른 프로그램이 그 포트를 잡음')
  assert.equal(heldOnlyBy(listenersOf(4327, () => '812\n900\n'), 812), false, '함께 듣는 다른 프로그램')
  assert.equal(listenersOf(4327, () => { throw new Error('lsof: no match') }), null)
  assert.equal(heldOnlyBy(null, 812), false, '알 수 없으면 넘기지 않음')
  const src = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  const on = src.slice(src.indexOf('async function localFullOn('), src.indexOf('async function localFullDown('))
  assert.ok(on.indexOf('heldOnlyBy(') > 0 && on.indexOf('heldOnlyBy(') < on.indexOf('new LocalRelay('), '비밀을 쓰는 연결보다 먼저 확인')
})

test('the local server log is kept apart from the site log, so the site never pages it out in plain (REQ-S-106)', () => {
  const src = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  assert.match(src, /const lfStore = new EventStore\(path\.join\(STATE_DIR, 'localfull', 'events'\)\)/)
  assert.match(src, /const storeOf = \(cmd\) => \(cmd\?\.signed === 'local' \? lfStore : store\)/)
  const body = (name) => src.slice(src.indexOf(`  ${name}(cmd) {`), src.indexOf('\n  },', src.indexOf(`  ${name}(cmd) {`)))
  for (const name of ['log', 'events', 'forget']) {
    assert.ok(src.includes(`  ${name}(cmd) {`), `${name} 이 명령의 출처를 받음`)
    assert.match(body(name), /storeOf\(cmd\)/, `${name} 은 출처의 기록을 씀`)
    assert.doesNotMatch(body(name), /\bstore\.(append|page|lastSeq|remove)\(/, `${name} 이 사이트 기록을 바로 쓰지 않음`)
  }
})

test('only the local server marks a command local: the site\'s signed:\'local\' is dropped in every trust mode (REQ-S-106)', async () => {
  const src = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  const { classOf, rebuild, hashesHold } = await import('../../agent/trust.mjs')
  // The real trustGate, run with the Mac's trust stubbed: a device signature that never checks out.
  const a = src.indexOf('function trustGate(cmd) {')
  const gateSrc = src.slice(a, src.indexOf('\n}\n', a) + 2)
  const trust = { verify: () => ({ ok: false, why: 'x' }), audit() {} }
  for (const mode of ['off', 'warn', 'enforce']) {
    const gate = new Function('trustMode', 'classOf', 'trustRefuse', 'trustWarn', 'trust', 'hashesHold', 'rebuild', `${gateSrc}\nreturn trustGate`)(() => mode, classOf, () => null, () => {}, trust, hashesHold, rebuild)
    for (const t of ['events', 'log', 'forget']) {
      const out = gate({ t, sid: 's1', signed: 'local' })
      assert.ok(out === null || out.signed !== 'local', `${mode} ${t}: 사이트가 붙인 local 표시가 남지 않음`)
    }
  }
  // The mark is put in one place, runCommand's local branch; the site's commands go through trustGate.
  assert.equal(src.split("cmd.signed = 'local'").length - 1, 1, 'local 표시는 한 곳에서만 붙음')
  const run = src.slice(src.indexOf('async function runCommand('), src.indexOf('\n}\n', src.indexOf('async function runCommand(')))
  assert.match(run, /if \(local\) \{\s*delete cmd\.signed\s*cmd\.signed = 'local'\s*\} else \{[^}]*cmd = trustGate\(cmd\)/)
  assert.ok(src.includes('return runCommand(cmd)\n'), '사이트 명령은 local 없이 들어옴')
  assert.ok(src.includes('toAgent: (cmd) => runCommand(cmd, { local: true })'), '로컬 서버 명령만 local')
})

test('a site with no build, or behind a sign-in, gives way to the published release; checked the same (REQ-F-904)', async () => {
  const dir = tmp()
  const configPath = path.join(dir, 'agent.json')
  fs.writeFileSync(configPath, JSON.stringify({ localFull: { releases: 'https://mirror.example/lf/' } }))
  const lf = new LocalFull({ dir: path.join(dir, 'localfull'), arch: 'darwin-arm64', keys: KEYS })
  let rel = signed(Buffer.from('r9'), 9)
  const asked = []
  const fetchImpl = async (url, opt) => {
    asked.push(url)
    if (url.startsWith('https://bridge.example/')) return new Response('', { status: 302, headers: { Location: 'https://sso.example/login' } })
    if (opt?.redirect === 'manual') throw new Error('릴리스는 리다이렉트를 따라가야 함')
    return url.endsWith('.json') ? new Response(JSON.stringify({ doc: rel.doc, sig: rel.sig })) : new Response(rel.bytes)
  }
  const log = console.log
  const err = console.error
  console.log = console.error = () => {}
  try {
    const base = { configPath, lf, site: 'https://bridge.example', agentPort: 4317, open: null, running: async () => false, fetchImpl, checkPort: async () => ({ ok: true }) }
    assert.equal(await localFullCli(['on'], base), 0)
    assert.equal(lf.installed().d.seq, 9, '릴리스에서 받음')
    assert.ok(asked.includes('https://mirror.example/lf/localfull-darwin-arm64.json') && asked.includes('https://mirror.example/lf/localfull-darwin-arm64'))
    // A release that is not signed, or signed before the one here, is not taken.
    rel = { ...signed(Buffer.from('r10'), 10), sig: signed(Buffer.from('x'), 10).sig }
    assert.equal(await localFullCli(['on'], base), 0)
    assert.equal(lf.installed().d.seq, 9, '서명이 맞지 않는 릴리스는 받지 않음')
    rel = signed(Buffer.from('r8'), 8)
    await localFullCli(['on'], base)
    assert.equal(lf.installed().d.seq, 9, '먼저 서명된 릴리스는 받지 않음')
  } finally {
    console.log = log
    console.error = err
  }
  await assert.rejects(releaseBuild('https://r.example/', 'darwin-arm64', async () => new Response('', { status: 404 })), /HTTP 404/)
  await assert.rejects(releaseBuild('https://r.example/', 'darwin-arm64', async () => new Response('<html>')), /맞지 않음/)
})

test('a port another program holds: on is refused with who holds it, and nothing is turned on (REQ-S-106)', async () => {
  const run = (cmd) => (cmd.endsWith('lsof') ? '777\n' : '  777 /usr/bin/nc\n')
  const busy = await portFree(4327, { run, listen: async () => true })
  assert.equal(busy.ok, false)
  assert.match(busy.why, /127\.0\.0\.1:4327 를 이미 다른 프로그램이 쓰고 있어 켜지 않았어요\(777 \/usr\/bin\/nc\)/)
  assert.equal((await portFree(4327, { run: () => '', listen: async () => false })).ok, false, '묶을 수 없으면 쓰는 중')
  assert.equal((await portFree(4327, { run: () => '', listen: async () => true })).ok, true)
  // A real port held here.
  const net = await import('node:net')
  const s = net.createServer().listen(0, '127.0.0.1')
  await new Promise((r) => s.once('listening', r))
  try {
    assert.equal((await portFree(s.address().port, { run: () => '' })).ok, false, '실제로 잡힌 포트')
  } finally {
    s.close()
  }

  const dir = tmp()
  const configPath = path.join(dir, 'agent.json')
  fs.writeFileSync(configPath, '{}')
  const lf = new LocalFull({ dir: path.join(dir, 'localfull'), arch: 'darwin-arm64', keys: KEYS })
  const err = console.error
  const said = []
  console.error = (m) => said.push(m)
  try {
    assert.equal(await localFullCli(['on'], { configPath, lf, site: '', agentPort: 4317, open: null, running: async () => true, fetchImpl: async () => assert.fail('받기 전에 멈춤'), checkPort: async () => busy }), 1)
  } finally {
    console.error = err
  }
  assert.match(said.join('\n'), /켜지 않았어요/)
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).localFull, undefined, '켜지 않음')
})

test("the server must answer the challenge only this run's secret answers, without the secret being sent (REQ-S-106)", async () => {
  const secret = crypto.randomBytes(32).toString('base64url')
  const sent = []
  const real = async (url, opt) => {
    sent.push(JSON.stringify([url, opt?.headers ?? {}]))
    const n = new URL(url).searchParams.get('n')
    return new Response(JSON.stringify({ mac: lfHelloMac(secret, n) }))
  }
  assert.equal(await helloOk('http://127.0.0.1:4327', secret, real), true)
  assert.ok(!sent.join('').includes(secret), '비밀은 보내지 않음')
  const other = async (url) => new Response(JSON.stringify({ mac: lfHelloMac('x'.repeat(43), new URL(url).searchParams.get('n')) }))
  assert.equal(await helloOk('http://127.0.0.1:4327', secret, other), false, '다른 비밀')
  assert.equal(await helloOk('http://127.0.0.1:4327', secret, async () => new Response('{"ok":true}')), false, 'health 처럼 200 만')
  assert.equal(await helloOk('http://127.0.0.1:4327', secret, async () => new Response('', { status: 404 })), false)
  // The same answer as the server's (server/localfull.go localHello, LF_HELLO).
  assert.equal(lfHelloMac('s', 'n'), crypto.createHmac('sha256', 's').update('claude-bridge localfull hello v1\nn').digest('base64url'))
})

// AC-1761: 세션 그룹 넘겨주기 (REQ-F-905). The Mac keeps the newest groups it was handed and sends its own up to a
// server whose are older, so the one changed last wins whichever way the switch goes. agent.json's localFull.groups
// false turns it off; the command runs nothing, so trust lets it through like the other free ones.
test('groups go with the Mac between the site and its local server: the one changed last wins (REQ-F-905)', () => {
  const site = { at: 100, groups: [{ id: 'aaaa1111', name: '일', items: ['s-a', 's-other-mac'] }], loose: ['s-b'], collapsed: ['loose'] }
  // Linked to the site: nothing kept yet, its groups are kept.
  const kept = groupsStep(null, site)
  assert.equal(kept.do, 'keep')
  assert.deepEqual(kept.rec, { at: 100, groups: site.groups, loose: site.loose, collapsed: site.collapsed })
  // `on`: a new local server has none (time 0), so the site's go up to it.
  const up = groupsStep(kept.rec, { at: 0, groups: [], loose: [], collapsed: [] })
  assert.equal(up.do, 'send')
  assert.deepEqual(up.msg, { t: 'groups', ...kept.rec })
  // Changed on the local server: kept. `off`: the site's are older, so these go up there.
  const local = { at: 200, groups: [{ id: 'bbbb2222', name: '새', items: ['s-a'] }], loose: ['s-other-mac'], collapsed: [] }
  const kept2 = groupsStep(kept.rec, local)
  assert.equal(kept2.do, 'keep')
  assert.equal(groupsStep(kept2.rec, site).do, 'send')
  // The same time: nothing; a broken one: nothing.
  assert.equal(groupsStep(kept2.rec, local).do, 'none')
  assert.equal(groupsStep(kept2.rec, { at: 'x' }).do, 'none')
  assert.equal(groupsStep(kept2.rec, null).do, 'none')
  // Far ahead of this Mac's clock: not taken, and one kept like that gives way to the server's.
  const now = Date.now()
  assert.equal(groupsStep(null, { at: now + 10 * 60_000, groups: [] }, now).do, 'none')
  assert.equal(groupsStep({ at: now + 10 * 60_000, groups: [] }, site, now).do, 'keep')
  // What is not a list is kept as an empty one.
  assert.deepEqual(groupsStep(null, { at: 1, groups: 'x' }).rec, { at: 1, groups: [], loose: [], collapsed: [] })

  const lf = new LocalFull({ dir: tmp(), arch: 'darwin-arm64', keys: KEYS })
  assert.equal(lf.groups(), null)
  assert.equal(lf.saveGroups(kept2.rec), true)
  assert.deepEqual(lf.groups(), kept2.rec)
  assert.equal((fs.statSync(lf.groupsPath).mode & 0o777).toString(8), '600')
  assert.equal(lf.saveGroups({ at: 3, groups: ['x'.repeat(GROUPS_MAX)] }), false, '너무 크면 두지 않음')
  assert.deepEqual(lf.groups(), kept2.rec)

  assert.equal(localFullOf({}).groups, true, '기본은 켬')
  assert.equal(localFullOf({ localFull: { groups: false } }).groups, false)
  assert.equal(classOf({ t: 'groups' }), 'free')
})
