// R1-I1 (리포트 #1), R5-H1·M1·L1 (리포트 #5): agents take only updates the maintainer signed, over every file's name,
// length and SHA-256 under a number that only grows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { buildSigned, manifestOf, manifestSigned, UPDATE_KEYS } from '../../agent/guard.mjs'
import { agentBuild, agentFileTexts } from '../../scripts/sign-agent.mjs'

const saved = () => JSON.parse(fs.readFileSync(new URL('../../agent/agent.sig', import.meta.url), 'utf8'))

test('agent/agent.sig signs the agent files as they are (run `node scripts/sign-agent.mjs` after changing them)', () => {
  const { seq, msig, legacy } = saved()
  assert.ok(manifestSigned(agentFileTexts(), seq, msig), 'agent/agent.sig 가 지금 에이전트 파일의 서명이 아닙니다. node scripts/sign-agent.mjs 로 서명하세요')
  // Agents of 1.161~1.164 check the build: they take this update once, and check the manifest from then on.
  assert.ok(buildSigned(agentBuild(), legacy))
})

test('files swapped between names, a changed file, another number, or another key do not pass', () => {
  const { seq, msig } = saved()
  const files = agentFileTexts()
  const swapped = { 'dialog.mjs': files['agent.mjs'], 'agent.mjs': files['dialog.mjs'], ...Object.fromEntries(Object.entries(files).filter(([n]) => n !== 'agent.mjs' && n !== 'dialog.mjs')) }
  assert.equal(manifestSigned(swapped, seq, msig), false, '이름을 바꿔 끼움')
  assert.equal(manifestSigned({ ...files, 'agent.mjs': `${files['agent.mjs']}\n// x` }, seq, msig), false, '내용 바뀜')
  assert.equal(manifestSigned(files, seq + 1, msig), false, '다른 순번')
  assert.equal(manifestSigned(files, seq, ''), false)
  const stranger = crypto.generateKeyPairSync('ed25519').privateKey
  assert.equal(manifestSigned(files, seq, crypto.sign(null, Buffer.from(manifestOf(files, seq)), stranger).toString('base64')), false, '믿지 않는 키')
  assert.match(manifestOf(files, seq), /agent\.mjs\0\d+\0[0-9a-f]{64}/, '이름·길이·전체 SHA-256')
  assert.equal(UPDATE_KEYS.length, 2)
})

// R7-M1 (리포트 #7): a seq at or below what main already ships would be refused by every Mac for good.
test('the signature on this checkout does not go back from the one on origin/main', async () => {
  const { priorSeqs } = await import('../../scripts/sign-agent.mjs')
  const { local, main } = priorSeqs()
  if (!main) return // no origin/main to compare with (a copy without git)
  const { execFileSync } = await import('node:child_process')
  const same = (() => {
    try {
      execFileSync('git', ['diff', '--quiet', 'origin/main', '--', 'agent/'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()
  if (same) assert.ok(local >= main)
  else assert.ok(local > main, `agent/agent.sig 의 순번(${local})이 main 의 것(${main})보다 커야 합니다. node scripts/sign-agent.mjs 로 다시 서명하세요`)
})

// 1.292: the trusted keys are in agent/keys.mjs, a signed agent file, and a fork makes its own with --init.
test('the trusted keys are an agent file, so they are under the signature', () => {
  assert.ok(Object.keys(agentFileTexts()).includes('keys.mjs'))
})

test('sign-agent --init makes a key the copy then trusts alone, and never writes over one', async () => {
  const { spawnSync } = await import('node:child_process')
  const os = await import('node:os')
  const path = await import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-sign-'))
  const repo = new URL('../..', import.meta.url).pathname
  fs.cpSync(path.join(repo, 'agent'), path.join(root, 'agent'), { recursive: true })
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.copyFileSync(path.join(repo, 'scripts/sign-agent.mjs'), path.join(root, 'scripts/sign-agent.mjs'))
  const key = path.join(root, 'signing', 'agent-ed25519.pem')
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts/sign-agent.mjs'), ...args], { env: { ...process.env, CLAUDE_BRIDGE_SIGN_KEY: key }, encoding: 'utf8' })
  assert.equal(run('--init').status, 0)
  assert.equal(fs.statSync(key).mode & 0o777, 0o600)
  const { UPDATE_KEYS: mine } = await import(`${path.join(root, 'agent/keys.mjs')}?init`)
  assert.equal(mine.length, 1)
  assert.ok(!UPDATE_KEYS.includes(mine[0]))
  const again = run('--init')
  assert.equal(again.status, 1)
  assert.match(again.stderr, /이미 있습니다/)
  assert.equal(run().status, 0)
  const { seq, msig } = JSON.parse(fs.readFileSync(path.join(root, 'agent/agent.sig'), 'utf8'))
  const texts = Object.fromEntries(Object.keys(agentFileTexts()).map((f) => [f, fs.readFileSync(path.join(root, 'agent', f), 'utf8')]))
  assert.ok(manifestSigned(texts, seq, msig, mine))
  // An agent installed from this repository does not take the fork's update.
  assert.equal(manifestSigned(texts, seq, msig), false)
})
