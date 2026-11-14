// 대화 모드 (REQ-F-907), the Mac's half: an answer's sentences read aloud in a Korean woman's voice, and the small
// model the page asks only when its own rules cannot tell (has the person finished? how is a code-heavy answer said
// in a line?). Nothing leaves the Mac but what Claude Code itself sends to its model.
import { execFile, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 대화 모드의 읽는 속도 (REQ-F-907): the page's choice (0.5~2, × each voice's normal), 1.5 when it says none. */
export const TALK_SPEED = 1.5
export const talkRate = (r) => (typeof r === 'number' && Number.isFinite(r) ? Math.min(2, Math.max(0.5, r)) : TALK_SPEED)

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
  async speak(text, rate = TALK_SPEED) {
    const voice = await this.pick()
    const out = path.join(this.tmp, `cb-talk-${crypto.randomBytes(6).toString('hex')}.wav`)
    try {
      await this.exec(['-v', voice, '-r', String(Math.round(175 * rate)), '--file-format=WAVE', '--data-format=LEI16@24000', '-o', out, text])
      return { audio: fs.readFileSync(out).toString('base64'), mime: 'audio/wav', engine: `say:${voice}` }
    } finally {
      fs.rmSync(out, { force: true })
    }
  }
}

/**
 * A Linux machine's voice (REQ-F-908): Supertonic, an on-device ONNX speech model with Korean women's voices (F1~F5),
 * run on the CPU by one python kept up (reading the model costs seconds, a sentence well under its own length at
 * 4 steps). Installed by the person once, into <dir>/supertonic: the model itself comes down on its first use.
 */
/**
 * Supertonic's fastest speed (its own normal is 1.05; the page's rate × 1.05 up to this). Not 1.5 × 1.05 (1.575): at that speed it drops words, as Whisper
 * heard back ("코드와" gone, an ending changed, F3·4단계 whole phrases), and at 1.3 it said every word.
 */
export const SUPERTONIC_SPEED = 1.3

export const SUPERTONIC_PY = `
import sys, json, wave, numpy as np
from supertonic import TTS
tts = TTS()
styles = {}
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    try:
        q = json.loads(line)
        st = styles.get(q["voice"]) or styles.setdefault(q["voice"], tts.get_voice_style(q["voice"]))
        wav, dur = tts.synthesize(q["text"], voice_style=st, lang="ko", total_steps=int(q["steps"]), speed=float(q.get("speed", 1.05)))
        pcm = (np.clip(np.asarray(wav, dtype=np.float32).reshape(-1), -1, 1) * 32767).astype("<i2")
        with wave.open(q["out"], "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(int(tts.sample_rate)); w.writeframes(pcm.tobytes())
        print(json.dumps({"id": q["id"], "ok": True}), flush=True)
    except Exception as e:
        print(json.dumps({"id": q.get("id") if isinstance(q, dict) else None, "error": str(e)[:200]}), flush=True)
`

export class SupertonicVoice {
  constructor({ dir, run = spawn, tmp = os.tmpdir(), voice = 'F2', steps = 8, speed = SUPERTONIC_SPEED, log = () => {}, idleMs = 10 * 60_000 } = {}) {
    Object.assign(this, { run, tmp, voice, steps, speed, log, idleMs })
    this.py = path.join(dir, 'supertonic', 'bin', 'python')
    this.startMs = 120_000
    this.sayMs = 30_000
    this.proc = null
    this.ready = null
    this.waits = new Map()
    this.seq = 0
    this.idle = null
  }
  get installHint() {
    const d = path.dirname(path.dirname(this.py))
    return `이 기계에 목소리(Supertonic)가 없어요. 터미널에서: python3 -m venv ${d} && ${d}/bin/pip install supertonic`
  }
  start() {
    if (!fs.existsSync(this.py)) throw err('novoice', this.installHint)
    const p = this.run(this.py, this.args(), { stdio: ['pipe', 'pipe', 'ignore'] })
    this.proc = p
    let buf = ''
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(err('voice', `목소리 모델을 띄우지 못했어요 (${Math.round(this.startMs / 60_000)}분)`)), this.startMs)
      p.stdout.setEncoding('utf8')
      p.stdout.on('data', (d) => {
        buf += d
        for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          let j
          try {
            j = JSON.parse(line)
          } catch {
            continue
          }
          if (j.ready) clearTimeout(timer), resolve()
          else this.waits.get(j.id)?.(j)
        }
      })
      const gone = () => {
        clearTimeout(timer)
        if (this.proc !== p) return
        this.proc = null
        reject(err('voice', '목소리 모델이 멈췄어요'))
        for (const w of this.waits.values()) w({ error: '목소리 모델이 멈췄어요' })
      }
      p.on('exit', gone)
      p.on('error', gone)
    })
    this.ready.catch(() => {})
    p.stdin.on('error', () => {})
    this.log('info', 'talk', `${this.engine} 띄움${this.steps ? ` (${this.steps}단계)` : ''}`)
    return p
  }
  args() {
    return ['-I', '-c', SUPERTONIC_PY]
  }
  request(id, text, rate, out) {
    return { id, text, voice: this.voice, steps: this.steps, speed: Math.min(this.speed, Math.round(1.05 * rate * 1000) / 1000), out }
  }
  get engine() {
    return `supertonic:${this.voice}`
  }
  stop() {
    const p = this.proc
    this.proc = null
    try {
      p?.stdin.end()
      p?.kill('SIGTERM')
    } catch {}
  }
  async speak(text, rate = TALK_SPEED) {
    clearTimeout(this.idle)
    const p = this.proc ?? this.start()
    await this.ready
    const id = ++this.seq
    const out = path.join(this.tmp, `cb-talk-${crypto.randomBytes(6).toString('hex')}.wav`)
    try {
      const r = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ error: '목소리가 오래 걸려요' }), this.sayMs)
        this.waits.set(id, (x) => (clearTimeout(timer), this.waits.delete(id), resolve(x)))
        p.stdin.write(`${JSON.stringify(this.request(id, text, rate, out))}\n`)
      })
      if (r.error) throw err('voice', r.error)
      return { audio: fs.readFileSync(out).toString('base64'), mime: 'audio/wav', engine: this.engine }
    } finally {
      fs.rmSync(out, { force: true })
      this.idle = setTimeout(() => this.stop(), this.idleMs)
      this.idle.unref?.()
    }
  }
}

/**
 * 소희 (REQ-F-911): Qwen3-TTS 0.6B CustomVoice (8-bit, MLX) on an Apple-silicon Mac, its built-in Korean woman's
 * voice "Sohee" (a designed voice, not a real person's). It has no speed of its own (mlx-audio's `speed` is "not
 * directly supported yet"), so ffmpeg's atempo makes it faster without raising its pitch. It speaks slower than
 * Supertonic: the same sentence is 8.0 s against 5.4 s, so QWEN_PACE brings "1배" to Supertonic's normal pace.
 * On an M1 it makes a sentence in about 0.8 of its own length: at 1.25배 reading catches up, and the page waits.
 */
export const QWEN_MODEL = 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit'
export const QWEN_PACE = 1.47
export const QWEN_PY = `
import sys, json, wave, shutil, subprocess, numpy as np
from mlx_audio.tts.utils import load_model
import mlx.core as mx
m = load_model(sys.argv[1])
# The first generation after loading costs ~5 s more (M1): paid here, before ready, not by the first sentence.
for r in m.generate("준비", voice="Sohee", lang_code="korean"):
    mx.eval(r.audio)
ff = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
def tempo(t):
    out = []
    while t > 2.0: out.append("atempo=2.0"); t /= 2.0
    while t < 0.5: out.append("atempo=0.5"); t /= 0.5
    out.append("atempo=%.4f" % t)
    return ",".join(out)
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    q = None
    try:
        q = json.loads(line)
        parts = []
        for r in m.generate(q["text"], voice=q["voice"], lang_code="korean"):
            mx.eval(r.audio)
            parts.append(np.array(r.audio, dtype=np.float32).reshape(-1))
        a = np.concatenate(parts) if parts else np.zeros(1, dtype=np.float32)
        pcm = (np.clip(a, -1, 1) * 32767).astype("<i2")
        raw = q["out"] + ".raw.wav"
        with wave.open(raw, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(pcm.tobytes())
        t = float(q.get("tempo", 1))
        if abs(t - 1) > 0.01:
            subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-y", "-i", raw, "-filter:a", tempo(t), "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", q["out"]], check=True, timeout=30)
        else:
            shutil.move(raw, q["out"])
        print(json.dumps({"id": q["id"], "ok": True}), flush=True)
    except Exception as e:
        print(json.dumps({"id": q.get("id") if isinstance(q, dict) else None, "error": str(e)[:200]}), flush=True)
    finally:
        if isinstance(q, dict):
            try:
                import os; os.remove(q["out"] + ".raw.wav")
            except Exception:
                pass
`

/** The same one-process-kept-up as SupertonicVoice, with Qwen3-TTS: installed into <dir>/qwentts by the person once. */
export class QwenVoice extends SupertonicVoice {
  constructor({ dir, voice = 'Sohee', model = QWEN_MODEL, ...o } = {}) {
    super({ dir, voice, ...o })
    this.py = path.join(dir, 'qwentts', 'bin', 'python')
    this.model = model
    this.startMs = 10 * 60_000
    this.sayMs = 60_000
  }
  get installHint() {
    const d = path.dirname(path.dirname(this.py))
    return `이 맥에 소희 목소리(Qwen3-TTS)가 없어요. 터미널에서: uv venv --python 3.12 ${d} && VIRTUAL_ENV=${d} uv pip install mlx-audio (ffmpeg 도 필요: brew install ffmpeg)`
  }
  args() {
    return ['-I', '-c', QWEN_PY, this.model]
  }
  request(id, text, rate, out) {
    return { id, text, voice: this.voice, tempo: Math.round(QWEN_PACE * rate * 1000) / 1000, out }
  }
  get engine() {
    return `qwen:${this.voice}`
  }
}

/** Whether this Mac has 소희 installed (told to the server with the agent's hello, REQ-F-911). */
export const hasQwen = (dir) => process.platform === 'darwin' && fs.existsSync(path.join(dir, 'qwentts', 'bin', 'python'))

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

/** A WAV's length in seconds from its header (byte rate at offset 28), or 0 when it is not one. */
export function wavSeconds(b64) {
  try {
    const b = Buffer.from(String(b64 ?? ''), 'base64')
    const rate = b.length > 44 && b.toString('ascii', 0, 4) === 'RIFF' ? b.readUInt32LE(28) : 0
    return rate ? Math.round(((b.length - 44) / rate) * 10) / 10 : 0
  } catch {
    return 0
  }
}

/** The agent's `talk` command: { op: tts | turn | brief, text } → what the server hands the page. */
export async function talk({ op, text, rate }, { voice, judge }) {
  const t0 = Date.now()
  const s = String(text ?? '').trim()
  if (!s) throw err('empty', '말이 비었어요')
  if (op === 'tts') return { ...(await voice.speak(s.slice(0, 600), talkRate(rate))), ms: Date.now() - t0 }
  if (op === 'turn') return { end: parseTurn(await judge.ask(turnPrompt(s.slice(0, 2000)))), ms: Date.now() - t0 }
  if (op === 'brief') return { line: (await judge.ask(sayPrompt(s.slice(0, 6000)))).slice(0, 600), ms: Date.now() - t0 }
  throw err('op', `모르는 op: ${op}`)
}
