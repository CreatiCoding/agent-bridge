// The session that handed work takes over when the delegated one ends a turn (1.236, 1.241, 1.390, 1.391): the setup
// the delegate-follow-*.test.mjs files share. One scene per file so node --test runs them at once (tests in one file
// run one after another). The server's settle (DELEGATE_SETTLE_MS, 5,000 ms by default) is cut short with
// BRIDGE_DELEGATE_SETTLE_MS, and the fixed waits here are multiples of it (1.494).
import { startServer } from './server-harness.mjs'
import { mac } from './fake-mac.mjs'

/** The server's settle in these tests (ms). */
export const SETTLE = 500
/** How long to watch when checking that something does not come: several settles. */
export const QUIET = SETTLE * 4

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Mac A (mac-a) with a session P (alive, idle) and Mac B (mac-b); runs run(rig) and cleans up.
 * rig.ask(op, args): P calls a bridge MCP tool (a delegate request up), and the answer (delegated) is waited for.
 */
export async function withDelegateRig(run) {
  const s = await startServer({ env: { BRIDGE_DELEGATE_SETTLE_MS: String(SETTLE) } })
  const A = 'aaaaaaaa-0000-4000-8000-00000000001a'
  const B = 'bbbbbbbb-0000-4000-8000-00000000001b'
  let a, b
  try {
    await s.login('alice')
    a = await mac(s, 'alice', A, 'mac-a')
    b = await mac(s, 'alice', B, 'mac-b')
    const started = s.api('alice', '/api/sessions', { method: 'POST', body: { hostId: A, cwd: '~', prompt: '시작' } })
    await a.answerNew()
    const parent = (await started).json.id
    await a.up({ t: 'status', sid: parent, alive: true, phase: 'idle' })
    const ask = async (op, args) => {
      const areq = `r-${Math.random()}`
      await a.up({ t: 'delegate', areq, sid: parent, op, args })
      return a.next((m) => m.t === 'delegated' && m.areq === areq, 15000)
    }
    await run({ s, a, b, parent, ask })
  } finally {
    a?.close()
    b?.close()
    await s.stop()
  }
}
