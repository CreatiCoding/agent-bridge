/**
 * Speech to text for the input box (REQ-F-754): a recording from the page comes in as a 16 kHz mono WAV, and the
 * words go back to the page, which sends them the way it sends anything typed.
 *
 * 1. Noise: RNNoise through ffmpeg's arnndn filter when ffmpeg and a model file are there (RNNoise is made for
 *    48 kHz, so the sound goes up to 48 kHz around it), otherwise a spectral gate written here. Can be turned off.
 * 2. Words: whisper.cpp on this Mac (whisper-server kept up for a while, so the model is not read again for every
 *    recording; whisper-cli when the server cannot start). Nothing leaves the Mac. The person's terms go in as the prompt,
 *    which is what makes "claude-bridge" come out spelled that way instead of "클로드 브리즈".
 * 3. Tidying: rules, no model (a model call costs seconds). Fillers out, punctuation and the terms' spelling fixed.
 *
 * Everything but the runners is a plain function of its input, so the tests run it without a microphone or a model.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { execFile, execFileSync, spawn } from 'node:child_process'

export const VOICE_RATE = 16000
/** whisper.cpp's ggml model names this page offers; the file is <STATE_DIR>/whisper/ggml-<name>.bin. */
export const WHISPER_MODELS = ['large-v3-turbo-q5_0', 'large-v3-turbo', 'medium', 'small', 'base']
export const VOICE_LANGS = ['ko', 'en', 'auto']
/** Longest recording taken: a minute of 16-bit 16 kHz is about 1.9 MB, 2.6 MB as base64. */
export const VOICE_MAX_SEC = 60

export class VoiceError extends Error {
  /** @param {'nobin'|'nomodel'|'api'|'audio'|'silent'} code */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// ---------- WAV

/** The samples of a 16-bit PCM WAV, channels averaged, as -1..1. */
export function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new VoiceError('audio', '녹음 파일이 WAV 가 아니에요')
  let fmt = null
  let at = 12
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4)
    const size = buf.readUInt32LE(at + 4)
    const body = at + 8
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) }
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16 || !fmt.channels) throw new VoiceError('audio', '녹음 파일이 16비트 PCM 이 아니에요')
      const end = Math.min(buf.length, body + size)
      const frames = Math.floor((end - body) / (2 * fmt.channels))
      const out = new Float32Array(frames)
      for (let i = 0; i < frames; i++) {
        let sum = 0
        for (let c = 0; c < fmt.channels; c++) sum += buf.readInt16LE(body + (i * fmt.channels + c) * 2)
        out[i] = sum / fmt.channels / 32768
      }
      return { rate: fmt.rate, samples: out }
    }
    at = body + size + (size % 2)
  }
  throw new VoiceError('audio', '녹음 파일에 소리 부분이 없어요')
}

/** A 16-bit mono PCM WAV of the samples. */
export function wavOf(samples, rate = VOICE_RATE) {
  const buf = Buffer.alloc(44 + samples.length * 2)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + samples.length * 2, 4)
  buf.write('WAVEfmt ', 8, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2)
  return buf
}

export const rms = (x) => {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * x[i]
  return x.length ? Math.sqrt(s / x.length) : 0
}

/**
 * Whether there is anything to hear: the loudest 50 ms stays under about -46 dBFS. Whisper given silence writes a
 * sentence anyway (a broadcast's sign-off), so silence is never handed to it.
 */
export function isSilent(x, rate = VOICE_RATE) {
  const step = Math.max(1, Math.round(rate * 0.05))
  let loudest = 0
  for (let i = 0; i < x.length; i += step) loudest = Math.max(loudest, rms(x.subarray(i, i + step)))
  return loudest < 0.005
}

// ---------- Spectral gate (used when RNNoise is not there)

/** In-place radix-2 FFT; `inverse` scales by 1/n. */
function fft(re, im, inverse = false) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) (re[i] /= n), (im[i] /= n)
}

/**
 * Spectral gate: the noise's spectrum is taken from the quietest fifth of the frames (people pause), and each frame
 * keeps of every frequency only what stands above that noise (spectral subtraction, never below `floor`, so the
 * result does not warble). sqrt-Hann windows at half overlap add back to exactly 1, so a frame the gate leaves alone
 * comes out unchanged.
 */
export function spectralGate(x, { frame = 512, strength = 1.5, floor = 0.08 } = {}) {
  if (x.length < frame * 2) return Float32Array.from(x)
  const hop = frame / 2
  const win = new Float32Array(frame).map((_, i) => Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame)))
  const padded = new Float32Array(x.length + frame * 2)
  padded.set(x, frame)
  const count = Math.floor((padded.length - frame) / hop) + 1
  const bins = frame / 2 + 1
  const specs = []
  for (let f = 0; f < count; f++) {
    const re = new Float64Array(frame)
    const im = new Float64Array(frame)
    for (let i = 0; i < frame; i++) re[i] = (padded[f * hop + i] ?? 0) * win[i]
    fft(re, im)
    let energy = 0
    const mag = new Float64Array(bins)
    for (let k = 0; k < bins; k++) energy += mag[k] = Math.hypot(re[k], im[k])
    specs.push({ re, im, mag, energy })
  }
  const quiet = [...specs].sort((a, b) => a.energy - b.energy).slice(0, Math.max(1, Math.floor(count / 5)))
  const noise = new Float64Array(bins)
  for (const s of quiet) for (let k = 0; k < bins; k++) noise[k] += s.mag[k] / quiet.length
  const out = new Float32Array(padded.length)
  specs.forEach(({ re, im, mag }, f) => {
    for (let k = 0; k < bins; k++) {
      const g = mag[k] > 0 ? Math.max(floor, 1 - (strength * noise[k]) / mag[k]) : floor
      re[k] *= g
      im[k] *= g
      if (k > 0 && k < frame / 2) (re[frame - k] *= g), (im[frame - k] *= g)
    }
    fft(re, im, true)
    for (let i = 0; i < frame; i++) out[f * hop + i] += re[i] * win[i]
  })
  return out.slice(frame, frame + x.length)
}

// ---------- Terms

/** The person's terms, one per line or comma: trimmed, no repeats, 100 at most, 60 letters each. */
export function parseTerms(text) {
  const seen = new Set()
  const out = []
  for (const t of String(text ?? '').split(/[\n,]/)) {
    const v = t.trim().slice(0, 60)
    if (!v || seen.has(v.toLowerCase())) continue
    seen.add(v.toLowerCase())
    out.push(v)
    if (out.length >= 100) break
  }
  return out
}

/**
 * The words 음성 모드 takes as commands at the end of a phrase (REQ-F-789). Said alone they came out as 순종, 전성,
 * 천송 and 리스트: put last in the prompt, where whisper reads it most, they come out as themselves more often.
 */
export const COMMAND_WORDS = { ko: ['전송', '리셋'] }

/** Whisper's initial prompt from the terms. Whisper reads only about the last 224 tokens of it, so it is kept short. */
export const termsPrompt = (terms, language = '') => {
  const tail = (COMMAND_WORDS[language] ?? []).join(', ')
  const room = 600 - (tail ? tail.length + 2 : 0)
  let s = ''
  for (const t of terms) {
    const next = s ? `${s}, ${t}` : t
    if (next.length > room) break
    s = next
  }
  return tail ? (s ? `${s}, ${tail}` : tail) : s
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/**
 * A term written the way the list writes it: "Claude-bridge", "claude bridge" and "ClaudeBridge" all become
 * "claude-bridge". Only terms in Latin letters and digits: their parts may come out joined by a space, a hyphen,
 * a dot or nothing. Korean terms are left to the prompt.
 */
export function applyTerms(text, terms) {
  let s = text
  for (const t of terms) {
    if (!/^[A-Za-z0-9][\w.\- ]*[A-Za-z0-9]$/.test(t)) continue
    const parts = t.split(/[\s._-]+/).filter(Boolean)
    const re = new RegExp(`(?<![A-Za-z0-9])${parts.map(escapeRe).join('[\\s._-]?')}(?![A-Za-z0-9])`, 'gi')
    s = s.replace(re, t)
  }
  return s
}

// ---------- Tidying

/** Whole outputs Whisper writes for a recording with no words in it (it learned them from video subtitles). */
const PHANTOMS = [/^(시청|구독)?\s*해\s*주셔서\s*감사합니다\.?$/, /^(구독과\s*좋아요|좋아요와\s*구독)[^.]{0,20}(부탁|눌러)[^.]*\.?$/, /^MBC\s*뉴스/, /^자막\s*(제공|by)/i, /^thank(s| you) for watching[.!]?$/i, /^\[?(음악|music|박수|silence|BLANK_AUDIO)\]?$/i]

/**
 * Whisper's confidence over the segments, weighted by their length (null when it gave none). Its no_speech_prob is
 * no help here: for a cough it is ~1e-11, the same as for words.
 */
export function meanLogprob(segments) {
  let sum = 0
  let len = 0
  for (const s of Array.isArray(segments) ? segments : []) {
    if (!Number.isFinite(s?.avg_logprob)) continue
    const w = Math.max(0.1, Number(s.end) - Number(s.start) || 0)
    sum += s.avg_logprob * w
    len += w
  }
  return len ? sum / len : null
}

/**
 * A short output Whisper was unsure of is a noise (a cough, a knock, a hum) it put words to: "감사합니다.",
 * "날씨였습니다.". Measured on this Mac: large-v3-turbo words −0.006 to −0.022 (also under noise), its noises −0.34 to
 * −0.70; base words −0.04 to −0.17, its noise −0.27. So the smaller models get a lower line.
 */
export const phantomLp = (model) => (/^large/.test(String(model ?? 'large')) ? -0.2 : -0.25)
export const PHANTOM_MAX = 20
export const isPhantomGuess = (text, lp, model) => lp != null && lp < phantomLp(model) && String(text).replace(/[\s,.?!…]/g, '').length <= PHANTOM_MAX

/**
 * Silero VAD for whisper.cpp: with it whisper-server hears only the stretches that are speech, so a noise gives no
 * words at all. The line above cannot do that: some noises come out "감사합니다." at lp −0.01, as sure as speech,
 * and a real "네." can come out at −0.48. Fetched once into the whisper folder and checked against this hash.
 */
export const VAD_MODEL = {
  name: 'ggml-silero-v5.1.2.bin',
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin',
  sha256: '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf',
}

/** Korean fillers that are never words in their own right. */
const KO_FILLER = '(?:음+|으+음|어+|어+어|으+|흠+|에+|아+)'
/** Fillers that are words elsewhere, taken out only at the start of a sentence or before a comma. */
const KO_SOFT = '(?:그러니까|그니까|뭐랄까|있잖아요?|그래서\\s*이제|약간|뭐)'
const EN_FILLER = '(?:u+[mh]+|uh+|um+|e+rm*|hmm+|mm+)'

/**
 * The words with fillers, stutters and broken punctuation taken out (rule based, a few milliseconds). Meaning is
 * never guessed: a word that can carry meaning is only dropped where it cannot ("그러니까," at the start, not
 * "그러니까 안 돼"), and nothing is rephrased.
 */
export function cleanTranscript(text, terms = []) {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (PHANTOMS.some((re) => re.test(s))) return ''
  const B = '(^|[\\s,.?!…])'
  const E = '(?=$|[\\s,.?!…])'
  // A bare filler anywhere, with the comma after it.
  s = s.replace(new RegExp(`${B}${KO_FILLER}[,.…]*${E}`, 'g'), '$1')
  s = s.replace(new RegExp(`${B}${EN_FILLER}[,.…]*${E}`, 'gi'), '$1')
  // Soft fillers at a sentence's start or set off by a comma.
  // Again until nothing changes: "Um, so, I mean, …" loses one at a time.
  for (let was = ''; was !== s; ) {
    was = s
    s = s.replace(new RegExp(`(^\\s*|[.?!]\\s*)${KO_SOFT}(?:[,…]+|\\s+)`, 'g'), '$1')
    s = s.replace(/(^\s*|[.?!]\s*)(?:you know|I mean|like|so|well),\s*/gi, '$1')
  }
  s = s.replace(new RegExp(`(,\\s*)${KO_SOFT}[,…]+`, 'g'), '$1')
  s = s.replace(/,\s*(?:you know|I mean|like),/gi, ',')
  // Stutters: the same one-syllable word, or a small English word, twice in a row ("그 그 파일", "the the").
  s = s.replace(/(^|\s)([가-힣])(?:\s+\2)+(?=\s)/g, '$1$2')
  s = s.replace(/\b(the|a|an|i|to|and|it|is|in|of)(?:\s+\1)+\b/gi, '$1')
  // Punctuation: none before a mark, one after, no doubles, nothing dangling at the start.
  s = s.replace(/\s+([,.?!])/g, '$1')
  s = s.replace(/([,.?!])\1+/g, '$1')
  s = s.replace(/,\s*([.?!])/g, '$1')
  s = s.replace(/([,?!])(?=[^\s\d])/g, '$1 ')
  s = s.replace(/(?<![\d.])\.(?=[가-힣A-Z])/g, '. ')
  s = s.replace(/^[\s,.…]+/, '').replace(/[\s,…]+$/, '')
  s = s.replace(/\s{2,}/g, ' ').trim()
  return applyTerms(s, terms)
}

// ---------- Runners

const BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', ...String(process.env.PATH ?? '').split(':')]
/** A program by name, looked for where Homebrew puts it too: launchd starts the agent with a short PATH. */
export function findBin(name, dirs = BIN_DIRS) {
  for (const d of dirs) {
    if (!d) continue
    const f = path.join(d, name)
    try {
      fs.accessSync(f, fs.constants.X_OK)
      return f
    } catch {}
  }
  return null
}

const run = (bin, argv, input, timeout = 60_000) =>
  new Promise((resolve, reject) => {
    const p = execFile(bin, argv, { timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr) })) : resolve(stdout)))
    if (input) p.stdin.end(input)
  })

/** Noise taken out of a WAV: RNNoise when there is ffmpeg and a model, otherwise the gate above. */
export async function denoise(wav, { dir, ffmpeg = findBin('ffmpeg') } = {}) {
  const model = dir && path.join(dir, 'rnnoise.rnnn')
  if (ffmpeg && model && fs.existsSync(model)) {
    try {
      const out = await run(ffmpeg, ['-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-af', `aresample=48000,arnndn=m='${model.replace(/'/g, '')}',aresample=${VOICE_RATE}`, '-ac', '1', '-f', 's16le', 'pipe:1'], wav, 20_000)
      // Bare samples back, and the WAV made here: a WAV ffmpeg writes to a pipe has no sizes in its header.
      const pcm = new Float32Array(Math.floor(out.length / 2)).map((_, i) => out.readInt16LE(i * 2) / 32768)
      return { wav: wavOf(pcm), how: 'rnnoise' }
    } catch {}
  }
  const { rate, samples } = parseWav(wav)
  return { wav: wavOf(spectralGate(samples), rate), how: 'gate' }
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

/**
 * whisper.cpp on this Mac. whisper-server is started at the first recording and stopped after IDLE_MS without
 * one: reading the model takes about a second, which every recording would otherwise pay. Its pid is kept in a
 * file, so a server left behind by an agent that was restarted is stopped by the next one.
 */
export class LocalWhisper {
  static IDLE_MS = 10 * 60_000
  static VAD_RETRY_MS = 60 * 60_000
  constructor({ dir, log = () => {}, bins = BIN_DIRS, fetchFn = fetch }) {
    this.dir = dir
    this.log = log
    this.bins = bins
    this.fetchFn = fetchFn
    this.srv = null
    this.idle = null
    this.pidFile = path.join(dir, 'whisper-server.pid')
    this.cleanedUp = false
    this.vadTried = 0
    this.vadBrokenAt = 0
  }
  modelFile(model) {
    return path.join(this.dir, `ggml-${model}.bin`)
  }
  /** The VAD model's file, fetched when missing (at most once an hour), or null: then whisper runs without it. */
  async vad() {
    if (Date.now() - this.vadBrokenAt < LocalWhisper.VAD_RETRY_MS) return null
    const file = path.join(this.dir, VAD_MODEL.name)
    if (fs.existsSync(file)) return file
    if (Date.now() - this.vadTried < LocalWhisper.VAD_RETRY_MS) return null
    this.vadTried = Date.now()
    try {
      const r = await this.fetchFn(VAD_MODEL.url, { signal: AbortSignal.timeout(30_000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const buf = Buffer.from(await r.arrayBuffer())
      const got = crypto.createHash('sha256').update(buf).digest('hex')
      if (got !== VAD_MODEL.sha256) throw new Error(`hash ${got.slice(0, 12)}`)
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, buf, { mode: 0o600 })
      fs.renameSync(tmp, file)
      this.log('info', 'voice', `말소리 감지 모델 받음 (${VAD_MODEL.name}, ${buf.length} B)`)
      return file
    } catch (e) {
      this.log('warn', 'voice', `말소리 감지 모델을 받지 못해 없이 받아씀: ${String(e.message).slice(0, 120)}`)
      return null
    }
  }
  check(model) {
    const cli = findBin('whisper-cli', this.bins)
    if (!cli) throw new VoiceError('nobin', '이 맥에 whisper.cpp 가 없어요. 터미널에서 `brew install whisper-cpp` 로 설치해 주세요')
    const file = this.modelFile(model)
    if (!fs.existsSync(file)) throw new VoiceError('nomodel', `이 맥에 음성 모델(${model})이 없어요. 터미널에서: mkdir -p ${this.dir} && curl -L -o ${file} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`)
    return { cli, file }
  }
  stop() {
    clearTimeout(this.idle)
    if (this.srv?.proc && !this.srv.proc.killed) this.srv.proc.kill()
    this.srv = null
    fs.rmSync(this.pidFile, { force: true })
  }
  /** A whisper-server some earlier agent left behind: stopped, if it is one. */
  cleanUp() {
    if (this.cleanedUp) return
    this.cleanedUp = true
    try {
      const pid = Number(fs.readFileSync(this.pidFile, 'utf8'))
      const comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 3000 })
      if (pid > 0 && /whisper-server/.test(comm)) process.kill(pid)
    } catch {}
    fs.rmSync(this.pidFile, { force: true })
  }
  async server(model) {
    const file = this.modelFile(model)
    const vad = await this.vad()
    if (this.srv && this.srv.file === file && this.srv.vad === vad && !this.srv.dead) return this.srv
    this.stop()
    this.cleanUp()
    const bin = findBin('whisper-server', this.bins)
    if (!bin) return null
    const srv = await this.spawnServer(bin, file, vad)
    if (srv || !vad) return srv
    // An older whisper.cpp without --vad does not start with it: once more without, and not again for an hour. Not for
    // good: a model file still being downloaded fails the same way, and the next try then starts fine.
    this.vadBrokenAt = Date.now()
    this.log('warn', 'voice', 'whisper-server 가 말소리 감지(--vad)로 뜨지 않아 없이 띄움')
    return this.spawnServer(bin, file, null)
  }
  async spawnServer(bin, file, vad) {
    const port = await freePort()
    const proc = spawn(bin, ['-m', file, '--host', '127.0.0.1', '--port', String(port), '-sns', ...(vad ? ['--vad', '-vm', vad] : [])], { stdio: 'ignore' })
    const srv = { file, vad, port, proc, dead: false }
    proc.on('exit', () => (srv.dead = true))
    proc.on('error', () => (srv.dead = true))
    fs.writeFileSync(this.pidFile, String(proc.pid))
    for (let i = 0; i < 120 && !srv.dead; i++) {
      if (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }).then((r) => r.ok, () => false)) {
        this.srv = srv
        this.log('info', 'voice', `whisper-server 띄움 (${path.basename(file)}, 포트 ${port}, 말소리 감지 ${vad ? '켬' : '없음'})`)
        return srv
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    if (!srv.dead) proc.kill()
    return null
  }
  async transcribe(wav, { model, language, prompt }) {
    const { cli, file } = this.check(model)
    clearTimeout(this.idle)
    this.idle = setTimeout(() => this.stop(), LocalWhisper.IDLE_MS)
    this.idle.unref?.()
    const srv = await this.server(model).catch(() => null)
    if (srv) {
      const form = new FormData()
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'voice.wav')
      form.append('language', language)
      form.append('response_format', 'verbose_json')
      form.append('temperature', '0')
      if (prompt) form.append('prompt', prompt)
      const r = await fetch(`http://127.0.0.1:${srv.port}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) }).catch(() => null)
      if (r?.ok) {
        const j = await r.json().catch(() => null)
        if (j && typeof j.text === 'string') return { text: j.text, how: 'whisper-server', lp: meanLogprob(j.segments), vad: !!srv.vad }
      }
      this.log('warn', 'voice', `whisper-server 가 답하지 않아 whisper-cli 로 바꿈 (HTTP ${r?.status ?? '없음'})`)
      this.stop()
    }
    const vad = await this.vad()
    const tmp = path.join(os.tmpdir(), `cb-voice-${process.pid}-${Date.now()}.wav`)
    fs.writeFileSync(tmp, wav, { mode: 0o600 })
    try {
      const out = await run(cli, ['-m', file, '-f', tmp, '-l', language, '-nt', '-np', '-sns', ...(vad ? ['--vad', '-vm', vad] : []), ...(prompt ? ['--prompt', prompt] : [])])
      return { text: String(out), how: 'whisper-cli', vad: !!vad }
    } catch (e) {
      throw new VoiceError('api', `whisper-cli 가 실패했어요: ${String(e.stderr || e.message).trim().split('\n').pop().slice(0, 200)}`)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }
}
/**
 * What this Mac has for speech, for the agent's health (REQ-F-758): whisper.cpp, the models fetched, the VAD model,
 * whether the running whisper-server listens with VAD ('idle' while none runs, 'off' while VAD is given up on),
 * and ffmpeg for RNNoise.
 */
export function voiceStatus({ dir, local = null, bins = BIN_DIRS }) {
  let models = []
  try {
    models = fs.readdirSync(dir).map((f) => /^ggml-(.+)\.bin$/.exec(f)?.[1]).filter((m) => m && !m.startsWith('silero'))
  } catch {}
  const srv = local?.srv && !local.srv.dead ? local.srv : null
  const givenUp = !!local && Date.now() - local.vadBrokenAt < LocalWhisper.VAD_RETRY_MS
  return {
    whisper: !!findBin('whisper-cli', bins),
    models,
    vadModel: fs.existsSync(path.join(dir, VAD_MODEL.name)),
    vad: srv ? (srv.vad ? 'on' : 'off') : givenUp ? 'off' : 'idle',
    ffmpeg: !!findBin('ffmpeg', bins),
  }
}

/**
 * The settings as the server sends them, made safe: anything unknown falls back to the default. Speech is always
 * turned into words on this Mac; a 'backend' from an older server is ignored.
 */
export function voiceOpts(o = {}) {
  return {
    model: WHISPER_MODELS.includes(o.model) ? o.model : WHISPER_MODELS[0],
    language: VOICE_LANGS.includes(o.language) ? o.language : 'ko',
    denoise: o.denoise !== false,
    tidy: o.tidy !== false,
    terms: parseTerms(Array.isArray(o.terms) ? o.terms.join('\n') : o.terms),
  }
}

/** One line per recording in <STATE_DIR>/voice.log (JSON): what Whisper wrote next to what was sent, to compare. */
export function voiceLog(file, entry, max = 512 * 1024) {
  try {
    const st = fs.statSync(file)
    if (st.size > max) {
      const keep = fs.readFileSync(file, 'utf8').slice(-max / 2)
      fs.writeFileSync(file, keep.slice(keep.indexOf('\n') + 1), { mode: 0o600 })
    }
  } catch {}
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
}

/** A recording to words: noise, whisper, tidying, each timed. */
export async function transcribe(wav, opts, { dir, local, log = () => {} }) {
  const o = voiceOpts(opts)
  const t0 = Date.now()
  const { rate, samples } = parseWav(wav)
  if (rate !== VOICE_RATE) throw new VoiceError('audio', `녹음이 ${VOICE_RATE} Hz 가 아니에요(${rate} Hz)`)
  if (samples.length > rate * (VOICE_MAX_SEC + 1)) throw new VoiceError('audio', `녹음은 ${VOICE_MAX_SEC}초까지예요`)
  if (samples.length < rate * 0.3) throw new VoiceError('silent', '너무 짧아요. 누른 채로 말해 주세요')
  if (isSilent(samples, rate)) throw new VoiceError('silent', '말소리가 들리지 않았어요. 마이크를 확인해 주세요')
  let clean = wav
  let how = 'off'
  if (o.denoise) ({ wav: clean, how } = await denoise(wav, { dir }))
  const t1 = Date.now()
  const prompt = termsPrompt(o.terms, o.language)
  const stt = await local.transcribe(clean, { model: o.model, language: o.language, prompt })
  const t2 = Date.now()
  const raw = stt.text.replace(/\s+/g, ' ').trim()
  // With VAD the speech is already picked out, and the lp line would only lose short real words.
  const dropped = stt.vad ? (raw ? null : 'vad') : isPhantomGuess(raw, stt.lp, o.model) ? 'phantom' : null
  const text = dropped ? '' : o.tidy ? cleanTranscript(raw, o.terms) : applyTerms(raw, o.terms)
  const t3 = Date.now()
  const lp = stt.lp == null ? undefined : Math.round(stt.lp * 1000) / 1000
  const out = { raw, text, sec: Math.round((samples.length / rate) * 10) / 10, backend: stt.how, model: o.model, language: o.language, denoise: how, vad: !!stt.vad, lp, ms: { denoise: t1 - t0, stt: t2 - t1, tidy: t3 - t2, total: t3 - t0 } }
  voiceLog(path.join(path.dirname(dir), 'voice.log'), { at: new Date().toISOString(), ...out, ...(dropped ? { dropped } : {}) })
  if (dropped === 'vad') {
    log('info', 'voice', `${out.sec}초 → 말소리 없음 (말소리 감지)`)
    throw new VoiceError('silent', '말소리가 들리지 않았어요')
  }
  if (dropped) {
    log('info', 'voice', `${out.sec}초 → 잡음으로 보고 버림 (확신 ${lp})`)
    throw new VoiceError('silent', '잡음으로 보여 받아쓰지 않았어요')
  }
  log('info', 'voice', `${out.sec}초 → ${text.length}자 (${stt.how}, 잡음 ${how}, ${out.ms.total} ms)`)
  return out
}
