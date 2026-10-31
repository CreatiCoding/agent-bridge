// The published extension types (extensions/agent-bridge-ext.d.ts) are checked here against what the page really
// has: typecheck fails when the two drift apart. Nothing imports this file.
import type * as Pub from '../../../extensions/agent-bridge-ext'
import type { ComposerCtx } from '../components/composer'
import type { SessionMenuCtx } from '../components/session-menu'
import type { ActionMap } from './actions'
import type { Bridge } from './ext-host'
import type { SettingsTab } from './router'
import type { Shortcut, ShortcutCtx } from './shortcuts'
import type { SlotName } from './slots'
import type { Phase, Session } from './types'

// The bridge object has every published part, of a fitting shape (function arguments compared strictly).
export const fits = (b: Bridge): Published => b
type Published = Pub.Bridge

// What the generic signatures above compare loosely is held equal one by one.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Holds<T extends true> = T
export type Checks = [
  Holds<Same<Pub.ActionMap, ActionMap>>,
  Holds<Same<Pub.SlotName, SlotName>>,
  Holds<Same<Pub.ComposerCtx, ComposerCtx>>,
  Holds<Same<Pub.Phase, Phase>>,
  Holds<Same<Pub.SettingsTab, SettingsTab>>,
  Holds<Same<Pub.Shortcut, Shortcut>>,
  Holds<Same<Pub.ShortcutCtx, ShortcutCtx>>,
  // The page's Session and menu context have more than is published: the published part must be there.
  Holds<Session extends Pub.Session ? true : false>,
  Holds<SessionMenuCtx extends Pub.SessionMenuCtx ? true : false>,
]
