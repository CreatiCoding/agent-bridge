// The Go server binary the tests run: BRIDGE_SERVER_BIN when set, else built once per test process from server/
// (go's build cache makes a rebuild of unchanged code a link only).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
let built = null

export function serverBin() {
  if (process.env.BRIDGE_SERVER_BIN) return process.env.BRIDGE_SERVER_BIN
  if (built) return built
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-bin-'))
  const out = path.join(dir, 'bridge-server')
  execFileSync('go', ['build', '-o', out, '.'], { cwd: path.join(ROOT, 'server'), stdio: ['ignore', 'pipe', 'inherit'] })
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }))
  built = out
  return built
}
