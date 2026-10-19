// Two servers over one data folder: the state changes hands, and requests to the old one reach the new one.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHandover } from '../../server/handover.mjs'

const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, () => resolve(s)) })
const get = (port, p = '/x', headers = {}) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p, headers }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => resolve({ status: r.statusCode, body: b })) }).on('error', reject))

function server(dir, name, events) {
  const h = createHandover(dir, () => {})
  return {
    h,
    async start() {
      events.push(`${name}:tookOver=${await h.takeOver()}`)
      this.http = await listen(async (req, res) => {
        if (req.url === '/api/health') return res.end(JSON.stringify({ instance: h.id }))
        if (await h.intercept(req, res)) return
        res.end(name)
      })
      h.serve({ port: this.http.address().port, drain: async () => (events.push(`${name}:drain`), { note: 'carried' }), resume: () => events.push(`${name}:resume`), cut: () => events.push(`${name}:cut`) })
      return this.http.address().port
    },
  }
}

test('a cold start takes nothing over and starts at once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ho-'))
  const events = []
  const a = server(dir, 'a', events)
  const t0 = Date.now()
  const port = await a.start()
  assert.ok(Date.now() - t0 < 500)
  assert.deepEqual(events, ['a:tookOver=false'])
  assert.equal((await get(port)).body, 'a')
  a.http.close()
})

test('the new server takes the state; the old one passes its requests on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ho-'))
  const events = []
  const a = server(dir, 'a', events)
  const portA = await a.start()
  const b = server(dir, 'b', events)
  const portB = await b.start()
  assert.equal(events[1], 'a:drain', 'the old server writes its state before the new one reads it')
  assert.equal(events[2], 'b:tookOver=true')
  assert.deepEqual(b.h.carried(), { note: 'carried' })
  // the old server finds the new one and switches to passing requests on
  for (let i = 0; i < 60 && a.h.state() !== 'proxy'; i++) await new Promise((r) => setTimeout(r, 100))
  assert.equal(a.h.state(), 'proxy')
  assert.ok(events.includes('a:cut'))
  assert.equal((await get(portA)).body, 'b', 'a request to the old server is answered by the new one')
  // R1-L4 (리포트 #1): a request from outside that only claims to be passed on is passed on all the same: the old
  // server writes nothing any more, so what it answered would be lost.
  assert.equal((await get(portA, '/x', { 'x-bridge-handover': 'anything' })).body, 'b')
  assert.equal((await get(portB)).body, 'b')
  // Told to stop now, the old one stays a few seconds for the requests the router still sends it; the new one has nothing to wait for.
  assert.equal(a.h.linger(), 8000)
  assert.equal(b.h.linger(), 0)
  a.http.closeAllConnections()
  b.http.closeAllConnections()
  a.http.close()
  b.http.close()
})

test('a server stopped before the new one starts leaves nothing to wait for', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ho-'))
  fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify({ id: 'gone', at: Date.now() - 60_000 }))
  const events = []
  const t0 = Date.now()
  const b = server(dir, 'b', events)
  await b.start()
  assert.ok(Date.now() - t0 < 500, 'no wait for a server that is not alive')
  assert.deepEqual(events, ['b:tookOver=false'])
  b.http.close()
})
