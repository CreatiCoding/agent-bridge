// 실행기 전환의 잠금 (REQ-F-891 규칙 12, AC-1707): only the switch that set `s.switching` takes it off. A refused call
// (a second switch, a bad runner) used to take it off in its finally, so a third switch stopped the terminal again
// while the first still waited on it. switchRunner runs here as written in agent.mjs, with the terminal and files mocked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const src = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
const start = src.indexOf('async function switchRunner(')
const body = src.slice(start, src.indexOf('\n}\n', start) + 2)

function rig() {
  const sessions = new Map()
  const emitted = []
  const kills = []
  const launched = []
  class SessionClosed extends Error {}
  const ctx = {
    sessions, SessionClosed, console, Error, Object, String, crypto: { randomUUID: () => 'new-conv' },
    fs: { existsSync: () => false, rmSync() {}, readFileSync: () => '', mkdirSync() {}, copyFileSync() {} },
    path: { basename: (p) => String(p).split('/').pop(), dirname: (p) => p },
    isClaude: (s) => !s.runner || s.runner === 'claude',
    safeConvId: (id) => typeof id === 'string' && /^[\w-]{1,80}$/.test(id),
    codexVersion: '0.166.0', codexModeStr: (m) => m, parseCodexMode: (m) => m ?? 'workspace-write',
    CODEX_ID_RE: /^[\w-]+$/, findRollout: () => null, codexRoot: () => '/x', mirrorPath: () => '/x', syncMirror() {}, codexEffortOk: () => false,
    safeAccountId: () => true, accountDir: () => null, EFFORTS: [], MODES: [], transcriptPath: () => '/x.jsonl', findTranscript: () => null, settingsArgs: () => [],
    tail() {}, resetRuntime(t) { Object.assign(t, { starting: false, turn: null, running: new Map(), wait: null, card: null, held: t.held ?? [] }) },
    // Each terminal stop waits until the test lets it go.
    tmux: (...a) => new Promise((resolve) => kills.push({ a, done: resolve })),
    launch: async (sid, t) => { launched.push(sid); t.launching = true; await Promise.resolve(); t.launching = false },
    emit: (m) => emitted.push(m), log() {}, note() {}, saveSessions() {}, publish() {},
    CLAUDE: { name: 'Claude Code' }, RUNNERS: { codex: { name: 'Codex' } }, can: () => false, commands: {},
    clearTimeout,
  }
  vm.createContext(ctx)
  vm.runInContext(`${body}; this.switchRunner = switchRunner`, ctx)
  const s = { cwd: '/w', tmux: 'b-s1', runner: 'codex', running: new Map(), held: [] }
  sessions.set('s1', s)
  return { ctx, sessions, s, emitted, kills, launched }
}
const settle = () => new Promise((r) => setImmediate(r))
const reply = (emitted, reqId) => emitted.find((m) => m.reqId === reqId)

test('a refused second switch leaves the first switch guarded; a third is refused too, and the terminal stops once', async () => {
  const { ctx, s, emitted, kills, launched } = rig()
  const first = ctx.switchRunner({ reqId: 'r1', sid: 's1', runner: 'claude' })
  await settle()
  assert.equal(s.switching, true)
  assert.equal(kills.length, 1)
  await ctx.switchRunner({ reqId: 'r2', sid: 's1', runner: 'claude' })
  assert.equal(reply(emitted, 'r2').error, '이미 실행기를 바꾸는 중이에요')
  assert.equal(s.switching, true, '거절된 요청이 첫 요청의 잠금을 풀면 안 됨')
  await ctx.switchRunner({ reqId: 'r3', sid: 's1', runner: 'claude' })
  assert.equal(reply(emitted, 'r3').error, '이미 실행기를 바꾸는 중이에요')
  assert.equal(kills.length, 1, '터미널 내리기가 겹치면 안 됨')
  kills[0].done()
  await first
  assert.equal(reply(emitted, 'r1').ok, true)
  assert.deepEqual(launched, ['s1'])
  assert.equal(s.switching, undefined, '첫 요청은 끝나면 자기 잠금을 푼다')
})

test('a switch refused for a bad runner, the same runner or a missing session does not take the guard off', async () => {
  const { ctx, s, emitted, kills } = rig()
  const first = ctx.switchRunner({ reqId: 'r1', sid: 's1', runner: 'claude' })
  await settle()
  await ctx.switchRunner({ reqId: 'bad', sid: 's1', runner: 'gemini' })
  await ctx.switchRunner({ reqId: 'same', sid: 's1', runner: 'codex' })
  await ctx.switchRunner({ reqId: 'none', sid: 'nope', runner: 'claude' })
  assert.equal(reply(emitted, 'bad').error, '이 맥에서 그 실행기를 쓸 수 없어요')
  assert.equal(reply(emitted, 'same').error, '이미 그 실행기로 도는 세션이에요')
  assert.equal(reply(emitted, 'none').error, '이 맥에 그 세션이 없어요')
  assert.equal(s.switching, true)
  kills[0].done()
  await first
  assert.equal(s.switching, undefined)
})

test('a close while the terminal goes: no new runner, the guard comes off, the session stays closed', async () => {
  const { ctx, s, sessions, emitted, kills, launched } = rig()
  const first = ctx.switchRunner({ reqId: 'r1', sid: 's1', runner: 'claude' })
  await settle()
  await ctx.switchRunner({ reqId: 'r2', sid: 's1', runner: 'claude' })
  s.closed = true
  kills[0].done()
  await first
  assert.equal(reply(emitted, 'r1').error, '전환하는 사이 세션이 닫혔어요')
  assert.deepEqual(launched, [])
  assert.equal(sessions.get('s1'), s)
  assert.equal(s.switching, undefined)
})

test('open and messages look at the same guard while a switch runs (agent.mjs)', () => {
  // A reopen is refused and a message is held while `switching` is set, so a refused switch must not clear it.
  assert.match(src, /if \(sessions\.get\(sid\)\?\.switching\) throw new Error\('실행기를 바꾸는 중이에요\. 끝난 뒤 다시 열어 주세요'\)/)
  assert.match(src, /if \(s\.starting \|\| s\.switching\) return \(toast\(sid, '세션이 뜨면 바로 전달할게요'\), hold\(/)
  assert.match(body, /s\.switching = true\n\s*locked = true\n/)
  assert.match(body, /finally \{\n\s*if \(locked\) delete s\.switching\n\s*\}/)
})
