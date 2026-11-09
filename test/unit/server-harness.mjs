// The real (Go) server on a free port over a fresh data folder, for tests that go through HTTP. Dev login is on, so
// `login(name)` signs a person in without GitHub; `boss` is the operator. `seed` writes files into the data folder
// before the server starts (relative path -> JSON value). The session's own environment (CLAUDECODE, HOME) is not
// passed on.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { serverBin } from './server-bin.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })

const gone = (c) => c.exitCode !== null || c.signalCode !== null

export async function startServer({ seed = {}, env = {} } = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-srv-'))
  for (const [rel, v] of Object.entries(seed)) {
    fs.mkdirSync(path.dirname(path.join(data, rel)), { recursive: true })
    fs.writeFileSync(path.join(data, rel), typeof v === 'string' ? v : JSON.stringify(v))
  }
  // A free port can be taken by another test file between freePort() and the server's listen, so a server that exits
  // before it is healthy is started again on a new port; one that never comes up fails with its own output.
  let port, origin, child, out
  for (let attempt = 0; ; attempt++) {
    port = await freePort()
    origin = `http://localhost:${port}`
    const childEnv = { ...process.env, HOME: data, PORT: String(port), BRIDGE_DATA: data, BRIDGE_DEV_LOGIN: '1', BRIDGE_ADMIN_LOGINS: 'boss', GITHUB_ALLOWED_LOGINS: '*', BRIDGE_ORIGIN: origin, BRIDGE_ROOT: ROOT, ...env }
    delete childEnv.CLAUDECODE
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k]
    child = spawn(serverBin(), [], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    out = ''
    const exited = new Promise((r) => child.once('exit', r))
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    let ok = false
    for (let i = 0; i < 150 && !ok && !gone(child); i++) {
      try {
        ok = (await fetch(`${origin}/api/health`)).ok
      } catch {}
      if (!ok) await new Promise((r) => setTimeout(r, 100))
    }
    if (ok) break
    if (!gone(child)) child.kill()
    await exited
    if (attempt >= 2) {
      fs.rmSync(data, { recursive: true, force: true })
      throw new Error(`server did not come up on :${port}\n${out}`)
    }
  }
  const jars = {}
  const api = async (who, p, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(`${origin}${p}`, { method, redirect: 'manual', headers: { ...(jars[who] ? { cookie: jars[who] } : {}), ...(body !== undefined ? { 'content-type': 'application/json', origin } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: r.status, json, text, headers: r.headers }
  }
  return {
    origin,
    data,
    log: () => out,
    async login(who) {
      const r = await fetch(`${origin}/api/auth/dev?login=${who}`, { redirect: 'manual' })
      jars[who] = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
      return jars[who]
    },
    api,
    jar: (who) => jars[who],
    async stop() {
      // A server that already exited has fired 'exit'; waiting for it again would hang with nothing keeping the loop alive.
      if (!gone(child)) {
        const exited = new Promise((r) => child.once('exit', r))
        child.kill()
        await exited
      }
      fs.rmSync(data, { recursive: true, force: true })
    },
  }
}
