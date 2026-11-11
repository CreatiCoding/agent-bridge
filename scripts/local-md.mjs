#!/usr/bin/env node
// Makes agent/localui/md.js from ui/src/lib/md-parse.ts (REQ-F-899): the local screen reads Claude's answers
// with the very parser the web page uses, so the two do not drift apart. Run after changing md-parse.ts, then
// sign the agent (node scripts/sign-agent.mjs). npm test fails when md.js is not made from the parser as it is.
//
// Needs ui's own esbuild (cd ui && corepack yarn install). The agent itself has no dependencies; md.js is a
// plain script that sets window.CbMd = { parse, inlineParts, isDiff, diffLine }.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SRC = path.join(ROOT, 'ui/src/lib/md-parse.ts')
export const OUT = path.join(ROOT, 'agent/localui/md.js')

/** sha256 hex of the parser source, written in md.js's first line. */
export const srcHash = (text = fs.readFileSync(SRC, 'utf8')) => crypto.createHash('sha256').update(text).digest('hex')

/** md.js as it should be, or null when ui's esbuild is not installed. */
export function localMdText() {
  let esbuild
  try {
    esbuild = createRequire(path.join(ROOT, 'ui/package.json'))('esbuild')
  } catch {
    return null
  }
  const src = fs.readFileSync(SRC, 'utf8')
  const out = esbuild.transformSync(src, { loader: 'ts', format: 'iife', globalName: 'CbMd', target: 'es2020', charset: 'utf8', legalComments: 'none' })
  return `// Made by scripts/local-md.mjs from ui/src/lib/md-parse.ts (sha256 ${srcHash(src)}) — do not edit.\n${out.code}`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = localMdText()
  if (text == null) {
    console.error('ui 의 esbuild 가 없어요: cd ui && corepack yarn install')
    process.exit(1)
  }
  fs.writeFileSync(OUT, text)
  console.log(`${path.relative(ROOT, OUT)} 을 만들었어요. 이제 node scripts/sign-agent.mjs`)
}
