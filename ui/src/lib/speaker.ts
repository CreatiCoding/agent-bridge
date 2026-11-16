// 대화 모드 (REQ-F-907): the answer read aloud, a sentence at a time, through the AudioContext the microphone was
// opened with (made inside the person's press: Safari plays sound only from one of those). Every sentence waiting is
// fetched in turn as soon as it is known, so the voice keeps making while one plays. A slow voice (소희 on an M1,
// REQ-F-911, makes a sentence in about the time it takes to hear it at 1.25배) would leave gaps, so reading starts,
// and starts again after a gap, only once what is made already lasts as long as what is left to make is expected to
// take (`holdFor`). A voice that streams (흘려 읽기, REQ-F-920) gives its sound in pieces while it makes it: those
// are played as they come, one right after another, and since they keep coming while it plays, much less is waited
// for. duck() lowers it while a sound might be the person starting to speak; stop() ends it at once and forgets what
// was waiting.

/**
 * One sentence's sound: encoded audio (wav, aiff or m4a) as the browser decodes it, or a WAV stream (16-bit PCM)
 * that grows as the voice makes it.
 */
export type Voice = (text: string) => Promise<ArrayBuffer | ReadableStream<Uint8Array>>

/**
 * After the first sentence of an answer, the sentences waiting are made together, up to this many letters: each
 * request costs a slow voice ~1.5 s whatever its length (소희: 8 letters in 2.6 s, 44 in 5.6 s). The first goes alone
 * so reading starts soon.
 */
export const JOIN_CHARS = 120

/** The next request: the first sentence alone when nothing of the answer is made yet, else as many as fit. */
export function nextChunk(queue: string[], first: boolean, max = JOIN_CHARS): string {
  let text = queue.shift() ?? ''
  if (first) return text
  while (queue.length && text.length + 1 + queue[0].length <= max) text += ` ${queue.shift()}`
  return text
}

/** Seconds of making per letter, before a sentence has been timed: about 소희's on an M1 (6.6 s for 36 letters). */
export const FIRST_SEC_PER_CHAR = 0.18

/**
 * Seconds of sound a streaming voice gives per second of making, before one has been timed: 소희 through the voice
 * server gave 6.27 s of sound in 6.6 s at 1.25배 (0.95); a little less, so the first answer does not run dry.
 */
export const FIRST_FLOW = 0.8

/**
 * How long to wait before reading, in seconds: the time the rest is expected to take to make, less what is made
 * already (it plays meanwhile), with a little to spare. 0 when nothing is left to make. `flow`: the share of that
 * making time that gives sound as it goes (a streaming voice); 0 for one that gives a sentence only when done.
 */
export function holdFor(madeSec: number, leftChars: number, secPerChar: number, spare = 0.5, flow = 0): number {
  if (leftChars <= 0) return 0
  return Math.max(0, leftChars * secPerChar * (1 - Math.min(Math.max(flow, 0), 1)) + spare - madeSec)
}

/** Pieces shorter than this are held back until more comes (each piece is a node and a scheduling step). */
export const MIN_PIECE_SEC = 0.25

/**
 * Turns a WAV stream (16-bit little-endian PCM, mono, header first) into pieces of samples, whatever the network cuts
 * it into: the header is read for the rate and skipped, an odd byte is kept for the next chunk, and samples are held
 * until a piece is at least MIN_PIECE_SEC long. end() gives what is left.
 */
export class PcmPieces {
  rate = 24000
  private head = new Uint8Array(0)
  private headDone = false
  private carry: number | null = null
  private held: number[] = []

  push(chunk: Uint8Array): Float32Array[] {
    let b = chunk
    if (!this.headDone) {
      const all = new Uint8Array(this.head.length + b.length)
      all.set(this.head)
      all.set(b, this.head.length)
      if (all.length < 44) {
        this.head = all
        return []
      }
      const v = new DataView(all.buffer, all.byteOffset, all.byteLength)
      if (String.fromCharCode(all[0], all[1], all[2], all[3]) !== 'RIFF') throw new Error('소리 형식이 아니에요')
      this.rate = v.getUint32(24, true) || 24000
      this.headDone = true
      b = all.subarray(44)
    }
    let i = 0
    if (this.carry !== null && b.length) {
      this.held.push(((b[0] << 8) | this.carry) << 16 >> 16)
      this.carry = null
      i = 1
    }
    for (; i + 1 < b.length; i += 2) this.held.push(((b[i + 1] << 8) | b[i]) << 16 >> 16)
    if (i < b.length) this.carry = b[i]
    return this.held.length >= this.rate * MIN_PIECE_SEC ? [this.take()] : []
  }

  end(): Float32Array | null {
    return this.held.length ? this.take() : null
  }

  private take(): Float32Array {
    const f = Float32Array.from(this.held, (s) => s / 32768)
    this.held = []
    return f
  }
}

type Made = { text: string; buf: AudioBuffer | null }

export class Speaker {
  private gain: GainNode
  /** Sentences not yet asked for. */
  private queue: string[] = []
  /** Sound made, not yet given to the speaker: whole sentences, or a streaming sentence's pieces. */
  private made: Made[] = []
  /** Letters of the sentence being made now (0: none), and when its making started (performance.now). */
  private makingChars = 0
  private makingAt = 0
  private gen = 0
  /** What is given to the speaker, and when (AudioContext time) the last of it ends. */
  private sources = new Set<AudioBufferSourceNode>()
  private endAt = 0
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private running = false
  private playing = false
  /** Whether any of this answer has been read yet (since the voice last went quiet). */
  private played = false
  private fetching = false
  private wake: (() => void) | null = null
  /** Seconds of making per letter, learnt from the last sentences (network included). */
  private secPerChar = FIRST_SEC_PER_CHAR
  private timed = false
  /** Seconds of sound per second of making while a voice streams (0: the last voice did not stream). */
  private flow = 0
  private flowTimed = false
  /** Told when it starts and stops speaking (preparing included). */
  onState = (_speaking: boolean) => {}
  /** Told when a sentence could not be made (the reason, once per answer). */
  onError = (_why: string) => {}
  /** Told when reading waits for the voice: the moment it is expected to start (ms), or null once it reads. */
  onWait = (_until: number | null) => {}

  private ctx: AudioContext
  private voice: Voice

  constructor(ctx: AudioContext, voice: Voice) {
    this.ctx = ctx
    this.voice = voice
    this.gain = ctx.createGain()
    this.gain.connect(ctx.destination)
  }

  get speaking() {
    return this.running
  }

  /** Sentences to read after what is being read now. */
  say(sentences: string[]) {
    if (!sentences.length) return
    this.queue.push(...sentences)
    if (!this.running) {
      this.running = true
      this.onState(true)
    }
    if (!this.fetching) void this.fetchLoop(this.gen)
    if (!this.playing) void this.playLoop(this.gen)
    this.nudge()
  }

  private nudge() {
    const w = this.wake
    this.wake = null
    w?.()
  }

  private madeSec() {
    return this.made.reduce((s, m) => s + (m.buf?.duration ?? 0), 0)
  }

  /** Seconds given to the speaker and not yet heard: none once every piece has ended (a clock that stood still while
   * the page was hidden must not keep it waiting). */
  private aheadSec() {
    return this.sources.size ? Math.max(0, this.endAt - this.ctx.currentTime) : 0
  }

  /** Letters still to make, the sentence being made counted by the share of its expected time not yet spent. */
  private leftChars() {
    const queued = this.queue.reduce((s, t) => s + t.length, 0)
    if (!this.makingChars) return queued
    const spent = (performance.now() - this.makingAt) / 1000 / this.secPerChar
    return queued + Math.max(0, this.makingChars - spent)
  }

  private async fetchLoop(g: number) {
    this.fetching = true
    try {
      while (g === this.gen && this.queue.length) {
        const text = nextChunk(this.queue, !this.made.length && !this.played && !this.aheadSec())
        this.makingChars = text.length
        this.makingAt = performance.now()
        const fail = (e: unknown) => (g === this.gen ? this.onError((e as Error)?.message ?? String(e)) : null, null)
        const got = await this.voice(text).catch(fail)
        if (g !== this.gen) {
          if (got && !(got instanceof ArrayBuffer)) void got.cancel().catch(() => {})
          return
        }
        let ok = false
        let soundSec = 0
        if (got instanceof ArrayBuffer) {
          const buf = await this.ctx.decodeAudioData(got).catch(fail)
          if (g !== this.gen) return
          this.made.push({ text, buf })
          ok = !!buf
          this.flow = 0
        } else if (got) {
          ok = await this.stream(got, text, g, (s) => (soundSec += s)).catch((e) => (fail(e), false))
          if (g !== this.gen) return
        } else {
          this.made.push({ text, buf: null })
        }
        const took = (performance.now() - this.makingAt) / 1000
        const s = took / text.length
        // A sentence that waited for the voice to start (its model loading, tens of seconds) says nothing of how
        // fast it makes: more than 3 times the guess is not learnt.
        if (ok && text.length >= 4 && s <= this.secPerChar * 3) {
          this.secPerChar = this.timed ? this.secPerChar * 0.5 + s * 0.5 : s
          this.timed = true
          if (soundSec > 0) {
            const f = Math.min(1.5, soundSec / took)
            this.flow = this.flowTimed ? this.flow * 0.5 + f * 0.5 : f
            this.flowTimed = true
          }
        }
        this.makingChars = 0
        this.nudge()
      }
    } finally {
      if (g === this.gen) this.fetching = false
    }
  }

  /** Reads a WAV stream into pieces of sound as they come. True when it ended well. */
  private async stream(body: ReadableStream<Uint8Array>, text: string, g: number, heard: (sec: number) => void): Promise<boolean> {
    if (!this.flowTimed) this.flow = FIRST_FLOW
    const reader = body.getReader()
    this.reader = reader
    const pcm = new PcmPieces()
    const add = (f: Float32Array | null) => {
      if (!f || !f.length) return
      const buf = this.ctx.createBuffer(1, f.length, pcm.rate)
      buf.getChannelData(0).set(f)
      heard(buf.duration)
      this.made.push({ text, buf })
      this.nudge()
    }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (g !== this.gen) return false
        if (done) break
        for (const f of pcm.push(value)) add(f)
      }
      add(pcm.end())
      return true
    } finally {
      if (this.reader === reader) this.reader = null
    }
  }

  private sleep(ms: number | null) {
    return new Promise<void>((r) => {
      this.wake = r
      if (ms != null) setTimeout(r, Math.max(0, ms))
    })
  }

  private async playLoop(g: number) {
    this.playing = true
    try {
      // Hold before the first sound, and again whenever reading has caught up with making.
      let hold = true
      while (g === this.gen) {
        const pending = this.made.length > 0 || this.queue.length > 0 || this.makingChars > 0
        const ahead = this.aheadSec()
        if (!pending) {
          if (ahead <= 0) break
          await this.sleep(ahead * 1000 + 20)
          continue
        }
        if (hold) {
          const left = this.leftChars()
          const wait = holdFor(this.madeSec() + ahead, left, this.secPerChar, 0.5, this.flow)
          if (!this.made.length || wait > 0) {
            if (ahead <= 0) this.onWait(Date.now() + Math.max(wait, left * this.secPerChar * (1 - this.flow)) * 1000)
            // Looked at again as time passes too: what is made does not change, but what is left gets shorter.
            await this.sleep(this.made.length || ahead > 0 ? Math.min(1000, Math.max(wait, 0.05) * 1000) : null)
            continue
          }
          hold = false
          this.onWait(null)
        }
        if (this.made.length) {
          while (this.made.length) {
            const m = this.made.shift()!
            this.played = true
            if (m.buf) this.schedule(m.buf)
          }
          continue
        }
        // Nothing new: wait for more, or until what is given is nearly heard. Run dry while still making: hold again.
        if (ahead > 0.08) await this.sleep((ahead - 0.08) * 1000)
        else hold = true
      }
    } finally {
      if (g === this.gen) {
        this.playing = false
        this.onWait(null)
        if (!this.fetching && !this.queue.length) {
          this.played = false
          this.running = false
          this.onState(false)
        }
      }
    }
  }

  /** Gives a piece to the speaker right where the last one ends, so the pieces of a sentence join without a gap. */
  private schedule(buf: AudioBuffer) {
    const s = this.ctx.createBufferSource()
    s.buffer = buf
    s.connect(this.gain)
    const at = Math.max(this.ctx.currentTime + 0.03, this.sources.size ? this.endAt : 0)
    s.onended = () => {
      this.sources.delete(s)
      this.nudge()
    }
    this.sources.add(s)
    s.start(at)
    this.endAt = at + buf.duration
  }

  /** Quieter (to) or back to full (1), smoothly so it does not click. */
  duck(to: number) {
    const t = this.ctx.currentTime
    this.gain.gain.cancelScheduledValues(t)
    this.gain.gain.setTargetAtTime(to, t, 0.05)
  }

  /** Stops at once, and nothing waiting is read. A sound still being made is let go (the voice stops making it). */
  stop() {
    this.gen++
    this.queue = []
    this.made = []
    this.makingChars = 0
    this.fetching = false
    this.playing = false
    this.played = false
    const r = this.reader
    this.reader = null
    void r?.cancel().catch(() => {})
    for (const s of this.sources) {
      try {
        s.stop()
      } catch {}
    }
    this.sources.clear()
    this.endAt = 0
    this.nudge()
    this.duck(1)
    this.onWait(null)
    if (this.running) {
      this.running = false
      this.onState(false)
    }
  }

  close() {
    this.stop()
    this.gain.disconnect()
  }
}
