// Codex 로 이어서 작업 (REQ-F-857): a Claude Code session's work goes on in a new Codex session in the same folder of
// the same Mac. The Claude session writes the hand-over summary (it knows the whole conversation, compacted parts
// too); the person reads and edits it, picks Codex's own sandbox and approval, and the Codex session starts with the
// summary as its first message. The Claude conversation stays as it is, and the two sessions link each other.
// 한 번에 넘기기 (REQ-F-861): opened with `auto` (a conversation brought over from the Mac's list with "Codex 로"),
// the sheet asks for the summary as soon as the session rests and starts the Codex session as soon as a handoff
// block comes back, so the whole move is one press. The person can still turn that off and read the summary first.
import { useEffect, useRef, useState } from 'react'
import { errorText, get } from '../lib/api'
import { isCancel, dispatch } from '../lib/actions'
import { openSession, sendMessage } from '../lib/builtin-actions'
import { codexAllowed } from '../lib/codex-mode'
import { folderPath } from '../lib/format'
import { getPref, setPref } from '../lib/local'
import { runnerOf } from '../lib/runner'
import { titleOf } from '../lib/sessions'
import { getStore, useStore } from '../lib/store'
import type { EventsPage, Ev, Session } from '../lib/types'
import { Button, Field, Spinner, Switch } from '../kit'
import { Sheet, toast } from '../kit/overlay'
import { CodexAllowField, CodexModeFields } from './codex-mode'
import { confirmLaunchMode } from './auto-allow-confirm'
import { act, sessionPost } from './session-menu'
import { HANDOFF_ASK, HANDOFF_HEAD, summaryAfterAsk } from '../lib/handoff'

/**
 * Opens the sheet for a session from anywhere (its ⋯ menu). `auto` asks for the summary once the session rests and
 * starts Codex when it comes (한 번에 넘기기); without it the person's last choice of the switch decides the start.
 */
export const openHandoff = (s: Session | string, opts: { auto?: boolean } = {}) =>
  dispatchEvent(new CustomEvent('cb-handoff', { detail: { id: typeof s === 'string' ? s : s.id, auto: !!opts.auto } }))

/** Why a session cannot be handed to Codex now, or null when it can (the menu item's hint). */
export function handoffBlocked(s: Session): string | null {
  if (runnerOf(s) !== 'claude') return 'Claude Code 세션만'
  if (s.locked) return '잠긴 세션은 못 넘겨요'
  if (s.seat?.where === 'slack') return 'Slack 에서 작업 중'
  const host = (getStore().state?.hosts ?? []).find((h) => h.id === s.hostId)
  if (!host?.online) return '맥이 연결돼 있지 않아요'
  if (!host.runners?.some((r) => r.id === 'codex')) return '이 맥에 Codex 가 없어요 (codex·tmux 필요)'
  if (!s.state.alive) return '세션을 먼저 열어야 해요'
  return null
}

/** How long the sheet waits for the summary. */
const ASK_MS = 15 * 60_000
const POLL_MS = 2000
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)

/** All the events after `after`, page by page. */
async function eventsAfter(sid: string, after: number) {
  const out: Ev[] = []
  let last = after
  for (let i = 0; i < 20; i++) {
    const p = await get<EventsPage>(`/api/sessions/${sid}/events?after=${last}`)
    out.push(...p.events)
    last = p.events.at(-1)?.seq ?? last
    if (!p.more) break
  }
  return out
}

type Step = 'ready' | 'asking' | 'edit'

export function HandoffSheet() {
  const [sid, setSid] = useState<string | null>(null)
  // Whether this opening was asked to go all the way by itself (read when the opening starts over below).
  const openAuto = useRef(false)
  useEffect(() => {
    const f = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; auto: boolean }>).detail
      openAuto.current = d.auto
      setSid(d.id)
    }
    addEventListener('cb-handoff', f)
    return () => removeEventListener('cb-handoff', f)
  }, [])
  const s = useStore((st) => (sid ? st.state?.sessions.find((x) => x.id === sid) : undefined))
  const host = useStore((st) => (s ? st.state?.hosts.find((h) => h.id === s.hostId) : undefined))
  const [step, setStep] = useState<Step>('ready')
  const [summary, setSummary] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Start the summary once Claude is done with what it is doing (끝나면 요약 만들기, 중단하고 진행).
  const [afterTurn, setAfterTurn] = useState(false)
  // 한 번에 넘기기: start Codex as soon as a handoff block comes back (auto), ask once the session rests (autoAsk),
  // and the start itself, run on the render after the summary is in (autoGo).
  const [auto, setAuto] = useState(false)
  const autoRef = useRef(false)
  autoRef.current = auto
  const [autoAsk, setAutoAsk] = useState(false)
  const [autoGo, setAutoGo] = useState(false)
  // One key per opening: a second press, or a retry after a lost answer, gets the same Codex session (REQ-F-857).
  const key = useRef('')
  const asking = useRef(0)
  const starting = useRef(false)
  // Codex's own sandbox and approval, picked here: Claude Code's permission mode does not carry over.
  const codex = host?.runners?.find((r) => r.id === 'codex')
  const [modePick, setModePick] = useState(() => getPref('handoffCodexMode', ''))
  const codexMode = codexAllowed(modePick)
  const [allowPick, setAllowPick] = useState(() => getPref('handoffCodexAllow', ''))
  const canAllow = !!codex?.caps.includes('autoAllow')
  const codexAllow = canAllow && (allowPick === 'autoAllow' || allowPick === 'allowAll') ? allowPick : ''

  const close = () => {
    asking.current += 1
    starting.current = false
    setSid(null)
    setBusy(false)
    setAfterTurn(false)
    setAutoAsk(false)
    setAutoGo(false)
  }

  // Each opening starts over, with the summary already written for this sheet if the conversation has one.
  const [opened, setOpened] = useState<string | null>(null)
  if (s && opened !== s.id) {
    setOpened(s.id)
    key.current = newKey()
    setStep('ready')
    setSummary('')
    setNote(null)
    setAfterTurn(false)
    const all = openAuto.current
    openAuto.current = false
    const on = all || getPref<boolean>('handoffAuto', false) === true
    setAuto(on)
    autoRef.current = on
    // The switch left on from the ⋯ menu goes all the way too: it asks as soon as the session rests.
    setAutoAsk(on)
    setAutoGo(false)
  }
  if (!s && opened) setOpened(null)
  useEffect(() => {
    // A one-press move always asks afresh: an older summary may miss what was done in the terminal since.
    if (!opened || autoAsk) return
    const n = asking.current
    get<EventsPage>(`/api/sessions/${opened}/events`).then(
      (p) => {
        const r = summaryAfterAsk(p.events)
        if (n === asking.current && r.summary && r.last && r.block) {
          setSummary(r.summary)
          setNote('이 세션이 최근에 쓴 인계 요약을 불러왔어요. 그사이 작업이 더 있었으면 다시 만들어 주세요.')
          setStep('edit')
        }
      },
      () => {},
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened])

  const phase = s?.state.phase
  const working = phase === 'busy' || phase === 'waiting' || phase === 'starting'

  const ask = async () => {
    if (!s) return
    const n = ++asking.current
    setStep('asking')
    setNote(null)
    try {
      const base = (await get<EventsPage>(`/api/sessions/${s.id}/events?after=1000000000000000`)).last
      const r = await sendMessage(s.id, HANDOFF_ASK)
      if (isCancel(r)) return n === asking.current && setStep('ready')
      const until = Date.now() + ASK_MS
      let seen: Ev[] = []
      // An answer without a block counts only once the session has rested with nothing new for two reads: the turn's
      // end may come before its last words are read.
      let still = 0
      while (n === asking.current && Date.now() < until) {
        await new Promise((ok) => setTimeout(ok, POLL_MS))
        if (n !== asking.current) return
        const more = await eventsAfter(s.id, seen.at(-1)?.seq ?? base)
        seen = [...seen, ...more]
        const got = summaryAfterAsk(seen)
        const now = getStore().state?.sessions.find((x) => x.id === s.id)?.state.phase
        still = now === 'idle' && !more.length ? still + 1 : 0
        if (got.asked && got.summary && now === 'idle' && (got.block || still >= 2)) {
          setSummary(got.summary)
          setStep('edit')
          // Only a real handoff block starts Codex by itself; plain last words are shown to read first.
          if (autoRef.current && got.block) setAutoGo(true)
          else if (autoRef.current) setNote('요약이 정해진 모양이 아니라 바로 시작하지 않았어요. 읽어 보고 시작해 주세요.')
          return
        }
      }
      if (n === asking.current) {
        setStep('ready')
        toast('요약을 받지 못했어요. 다시 만들거나 직접 써 주세요', { tone: 'bad' })
      }
    } catch (e) {
      if (n === asking.current) {
        setStep('ready')
        toast(`요약을 만들지 못했어요: ${errorText(e)}`, { tone: 'bad' })
      }
    }
  }

  // 끝나면 요약 만들기: asked as soon as the turn is over.
  useEffect(() => {
    if (afterTurn && s && phase === 'idle' && step === 'ready') {
      setAfterTurn(false)
      // One request only: a pending one-press ask is the same request.
      setAutoAsk(false)
      void ask()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [afterTurn, phase, step])

  // 한 번에 넘기기: the summary is asked once the session is up and resting (a conversation just brought over is
  // still starting).
  useEffect(() => {
    if (autoAsk && !afterTurn && s?.state.alive && phase === 'idle' && step === 'ready') {
      setAutoAsk(false)
      void ask()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAsk, afterTurn, s?.state.alive, phase, step])

  const stop = async () => {
    if (!s) return
    const r = await act(() => sessionPost(s, 'esc'), '멈추라고 보냈어요 (Esc)')
    // A pending one-press ask already waits for the rest.
    if (r != null && !autoAsk) setAfterTurn(true)
  }

  const start = async () => {
    if (!s || !host || starting.current) return
    const text = summary.trim()
    if (!text) return toast('넘길 요약이 비어 있어요', { tone: 'bad' })
    starting.current = true
    setBusy(true)
    try {
      if (!(await confirmLaunchMode(codexAllow))) return
      const r = await dispatch('session.create', {
        hostId: host.id,
        cwd: s.cwd,
        prompt: `${HANDOFF_HEAD}\n\n${text}`,
        runner: 'codex',
        model: '',
        effort: '',
        mode: codexAllow,
        ...(codexMode ? { codexMode } : {}),
        create: false,
        handoffFrom: s.id,
        handoffKey: key.current,
      })
      if (isCancel(r)) return
      setPref('handoffCodexMode', codexMode)
      if (canAllow) setPref('handoffCodexAllow', codexAllow)
      toast('Codex 세션을 띄웠어요. Claude 세션은 그대로 남아요')
      close()
      openSession(r.sid, 'handoff')
    } catch (e) {
      // The Claude session is untouched; the summary stays here to try again.
      toast(`Codex 세션을 시작하지 못했어요: ${errorText(e)}`, { tone: 'bad' })
    } finally {
      starting.current = false
      setBusy(false)
    }
  }

  // ...and Codex starts on the render that has the summary, with the sandbox and approval shown in the sheet now.
  useEffect(() => {
    if (autoGo && step === 'edit') {
      setAutoGo(false)
      if (autoRef.current && !working) void start()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoGo, step])

  const pickAuto = (on: boolean) => {
    setAuto(on)
    // Off also stops the ask still waiting for the session: the person reads and asks themselves.
    if (!on) setAutoAsk(false)
    setPref('handoffAuto', on)
  }

  const modeFields = (
    <>
      <p className="muted">Codex 의 권한은 여기서 따로 골라요. Claude 세션의 권한 모드는 옮기지 않아요.</p>
      <CodexModeFields value={codexMode} onChange={setModePick} />
      {canAllow ? <CodexAllowField value={codexAllow} onChange={setAllowPick} /> : null}
    </>
  )

  const folder = s ? folderPath(s.cwd, s.home) : ''
  return (
    <Sheet
      open={!!s}
      onClose={close}
      title="Codex 로 이어서 작업"
      footer={
        <div className="dialog-buttons">
          <Button onClick={close}>취소</Button>
          {step === 'edit' ? (
            <Button tone="primary" busy={busy} disabled={!summary.trim() || working || !codex} onClick={() => void start()}>
              Codex 세션 시작
            </Button>
          ) : step === 'ready' ? (
            <Button tone="primary" disabled={working || !codex} onClick={() => void ask()}>
              요약 만들기
            </Button>
          ) : null}
        </div>
      }
    >
      {s ? (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            <b>{titleOf(s)}</b> 의 작업을 같은 맥·같은 폴더의 새 Codex 세션이 이어받아요. Claude 대화는 그대로 남고, 두 세션에 서로 여는 링크가 남아요.
          </p>
          <Field label="작업 폴더" hint="미커밋 변경과 worktree·브랜치를 그대로 두고 같은 폴더에서 이어서 해요">
            <div className="input mono" aria-label="작업 폴더">
              {folder}
            </div>
          </Field>
          {!codex ? <p className="muted">이 맥에 Codex 가 없어요. 맥에 codex 와 tmux 를 설치하면 쓸 수 있어요.</p> : null}
          {working && step !== 'asking' ? (
            <div className="note note-warn">
              <div className="grow">
                {phase === 'waiting' ? 'Claude 가 답을 기다리고 있어요. 세션에서 답한 뒤 이어서 해요.' : 'Claude 가 지금 작업 중이에요. 두 에이전트가 같은 파일을 함께 고치지 않게, 끝나길 기다리거나 멈춘 뒤에 넘겨요.'}
                <div className="choices">
                  {autoAsk ? (
                    <span className="hstack muted">
                      <Spinner size={12} /> 준비되면 요약을 만들어요
                    </span>
                  ) : afterTurn ? (
                    <span className="hstack muted">
                      <Spinner size={12} /> 끝나면 요약을 만들어요
                    </span>
                  ) : step === 'ready' ? (
                    <Button size="sm" onClick={() => setAfterTurn(true)}>
                      끝나면 요약 만들기
                    </Button>
                  ) : null}
                  {phase === 'busy' ? (
                    <Button size="sm" tone="danger" onClick={() => void stop()}>
                      중단하고 진행
                    </Button>
                  ) : null}
                  {phase === 'waiting' ? (
                    <Button size="sm" onClick={() => (close(), openSession(s.id, 'handoff'))}>
                      세션 열기
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
          {step !== 'edit' ? (
            <Switch label="요약이 오면 바로 Codex 세션 시작" checked={auto} onChange={pickAuto} />
          ) : null}
          {step === 'ready' && autoAsk ? (
            <p className="muted">세션이 준비되면 요약을 만들고, 요약이 오면 아래 권한으로 바로 Codex 세션을 시작해요.</p>
          ) : null}
          {step === 'ready' && !autoAsk ? (
            <p className="muted">
              "요약 만들기"를 누르면 Claude 에게 목표·요구사항·결정 사항·변경 파일·검증 결과·남은 작업을 정리해 달라고 이 대화에 보내요. 받은 요약은 보내기 전에 고칠 수 있어요.{' '}
              <Button size="sm" tone="ghost" onClick={() => (setSummary(''), setStep('edit'))}>
                직접 쓰기
              </Button>
            </p>
          ) : null}
          {step === 'asking' ? (
            <div className="hstack muted" style={{ gap: 8 }}>
              <Spinner size={14} /> Claude 가 인계 요약을 쓰는 중이에요. 이 창을 닫아도 대화에는 남아요.
              {phase === 'waiting' ? ' 권한을 묻고 있어요: 세션에서 답해 주세요.' : ''}
            </div>
          ) : null}
          {step !== 'edit' && auto ? modeFields : null}
          {step === 'edit' ? (
            <>
              {note ? <p className="muted">{note}</p> : null}
              <Field label="넘길 요약" hint="Codex 세션의 첫 메시지가 돼요. 고쳐서 보내도 돼요">
                <textarea className="input" rows={14} value={summary} onChange={(e) => setSummary(e.target.value)} aria-label="넘길 요약" />
              </Field>
              <div className="hstack" style={{ gap: 8, marginTop: -8, marginBottom: 8 }}>
                <Button size="sm" tone="ghost" icon="refresh" disabled={working || busy} onClick={() => void ask()}>
                  요약 다시 만들기
                </Button>
              </div>
              {modeFields}
            </>
          ) : null}
        </>
      ) : null}
    </Sheet>
  )
}
