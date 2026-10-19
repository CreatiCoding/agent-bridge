import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claimLogin, heldBy, loadPins } from '../../server/login-pin.mjs'

// R1-L1 (리포트 #1, #3): a renamed operator's old name, taken by another GitHub account, must not sign that account
// in as the operator, also after the operator has signed in under the new name.
test('a login name stays with the GitHub account first seen with it, across a rename', () => {
  const pins = loadPins(null, { gh1: { login: 'Boss' }, 'dev-x': { login: 'x' } })
  assert.deepEqual({ ...pins }, { boss: 'gh1' }, 'dev 로그인은 GitHub 계정이 아님')
  assert.equal(claimLogin(pins, 'gh1', 'boss'), null, '같은 계정은 그대로')
  assert.equal(claimLogin(pins, 'gh1', 'NewBoss'), null)
  assert.equal(claimLogin(pins, 'gh2', 'boss'), 'gh1')
  assert.equal(pins.boss, 'gh1')
})

// R4-M2 (리포트 #4): a name let go came back at the next start, pinned again from users.json.
test('a name an operator let go stays free after a restart', () => {
  const users = { gh1: { login: 'boss' } }
  const pins = loadPins(null, users)
  delete pins.boss
  const saved = JSON.parse(JSON.stringify(pins))
  const after = loadPins(saved, users)
  assert.equal(heldBy(after, 'gh2', 'boss'), null)
  assert.equal(claimLogin(after, 'gh2', 'boss'), null)
})

// R4-L1 (리포트 #4): names like `constructor` were read off the object's prototype as held.
test('a name that is also an object property name is a name like any other', () => {
  const pins = loadPins({}, {})
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal(heldBy(pins, 'gh9', name), null, name)
  assert.equal(claimLogin(pins, 'gh9', 'constructor'), null)
  assert.equal(heldBy(pins, 'gh8', 'constructor'), 'gh9')
})

// R8-L2 (리포트 #8): made again from users.json, a name let go (`<name>#released`) stays free, the others stay held.
test('pins made again from users.json keep released names free', () => {
  const pins = loadPins(null, { gh1: { login: 'boss#released' }, gh2: { login: 'alice' } })
  assert.equal(heldBy(pins, 'gh9', 'boss'), null)
  assert.equal(heldBy(pins, 'gh9', 'alice'), 'gh2')
})
