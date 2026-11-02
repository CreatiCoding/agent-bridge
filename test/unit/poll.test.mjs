// 스트림이 막힌 네트워크 (REQ-F-849): a page and a Mac's bridge tab that fetch instead of streaming, against the
// real server. The Mac here is played through /api/bridge/poll only, so a command that reaches it went that way.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './server-harness.mjs'

const H = 'aaaaaaaa-0000-4000-8000-0000000000d1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pid = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')

/** A Mac whose bridge tab fetches its commands. */
async function pollMac(s, who, hostId) {
  const hello = await s.api(who, '/api/bridge/hello', { method: 'POST', body: { hostId, name: 'mac' } })
  assert.equal(hello.status, 200)
  const conn = hello.json.conn
  const got = []
  const answers = []
  let since = 0
  let on = true
  const loop = (async () => {
    while (on) {
      const r = await s.api(who, `/api/bridge/poll?hostId=${hostId}&conn=${conn}&since=${since}&wait=2`).catch(() => null)
      if (!r) return
      if (r.status !== 200) {
        answers.push(r)
        await sleep(300)
        continue
      }
      answers.push(r.json)
      since = r.json.last
      for (const d of r.json.msgs) got.push(JSON.parse(d))
      await sleep(250)
    }
  })()
  const next = async (pick, ms = 8000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
      const i = got.findIndex(pick)
      if (i >= 0) return got.splice(i, 1)[0]
    }
    throw new Error('기다린 명령이 오지 않음')
  }
  const up = (...msgs) => s.api(who, '/api/bridge/up', { method: 'POST', body: { hostId, conn, msgs } })
  return { conn, next, up, answers, stop: () => ((on = false), loop) }
}

test('폴링 (AC-1571): 조작 화면과 연동 탭이 스트림 없이 같은 것을 받는다', async () => {
  const s = await startServer()
  let m
  try {
    await s.login('alice')
    await s.login('bob')
    m = await pollMac(s, 'alice', H)
    const me = pid()
    // The first fetch starts from the whole state (AC-1571).
    let r = await s.api('alice', `/api/classic/poll?pid=${me}&since=0&wait=0`)
    assert.equal(r.status, 200)
    assert.equal(r.json.reset, true)
    const st = JSON.parse(r.json.msgs[0])
    assert.equal(st.t, 'state')
    assert.ok(st.hosts.some((h) => h.id === H), '연동 탭이 폴링으로 붙은 맥이 목록에 있음')
    let since = r.json.last

    // A command reaches the Mac through its fetches, and its answer comes back (AC-1571).
    const started = s.api('alice', '/api/sessions', { method: 'POST', body: { hostId: H, cwd: '~', prompt: '시작' } })
    const cmd = await m.next((x) => x.t === 'new')
    assert.ok(cmd.reqId)
    await m.up({ t: 'got', reqId: cmd.reqId }, { t: 'opened', reqId: cmd.reqId, sid: cmd.sid, ok: true, cwd: '/Users/x' })
    const sid = (await started).json.id
    assert.ok(sid)

    // The page hears of it as a stream would say it: only what changed (AC-1571).
    await sleep(600)
    r = await s.api('alice', `/api/classic/poll?pid=${me}&since=${since}&wait=5`)
    assert.equal(r.status, 200)
    assert.equal(r.json.reset, false)
    const deltas = r.json.msgs.map((d) => JSON.parse(d)).filter((x) => x.t === 'state_delta')
    assert.ok(deltas.some((d) => d.changed?.some((row) => row.id === sid)), '새 세션이 state_delta 로 옴')
    since = r.json.last

    // Too soon without waiting: refused (AC-1571).
    await s.api('alice', `/api/classic/poll?pid=${me}&since=${since}&wait=0`)
    r = await s.api('alice', `/api/classic/poll?pid=${me}&since=${since}&wait=0`)
    assert.equal(r.status, 429)

    // An older since than one already answered (a late or retried request): stale, nothing changes (AC-1571).
    await sleep(600)
    r = await s.api('alice', `/api/classic/poll?pid=${me}&since=0&wait=0`)
    assert.equal(r.status, 410)
    // A number it was never given: starts over from the whole state (AC-1571).
    await sleep(600)
    r = await s.api('alice', `/api/classic/poll?pid=${me}&since=999999&wait=0`)
    assert.equal(r.json.reset, true)
    assert.equal(r.json.since, 999999)
    assert.equal(JSON.parse(r.json.msgs[0]).t, 'state')

    // Another person with the same pid gets their own place, never alice's (AC-1571).
    r = await s.api('bob', `/api/classic/poll?pid=${me}&since=0&wait=0`)
    assert.equal(r.status, 200)
    assert.equal(JSON.parse(r.json.msgs[0]).sessions.length, 0)
    // Not signed in, and a wrong conn for the bridge tab: refused (AC-1571).
    assert.equal((await fetch(`${s.origin}/api/classic/poll?pid=${me}&since=0`)).status, 401)
    assert.equal((await s.api('alice', `/api/bridge/poll?hostId=${H}&conn=nope&since=0`)).status, 409)
    assert.equal((await s.api('alice', `/api/classic/poll?pid=xyz&since=0`)).status, 400)
  } finally {
    await m?.stop()
    await s.stop()
  }
})

test('탐침 (AC-1572): 1초 간격의 메시지 다섯 개를 따로따로 보내고 끝난다', async () => {
  const s = await startServer()
  try {
    await s.login('alice')
    const res = await fetch(`${s.origin}/api/classic/stream?probe=1`, { headers: { cookie: s.jar('alice') } })
    assert.equal(res.headers.get('content-type'), 'text/event-stream')
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    const at = []
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (chunk.startsWith('data: ')) at.push([JSON.parse(chunk.slice(6)).n, Date.now()])
      }
    }
    assert.deepEqual(at.map((x) => x[0]), [0, 1, 2, 3, 4])
    assert.ok(at[4][1] - at[0][1] >= 3500, '메시지가 시간 간격을 두고 옴')
  } finally {
    await s.stop()
  }
})
