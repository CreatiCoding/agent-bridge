// 음성 입력 (REQ-F-754), the page's half. In 음성 모드 the microphone stays open: what is said shows at once from
// the browser's own recogniser, and each phrase (cut at the pauses) goes to the session's Mac as a 16 kHz mono 16-bit
// WAV, where whisper writes the words that are kept (agent/voice.mjs). What this browser keeps for itself (which
// microphone, the shortcut, the instant words on or off, the last few results) is here too; the rest is the account's.
import { useEffect, useState } from 'react'
import { get } from './api'
import type { VoicePrefs } from './types'

export const VOICE_RATE = 16000

export const VOICE_DEFAULT: VoicePrefs = { on: false, model: 'large-v3-turbo-q5_0', language: 'ko', denoise: true, tidy: true, terms: '' }

// The account's settings, read once per page and kept in step by 설정 → 음성 (the 'cb-voice' event).
let prefs: VoicePrefs | null = null
let loading: Promise<VoicePrefs> | null = null
export function setVoicePrefs(v: VoicePrefs) {
  prefs = v
  dispatchEvent(new Event('cb-voice'))
}
export function useVoicePrefs(): VoicePrefs | null {
  const [v, setV] = useState(prefs)
  useEffect(() => {
    const on = () => setV(prefs)
    addEventListener('cb-voice', on)
    if (!prefs)
      (loading ??= get<VoicePrefs>('/api/prefs/voice').catch(() => ((loading = null), VOICE_DEFAULT))).then((r) => {
        prefs ??= r
        setV(prefs)
      })
    return () => removeEventListener('cb-voice', on)
  }, [])
  return v
}

/** This device's own: which microphone, the key that turns 음성 모드 on and off, and the instant words. */
export interface VoiceDevice {
  mic: string
  key: 'alt-space' | 'ctrl-shift-space' | 'off'
  live: boolean
}
const DEVICE = 'cb2.voice'
const RECENT = 'cb2.voice.recent'
const readLs = <T,>(k: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(k)
    return v == null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
const writeLs = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {}
}
export const getVoiceDevice = (): VoiceDevice => {
  const { mic = '', key = 'alt-space', live = true } = readLs<Partial<VoiceDevice>>(DEVICE, {})
  return { mic, key, live }
}
export const setVoiceDevice = (v: VoiceDevice) => writeLs(DEVICE, v)
export const KEY_LABEL: Record<VoiceDevice['key'], string> = { 'alt-space': '⌥ Space', 'ctrl-shift-space': 'Ctrl ⇧ Space', off: '끔' }
export const isVoiceKey = (e: KeyboardEvent | React.KeyboardEvent, key: VoiceDevice['key']) =>
  e.code === 'Space' && (key === 'alt-space' ? e.altKey && !e.ctrlKey && !e.metaKey : key === 'ctrl-shift-space' ? e.ctrlKey && e.shiftKey && !e.altKey : false)

/** What came back for one phrase, the words as heard and as tidied, for 설정 → 음성 to compare. The last 20, this browser only. */
export interface VoiceResult {
  at: number
  raw: string
  text: string
  ms?: { total?: number }
  sec?: number
}
export const getVoiceRecent = () => readLs<VoiceResult[]>(RECENT, [])
export const addVoiceRecent = (r: VoiceResult) => writeLs(RECENT, [r, ...getVoiceRecent()].slice(0, 20))
export const clearVoiceRecent = () => writeLs(RECENT, [])

/** Average down to 16 kHz: each output sample is the mean of the input samples it covers (a simple low-pass). */
export function downsample(x: Float32Array, from: number, to = VOICE_RATE): Float32Array {
  if (from === to) return x
  const ratio = from / to
  const out = new Float32Array(Math.floor(x.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio)
    const b = Math.min(x.length, Math.floor((i + 1) * ratio))
    let s = 0
    for (let j = a; j < b; j++) s += x[j]
    out[i] = b > a ? s / (b - a) : x[a]
  }
  return out
}

/** 16-bit PCM mono WAV, as base64. */
export function wavBase64(x: Float32Array, rate = VOICE_RATE): string {
  const buf = new DataView(new ArrayBuffer(44 + x.length * 2))
  const str = (o: number, s: string) => [...s].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  buf.setUint32(4, 36 + x.length * 2, true)
  str(8, 'WAVEfmt ')
  buf.setUint32(16, 16, true)
  buf.setUint16(20, 1, true)
  buf.setUint16(22, 1, true)
  buf.setUint32(24, rate, true)
  buf.setUint32(28, rate * 2, true)
  buf.setUint16(32, 2, true)
  buf.setUint16(34, 16, true)
  str(36, 'data')
  buf.setUint32(40, x.length * 2, true)
  for (let i = 0; i < x.length; i++) buf.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 0x7fff, true)
  const bytes = new Uint8Array(buf.buffer)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** A failure to start recording, in words the person can act on. */
export function micError(e: unknown): string {
  const name = (e as Error)?.name
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return '이 주소에서는 마이크를 쓸 수 없어요 (https 에서만 돼요)'
  if (name === 'NotAllowedError' || name === 'SecurityError') return '마이크 권한이 없어요. 브라우저 주소창의 사이트 설정에서 마이크를 허용해 주세요'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '마이크를 찾지 못했어요. 설정 → 음성에서 마이크를 다시 골라 주세요'
  if (name === 'NotReadableError') return '마이크를 다른 앱이 쓰고 있어요'
  return `마이크를 열지 못했어요 (${(e as Error)?.message ?? name})`
}

/** Two pieces of speech as one line. */
export const joinWords = (a: string, b: string) => (a.trim() && b.trim() ? `${a.replace(/\s+$/, '')} ${b.replace(/^\s+/, '')}` : a.trim() ? a : b.trim())

// The browser's own recogniser: Safari and Chrome, under the webkit name.
interface SpeechRec {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
  start(): void
  abort(): void
}
const speechCtor = (): (new () => SpeechRec) | null => {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}
export const canPreview = () => typeof window !== 'undefined' && !!speechCtor()

/**
 * The instant words (음성 모드): the browser's recogniser (Apple's or Google's, over the network) shows what is being
 * said as it is said; the Mac's whisper then writes the words that are kept. text() is everything heard since it
 * started, so a place in it can be remembered and only what came after shown. It starts again by itself when the
 * browser ends it (Chrome does after a quiet while); a refusal turns it off (onOff, with why).
 */
export class LivePreview {
  private r: SpeechRec | null = null
  private done = ''
  private now = ''
  private on = false
  /** Started before the panel that shows the words is up, so the panel is told later. */
  onChange = () => {}
  onOff = (_why: string) => {}
  off = ''
  constructor(private lang: string) {}
  /**
   * Starts it and settles once it is listening, refused or ended: the microphone is opened only then. Safari asks
   * for both through one microphone permission (two asks at once were two prompts), and on an iPhone the recogniser
   * cannot get the microphone once the page has it (1.186 opened the microphone first: no instant words).
   */
  start(): Promise<void> {
    let settle = () => {}
    const ready = new Promise<void>((ok) => (settle = ok))
    const S = speechCtor()
    if (!S) return (this.fail('이 브라우저에는 즉시 받아쓰기가 없어요'), Promise.resolve())
    const r = new S()
    r.onstart = () => settle()
    r.lang = this.lang === 'en' ? 'en-US' : this.lang === 'ko' ? 'ko-KR' : navigator.language
    r.continuous = true
    r.interimResults = true
    r.onresult = (e) => {
      let t = ''
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript
      this.now = t
      this.onChange()
    }
    r.onerror = (e) => {
      settle()
      if (e.error !== 'not-allowed' && e.error !== 'service-not-allowed' && e.error !== 'audio-capture') return
      this.fail(e.error === 'audio-capture' ? '즉시 받아쓰기가 마이크를 쓰지 못했어요' : '즉시 받아쓰기가 허락되지 않았어요')
    }
    r.onend = () => {
      settle()
      this.done = joinWords(this.done, this.now)
      this.now = ''
      if (this.on && this.r === r)
        setTimeout(() => {
          if (!this.on || this.r !== r) return
          try {
            r.start()
          } catch {}
        }, 250)
    }
    this.r = r
    this.on = true
    try {
      r.start()
    } catch {
      this.fail('즉시 받아쓰기를 시작하지 못했어요')
      settle()
    }
    setTimeout(settle, 15000) // never stuck opening if it neither starts nor fails
    return ready
  }
  /** Turned off for good, with why (kept, for a panel that is not listening yet). */
  fail(why: string) {
    this.stop()
    this.off = why
    this.onOff(why)
  }
  get running() {
    return this.on
  }
  text() {
    return joinWords(this.done, this.now)
  }
  stop() {
    this.on = false
    const r = this.r
    this.r = null
    try {
      r?.abort()
    } catch {}
  }
}

/** A piece of speech between two pauses, ready for the Mac. */
export interface Phrase {
  audio: string
  sec: number
}

/**
 * How 음성 모드 cuts speech into phrases: it starts once the sound stays over the room's own level (over times it, at
 * least floor) for startMs, and ends after endMs under it or at maxSec; preMs from before the start is kept so the
 * first sound is not cut, and a phrase with less than minVoicedMs of speech in it is dropped (a cough, a knock).
 */
export const VAD = { startMs: 170, endMs: 700, preMs: 340, minVoicedMs: 250, maxSec: 25, floor: 0.012, over: 2.5 }

/**
 * The microphone, open for as long as 음성 모드 is. It listens all the time and hands each phrase (listen) as a
 * 16 kHz WAV. flush() ends the phrase being spoken now (전송); drop() forgets it (리셋).
 */
export class LiveListen {
  private ctx: AudioContext
  private stream: MediaStream | null = null
  private node: ScriptProcessorNode | null = null
  private pre: Float32Array[] = []
  private cur: Float32Array[] = []
  private curLen = 0
  private voiced = 0
  private loud = 0
  private quiet = 0
  private noise = 0.005
  speaking = false
  /** How loud it is now, 0 to 1 (for the meter). */
  level = 0
  /** How long nothing at all has come in: another user of the microphone has taken it. */
  deadMs = 0
  private waiting: Phrase[] = []
  private onPhrase: ((p: Phrase) => void) | null = null
  /** Who takes the phrases: the panel, set once it is up (phrases cut before then wait for it). */
  listen(fn: ((p: Phrase) => void) | null) {
    this.onPhrase = fn
    if (fn) this.waiting.splice(0).forEach(fn)
  }
  /** Who takes them now: a panel that goes away lets go only of what is still its own (분할 화면 hands it on). */
  get taker() {
    return this.onPhrase
  }
  constructor() {
    // Made inside the press, before anything is awaited: Safari only lets sound start from the person's own touch.
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.ctx = new AC()
  }
  async start(mic: string) {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('insecure'), { name: 'SecurityError' })
    const audio: MediaTrackConstraints = { channelCount: 1, noiseSuppression: true, echoCancellation: true, autoGainControl: true }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: mic ? { ...audio, deviceId: { exact: mic } } : audio })
    } catch (e) {
      // A microphone chosen on this device that is gone now (unplugged): the default one instead.
      if (!mic || (e as Error).name !== 'OverconstrainedError') throw e
      this.stream = await navigator.mediaDevices.getUserMedia({ audio })
    }
    await this.ctx.resume()
    const src = this.ctx.createMediaStreamSource(this.stream)
    // ScriptProcessor is old but everywhere (an AudioWorklet would need a file of its own); 4096 at 48 kHz is 85 ms.
    this.node = this.ctx.createScriptProcessor(4096, 1, 1)
    this.node.onaudioprocess = (e) => this.take(new Float32Array(e.inputBuffer.getChannelData(0)))
    src.connect(this.node)
    this.node.connect(this.ctx.destination)
  }
  /** iOS stops the sound while the page is put away; back on the page it goes on. */
  resume() {
    if (this.ctx.state === 'suspended' || (this.ctx.state as string) === 'interrupted') void this.ctx.resume().catch(() => {})
  }
  private take(x: Float32Array) {
    const ms = (x.length / this.ctx.sampleRate) * 1000
    let sum = 0
    for (let i = 0; i < x.length; i++) sum += x[i] * x[i]
    const rms = Math.sqrt(sum / x.length)
    this.level = Math.min(1, rms * 8)
    this.deadMs = rms === 0 ? this.deadMs + ms : 0
    const over = rms > Math.max(VAD.floor, this.noise * VAD.over)
    if (!this.speaking) {
      // The room's own level: follows a drop at once, a rise only slowly (so speech does not become the room).
      this.noise = rms < this.noise ? this.noise * 0.7 + rms * 0.3 : this.noise * 0.995 + rms * 0.005
      this.pre.push(x)
      while (this.pre.length > 1 && (this.pre.length - 1) * ms > VAD.preMs) this.pre.shift()
      this.loud = over ? this.loud + ms : 0
      if (this.loud < VAD.startMs) return
      this.speaking = true
      this.cur = this.pre
      this.curLen = this.pre.reduce((n, c) => n + c.length, 0)
      this.pre = []
      this.voiced = this.loud
      this.quiet = 0
      return
    }
    this.cur.push(x)
    this.curLen += x.length
    if (over) {
      this.voiced += ms
      this.quiet = 0
    } else this.quiet += ms
    if (this.quiet >= VAD.endMs || this.curLen / this.ctx.sampleRate >= VAD.maxSec) this.flush()
  }
  /** Ends the phrase being spoken now and hands it over; false when there was none (or too little speech in it). */
  flush(): boolean {
    if (!this.speaking) return false
    const chunks = this.cur
    const voiced = this.voiced
    this.drop()
    if (voiced < VAD.minVoicedMs) return false
    const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
    let o = 0
    for (const c of chunks) all.set(c, (o += c.length) - c.length)
    const rate = this.ctx.sampleRate
    const p = { audio: wavBase64(downsample(all, rate)), sec: all.length / rate }
    if (this.onPhrase) this.onPhrase(p)
    else this.waiting.push(p)
    return true
  }
  drop() {
    this.speaking = false
    this.cur = []
    this.curLen = 0
    this.voiced = 0
    this.loud = 0
    this.quiet = 0
  }
  close() {
    this.drop()
    this.node?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.ctx.close().catch(() => {})
  }
}

/** The microphones this browser can name (names only appear once the page has been allowed the microphone). */
export async function listMics(): Promise<{ id: string; label: string }[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  const all = await navigator.mediaDevices.enumerateDevices()
  return all.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default').map((d, i) => ({ id: d.deviceId, label: d.label || `마이크 ${i + 1}` }))
}

/** What an agent error code means for the person, short (the agent's own sentence, with the fix, is in the details). */
export const VOICE_CODE_TITLE: Record<string, string> = {
  nobin: 'whisper.cpp 가 맥에 없어요',
  nomodel: '음성 모델이 맥에 없어요',
  api: 'whisper.cpp 가 실패했어요',
  silent: '말소리가 없어요',
  audio: '녹음을 읽지 못했어요',
  demo: '데모에서는 받아쓰지 않아요',
}
