#!/usr/bin/env node
// Signs the agent as it is in this checkout (R1-I1, R5-H1): the manifest of AGENT_FILES (each name, length and
// SHA-256, after a number that only grows) signed with the maintainer's key, into agent/agent.sig as JSON
// { seq, msig, legacy }. `legacy` signs the 12-letter build the way agents before 1.165 check, so they can still take
// this update once; agents from 1.165 check msig only. Run it after changing any agent file, before committing;
// `npm test` fails while the signature does not match the files.
//   node scripts/sign-agent.mjs            (key: ~/.claude-bridge-signing/agent-ed25519.pem, or CLAUDE_BRIDGE_SIGN_KEY)
//   node scripts/sign-agent.mjs --init     (a fork: makes that key, and agent/keys.mjs trusts only it)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { signedText, manifestOf, manifestSigned } from '../agent/guard.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export function agentFiles() {
  const src = fs.readFileSync(path.join(ROOT, 'agent/agent.mjs'), 'utf8')
  return JSON.parse(/const AGENT_FILES = (\[[^\]]+\])/.exec(src)[1].replace(/'/g, '"'))
}
/** The files as the server sends them: AGENT_FILES in order. */
export const agentFileTexts = () => Object.fromEntries(agentFiles().map((f) => [f, fs.readFileSync(path.join(ROOT, 'agent', f), 'utf8')]))
/** The seq of an agent.sig text, 0 when there is none. */
const seqOf = (text) => {
  try {
    return JSON.parse(text).seq ?? 0
  } catch {
    return 0
  }
}
/** The seq this checkout's agent.sig has, and the one on origin/main (fetched first when asked), 0 when unknown. */
export function priorSeqs({ fetch = false } = {}) {
  let local = 0
  let main = 0
  try {
    local = seqOf(fs.readFileSync(path.join(ROOT, 'agent/agent.sig'), 'utf8'))
  } catch {}
  // Fetched first: a main that moved since the last fetch may already carry a larger seq (R7-M1).
  if (fetch) {
    try {
      execFileSync('git', ['-C', ROOT, 'fetch', '-q', 'origin', 'main'], { stdio: 'ignore', timeout: 30_000 })
    } catch {
      // Said, not swallowed: the seq is then checked against the origin/main last fetched (R9-L3).
      console.error('경고: git fetch origin main 이 실패해 마지막으로 받아 둔 origin/main 의 순번과 비교합니다')
    }
  }
  try {
    main = seqOf(execFileSync('git', ['-C', ROOT, 'show', 'origin/main:agent/agent.sig'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch {}
  return { local, main }
}
export const agentBuild = () => agentFiles().reduce((h, f) => h.update(fs.readFileSync(path.join(ROOT, 'agent', f))), crypto.createHash('sha1')).digest('hex').slice(0, 12)

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const keyFile = process.env.CLAUDE_BRIDGE_SIGN_KEY || path.join(os.homedir(), '.claude-bridge-signing', 'agent-ed25519.pem')
  if (process.argv.includes('--init')) {
    // Never over a key that exists: agents trusting it could then not be signed for again.
    if (fs.existsSync(keyFile)) {
      console.error(`서명 키가 이미 있습니다: ${keyFile}. 덮어쓰지 않습니다.`)
      process.exit(1)
    }
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
    fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' })
    const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const keysFile = path.join(ROOT, 'agent/keys.mjs')
    const src = fs.readFileSync(keysFile, 'utf8')
    fs.writeFileSync(keysFile, src.replace(/^export const UPDATE_KEYS = .*$/m, `export const UPDATE_KEYS = [${JSON.stringify(pub).replace(/"/g, "'")}]`))
    console.log(`개인 키: ${keyFile} (저장소·서버에 두지 마세요)`)
    console.log(`공개키: agent/keys.mjs 에 ${pub}`)
    console.log('이 키만 믿게 됐어요. 이전 키를 믿는 맥은 이 키로만 서명한 업데이트를 받지 않아요. 이제 node scripts/sign-agent.mjs 로 서명하세요.')
    process.exit(0)
  }
  if (!fs.existsSync(keyFile)) {
    console.error(`서명 키가 없습니다: ${keyFile}. 에이전트 업데이트는 관리자의 맥에서만 서명할 수 있습니다.`)
    process.exit(1)
  }
  const key = crypto.createPrivateKey(fs.readFileSync(keyFile))
  const files = agentFileTexts()
  // Grows with every signing, so an older signed agent cannot be sent again as an update: seconds since 1970, but
  // always past this checkout's last seq and origin/main's (R7-M1). A worktree signed earlier than one already on main
  // would otherwise ship a smaller seq, and every Mac would refuse it for good. Taking back an agent version is
  // signing it again, which gives it a new seq.
  const { local, main } = priorSeqs({ fetch: true })
  const seq = Math.max(Math.floor(Date.now() / 1000), local + 1, main + 1)
  const msig = crypto.sign(null, Buffer.from(manifestOf(files, seq)), key).toString('base64')
  if (!manifestSigned(files, seq, msig)) {
    console.error('이 키는 에이전트가 믿는 키(agent/keys.mjs)가 아닙니다. 새로 만들려면 --init.')
    process.exit(1)
  }
  const legacy = crypto.sign(null, Buffer.from(signedText(agentBuild())), key).toString('base64')
  fs.writeFileSync(path.join(ROOT, 'agent/agent.sig'), `${JSON.stringify({ seq, msig, legacy })}\n`)
  console.log(`agent/agent.sig: build ${agentBuild()} · seq ${seq} 서명함`)
}
