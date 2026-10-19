// 분할 화면 (REQ-F-786): up to three sessions side by side, each in its own frame of this same page at a phone's
// width, so every pane is the phone screen as it is (its own list, sheets and input) without a second layout.
// The page holding the panes puts `cbSplit` on its window; a page inside a pane reaches it through window.parent
// (same origin), which is also how a page knows it is a pane.
import { useEffect, useState } from 'react'
import { confirmDialog, promptDialog, toast, type MenuItem } from '../kit/overlay'
import { errorText, post } from './api'
import { navigate } from './router'
import { titleOf } from './sessions'
import { getStore } from './store'
import type { SplitPreset } from './types'
import type { LiveListen, LivePreview } from './voice'
import type { VoiceEnd } from './voice-commands'

export const SPLIT_MAX = 3
/** The narrowest a pane gets before the panes scroll sideways instead. */
export const PANE_MIN = 340

/**
 * 음성 모드 across the panes (REQ-F-788): one microphone, opened by the pane it was turned on in, heard into one pane
 * at a time (the target). Every pane shows that 음성 모드 is on; the others offer to take it over.
 */
export interface SplitVoice {
  listen: LiveListen
  preview: LivePreview | null
  /** The pane whose page opened the microphone (its sound stops when that frame goes). */
  owner: Window
  /** The pane the words go into. */
  target: Window
  /** 1-based, for "2번 칸이 받는 중". */
  targetNo: number
}

/** What the page holding the panes offers the pages inside them. */
export interface SplitHost {
  count: () => number
  add: () => void
  close: (w: Window) => void
  full: (w: Window) => void
  moved: (w: Window, path: string) => void
  voice: () => SplitVoice | null
  /** The microphone just opened in this pane: every pane learns, and this one hears. */
  voiceStart: (w: Window, listen: LiveListen, preview: LivePreview | null) => void
  /** Hear into this pane from now on; the one hearing before hands over what it gathered first. */
  voiceTarget: (w: Window) => void
  /** A phrase that named pane `no` (1-based) by voice: that pane hears from now on and takes the phrase (REQ-F-789). */
  voiceRoute: (no: number, text: string, end: VoiceEnd | null) => void
  /** Taken once by the pane that was named: the phrase, and what it ended with. */
  voiceCarry: () => { text: string; end: VoiceEnd | null } | null
  voiceEnd: () => void
}

function host(): SplitHost | null {
  try {
    return window.parent !== window ? ((window.parent as unknown as { cbSplit?: SplitHost }).cbSplit ?? null) : null
  } catch {
    return null
  }
}

/** This page is drawn inside a pane: it leaves to the page around it what is said once for the whole screen. */
export const inPane = !!host()
export const splitHost = host

/** How many panes this window has room for (a phone: 1, an iPad standing: 2, an iPad lying or a PC: 3). */
export const splitRoom = () => Math.max(1, Math.min(SPLIT_MAX, Math.floor(innerWidth / PANE_MIN)))

export const splitUrl = (ids: string[]) => `/split?s=${ids.join(',')}`

/** Asks the person for a session, leaving out the ones given (the session picker, mounted once in the app). */
export function pickSession(exclude: string[]): Promise<string | null> {
  return new Promise((resolve) => dispatchEvent(new CustomEvent('cb-split-pick', { detail: { exclude, resolve } })))
}

/** 음성 모드 across the panes as it is now, for a page inside a pane; null when it is off or this is not a pane. */
export function useSplitVoice(): SplitVoice | null {
  const [, redraw] = useState(0)
  useEffect(() => {
    if (!inPane) return
    const f = () => redraw((n) => n + 1)
    addEventListener('cb-split-voice', f)
    return () => removeEventListener('cb-split-voice', f)
  }, [])
  return inPane ? (host()?.voice() ?? null) : null
}

/** 분할로 띄우기 from a session's ⋯ menu: the session and one the person picks, side by side. */
export async function startSplit(id: string) {
  const other = await pickSession([id])
  if (other) navigate(splitUrl([id, other]))
}

// 분할 조합 (REQ-F-790): a set of panes saved by name, kept with the account so every device has it.

/** The sessions of a saved set that can still be opened (a session that ended or went is left out). */
export function presetLive(p: SplitPreset): string[] {
  const live = new Set((getStore().state?.sessions ?? []).filter((s) => !s.closed).map((s) => s.id))
  return p.ids.filter((id) => live.has(id))
}

/** The saved set that is exactly these panes, in this order. */
export const presetOf = (presets: SplitPreset[], ids: string[]) => presets.find((p) => p.ids.join(',') === ids.join(','))

/** Opens a saved set: through the address, or by `apply` from 분할 화면 itself (its panes are drawn from the address once). */
export function openPreset(p: SplitPreset, apply: (ids: string[]) => void = (ids) => navigate(splitUrl(ids))) {
  const ids = presetLive(p)
  if (ids.length < 2) return void toast(`'${p.name}' 에 열 수 있는 세션이 ${ids.length ? '하나뿐' : '없어'}요`, { tone: 'bad' })
  if (ids.length < p.ids.length) toast(`끝난 세션 ${p.ids.length - ids.length}개는 빼고 열었어요`)
  apply(ids)
}

async function savePreset(body: { id?: string; name: string; ids: string[] }) {
  try {
    await post('/api/prefs/splits', { op: 'save', ...body })
    return true
  } catch (e) {
    toast(errorText(e), { tone: 'bad' })
    return false
  }
}

/** 조합 저장: asks a name (the sessions' titles to start with) and keeps these panes under it. */
export async function savePresetAs(ids: string[]) {
  const byId = new Map((getStore().state?.sessions ?? []).map((s) => [s.id, s]))
  const value = ids.map((id) => { const s = byId.get(id); return s ? titleOf(s) : '' }).filter(Boolean).join(' · ').slice(0, 40)
  const name = (await promptDialog('조합 이름', { value, placeholder: '예: 백엔드 작업', ok: '저장' }))?.trim()
  if (name && (await savePreset({ name, ids }))) toast(`'${name}' 조합을 저장했어요`)
}

/** 이름 바꾸기 · 지우기 for one saved set. */
export function presetActions(p: SplitPreset): MenuItem[] {
  const all = getStore().state?.splits ?? []
  const at = all.findIndex((x) => x.id === p.id)
  const move = (by: -1 | 1) => () => void post('/api/prefs/splits', { op: 'move', id: p.id, by }).catch((e) => toast(errorText(e), { tone: 'bad' }))
  return [
    ...(all.length > 1
      ? [
          { label: '위로 옮기기', icon: 'arrowUp', disabled: at <= 0, onSelect: move(-1) },
          { label: '아래로 옮기기', icon: 'arrowDown', disabled: at < 0 || at >= all.length - 1, onSelect: move(1) },
        ]
      : []),
    {
      label: '이름 바꾸기',
      icon: 'edit',
      onSelect: async () => {
        const name = (await promptDialog('조합 이름', { value: p.name, ok: '바꾸기' }))?.trim()
        if (name && name !== p.name) await savePreset({ id: p.id, name, ids: p.ids })
      },
    },
    {
      label: '지우기',
      icon: 'trash',
      danger: true,
      onSelect: async () => {
        if (!(await confirmDialog(`'${p.name}' 조합을 지울까요?`, { text: '세션은 그대로 있어요.', ok: '지우기', danger: true }))) return
        await post('/api/prefs/splits', { op: 'remove', id: p.id }).catch((e) => toast(errorText(e), { tone: 'bad' }))
      },
    },
  ]
}
