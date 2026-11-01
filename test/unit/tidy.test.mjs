// 세션 정리 (REQ-F-835~837): the pure judgements the agent's hourly batch makes. Each boundary the SPEC names is here:
// exactly N days, a working session, one waiting on a dialog, one pinned, unpushed commits, a loop within 24 hours.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DAY_MS, idleStopWhy, restAct, folderTidyWhy, transcriptTidyWhy, tidyPolicyOf, humanLine, lastHumanLine, lastTurnLine, TIDY_DEFAULTS } from '../../agent/guard.mjs'

const NOW = Date.UTC(2026, 10, 1, 12)
const auto = { mode: 'auto', idleStopDays: 3 }
const H = 3600_000
// A live, idle session whose last human input was `ago` ms before NOW.
const s = (ago, extra = {}) => ({ alive: true, lastHumanAt: NOW - ago, lastTurnAt: NOW - ago, noticeAt: null, ...extra })

test('tidyPolicyOf: defaults, and only sane values taken', () => {
  assert.deepEqual(tidyPolicyOf(null), { ...TIDY_DEFAULTS })
  assert.deepEqual(tidyPolicyOf({ mode: 'x', idleStopDays: -1, restDays: 1.5, transcriptMB: 0 }), { ...TIDY_DEFAULTS })
  assert.equal(tidyPolicyOf({ mode: 'suggest', idleStopDays: 0 }).idleStopDays, 0)
  assert.equal(tidyPolicyOf({ mode: 'suggest' }).mode, 'suggest')
})

test('idleStopWhy (AC-1513): notice a day ahead, stop at exactly N days once told 24 hours before', () => {
  // Not yet: 2 days − 1 ms since the last input.
  assert.deepEqual(idleStopWhy(s(2 * DAY_MS - 1), NOW, auto), { act: null, why: null, stopAt: null })
  // Exactly 2 days, never told: told now, to stop at input + 3 days.
  assert.deepEqual(idleStopWhy(s(2 * DAY_MS), NOW, auto), { act: 'notice', why: null, stopAt: NOW + DAY_MS })
  // Told a day ago, exactly 3 days since the input: stopped.
  assert.equal(idleStopWhy(s(3 * DAY_MS, { noticeAt: NOW - DAY_MS }), NOW, auto).act, 'stop')
  // Told a day ago, 3 days − 1 ms: waits.
  const w = idleStopWhy(s(3 * DAY_MS - 1, { noticeAt: NOW - DAY_MS }), NOW, auto)
  assert.equal(w.act, 'wait')
  assert.equal(w.stopAt, NOW + 1)
  assert.match(w.why, /^예고함 · /)
  // Five days without a notice (the agent was off): told now, stopped a day later, never without a notice.
  assert.deepEqual(idleStopWhy(s(5 * DAY_MS), NOW, auto), { act: 'notice', why: null, stopAt: NOW + DAY_MS })
  // Told 23 hours ago although the days are long past: not yet.
  assert.equal(idleStopWhy(s(5 * DAY_MS, { noticeAt: NOW - 23 * H }), NOW, auto).act, 'wait')
  // A notice from before the last input is stale: told again.
  assert.equal(idleStopWhy(s(2 * DAY_MS, { noticeAt: NOW - 2 * DAY_MS - 1 }), NOW, auto).act, 'notice')
})

test('idleStopWhy (AC-1513): what is never stopped', () => {
  const old = (extra) => idleStopWhy(s(10 * DAY_MS, { noticeAt: NOW - 2 * DAY_MS, ...extra }), NOW, auto)
  assert.equal(old({}).act, 'stop')
  assert.deepEqual(old({ turn: true }), { act: null, why: '작업 중', stopAt: null })
  assert.equal(old({ waiting: true }).why, '확인을 기다리는 중')
  assert.equal(old({ keepAlive: true }).why, '자동 종료 안 함으로 고정')
  assert.equal(old({ delegate: true }).why, '맡긴 일을 기다리는 중')
  assert.equal(old({ locked: true }).why, '잠긴 세션')
  assert.equal(old({ reportAuto: true }).why, '자동 대응 중')
  assert.equal(old({ changing: true }).why, '바뀌는 중')
  // A loop: its last turn ended 23h59m ago, though no person typed for 10 days.
  assert.equal(old({ lastTurnAt: NOW - DAY_MS + 60_000 }).why, '스스로 일하는 중(마지막 턴이 24시간 안)')
  // Exactly 24 hours: no longer held.
  assert.equal(old({ lastTurnAt: NOW - DAY_MS }).act, 'stop')
  // Already stopped: REQ-F-836's business.
  assert.equal(old({ alive: false }).act, null)
})

test('idleStopWhy: suggest only counts, off does nothing, by hand skips the days but not the work', () => {
  assert.equal(idleStopWhy(s(3 * DAY_MS), NOW, { mode: 'suggest', idleStopDays: 3 }).act, 'suggest')
  assert.equal(idleStopWhy(s(3 * DAY_MS - 1), NOW, { mode: 'suggest', idleStopDays: 3 }).act, null)
  assert.equal(idleStopWhy(s(9 * DAY_MS), NOW, { mode: 'off' }).why, '자동 종료 꺼짐')
  assert.equal(idleStopWhy(s(9 * DAY_MS), NOW, { mode: 'auto', idleStopDays: 0 }).why, '자동 종료 꺼짐')
  assert.equal(idleStopWhy(s(H), NOW, auto, true).act, 'stop')
  assert.equal(idleStopWhy(s(H, { keepAlive: true }), NOW, auto, true).act, 'stop', '손으로 내리면 고정은 막지 않음')
  assert.equal(idleStopWhy(s(H, { turn: true }), NOW, auto, true).why, '작업 중')
  assert.equal(idleStopWhy(s(H, { alive: false }), NOW, auto, true).why, '이미 claude 가 내려가 있어요')
})

test('restAct (AC-1515): rest at exactly 7 days, close offered at exactly 30', () => {
  const p = { mode: 'auto', restDays: 7, closeSuggestDays: 30 }
  const st = (ago, extra = {}) => ({ alive: false, resting: false, lastHumanAt: NOW - ago, ...extra })
  assert.deepEqual(restAct(st(7 * DAY_MS), NOW, p), { rest: true, close: false })
  assert.deepEqual(restAct(st(7 * DAY_MS - 1), NOW, p), { rest: false, close: false })
  assert.deepEqual(restAct(st(8 * DAY_MS, { resting: true }), NOW, p), { rest: false, close: false })
  assert.deepEqual(restAct(st(8 * DAY_MS, { alive: true }), NOW, p), { rest: false, close: false })
  assert.deepEqual(restAct(st(30 * DAY_MS, { resting: true }), NOW, p), { rest: false, close: true })
  assert.deepEqual(restAct(st(40 * DAY_MS, { keepAlive: true }), NOW, p), { rest: false, close: false })
})

test('folderTidyWhy (AC-1514): only an untouched, clean folder under the root goes by itself', () => {
  const p = { mode: 'auto', folderTrashDays: 14 }
  const f = (extra) => folderTidyWhy({ kind: 'works', repos: [], lastAt: NOW - 14 * DAY_MS, ...extra }, NOW, p)
  assert.deepEqual(f({}), { auto: true, why: '14일 넘게 안 씀 · 자동 정리 대상' })
  assert.deepEqual(f({ lastAt: NOW - 14 * DAY_MS + H }), { auto: false, why: '최근 13일 안에 씀' })
  assert.equal(f({ repos: [{ dirty: false, unpushed: 0, stash: 0 }], lastAt: NOW - 15 * DAY_MS }).auto, true)
  assert.deepEqual(f({ repos: [{ unpushed: 1 }] }), { auto: false, why: '안 올린 커밋 1개' })
  assert.deepEqual(f({ repos: [{ stash: 2 }] }), { auto: false, why: 'stash 2개' })
  assert.deepEqual(f({ repos: [{ dirty: true, unpushed: 3 }] }), { auto: false, why: '고친 것·새 파일이 남아 있음' })
  assert.deepEqual(f({ repos: [{ worktree: true }] }), { auto: false, why: 'git worktree 가 들어 있음(머지된 worktree 정리를 쓰세요)' })
  assert.deepEqual(f({ kind: 'ended' }), { auto: false, why: '사용자 폴더라 자동으로 옮기지 않음' })
  assert.deepEqual(f({ endedAt: NOW - 3 * DAY_MS }), { auto: false, why: '끝난 지 3일' })
  assert.deepEqual(f({ trashWhy: '홈 바로 아래 폴더는 옮길 수 없어요' }), { auto: false, why: '홈 바로 아래 폴더는 옮길 수 없어요' })
  assert.deepEqual(folderTidyWhy({ kind: 'works', repos: [], lastAt: 0 }, NOW, { mode: 'auto', folderTrashDays: 0 }), { auto: false, why: '폴더 자동 정리 꺼짐' })
  assert.deepEqual(folderTidyWhy({ kind: 'works', repos: [], lastAt: 0 }, NOW, { mode: 'off' }), { auto: false, why: '폴더 자동 정리 꺼짐' })
})

test('transcriptTidyWhy (AC-1515): old and big, and not an open session', () => {
  const p = { mode: 'auto', transcriptDays: 30, transcriptMB: 10 }
  const MB = 1024 * 1024
  assert.equal(transcriptTidyWhy({ size: 10 * MB, lastAt: NOW - 30 * DAY_MS }, NOW, p), '30일 안 씀 · 10 MB')
  assert.equal(transcriptTidyWhy({ size: 10 * MB - 1, lastAt: NOW - 30 * DAY_MS }, NOW, p), null)
  assert.equal(transcriptTidyWhy({ size: 50 * MB, lastAt: NOW - 29 * DAY_MS }, NOW, p), null)
  assert.equal(transcriptTidyWhy({ size: 50 * MB, lastAt: 0, open: true }, NOW, p), null)
})

test('lastHumanLine: the last line a person typed, not tool results, meta lines or command echoes', () => {
  const at = (h) => new Date(NOW - h * H).toISOString()
  const lines = [
    { type: 'user', timestamp: at(50), message: { content: '이거 고쳐 줘' } },
    { type: 'assistant', timestamp: at(49), message: { content: [{ type: 'text', text: '네' }] } },
    { type: 'user', timestamp: at(48), message: { content: [{ type: 'text', text: '좋아요, 그리고 테스트도' }] } },
    { type: 'user', timestamp: at(47), message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'user', timestamp: at(46), toolUseResult: {}, message: { content: [{ type: 'text', text: 'x' }] } },
    { type: 'user', timestamp: at(45), isMeta: true, message: { content: 'meta' } },
    { type: 'user', timestamp: at(44), message: { content: '<command-name>/clear</command-name>' } },
    { type: 'user', timestamp: at(43), message: { content: '<task-notification>done</task-notification>' } },
    { type: 'assistant', timestamp: at(2), message: { content: [{ type: 'text', text: '끝' }] } },
  ]
  // A first line cut in half (read from the middle of the file) is skipped.
  const text = '{"type":"user","timest' + '\n' + lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  assert.equal(lastHumanLine(text), NOW - 48 * H)
  assert.equal(lastTurnLine(text), NOW - 2 * H)
  assert.equal(lastHumanLine('{"type":"assistant","timestamp":"2026-01-01T00:00:00Z"}'), null)
  assert.equal(humanLine({ type: 'user', message: { content: '  ' } }), false)
})

test('IF-264 (AC-1518): the owner reads and sets it, others do not; tidyAsk gets the policy and holds', async () => {
  const { startServer } = await import('./server-harness.mjs')
  const { mac } = await import('./fake-mac.mjs')
  const srv = await startServer()
  try {
    for (const who of ['alice', 'bob']) await srv.login(who)
    const id = 'aaaaaaaa-0000-4000-8000-0000000000e1'
    const m = await mac(srv, 'alice', id, 'tidy')
    const tidy = (who, body) => srv.api(who, `/api/hosts/${id}/tidy`, { method: 'POST', body })
    const r = await tidy('alice', { op: 'report' })
    assert.equal(r.status, 200)
    assert.equal(r.json.report, null)
    // alice is not an operator: her Mac waits for her to turn it on.
    assert.equal(r.json.policy.mode, 'suggest')
    assert.equal(r.json.policy.why, 'owner')
    assert.equal((await tidy('bob', { op: 'report' })).status, 404)
    assert.equal((await tidy('alice', { op: 'nope' })).status, 400)
    assert.equal((await tidy('alice', { op: 'settings', scope: 'host', mode: 'x' })).status, 400)
    const set = await tidy('alice', { op: 'settings', scope: 'account', mode: 'auto', idleStopDays: 5 })
    assert.equal(set.status, 200)
    assert.equal(set.json.policy.mode, 'auto')
    assert.equal(set.json.policy.idleStopDays, 5)
    assert.equal((await tidy('alice', { op: 'settings', scope: 'host', idleStopDays: 2 })).json.policy.idleStopDays, 2, '기기가 계정보다 먼저')
    await m.up({ t: 'tidyAsk' })
    const run = await m.next((x) => x.t === 'tidyRun')
    assert.equal(run.policy.idleStopDays, 2)
    assert.deepEqual(run.roots, ['~/bridge/works'])
    assert.deepEqual(run.holds, {})
    await m.up({ t: 'tidyReport', report: { at: Date.now(), mode: 'auto', local: { date: '2026-11-02', hour: 3 }, sessions: [], folders: [{ path: '~/bridge/works/기타/a', kind: 'works', size: 1, lastAt: 0, auto: false, why: '안 올린 커밋 1개' }], transcripts: [], done: {}, would: {} } })
    const after = await tidy('alice', { op: 'report' })
    assert.equal(after.json.report.folders[0].why, '안 올린 커밋 1개')
    assert.equal((await tidy('alice', { op: 'stop', sids: ['nope'] })).status, 400, '그 맥의 세션이 아님')
    m.close()
  } finally {
    await srv.stop()
  }
})
