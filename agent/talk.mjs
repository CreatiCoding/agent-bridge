// 대화 모드 (REQ-F-907), the Mac's half: an answer's sentences read aloud in a Korean woman's voice, and the small
// model the page asks only when its own rules cannot tell (has the person finished? how is a code-heavy answer said
// in a line?). Nothing leaves the Mac but what Claude Code itself sends to its model.
import { execFile, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const err = (code, message) => Object.assign(new Error(message), { code })

// ---------- voice

/** The Korean voices `say -v '?'` lists, best first: Premium, then Enhanced, then the plain one; women's voices first. */
export function koreanVoices(list) {
  const rank = (n) => (/premium/i.test(n) ? 0 : /enhanced|향상/i.test(n) ? 1 : 2)
  const women = /yuna|유나|sora|소라|jian|지안/i
  return String(list)
    .split('\n')
    .map((l) => /^(.+?)\s{2,}(ko[_-]KR)\b/.exec(l)?.[1]?.trim())
    .filter(Boolean)
    .sort((a, b) => rank(a) - rank(b) || Number(!women.test(a)) - Number(!women.test(b)))
}

/**
 * macOS's own speech: `say` into a 24 kHz 16-bit WAV (every browser decodes WAV). The voice is the best Korean
 * one installed (시스템 설정 → 손쉬운 사용 → 읽기 및 말하기 → 시스템 목소리 → 관리 에서 Yuna (프리미엄) 을 받으면 그것).
 */
export class SayVoice {
  constructor({ run = execFile, tmp = os.tmpdir() } = {}) {
    this.run = run
    this.tmp = tmp
    this.voice = null
  }
  exec(args) {
    return new Promise((resolve, reject) => this.run('say', args, { timeout: 30_000 }, (e, out) => (e ? reject(e) : resolve(String(out ?? '')))))
  }
  async pick() {
    if (this.voice) return this.voice
    const v = koreanVoices(await this.exec(['-v', '?']).catch(() => ''))[0]
    if (!v) throw err('novoice', '이 맥에 한국어 목소리가 없어요. 시스템 설정 → 손쉬운 사용 → 읽기 및 말하기에서 Yuna 를 받아 주세요')
    return (this.voice = v)
  }
  async speak(text) {
    const voice = await this.pick()
    const out = path.join(this.tmp, `cb-talk-${crypto.randomBytes(6).toString('hex')}.wav`)
    try {
      await this.exec(['-v', voice, '--file-format=WAVE', '--data-format=LEI16@24000', '-o', out, text])
      return { audio: fs.readFileSync(out).toString('base64'), mime: 'audio/wav', engine: `say:${voice}` }
    } finally {
      fs.rmSync(out, { force: true })
    }
  }
}

// ---------- the small model

export const JUDGE_SYSTEM = [
  '너는 음성 대화를 돕는 판정기야. 묻는 것에만 정해진 형식으로 짧게 답해.',
  'TURN: 사람이 방금 한 말을 보고, 말을 끝냈으면 DONE, 이어서 더 말할 것 같으면 MORE 한 단어만 답해.',
  'SAY: 마크다운 답을 보고, 소리 내어 읽을 한국어 한두 문장으로 요약해. 코드·경로·주소·기호는 읽지 말고 뜻만 말해. 문장만 답해.',
].join('\n')

export const turnPrompt = (text) => `TURN\n${text}`
export const sayPrompt = (md) => `SAY\n${md}`
/** The model's word for a turn: DONE or MORE, anything else is more (waiting a little costs less than cutting in). */
export const parseTurn = (out) => (/\bDONE\b/i.test(String(out)) && !/\bMORE\b/i.test(String(out)) ? 'done' : 'more')

/**
 * One `claude -p` kept up in stream-json, so a question costs the model's answer and not a start (a few seconds).
 * It is started again after `fresh` questions (its conversation grows with each) or once it has been idle `idleMs`.
 */
export class Judge {
  constructor({ bin = 'claude', env = process.env, model = 'haiku', run = spawn, log = () => {}, fresh = 12, idleMs = 5 * 60_000 } = {}) {
    Object.assign(this, { bin, env, model, run, log, fresh, idleMs })
    this.proc = null
    this.asked = 0
    this.buf = ''
    this.wait = null
    this.chain = Promise.resolve()
    this.idle = null
  }
  start() {
    const p = this.run(this.bin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', this.model, '--system-prompt', JUDGE_SYSTEM, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands'], {
      cwd: os.homedir(),
      env: this.env,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    this.proc = p
    this.asked = 0
    this.buf = ''
    p.stdin.on('error', () => {})
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', (d) => {
      this.buf += d
      for (let i = this.buf.indexOf('\n'); i !== -1; i = this.buf.indexOf('\n')) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        let j
        try {
          j = JSON.parse(line)
        } catch {
          continue
        }
        if (j.type === 'result') this.wait?.(j.is_error ? { error: String(j.result ?? '판정 실패') } : { text: String(j.result ?? '') })
      }
    })
    const gone = () => {
      if (this.proc !== p) return
      this.proc = null
      this.wait?.({ error: '판정기가 멈췄어요' })
    }
    p.on('exit', gone)
    p.on('error', gone)
    return p
  }
  stop() {
    const p = this.proc
    this.proc = null
    try {
      p?.stdin.end()
      p?.kill('SIGTERM')
    } catch {}
  }
  /** The model's answer to one question (one at a time). */
  ask(prompt, timeoutMs = 20_000) {
    const run = async () => {
      clearTimeout(this.idle)
      if (this.proc && this.asked >= this.fresh) this.stop()
      const p = this.proc ?? this.start()
      this.asked++
      const r = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ error: '판정이 오래 걸려요' }), timeoutMs)
        this.wait = (x) => (clearTimeout(timer), (this.wait = null), resolve(x))
        p.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`)
      })
      if (r.error) this.stop()
      this.idle = setTimeout(() => this.stop(), this.idleMs)
      this.idle.unref?.()
      if (r.error) throw err('judge', r.error)
      return r.text.trim()
    }
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => {})
    return next
  }
}

/** The agent's `talk` command: { op: tts | turn | brief, text } → what the server hands the page. */
export async function talk({ op, text }, { voice, judge }) {
  const t0 = Date.now()
  const s = String(text ?? '').trim()
  if (!s) throw err('empty', '말이 비었어요')
  if (op === 'tts') return { ...(await voice.speak(s.slice(0, 600))), ms: Date.now() - t0 }
  if (op === 'turn') return { end: parseTurn(await judge.ask(turnPrompt(s.slice(0, 2000)))), ms: Date.now() - t0 }
  if (op === 'brief') return { line: (await judge.ask(sayPrompt(s.slice(0, 6000)))).slice(0, 600), ms: Date.now() - t0 }
  throw err('op', `모르는 op: ${op}`)
}
