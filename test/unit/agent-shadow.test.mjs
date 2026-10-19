// R4-M1 (리포트 #4): a local `bg` (a boolean) hid the module's headless-browser state object `bg`, and a timer that
// meant the object wrote to `true` and ended the agent. The module's `bg` is declared once; no local takes the name.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('agent.mjs declares `bg` only once, as the headless browser state', () => {
  const src = fs.readFileSync(new URL('../../agent/agent.mjs', import.meta.url), 'utf8')
  const decl = [...src.matchAll(/\b(?:const|let|var)\s+bg\b\s*=/g)]
  assert.equal(decl.length, 1, `bg 를 선언한 곳이 ${decl.length}군데`)
  assert.match(src.slice(decl[0].index, decl[0].index + 40), /const bg = \{/)
  assert.doesNotMatch(src, /[({,]\s*bg\s*[,)}]\s*=>/, '매개변수 이름 bg')
})
