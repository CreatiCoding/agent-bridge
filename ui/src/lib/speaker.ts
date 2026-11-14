// 대화 모드 (REQ-F-907): the answer read aloud, a sentence at a time, through the AudioContext the microphone was
// opened with (made inside the person's press: Safari plays sound only from one of those). Every sentence waiting is
// fetched in turn as soon as it is known, so the voice keeps making while one plays. A slow voice (소희 on an M1,
// REQ-F-911, makes a sentence in about the time it takes to hear it at 1.25배) would leave gaps, so reading starts,
// and starts again after a gap, only once what is made already lasts as long as what is left to make is expected to
// take (`holdFor`). duck() lowers it while a sound might be the person starting to speak; stop() ends it at once and
// forgets what was waiting.

/** One sentence's sound from the Mac: encoded audio (wav, aiff or m4a), as the browser decodes it. */
export type Voice = (text: string) => Promise<ArrayBuffer>

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
 * How long to wait before reading, in seconds: the time the rest is expected to take to make, less what is made
 * already (it plays meanwhile), with a little to spare. 0 when nothing is left to make.
 */
export function holdFor(madeSec: number, leftChars: number, secPerChar: number, spare = 0.5): number {
  if (leftChars <= 0) return 0
  return Math.max(0, leftChars * secPerChar + spare - madeSec)
}

type Made = { text: string; buf: AudioBuffer | null }

export class Speaker {
  private gain: GainNode
  /** Sentences not yet asked for. */
  private queue: string[] = []
  /** Sentences made, not yet played. */
  private made: Made[] = []
  /** Letters of the sentence being made now (0: none). */
  private makingChars = 0
  private gen = 0
  private src: AudioBufferSourceNode | null = null
  private running = false
  private playing = false
  /** Whether any of this answer has been read yet (since the voice last went quiet). */
  private played = false
  private fetching = false
  private wake: (() => void) | null = null
  /** Seconds of making per letter, learnt from the last sentences (network included). */
  private secPerChar = FIRST_SEC_PER_CHAR
  private timed = false
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

  private leftChars() {
    return this.makingChars + this.queue.reduce((s, t) => s + t.length, 0)
  }

  private async fetchLoop(g: number) {
    this.fetching = true
    try {
      while (g === this.gen && this.queue.length) {
        const text = nextChunk(this.queue, !this.made.length && !this.played)
        this.makingChars = text.length
        const t0 = performance.now()
        const buf = await this.voice(text)
          .then((b) => this.ctx.decodeAudioData(b))
          .catch((e) => (g === this.gen ? this.onError((e as Error)?.message ?? String(e)) : null, null))
        if (g !== this.gen) return
        const s = (performance.now() - t0) / 1000 / text.length
        // A sentence that waited for the voice to start (its model loading, tens of seconds) says nothing of how
        // fast it makes: more than 3 times the guess is not learnt.
        if (buf && text.length >= 4 && s <= this.secPerChar * 3) {
          this.secPerChar = this.timed ? this.secPerChar * 0.5 + s * 0.5 : s
          this.timed = true
        }
        this.makingChars = 0
        this.made.push({ text, buf })
        this.nudge()
      }
    } finally {
      if (g === this.gen) this.fetching = false
    }
  }

  private async playLoop(g: number) {
    this.playing = true
    try {
      // Hold before the first sentence, and again whenever reading has caught up with making.
      let hold = true
      while (g === this.gen) {
        if (!this.made.length && !this.queue.length && !this.makingChars) break
        const wait = hold ? holdFor(this.madeSec(), this.leftChars(), this.secPerChar) : 0
        if (!this.made.length || wait > 0) {
          this.onWait(Date.now() + Math.max(wait, this.makingChars * this.secPerChar) * 1000)
          await new Promise<void>((r) => {
            this.wake = r
            // Looked at again as time passes too: what is made does not change, but what is left gets shorter.
            if (this.made.length) setTimeout(r, Math.min(1000, wait * 1000))
          })
          if (g !== this.gen) return
          if (!this.made.length) hold = true
          continue
        }
        this.onWait(null)
        hold = false
        const m = this.made.shift()!
        this.played = true
        if (m.buf) await this.play(m.buf, g)
        if (!this.made.length) hold = true
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

  private play(buf: AudioBuffer, g: number) {
    return new Promise<void>((done) => {
      if (g !== this.gen) return done()
      const s = this.ctx.createBufferSource()
      s.buffer = buf
      s.connect(this.gain)
      s.onended = () => {
        if (this.src === s) this.src = null
        done()
      }
      this.src = s
      s.start()
    })
  }

  /** Quieter (to) or back to full (1), smoothly so it does not click. */
  duck(to: number) {
    const t = this.ctx.currentTime
    this.gain.gain.cancelScheduledValues(t)
    this.gain.gain.setTargetAtTime(to, t, 0.05)
  }

  /** Stops at once, and nothing waiting is read. */
  stop() {
    this.gen++
    this.queue = []
    this.made = []
    this.makingChars = 0
    this.fetching = false
    this.playing = false
    this.played = false
    const s = this.src
    this.src = null
    try {
      s?.stop()
    } catch {}
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
