// Whether macOS shows one of its own alerts, a privacy prompt among them (REQ-F-777).
import test from 'node:test'
import assert from 'node:assert/strict'
import { sysDialogOpen } from '../../agent/screen.mjs'

// The on-screen window list of a Mac mini on 2026-10-18, a privacy prompt of macOS open (reduced as the agent does).
const WITH_ALERT = [
  { o: 'Window Server', l: 0, b: { X: 0, Y: 0, Width: 1920, Height: 1080 } },
  { o: 'Control Center', l: 25, b: { X: 1700, Y: 0, Width: 30, Height: 24 } },
  { o: 'UserNotificationCenter', l: 8, b: { X: 830, Height: 192, Y: 188, Width: 260 } },
]

test('an alert of UserNotificationCenter on screen is an open system dialog', () => {
  assert.equal(sysDialogOpen(WITH_ALERT), true)
})

test('without it, or with only a tiny or normal-layer window of it, none is open', () => {
  assert.equal(sysDialogOpen(WITH_ALERT.slice(0, 2)), false)
  assert.equal(sysDialogOpen([{ o: 'UserNotificationCenter', l: 0, b: { Width: 260, Height: 192 } }]), false)
  assert.equal(sysDialogOpen([{ o: 'UserNotificationCenter', l: 8, b: { Width: 1, Height: 1 } }]), false)
  assert.equal(sysDialogOpen(null), false)
  assert.equal(sysDialogOpen([null, {}]), false)
})
