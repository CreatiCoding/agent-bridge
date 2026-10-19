// A Mac played by a test through the bridge tab's routes: hello, the command stream, and the way back up.
import assert from 'node:assert/strict'

/** A Mac's bridge tab: hello, the command stream, and the way back. */
export async function mac(s, who, hostId, name) {
  const hello = await s.api(who, '/api/bridge/hello', { method: 'POST', body: { hostId, name } })
  assert.equal(hello.status, 200)
  const conn = hello.json.conn
  const got = []
  const waiters = []
  const res = await fetch(`${s.origin}/api/bridge/stream?hostId=${hostId}&conn=${conn}`, { headers: { cookie: s.jar(who) } })
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  ;(async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }))
      if (done) return
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i)
        buf = buf.slice(i + 2)
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue
          let m
          try {
            m = JSON.parse(line.slice(6))
          } catch {
            continue
          }
          got.push(m)
          for (const w of [...waiters]) if (w.pick(m)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(m))
        }
      }
    }
  })()
  const up = (...msgs) => s.api(who, '/api/bridge/up', { method: 'POST', body: { hostId, conn, msgs } })
  const next = (pick, ms = 8000) => {
    const seen = got.find(pick)
    if (seen) return (got.splice(got.indexOf(seen), 1), Promise.resolve(seen))
    return new Promise((resolve, reject) => {
      const w = { pick, resolve: (m) => (got.splice(got.indexOf(m), 1), clearTimeout(t), resolve(m)) }
      const t = setTimeout(() => (waiters.splice(waiters.indexOf(w), 1), reject(new Error(`${name}: 기다린 명령이 오지 않음`))), ms)
      waiters.push(w)
    })
  }
  // Every new session is started at once, the way the agent answers.
  const answerNew = async () => {
    const m = await next((x) => x.t === 'new')
    await up({ t: 'opened', reqId: m.reqId, sid: m.sid, ok: true, cwd: '/Users/x' })
    return m
  }
  return { hostId, conn, up, next, answerNew, close: () => reader.cancel().catch(() => {}) }
}

