// Where the person writes. On a PC and an iPad Enter sends (Shift+Enter for a new line); on a phone Enter is a new
// line and the button sends. ↑ in an empty box brings back what this session was sent before (from its conversation,
// so the same on every device). Pictures can be picked, pasted (Ctrl+V in the box, or "클립보드에서 붙여넣기" under
// the picture button, which is the only way on a phone) or dropped (8 at most). A line starting with / offers the session's skills and commands.
// With 음성 입력 on (설정 → 음성), a microphone button turns 음성 모드 on: the box gives way to a panel that keeps
// listening and gathers what is said, sent with one press (components/voice-mode.tsx); on a PC a key does the same.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import { get } from '../lib/api'
import { shrinkImage } from '../lib/image'
import { uploadVideo, VIDEO_MAX, VIDEO_TYPES, type SentVideo } from '../lib/video'
import { getDraft, setDraft } from '../lib/local'
import { isIPad } from '../lib/safari'
import type { Session } from '../lib/types'
import { canPreview, getVoiceDevice, isVoiceKey, joinWords, KEY_LABEL, LiveListen, LivePreview, micError, useVoicePrefs } from '../lib/voice'
import { inPane, splitHost, useSplitVoice } from '../lib/split'
import { Button, Icon, IconButton, NO_AUTOFILL, useMedia } from '../kit'
import { VoiceMode, type VoiceDraft } from './voice-mode'
import { openMenu, toast } from '../kit/overlay'
import { featureOn } from '../lib/features'
import { dispatch } from '../lib/actions'
import { registerComposer } from '../lib/builtin-actions'

interface Skill {
  name: string
  kind?: string
  description?: string
  count?: number
}

// The pictures in a paste: some browsers put them only in items, not in files.
const pastedImages = (d: DataTransfer) => {
  const files = [...d.files].filter((f) => f.type.startsWith('image/'))
  if (files.length) return files
  return [...d.items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => !!f)
}
const IPAD = isIPad()
const canReadClipboard = typeof navigator !== 'undefined' && !!navigator.clipboard?.read

export interface ComposerHandle {
  setText: (text: string) => void
  focus: () => void
}

export type { SentVideo }

export const Composer = forwardRef<ComposerHandle, { session: Session; history: string[]; disabled?: string; busy: boolean; onSend: (text: string, images: { data: string; name: string }[], videos?: SentVideo[]) => Promise<boolean>; onDraft?: (shown: string) => VoiceDraft; onStop: () => void; tools?: ReactNode }>(function Composer({ session, history, disabled, busy, onSend, onDraft, onStop, tools }, ref) {
  const [text, setText] = useState(() => getDraft(session.id))
  const [images, setImages] = useState<{ data: string; name: string }[]>([])
  // Videos go up as they are when the message is sent (REQ-F-761); pct is how far that has got.
  const [videos, setVideos] = useState<{ file: File; pct: number | null }[]>([])
  const [sending, setSending] = useState(false)
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [pick, setPick] = useState(0)
  const box = useRef<HTMLTextAreaElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const recall = useRef<number | null>(null)
  const recalling = useRef<string[]>([])
  const lastSent = useRef<{ text: string; at: number } | null>(null)
  const mouse = useMedia('(pointer: fine)')
  // An iPad sends on Enter as a PC does (its keyboard has Shift for a new line); a phone's Enter stays a new line.
  const enterSends = mouse || IPAD

  useImperativeHandle(ref, () => ({
    setText: (t) => {
      setText(t)
      requestAnimationFrame(() => box.current?.focus())
    },
    focus: () => box.current?.focus(),
  }))

  // Each session keeps its own draft.
  useEffect(() => {
    setText(getDraft(session.id))
    setImages([])
    setVideos([])
    setSkills(null)
  }, [session.id])
  useEffect(() => {
    const t = setTimeout(() => setDraft(session.id, text), 300)
    return () => clearTimeout(t)
  }, [session.id, text])
  // A box turned off (the Mac gone for a few seconds while its agent restarts) loses the cursor; it is put back
  // when the box comes on again, if it had it and nothing else took it meanwhile. Read during render: by the
  // time an effect runs the browser has already moved focus away.
  const offFocused = useRef(false)
  const wasOff = useRef(false)
  if (disabled && !wasOff.current) offFocused.current = typeof document !== 'undefined' && document.activeElement === box.current && !!box.current
  useEffect(() => {
    wasOff.current = !!disabled
    if (disabled || !offFocused.current) return
    offFocused.current = false
    const el = box.current
    const now = document.activeElement
    if (el && (!now || now === document.body)) el.focus()
  }, [disabled])
  // The box grows with what is written, up to as many whole lines as fit in 30% of the window (then it scrolls).
  // Whole lines, so the last visible one is never cut in half. Counted again when the window changes size.
  const [winH, setWinH] = useState(() => window.innerHeight)
  useEffect(() => {
    const onResize = () => setWinH(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  useEffect(() => {
    const el = box.current
    if (!el) return
    const cs = getComputedStyle(el)
    const line = parseFloat(cs.lineHeight) || 24
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    const lines = Math.max(1, Math.floor((winH * 0.3 - pad) / line))
    el.style.maxHeight = `${Math.ceil(lines * line + pad)}px`
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text, winH])

  const slash = /^\/([\w:-]*)$/.exec(text)
  useEffect(() => {
    if (!slash || skills) return
    get<{ ok: true; skills: Skill[] }>(`/api/sessions/${session.id}/skills`)
      .then((r) => setSkills(r.skills))
      .catch(() => setSkills([]))
  }, [slash, skills, session.id])
  const matches = slash && skills ? skills.filter((s) => s.name.toLowerCase().includes(slash[1].toLowerCase())).slice(0, 8) : []

  const addFiles = async (files: FileList | File[]) => {
    const vids = [...files].filter((f) => f.type.startsWith('video/'))
    if (vids.length) {
      const ok = vids.filter((f) => VIDEO_TYPES.includes(f.type) && f.size <= VIDEO_MAX)
      if (ok.length < vids.length) toast(`mp4·mov·webm 영상, ${VIDEO_MAX / 1024 / 1024}MB 까지 보낼 수 있어요`)
      if (videos.length + ok.length > 3) toast('영상은 한 번에 3개까지 보낼 수 있어요')
      setVideos((now) => [...now, ...ok.map((file) => ({ file, pct: null }))].slice(0, 3))
    }
    const list = [...files].filter((f) => f.type.startsWith('image/'))
    if (!list.length) return
    if (images.length + list.length > 8) toast('그림은 한 번에 8장까지 보낼 수 있어요')
    const made = await Promise.all(list.slice(0, 8 - images.length).map((f) => shrinkImage(f).catch(() => null)))
    setImages((now) => [...now, ...made.filter((x): x is { data: string; name: string } => !!x)].slice(0, 8))
  }

  // Read pictures straight from the clipboard (the browser may ask first; iOS shows its own 붙여넣기 bubble).
  const fromClipboard = async () => {
    const got: File[] = []
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith('image/'))
        if (type) got.push(new File([await item.getType(type)], `clipboard.${type.split('/')[1]}`, { type }))
      }
    } catch {
      return toast('클립보드를 읽지 못했어요. 브라우저가 허락하지 않았어요', { tone: 'bad' })
    }
    if (!got.length) return toast('클립보드에 그림이 없어요')
    await addFiles(got)
  }
  const attach = (at: HTMLElement) => {
    if (!canReadClipboard) return file.current?.click()
    openMenu(
      [
        { label: '사진·영상 고르기', icon: 'image', onSelect: () => file.current?.click() },
        { label: '클립보드에서 붙여넣기', icon: 'copy', onSelect: () => void fromClipboard() },
      ],
      at,
    )
  }

  // composer.submit (REQ-F-822): the default sends `override` (or what is written) with what is attached, and
  // empties the box once it went. A press waits here too, so a second press while it goes does nothing.
  const submitting = useRef(false)
  const submit = async (override?: string): Promise<{ sent: boolean; reason?: string }> => {
    const t = (override ?? text).trim()
    if (!t && !images.length && !videos.length) return { sent: false, reason: 'empty' }
    if (submitting.current) return { sent: false, reason: 'sending' }
    // The same words twice in a row are usually a double press: the second press needs a second press.
    if (t && lastSent.current?.text === t && Date.now() - lastSent.current.at < 10_000 && !images.length && !videos.length) {
      lastSent.current = { text: '', at: 0 }
      toast('방금 보낸 글과 같아요. 한 번 더 누르면 보내요')
      return { sent: false, reason: 'duplicate' }
    }
    submitting.current = true
    setSending(true)
    // The videos first, one by one with how far each has got; the message names them once all are up.
    const sent: SentVideo[] = []
    for (const [i, v] of videos.entries()) {
      try {
        sent.push(await uploadVideo(`/api/sessions/${encodeURIComponent(session.id)}/upload`, v.file, (pct) => setVideos((now) => now.map((x, j) => (j === i ? { ...x, pct } : x)))))
      } catch (e) {
        setVideos((now) => now.map((x) => ({ ...x, pct: null })))
        submitting.current = false
        setSending(false)
        toast(`영상을 올리지 못했어요: ${e instanceof Error ? e.message : e}`, { tone: 'bad' })
        return { sent: false, reason: 'upload' }
      }
    }
    const ok = await onSend(t, images, sent)
    submitting.current = false
    setSending(false)
    if (ok) {
      lastSent.current = { text: t, at: Date.now() }
      setText('')
      setImages([])
      setVideos([])
      setDraft(session.id, '')
      recall.current = null
    }
    return { sent: ok }
  }
  const submitNow = useRef(submit)
  submitNow.current = submit
  useEffect(() => registerComposer(session.id, (t) => submitNow.current(t)), [session.id])
  // The box's own send: through the bus, held as sending while handlers decide.
  const pressing = useRef(false)
  const send = async () => {
    if (pressing.current || submitting.current) return
    pressing.current = true
    setSending(true)
    try {
      await dispatch('composer.submit', { sid: session.id })
    } finally {
      pressing.current = false
      if (!submitting.current) setSending(false)
    }
  }

  // ⌘Enter sends even while a Korean syllable is still being put together: it is sent once the IME lets it go.
  const sendAfterIme = useRef(false)
  const sendNow = useRef(send)
  sendNow.current = send
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const cmdEnter = e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey
    if (e.nativeEvent.isComposing || e.keyCode === 229) {
      if (cmdEnter) (e.preventDefault(), (sendAfterIme.current = true))
      return
    }
    if (cmdEnter) {
      e.preventDefault()
      sendAfterIme.current = false
      void send()
      return
    }
    if (matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length)
      return
    }
    if (matches.length && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
      e.preventDefault()
      setText(`/${matches[Math.min(pick, matches.length - 1)].name} `)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && enterSends) {
      e.preventDefault()
      void send()
      return
    }
    // ↑ on an empty input, or on a message just brought back (untouched), goes one further back in this session.
    if (e.key === 'ArrowUp' && !e.shiftKey && (!text || recall.current != null)) {
      // The list is taken once when going back starts: a message arriving meanwhile must not shift the steps.
      if (recall.current == null) recalling.current = history
      const h = recalling.current
      if (!h.length) return
      e.preventDefault()
      recall.current = recall.current == null ? h.length - 1 : Math.max(0, recall.current - 1)
      setText(h[recall.current])
      return
    }
    if (e.key === 'ArrowDown' && recall.current != null && !e.shiftKey) {
      const h = recalling.current
      e.preventDefault()
      recall.current = recall.current + 1
      if (recall.current >= h.length) {
        recall.current = null
        setText('')
      } else setText(h[recall.current])
      return
    }
    if (e.key === 'Escape' && busy && !text) {
      e.preventDefault()
      onStop()
    }
  }

  // 음성 모드 (REQ-F-754). The browser's recogniser starts inside the press, and the microphone is opened once it
  // is listening (LivePreview.start says why); the sound's AudioContext is made inside the press too (Safari wants
  // that). 'opening' is the wait for both.
  const voice = useVoicePrefs()
  const voiceOn = !!voice?.on && featureOn('voice') // features.voice (REQ-F-812)
  const [vm, setVm] = useState<{ listen: LiveListen; preview: LivePreview | null } | 'opening' | null>(null)
  const vmNow = useRef(vm)
  vmNow.current = vm
  // In 분할 화면 the microphone is the panes' (REQ-F-788): opened here, it is handed to the page around them, which
  // hears it into one pane at a time; turned on where it is open already, it is heard here from now on.
  const shared = useSplitVoice()
  const hereShared = !!shared && shared.target === window
  const hereNow = useRef(hereShared)
  hereNow.current = hereShared
  const takeShared = useRef<() => Promise<string>>(async () => '')
  if (hereShared)
    (window as unknown as { cbVoiceYield?: () => void }).cbVoiceYield = () =>
      void takeShared.current().then((said) => said && setText((t) => joinWords(t, said)))
  const voiceStart = async () => {
    if (vmNow.current) return
    const split = inPane ? splitHost() : null
    if (split?.voice()) return split.voiceTarget(window)
    const dev = getVoiceDevice()
    const listen = new LiveListen()
    const preview = dev.live && canPreview() ? new LivePreview(voice?.language ?? 'ko') : null
    const heard = preview?.start()
    setVm('opening')
    try {
      await heard
      await listen.start(dev.mic)
    } catch (e) {
      listen.close()
      preview?.stop()
      setVm(null)
      return toast(micError(e), { tone: 'bad' })
    }
    if (split) return (setVm(null), split.voiceStart(window, listen, preview))
    setVm({ listen, preview })
  }
  const voiceEnd = (said: string) => {
    const now = vmNow.current
    if (now && now !== 'opening') (now.listen.close(), now.preview?.stop())
    // Off in one pane is off in all of them.
    if (hereNow.current) splitHost()?.voiceEnd()
    setVm(null)
    if (said) setText((t) => joinWords(t, said))
    requestAnimationFrame(() => box.current?.focus())
  }
  // Leaving the session (or the page) turns it off, dropping what was gathered.
  useEffect(
    () => () => {
      const now = vmNow.current
      if (now && now !== 'opening') (now.listen.close(), now.preview?.stop())
      setVm(null)
    },
    [session.id],
  )
  // The key (on a PC) turns it on and off.
  const voiceEndNow = useRef<() => void>(() => {})
  useEffect(() => {
    if (!voiceOn) return
    const key = getVoiceDevice().key
    if (key === 'off') return
    const down = (e: KeyboardEvent) => {
      if (!isVoiceKey(e, key)) return
      e.preventDefault()
      if (e.repeat) return
      if (vmNow.current || hereNow.current) voiceEndNow.current()
      else void voiceStart()
    }
    addEventListener('keydown', down)
    return () => removeEventListener('keydown', down)
  }, [voiceOn, session.id])

  // A downward swipe on the box puts a phone's keyboard away. Not while the text inside is scrolled down (the swipe
  // scrolls it back first), and not for a sideways swipe (the chips scroll sideways).
  const swipe = useRef<{ x: number; y: number } | null>(null)
  const swipeStart = (e: React.TouchEvent) => {
    const ta = box.current
    swipe.current = ta && document.activeElement === ta && !(e.target === ta && ta.scrollTop > 0) ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null
  }
  const swipeMove = (e: React.TouchEvent) => {
    const s = swipe.current
    if (!s) return
    const dy = e.touches[0].clientY - s.y
    const dx = Math.abs(e.touches[0].clientX - s.x)
    if (dy > 40 && dy > dx * 1.5) (box.current?.blur(), (swipe.current = null))
  }

  const empty = !text.trim() && !images.length && !videos.length
  const dev = getVoiceDevice()
  return (
    <div
      className="composer-in"
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        void addFiles(e.dataTransfer.files)
      }}
    >
      {matches.length ? (
        <div className="slash-menu" role="listbox">
          {matches.map((s, i) => (
            <button key={s.name} type="button" role="option" aria-selected={i === pick} className={`slash-item${i === pick ? ' on' : ''}`} onMouseDown={(e) => (e.preventDefault(), setText(`/${s.name} `), box.current?.focus())}>
              <b>/{s.name}</b>
              <span>{s.description}</span>
            </button>
          ))}
        </div>
      ) : null}
      {images.length || videos.length ? (
        <div className="attach-row">
          {videos.map((v, i) => (
            <span key={`v${i}`} className="attach attach-video">
              <span className="attach-video-name">🎬 {v.file.name}</span>
              <span className="muted">{v.pct === null ? `${(v.file.size / 1024 / 1024).toFixed(1)}MB` : `올리는 중 ${v.pct}%`}</span>
              {sending ? null : (
                <button type="button" aria-label="빼기" onClick={() => setVideos(videos.filter((_, j) => j !== i))}>
                  <Icon name="close" />
                </button>
              )}
            </span>
          ))}
          {images.map((im, i) => (
            <span key={i} className="attach">
              <img src={im.data} alt={im.name} />
              <button type="button" aria-label="빼기" onClick={() => setImages(images.filter((_, j) => j !== i))}>
                <Icon name="close" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {shared && !hereShared ? (
        /* 분할 화면: another pane hears the microphone; this one can take it. */
        <div className="inputbox voice-elsewhere" role="region" aria-label="음성 모드">
          <span className="voice-meter on" aria-hidden />
          <span className="voice-state grow">
            음성 모드 · <b>{shared.targetNo || '다른'}번 칸</b>이 받는 중
          </span>
          <Button size="sm" tone="primary" icon="mic" onClick={() => splitHost()?.voiceTarget(window)}>
            여기로 받기
          </Button>
          <IconButton icon="close" label="음성 모드 끄기" onClick={() => splitHost()?.voiceEnd()} />
        </div>
      ) : (vm && vm !== 'opening') || hereShared ? (
        <VoiceMode
          key={session.id}
          sessionId={session.id}
          listen={hereShared ? shared!.listen : (vm as { listen: LiveListen }).listen}
          preview={hereShared ? shared!.preview : (vm as { preview: LivePreview | null }).preview}
          disabled={disabled}
          onSend={(t) => onSend(t, [])}
          onDraft={onDraft}
          onClose={voiceEnd}
          endRef={voiceEndNow}
          takeRef={takeShared}
          head={hereShared ? <span className="voice-pane">{shared!.targetNo}번 칸이 받는 중</span> : null}
          panes={hereShared ? (splitHost()?.count() ?? 0) : 0}
          paneNo={hereShared ? shared!.targetNo : 0}
          onRoute={hereShared ? (no, said, end) => splitHost()?.voiceRoute(no, said, end) : undefined}
          carry={hereShared ? () => splitHost()?.voiceCarry() ?? null : undefined}
        />
      ) : (
      /* One glass card: the text on top, and under it a row of 사진 · the session's chips · 보내기. */
      <div className="inputbox" onTouchStart={swipeStart} onTouchMove={swipeMove} onTouchEnd={() => (swipe.current = null)}>
        <textarea
          ref={box}
          rows={1}
          value={text}
          placeholder={disabled ?? (busy ? '끝나면 이어서 전달해요' : '메시지 보내기')}
          disabled={!!disabled}
          enterKeyHint={enterSends ? 'send' : 'enter'}
          {...NO_AUTOFILL}
          onChange={(e) => (setText(e.target.value), setPick(0), (recall.current = null))}
          onKeyDown={onKey}
          onCompositionEnd={() => {
            // Some browsers repeat the ⌘Enter once the syllable is let go (sent from onKey then); others do not.
            if (sendAfterIme.current)
              setTimeout(() => {
                if (!sendAfterIme.current) return
                sendAfterIme.current = false
                void sendNow.current()
              }, 30)
          }}
          onPaste={(e) => {
            const files = pastedImages(e.clipboardData)
            if (files.length) {
              e.preventDefault()
              void addFiles(files)
            }
          }}
          aria-label="메시지"
        />
        <div className="inputbar">
          <IconButton icon="plus" label="사진 첨부" className="glass-btn" onClick={(e) => attach(e.currentTarget)} disabled={!!disabled} />
          <input ref={file} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => (e.target.files && void addFiles(e.target.files), (e.target.value = ''))} />
          <div className="chips">{tools}</div>
          {voiceOn ? (
            <button
              type="button"
              className="icon-btn glass-btn mic-btn"
              aria-label="음성 모드"
              title={mouse && dev.key !== 'off' ? `음성 모드 (${KEY_LABEL[dev.key]})` : '음성 모드'}
              disabled={!!disabled || vm === 'opening'}
              onClick={() => void voiceStart()}
            >
              <Icon name="mic" />
            </button>
          ) : null}
          {busy && empty ? (
            <button type="button" className="send stop" aria-label="중단 (Esc)" title="중단 (Esc)" onClick={onStop}>
              <Icon name="stop" />
            </button>
          ) : (
            // The press keeps the focus in the text box, so a phone's keyboard stays up for the next message.
            <button type="button" className="send" aria-label="보내기" title={enterSends ? '보내기 (Enter · ⌘Enter)' : '보내기 (⌘Enter)'} disabled={empty || sending || !!disabled} onMouseDown={(e) => document.activeElement === box.current && e.preventDefault()} onClick={() => void send()}>
              <Icon name="send" />
            </button>
          )}
        </div>
      </div>
      )}
    </div>
  )
})
