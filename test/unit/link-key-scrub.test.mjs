// An agent's link key never leaves the Mac (REQ-S-081): the agent hides its own keys before sending, and the server
// hides the two forms a key is written in (a link address, a hook header) before keeping anything, for older agents.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { hideKeys, hideKeysDeep } from '../../agent/scrub.mjs'
import { startServer } from './server-harness.mjs'
import { mac } from './fake-mac.mjs'

const KEY = crypto.randomBytes(24).toString('base64url')
const HOOK = crypto.randomBytes(24).toString('base64url')
const ps = `831266 /opt/google/chrome/chrome --headless=new --user-data-dir=/home/u/.claude-bridge/browser https://b.test/api/auth/qr/f6ef2e04#port=4317&key=${KEY}&bg=1`

test('hideKeys: 연동 주소의 key= 와 x-bridge-key 머리, 이 기기의 키 값을 *** 로', () => {
  assert.equal(hideKeys(ps), ps.replace(KEY, '***'))
  assert.equal(hideKeys(`https://b.test/bridge#key=${KEY}`), 'https://b.test/bridge#key=***')
  assert.equal(hideKeys(`x-bridge-key: ${HOOK}\n`), 'x-bridge-key: ***\n')
  assert.equal(hideKeys(`키는 ${KEY} 이고 훅은 "${HOOK}"`, [KEY, HOOK]), '키는 *** 이고 훅은 "***"')
  // Short values and ordinary query strings stay: only something as long as a key is hidden.
  assert.equal(hideKeys('a?x=1&key=abc'), 'a?x=1&key=abc')
  assert.equal(hideKeys('짧은 값', ['', 'abc', undefined]), '짧은 값')
  assert.equal(hideKeys(undefined), '')
})

test('hideKeysDeep: 메시지 안의 모든 글자를 걸러도 모양은 그대로', () => {
  const msg = { t: 'lines', sid: 's1', n: 3, ok: true, lines: [{ text: ps, tool: { input: { command: 'ps -ef' } } }, null] }
  const out = hideKeysDeep(msg, [KEY])
  assert.deepEqual(out, { ...msg, lines: [{ text: ps.replace(KEY, '***'), tool: { input: { command: 'ps -ef' } } }, null] })
  assert.ok(!JSON.stringify(out).includes(KEY))
})

test('서버: 옛 에이전트가 키를 담아 올려도 저장하기 전에 가린다', async () => {
  const srv = await startServer()
  try {
    await srv.login('alice')
    const m = await mac(srv, 'alice', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'srv')
    const r = await m.up({ t: 'logs', entries: [{ ts: Date.now(), level: 'info', area: 'test', text: `${ps}\nx-bridge-key: ${HOOK}` }] })
    assert.equal(r.status, 200)
    let text = ''
    for (let i = 0; i < 20 && !text; i++) {
      const got = await srv.api('alice', '/api/hosts/aaaaaaaa-0000-4000-8000-0000000000c1/logs')
      text = (got.json.entries ?? []).map((e) => e.text).join('\n')
      if (!text) await new Promise((res) => setTimeout(res, 100))
    }
    assert.match(text, /#port=4317&key=\*\*\*&bg=1/)
    assert.match(text, /x-bridge-key: \*\*\*/)
    assert.ok(!text.includes(KEY) && !text.includes(HOOK), '키가 남지 않음')
    m.close()
  } finally {
    await srv.stop()
  }
})
