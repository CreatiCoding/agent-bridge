// A host's CPU, memory and disk in use, reported with its health so the site shows them (REQ-F-800).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpuBusy, macMemUsed, linuxMemUsed, diskUse, macBattery, linuxBattery, BATTERY_LOW_PCT } from '../../agent/guard.mjs'

test('cpuBusy: share of non-idle time across all cores between two readings', () => {
  const t = (user, idle) => ({ times: { user, nice: 0, sys: 0, irq: 0, idle } })
  assert.equal(cpuBusy([t(0, 0), t(0, 0)], [t(25, 75), t(75, 25)]), 50)
  assert.equal(cpuBusy([t(0, 0)], [t(0, 0)]), null, '시간이 흐르지 않음')
  assert.equal(cpuBusy(null, [t(1, 1)]), null)
  assert.equal(cpuBusy([t(0, 0)], [t(1, 1), t(1, 1)]), null, '코어 수가 바뀜')
})

test('macMemUsed: app memory + wired + compressed, as Activity Monitor counts it', () => {
  const vm = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    27494.
Pages wired down:                             100.
Pages purgeable:                                 10.
Anonymous pages:                              200.
Pages occupied by compressor:                 50.
`
  assert.equal(macMemUsed(vm), (200 - 10 + 100 + 50) * 16384)
  assert.equal(macMemUsed('nothing'), null)
})

test('linuxMemUsed: MemTotal less MemAvailable', () => {
  assert.equal(linuxMemUsed('MemTotal:       16000000 kB\nMemFree:  100 kB\nMemAvailable:   4000000 kB\n'), 12000000 * 1024)
  assert.equal(linuxMemUsed(''), null)
})

test('diskUse: counted like df, used / (used + available)', () => {
  const d = diskUse({ blocks: 1000, bfree: 300, bavail: 200, bsize: 4096 })
  assert.deepEqual(d, { total: 1000 * 4096, used: 700 * 4096, avail: 200 * 4096, pct: 77.8 })
  assert.equal(diskUse({ blocks: 0 }), null)
  assert.equal(diskUse(null), null)
})

test('macBattery: charge, power, time left and wear from pmset and ioreg (REQ-F-806)', () => {
  const on = (line, src = 'Battery Power') => `Now drawing from '${src}'\n -InternalBattery-0 (id=1234567)\t${line} present: true\n`
  const io = '    "CycleCount" = 123\n    "DesignCapacity" = 4563\n    "AppleRawMaxCapacity" = 4152\n'
  assert.deepEqual(macBattery(on('76%; discharging; 3:12 remaining'), io), { present: true, ac: false, pct: 76, state: 'discharging', remain: 192, cycles: 123, health: 91 })
  assert.deepEqual(macBattery(on('40%; charging; 1:05 remaining', 'AC Power')), { present: true, ac: true, pct: 40, state: 'charging', remain: 65, cycles: null, health: null })
  assert.equal(macBattery(on('100%; charged; 0:00 remaining', 'AC Power')).state, 'full')
  assert.equal(macBattery(on('80%; AC attached; not charging', 'AC Power')).state, 'idle')
  assert.equal(macBattery(on('15%; discharging; (no estimate)')).remain, null)
  assert.deepEqual(macBattery("Now drawing from 'AC Power'\n", '"MaxCapacity" = 0'), { present: false, ac: true }, '맥 미니')
  assert.equal(macBattery(''), null)
  assert.equal(BATTERY_LOW_PCT, 20)
})

test('linuxBattery: /sys/class/power_supply entries (REQ-F-806)', () => {
  assert.deepEqual(linuxBattery([]), { present: false, ac: true }, '배터리 없는 서버')
  assert.deepEqual(linuxBattery([{ type: 'Mains\n', online: '1\n' }]), { present: false, ac: true })
  const bat = { type: 'Battery\n', present: '1', status: 'Discharging\n', capacity: '18\n', cycle_count: '210', energy_now: '9000000', energy_full: '45000000', energy_full_design: '50000000', power_now: '6000000' }
  assert.deepEqual(linuxBattery([{ type: 'Mains', online: '0' }, bat]), { present: true, ac: false, pct: 18, state: 'discharging', remain: 90, cycles: 210, health: 90 })
  const charging = { type: 'Battery', status: 'Charging', charge_now: '2000', charge_full: '4000', charge_full_design: '4000', current_now: '1000' }
  assert.deepEqual(linuxBattery([{ type: 'Mains', online: '1' }, charging]), { present: true, ac: true, pct: 50, state: 'charging', remain: 120, cycles: null, health: 100 })
  assert.equal(linuxBattery([{ type: 'Battery', status: 'Not charging', capacity: '80' }, { type: 'Mains', online: '1' }]).state, 'idle')
})
