// agent-bridge extension API, extensionApi 1 (docs/SPEC.md "익스텐션 공개 API").
// What is here is the public API: an extension may count on it until extensionApi goes up. Anything else on the
// page (DOM, CSS classes, globals, other kit exports, other Session fields) can change at any time.
// The page checks that its bridge object fits these types (ui/src/lib/ext-api-check.ts).
import type * as ReactNS from 'react'
import type { ButtonHTMLAttributes, ComponentType, ReactNode, RefAttributes } from 'react'

// ---------- what the page knows ----------

export type Phase = 'starting' | 'idle' | 'busy' | 'waiting' | 'ended'

/** A session as the page has it. Only these fields are public. */
export interface Session {
  id: string
  hostId: string
  title: string
  cwd: string
  closed: boolean
  favorite?: boolean
  lastAt: number
  state: { phase: Phase }
}

export interface User {
  uid: string
  login: string
  provider: string
  admin: boolean
}

export type SettingsTab = 'launch' | 'prompt' | 'accounts' | 'device' | 'plugins' | 'voice' | 'admin' | 'changes' | 'more'

/** What the page is showing: route is 'session' on a session's page (then sid), else another page's name. */
export interface Current {
  route: string
  sid?: string
}

// ---------- actions (§6) ----------

export interface ActionMap {
  /** The send button, Enter, ⌘Enter. sent false when nothing went (reason: 'empty', 'busy', 'no-composer' …). */
  'composer.submit': { args: { sid: string; text?: string }; result: { sent: boolean; reason?: string } }
  'message.send': {
    args: { sid: string; text: string; kind: 'text' | 'command'; images: { data: string; name: string }[]; videos: { id: string; name: string }[] }
    result: unknown
  }
  'permission.answer': {
    args: {
      sid: string
      /** False for a card the page does not know the kind of. */
      known: boolean
      card: { id: string; kind?: string; title?: string; tool?: { name: string; input?: unknown } | null }
      option: { n: number | 'esc' | 'enter'; label: string; kind: string }
    }
    result: unknown
  }
  'session.open': { args: { sid: string; from: string; replace?: boolean }; result: void }
  'session.create': { args: { hostId: string; [k: string]: unknown }; result: { sid: string } }
  'session.close': { args: { sid: string; kind: 'end' | 'remove' | 'trash' }; result: unknown }
  'link.open': { args: { url: string; from: string; target?: '_self' }; result: unknown }
  'clipboard.copy': { args: { text: string; kind: 'code' | 'message' | 'link' | 'other' }; result: unknown }
  /** A fenced block in an answer; around only. Return what to draw, or next(args). */
  'renderer.block': { args: { lang: string; text: string; closed: boolean; isLast: boolean; sid?: string }; result: unknown }
  'notify.show': { args: { text: string; sid?: string }; result: void }
}
export type ActionName = keyof ActionMap
export type Args<N extends ActionName> = ActionMap[N]['args']
export type Result<N extends ActionName> = ActionMap[N]['result']
/** Returned by a before (or an around instead of calling next) to stop the action; the reason is shown. */
export type Cancel = { cancel: string }
/** Actions that run inside a press or a render: their handlers must not wait (a Promise from before is ignored). */
export type SyncAction = 'session.open' | 'link.open' | 'clipboard.copy' | 'renderer.block' | 'notify.show'

export interface Ctx {
  /** Dispatch again, skipping this handler. */
  dispatch: <N extends ActionName>(name: N, args: Args<N>) => unknown
  /** Wraps a wait for the person (a confirm, a sheet): the time limit stops meanwhile. */
  waitUser: <T>(p: Promise<T>) => Promise<T>
}

export interface HookOpts {
  /** Bigger is further out; 0 by default. The page's own html preview sits at -1000. */
  priority?: number
  /** How long a before/around of an async action may take before next(): 500 ms by default, 10 s at most. */
  timeoutMs?: number
}

export type BeforeFn<N extends ActionName> = (args: Args<N>, ctx: Ctx) => Args<N> | Cancel | void | Promise<Args<N> | Cancel | void>
export type AfterFn<N extends ActionName> = (args: Args<N>, result: Result<N>, ctx: Ctx) => void
export type AroundFn<N extends ActionName> = (args: Args<N>, next: (args: Args<N>) => unknown, ctx: Ctx) => unknown

// ---------- events (§10) ----------

export interface EventSession {
  id: string
  /** The Mac's name. */
  host: string
  hostId: string
  cwd: string
  title: string
}
interface EventBase {
  /** The same when sent again: claim with it. */
  id: string
  at: number
  user: { uid: string; login: string }
  /** The session's page, or the site. */
  url: string
}
export interface SessionDone extends EventBase {
  name: 'session.done'
  session: EventSession
}
export interface DecisionWaiting extends EventBase {
  name: 'decision.waiting'
  session: EventSession
  card: { id: string; kind: string; title: string; tool?: { name: string; input?: unknown }; options: { n: number; label: string; kind: string }[] }
}
export interface DecisionAnswered extends EventBase {
  name: 'decision.answered'
  session: EventSession
  card: { id: string }
  n: number | 'esc' | 'enter' | null
  via: 'card' | 'message' | 'auto' | 'terminal'
  by: string | null
}
export interface EventMap {
  'session.done': SessionDone
  'decision.waiting': DecisionWaiting
  'decision.answered': DecisionAnswered
}
export type EventName = keyof EventMap

// ---------- slots (§7) ----------

export interface ComposerCtx {
  sid: string
  text: string
  attachments: { kind: 'image' | 'video'; name: string; pct?: number }[]
  sending: boolean
  busy: boolean
  disabled: boolean
  setText: (text: string) => void
  addAttachment: (file: File) => void
  clear: () => void
  focus: () => void
}

export interface SessionMenuCtx {
  sid: string
  session: Session
  closed: boolean
  alive: boolean
  away: boolean
  hostConnected: boolean
  canMoveHost: boolean
  slackOn: boolean
  phase: Phase
  wide: boolean
  todoBlocked: string | undefined
  place: 'page' | 'list'
}

export interface SlotContexts {
  'composer.actions': ComposerCtx
  'session.menu': SessionMenuCtx
  'session-list.row.badges': { session: Session }
  'settings.section': { user: User | null; tab: SettingsTab }
}
export type SlotName = keyof SlotContexts

interface ItemBase {
  /** Unique in its slot, not one of the page's ids. */
  id: string
  /** Before or after one of the page's (or another added) items; at the end when that id is not there. */
  order?: { before?: string; after?: string }
}
/** render is drawn as a component: hooks (useSlotContext, data.shared) may be used in it. */
export interface ComposerItem extends ItemBase {
  render: () => ReactNode
  /** What it becomes in the ⋯ menu on a narrow screen (only the first added item stays out). */
  menu?: { label: string; icon?: IconName; enabled?: (ctx: ComposerCtx) => boolean; run: (ctx: ComposerCtx) => void }
}
export interface SessionMenuItem extends ItemBase {
  label?: ReactNode
  icon?: IconName
  hint?: ReactNode
  danger?: boolean
  /** A separator, or a heading. */
  sep?: boolean
  header?: ReactNode
  visible?: (ctx: SessionMenuCtx) => boolean
  checked?: (ctx: SessionMenuCtx) => boolean
  enabled?: (ctx: SessionMenuCtx) => boolean
  run?: (ctx: SessionMenuCtx) => void
  items?: SessionMenuItem[]
}
/** Up to two added badges show; the row is a link, so nothing pressable. */
export interface BadgeItem extends ItemBase {
  render: () => ReactNode
}
export interface SettingsItem extends ItemBase {
  /** The settings tab it is drawn on; 'plugins' by default. */
  tab?: SettingsTab
  render: () => ReactNode
}
export interface SlotItems {
  'composer.actions': ComposerItem
  'session.menu': SessionMenuItem
  'session-list.row.badges': BadgeItem
  'settings.section': SettingsItem
}

/** The page's own items, which order, replace and hide may name. */
export interface BuiltinIds {
  'composer.actions': 'attach' | 'chips' | 'mic' | 'send'
  'session.menu':
    | 'split' | 'split-add' | 'split-full' | 'split-leave' | 'same-group' | 'copy-path' | 'screen' | 'todos' | 'doc'
    | 'place' | 'resume' | 'rename' | 'remove'
    | 'group' | 'refresh' | 'compact' | 'fork' | 'lightfork' | 'trim-log' | 'move-host' | 'move-account' | 'move-cwd' | 'lock' | 'favorite' | 'rest' | 'log' | 'end' | 'trash'
  'session-list.row.badges': 'state' | 'slack' | 'delegated'
  'settings.section': never
}

// ---------- shortcuts ----------

export interface ShortcutCtx {
  route: string
  sid?: string
  focused: 'composer' | 'timeline' | 'other'
  /** While the box has the focus: composer.actions' context. */
  composer?: unknown
}
export interface Shortcut {
  /** Prefixed with "<extension id>." by the page. */
  id: string
  title: string
  /** "Mod+K", "Alt+Shift+H": Mod is ⌘ on a Mac and Ctrl elsewhere; letters and digits by their place. Taken keys are refused. */
  keys?: string | string[]
  when?: (ctx: ShortcutCtx) => boolean
  run?: (ctx: ShortcutCtx) => void
}

// ---------- kit ----------

/** One of kit.ICONS. */
export type IconName = string
type Tone = 'primary' | 'plain' | 'danger' | 'ghost' | 'soft'

export interface Kit {
  Button: ComponentType<ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; size?: 'sm' | 'md' | 'lg'; icon?: IconName; busy?: boolean; block?: boolean } & RefAttributes<HTMLButtonElement>>
  /** keepFocus: pressing it leaves the focus (and a phone's keyboard) in the message box. */
  IconButton: ComponentType<ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; active?: boolean; keepFocus?: boolean } & RefAttributes<HTMLButtonElement>>
  Icon: ComponentType<{ name: IconName; className?: string }>
  ICONS: readonly string[]
  Badge: ComponentType<{ tone?: 'grey' | 'blue' | 'green' | 'red' | 'amber' | 'violet'; children?: ReactNode; dot?: boolean }>
  Chip: ComponentType<{ children: ReactNode; icon?: IconName; onClick?: (e: ReactNS.MouseEvent<HTMLButtonElement>) => void; active?: boolean; tone?: 'warn' | 'ok' | 'bad' | 'merged'; title?: string }>
  Field: ComponentType<{ label?: ReactNode; hint?: ReactNode; children: ReactNode }>
  /** One line, or several with rows. */
  TextField: ComponentType<{ value: string; onChange: (v: string) => void; label?: string; placeholder?: string; rows?: number; autoFocus?: boolean; disabled?: boolean; onEnter?: () => void }>
  Row: ComponentType<{ left?: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode; onClick?: () => void; onContextMenu?: (e: ReactNS.MouseEvent) => void; active?: boolean; href?: string; className?: string; chevron?: boolean }>
  SectionHeader: ComponentType<{ title: ReactNode; right?: ReactNode; onClick?: () => void; folded?: boolean }>
  Segmented: <T extends string>(props: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) => ReactNode
  Sheet: ComponentType<{ open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; className?: string }>
  Spinner: ComponentType<{ size?: number }>
  Switch: ComponentType<{ checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }>
  Collapse: ComponentType<{ open: boolean; children: ReactNode; className?: string }>
  Empty: ComponentType<{ icon?: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode }>
  Help: ComponentType<{ children: ReactNode }>
  /** Markdown drawn as answers are (fenced blocks go through renderer.block). */
  Markdown: ComponentType<{ text: string; className?: string }>
}

export interface MenuItem {
  id?: string
  label: ReactNode
  icon?: IconName
  danger?: boolean
  checked?: boolean
  disabled?: boolean
  hint?: ReactNode
  onSelect?: () => void
  /** A submenu: items only. */
  items?: MenuItem[]
}
export type MenuEntry = MenuItem | 'sep' | { id?: string; header: ReactNode }

// ---------- storage (§8.5) ----------

export interface Store {
  get: (key: string) => Promise<{ value: unknown; version: number } | null>
  /** ifVersion: only if the value is still that version (else it throws, 409). */
  set: (key: string, value: unknown, opts?: { ifVersion?: number }) => Promise<{ version: number }>
  delete: (key: string) => Promise<void>
  list: (prefix?: string) => Promise<string[]>
}

// ---------- the bridge object (§8.3) ----------

export interface Bridge {
  /** The page's React (19); use it, not your own copy. */
  React: typeof ReactNS
  kit: Kit
  extensionApi: number
  /** This extension's id. */
  id: string
  actions: {
    before: <N extends Exclude<ActionName, 'renderer.block'>>(name: N, fn: BeforeFn<N>, opts?: HookOpts) => () => void
    around: <N extends ActionName>(name: N, fn: AroundFn<N>, opts?: HookOpts) => () => void
    after: {
      <N extends ActionName>(name: N, fn: AfterFn<N>, opts?: HookOpts): () => void
      /** An event from the server; primaryOnly: in one page of this browser only. */
      <E extends EventName>(name: E, fn: (ev: EventMap[E]) => void, opts?: { primaryOnly?: boolean }): () => void
    }
    dispatch: <N extends ActionName>(name: N, args: Args<N>) => N extends SyncAction ? Result<N> : Promise<Result<N> | Cancel>
  }
  slots: {
    register: <S extends SlotName>(slot: S, item: SlotItems[S]) => () => void
    /** Wraps or replaces an item (the page's or an added one); the id stays. */
    replace: <S extends SlotName>(slot: S, id: string, f: (orig: SlotItems[S]) => SlotItems[S]) => () => void
    hide: <S extends SlotName>(slot: S, id: string) => () => void
    /** Inside an item's render: the slot's context (SlotContexts). */
    useSlotContext: <C = unknown>() => C
  }
  commands: { register: (s: Shortcut) => () => void }
  ui: {
    /** A sheet with its own back-button entry: back (or an iOS swipe) closes it. Comp also gets close. */
    sheet: { open: <P extends object>(Comp: ComponentType<P & { close: () => void }>, props?: P, opts?: { title?: ReactNode; wide?: boolean }) => { closed: Promise<void>; close: () => void } }
    confirm: (title: ReactNode, body?: ReactNode) => Promise<boolean>
    menu: (items: MenuEntry[], at: HTMLElement | { x: number; y: number }, title?: ReactNode) => void
    prompt: (title: ReactNode, opts?: { text?: ReactNode; value?: string; placeholder?: string; ok?: string; multiline?: boolean }) => Promise<string | null>
    choose: (title: ReactNode, options: { value: string; label: ReactNode; hint?: ReactNode; danger?: boolean }[], text?: ReactNode) => Promise<string | null>
    toast: (text: ReactNode, opts?: { tone?: 'ok' | 'bad' }) => void
  }
  storage: {
    /** This person's, for this extension. */
    user: Store
    /** Everyone reads; only admins write. */
    server: Store
    /** Never come back to the page; used only as ${user.KEY} in a route's headers. */
    secrets: { set: (key: string, value: string) => Promise<void>; delete: (key: string) => Promise<void>; has: (key: string) => Promise<boolean> }
  }
  /** To this extension's server routes (/api/ext/<id>/call/…): the server says who asks and signs it. */
  api: {
    fetch: (path: string, init?: RequestInit) => Promise<Response>
    /** GET without a body, POST with one; throws on an error status. */
    json: <T>(path: string, body?: unknown) => Promise<T>
    /** A picture from a route as a blob: address, for an <img>. */
    blobUrl: (path: string) => Promise<string>
  }
  /** Whether this page is the one page of this browser that does once-per-browser work. */
  readonly isPrimary: boolean
  events: { claim: (eventId: string) => Promise<boolean> }
  data: {
    /** A hook: one fetch per key in this page for all its users, again every ms (not while hidden). */
    shared: <T>(key: string, fetcher: () => Promise<T>, ms: number) => T | undefined
  }
  /** t: this extension's locales/<lang>.json (ko when the language has none); the key when missing. */
  i18n: { locale: string; t: (key: string) => string }
  /** token('accent') reads the page's CSS variable --accent. */
  theme: { dark: () => boolean; token: (name: string) => string }
  user: User
  /** Hooks: drawn again when they change. */
  useSessions: () => Session[]
  useCurrent: () => Current
  sessions: () => Session[]
  current: () => Current
}

/** What an extension's entry module exports. */
export type Extension = (bridge: Bridge) => void | Promise<void>
