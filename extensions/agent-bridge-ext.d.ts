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

export type SettingsTab = 'devices' | 'launch' | 'prompt' | 'accounts' | 'device' | 'plugins' | 'voice' | 'admin' | 'changes' | 'more'

/** What the page is showing: route is 'session' on a session's page (then sid), else another page's name. */
export interface Current {
  route: string
  sid?: string
}

// ---------- actions (§6) ----------

export interface ActionMap {
  /** The send button, Enter, ⌘Enter. sent false when nothing went (reason: 'empty', 'sending', 'duplicate', 'upload', 'no-composer'). */
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
  /**
   * One of Claude's answers, whole; around only (REQ-F-850). Return next(args), { text } (changed words: the page
   * marks them and offers the answer's own), or { hide: true, reason? } (one folded line that opens). An answer an
   * agreed `messages.quiet` rule made quiet stays folded whatever a handler returns.
   */
  'message.render': { args: MessageArgs; result: MessageView }
}
export interface MessageArgs {
  sid: string
  seq: number
  text: string
  /** The rule that made it quiet (the server kept its "새 답" dot and notifications back), or null. */
  quiet: { ext: string; name: string; label: string } | null
  isLast: boolean
}
/** `by` is set by the page (the extensions that folded or changed it). */
export type MessageView = { text: string; by?: string[] } | { hide: true; reason?: string; text?: string; by?: string[] }
export type ActionName = keyof ActionMap
export type Args<N extends ActionName> = ActionMap[N]['args']
export type Result<N extends ActionName> = ActionMap[N]['result']
/** Returned by a before (or an around instead of calling next) to stop the action; the reason is shown. */
export type Cancel = { cancel: string }
/** Actions that run inside a press or a render: their handlers must not wait (a Promise from before is ignored). */
export type SyncAction = 'session.open' | 'link.open' | 'clipboard.copy' | 'renderer.block' | 'notify.show' | 'message.render'

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
  /** The turn ended on a quiet answer (REQ-F-850): the notify webhooks did not get it. */
  quiet?: true
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
  attachments: { kind: 'image' | 'video' | 'file'; name: string; pct?: number }[]
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
  'app.rail.items': AppCtx
  'app.menu.items': AppCtx
  // REQ-F-865
  'session-list.toolbar': ListCtx
  'session-list.filters': ListCtx
  'session-list.empty': { filter: string }
  'session-group.actions': GroupCtx
  'session-group.badges': GroupCtx
  'session-group.menu': GroupCtx
  'session-list.row.actions': { session: Session }
  'session.header.actions': SessionCtx
  'session.header.badges': SessionCtx
  'session-tabs.actions': { sid: string; tabs: Session[]; group: { id: string; name: string } | null }
  'session-tab.menu': { session: Session; active: boolean; group: { id: string; name: string } | null }
  'split-pane.actions': SessionCtx
  'composer.before': ComposerCtx
  'composer.after': ComposerCtx
  'composer.status': ComposerCtx
  'message.actions': MessageCtx
  'message.metadata': MessageCtx
  'session.timeline.before': SessionCtx
  'session.timeline.after': SessionCtx
  'host-list.toolbar': { hosts: HostInfo[] }
  'host-card.actions': { host: HostInfo }
  'host-card.badges': { host: HostInfo }
  'host-detail.section': { host: HostInfo; mine: boolean }
  'adopt-list.toolbar': { hostId: string; shown: ConvInfo[]; picked: ConvInfo[] }
  'adopt-list.row.actions': { hostId: string; conversation: ConvInfo }
  'session-create.fields': CreateFieldCtx
  'session-create.summary': { draft: CreateDraft; ext: Record<string, Record<string, unknown>> }
  'file-list.actions': { hostId: string; path: string; items: FileInfo[] }
  'file-row.actions': { hostId: string; file: FileInfo }
  'preview.toolbar': { kind: 'html'; html: string } | { kind: 'server'; sid: string; url: string | null }
  'app.banner': { route: string }
  'session.banner': SessionCtx
  'app.status.items': { route: string }
  'notification.items': Record<string, never>
  'settings.tabs': { user: User | null; tab: string }
  'app.routes': { ext: string; page: string }
}
export type SlotName = keyof SlotContexts
/** How a slot's added items are drawn (bridge.version.slots): see SlotItems for each one's shape. */
export type SlotKind = 'own' | 'action' | 'menu' | 'section' | 'badge' | 'data'

/** What the slot contexts of REQ-F-865 carry. Read only: act through actions.dispatch and your own routes. */
export interface ListCtx {
  /** The list's search text, and changing it (also bridge.list). */
  filter: string
  setFilter: (text: string) => void
  wide: boolean
}
export interface GroupCtx {
  group: { id: string; name: string; parent: string | null }
  sessions: Session[]
}
export interface SessionCtx {
  sid: string
  session: Session
  wide: boolean
  /** In a pane of a split screen (each pane is its own frame). */
  pane: boolean
}
export interface MessageCtx {
  sid: string
  session: Session
  message: { key: string; seq: number; at: number; id?: string; role: 'user' | 'assistant'; text: string }
}
/** A host as slot contexts show it: no keys, paths or logs. */
export interface HostInfo {
  id: string
  name: string
  kind: string
  online: boolean
  runners: string[]
}
export interface ConvInfo {
  conv: string
  cwd: string
  runner: string
  title: string
  exists: boolean
}
export interface FileInfo {
  path: string
  name: string
  kind: string
  size: number | null
}
/** What the new session page is about to start (read only: the page's fields are the page's). */
export interface CreateDraft {
  hostId: string
  cwd: string
  runner: string
  model: string
  effort: string
  mode: string
  group: string | null
  prompt: string
}
export interface CreateFieldCtx {
  draft: CreateDraft
  /** This extension's own values, reaching its session.create hooks as args.ext[<id>] (never the server). */
  values: Record<string, unknown>
  set: (name: string, value: unknown) => void
}

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
/** Where an app item was pressed (REQ-F-863). */
export interface AppCtx {
  place: 'rail' | 'menu'
  route: string
  sid?: string
  wide: boolean
}
/**
 * app.rail.items (the PC's rail) and app.menu.items (the phone's ⋯ menu): data the page draws, the same in both.
 * Register the same id in both slots for one action everywhere; change it later with slots.update (badge, busy, ...).
 */
export interface AppItem extends ItemBase {
  label: string
  icon: IconName
  hint?: string
  /** A count (over 0), a dot or NEW; null or 0 shows nothing. */
  badge?: number | 'dot' | 'new' | null
  active?: boolean
  /** Not pressable; a string says why. */
  disabled?: boolean | string
  /** Working: not pressable until cleared, so it does not run twice. A number 0..1 is how far. */
  busy?: boolean | number
  /** app.menu.items only: also in the PC's account menu (by default only where the rail is not shown). */
  wide?: boolean
  run: (ctx: AppCtx) => void
}
/**
 * An `action` or `menu` slot's item (REQ-F-865): data the page draws as a button (more than fit go into ⋯) or a
 * menu row. Same fields as AppItem; `visible` decides per place from the slot's context.
 */
export interface ActionItem<C = unknown> extends ItemBase {
  label: string
  icon: IconName
  hint?: string
  badge?: number | 'dot' | 'new' | null
  active?: boolean
  disabled?: boolean | string
  busy?: boolean | number
  danger?: boolean
  visible?: (ctx: C) => boolean
  run: (ctx: C) => void
}
/** A `section` or `badge` slot's item: drawn as a component under the slot's context (useSlotContext). */
export interface RenderItem extends ItemBase {
  render: () => ReactNode
}
/** app.status.items: background work as a chip (busy: a spinner, tone: done or failed). */
export interface StatusItem extends ActionItem<{ route: string }> {
  tone?: 'ok' | 'bad'
}
/** session-create.fields: validate says what is wrong (the start waits and shows it), or nothing. */
export interface CreateFieldItem extends RenderItem {
  validate?: (values: Record<string, unknown>, draft: CreateDraft) => string | null | undefined
}
/** notification.items: listed above the server's notices and counted on the bell, until closed or taken away. */
export interface NoticeItem extends ItemBase {
  title: string
  text?: string
  tone?: 'ok' | 'fail' | 'info'
  at?: number
  run?: () => void
  onClose?: () => void
}
/** settings.tabs: a tab of its own at /settings/x/<extension>/<id> (id: a-z, 0-9, -). */
export interface SettingsTabItem extends ItemBase {
  label: string
  icon?: IconName
  render: () => ReactNode
}
/** app.routes: a page of its own at /x/<extension>/<id> (bridge.routes.open), in the page's frame. */
export interface RouteItem extends ItemBase {
  title: string
  render: () => ReactNode
}
export interface SlotItems {
  'composer.actions': ComposerItem
  'session.menu': SessionMenuItem
  'session-list.row.badges': BadgeItem
  'settings.section': SettingsItem
  'app.rail.items': AppItem
  'app.menu.items': AppItem
  'session-list.toolbar': ActionItem<SlotContexts['session-list.toolbar']>
  'session-list.filters': RenderItem
  'session-list.empty': RenderItem
  'session-group.actions': ActionItem<SlotContexts['session-group.actions']>
  'session-group.badges': RenderItem
  'session-group.menu': ActionItem<SlotContexts['session-group.menu']>
  'session-list.row.actions': ActionItem<SlotContexts['session-list.row.actions']>
  'session.header.actions': ActionItem<SlotContexts['session.header.actions']>
  'session.header.badges': RenderItem
  'session-tabs.actions': ActionItem<SlotContexts['session-tabs.actions']>
  'session-tab.menu': ActionItem<SlotContexts['session-tab.menu']>
  'split-pane.actions': ActionItem<SlotContexts['split-pane.actions']>
  'composer.before': RenderItem
  'composer.after': RenderItem
  'composer.status': RenderItem
  'message.actions': ActionItem<SlotContexts['message.actions']>
  'message.metadata': RenderItem
  'session.timeline.before': RenderItem
  'session.timeline.after': RenderItem
  'host-list.toolbar': ActionItem<SlotContexts['host-list.toolbar']>
  'host-card.actions': ActionItem<SlotContexts['host-card.actions']>
  'host-card.badges': RenderItem
  'host-detail.section': RenderItem
  'adopt-list.toolbar': ActionItem<SlotContexts['adopt-list.toolbar']>
  'adopt-list.row.actions': ActionItem<SlotContexts['adopt-list.row.actions']>
  'session-create.fields': CreateFieldItem
  'session-create.summary': RenderItem
  'file-list.actions': ActionItem<SlotContexts['file-list.actions']>
  'file-row.actions': ActionItem<SlotContexts['file-row.actions']>
  'preview.toolbar': ActionItem<SlotContexts['preview.toolbar']>
  'app.banner': RenderItem
  'session.banner': RenderItem
  'app.status.items': StatusItem
  'notification.items': NoticeItem
  'settings.tabs': SettingsTabItem
  'app.routes': RouteItem
}

/** The page's own items, which order, replace and hide may name. */
export interface BuiltinIds {
  'composer.actions': 'attach' | 'chips' | 'mic' | 'send'
  'session.menu':
    | 'split' | 'split-add' | 'split-full' | 'split-leave' | 'same-group' | 'copy-path' | 'screen' | 'todos' | 'doc'
    | 'place' | 'resume' | 'rename' | 'remove'
    | 'group' | 'refresh' | 'compact' | 'fork' | 'lightfork' | 'trim-log' | 'move-host' | 'move-account' | 'move-cwd' | 'lock' | 'favorite' | 'rest' | 'log' | 'end' | 'trash'
  'session-list.row.badges': 'state' | 'slack' | 'delegated' | 'runner'
  'settings.section': never
  'app.rail.items': 'logo' | 'sidebar' | 'new' | 'search' | 'usage' | 'report' | 'bell' | 'settings' | 'account'
  'app.menu.items': 'new' | 'new-group' | 'view-group' | 'view-recent' | 'settings' | 'report' | 'account' | 'logout'
  'session-list.toolbar': never
  'session-list.filters': never
  'session-list.empty': never
  'session-group.actions': never
  'session-group.badges': never
  'session-group.menu': never
  'session-list.row.actions': never
  'session.header.actions': never
  'session.header.badges': never
  'session-tabs.actions': never
  'session-tab.menu': never
  'split-pane.actions': never
  'composer.before': never
  'composer.after': never
  'composer.status': never
  'message.actions': never
  'message.metadata': never
  'session.timeline.before': never
  'session.timeline.after': never
  'host-list.toolbar': never
  'host-card.actions': never
  'host-card.badges': never
  'host-detail.section': never
  'adopt-list.toolbar': never
  'adopt-list.row.actions': never
  'session-create.fields': never
  'session-create.summary': never
  'file-list.actions': never
  'file-row.actions': never
  'preview.toolbar': never
  'app.banner': never
  'session.banner': never
  'app.status.items': never
  'notification.items': never
  'settings.tabs': never
  'app.routes': never
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
    before: <N extends Exclude<ActionName, 'renderer.block' | 'message.render'>>(name: N, fn: BeforeFn<N>, opts?: HookOpts) => () => void
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
    /** Changes fields of an item this extension added (not id or order) and draws it again. */
    update: <S extends SlotName>(slot: S, id: string, patch: Partial<Omit<SlotItems[S], 'id' | 'order'>>) => void
    /** Inside an item's render: the slot's context (SlotContexts). */
    useSlotContext: <C = unknown>() => C
    /** Whether this page has the slot: an older page may not, so check before register to fall back. */
    supported: (slot: string) => boolean
  }
  /** What this page gives: the API number and every slot with how it is drawn. */
  version: { extensionApi: number; slots: { name: SlotName; kind: SlotKind }[] }
  /** The session list's search text. */
  list: { filter: () => string; setFilter: (text: string) => void; useFilter: () => string }
  /** This extension's pages (app.routes). */
  routes: { href: (id: string) => string; open: (id: string) => void }
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
