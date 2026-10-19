// 개인정보 최소 처리 (REQ-S-073, REQ-S-074): what a Mac sends is kept without credentials, note contents, account
// e-mails or host names; expired sign-ins and delivered videos go.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startServer } from './server-harness.mjs'
import { mac } from './fake-mac.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const uidOf = (s) => fs.readdirSync(path.join(s.data, 'u')).find((u) => !u.startsWith('demo'))

test('작업 폴더·맥 로그·호스트 정보가 인증 정보·지침 본문·이메일·hostname 없이 남는다 (1.271)', async () => {
  const s = await startServer({ seed: { 'logins.json': { deadbeef: { uid: 'gh1', exp: Date.now() - 1000 } } } })
  let a
  try {
    await s.login('alice')
    a = await mac(s, 'alice', A, 'mac-a')
    const started = s.api('alice', '/api/sessions', { method: 'POST', body: { hostId: A, cwd: '~', prompt: '시작' } })
    await a.answerNew()
    const sid = (await started).json.id
    await a.up(
      { t: 'hello', version: '0.2.0', build: 'x', hostId: A, name: 'mac-a', kind: 'other', home: '/Users/x', info: { node: 'v22', os: 'Darwin', hostname: 'kims-mac.local' }, sessions: [{ id: sid, cwd: '/Users/x', alive: true, conv: sid }] },
      { t: 'accounts', accounts: [{ id: '', name: '기본 계정', loggedIn: true, email: 'me@example.com', plan: 'max', method: 'claude.ai' }] },
      { t: 'folder', sid, folder: { git: true, at: 1, files: { 'CLAUDE.md': '비밀 메모' }, repos: [{ dir: '.', branch: 'f', sha: 'abc', origin: 'https://me:ghp_secret1@github.com/o/r.git', push: "failed: unable to access 'https://x-access-token:ghs_secret2@github.com/o/r.git/'" }] } },
      { t: 'logs', entries: [{ ts: Date.now(), level: 'warn', area: 'push', text: "fatal: 'https://me:ghp_secret3@github.com/o/r.git' 거절" }] },
    )
    // The account e-mail is still shown while the Mac is connected.
    const st = await s.api('alice', `/api/hosts/${A}/status`)
    assert.equal(st.json.host.accounts[0].email, 'me@example.com')
    await sleep(6500)
    const uid = uidOf(s)
    const meta = JSON.parse(fs.readFileSync(path.join(s.data, 'u', uid, 's', sid, 'meta.json'), 'utf8'))
    assert.equal(meta.folder.repos[0].origin, 'https://github.com/o/r.git')
    assert.ok(!JSON.stringify(meta).includes('secret'), 'meta.json 에 토큰 없음')
    assert.deepEqual(meta.folder.files, {})
    const hosts = fs.readFileSync(path.join(s.data, 'hosts.json'), 'utf8')
    assert.ok(!hosts.includes('me@example.com') && !hosts.includes('"plan"'), 'hosts.json 에 이메일·요금제 없음')
    assert.ok(!hosts.includes('kims-mac'), 'hosts.json 에 hostname 없음')
    const hostLog = fs.readFileSync(path.join(s.data, 'u', uid, 'hosts', `${A}.log`), 'utf8')
    assert.ok(hostLog.includes('github.com/o/r.git') && !hostLog.includes('ghp_secret3'), '호스트 로그에 토큰 없음')
    assert.ok(!s.log().includes('ghp_secret3') && !s.log().includes('거절'), '표준 출력에 로그 본문 없음')
    assert.ok(!('deadbeef' in JSON.parse(fs.readFileSync(path.join(s.data, 'logins.json'), 'utf8'))), '만료된 로그인 해시는 지워짐')
  } finally {
    a?.close()
    await s.stop()
  }
})

test('저장돼 있던 작업 폴더의 토큰은 시작할 때 지워지고 지침 본문은 _legacy 로 옮겨진다 (1.271)', async () => {
  const sid = 'bbbbbbbb-0000-4000-8000-00000000000b'
  const seedMeta = { id: sid, uid: 'gh9', hostId: A, cwd: '/Users/x', title: 't', lines: 0, seq: 0, folder: { git: true, files: { 'AGENTS.md': '메모' }, repos: [{ dir: '.', origin: 'https://u:tok_old@github.com/o/r.git' }] } }
  const s = await startServer({ seed: { [`u/gh9/s/${sid}/meta.json`]: seedMeta } })
  try {
    await sleep(6000)
    const meta = JSON.parse(fs.readFileSync(path.join(s.data, 'u', 'gh9', 's', sid, 'meta.json'), 'utf8'))
    assert.equal(meta.folder.repos[0].origin, 'https://github.com/o/r.git')
    assert.deepEqual(meta.folder.files, {})
    assert.deepEqual(meta._legacy.folderFiles, { 'AGENTS.md': '메모' })
  } finally {
    await s.stop()
  }
})

test('보낸 영상은 맥이 받았다고 알리면 바로 지워진다 (1.271)', async () => {
  const s = await startServer()
  let a
  try {
    await s.login('alice')
    a = await mac(s, 'alice', A, 'mac-a')
    const started = s.api('alice', '/api/sessions', { method: 'POST', body: { hostId: A, cwd: '~', prompt: '시작' } })
    await a.answerNew()
    const sid = (await started).json.id
    const ok = await fetch(`${s.origin}/api/sessions/${sid}/upload?name=v.mov`, { method: 'POST', headers: { cookie: s.jar('alice'), 'content-type': 'video/quicktime', origin: s.origin }, body: Buffer.from('fake') })
    const { id } = await ok.json()
    const file = path.join(s.data, 'u', uidOf(s), 'uploads', id)
    assert.ok(fs.existsSync(file))
    assert.equal((await s.api('alice', `/api/sessions/${sid}/say`, { method: 'POST', body: { text: '봐 줘', videos: [{ id }] } })).status, 200)
    const send = await a.next((m) => m.t === 'send' && m.sid === sid)
    assert.ok(fs.existsSync(file), '맥이 받기 전에는 남음')
    await a.up({ t: 'delivered', sid, ids: [send.id] })
    await sleep(200)
    assert.ok(!fs.existsSync(file) && !fs.existsSync(`${file}.json`), '받은 뒤에는 없음')
  } finally {
    a?.close()
    await s.stop()
  }
})
