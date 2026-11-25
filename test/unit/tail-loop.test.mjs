// AC-1848 (REQ-F-386): on a Mac with 90 sessions the last reply of a turn reached the site 17–52 s late. The one
// 700 ms tick read the transcripts and then awaited each session's folder sync (git, `gh pr view` per repository),
// so a slow folder held every other session's lines back. The transcripts now have their own timer, and the tick
// starts folder syncs without waiting for them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
const loops = src.slice(src.indexOf('// ---------- loops ----------'), src.indexOf('// ---------- http (loopback only) ----------'))
const timers = loops.split(/\n(?=setInterval\()/).filter((b) => b.startsWith('setInterval('))

test('the tick no longer awaits a folder sync, nor reads the transcripts itself', () => {
  const tick = timers.find((b) => b.includes('ticking = true'))
  assert.ok(tick, 'tick 을 찾지 못함')
  assert.doesNotMatch(tick, /await\s+syncFolder\(/)
  assert.doesNotMatch(tick, /\btail\(sid, s\)/)
  assert.match(tick, /folderBusy/)
  assert.match(tick, /foldersBusy < FOLDER_PAR/)
})

test('the transcripts have their own timer that awaits nothing', () => {
  const t = timers.find((b) => /\btail\(sid, s\)/.test(b))
  assert.ok(t, 'tail 을 부르는 타이머가 없음')
  assert.doesNotMatch(t, /\bawait\b/)
  assert.match(t, /\}, TAIL_MS\)/)
  assert.match(t, /keepBrowser/)
})

test('endTurn reads the transcript again a few times after the turn ends', () => {
  const end = src.slice(src.indexOf('function endTurn('), src.indexOf('function maybeRefresh('))
  assert.match(end, /END_TAIL_MS/)
  assert.match(src, /const END_TAIL_MS = \[[\d, ]+\]/)
})
