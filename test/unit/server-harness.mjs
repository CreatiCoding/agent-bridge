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

export async function startServer({ seed = {}, env = {} } = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-srv-'))
  for (const [rel, v] of Object.entries(seed)) {
    fs.mkdirSync(path.dirname(path.join(data, rel)), { recursive: true })
    fs.writeFileSync(path.join(data, rel), typeof v === 'string' ? v : JSON.stringify(v))
  }
  const port = await freePort()
  const origin = `http://localhost:${port}`
  const childEnv = { ...process.env, HOME: data, PORT: String(port), BRIDGE_DATA: data, BRIDGE_DEV_LOGIN: '1', BRIDGE_ADMIN_LOGINS: 'boss', GITHUB_ALLOWED_LOGINS: '*', BRIDGE_ORIGIN: origin, BRIDGE_ROOT: ROOT, ...env }
  delete childEnv.CLAUDECODE
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k]
  const child = spawn(serverBin(), [], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
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
      child.kill()
      await new Promise((r) => child.once('exit', r))
      fs.rmSync(data, { recursive: true, force: true })
    },
  }
}
