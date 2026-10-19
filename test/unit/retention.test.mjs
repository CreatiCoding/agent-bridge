// 보관 기한 (REQ-S-071, REQ-S-072, REQ-S-074 (8)) and the operator's clearing of what came before (REQ-S-075).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startServer } from './server-harness.mjs'

const DAY = 86_400_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const oldStuff = (now) => ({
  'u/dev-alice/notices.json': [
    { id: 'n1', at: now - DAY, sid: 'x', key: 'k1', title: '어제', text: '한 줄', tone: 'info' },
    { id: 'n2', at: now - 31 * DAY, sid: 'x', key: 'k2', title: '31일 전', text: '한 줄', tone: 'info' },
  ],
  'reports/r-old-0001.json': { id: 'r-old-0001', at: now - 91 * DAY, uid: 'dev-alice', login: 'alice', text: '옛 제보', images: [], videos: [], status: 'new' },
  'reports/r-new-0001.json': { id: 'r-new-0001', at: now - DAY, uid: 'dev-alice', login: 'alice', text: '새 제보', images: [], videos: [], status: 'new' },
  'access.json': {
    oldwait: { login: 'oldwait', status: 'pending', firstAt: now - 100 * DAY, lastAt: now - 91 * DAY, attempts: 1 },
    newwait: { login: 'newwait', status: 'pending', firstAt: now - DAY, lastAt: now - DAY, attempts: 1 },
    oldok: { login: 'oldok', status: 'allowed', firstAt: now - 200 * DAY, lastAt: now - 200 * DAY, attempts: 1 },
  },
})

test('기한이 지난 알림·제보·접근 요청은 새 기한이 시작된 뒤 것이면 저절로 지워진다 (1.272)', async () => {
  const now = Date.now()
  const s = await startServer({ seed: { ...oldStuff(now), 'retention.json': { since: now - 365 * DAY } } })
  try {
    await s.login('alice')
    const notices = (await s.api('alice', '/api/notices')).json.notices
    assert.deepEqual(notices.map((n) => n.title), ['어제'])
    await sleep(2500)
    assert.ok(!fs.existsSync(path.join(s.data, 'reports/r-old-0001.json')))
    assert.ok(fs.existsSync(path.join(s.data, 'reports/r-new-0001.json')))
    await sleep(5500)
    const access = JSON.parse(fs.readFileSync(path.join(s.data, 'access.json'), 'utf8'))
    assert.deepEqual(Object.keys(access).sort(), ['newwait', 'oldok'])
  } finally {
    await s.stop()
  }
})

test('기한이 시작되기 전 것은 운영자가 수를 본 뒤 BRIDGE_PURGE=1 일 때만 지운다 (1.272)', async () => {
  const now = Date.now()
  const sid = 'cccccccc-0000-4000-8000-00000000000c'
  const kept = 'cccccccc-0000-4000-8000-00000000000d'
  const seed = { ...oldStuff(now), [`u/dev-alice/s/${sid}/meta.json`]: { id: sid, uid: 'dev-alice', hostId: 'h', cwd: '/x', lines: 0, seq: 0, agentLog: true, _legacy: { folderFiles: { 'CLAUDE.md': 'x' } } }, [`u/dev-alice/s/${sid}/events.jsonl`]: '{"seq":1}\n', [`u/dev-alice/s/${kept}/meta.json`]: { id: kept, uid: 'dev-alice', hostId: 'h', cwd: '/x', lines: 0, seq: 1, agentLog: false }, [`u/dev-alice/s/${kept}/events.jsonl`]: '{"seq":1}\n' }
  for (const env of [{}, { BRIDGE_PURGE: '1' }]) {
    const s = await startServer({ seed, env })
    try {
      await s.login('alice')
      await s.login('boss')
      // Nothing old goes by itself: these were made before the limits started.
      assert.equal((await s.api('alice', '/api/notices')).json.notices.length, 2)
      assert.equal((await s.api('alice', '/api/admin/purge')).status, 403)
      const g = (await s.api('boss', '/api/admin/purge')).json
      assert.equal(g.enabled, !!env.BRIDGE_PURGE)
      assert.equal(g.targets.notices.items, 1)
      assert.equal(g.targets.reports.files, 1)
      assert.equal(g.targets.access.items, 1)
      assert.equal(g.targets.legacyMeta.files, 1)
      assert.equal(g.targets.events.files, 2)
      assert.equal(g.targets.events.notMoved, 1)
      assert.equal(g.conversationReady, true)
      const r = await s.api('boss', '/api/admin/purge', { method: 'POST', body: { kinds: ['notices', 'reports', 'access', 'legacyMeta'] } })
      if (!env.BRIDGE_PURGE) {
        assert.equal(r.status, 409)
        assert.ok(fs.existsSync(path.join(s.data, 'reports/r-old-0001.json')))
        continue
      }
      assert.equal(r.status, 200)
      assert.deepEqual(r.json.done, { notices: 1, reports: 1, access: 1, legacyMeta: 1 })
      assert.equal((await s.api('alice', '/api/notices')).json.notices.length, 1)
      assert.ok(!fs.existsSync(path.join(s.data, 'reports/r-old-0001.json')))
      // The server keeps no conversation now (1.277): the old copies go, except a log not yet on its Mac.
      const e = await s.api('boss', '/api/admin/purge', { method: 'POST', body: { kinds: ['events'] } })
      assert.equal(e.status, 200)
      assert.equal(e.json.done.events, 1)
      assert.ok(!fs.existsSync(path.join(s.data, `u/dev-alice/s/${sid}/events.jsonl`)))
      assert.ok(fs.existsSync(path.join(s.data, `u/dev-alice/s/${kept}/events.jsonl`)))
    } finally {
      await s.stop()
    }
  }
})

test('제보의 그림은 제보와 함께 두고, 계정을 지워도 제보는 남는다 (1.272)', async () => {
  const s = await startServer()
  try {
    await s.login('alice')
    const r = await s.api('alice', '/api/reports', { method: 'POST', body: { text: '이상해요', images: [{ data: PNG }] } })
    assert.equal(r.status, 200)
    const report = JSON.parse(fs.readFileSync(path.join(s.data, 'reports', `${r.json.id}.json`), 'utf8'))
    assert.ok(fs.existsSync(path.join(s.data, 'reports/img', report.images[0])))
    assert.ok(!fs.existsSync(path.join(s.data, 'u/dev-alice/img', report.images[0])))
    const img = await s.api('alice', `/api/reports/${r.json.id}/img/${report.images[0]}`)
    assert.equal(img.status, 200)
    assert.equal((await s.api('alice', '/api/account/delete', { method: 'POST', body: { login: 'alice' } })).status, 200)
    assert.ok(fs.existsSync(path.join(s.data, 'reports', `${r.json.id}.json`)))
    assert.ok(fs.existsSync(path.join(s.data, 'reports/img', report.images[0])))
  } finally {
    await s.stop()
  }
})
