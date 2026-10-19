// The changelog in Settings (ui/src/lib/changes.ts) keeps up with SPEC: every SPEC 판 has its release there.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../../', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')

test('the newest release in 변경 기록 is the SPEC version this commit carries', () => {
  const spec = read('docs/SPEC.md').match(/^\| (\d+\.\d+) \| \d{4}-\d{2}-\d{2} \| 확정/m)?.[1]
  const versions = [...read('ui/src/lib/changes.ts').split('export const CHANGES')[1].matchAll(/version: '(\d+\.\d+)'/g)].map((m) => m[1])
  assert.ok(spec, 'SPEC 머리에서 판을 읽음')
  assert.equal(versions[0], spec, `SPEC ${spec} 판을 ui/src/lib/changes.ts 맨 위에 더해 주세요`)
  assert.equal(new Set(versions).size, versions.length, '같은 판이 두 번 있지 않음')
})
