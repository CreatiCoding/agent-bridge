import type { Features } from './types'

/** What this server turned off in bridge.yaml (REQ-F-812). Set once from /api/me before the app renders with it;
 * an older server says nothing, which means everything is on. Read where `me` is not passed down. */
let current: Features | undefined

export function setFeatures(f: Features | undefined) {
  current = f
}

/** background is read-only: false on a header-only server (auth.headerOnly, REQ-F-816), where the headless browser
 * cannot pass the proxy and the QR sign-in is closed. */
export type Feature = 'sessionMove' | 'webpush' | 'voice' | 'preview' | 'skills' | 'slack' | 'remoteKeys' | 'background'

export const featureOn = (name: Feature) => current?.[name] !== false

/** A permission mode this server lets people pick ("" is the Mac's own default, always allowed). */
export const modeAllowed = (mode: string) => !mode || !current?.permissionModes || current.permissionModes.includes(mode)
