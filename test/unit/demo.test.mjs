// 공개 데모 (REQ-F-766, REQ-S-068) against a real server.mjs: the one-press sign-in, its limits, the allow-list,
// and the demo Mac answering through the server's own paths.
import { test, before, after, afterEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startServer } from './server-harness.mjs'
import { mac } from './fake-mac.mjs'
import { demoReply } from '../../server/demo.mjs'

import crypto from 'node:crypto'
let ipN = 0
/** Each demo from an address of its own, so the limit of 10 an hour is counted only where a test means it. */
const DEMO = { BRIDGE_DEMO: '1' }
const freshIp = () => `10.9.0.${++ipN}`

async function demoLogin(srv, { ip = freshIp(), origin = srv.origin, fetchSite } = {}) {
  const r = await fetch(`${srv.origin}/api/auth/demo`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip, ...(origin ? { origin } : {}), ...(fetchSite ? { 'sec-fetch-site': fetchSite } : {}) },
    body: '',
  })
  const jar = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  return { status: r.status, jar, text: await r.text() }
}
const as = (srv, jar) => async (p, { method = 'GET', body } = {}) => {
  const r = await fetch(`${srv.origin}${p}`, { method, redirect: 'manual', headers: { cookie: jar, ...(body !== undefined ? { 'content-type': 'application/json', origin: srv.origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: r.status, json, text }
}
/** The whole state the page is sent first on its live stream. */
async function stateOf(srv, jar) {
  const ctl = new AbortController()
  const r = await fetch(`${srv.origin}/api/classic/stream`, { headers: { cookie: jar }, signal: ctl.signal })
  const reader = r.body.getReader()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += new TextDecoder().decode(value)
    const m = /data: (\{"t":"state"[^\n]*)\n\n/.exec(buf)
    if (m) return (ctl.abort(), JSON.parse(m[1]))
  }
  throw new Error('no state')
}
/** A demo account's Mac, its seed sessions by title, and its group, once the demo Mac has listed them. */
const SEED = ['할 일 앱에 다크 모드 넣기', 'README 정리하고 테스트 돌리기', '이 앱은 무엇을 하나요?']
async function seedOf(srv, jar) {
  const st = await wait(async () => {
    const s = await stateOf(srv, jar)
    return s.sessions.length === 3 && s.sessions.every((x) => x.title) && s.sessions.some((x) => x.card) && s
  })
  return { st, host: st.hosts[0].id, sids: SEED.map((t) => st.sessions.find((x) => x.title === t)?.id), group: st.groups.groups[0] }
}
const wait = async (f, ms = 6000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('demo off', () => {
  let srv
  afterEach(() => srv?.stop())
  // 1.291: off unless BRIDGE_DEMO is exactly `1`, so a fork does not open a public demo by default.
  for (const v of [undefined, '0', 'true', '']) {
    test(`BRIDGE_DEMO=${v}: no button on the sign-in page, and /api/auth/demo is 404`, async () => {
      srv = await startServer({ env: { BRIDGE_DEMO: v } })
      const page = await (await fetch(`${srv.origin}/`)).text()
      assert.doesNotMatch(page, /데모로 둘러보기/)
      assert.equal((await demoLogin(srv)).status, 404)
    })
  }
})

describe('demo on', () => {
  let srv
  let api
  let jar
  let seed
  before(async () => {
    srv = await startServer({ env: DEMO })
    // A real person with a real Mac and a session on it: what the demo account must never reach.
    await srv.login('alice')
    const m = await mac(srv, 'alice', 'host-alice-0001', 'alice-mac')
    const started = srv.api('alice', '/api/sessions', { method: 'POST', body: { hostId: 'host-alice-0001', cwd: '~/x' } })
    await m.answerNew()
    const r = await started
    assert.equal(r.status, 200)
    srv.aliceSid = r.json.id
    const ok = await demoLogin(srv)
    assert.equal(ok.status, 302)
    jar = ok.jar
    api = as(srv, jar)
    seed = await seedOf(srv, jar)
  })
  after(() => srv?.stop())

  test('the sign-in page shows 데모로 둘러보기 as a button under GitHub: one press, no id or password', async () => {
    const page = await (await fetch(`${srv.origin}/`)).text()
    assert.match(page, /<form method="post" action="\/api\/auth\/demo"[^>]*><button class="btn" type="submit"[^>]*>데모로 둘러보기<\/button>/)
    assert.ok(page.indexOf('GitHub 로 로그인') < page.indexOf('데모로 둘러보기'))
    assert.doesNotMatch(page, /name="password"/)
  })

  test('a demo is opened only by a press on this site', async () => {
    assert.equal((await demoLogin(srv, { origin: 'https://evil.test' })).status, 403)
    assert.equal((await demoLogin(srv, { origin: null })).status, 403)
    // The site's own form under no-referrer: Origin null, and the browser's word that it is the same site.
    assert.equal((await demoLogin(srv, { origin: 'null', fetchSite: 'cross-site' })).status, 403)
    assert.equal((await demoLogin(srv, { origin: 'null', fetchSite: 'same-origin' })).status, 302)
    assert.equal((await fetch(`${srv.origin}/api/auth/demo`)).status, 405)
  })

  test('one address opens at most 10 demos an hour', async () => {
    const ip = freshIp()
    for (let i = 0; i < 10; i++) assert.equal((await demoLogin(srv, { ip })).status, 302)
    const r = await demoLogin(srv, { ip })
    assert.equal(r.status, 429)
    assert.match(r.text, /1시간에 10번까지/)
    assert.equal((await demoLogin(srv)).status, 302, '다른 주소는 그대로')
  })

  test('the account is demo by uid: not an operator, not a GitHub name', async () => {
    const me = await api('/api/me')
    assert.equal(me.status, 200)
    assert.equal(me.json.demo, true)
    assert.equal(me.json.admin, false)
    assert.equal(me.json.user.login, '심사용 데모')
    const alice = await srv.api('alice', '/api/me')
    assert.equal(alice.json.demo, undefined)
    // The operator's lists do not show it.
    await srv.login('boss')
    const access = await srv.api('boss', '/api/admin/access')
    assert.doesNotMatch(access.text, /심사용 데모/)
    const overview = await srv.api('boss', '/api/admin/overview')
    assert.doesNotMatch(overview.text, /심사용 데모|데모 맥/)
  })

  test('it sees only its demo Mac, online, with its three sessions, a group and an open card', async () => {
    const { st, host, sids, group } = seed
    assert.deepEqual(st.hosts.map((h) => [h.name, h.online]), [['데모 맥', true]])
    assert.match(host, /^demohost-[0-9a-f]{12}$/)
    assert.ok(sids.every(Boolean), '세 seed 세션')
    assert.deepEqual([group.name, group.items], ['데모 프로젝트', sids.slice(0, 2)])
    const waiting = st.sessions.find((s) => s.id === sids[1])
    assert.equal(waiting.card?.kind, 'permission')
    assert.equal(waiting.state.phase, 'waiting')
    // Another person sees none of it.
    const alice = await stateOf(srv, srv.jar('alice'))
    assert.ok(!alice.hosts.some((h) => h.id === host))
    assert.ok(!alice.sessions.some((s) => sids.includes(s.id)))
  })

  test('a message is answered by the demo Mac a moment later', async () => {
    const sid = seed.sids[0]
    const before = (await api(`/api/sessions/${sid}/events`)).json.last
    const r = await api(`/api/sessions/${sid}/say`, { method: 'POST', body: { text: '안녕하세요' } })
    assert.equal(r.status, 200, r.text)
    const answered = await wait(async () => {
      const ev = (await api(`/api/sessions/${sid}/events?after=${before}`)).json.events
      return ev.find((e) => e.k === 'text') && ev
    })
    assert.ok(answered.some((e) => e.k === 'user' && e.text === '안녕하세요'))
    assert.match(answered.find((e) => e.k === 'text').text, /데모 모드/)
  })

  test('the permission card is answered with a button', async () => {
    const sid = seed.sids[1]
    const ev = (await api(`/api/sessions/${sid}/events`)).json
    assert.ok(ev.card?.open, '열린 카드')
    const r = await api(`/api/sessions/${sid}/answer`, { method: 'POST', body: { card: ev.card.id, n: 1 } })
    assert.equal(r.status, 200, r.text)
    const after = await wait(async () => {
      const e = (await api(`/api/sessions/${sid}/events?after=${ev.last}`)).json.events
      return e.some((x) => x.k === 'card_end') && e.some((x) => x.k === 'text') && e
    })
    assert.match(after.find((x) => x.k === 'text').text, /실제 맥에서는 아무것도 실행되지/)
  })

  test('a new session on the demo Mac starts and answers its first prompt', async () => {
    const r = await api('/api/sessions', { method: 'POST', body: { hostId: seed.host, cwd: '~/projects/try', prompt: '무엇을 할 수 있어요?', create: true } })
    assert.equal(r.status, 200, r.text)
    const ev = await wait(async () => {
      const e = (await api(`/api/sessions/${r.json.id}/events`)).json.events
      return e.some((x) => x.k === 'text') && e
    })
    assert.match(ev.find((x) => x.k === 'text').text, /할 수 있어요/)
  })

  test('what is not on the allow-list is 403', async () => {
    const DEMO_HOST = seed.host
    const DEMO_SESSIONS = seed.sids
    const refused = [
      ['GET', '/api/admin/overview'],
      ['GET', '/api/admin/access'],
      ['POST', '/api/admin/models', {}],
      ['POST', '/api/bridge/hello', { hostId: 'demo-real-host-1', name: 'x' }],
      ['GET', '/api/bridge/stream?hostId=x&conn=y'],
      ['POST', '/api/qr', {}],
      ['POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/x' }],
      ['GET', '/api/push/key'],
      ['POST', '/api/plugins/slack', { enabled: true }],
      ['POST', '/api/reports', { text: 'x' }],
      ['GET', '/api/reports'],
      ['GET', '/api/skills'],
      ['GET', '/api/stream'],
      ['POST', `/api/hosts/${DEMO_HOST}/sudo`, { password: 'x' }],
      ['POST', `/api/hosts/${DEMO_HOST}/delegate`, { on: true }],
      ['POST', `/api/hosts/${DEMO_HOST}/background`, { on: true }],
      ['POST', `/api/hosts/${DEMO_HOST}/accounts`, { op: 'list' }],
      ['POST', `/api/sessions/${DEMO_SESSIONS[0]}/preview`, { port: 3000 }],
      ['POST', `/api/sessions/${DEMO_SESSIONS[0]}/lock`, { proof: 'a'.repeat(64) }],
      ['POST', `/api/sessions/${DEMO_SESSIONS[0]}/lightfork`, {}],
      ['POST', `/api/sessions/${DEMO_SESSIONS[0]}/move`, {}],
      ['POST', `/api/sessions/${DEMO_SESSIONS[0]}/seat`, { to: 'slack' }],
      ['POST', `/api/sessions/${DEMO_SESSIONS[0]}/say`, { text: ':sudo whoami' }],
      ['POST', `/api/sessions/${DEMO_SESSIONS[0]}/say`, { text: '그림', images: [{ data: 'data:image/png;base64,AAAA' }] }],
    ]
    for (const [method, p, body] of refused) {
      const r = await api(p, { method, body })
      assert.equal(r.status, 403, `${method} ${p} → ${r.status} ${r.text.slice(0, 120)}`)
      assert.match(r.json?.error ?? '', /데모에서는/)
    }
    // A video goes up as it is, not as JSON.
    const up = await fetch(`${srv.origin}/api/sessions/${seed.sids[0]}/upload?name=a.mp4`, { method: 'POST', headers: { cookie: jar, origin: srv.origin, 'content-type': 'video/mp4' }, body: Buffer.alloc(1024) })
    assert.equal(up.status, 403)
  })

  test("a real Mac's id or another person's session id is 403, in the path or in the body", async () => {
    const alice = srv.aliceSid
    for (const [method, p, body] of [
      ['GET', '/api/hosts/host-alice-0001/status'],
      ['GET', '/api/hosts/host-alice-0001/dirs'],
      ['GET', `/api/sessions/${alice}/events`],
      ['POST', `/api/sessions/${alice}/say`, { text: 'hi' }],
      ['POST', `/api/sessions/${alice}/answer`, { card: 'x', n: 1 }],
      ['DELETE', `/api/sessions/${alice}`],
      ['POST', '/api/sessions', { hostId: 'host-alice-0001', cwd: '~' }],
      ['POST', `/api/sessions/${seed.sids[0]}/resume`, { hostId: 'host-alice-0001' }],
      ['POST', '/api/groups', { op: 'move', session: alice }],
      ['GET', '/api/sessions/no-such-session-1/events'],
    ]) {
      const r = await api(p, { method, body })
      assert.equal(r.status, 403, `${method} ${p} → ${r.status}`)
    }
    // Nor can a real Mac take a demo Mac's id.
    assert.equal((await srv.api('alice', '/api/bridge/hello', { method: 'POST', body: { hostId: seed.host, name: 'x' } })).status, 403)
    assert.equal((await srv.api('alice', '/api/bridge/hello', { method: 'POST', body: { hostId: 'demohost-000000000000', name: 'x' } })).status, 403)
    // Alice's session is as it was.
    const ev = await srv.api('alice', `/api/sessions/${alice}/events`)
    assert.equal(ev.status, 200)
    assert.ok(!ev.json.events.some((e) => e.k === 'user' && e.text === 'hi'))
  })

  test('the settings, the voice screen and 복제 work in the demo', async () => {
    assert.equal((await api('/api/plugins')).status, 200)
    assert.equal((await api('/api/prefs/icons', { method: 'POST', body: { size: 20, fill: 1 } })).status, 200)
    assert.equal((await api('/api/prefs/voice')).json.on, true, '음성 입력이 켜져 있다')
    const v = await api(`/api/sessions/${seed.sids[0]}/voice`, { method: 'POST', body: { audio: 'AAAA' } })
    assert.equal(v.status, 502)
    assert.equal(v.json.code, 'demo')
    assert.match(v.json.error, /데모 모드라 실제 받아쓰기는 하지 않아요/)
    const host = await api(`/api/hosts/${seed.host}/status`)
    assert.equal(host.json.host.voice.whisper, true, '음성 준비 상태가 보인다')
    const f = await api(`/api/sessions/${seed.sids[0]}/fork`, { method: 'POST', body: {} })
    assert.equal(f.status, 200, f.text)
    const ev = (await api(`/api/sessions/${f.json.id}/events`)).json.events
    assert.ok(ev.some((e) => e.k === 'text' && /다크 모드를 넣었어요/.test(e.text)), '복제에 대화가 따라옴')
  })

  test('two visitors at once each have their own demo, and neither reaches the other', async () => {
    const b = await demoLogin(srv)
    const apiB = as(srv, b.jar)
    const seedB = await seedOf(srv, b.jar)
    assert.notEqual(seedB.host, seed.host)
    assert.ok(seedB.sids.every((x) => !seed.sids.includes(x)))
    // B clears a session and renames the group: A's are as they were.
    assert.equal((await apiB(`/api/sessions/${seedB.sids[2]}`, { method: 'DELETE' })).status, 200)
    assert.equal((await apiB('/api/groups', { method: 'POST', body: { op: 'rename', id: seedB.group.id, name: '바뀜' } })).status, 200)
    const a = await stateOf(srv, jar)
    assert.ok(a.sessions.some((x) => x.id === seed.sids[2]))
    assert.equal(a.groups.groups[0].name, '데모 프로젝트')
    // Neither reaches the other's Mac or sessions.
    assert.equal((await apiB(`/api/sessions/${seed.sids[0]}/events`)).status, 403)
    assert.equal((await apiB(`/api/hosts/${seed.host}/status`)).status, 403)
    assert.equal((await api(`/api/sessions/${seedB.sids[0]}/say`, { method: 'POST', body: { text: 'x' } })).status, 403)
    assert.equal((await apiB('/api/sessions', { method: 'POST', body: { hostId: seed.host, cwd: '~' } })).status, 403)
    // 계정 삭제 in B's demo puts only B's back to the seed (REQ-F-770 rule 7); A's session is still there.
    const del = await apiB('/api/account/delete', { method: 'POST', body: { login: '심사용 데모' } })
    assert.equal(del.status, 200, del.text)
    assert.equal(del.json.demo, true)
    assert.equal((await seedOf(srv, b.jar)).st.sessions.length, 3)
    assert.equal((await api(`/api/sessions/${seed.sids[0]}/events`)).status, 200)
  })

  test('another press starts from the seed', async () => {
    const again = await demoLogin(srv)
    const s = await seedOf(srv, again.jar)
    assert.equal(s.st.sessions.length, 3)
    assert.equal(s.group.name, '데모 프로젝트')
  })

  test('a demo sends at most 2,000 characters a message and 20 sends a minute, and has at most 20 sessions', async () => {
    const d = await demoLogin(srv)
    const apiD = as(srv, d.jar)
    const { sids, host } = await seedOf(srv, d.jar)
    const long = await apiD(`/api/sessions/${sids[0]}/say`, { method: 'POST', body: { text: 'x'.repeat(2001) } })
    assert.equal(long.status, 413)
    assert.match(long.json.error, /2,000자까지/)
    // 17 new sessions make 20; the 21st is refused. They are sends too: 17 of the 20 a minute.
    for (let i = 0; i < 17; i++) assert.equal((await apiD('/api/sessions', { method: 'POST', body: { hostId: host, cwd: `~/p${i}` } })).status, 200)
    const more = await apiD('/api/sessions', { method: 'POST', body: { hostId: host, cwd: '~/p18' } })
    assert.equal(more.status, 403)
    assert.match(more.json.error, /20개까지/)
    // The 18th was a send too: two more fit in the minute, the third does not.
    assert.equal((await apiD(`/api/sessions/${sids[0]}/say`, { method: 'POST', body: { text: '하나' } })).status, 200)
    assert.equal((await apiD(`/api/sessions/${sids[0]}/say`, { method: 'POST', body: { text: '둘' } })).status, 200)
    const fast = await apiD(`/api/sessions/${sids[0]}/say`, { method: 'POST', body: { text: '셋' } })
    assert.equal(fast.status, 429)
    assert.match(fast.json.error, /1분에 20번까지/)
  })
})

describe('demo limits and lasting sign-ins', () => {
  test('at most 50 demos at once: the 51st waits while all are in use', async () => {
    const srv = await startServer({ env: DEMO })
    try {
      for (let i = 0; i < 50; i++) assert.equal((await demoLogin(srv, { ip: `10.8.${Math.floor(i / 10)}.1` })).status, 302)
      const r = await demoLogin(srv, { ip: '10.8.99.1' })
      assert.equal(r.status, 503)
      assert.match(r.text, /데모를 쓰는 사람이 많아요/)
    } finally {
      await srv.stop()
    }
  })

  test('a demo sign-in does not run out: after a restart it comes back from the seed', async () => {
    // A demo token a former run handed out, its account gone with that run.
    const token = crypto.randomBytes(32).toString('base64url')
    const hash = crypto.createHash('sha256').update(token).digest('hex')
    const srv = await startServer({ env: DEMO, seed: { 'logins.json': { [hash]: { uid: 'demo-0123456789ab', exp: Date.now() + 86_400_000 } } } })
    try {
      const jar = `cb=${token}`
      const me = await as(srv, jar)('/api/me')
      assert.equal(me.status, 200)
      assert.equal(me.json.demo, true)
      assert.equal((await seedOf(srv, jar)).st.sessions.length, 3)
    } finally {
      await srv.stop()
    }
  })
})

describe('demo state on disk', () => {
  test('the demo account and its Mac are never written to users.json or hosts.json', async () => {
    const srv = await startServer({ env: DEMO })
    try {
      assert.equal((await demoLogin(srv)).status, 302)
      await srv.login('alice')
      await new Promise((r) => setTimeout(r, 5600))
      const fs = await import('node:fs')
      const users = JSON.parse(fs.readFileSync(`${srv.data}/users.json`, 'utf8'))
      const hosts = JSON.parse(fs.readFileSync(`${srv.data}/hosts.json`, 'utf8'))
      assert.ok(users['dev-alice'])
      assert.ok(!Object.keys(users).some((k) => k.startsWith('demo')))
      assert.ok(!Object.keys(hosts).some((k) => k.startsWith('demohost-')))
    } finally {
      await srv.stop()
    }
  })
})

test('the demo replies: the default says it is the demo, the permission words ask with a card', () => {
  assert.match(demoReply('아무 말').text, /데모 모드예요\. 실제 맥에 연결돼 있지 않아요/)
  assert.ok(demoReply('권한 요청 보여 줘').permission)
  assert.match(demoReply('코드 예시 보여 줘').text, /```ts/)
})
