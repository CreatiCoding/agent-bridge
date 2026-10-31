// 자동 업데이트 시간 (REQ-F-832): when a Mac puts a new agent in place.
import test from 'node:test'
import assert from 'node:assert/strict'
import { updatePolicyOf, updatePolicyError, inUpdateWindow, updateDue, UPDATE_WINDOW_DEFAULT } from '../../agent/guard.mjs'

test('the default is the night window, 4~6 o\'clock', () => {
  assert.deepEqual(updatePolicyOf(undefined), { mode: 'night', ...UPDATE_WINDOW_DEFAULT, skipBusy: true })
  assert.deepEqual(updatePolicyOf({ mode: 'bogus', from: 4, to: 4 }), { mode: 'night', from: 4, to: 6, skipBusy: true })
  assert.deepEqual(updatePolicyOf({ mode: 'always', from: 22, to: 2, skipBusy: false }), { mode: 'always', from: 22, to: 2, skipBusy: false })
})

test('a window takes its start hour and not its end hour, and may run past midnight', () => {
  assert.equal(inUpdateWindow(3, 4, 6), false)
  assert.equal(inUpdateWindow(4, 4, 6), true)
  assert.equal(inUpdateWindow(5, 4, 6), true)
  assert.equal(inUpdateWindow(6, 4, 6), false)
  assert.equal(inUpdateWindow(23, 22, 2), true)
  assert.equal(inUpdateWindow(1, 22, 2), true)
  assert.equal(inUpdateWindow(2, 22, 2), false)
  assert.equal(inUpdateWindow(12, 22, 2), false)
})

test('an update is due at night, always, or when asked for now', () => {
  const night = updatePolicyOf({})
  assert.equal(updateDue(night, 0), false)
  assert.equal(updateDue(night, 5), true)
  assert.equal(updateDue(night, 0, true), true)
  assert.equal(updateDue(updatePolicyOf({ mode: 'always', from: 4, to: 6 }), 13), true)
})

test('a policy from the site is checked', () => {
  assert.equal(updatePolicyError({ mode: 'night', from: 4, to: 6 }), null)
  assert.ok(updatePolicyError({ mode: 'sometimes', from: 4, to: 6 }))
  assert.ok(updatePolicyError({ mode: 'night', from: 4, to: 24 }))
  assert.ok(updatePolicyError({ mode: 'night', from: 4.5, to: 6 }))
  assert.ok(updatePolicyError({ mode: 'night', from: 5, to: 5 }))
})

test('at night a working session puts the update off, unless skipBusy is off (1.378)', () => {
  const night = updatePolicyOf({})
  assert.equal(night.skipBusy, true)
  assert.equal(updateDue(night, 5, false, true), false)
  assert.equal(updateDue(night, 5, false, false), true)
  assert.equal(updateDue(night, 5, true, true), true, '지금 업데이트는 기다리지 않는다')
  assert.equal(updateDue(updatePolicyOf({ mode: 'night', from: 4, to: 6, skipBusy: false }), 5, false, true), true)
  assert.equal(updateDue(updatePolicyOf({ mode: 'always', from: 4, to: 6 }), 13, false, true), true)
  assert.equal(updatePolicyError({ mode: 'night', from: 4, to: 6, skipBusy: 'yes' }) !== null, true)
  assert.equal(updatePolicyError({ mode: 'night', from: 4, to: 6, skipBusy: false }), null)
})
