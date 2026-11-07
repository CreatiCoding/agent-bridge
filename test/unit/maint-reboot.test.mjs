// 정비 재부팅: when a Mac restarts itself on purpose, what stops it, and what comes back after.
import test from 'node:test'
import assert from 'node:assert/strict'
import { REBOOT_DEFAULT, rebootPolicyOf, rebootPolicyError, rebootWhy, rebootBlockers, rebootPreflight, chromeCloneDir, bootTimeOf, rebootPhase, rebootDiff, rebootResumeList } from '../../agent/guard.mjs'

test('the policy is off by default and falls back to the default on anything malformed', () => {
  assert.deepEqual(rebootPolicyOf(undefined), { ...REBOOT_DEFAULT })
  assert.equal(rebootPolicyOf({ on: 'yes' }).on, false)
  assert.deepEqual(rebootPolicyOf({ on: true, day: 9, from: 4, to: 4, minClones: -1, minFreeGB: 1.5, failMin: 1 }), { ...REBOOT_DEFAULT, on: true })
  assert.deepEqual(rebootPolicyOf({ on: true, day: 6, from: 22, to: 2, minClones: 0, minFreeGB: 50, failMin: 15 }), { on: true, day: 6, from: 22, to: 2, minClones: 0, minFreeGB: 50, failMin: 15 })
})

test('a policy from the site is checked', () => {
  assert.equal(rebootPolicyError({ ...REBOOT_DEFAULT }), null)
  assert.ok(rebootPolicyError({ ...REBOOT_DEFAULT, on: 1 }))
  assert.ok(rebootPolicyError({ ...REBOOT_DEFAULT, day: 7 }))
  assert.ok(rebootPolicyError({ ...REBOOT_DEFAULT, from: 24 }))
  assert.ok(rebootPolicyError({ ...REBOOT_DEFAULT, from: 5, to: 5 }))
  assert.ok(rebootPolicyError({ ...REBOOT_DEFAULT, minClones: -1 }))
  assert.ok(rebootPolicyError({ ...REBOOT_DEFAULT, minFreeGB: 2.5 }))
  assert.ok(rebootPolicyError({ ...REBOOT_DEFAULT, failMin: 90 }))
})

test('a restart is due only on the day, inside the window, and for a reason', () => {
  const p = rebootPolicyOf({ on: true })
  const many = { clones: 111, freeGB: 90 }
  assert.equal(rebootWhy(rebootPolicyOf({}), { day: 0, hour: 4 }, many), null, 'off')
  assert.equal(rebootWhy(p, { day: 1, hour: 4 }, many), null, 'another day')
  assert.equal(rebootWhy(p, { day: 0, hour: 6 }, many), null, 'the end hour is outside')
  assert.match(rebootWhy(p, { day: 0, hour: 4 }, many), /Chrome 복제본 111개/)
  assert.match(rebootWhy(p, { day: 0, hour: 5 }, { clones: 2, freeGB: 12 }), /남은 공간 12GB/)
  assert.equal(rebootWhy(p, { day: 0, hour: 5 }, { clones: 2, freeGB: 90 }), null, 'nothing to give back')
  assert.equal(rebootWhy(p, { day: 0, hour: 5 }, { clones: null, freeGB: null }), null, 'facts not read are no reason')
  assert.equal(rebootWhy(rebootPolicyOf({ on: true, minClones: 0, minFreeGB: 0 }), { day: 0, hour: 4 }, {}), '매주 정해진 재부팅')
})

test('a window past midnight belongs to the day it starts on', () => {
  const p = rebootPolicyOf({ on: true, day: 6, from: 23, to: 2, minClones: 0, minFreeGB: 0 })
  assert.ok(rebootWhy(p, { day: 6, hour: 23 }))
  assert.ok(rebootWhy(p, { day: 0, hour: 1 }), 'Sunday 1 o\'clock is Saturday\'s window')
  assert.equal(rebootWhy(p, { day: 6, hour: 1 }), null, 'Saturday 1 o\'clock is Friday\'s')
})

test('anything going on in a session keeps the Mac up', () => {
  assert.deepEqual(rebootBlockers([{ name: 'a' }, { id: 'b' }]), [])
  assert.deepEqual(rebootBlockers([{ name: 'a', working: true, bg: 2 }, { id: 'b', waiting: true, card: true, delegating: 1, launching: true }]), [
    'a: 턴이 도는 중', 'a: 백그라운드 작업 2개', 'b: 답을 기다리는 중', 'b: 열린 카드', 'b: 다른 맥에 맡긴 일 1개', 'b: 뜨는 중',
  ])
})

test('a Mac that would stop at a login or FileVault screen, or could not link again, is refused', () => {
  const ok = { user: 'me', autoLoginUser: 'me\n', fileVault: 'FileVault is Off.\n', background: true }
  assert.deepEqual(rebootPreflight(ok), [])
  assert.equal(rebootPreflight({ ...ok, autoLoginUser: '' }).length, 1)
  assert.equal(rebootPreflight({ ...ok, autoLoginUser: 'someone' }).length, 1)
  assert.equal(rebootPreflight({ ...ok, fileVault: 'FileVault is On.' }).length, 1)
  assert.equal(rebootPreflight({ ...ok, fileVault: undefined }).length, 1)
  assert.equal(rebootPreflight({ ...ok, background: false }).length, 1)
})

test('the clone folder sits beside the temp folder, and the boot time reads in ms', () => {
  assert.equal(chromeCloneDir('/var/folders/js/abc/T/'), '/var/folders/js/abc/X/com.google.Chrome.code_sign_clone')
  assert.equal(chromeCloneDir('/var/folders/js/abc/T'), '/var/folders/js/abc/X/com.google.Chrome.code_sign_clone')
  assert.equal(bootTimeOf('{ sec = 1794070800, usec = 512000 } Sun Nov  8 02:00:00 2026'), 1794070800512)
  assert.equal(bootTimeOf('nonsense'), null)
})

test('an asked-for restart is back after a boot, failed when none came in time', () => {
  const rec = { phase: 'requested', requestedAt: 1_000_000 }
  assert.equal(rebootPhase(null, 0, 0), null)
  assert.equal(rebootPhase({ phase: 'done' }, 0, 0), 'done')
  assert.equal(rebootPhase(rec, 2_000_000, 2_000_000), 'back')
  assert.equal(rebootPhase(rec, 500_000, 1_000_000 + 5 * 60_000), 'waiting')
  assert.equal(rebootPhase(rec, 500_000, 1_000_000 + 11 * 60_000), 'failed')
  assert.equal(rebootPhase(rec, null, 1_000_000 + 3 * 60_000, 2), 'failed')
})

test('before and after: a service that ran must run again, one that only waited must still be there', () => {
  const before = { services: { agent: { pid: 1 }, timer: { pid: null }, gone: { pid: 3 } }, docker: 'running', clones: 111, freeGB: 62 }
  const after = { services: { agent: { pid: 9 }, timer: { pid: null } }, docker: 'running', clones: 2, freeGB: 91 }
  const d = rebootDiff(before, after)
  assert.equal(d.bad, 1)
  assert.deepEqual(d.lines.find((l) => l.what === 'gone'), { what: 'gone', before: '실행 중', after: '없음', ok: false })
  assert.deepEqual(d.lines.find((l) => l.what === 'Chrome 복제본'), { what: 'Chrome 복제본', before: '111개', after: '2개', ok: true })
  assert.equal(rebootDiff({ docker: 'running' }, { docker: null }).bad, 1)
  assert.equal(rebootDiff({ docker: 'stopped' }, {}).bad, 0)
})

test('sessions come back once each, not into a folder the boot took away', () => {
  const saved = [
    { sid: 'a', conv: 'c1', cwd: '/w/a' },
    { sid: 'b', conv: 'c2', cwd: '/w/b', closed: true },
    { sid: 'c', conv: 'c3', cwd: '/w/c' },
    { sid: 'd', conv: 'c1', cwd: '/w/a' },
    { sid: 'e', conv: 'c5', cwd: '/private/tmp/x/wt' },
    { sid: 'f', conv: 'c6', cwd: '/w/gone' },
    { sid: 'g' },
    { sid: 'h', conv: 'c8', cwd: '/w/h' },
  ]
  const exists = (p) => !String(p).startsWith('/private/tmp') && p !== '/w/gone'
  const { resume, skip } = rebootResumeList(saved, { running: ['c3'], exists, max: 1 })
  assert.deepEqual(resume.map((s) => s.sid), ['a'])
  assert.deepEqual(Object.fromEntries(skip.map((s) => [s.sid, s.why])), {
    b: '닫았거나 쉬거나 옮긴 세션이에요',
    c: '이미 떠 있어요',
    d: '이미 떠 있어요',
    e: '/tmp 안의 폴더라 재부팅으로 사라졌어요',
    f: '작업 폴더가 없어요',
    g: '대화 id 가 없어요',
    h: '한 번에 1개까지만 다시 열어요',
  })
})
