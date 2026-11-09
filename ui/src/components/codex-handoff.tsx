// 실행기 전환 (REQ-F-891; before it Codex 로 이어서 작업, REQ-F-857, which started a second session): a session's work
// goes on in the other runner (Claude Code ↔ Codex) in the same session: same id, same place in the list, same
// conversation on the page, same folder of the same Mac. Nothing is asked of the runner it leaves (1.508, rule 13: it
// may have no tokens left): the Mac puts that conversation into a file and tells the new runner to read it. The person
// picks Codex's own sandbox and approval when it goes to Codex, and the Mac switches the runner (POST /switch). The
// runner it leaves keeps its conversation on the Mac: switching back resumes it.
// 한 번에 넘기기 (REQ-F-861): opened with `auto` (a conversation brought over from the Mac's list with "Codex 로"),
// the sheet switches as soon as the session is up and resting.
import { useEffect, useRef, useState } from 'react'
import { errorText } from '../lib/api'
import { openSession } from '../lib/builtin-actions'
import { codexAllowed } from '../lib/codex-mode'
import { folderPath } from '../lib/format'
import { getPref, setPref } from '../lib/local'
import { runnerOf } from '../lib/runner'
import { titleOf } from '../lib/sessions'
import { getStore, useStore } from '../lib/store'
import type { Session } from '../lib/types'
import { Button, Field, Spinner } from '../kit'
import { Sheet, toast } from '../kit/overlay'
import { CodexAllowField, CodexModeFields } from './codex-mode'
import { confirmLaunchMode } from './auto-allow-confirm'
import { act, sessionPost } from './session-menu'
import { RUNNER_NAMES, otherRunner, type SwitchRunner } from '../lib/handoff'

/**
 * Opens the sheet for a session from anywhere (its ⋯ menu, a right click on its row). `auto` switches once the
 * session rests (한 번에 넘기기).
 */
export const openHandoff = (s: Session | string, opts: { auto?: boolean } = {}) =>
  dispatchEvent(new CustomEvent('cb-handoff', { detail: { id: typeof s === 'string' ? s : s.id, auto: !!opts.auto } }))

/** The runner a session switches to: the other one. */
export const switchTarget = (s: Session): SwitchRunner => otherRunner(runnerOf(s))

/** Why a session cannot switch runner now, or null when it can (the menu item's hint). */
export function handoffBlocked(s: Session): string | null {
  const from = runnerOf(s)
  if (from !== 'claude' && from !== 'codex') return 'Claude Code·Codex 세션만'
  if (s.locked) return '잠긴 세션은 못 바꿔요'
  if (s.seat?.where === 'slack') return 'Slack 에서 작업 중'
  const host = (getStore().state?.hosts ?? []).find((h) => h.id === s.hostId)
  if (!host?.online) return '맥이 연결돼 있지 않아요'
  if (from === 'claude' && !host.runners?.some((r) => r.id === 'codex')) return '이 맥에 Codex 가 없어요 (codex·tmux 필요)'
  if (!s.state.alive) return '세션을 먼저 열어야 해요'
  return null
}

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
  const [busy, setBusy] = useState(false)
  // Switch once the session rests: after its turn (끝나면 전환, 중단하고 진행) or from a one-press move (auto).
  const [whenIdle, setWhenIdle] = useState(false)
  const from: SwitchRunner = s && runnerOf(s) === 'codex' ? 'codex' : 'claude'
  const to = otherRunner(from)
  const toCodex = to === 'codex'
  const fromName = RUNNER_NAMES[from]
  const toName = RUNNER_NAMES[to]
  const starting = useRef(false)
  // Codex's own sandbox and approval, picked here: Claude Code's permission mode does not carry over.
  const codex = host?.runners?.find((r) => r.id === 'codex')
  const [modePick, setModePick] = useState(() => getPref('handoffCodexMode', ''))
  const codexMode = codexAllowed(modePick)
  const [allowPick, setAllowPick] = useState(() => getPref('handoffCodexAllow', ''))
  const canAllow = toCodex && !!codex?.caps.includes('autoAllow')
  const codexAllow = canAllow && (allowPick === 'autoAllow' || allowPick === 'allowAll') ? allowPick : ''

  const close = () => {
    starting.current = false
    setSid(null)
    setBusy(false)
    setWhenIdle(false)
  }

  // Each opening starts over.
  const [opened, setOpened] = useState<string | null>(null)
  if (s && opened !== s.id) {
    setOpened(s.id)
    setWhenIdle(openAuto.current)
    openAuto.current = false
  }
  if (!s && opened) setOpened(null)

  const phase = s?.state.phase
  const working = phase === 'busy' || phase === 'waiting' || phase === 'starting'

  const start = async () => {
    if (!s || !host || starting.current) return
    starting.current = true
    setBusy(true)
    try {
      if (toCodex && !(await confirmLaunchMode(codexAllow))) return
      // The same session goes on in the other runner (REQ-F-891): no new session is made. The Mac hands the new
      // runner the conversation it leaves to read (rule 13).
      await sessionPost<{ ok: true; resumed?: boolean }>(s, 'switch', {
        runner: to,
        ...(toCodex ? { codexMode } : {}),
        ...(codexAllow ? { mode: codexAllow } : {}),
      })
      if (toCodex) {
        setPref('handoffCodexMode', codexMode)
        if (canAllow) setPref('handoffCodexAllow', codexAllow)
      }
      toast(`${toName} 로 바꿨어요. ${fromName} 와의 대화를 읽고 이어서 해요`)
      close()
      openSession(s.id, 'handoff')
    } catch (e) {
      // The session is untouched (or back on its runner): it can be tried again.
      toast(`${toName} 로 바꾸지 못했어요: ${errorText(e)}`, { tone: 'bad' })
    } finally {
      starting.current = false
      setBusy(false)
    }
  }

  // 끝나면 전환 / 한 번에 넘기기: the switch goes as soon as the session is up and resting.
  useEffect(() => {
    if (whenIdle && s?.state.alive && phase === 'idle' && !busy) {
      setWhenIdle(false)
      void start()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whenIdle, s?.state.alive, phase, busy])

  const stop = async () => {
    if (!s) return
    const r = await act(() => sessionPost(s, 'esc'), '멈추라고 보냈어요 (Esc)')
    if (r != null) setWhenIdle(true)
  }

  const folder = s ? folderPath(s.cwd, s.home) : ''
  return (
    <Sheet
      open={!!s}
      onClose={close}
      title={`${toName} 로 전환`}
      footer={
        <div className="dialog-buttons">
          <Button onClick={close}>취소</Button>
          <Button tone="primary" busy={busy} disabled={working || whenIdle || (toCodex && !codex)} onClick={() => void start()}>
            {toName} 로 전환
          </Button>
        </div>
      }
    >
      {s ? (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            <b>{titleOf(s)}</b> 를 {fromName} 에서 {toName} 로 바꿔 <b>이 세션에서</b> 이어서 해요. 새 세션을 만들지 않아요. {fromName} 의 대화는 맥에 남아, 다시 바꾸면 그 대화를 이어서 열어요.
          </p>
          <p className="muted">
            {fromName} 에게 요약을 시키지 않아요({fromName} 토큰이 없어도 돼요). 맥이 지금까지의 대화를 작업 폴더의 <code>SESSION-…-switch.md</code> 에 옮기고, {toName} 가 그 파일과 지금 파일 상태를 직접 읽고 이어서 해요.
          </p>
          <Field label="작업 폴더" hint="미커밋 변경과 worktree·브랜치를 그대로 두고 같은 폴더에서 이어서 해요">
            <div className="input mono" aria-label="작업 폴더">
              {folder}
            </div>
          </Field>
          {toCodex && !codex ? <p className="muted">이 맥에 Codex 가 없어요. 맥에 codex 와 tmux 를 설치하면 쓸 수 있어요.</p> : null}
          {working ? (
            <div className="note note-warn">
              <div className="grow">
                {phase === 'waiting' ? `${fromName} 가 답을 기다리고 있어요. 세션에서 답한 뒤 이어서 해요.` : `${fromName} 가 지금 작업 중이에요. 두 에이전트가 같은 파일을 함께 고치지 않게, 끝나길 기다리거나 멈춘 뒤에 바꿔요.`}
                <div className="choices">
                  {whenIdle ? (
                    <span className="hstack muted">
                      <Spinner size={12} /> 끝나면 바로 바꿔요
                    </span>
                  ) : (
                    <Button size="sm" onClick={() => setWhenIdle(true)}>
                      끝나면 전환
                    </Button>
                  )}
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
          ) : whenIdle ? (
            <div className="hstack muted" style={{ gap: 8 }}>
              <Spinner size={14} /> 세션이 준비되면 바로 바꿔요
            </div>
          ) : null}
          {toCodex ? (
            <>
              <p className="muted">Codex 의 권한은 여기서 따로 골라요. Claude Code 의 권한 모드는 옮기지 않아요.</p>
              <CodexModeFields value={codexMode} onChange={setModePick} />
              {canAllow ? <CodexAllowField value={codexAllow} onChange={setAllowPick} /> : null}
            </>
          ) : (
            <p className="muted">Claude Code 는 이 세션에서 예전에 쓰던 모델·권한 모드로 다시 떠요. 처음이면 기본값이에요.</p>
          )}
        </>
      ) : null}
    </Sheet>
  )
}
