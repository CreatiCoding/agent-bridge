#!/usr/bin/env node
// Publishes the signed Mac builds of `local --full` to the repository's release `localfull` (SPEC REQ-F-904), so a
// Mac whose site has none (a site behind a sign-in, or an image built from other base images) takes them from there.
// The builds are made again by the Dockerfile's localfull stage (scripts/sign-agent.mjs buildLocalFull) and must be
// the ones signed in server/localfull.json, byte for byte: nothing else is uploaded. No key is needed here, and the
// release host is not trusted by the agent (it checks the signature, the hash and the seq as for the site's).
//   node scripts/release-localfull.mjs            (after the commit with server/localfull.json is on main)
//   node scripts/release-localfull.mjs --check    (says whether the release has these builds, uploads nothing)
// Assets: localfull-<arch> (the program) and localfull-<arch>.json ({doc, sig}, what the site's /localfull/<arch>.json
// answers). Uploaded program first, then documents, each replacing the one before.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildLocalFull, savedLocalFull, localFullSrc } from './sign-agent.mjs'
import { lfVerify, LF_ARCHES } from '../agent/localfull.mjs'

const REPO = process.env.LOCALFULL_REPO || 'CreatiCoding/agent-bridge'
const TAG = 'localfull'
const gh = (args, opt = {}) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt })

const saved = savedLocalFull()
if (!saved || saved.src !== localFullSrc()) {
  console.error('server/localfull.json 이 지금 소스의 서명이 아닙니다. node scripts/sign-agent.mjs 로 먼저 서명하세요.')
  process.exit(1)
}
// What the release has now: its documents, compared with the signed ones.
let have = {}
try {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-lf-rel-'))
  gh(['release', 'download', TAG, '-R', REPO, '-p', 'localfull-*.json', '-D', out, '--clobber'])
  for (const a of LF_ARCHES) {
    try {
      have[a] = JSON.parse(fs.readFileSync(path.join(out, `localfull-${a}.json`), 'utf8'))
    } catch {}
  }
  fs.rmSync(out, { recursive: true, force: true })
} catch {
  have = null // no release yet
}
const same = have && LF_ARCHES.every((a) => have[a]?.doc === saved[a].doc && have[a]?.sig === saved[a].sig)
if (same) {
  console.log(`릴리스 ${TAG}: 이미 이 빌드들이에요(${LF_ARCHES.map((a) => JSON.parse(saved[a].doc).version).join(', ')}).`)
  process.exit(0)
}
if (process.argv.includes('--check')) {
  console.log(`릴리스 ${TAG}: ${have ? '다른 빌드' : '없음'} — node scripts/release-localfull.mjs 로 올리세요.`)
  process.exit(1)
}

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-lf-rel-'))
try {
  console.log('맥용 서버를 Dockerfile 의 localfull 단계로 다시 빌드하는 중(docker)…')
  buildLocalFull(out)
  const files = []
  const docs = []
  for (const a of LF_ARCHES) {
    const bytes = fs.readFileSync(path.join(out, a))
    const r = lfVerify({ doc: saved[a].doc, sig: saved[a].sig, bytes }, { arch: a })
    if (!r.ok) {
      console.error(`${a}: 빌드가 서명과 다릅니다(${r.why}). 올리지 않습니다.`)
      process.exit(1)
    }
    const bin = path.join(out, `localfull-${a}`)
    fs.renameSync(path.join(out, a), bin)
    const doc = path.join(out, `localfull-${a}.json`)
    fs.writeFileSync(doc, `${JSON.stringify({ doc: saved[a].doc, sig: saved[a].sig })}\n`)
    files.push(bin)
    docs.push(doc)
    console.log(`${a}: ${r.d.version} · 순번 ${r.d.seq} · ${bytes.length} 바이트 — 서명과 같음`)
  }
  if (!have) {
    gh(['release', 'create', TAG, '-R', REPO, '--latest=false', '--title', 'local --full: 서명된 맥용 서버', '--notes', '`node agent.mjs local --full on` 이 사이트에서 받지 못할 때 여기서 받습니다. 에이전트는 관리자 서명·해시·순번을 확인한 것만 씁니다(SPEC REQ-F-904). 손으로 넣으려면: `node agent.mjs local --full install localfull-<arch> localfull-<arch>.json`'])
  }
  gh(['release', 'upload', TAG, '-R', REPO, '--clobber', ...files])
  gh(['release', 'upload', TAG, '-R', REPO, '--clobber', ...docs])
  console.log(`릴리스 ${TAG} 에 올렸어요: https://github.com/${REPO}/releases/tag/${TAG}`)
} finally {
  fs.rmSync(out, { recursive: true, force: true })
}
