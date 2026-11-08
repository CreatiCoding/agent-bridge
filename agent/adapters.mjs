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
/**
 * A write's request id is kept JOURNAL_MS and only age forgets it (1.503): more writes never push one out, or the
 * same id could run again. At most JOURNAL_MAX of them: when full a new write is refused before it runs
 * (journal-full). Results are kept for the newest JOURNAL_KEEP only; an older one replays as done, resultDropped.
 */
export const JOURNAL_KEEP = 300
export const JOURNAL_MS = 24 * 3600_000
export const JOURNAL_MAX = 3000
/** A write's result kept for a replay; a bigger one is answered as done with result null and resultDropped. */
export const JOURNAL_RESULT_MAX = 16 * 1024
/**
 * A request id that status found never arrived is closed (REQ-S-101): kept CLOSED_MS (longer than a signature is
 * good for, trust.mjs SKEW_MS both ways) so a call a server held back is refused when it comes, never run after the
 * page was told none. Only age forgets a closed id (1.503): at CLOSED_KEEP status answers unknown (closed-full)
 * instead of none, never dropping an id it already promised. Apart from the journal so they never push out what ran.
 */
export const CLOSED_MS = 5 * 60_000
export const CLOSED_KEEP = 500

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
    // ext|requestId closed in memory but not yet on disk (a save failed): refused here, never answered none (1.504).
    this.unsaved = new Set()
    this.journal = this.load()
  }
  load() {
    let text = null
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') return {}
    }
    try {
      const j = text === null ? null : JSON.parse(text)
      if (j && typeof j === 'object' && !Array.isArray(j)) return j
    } catch {}
    // Unreadable: the ids it closed or ran may be lost. Kept aside as .bad, whose time says for how long nothing
    // runs and nothing is promised (lost()), across more restarts too.
    try {
      fs.renameSync(this.file, `${this.file}.bad`)
    } catch {}
    try {
      fs.writeFileSync(`${this.file}.bad`, '', { flag: 'a', mode: 0o600 })
      fs.utimesSync(`${this.file}.bad`, new Date(this.now()), new Date(this.now()))
    } catch {}
    this.log('warn', '어댑터 기록(adapters-journal.json)을 읽지 못했어요. 5 분 동안 어댑터를 실행하지 않아요')
    return {}
  }
  /** True while a journal lost by load() may still hold a closed id that a good signature could come for. */
  lost() {
    try {
      return this.now() - fs.statSync(`${this.file}.bad`).mtimeMs < CLOSED_MS
    } catch {
      return false
    }
  }
  /** Ids still kept: closed ones younger than CLOSED_MS, or write ids younger than JOURNAL_MS. */
  kept(closed) {
    const t = this.now()
    let n = 0
    for (const e of Object.values(this.journal)) if ((e.state === 'closed') === closed && t - e.at < (closed ? CLOSED_MS : JOURNAL_MS)) n++
    return n
  }
  save() {
    const t = this.now()
    const all = Object.entries(this.journal).sort((a, b) => b[1].at - a[1].at)
    // Only age forgets an id. Room is made by refusing new ones (status closed-full, call journal-full), never by
    // dropping one: a dropped closed id could run after none, a dropped write id could run twice.
    const ran = all.filter(([, e]) => e.state !== 'closed' && t - e.at < JOURNAL_MS)
    ran.forEach(([, e], i) => {
      if (i >= JOURNAL_KEEP && 'result' in e) (delete e.result, (e.resultDropped = true))
    })
    const closed = all.filter(([, e]) => e.state === 'closed' && t - e.at < CLOSED_MS)
    this.journal = Object.fromEntries([...ran, ...closed])
    fs.mkdirSync(this.stateDir, { recursive: true })
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.journal), { mode: 0o600 })
    fs.renameSync(`${this.file}.tmp`, this.file)
    // Everything in memory is on disk now, the ids a failed save left behind too.
    this.unsaved.clear()
  }
  /** This extension's actions on this Mac, and the adapters that could not be read (for its owner to fix). */
  list(ext) {
    const { adapters, problems } = readAdapters(this.stateDir)
    const actions = {}
    for (const a of adapters) if (a.ext === ext) for (const [n, access] of Object.entries(a.actions)) actions[n] ??= access
    return { actions, problems: problems.slice(0, 20) }
  }
  /**
   * What became of a request id: none (never arrived, and from now on never runs: send again with a new id),
   * running, done, failed, unknown. `at` is this Mac's time of the answer.
   * none is answered only once the closed id is on disk (1.503). When that cannot be promised (the table is full,
   * the journal was lost or cannot be written) the answer is unknown with a code, and the id is not closed.
   */
  status(ext, requestId) {
    if (!EXT_RE.test(ext ?? '') || !REQUEST_RE.test(requestId ?? '')) return { state: 'refused', code: 'bad-request', error: '익스텐션·요청 id 모양이 맞지 않아요' }
    const k = `${ext}|${requestId}`
    if (this.running.has(k)) return { state: 'running' }
    const e = this.journal[k] ?? this.reads.get(k)
    const cannot = (code, why) => ({ state: 'unknown', code, error: `${why}. 이 요청 id 가 나중에 실행되지 않는다고 약속할 수 없어요. 잠시 뒤 다시 확인하거나 새 id 로 보내기 전에 결과를 확인하세요` })
    // none only for a closed id that is on disk: one a failed save left in memory is written first (1.504).
    if (e?.state === 'closed') return this.unsaved.has(k) && !this.persist() ? cannot('journal', '어댑터 기록을 디스크에 쓰지 못했어요') : { state: 'none', at: this.now() }
    if (e) return this.view(e, false)
    if (this.lost()) return cannot('journal-lost', '어댑터 기록을 읽지 못해 5 분 동안 확인할 수 없어요')
    if (this.kept(true) >= CLOSED_KEEP) return cannot('closed-full', `닫아 둔 요청 id 가 ${CLOSED_KEEP}개로 가득해요`)
    this.journal[k] = { ext, state: 'closed', at: this.now() }
    // Not written: still refused in this process (the entry stays), but a restart would forget it: not promised.
    this.unsaved.add(k)
    if (!this.persist()) return cannot('journal', '어댑터 기록을 디스크에 쓰지 못했어요')
    return { state: 'none', at: this.now() }
  }
  /** save(), true once it is on disk. */
  persist() {
    try {
      this.save()
      return true
    } catch (err) {
      this.log('warn', `어댑터 기록을 쓰지 못했어요: ${err.message}`)
      return false
    }
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
      if (old.state === 'closed') return { state: 'refused', code: 'request-closed', error: '이 요청 id 는 상태 확인에서 "도착하지 않음"으로 닫혔어요. 실행하지 않았어요. 새 id 로 다시 요청하세요' }
      if (old.action !== action) return { state: 'refused', code: 'request-reused', error: '같은 요청 id 를 다른 작업에 썼어요' }
      return this.view(old, true)
    }
    // The lost journal may have closed this id, or run it: nothing runs until a signature for it can no longer be good.
    if (this.lost()) return { state: 'refused', code: 'journal-lost', error: '어댑터 기록을 읽지 못해 5 분 동안 실행하지 않아요. 실행하지 않았어요' }
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
      if (this.kept(false) >= JOURNAL_MAX) return { state: 'refused', code: 'journal-full', error: `24 시간 안의 쓰기 요청 id 가 ${JOURNAL_MAX}개로 가득해 중복 실행을 막을 수 없어요. 실행하지 않았어요` }
      this.journal[k] = entry
      try {
        this.save()
      } catch (err) {
        delete this.journal[k]
        this.log('warn', `어댑터 기록을 쓰지 못했어요: ${err.message}`)
        return { state: 'refused', code: 'journal', error: '어댑터 기록을 디스크에 쓰지 못해 실행하지 않았어요' }
      }
    }
    const p = this.run(a, { ext, action, access, input: input ?? null, requestId, session: { id: sid ?? null, cwd: cwd ?? null } }, write).then((out) => {
      Object.assign(entry, { state: out.state, error: out.error, code: out.code })
      if (out.state === 'done') {
        const size = JSON.stringify(out.result ?? null).length
        if (write && size > JOURNAL_RESULT_MAX) entry.resultDropped = true
        else entry.result = out.result
      }
      if (write) {
        // Not written: the id stays 'running' on disk (unknown after a restart), never forgotten.
        try {
          this.save()
        } catch (err) {
          this.log('warn', `어댑터 기록을 쓰지 못했어요: ${err.message}`)
        }
      } else this.reads.set(k, entry), setTimeout(() => this.reads.delete(k), 10 * 60_000).unref?.()
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

/**
 * A call's input as the agent got it (REQ-S-101): inputJ, the JSON text the page signed the hash of (a sealed piece
 * while sealing, opened by open(text) which throws when it does not open), or else the plain input of an unsigned
 * call. Returns {input} or {error}.
 */
export function adapterInput(cmd, open = (t) => t) {
  if (typeof cmd?.inputJ !== 'string') return { input: cmd?.input ?? null }
  let text
  try {
    text = open(cmd.inputJ)
  } catch (e) {
    return { error: e.message }
  }
  if (typeof text !== 'string' || text.length > ADAPTER_IN_MAX) return { error: `입력이 ${ADAPTER_IN_MAX / 1024}KB 를 넘거나 읽을 수 없어요` }
  try {
    return { input: JSON.parse(text) }
  } catch {
    return { error: '입력이 JSON 이 아니에요' }
  }
}
