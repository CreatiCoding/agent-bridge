// 쓰는 중이면 기다렸다 가져오기 (REQ-F-867, AC-1623): the busy refusal is waited out, anything else is not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ADOPT_BUSY, ADOPT_RETRY_MS, ADOPT_WAIT_MS, adoptControl, adoptEach, AdoptLeft, adoptWhenFree, AdoptWaitStopped } from '../../ui/src/lib/adopt-wait.ts'

const BUSY = '다른 도구(터미널 등)가 이 대화를 지금 쓰는 중이에요. 그쪽에서 끝난 뒤(1분 뒤) 다시 가져와 주세요'
const clock = () => {
  let t = 0
  return { now: () => t, sleep: async (ms) => void (t += ms) }
}
const message = (e) => e.message

test('쓰는 중이면 끝날 때까지 다시 시도해 가져온다', async () => {
  const c = clock()
  const waits = []
  let calls = 0
  const r = await adoptWhenFree(async () => (++calls < 4 ? Promise.reject(new Error(BUSY)) : 'sid'), { message, onWait: (w) => waits.push(w), ...c })
  assert.equal(r, 'sid')
  assert.equal(calls, 4)
  assert.deepEqual(waits.map((w) => w.tries), [1, 2, 3])
  assert.equal(c.now(), 3 * ADOPT_RETRY_MS)
})

test('Codex 의 쓰는 중 문구도 기다린다', () => {
  assert.ok(ADOPT_BUSY.test('다른 도구(터미널 등)의 codex 가 이 대화를 지금 쓰는 중이에요. 그쪽 codex 를 끝낸 뒤(1분 뒤) 다시 가져와 주세요'))
})

test('다른 오류는 기다리지 않는다', async () => {
  let calls = 0
  await assert.rejects(adoptWhenFree(async () => (calls++, Promise.reject(new Error('이 맥에서 그 대화의 기록을 찾지 못했습니다'))), { message, ...clock() }), /기록을 찾지/)
  assert.equal(calls, 1)
})

test('최대 시간을 넘기면 맥의 문구 그대로 실패한다', async () => {
  const c = clock()
  await assert.rejects(adoptWhenFree(async () => Promise.reject(new Error(BUSY)), { message, ...c }), /지금 쓰는 중이에요/)
  assert.ok(c.now() >= ADOPT_WAIT_MS && c.now() < ADOPT_WAIT_MS + ADOPT_RETRY_MS)
})

test('멈추면 1초 안에 그만둔다', async () => {
  const c = clock()
  let stop = false
  const p = adoptWhenFree(async () => Promise.reject(new Error(BUSY)), { message, stopped: () => stop, onWait: () => void (stop = true), ...c })
  await assert.rejects(p, AdoptWaitStopped)
  assert.ok(c.now() <= 1000)
})

test('목록 화면이 기다리기를 쓴다', () => {
  const src = readFileSync(new URL('../../ui/src/pages/adopt-list.tsx', import.meta.url), 'utf8')
  assert.match(src, /ctl\.one\(/)
  assert.match(src, /기다리지 않기/)
  assert.doesNotMatch(src, /그쪽을 먼저 끝내세요/)
})

// 화면을 떠나면 일괄 가져오기 전체가 멈춘다 (REQ-F-867 규칙 2, AC-1624): the stop for leaving the page is not the
// 기다리지 않기 button's, and the next conversation must not clear it.
test('첫 대화를 기다리는 중 목록 화면을 떠나면 두 번째 대화는 보내지 않는다', async () => {
  const c = clock()
  const ctl = adoptControl()
  const sent = []
  const post = async (id) => (sent.push(id), Promise.reject(new Error(BUSY)))
  const r = await adoptEach(['a', 'b'], ctl, (id) => ctl.one(() => post(id), { message, onWait: () => ctl.leave(), ...c }))
  assert.equal(r.left, true)
  assert.deepEqual(sent, ['a'])
  assert.equal(ctl.left(), true)
  await assert.rejects(ctl.one(() => post('c'), { message, ...c }), AdoptLeft)
  assert.deepEqual(sent, ['a'])
})

test('기다리지 않기는 그 대화만 건너뛰고 다음 대화를 가져온다', async () => {
  const c = clock()
  const ctl = adoptControl()
  const sent = []
  const post = async (id) => (sent.push(id), id === 'a' ? Promise.reject(new Error(BUSY)) : id)
  const r = await adoptEach(['a', 'b'], ctl, (id) => ctl.one(() => post(id), { message, onWait: () => ctl.skip(), ...c }))
  assert.equal(r.left, false)
  assert.deepEqual(sent, ['a', 'b'])
  assert.equal(r.failed.length, 1)
  assert.ok(r.failed[0].error instanceof AdoptWaitStopped)
})

test('기다리는 사이 화면을 떠나면 다시 시도하지 않는다', async () => {
  const ctl = adoptControl()
  let t = 0
  let sent = 0
  const sleep = async (ms) => {
    t += ms
    if (t >= 5000) ctl.leave()
  }
  await assert.rejects(ctl.one(async () => (sent++, Promise.reject(new Error(BUSY))), { message, now: () => t, sleep }), AdoptLeft)
  assert.equal(sent, 1)
})

test('목록 화면은 화면 이탈과 기다리지 않기를 나눠 쓴다', () => {
  const src = readFileSync(new URL('../../ui/src/pages/adopt-list.tsx', import.meta.url), 'utf8')
  assert.match(src, /adoptEach\(/)
  assert.match(src, /\.leave\(\)/)
  assert.match(src, /\.skip\(\)/)
  assert.doesNotMatch(src, /stop\.current = false/)
})
