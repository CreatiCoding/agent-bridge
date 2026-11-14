// The iOS app's half of 대화 모드 (REQ-F-912, REQ-F-913), in one place: whether the page runs inside the app, the
// audio session it asks WebKit for, and the state it tells the app for the Dynamic Island. A browser has none of it.

/** Inside the iOS app: its User-Agent names it (REQ-F-765, the same mark app-version reads). */
export const inIosApp = () => typeof navigator === 'object' && / AgentBridge\/[\w.?]+ \(/.test(navigator.userAgent ?? '')

/**
 * 앱에서 백그라운드 대화 (REQ-F-912): WebKit stops a page's AudioContext once the page is hidden, unless the page
 * asked for a `playback` or `play-and-record` audio session (AudioContext::shouldOverrideBackgroundPlaybackRestriction).
 * Asked only inside the app, which has the `audio` background mode: in Safari or a home-screen app the page stops when
 * put away all the same, and the type could change where the sound goes (earphones) for nothing. Returns how to put
 * back what it was.
 */
export function holdAudioSession(): () => void {
  const s = (navigator as unknown as { audioSession?: { type: string } }).audioSession
  if (!inIosApp() || !s || typeof s.type !== 'string') return () => {}
  const was = s.type
  try {
    s.type = 'play-and-record'
  } catch {
    return () => {}
  }
  return () => {
    try {
      s.type = was
    } catch {}
  }
}

/** 다이내믹 아일랜드 (REQ-F-913): what 대화 모드 is doing now. */
export type TalkPhase = 'listening' | 'speaking' | 'thinking'
type TalkMsg = { op: 'start' | 'update'; phase: TalkPhase; title: string } | { op: 'end' }
type TalkBridge = { webkit?: { messageHandlers?: { talk?: { postMessage(m: TalkMsg): void } } } }

/** Tells the app (the Live Activity); nothing outside it. */
export function tellTalk(m: TalkMsg, w: unknown = globalThis) {
  try {
    ;(w as TalkBridge).webkit?.messageHandlers?.talk?.postMessage(m)
  } catch {}
}
