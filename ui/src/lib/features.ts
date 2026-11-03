import type { Features } from './types'

/** What this server turned off in bridge.yaml (REQ-F-812). Set once from /api/me before the app renders with it;
 * an older server says nothing, which means everything is on. Read where `me` is not passed down. */
let current: Features | undefined

export function setFeatures(f: Features | undefined) {
  current = f
}

/** background is read-only: always on from 1.382 (false on a header-only server before it). */
export type Feature = 'sessionMove' | 'webpush' | 'voice' | 'preview' | 'skills' | 'slack' | 'remoteKeys' | 'reports' | 'background'

export const featureOn = (name: Feature) => current?.[name] !== false

/** A header-only server (auth.headerOnly, REQ-F-816): the QR sign-in is closed and the headless link signs in at the
 * proxy through a visible window on the Mac (REQ-F-833). An older server said so with background false. */
export const proxyLogin = () => current?.proxyLogin === true || current?.background === false

/** A permission mode this server lets people pick ("" is the Mac's own default, always allowed). */
export const modeAllowed = (mode: string) => !mode || !current?.permissionModes || current.permissionModes.includes(mode)
