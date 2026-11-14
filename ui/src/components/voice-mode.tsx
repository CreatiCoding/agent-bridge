// 음성 모드 (REQ-F-754): in place of the input box while it is on. The microphone stays open; what is said shows at
// once (the browser's recogniser, grey) and is replaced phrase by phrase by what the Mac's whisper wrote (the words
// kept). Two buttons: 리셋 forgets everything gathered, 전송 takes it at once (grey words too) and goes on listening;
// what was taken shows in the conversation at once (grey) and is sent when the Mac's words are in. Turning it off puts
// what was gathered in the input box.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError, post } from '../lib/api'
import { voiceCommand, type VoiceEnd } from '../lib/voice-commands'
import { addVoiceRecent, getVoiceDevice, joinWords, setVoiceDevice, VOICE_CODE_TITLE, type LiveListen, type LivePreview, type Phrase, type VoiceResult } from '../lib/voice'
import { inHomeApp, safariHref } from '../lib/safari'
import { Button, IconButton } from '../kit'
import { toast } from '../kit/overlay'
import { linkClick } from '../lib/builtin-actions'
import { pairedHosts, pairedWith } from '../lib/trust'
import { getStore } from '../lib/store'
import { bargeIn, BARGE, fromBase64, isEcho, learnVoice, nearVoice, ReadQueue, sentences, speakable, TURN, turnEnd } from '../lib/talk'
import { withHint } from '../lib/timeline'
import { Speaker } from '../lib/speaker'

interface Said {
  id: number
  /** Still on the Mac, written, or failed (then what the browser heard stands in, when it heard it). */
  state: 'wait' | 'done' | 'bad'
  text: string
  /** How far the browser's words had got when this phrase ended: what comes after belongs to later phrases. */
  mark: number
}

/** A message 전송 put in the conversation before its words are final: sent (or dropped) once the Mac has written it. */
export interface VoiceDraft {
  send: (text: string) => Promise<boolean>
  drop: () => void
}

/** The microphone stops giving sound when the browser's recogniser takes it (some phones): the instant words go. */
const DEAD_MS = 3000

export function VoiceMode({
  sessionId,
  listen,
  preview,
  disabled,
  onSend,
  onDraft,
  onClose,
  endRef,
  takeRef,
  head,
  panes = 0,
  paneNo = 0,
  onRoute,
  carry,
  talk,
}: {
  sessionId: string
  listen: LiveListen
  preview: LivePreview | null
  disabled?: string
  onSend: (text: string) => Promise<boolean>
  /** Shows what 전송 took in the conversation at once; without it the message shows only when it is sent. */
  onDraft?: (shown: string) => VoiceDraft
  onClose: (text: string) => void
  /** Where the page's key finds how to turn it off (the same as the button). */
  endRef: React.MutableRefObject<() => void>
  /** Where the pane of 분할 화면 finds how to hand what was gathered over when another pane takes the microphone. */
  takeRef?: React.MutableRefObject<() => Promise<string>>
  /** Said beside the state (분할 화면: which pane hears, and how to move it). */
  head?: ReactNode
  /** 분할 화면: how many panes there are and which this is (1-based), for "두 번째 세션 …" (REQ-F-789). */
  panes?: number
  paneNo?: number
  /** A phrase that named another pane: hear into that one, which takes this phrase and what it ends with. */
  onRoute?: (pane: number, text: string, end: VoiceEnd | null) => void
  /** What a phrase that named this pane brought with it (taken once, as the panel comes up). */
  carry?: () => { text: string; end: VoiceEnd | null } | null
  /** 대화 모드 (REQ-F-907): the session's answers, the new ones read aloud. Without it (분할 화면) it is 음성 모드 only. */
  talk?: { answers: { key: string; text: string }[] }
}) {
  const [said, setSaid] = useState<Said[]>([])
  const [live, setLive] = useState('')
  // A panel that takes over a microphone already open (분할 화면) starts after what the browser heard before it.
  const [base, setBase] = useState(() => preview?.text().length ?? 0)
  const [speaking, setSpeaking] = useState(false)
  const [err, setErr] = useState<{ title: string; detail: string } | null>(null)
  const [note, setNote] = useState(preview?.off ?? '')
  const [closing, setClosing] = useState(false)
  const meter = useRef<HTMLSpanElement>(null)
  // 대화 모드 (REQ-F-907): sent when the person stops, the answer read aloud, and stopped when they speak again.
  const [auto, setAuto] = useState(() => getVoiceDevice().talk)
  const talkOn = !!talk && auto
  const autoNow = useRef(talkOn)
  autoNow.current = talkOn
  const [reading, setReading] = useState(false)
  const [judging, setJudging] = useState(false)
  const judgingNow = useRef(false)
  const talkPost = <T,>(body: object) => post<T>(`/api/sessions/${sessionId}/talk`, body)
  const speaker = useMemo(
    () => (talk ? new Speaker(listen.audio, (text) => talkPost<{ audio: string }>({ op: 'tts', text }).then((r) => fromBase64(r.audio))) : null),
    [listen, !!talk, sessionId],
  )
  const speakerNow = useRef(speaker)
  speakerNow.current = speaker
  // What was read lately, and when it ended: a phrase that is only that coming back through the microphone is dropped.
  const readText = useRef('')
  const readEnd = useRef(0)
  useEffect(() => {
    if (!speaker) return
    speaker.onState = (on) => (setReading(on), on ? null : (readEnd.current = Date.now()))
    speaker.onError = (why) => setErr({ title: '목소리를 만들지 못했어요', detail: why })
    return () => speaker.close()
  }, [speaker])
  const queue = useRef<ReadQueue | null>(null)
  const readChain = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    if (!talk) return
    const q = queue.current
    // What was there when it began is never read; nor is what comes while 대화 is off.
    if (!q || !autoNow.current || !speaker) {
      ;(queue.current ??= new ReadQueue()).skip(talk.answers.map((a) => a.key))
      return
    }
    for (const a of talk.answers) {
      if (!q.take(a.key)) continue
      readChain.current = readChain.current.then(async () => {
        const plain = speakable(a.text)
        // A plain answer is read as it is; one that is mostly code or English is said in a line by the Mac's model.
        const said = plain !== 'unsure' ? plain : await talkPost<{ line: string }>({ op: 'brief', text: a.text.slice(0, 6000) }).then((r) => sentences(r.line), () => [])
        if (!said.length || !autoNow.current) return
        readText.current = `${readText.current} ${said.join(' ')}`.slice(-800)
        speaker.say(said)
      })
    }
  }, [talk?.answers, speaker])
  const textBox = useRef<HTMLDivElement>(null)
  // Each phrase goes to the Mac in turn; `gen` drops what comes back for phrases a 리셋 has thrown away.
  const chain = useRef<Promise<void>>(Promise.resolve())
  const gen = useRef(0)
  const nextId = useRef(1)
  // The phrases as refs too: 전송 reads them once the Mac has answered, long after the render it was pressed in.
  const info = useRef(new Map<number, { from: number; mark: number; text: string }>())
  const lastMark = useRef(base)
  const sentUpTo = useRef(0)
  const sending = useRef<Promise<void>>(Promise.resolve())
  const browserText = () => preview?.text() ?? ''
  const commands = useRef({ panes, paneNo, onRoute })
  commands.current = { panes, paneNo, onRoute }

  useEffect(() => {
    const take = (p: Phrase) => {
      const id = nextId.current++
      const g = gen.current
      const m = { from: lastMark.current, mark: browserText().length, text: '' }
      lastMark.current = m.mark
      info.current.set(id, m)
      setSaid((s) => [...s, { id, state: 'wait', text: '', mark: m.mark }])
      // The browser's words lag a little behind the sound: what it adds just after the pause is still this phrase.
      setTimeout(() => {
        if (nextId.current - 1 !== id || sentUpTo.current >= id || !info.current.has(id)) return
        m.mark = lastMark.current = Math.max(m.mark, browserText().length)
        setSaid((s) => s.map((x) => (x.id === id && x.state === 'wait' ? { ...x, mark: m.mark } : x)))
      }, 800)
      chain.current = chain.current.then(() => transcribe(id, g, p))
    }
    listen.listen(take)
    if (preview) {
      preview.onChange = () => setLive(preview.text())
      preview.onOff = (why) => setNote(why)
    }
    return () => {
      if (listen.taker === take) listen.listen(null)
    }
  }, [listen, preview])

  // The person's own level in this panel (REQ-F-909), learnt from their clear phrases.
  const voiceLv = useRef<number[]>([])
  // 리눅스 세션의 받아쓰기 (REQ-F-908): another Mac may hear it, but never for a machine paired with this device.
  const hostPaired = () => {
    const h = getStore().state?.sessions.find((x) => x.id === sessionId)?.hostId
    return !!h && pairedWith(h)
  }
  const transcribe = async (id: number, g: number, p: Phrase) => {
    let state: Said['state'] = 'done'
    let text = ''
    let rec: VoiceResult | null = null
    try {
      const r = await post<{ ok: true; raw: string; text: string; sec: number; ms?: { total?: number } }>(`/api/sessions/${sessionId}/voice`, { audio: p.audio, away: !hostPaired() })
      rec = { at: Date.now(), raw: r.raw, text: r.text, ms: r.ms, sec: r.sec, ...(p.snr != null ? { snr: Math.round(p.snr * 10) / 10 } : {}) }
      text = r.text.trim()
      if (g === gen.current) setErr(null)
    } catch (e) {
      const code = e instanceof ApiError ? String(e.data.code ?? '') : ''
      if (code !== 'silent') {
        state = 'bad'
        if (g === gen.current) setErr({ title: VOICE_CODE_TITLE[code] ?? '받아쓰지 못했어요', detail: (e as Error).message })
      }
    }
    const m = info.current.get(id)
    if (!m) return
    // A phrase the Mac could not write keeps what the browser heard for it.
    if (state === 'bad') text = browserText().slice(m.from, m.mark).trim()
    // The answer itself back through the microphone, heard while it was read (or just after): not the person's words.
    if (text && (speakerNow.current?.speaking || Date.now() - readEnd.current < 3000) && isEcho(text, readText.current)) text = ''
    // 가까이서 한 말만 (REQ-F-909): in 대화 모드 a phrase too quiet against the room, or short and barely over it, is
    // the room (other people, the train), not the person: it is not sent.
    if (text && autoNow.current) {
      const heard = p.snr != null ? { level: p.level ?? 0, snr: p.snr } : undefined
      const v = nearVoice(text, heard, voiceLv.current)
      if (v === 'keep') voiceLv.current = learnVoice(voiceLv.current, text, heard)
      else {
        if (rec) rec.room = v
        text = ''
      }
    }
    if (rec) addVoiceRecent(rec)
    // 음성 명령 (REQ-F-789), from this panel's latest render: the phrase is what it says without them.
    const now = commands.current
    const cmd = voiceCommand(text, now.panes)
    text = cmd.text
    m.text = text
    if (g !== gen.current) return
    setSaid((s) => s.map((x) => (x.id === id ? { ...x, state, text } : x)))
    // Another pane named: the phrase goes there, with what it ends with; this panel keeps the phrases before it.
    if (cmd.pane && cmd.pane !== now.paneNo && now.onRoute) {
      m.text = ''
      setSaid((s) => s.filter((x) => x.id !== id))
      return now.onRoute(cmd.pane, text, cmd.end)
    }
    // A paired device never sends words it has not shown first (REQ-S-091): what the Mac heard comes back through the server.
    if (cmd.end === 'send') pairedHosts().length ? toast('짝지은 기기라 자동 전송을 껐어요 · 확인하고 보내기를 눌러 주세요') : sendNow.current()
    else if (cmd.end === 'reset') resetNow.current()
  }

  // The meter and "말하는 중" follow the sound without drawing the panel again each frame.
  useEffect(() => {
    let raf = 0
    let was = false
    let ducked = false
    let heardAt = -1
    const tick = () => {
      meter.current?.style.setProperty('--lvl', String(listen.level))
      // The person speaking while the answer is read: quieter at a sound, stopped once it is sure to be speech.
      const sp = speakerNow.current
      if (sp?.speaking) {
        if (heardAt < 0 || !listen.loudMs) heardAt = browserText().length
        const b = bargeIn(listen.loudMs, browserText().length > heardAt + 1)
        if (b === 'stop') sp.stop()
        else if (b === 'duck') (ducked = true, sp.duck(BARGE.duckTo))
        else if (ducked) (ducked = false, sp.duck(1))
      } else heardAt = -1
      if (listen.speaking !== was) setSpeaking((was = listen.speaking))
      if (preview?.running && listen.deadMs > DEAD_MS) {
        preview.fail('이 기기에서는 즉시 받아쓰기와 녹음을 같이 못 해요. 즉시 받아쓰기를 껐어요')
        setVoiceDevice({ ...getVoiceDevice(), live: false })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [listen, preview])

  // The screen stays on while listening (a phone that sleeps stops the microphone); back on the page it goes on.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null
    const wake = () => {
      const wl = (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock
      wl?.request('screen').then(
        (l) => (lock = l),
        () => {},
      )
    }
    const vis = () => {
      if (document.visibilityState !== 'visible') return
      listen.resume()
      wake()
    }
    wake()
    document.addEventListener('visibilitychange', vis)
    return () => (document.removeEventListener('visibilitychange', vis), void lock?.release().catch(() => {}))
  }, [listen])

  // The words kept are the phrases written so far, in order; the browser's words after the last of them follow, grey.
  const firstWaiting = said.findIndex((x) => x.state === 'wait')
  const doneUpTo = firstWaiting < 0 ? said.length : firstWaiting
  const kept = said.slice(0, doneUpTo).reduce((t, x) => joinWords(t, x.text), '')
  const from = doneUpTo ? said[doneUpTo - 1].mark : base
  const tail = preview && !note ? live.slice(from).trim() : ''
  const waiting = said.length - doneUpTo
  useEffect(() => {
    const el = textBox.current
    if (el) el.scrollTop = el.scrollHeight
  }, [kept, tail])

  // 대화 모드: after a quiet while, the words decide (sent, or wait for more); when they cannot, the Mac's model does.
  const viewNow = useRef({ kept, tail, waiting })
  viewNow.current = { kept, tail, waiting }
  const lastSound = useRef(Date.now())
  const judged = useRef<string | null>(null)
  useEffect(() => {
    const t = setInterval(() => {
      if (!autoNow.current) return
      if (listen.speaking || listen.loudMs > 0) return void (lastSound.current = Date.now())
      const v = viewNow.current
      const text = joinWords(v.kept, v.tail).trim()
      if (!text || v.waiting || judgingNow.current) return
      const quiet = Date.now() - lastSound.current
      if (quiet < TURN.quietMs) return
      // The Mac's words when they are in (the browser's are rougher).
      const end = turnEnd(v.kept || text)
      if (end === 'done') return sendNow.current()
      if (end === 'more' && quiet < TURN.quietMs + TURN.moreMs) return
      // The model said more is coming (or could not say): sent after a long quiet all the same.
      if (judged.current === text) return void (quiet >= TURN.quietMs + TURN.afterMs && sendNow.current())
      const at = lastSound.current
      judgingNow.current = true
      setJudging(true)
      void talkPost<{ end: 'done' | 'more' }>({ op: 'turn', text })
        .then(
          (r) => r.end,
          () => 'more' as const,
        )
        .then((r) => {
          judgingNow.current = false
          setJudging(false)
          const now = viewNow.current
          // Spoken again meanwhile: the answer is for words that are not the last ones any more.
          if (lastSound.current !== at || joinWords(now.kept, now.tail).trim() !== text) return
          if (r === 'done') sendNow.current()
          else judged.current = text
        })
    }, 150)
    return () => clearInterval(t)
  }, [listen])

  /**
   * Ends the phrase being spoken and takes every phrase not sent yet out of the panel: their ids, and a promise that
   * holds once the Mac has written them all. The panel starts over from here and goes on listening.
   */
  const takeAll = () => {
    listen.flush()
    const last = nextId.current - 1
    const ids = [...info.current.keys()].filter((id) => id > sentUpTo.current && id <= last)
    sentUpTo.current = last
    lastMark.current = browserText().length
    setBase(lastMark.current)
    setSaid((s) => s.filter((x) => x.id > last))
    setErr(null)
    const written = chain.current.then(() => {
      const text = ids.reduce((t, id) => joinWords(t, info.current.get(id)?.text ?? ''), '').trim()
      ids.forEach((id) => info.current.delete(id))
      return text
    })
    return { ids, written }
  }
  /**
   * 전송 at once, grey words and all: the panel empties, what was said shows in the conversation (grey), and when the
   * Mac's words are in they replace it and are sent; sends keep their order. Grey words with no phrase cut for them (the sound was too
   * short to be one) are sent as the browser heard them.
   */
  const send = () => {
    if (closing || disabled) return
    const shown = joinWords(kept, tail).trim()
    const { ids, written } = takeAll()
    if (!ids.length && !shown) return toast('보낼 말이 아직 없어요')
    const draft = onDraft?.(shown || '…')
    const hint = autoNow.current
    judged.current = null
    speakerNow.current?.stop()
    sending.current = sending.current.then(async () => {
      const said = ids.length ? await written : shown
      const text = said && hint ? withHint(said) : said
      if (text) {
        // Not taken (the session refused it): back in the panel, to send again or reset.
        if (!(await (draft ? draft.send(text) : onSend(text)).catch(() => false))) {
          const back = nextId.current++
          info.current.set(back, { from: lastMark.current, mark: lastMark.current, text })
          setSaid((s) => [{ id: back, state: 'done', text, mark: lastMark.current }, ...s])
        }
      } else {
        draft?.drop()
        toast('받아쓴 말이 없어 보내지 않았어요')
      }
    })
  }
  const reset = () => {
    gen.current++
    listen.drop()
    chain.current = Promise.resolve()
    for (const id of info.current.keys()) if (id > sentUpTo.current) info.current.delete(id)
    sentUpTo.current = nextId.current - 1
    setSaid([])
    setErr(null)
    lastMark.current = browserText().length
    setBase(lastMark.current)
  }
  const close = async () => {
    if (closing) return
    setClosing(true)
    onClose(await takeAll().written)
  }

  // On a PC: Enter (or ⌘Enter) sends, Esc resets.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable="true"]') || e.isComposing) return
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) (e.preventDefault(), sendNow.current())
      else if (e.key === 'Escape') (e.preventDefault(), resetNow.current())
    }
    addEventListener('keydown', down)
    return () => removeEventListener('keydown', down)
  }, [])
  const sendNow = useRef(send)
  sendNow.current = send
  const resetNow = useRef(reset)
  resetNow.current = reset
  // A phrase that named this pane in another one lands here, and is sent (or forgets all) as it ended.
  useEffect(() => {
    const c = carry?.()
    if (!c) return
    if (c.end === 'reset') return void resetNow.current()
    if (c.text) {
      const id = nextId.current++
      info.current.set(id, { from: lastMark.current, mark: lastMark.current, text: c.text })
      setSaid((s) => [...s, { id, state: 'done', text: c.text, mark: lastMark.current }])
    }
    if (c.end === 'send' && !pairedHosts().length) setTimeout(() => sendNow.current())
  }, [])
  endRef.current = () => void close()
  if (takeRef) takeRef.current = () => takeAll().written

  const status = closing ? '마무리하는 중…' : speaking ? '말하는 중' : waiting ? '받아쓰는 중…' : judging ? '말이 끝났는지 보는 중…' : reading ? 'Claude 가 말하는 중' : '듣는 중'
  const toggleAuto = () => {
    const on = !auto
    setAuto(on)
    setVoiceDevice({ ...getVoiceDevice(), talk: on })
    if (!on) speakerNow.current?.stop()
  }
  return (
    <div className="inputbox voice-mode" role="region" aria-label="음성 모드">
      <div className="voice-head">
        <span ref={meter} className={`voice-meter${speaking ? ' on' : ''}`} aria-hidden />
        <span className="voice-state" role="status">
          {status}
        </span>
        {head}
        {talk ? (
          <Button size="sm" tone={auto ? 'primary' : undefined} onClick={toggleAuto} aria-pressed={auto} title="말을 멈추면 알아서 보내고, 답을 목소리로 읽어요">
            {auto ? '대화 켬' : '대화 끔'}
          </Button>
        ) : null}
        <IconButton icon="mic" label="음성 모드 끄기" className="glass-btn mic-btn rec" onClick={() => void close()} disabled={closing} />
      </div>
      <div ref={textBox} className="voice-text" aria-live="polite">
        {kept || tail ? (
          <>
            {kept}
            {kept && tail ? ' ' : null}
            {tail ? <span className="voice-live">{tail}</span> : null}
            {waiting && !tail ? <span className="voice-live"> …</span> : null}
          </>
        ) : waiting ? (
          <span className="voice-live">…</span>
        ) : (
          <span className="voice-hint">
            {talkOn ? '말해 보세요. 말을 멈추면 알아서 보내고, 답은 목소리로 읽어 드려요. 읽는 중에 말하면 멈춰요' : '말해 보세요. 말한 내용이 여기에 쌓이고, 전송을 누르면 보내요'}
            {inHomeApp() ? (
              <>
                {' '}
                홈 화면 앱은 켤 때마다 마이크를 다시 물어요. <a href={safariHref()} onClick={linkClick(safariHref(), 'safari', '_self')}>Safari로 열기</a>
              </>
            ) : null}
          </span>
        )}
      </div>
      {err ? (
        <details className="voice-err">
          <summary>{err.title}</summary>
          {err.detail}
        </details>
      ) : null}
      {note ? <div className="voice-note">{note}</div> : null}
      <div className="voice-actions">
        <Button size="lg" onClick={reset} disabled={closing || (!said.length && !tail)}>
          리셋
        </Button>
        <Button size="lg" tone="primary" icon="send" onClick={send} disabled={!!disabled || closing || (!said.length && !tail && !speaking)}>
          전송
        </Button>
      </div>
    </div>
  )
}
