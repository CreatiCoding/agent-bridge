// What the server sends, as server/server.mjs builds it (stateOf, logEvents, the classic stream).

export type Phase = 'starting' | 'idle' | 'busy' | 'waiting' | 'ended'

export interface Usage {
  context: number | null
  window: number | null
  fiveHour: number | null
  week: number | null
  cost: number | null
  fiveHourResetsAt: number | null
  weekResetsAt: number | null
}

/** What the prompt cache did in the session, counted from its transcript (REQ-F-773). Tokens. */
export interface CacheUsage {
  calls: number
  read: number
  write: number
  input: number
  output: number
  /** The share of the context read from the cache, 0–100. */
  hit: number
  /** The context of the latest call. */
  ctx: number
  at: number
  /** The latest calls that wrote the context again, and what came before them. */
  events: { at: number; kind: 'start' | 'cold' | 'idle' | 'model' | 'compact' | 'other'; tokens: number; gap: number }[]
}

export interface HeldMessage {
  id: string
  text: string
  at: number
}

export interface SessionState {
  alive: boolean
  phase: Phase
  waiting: string | null
  waitingSince: number | null
  held: HeldMessage[]
  tool: { name: string | null; title: string | null; at: number | null } | null
  tools: number
  running?: string[]
  sessionMd?: number | null
  /** The session's own hand-over file: SESSION.md, or SESSION-<id8>.md when SESSION.md is another session's. */
  mdFile?: string | null
  /** What a light copy hands over of it at most: a tenth of the context window, 20 KB (200k) to 100 KB (1M). */
  mdMax?: number | null
  /** The web servers the session started on its Mac (localhost), for the header's computer button. */
  servers?: { port: number; title: string }[]
  plugins?: { market: string; version: string; latest?: string }[]
  turnAt: number | null
  mode: string | null
  effort: string | null
  context: string | null
  autoAllow: boolean
  /** 전부 허용 that asks nothing, risky calls included (REQ-F-796); off means 안전한 전부 허용 while autoAllow is on. */
  allowAll?: boolean
  refreshAfter?: boolean
  /** The bridge MCP tools the session's process started with (null: an agent before 1.245 did not say). */
  bridgeTools?: string[] | null
  size?: number | null
  quietSince?: number | null
  usage?: Usage | null
  cache?: CacheUsage | null
  handedOffTo?: string | null
}

export interface Repo {
  dir?: string
  name?: string
  branch?: string
  sha?: string
  remote?: string
  pushError?: string | null
  pr?: { url: string; number: number; title: string; state: string; draft?: boolean } | null
}

export interface CardOption {
  n: number
  label: string
  description?: string
  kind?: string
}

export interface Card {
  id: string
  kind: 'permission' | 'question' | 'plan' | 'dialog' | 'keyed' | 'stuck' | string
  open: boolean
  auto?: boolean
  at?: number
  title?: string
  header?: string
  description?: string
  context?: string
  footer?: string
  selected?: number
  multi?: boolean
  options?: CardOption[]
  tool?: { name: string; input?: unknown } | null
  plan?: string
  result?: string
}

export interface Session {
  id: string
  hostId: string
  prevHostId: string | null
  title: string
  manualTitle?: boolean
  cwd: string
  home: string
  lines: number
  syncedAt: number | null
  autoPush: boolean
  autoAllow: boolean
  allowAll?: boolean
  folder: { repos?: Repo[]; files?: string[] } | null
  closed: boolean
  resting?: boolean
  /** 즐겨찾기: first in the newest-first list (REQ-F-782). */
  favorite?: boolean
  /** To-dos taken off the panel, by their words (`todoKey`, REQ-F-784). */
  todoHidden?: string[]
  moves: { at: number; from: string; to: string; lines: number; sourceOnline: boolean; warnings: string[] }[]
  conv: string
  seq: number
  lastAt: number
  last: string
  preview: string
  model: string
  launchModel?: string
  createdAt: number
  updatedAt: number
  state: SessionState
  moving: { to: string; at: number } | null
  card: Card | null
  writing: string
  bg?: { kind: string; label: string }[]
  /** Its transcript showed the bridge todos tool (offered or called): for sessions an older agent started. */
  sawTodosTool?: boolean
  coding?: boolean
  forked?: string
  /** Locked with a password: the list shows only that, and the conversation needs unlocking. */
  locked?: boolean
  /** Where it is worked on: the bridge (none, or web) or Slack. In Slack, the pages only read it. */
  seat?: { where: 'web' | 'slack'; at: number; url?: string | null } | null
  /** The Claude account on its Mac it runs in: '' (or none, from before accounts) is the Mac's main one. */
  account?: string
  /** Opened by another session to hand it work (다른 맥에 맡기기, REQ-F-760): that session's id. */
  delegatedBy?: string
}

/** A Claude account on a Mac (설정 → Claude 계정). Each is a config folder of its own with its own sign-in. */
export interface Account {
  id: string
  name: string
  main: boolean
  /** null: not known yet (the Mac has not said). */
  loggedIn: boolean | null
  /** Only on the host page and the accounts tab (the Mac's owner); never in the session list's state. */
  email?: string | null
  plan?: string | null
  method?: string | null
  sessions: number
  signingIn: boolean
}

export interface DiskHelp {
  login: string
  askedAt: number
  until: number
}

export interface Host {
  id: string
  /** CPU, memory and disk in use (REQ-F-800); absent from older agents. */
  sys?: import('./format').SysUse | null
  /** The last battery the host reported and when, kept after it goes away (REQ-F-807). */
  battery?: (import('./format').Battery & { at: number }) | null
  /** 디스크 정리 도움 (REQ-F-804): the operator who asked, and until when it was granted (0: not yet). */
  diskHelp?: DiskHelp | null
  name: string
  kind: string
  info: { version: string; build: string; node: string; os: string; hostname: string } | null
  outdated: boolean
  problems: number
  problem: string | null
  online: boolean
  stale: boolean
  lastSeen: number | null
  healthAt: number | null
  rtt: number | null
  errors?: number
  lastError?: string | null
  /** Its Claude accounts, without e-mail addresses. An agent from before accounts sends none. */
  accounts?: Account[]
  /** What it has for speech (REQ-F-758). null from an agent that does not say. */
  voice?: VoiceStatus | null
  /** Whether it takes work handed over from the person's other Macs (REQ-F-760). */
  takesWork?: boolean
  /** 관리자 권한 (REQ-F-764): until when root is open on it (0: closed), and who waits for its password. */
  sudo?: { until: number; asks: { id: string; sid: string; title: string; what: string; at: number }[] } | null
  /** When it takes a new agent and the one it holds (REQ-F-832). null from an agent older than that. */
  update?: UpdatePolicy | null
}

/** 자동 업데이트 (REQ-F-832): `night` only between from and to o'clock (the Mac's time), `always` as one arrives. */
export interface UpdatePolicy {
  mode: 'night' | 'always'
  from: number
  to: number
  /** --no-auto-update: nothing is taken. */
  off: boolean
  /** The new agent taken and waiting to go in. `now`: 지금 업데이트 was asked. */
  pending: { build: string; at: number; now: boolean } | null
}

export interface VoiceStatus {
  whisper: boolean
  models: string[]
  vadModel: boolean
  /** The running whisper-server's VAD: 'idle' while none runs. */
  vad: 'on' | 'off' | 'idle' | null
  ffmpeg: boolean
}

/** One Mac's choice over the account's: '' follows the account. */
export interface VoiceHost {
  model: string
}

export interface Notice {
  id: string
  at: number
  sid?: string
  title: string
  text: string
  tone?: 'ok' | 'fail' | 'info' | 'warn'
}

export interface Group {
  id: string
  name: string
  items: string[]
  /** The group it sits in; none at the top. Three levels at most. */
  parent?: string
}

export interface Groups {
  groups: Group[]
  loose: string[]
  collapsed?: string[]
}

/** 분할 조합 (REQ-F-790): sessions saved to open side by side again. */
export interface SplitPreset {
  id: string
  name: string
  ids: string[]
}

export interface State {
  hosts: Host[]
  groups: Groups
  splits?: SplitPreset[]
  notices: Notice[]
  /** Where a session can be moved besides the bridge: 'slack' while the Slack plugin is on. */
  places?: string[]
  /** The page build the server hands out now (`index-<hash>.js`): another than this page's reloads it. */
  ui?: string | null
  sessions: Session[]
}

/** One entry of a session's numbered log. */
export type Ev = { seq: number; at: number } & (
  | { k: 'user'; id?: string; text: string; via?: string; command?: boolean; images?: string[] }
  | { k: 'text'; text: string; choices?: string[] }
  | { k: 'tool'; tool: string; name: string; label: string; detail?: string; input?: string }
  | { k: 'tool_end'; tool: string; error?: boolean; text?: string; images?: string[] }
  | { k: 'todos'; items: Todo[] }
  | { k: 'local'; text: string; error?: boolean }
  | { k: 'notice'; text: string; tone?: string; icon?: string }
  | { k: 'line'; text: string; blocks?: unknown }
  | { k: 'title'; title: string }
  | { k: 'model'; model: string }
  | { k: 'status'; phase: Phase }
  | { k: 'card'; card: Card }
  | { k: 'card_end'; id: string; result?: string }
  | { k: 'react'; id: string; name: string; on: boolean }
  | { k: 'held'; id: string; n: number; first?: boolean }
  | { k: 'side'; id: string; q: string; update?: boolean; answer?: string; error?: string }
  | { k: 'end'; text?: string }
)

export interface Todo {
  text: string
  active: string
  status: string
}

export interface EventsPage {
  events: Ev[]
  more: boolean
  last: number
  lines: number
  writing: string
  card: Card | null
}

/** How the signed-in person is named on screen: an Apple account (REQ-F-772) by its name or e-mail, not its `apple_…`. */
export const shownName = (me: Me) => (me.user.apple ? me.user.name || 'Apple 사용자' : me.user.login)

export interface Me {
  /** Who is signed in, and how (REQ-F-824: settings.section's user); an older server leaves them out. */
  uid?: string
  provider?: string
  /** `apple`: signed in with Apple (REQ-F-772); `login` is then this server's own `apple_…` name. */
  user: { login: string; name?: string; avatar?: string; apple?: boolean }
  admin: boolean
  /** The beta reviewer's account (데모 모드, REQ-F-766): one demo Mac played by the server, no real one. */
  demo?: boolean
  /** The newest iOS build sent to TestFlight (REQ-F-781); never to the demo account. */
  appBuild?: { build: number; at: number }
  version: string
  origin: string
  /** Where this server's source is (REQ-F-791, AGPL-3.0 §13); an older server leaves it out. */
  source?: string
  icons?: IconPrefs
  voice?: VoicePrefs
  /** What bridge.yaml turned off (REQ-F-812); an older server leaves it out (everything on). */
  features?: Features
  /** false on a page at origins.extra (REQ-F-815): it does not link Macs. Left out elsewhere. */
  linkHere?: boolean
  /** Where this server sends conversations (bridge.yaml notify, REQ-F-818): the origin and the events; left out when none. */
  recipients?: { origin: string; events: string[] }[]
}

/** The server's feature flags (REQ-F-812). background is read-only (headless link and screenless hosts). */
export interface Features {
  sessionMove: boolean
  webpush: boolean
  voice: boolean
  preview: boolean
  skills: boolean
  slack: boolean
  remoteKeys: boolean
  permissionModes: string[]
  background: boolean
}

/** 음성 입력 (REQ-F-754), kept with the account. terms: one word per line (or comma), the spelling to keep. */
export interface VoicePrefs {
  on: boolean
  model: string
  language: 'ko' | 'en' | 'auto'
  denoise: boolean
  tidy: boolean
  terms: string
}

/** Kept with the account: the icons' size in px and how much of their box the drawings fill (1 = as drawn). */
export interface IconPrefs {
  size: number
  fill: number
}

export interface Options {
  models: { label: string; value: string }[]
  efforts: string[]
  modes: { label: string; value: string }[]
}
