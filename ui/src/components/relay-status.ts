// On a Mac with an agent, any open page of the site links that Mac to the server (web/relay.js). This page
// does it in the background, waiting in line behind another tab that already does, and shows how it goes.
import { useSyncExternalStore } from 'react'
import { agentInfo, startRelay } from '../../../web/relay.js'

export interface RelayState {
  agent: 'on' | 'wait' | 'off'
  server: 'on' | 'wait' | 'off'
  name: string
  text: string
  /** The headless browser links this Mac (헤드리스 연동 모드): this tab stood down and there is nothing to show. */
  headless?: boolean
}

let state: RelayState | null = null
const subs = new Set<() => void>()
const set = (p: Partial<RelayState>) => {
  state = { ...(state as RelayState), ...p }
  subs.forEach((f) => f())
}

let started = false
export function startBackgroundRelay() {
  if (started || !agentInfo()) return
  started = true
  state = { agent: 'wait', server: 'wait', name: '', text: '' }
  startRelay(
    {
      link: (which: 'agent' | 'server', st: 'on' | 'wait' | 'off', text: string) => set(which === 'agent' ? { agent: st, text } : { server: st }),
      hello: (msg: { name?: string }) => set({ name: msg.name ?? '' }),
      login: () => location.reload(),
      stood: (_text: string, _offer: boolean, headless: boolean) => set({ headless }),
    },
    { persistent: true },
  )
}

export const useRelay = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => state,
  )
