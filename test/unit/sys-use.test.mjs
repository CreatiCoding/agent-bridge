// A host's CPU, memory and disk in use, reported with its health so the site shows them (REQ-F-800).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpuBusy, macMemUsed, linuxMemUsed, diskUse } from '../../agent/guard.mjs'

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
