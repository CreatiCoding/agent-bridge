// 관리자 권한 (REQ-F-764): `:sudo` from the page and sudo in a session ask the person for the Mac's password,
// which only passes through the server to that Mac, and opens root there for 5 minutes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer } from './server-harness.mjs'
import { mac } from './fake-mac.mjs'
import { sudoWrapper, askpassScript, tailOf, SUDO_WINDOW_MS } from '../../agent/guard.mjs'

test('sudo 감싸기: -A 를 붙여 askpass 를 쓰고, -S·-n 은 그대로 넘긴다 (1.208)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-sudo-'))
  try {
    // The real sudo replaced by one that prints what it was given.
    const fake = path.join(dir, 'fake-sudo')
    fs.writeFileSync(fake, '#!/bin/sh\necho "ASKPASS=$SUDO_ASKPASS ARGS=$*"\n', { mode: 0o700 })
    const wrapper = path.join(dir, 'sudo')
    fs.writeFileSync(wrapper, sudoWrapper("/tmp/it's askpass").replaceAll('/usr/bin/sudo', fake), { mode: 0o700 })
    const run = (...args) => spawnSync(wrapper, args, { encoding: 'utf8', env: { PATH: process.env.PATH } }).stdout.trim()
    assert.equal(run('whoami'), "ASKPASS=/tmp/it's askpass ARGS=-A whoami")
    assert.equal(run('-u', 'root', 'ls', '-n'), "ASKPASS=/tmp/it's askpass ARGS=-A -u root ls -n")
    assert.equal(run('-n', 'true'), 'ASKPASS= ARGS=-n true')
    assert.equal(run('-S', 'true'), 'ASKPASS= ARGS=-S true')
    assert.equal(run('-nS', 'true'), 'ASKPASS= ARGS=-nS true')
    assert.equal(run('--non-interactive', 'true'), 'ASKPASS= ARGS=--non-interactive true')
    assert.equal(run('--', '-S'), "ASKPASS=/tmp/it's askpass ARGS=-A -- -S")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  // The helper reads the key from a file (never on its command line) and asks the agent's /askpass.
  const helper = askpassScript('/x/hook.header')
  assert.match(helper, /-H @'\/x\/hook\.header'/)
  assert.match(helper, /\/askpass\?/)
  assert.match(helper, /\[ -n "\$CB_HOOK" \] \|\| exit 1/)
  assert.equal(SUDO_WINDOW_MS, 300_000)
  assert.equal(tailOf('abc', 10), 'abc')
  assert.equal(tailOf('0123456789abc', 3), '…(앞 10자 생략)\nabc')
})

test('관리자 권한: 비밀번호를 물어 맥에만 넘기고, 5분 열린 동안은 묻지 않으며, :sudo 결과를 대화에 남긴다 (1.208)', async () => {
  const s = await startServer()
  const A = 'aaaaaaaa-0000-4000-8000-00000000000a'
  const PW = 'pw-zz9-SECRET'
  let a
  try {
    await s.login('alice')
    await s.login('bob')
    await s.login('boss')
    a = await mac(s, 'alice', A, 'mac-a')
    const started = s.api('alice', '/api/sessions', { method: 'POST', body: { hostId: A, cwd: '~', prompt: '시작' } })
    await a.answerNew()
    const sid = (await started).json.id
    const hostOf = async () => (await s.api('alice', `/api/hosts/${A}/status`)).json.host

    // Claude's sudo with no password kept: the person is asked, with what it runs.
    await a.up({ t: 'sudoask', areq: 'q1', sid, what: 'sudo whoami', need: true })
    const asked = (await hostOf()).sudo
    assert.equal(asked.until, 0)
    assert.deepEqual(asked.asks.map((x) => [x.id, x.sid, x.what]), [['q1', sid, 'sudo whoami']])
    // Only the Mac's owner types its password: not another person, not the operator.
    assert.equal((await s.api('bob', `/api/hosts/${A}/sudo`, { method: 'POST', body: { password: PW } })).status, 404)
    assert.equal((await s.api('boss', `/api/hosts/${A}/sudo`, { method: 'POST', body: { password: PW } })).status, 404)

    // A wrong one: the Mac says so, and the person is still asked.
    const wrong = s.api('alice', `/api/hosts/${A}/sudo`, { method: 'POST', body: { password: 'nope' } })
    const w = await a.next((m) => m.t === 'sudopass')
    assert.equal(w.password, 'nope')
    await a.up({ t: 'sudopass', reqId: w.reqId, ok: false, error: '비밀번호가 맞지 않아요' })
    const wr = await wrong
    assert.equal(wr.status, 403)
    assert.match(wr.json.error ?? wr.text, /맞지 않아요/)
    assert.equal((await hostOf()).sudo.asks.length, 1)

    // The right one: open for 5 minutes, and the request that waited goes through.
    const right = s.api('alice', `/api/hosts/${A}/sudo`, { method: 'POST', body: { password: PW } })
    const p = await a.next((m) => m.t === 'sudopass')
    assert.equal(p.password, PW)
    const until = Date.now() + 300_000
    await a.up({ t: 'sudopass', reqId: p.reqId, ok: true, until })
    assert.equal((await right).status, 200)
    assert.deepEqual(await a.next((m) => m.t === 'sudoans' && m.areq === 'q1'), { t: 'sudoans', areq: 'q1', ok: true })
    const opened = (await hostOf()).sudo
    assert.equal(opened.until, until)
    assert.equal(opened.asks.length, 0)

    // While open, the Mac's own check is answered at once.
    await a.up({ t: 'sudoask', areq: 'q2', sid, what: 'sudo ls', need: false })
    assert.equal((await a.next((m) => m.t === 'sudoans' && m.areq === 'q2')).ok, true)
    // Another Mac cannot speak for this session.
    const B = 'bbbbbbbb-0000-4000-8000-00000000000b'
    const b = await mac(s, 'alice', B, 'mac-b')
    await b.up({ t: 'sudoask', areq: 'q3', sid, what: 'x', need: false })
    assert.equal((await b.next((m) => m.t === 'sudoans' && m.areq === 'q3')).ok, false)
    b.close()

    // `:sudo` typed in the session: run on its Mac, what it printed in the conversation.
    assert.equal((await s.api('alice', `/api/sessions/${sid}/say`, { method: 'POST', body: { text: ':sudo whoami' } })).status, 200)
    const run = await a.next((m) => m.t === 'sudo')
    assert.deepEqual([run.sid, run.command], [sid, 'whoami'])
    await a.up({ t: 'sudo', reqId: run.reqId, ok: true, code: 0, out: 'root\n', ms: 20 })
    let events = []
    for (let i = 0; i < 40 && !events.some((e) => e.k === 'local'); i++) {
      await new Promise((r) => setTimeout(r, 100))
      events = (await s.api('alice', `/api/sessions/${sid}/events`)).json.events
    }
    assert.ok(events.some((e) => e.k === 'line' && /관리자 권한으로 실행: `whoami`/.test(e.text)))
    assert.deepEqual(events.filter((e) => e.k === 'local').map((e) => [e.text, !!e.error]), [['# whoami\nroot', false]])
    assert.equal((await s.api('alice', `/api/sessions/${sid}/say`, { method: 'POST', body: { text: ':sudo' } })).status, 400)

    // 취소: who waited is turned away. 닫기: the Mac forgets it.
    await a.up({ t: 'sudoask', areq: 'q4', sid, what: 'sudo id', need: true })
    assert.equal((await s.api('alice', `/api/hosts/${A}/sudo`, { method: 'POST', body: { cancel: true } })).status, 200)
    assert.equal((await a.next((m) => m.t === 'sudoans' && m.areq === 'q4')).ok, false)
    const off = s.api('alice', `/api/hosts/${A}/sudo`, { method: 'POST', body: { off: true } })
    const o = await a.next((m) => m.t === 'sudooff')
    await a.up({ t: 'sudooff', reqId: o.reqId, ok: true })
    assert.equal((await off).status, 200)
    assert.equal((await hostOf()).sudo.until, 0)
    // A restarted agent waits on nothing: what the page showed as waiting goes.
    await a.up({ t: 'sudoask', areq: 'q5', sid, what: 'sudo id', need: true })
    await a.up({ t: 'sudostate', until: 0, waiting: [] })
    assert.equal((await hostOf()).sudo.asks.length, 0)

    // The password passed through once and was written nowhere.
    assert.ok(!s.log().includes(PW), '서버 로그에 비밀번호가 없음')
    const files = spawnSync('grep', ['-rl', PW, s.data], { encoding: 'utf8' }).stdout.trim()
    assert.equal(files, '', '데이터 폴더에 비밀번호가 없음')
  } finally {
    a?.close()
    await s.stop()
  }
})
