// What a self-update ships. A file the update leaves out of AGENT_FILES is not a failing build but a Mac whose
// agent can no longer start (and so can no longer be updated): 4188544 did that with split.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const filesIn = (src) => JSON.parse(src.match(/const AGENT_FILES = (\[[^\]]*\])/)[1].replaceAll("'", '"'))
const AGENT = read('agent/agent.mjs')
const LINK_CHECK = AGENT.match(/const LINK_CHECK = `([\s\S]*?)`/)[1]
const linkCheck = (dir) => execFileSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '--input-type=module', '-e', LINK_CHECK, path.join(dir, 'agent.mjs')], { stdio: 'pipe' })

test('the server ships the same files the agent fingerprints', () => {
  // server/config.go: var AGENT_FILES = []string{"agent.mjs", ...}
  const go = JSON.parse(read('server/config.go').match(/var AGENT_FILES = \[\]string\{([^}]*)\}/)[1].replace(/^/, '[').replace(/$/, ']'))
  assert.deepEqual(go, filesIn(AGENT))
})

test('every file an agent file imports is shipped', () => {
  const files = filesIn(AGENT)
  for (const f of files)
    for (const [, spec] of read(`agent/${f}`).matchAll(/(?:from|import\()\s*'\.\/([^']+)'/g)) assert.ok(files.includes(spec), `${f} 이 가져오는 ${spec} 이 AGENT_FILES 에 없음`)
})

function copyOf(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-update-'))
  for (const f of files) fs.copyFileSync(path.join(ROOT, 'agent', f), path.join(dir, f))
  return dir
}

test('the link check passes the files as shipped, without starting the agent', () => {
  const dir = copyOf(filesIn(AGENT))
  try {
    linkCheck(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the link check refuses an update that leaves out an imported file', () => {
  const dir = copyOf(filesIn(AGENT).filter((f) => f !== 'split.mjs'))
  try {
    assert.throws(() => linkCheck(dir), (e) => /split\.mjs/.test(String(e.stderr)))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the link check refuses an import of a name a file does not export', () => {
  const dir = copyOf(filesIn(AGENT))
  try {
    fs.writeFileSync(path.join(dir, 'split.mjs'), fs.readFileSync(path.join(dir, 'split.mjs'), 'utf8').replace('export function mainColumn', 'function mainColumn'))
    assert.throws(() => linkCheck(dir), (e) => /mainColumn/.test(String(e.stderr)))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
