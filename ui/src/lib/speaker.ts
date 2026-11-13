// 대화 모드 (REQ-F-907): the answer read aloud, a sentence at a time, through the AudioContext the microphone was
// opened with (made inside the person's press: Safari plays sound only from one of those). The next sentence's sound
// is fetched while this one plays, so there is no gap between them. duck() lowers it while a sound might be the
// person starting to speak; stop() ends it at once and forgets what was waiting.

/** One sentence's sound from the Mac: encoded audio (wav, aiff or m4a), as the browser decodes it. */
export type Voice = (text: string) => Promise<ArrayBuffer>

export class Speaker {
  private gain: GainNode
  private queue: string[] = []
  private gen = 0
  private src: AudioBufferSourceNode | null = null
  private next: { text: string; buf: Promise<AudioBuffer | null> } | null = null
  private running = false
  /** Told when it starts and stops speaking. */
  onState = (_speaking: boolean) => {}
  /** Told when a sentence could not be made (the reason, once per answer). */
  onError = (_why: string) => {}

  constructor(
    private ctx: AudioContext,
    private voice: Voice,
  ) {
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
    if (!this.running) void this.loop(this.gen)
  }

  private fetch(text: string): Promise<AudioBuffer | null> {
    return this.voice(text)
      .then((b) => this.ctx.decodeAudioData(b))
      .catch((e) => (this.onError((e as Error)?.message ?? String(e)), null))
  }

  private async loop(g: number) {
    this.running = true
    this.onState(true)
    try {
      while (g === this.gen && (this.queue.length || this.next)) {
        const cur = this.next ?? (() => { const text = this.queue.shift()!; return { text, buf: this.fetch(text) } })()
        this.next = null
        // The one after this, fetched while this one plays.
        if (this.queue.length) {
          const text = this.queue.shift()!
          this.next = { text, buf: this.fetch(text) }
        }
        const buf = await cur.buf
        if (g !== this.gen) return
        if (buf) await this.play(buf, g)
      }
    } finally {
      if (g === this.gen) {
        this.running = false
        this.onState(false)
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
    this.next = null
    const s = this.src
    this.src = null
    try {
      s?.stop()
    } catch {}
    this.duck(1)
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
