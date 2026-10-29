import type { Features } from './types'

/** What this server turned off in bridge.yaml (REQ-F-812). Set once from /api/me before the app renders with it;
 * an older server says nothing, which means everything is on. Read where `me` is not passed down. */
let current: Features | undefined

export function setFeatures(f: Features | undefined) {
  current = f
}

export type Feature = 'sessionMove' | 'webpush' | 'voice' | 'preview' | 'skills' | 'slack' | 'remoteKeys'

export const featureOn = (name: Feature) => current?.[name] !== false

/** A permission mode this server lets people pick ("" is the Mac's own default, always allowed). */
export const modeAllowed = (mode: string) => !mode || !current?.permissionModes || current.permissionModes.includes(mode)
