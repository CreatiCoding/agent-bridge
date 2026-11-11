// 로컬 전체 화면 (local --full, REQ-F-900~902, REQ-S-103~105): the signed Mac builds of the server, what the agent
// takes and runs, the one-time links, the agent's link to its local server, and the terminal's commands.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { lfDocOf, lfSign, lfSigned, lfVerify, LocalFull, localFullOf, archOf, sseMessages, Relay, localFullCli, LF_ARCHES } from '../../agent/localfull.mjs'
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
  assert.deepEqual(localFullOf({}, 4317), { on: false, port: 4327, sessionHours: 12 })
  assert.deepEqual(localFullOf({ localFull: { on: true, port: 80, sessionHours: 999 } }, 4400), { on: true, port: 4410, sessionHours: 168 })
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
    const base = { configPath, lf, site: 'https://bridge.example', agentPort: 4317, open: null, running: async () => false, fetchImpl }
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
