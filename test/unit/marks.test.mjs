import test from 'node:test'
import assert from 'node:assert/strict'
import { marksStep, MARKS_MAX } from '../../agent/localfull.mjs'
import { readFileSync } from 'node:fs'

test('AC-1836 맥이 세션별 즐겨찾기·제목을 들고, 늦게 바뀐 쪽이 이긴다', () => {
  const now = 1_800_000_000_000
  const a = 'sess-0001'
  const b = 'sess-0002'
  // Nothing kept: the site's (even at 1, marked before there was a time) is kept; an unmarked 0 is kept too.
  let r = marksStep({}, [{ sid: a, at: 1, favorite: true, title: '내 이름' }, { sid: b, at: 0, favorite: false, title: '' }], now)
  assert.deepEqual(r.keep, { [a]: { at: 1, favorite: true, title: '내 이름' }, [b]: { at: 0, favorite: false, title: '' } })
  assert.deepEqual(r.send, [])
  // A new local server: all unmarked at 0. What is kept goes up for a; b is the same, nothing.
  r = marksStep(r.keep, [{ sid: a, at: 0, favorite: false, title: '' }, { sid: b, at: 0, favorite: false, title: '' }], now)
  assert.equal(r.keep, null)
  assert.deepEqual(r.send, [{ sid: a, at: 1, favorite: true, title: '내 이름' }])
  // Changed on the local server later: kept here, then the site's older one makes it go up.
  r = marksStep({ [a]: { at: 1, favorite: true, title: '내 이름' } }, [{ sid: a, at: now - 10, favorite: false, title: '새 이름' }], now)
  assert.deepEqual(r.keep[a], { at: now - 10, favorite: false, title: '새 이름' })
  const kept = r.keep
  r = marksStep(kept, [{ sid: a, at: 1, favorite: true, title: '내 이름' }], now)
  assert.deepEqual(r.send, [{ sid: a, at: now - 10, favorite: false, title: '새 이름' }])
  // Too far ahead, a bad id, not a number: nothing.
  r = marksStep(kept, [{ sid: a, at: now + 10 * 60_000, favorite: true }, { sid: '../x', at: now, favorite: true }, { sid: b, at: 'x' }], now)
  assert.equal(r.keep, null)
  assert.deepEqual(r.send, [])
  // A long title is cut; never more than MARKS_MAX sessions kept (the oldest go).
  r = marksStep({}, [{ sid: a, at: 5, favorite: false, title: 'x'.repeat(200) }], now)
  assert.equal(r.keep[a].title.length, 80)
  const many = {}
  for (let i = 0; i < MARKS_MAX; i++) many[`sess-${String(i).padStart(5, '0')}`] = { at: i + 10, favorite: false, title: '' }
  r = marksStep(many, [{ sid: 'sess-new00001', at: now, favorite: true, title: '' }], now)
  assert.equal(Object.keys(r.keep).length, MARKS_MAX)
  assert.ok(!('sess-00000' in r.keep) && 'sess-new00001' in r.keep)
  // The agent says it carries marks with groups, keeps them only then, and runs nothing for them while trust is on.
  const agent = readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  assert.match(agent, /localFullNow\(\)\.groups \? \['groups', 'marks'\] : \[\]/)
  assert.match(agent, /marks\(cmd\) \{\n    if \(!localFullNow\(\)\.groups\) return/)
  assert.match(agent, /\.filter\(\(e\) => typeof e\?\.sid === 'string' && sessions\.has\(e\.sid\)\)/)
  assert.match(readFileSync(new URL('../../agent/trust.mjs', import.meta.url), 'utf8'), /\n  marks: 'free',/)
})
