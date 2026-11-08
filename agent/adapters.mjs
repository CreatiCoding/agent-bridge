// 로컬 어댑터 (REQ-F-893): programs the Mac's owner put in ~/.claude-bridge/adapters/<name>/ that an extension's
// page may call by action name, through the server and this agent's own outbound link (no port is opened here).
// The agent's signed files are not touched: an adapter is the owner's own folder with an adapter.json:
//   { "ext": "slack", "command": ["node", "adapter.mjs"], "actions": { "thread.read": "read", "thread.reply": "write" }, "timeoutMs": 30000 }
// One call runs the command once in that folder: the request is JSON on stdin, the result is JSON on stdout.
// A write's request id is kept on disk before it runs, so the same id never runs twice (a resend, a reconnect, an
// agent restart): it gets the first outcome back, or 'unknown' when that run's end was never seen.
import fs from 'node:fs'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'

export const ADAPTER_IN_MAX = 64 * 1024
export const ADAPTER_OUT_MAX = 512 * 1024
export const ADAPTER_TIMEOUT_MS = 30_000
export const ADAPTER_TIMEOUT_MAX = 120_000
/** What is kept of each request id: the last JOURNAL_KEEP, none older than JOURNAL_MS. */
export const JOURNAL_KEEP = 300
export const JOURNAL_MS = 24 * 3600_000
/** A write's result kept for a replay; a bigger one is answered as done with result null and resultDropped. */
export const JOURNAL_RESULT_MAX = 16 * 1024

const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/
const EXT_RE = /^[a-z][a-z0-9-]{1,31}$/
export const ACTION_RE = /^[a-z][a-z0-9_-]{0,31}(\.[a-z][a-z0-9_-]{0,31}){0,3}$/
export const REQUEST_RE = /^[A-Za-z0-9_-]{8,64}$/
const BOOT = `${process.pid}-${Date.now()}`

const loose = (st) => process.platform !== 'win32' && ((st.mode & 0o022) !== 0 || (typeof process.getuid === 'function' && st.uid !== process.getuid()))

/** The adapters in stateDir/adapters, and what is wrong with the ones that cannot be used. */
export function readAdapters(stateDir) {
  const root = path.join(stateDir, 'adapters')
  const out = []
  const problems = []
  let names = []
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    return { adapters: out, problems }
  }
  for (const name of names) {
    const dir = path.join(root, name)
    const bad = (why) => problems.push({ name, error: why })
    if (!NAME_RE.test(name)) {
      bad('폴더 이름은 소문자로 시작하는 소문자·숫자·- 2~32자예요')
      continue
    }
    const file = path.join(dir, 'adapter.json')
    let conf
    try {
      // Someone else who can write the folder or the file could make this Mac run anything: refused.
      if (loose(fs.statSync(dir)) || loose(fs.statSync(file))) {
        bad('폴더나 adapter.json 을 다른 사용자가 고칠 수 있어요(chmod go-w, 내 소유로)')
        continue
      }
      conf = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      bad(e.code === 'ENOENT' ? 'adapter.json 이 없어요' : `adapter.json 을 읽지 못했어요: ${e.message}`)
      continue
    }
    if (!conf || typeof conf !== 'object' || !EXT_RE.test(conf.ext ?? '')) {
      bad('ext 에 익스텐션 id 를 적어 주세요')
      continue
    }
    if (!Array.isArray(conf.command) || !conf.command.length || conf.command.some((c) => typeof c !== 'string' || !c)) {
      bad('command 는 ["node", "adapter.mjs"] 같은 글자 목록이에요')
      continue
    }
    const actions = {}
    for (const [a, access] of Object.entries(conf.actions ?? {})) {
      if (!ACTION_RE.test(a) || (access !== 'read' && access !== 'write')) bad(`actions.${a} 는 쓸 수 없어요(이름은 thread.read 모양, 값은 read 또는 write)`)
      else actions[a] = access
    }
    if (!Object.keys(actions).length) {
      bad('actions 가 비었어요')
      continue
    }
    const t = Number(conf.timeoutMs)
    out.push({ name, dir, ext: conf.ext, command: conf.command, actions, timeoutMs: Number.isFinite(t) && t > 0 ? Math.min(t, ADAPTER_TIMEOUT_MAX) : ADAPTER_TIMEOUT_MS })
  }
  return { adapters: out, problems }
}

export class Adapters {
  constructor({ stateDir, now = () => Date.now(), spawn = nodeSpawn, log = () => {} }) {
    this.stateDir = stateDir
    this.now = now
    this.spawn = spawn
    this.log = log
    this.file = path.join(stateDir, 'adapters-journal.json')
    this.running = new Map() // ext|requestId → Promise of the outcome, in this process
    this.reads = new Map() // ext|requestId → a read's outcome, in memory only
    this.journal = this.load()
  }
  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
    } catch {
      return {}
    }
  }
  save() {
    const t = this.now()
    const keep = Object.entries(this.journal)
      .filter(([, e]) => t - e.at < JOURNAL_MS)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, JOURNAL_KEEP)
    this.journal = Object.fromEntries(keep)
    fs.mkdirSync(this.stateDir, { recursive: true })
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.journal), { mode: 0o600 })
    fs.renameSync(`${this.file}.tmp`, this.file)
  }
  /** This extension's actions on this Mac, and the adapters that could not be read (for its owner to fix). */
  list(ext) {
    const { adapters, problems } = readAdapters(this.stateDir)
    const actions = {}
    for (const a of adapters) if (a.ext === ext) for (const [n, access] of Object.entries(a.actions)) actions[n] ??= access
    return { actions, problems: problems.slice(0, 20) }
  }
  /** What became of a request id: none (never arrived: safe to send again), running, done, failed, unknown. */
  status(ext, requestId) {
    const k = `${ext}|${requestId}`
    if (this.running.has(k)) return { state: 'running' }
    const e = this.journal[k] ?? this.reads.get(k)
    if (!e) return { state: 'none' }
    return this.view(e, false)
  }
  view(e, replayed) {
    const base = { state: e.state === 'running' && e.boot !== BOOT ? 'unknown' : e.state, action: e.action, ...(replayed ? { replayed: true } : {}) }
    if (base.state === 'unknown' && e.state === 'running') base.error = '실행하던 중 에이전트가 다시 시작돼 끝을 보지 못했어요'
    if (base.state === 'done') return { ...base, result: e.result ?? null, ...(e.resultDropped ? { resultDropped: true } : {}) }
    return { ...base, ...(e.error ? { error: e.error } : {}), ...(e.code ? { code: e.code } : {}) }
  }
  /** Runs one action once. Never throws: the outcome's state says what happened. */
  async call({ ext, action, access, input, requestId, sid, cwd }) {
    if (!EXT_RE.test(ext ?? '') || !ACTION_RE.test(action ?? '') || !REQUEST_RE.test(requestId ?? '')) return { state: 'refused', code: 'bad-request', error: '익스텐션·작업 이름·요청 id 모양이 맞지 않아요' }
    const k = `${ext}|${requestId}`
    const was = this.running.get(k)
    if (was) return { ...(await was), replayed: true }
    const old = this.journal[k] ?? this.reads.get(k)
    if (old) {
      if (old.action !== action) return { state: 'refused', code: 'request-reused', error: '같은 요청 id 를 다른 작업에 썼어요' }
      return this.view(old, true)
    }
    const raw = JSON.stringify(input ?? null)
    if (raw.length > ADAPTER_IN_MAX) return { state: 'refused', code: 'too-large', error: `입력이 ${ADAPTER_IN_MAX / 1024}KB 를 넘어요` }
    const { adapters } = readAdapters(this.stateDir)
    const a = adapters.find((x) => x.ext === ext && x.actions[action])
    if (!a) return { state: 'refused', code: 'not-installed', error: `이 맥에 ${ext} 의 ${action} 어댑터가 없어요` }
    if (a.actions[action] !== access) return { state: 'refused', code: 'access', error: `${action} 은 ${a.actions[action] === 'write' ? '쓰기' : '읽기'} 작업이에요` }
    const write = access === 'write'
    const entry = { ext, action, access, state: 'running', at: this.now(), boot: BOOT }
    // Kept before it runs: if this agent stops halfway, the id answers unknown and is never run again.
    if (write) {
      this.journal[k] = entry
      this.save()
    }
    const p = this.run(a, { ext, action, access, input: input ?? null, requestId, session: { id: sid ?? null, cwd: cwd ?? null } }, write).then((out) => {
      Object.assign(entry, { state: out.state, error: out.error, code: out.code })
      if (out.state === 'done') {
        const size = JSON.stringify(out.result ?? null).length
        if (write && size > JOURNAL_RESULT_MAX) entry.resultDropped = true
        else entry.result = out.result
      }
      if (write) this.save()
      else this.reads.set(k, entry), setTimeout(() => this.reads.delete(k), 10 * 60_000).unref?.()
      this.running.delete(k)
      return out
    })
    this.running.set(k, p)
    return p
  }
  run(a, req, write) {
    return new Promise((resolve) => {
      const t0 = this.now()
      let child
      try {
        const cmd = a.command[0].startsWith('./') ? path.join(a.dir, a.command[0]) : a.command[0]
        child = this.spawn(cmd, a.command.slice(1), {
          cwd: a.dir,
          // Its own process group, so a timeout stops what it started too (the CLI it runs).
          detached: process.platform !== 'win32',
          env: { ...process.env, BRIDGE_ADAPTER_ACTION: req.action, BRIDGE_ADAPTER_ACCESS: req.access, BRIDGE_REQUEST_ID: req.requestId },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (e) {
        return resolve({ state: 'failed', code: 'spawn', error: `어댑터를 시작하지 못했어요: ${e.message}` })
      }
      let out = Buffer.alloc(0)
      let err = ''
      let ended = false
      let why = null
      const stop = () => {
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM')
          else child.kill('SIGTERM')
        } catch {}
        setTimeout(() => {
          try {
            if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
            else child.kill('SIGKILL')
          } catch {}
        }, 2000).unref?.()
      }
      const timer = setTimeout(() => ((why = 'timeout'), stop()), a.timeoutMs)
      child.stdout.on('data', (d) => {
        if (why) return
        out = Buffer.concat([out, d])
        if (out.length > ADAPTER_OUT_MAX) (why = 'too-large'), stop()
      })
      child.stderr.on('data', (d) => (err = (err + d).slice(-2000)))
      child.stdin.on('error', () => {})
      const finish = (code, e) => {
        if (ended) return
        ended = true
        clearTimeout(timer)
        const ms = this.now() - t0
        const tail = err.trim().split('\n').slice(-3).join(' ').slice(0, 300)
        // A write stopped halfway may have done its work already: unknown, never failed.
        const cut = (c, m) => (write ? { state: 'unknown', code: c, error: `${m}. 실행됐는지 알 수 없어요` } : { state: 'failed', code: c, error: m })
        let r
        if (e) r = { state: 'failed', code: 'spawn', error: `어댑터를 시작하지 못했어요: ${e.message}` }
        else if (why === 'timeout') r = cut('timeout', `${Math.round(a.timeoutMs / 1000)}초 안에 끝나지 않았어요`)
        else if (why === 'too-large') r = cut('too-large', `결과가 ${ADAPTER_OUT_MAX / 1024}KB 를 넘었어요`)
        else if (code !== 0) r = { state: 'failed', code: 'exit', error: `어댑터가 ${code} 로 끝났어요${tail ? `: ${tail}` : ''}` }
        else {
          try {
            const text = out.toString('utf8').trim()
            r = { state: 'done', result: text ? JSON.parse(text) : null }
          } catch {
            r = cut('bad-output', '어댑터가 JSON 이 아닌 것을 냈어요')
          }
        }
        this.log(r.state === 'done' ? 'info' : 'warn', `${a.name} ${req.action} ${r.state}${r.code ? `(${r.code})` : ''} ${ms}ms`)
        resolve(r)
      }
      child.on('error', (e) => finish(null, e))
      child.on('close', (code) => finish(code))
      child.stdin.end(JSON.stringify(req))
    })
  }
}
