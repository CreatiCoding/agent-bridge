// 맥 기준 세션 목록 (REQ-F-927): what the agent tells each server at hello so the servers follow the Mac.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lastLineAt, LAST_LINE_BYTES } from '../../agent/localfull.mjs'

const src = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')

// AC-1851
test("a conversation's time is its last person's or assistant's line, read from the file's end", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ml-'))
  const f = path.join(dir, 'c.jsonl')
  const line = (o) => JSON.stringify(o) + '\n'
  fs.writeFileSync(f, line({ type: 'user', timestamp: '2026-11-18T01:00:00.000Z' }) + line({ type: 'assistant', timestamp: '2026-11-24T02:00:00.000Z' }) + line({ type: 'summary', timestamp: '2026-11-25T03:00:00.000Z' }) + 'not json "timestamp"\n')
  assert.equal(lastLineAt(f), Date.parse('2026-11-24T02:00:00.000Z'))
  // Only the end is read: a long file's first line is not looked at, and a cut first piece is never parsed.
  fs.writeFileSync(f, line({ type: 'user', timestamp: '2026-11-18T01:00:00.000Z' }) + 'x'.repeat(LAST_LINE_BYTES) + '\n' + line({ type: 'system' }))
  assert.equal(lastLineAt(f), null)
  assert.equal(lastLineAt(path.join(dir, 'none.jsonl')), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('hello says it lists every session and when each last moved; a linking server gets the last tidy report', () => {
  assert.match(src, /t: 'hello', caps: \[[^\]]*'listed'/)
  assert.match(src, /seq: st\.tailSeq\(id\), at: lastLineAt\(transcriptPath\(s, id\)\)/)
  assert.match(src, /if \(report\) lastTidyReport = report/)
  assert.match(src, /link\.welcomed = true\n.*\n\s+if \(lastTidyReport\) emitTo\(link, \{ t: 'tidyReport', report: lastTidyReport, again: true \}\)/)
})
