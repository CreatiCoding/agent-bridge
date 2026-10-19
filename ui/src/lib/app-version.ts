// 앱 버전 (REQ-F-765). The iOS app appends `AgentBridge/<version> (<build>)` to its User-Agent; a browser has none.

export interface AppVersion {
  version: string
  build: string
}

export function appVersion(ua: string = navigator.userAgent): AppVersion | null {
  const m = ua.match(/AgentBridge\/([\w.?]+) \(([\w.?]+)\)/)
  return m ? { version: m[1], build: m[2] } : null
}

/** The newest build sent to TestFlight, as the server heard it from the operator's Mac (REQ-F-781). */
export interface AppBuild {
  build: number
  at: number
}

/** App Store Connect takes a while to process an upload: until then TestFlight has nothing newer to offer. */
export const APP_UPDATE_WAIT_MS = 30 * 60_000
/** "나중에" leaves that build alone on this device for a day. */
export const APP_UPDATE_SNOOZE_MS = 24 * 60 * 60_000
/** Opens the TestFlight app at this app (the web view hands a link that is not http(s) to iOS). */
export const TESTFLIGHT_URL = 'itms-beta://beta.itunes.apple.com/v1/app/6823927425'

export interface AppSnooze {
  build: number
  until: number
}

/** The build to ask the person to update to, or null: only inside the app, past the wait, and not put off for it. */
export function updateDue(app: AppVersion | null, latest: AppBuild | null | undefined, now: number, snooze: AppSnooze | null): number | null {
  const mine = Number(app?.build)
  if (!app || !Number.isSafeInteger(mine) || !latest) return null
  if (latest.build <= mine || now - latest.at < APP_UPDATE_WAIT_MS) return null
  if (snooze && snooze.build === latest.build && now < snooze.until) return null
  return latest.build
}
