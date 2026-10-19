// Safari로 열기 (REQ-F-755). An iPhone home-screen app asks for the microphone again every time it is opened, and
// has no setting to keep it (Safari's per-site 허용 does not reach it). Safari itself keeps that 허용, so the app
// offers to open the same page there. `x-safari-https:` is iOS's own scheme for "open this in Safari".

const nav = navigator as Navigator & { standalone?: boolean }

/** An iPad: its Safari and the iOS app say "Macintosh", so a Mac with a touch screen is one. */
export const isIPad = () => /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)

/** True in an iPhone/iPad home-screen app, where the link is any use. */
export function inHomeApp(): boolean {
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  return ios && (matchMedia('(display-mode: standalone)').matches || nav.standalone === true)
}

/** This page, opened in Safari. */
export function safariHref(): string {
  return `x-safari-${location.href}`
}
