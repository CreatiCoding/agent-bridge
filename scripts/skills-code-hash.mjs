#!/usr/bin/env node
// The /skills code hash of a git ref, to compare with the `code` that https://bridge.creco.dev/skills/version reports
// (signed out it reports only that; which repo and its commit only to the person signed in, for their own repo).
//   node scripts/skills-code-hash.mjs [ref=origin/main]
import { execFileSync } from 'node:child_process'
import { codeHash } from '../server/skills.mjs'

const ref = process.argv[2] || 'origin/main'
console.log(codeHash((f) => execFileSync('git', ['show', `${ref}:${f}`], { encoding: 'utf8' })))
