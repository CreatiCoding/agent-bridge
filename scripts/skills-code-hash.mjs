#!/usr/bin/env node
// The /skills code hash of a git ref, to compare with the `code` that https://bridge.creco.dev/skills/version reports
// (signed out it reports only that; which repo and its commit only to the person signed in, for their own repo).
//   node scripts/skills-code-hash.mjs [ref=origin/main]
// Same as codeHash in server/skills.go: sha256 over (file + NUL + contents + NUL) of SKILLS_FILES, first 12 hex.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const SKILLS_FILES = ['server/skills.go', 'web/skills.html', 'web/skills.css', 'web/skills.js']
const ref = process.argv[2] || 'origin/main'
const h = createHash('sha256')
for (const f of SKILLS_FILES) h.update(f + '\0' + execFileSync('git', ['show', `${ref}:${f}`], { encoding: 'utf8' }) + '\0')
console.log(h.digest('hex').slice(0, 12))
