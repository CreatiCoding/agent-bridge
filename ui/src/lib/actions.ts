// 액션 버스 (REQ-F-822): what the page does on someone's behalf goes through a named action, so a handler can be put
// before, after or around it. The built-in way of doing it (the default) is always the innermost step and runs at
// most once. Nothing here knows about React or the page: the defaults are set by lib/builtin-actions.

/** Where a message, a card or a session comes from, as the page knows it. */
export interface ActionMap {
  'composer.submit': { args: { sid: string; text?: string }; result: { sent: boolean; reason?: string } }
  'message.send': {
    args: { sid: string; text: string; kind: 'text' | 'command'; images: { data: string; name: string }[]; videos: { id: string; name: string }[] }
    result: unknown
  }
  'permission.answer': {
    args: {
      sid: string
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
  'renderer.block': { args: { lang: string; text: string; closed: boolean; isLast: boolean; sid?: string }; result: unknown }
  'notify.show': { args: { text: string; sid?: string }; result: void }
}
export type ActionName = keyof ActionMap
type Args<N extends ActionName> = ActionMap[N]['args']
type Result<N extends ActionName> = ActionMap[N]['result']
export type Cancel = { cancel: string }

/**
 * sync: called inside a press (iOS lets a new window or a clipboard write happen only there) or during a render;
 * its handlers must not wait. onTimeout: what a slow (or failing) before/around does to the action.
 */
export const ACTIONS: Record<ActionName, { sync: boolean; onTimeout?: 'cancel' | 'skip'; aroundOnly?: boolean }> = {
  'composer.submit': { sync: false, onTimeout: 'cancel' },
  'message.send': { sync: false, onTimeout: 'cancel' },
  'permission.answer': { sync: false, onTimeout: 'cancel' },
  'session.open': { sync: true },
  'session.create': { sync: false, onTimeout: 'cancel' },
  'session.close': { sync: false, onTimeout: 'skip' },
  'link.open': { sync: true },
  'clipboard.copy': { sync: true },
  'renderer.block': { sync: true, aroundOnly: true },
  'notify.show': { sync: true },
}

/** How long a before/around may take before it calls next(), unless it asks for more (up to MAX_WAIT_MS). */
export const WAIT_MS = 500
export const MAX_WAIT_MS = 10_000

export interface Ctx {
  /** Dispatch again, skipping the handler that calls it (next() goes on down instead). */
  dispatch: <N extends ActionName>(name: N, args: Args<N>) => unknown
  /** The clock stops while the person answers (a confirm, a sheet). */
  waitUser: <T>(p: Promise<T>) => Promise<T>
}
type Next = (args: never) => unknown
type Kind = 'before' | 'after' | 'around'
interface Layer {
  name: ActionName
  kind: Kind
  fn: (...a: never[]) => unknown
  priority: number
  owner: string
  timeoutMs: number
}
export interface HookOpts {
  /** Bigger is further out; 0 by default. */
  priority?: number
  /** The extension's id: same priority, ordered by it. */
  owner?: string
  timeoutMs?: number
}

const layers = new Map<ActionName, Layer[]>()
const defaults = new Map<ActionName, (args: never) => unknown>()

/** What went wrong in a handler, newest last; 운영 탭 reads it once extensions load (6단계). */
export const actionLog: { at: number; action: string; owner: string; what: string }[] = []
let noted: (owner: string, action: string, what: string) => void = () => {}
/** Who hears of a handler's failure (the extension host reports it to the server). */
export const onNoted = (f: typeof noted) => void (noted = f)
const note = (l: { name: string; owner: string }, what: string) => {
  noted(l.owner, l.name, what)
  actionLog.push({ at: Date.now(), action: l.name, owner: l.owner, what })
  if (actionLog.length > 100) actionLog.shift()
  console.warn(`[actions] ${l.name}${l.owner ? ` (${l.owner})` : ''}: ${what}`)
}

let cancelShown: (reason: string) => void = () => {}
/** How a cancel is told to the person (a toast); set by the page. */
export const onCancelShown = (f: (reason: string) => void) => void (cancelShown = f)

let version = 0
const watchers = new Set<() => void>()
/** Bumped whenever a handler comes or goes: what drew with them (a code block) draws again. */
export const actionsVersion = () => version
export function watchActions(f: () => void) {
  watchers.add(f)
  return () => void watchers.delete(f)
}
const changed = () => {
  version++
  for (const f of watchers) f()
}

export const isCancel = (r: unknown): r is Cancel => !!r && typeof r === 'object' && typeof (r as Cancel).cancel === 'string'

/** The built-in way of doing an action. */
export function setDefault<N extends ActionName>(name: N, f: (args: Args<N>) => Result<N> | Promise<Result<N>>) {
  defaults.set(name, f as (args: never) => unknown)
}

function add(name: ActionName, kind: Kind, fn: Layer['fn'], o: HookOpts = {}) {
  if (!(name in ACTIONS)) throw new Error(`모르는 액션이에요: ${name}`)
  if (ACTIONS[name].aroundOnly && kind !== 'around') throw new Error(`${name} 은 around 만 받아요`)
  const l: Layer = { name, kind, fn, priority: o.priority ?? 0, owner: o.owner ?? '', timeoutMs: Math.min(MAX_WAIT_MS, Math.max(1, o.timeoutMs ?? WAIT_MS)) }
  const list = [...(layers.get(name) ?? []), l].sort((a, b) => b.priority - a.priority || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0))
  layers.set(name, list)
  changed()
  return () => {
    layers.set(name, (layers.get(name) ?? []).filter((x) => x !== l))
    changed()
  }
}

type BeforeFn<N extends ActionName> = (args: Args<N>, ctx: Ctx) => Args<N> | Cancel | void | Promise<Args<N> | Cancel | void>
type AfterFn<N extends ActionName> = (args: Args<N>, result: Result<N>, ctx: Ctx) => void
type AroundFn<N extends ActionName> = (args: Args<N>, next: (args: Args<N>) => unknown, ctx: Ctx) => unknown

export const before = <N extends ActionName>(name: N, fn: BeforeFn<N>, o?: HookOpts) => add(name, 'before', fn as Layer['fn'], o)
export const after = <N extends ActionName>(name: N, fn: AfterFn<N>, o?: HookOpts) => add(name, 'after', fn as Layer['fn'], o)
export const around = <N extends ActionName>(name: N, fn: AroundFn<N>, o?: HookOpts) => add(name, 'around', fn as Layer['fn'], o)

const isThenable = (x: unknown): x is PromiseLike<unknown> => !!x && typeof (x as PromiseLike<unknown>).then === 'function'

/**
 * Runs an action through its handlers. A sync action returns what its default (or an around) returned; any other
 * returns a promise: the default's result, { cancel } when a handler stopped it, or the default's own error.
 */
export function dispatch<N extends ActionName>(name: N, args: Args<N>): N extends 'session.open' | 'link.open' | 'clipboard.copy' | 'renderer.block' | 'notify.show' ? Result<N> : Promise<Result<N> | Cancel> {
  return run(name, args, null) as never
}

function run(name: ActionName, args: unknown, skip: Layer | null): unknown {
  const list = (layers.get(name) ?? []).filter((l) => l !== skip)
  const base = defaults.get(name)
  if (!base) throw new Error(`기본 구현이 없는 액션이에요: ${name}`)
  if (ACTIONS[name].sync) return runSync(list, base, args)
  return runAsync(name, list, base, args).then((r) => {
    if (isCancel(r)) cancelShown(r.cancel)
    return r
  })
}

function ctxOf(l: Layer, waitUser: Ctx['waitUser'] = (p) => p): Ctx {
  return { dispatch: (n, a) => run(n, a, l), waitUser }
}

// after sees the arguments the default ran with, whatever layer it sits in.
function runSync(list: Layer[], base: (a: never) => unknown, args: unknown): unknown {
  let ran = args
  const step = (i: number, a: unknown): unknown => {
    if (i === list.length) return base((ran = a) as never)
    const l = list[i]
    let called = false
    let res: unknown
    const next = (a2: unknown) => {
      if (!called) ((called = true), (res = step(i + 1, a2)))
      return res
    }
    const ctx = ctxOf(l)
    try {
      if (l.kind === 'before') {
        const r = (l.fn as (a: unknown, c: Ctx) => unknown)(a, ctx)
        if (isThenable(r)) {
          note(l, 'before 가 Promise 를 돌려줘서 무시했어요 (이 액션은 동기예요)')
          return next(a)
        }
        if (isCancel(r)) return (cancelShown(r.cancel), r)
        return next(r && typeof r === 'object' ? r : a)
      }
      if (l.kind === 'after') {
        const out = next(a)
        if (!isCancel(out)) (l.fn as (a: unknown, r: unknown, c: Ctx) => unknown)(ran, out, ctx)
        return out
      }
      const out = (l.fn as (a: unknown, n: Next, c: Ctx) => unknown)(a, next as Next, ctx)
      if (!called && isCancel(out)) cancelShown(out.cancel)
      return out
    } catch (e) {
      note(l, `오류: ${e instanceof Error ? e.message : e}`)
      return called ? res : next(a)
    }
  }
  return step(0, args)
}

function runAsync(name: ActionName, list: Layer[], base: (a: never) => unknown, args: unknown): Promise<unknown> {
  const onTimeout = ACTIONS[name].onTimeout ?? 'cancel'
  let ran = args
  const step = (i: number, a: unknown): Promise<unknown> => {
    if (i === list.length) {
      try {
        return Promise.resolve(base((ran = a) as never))
      } catch (e) {
        return Promise.reject(e)
      }
    }
    return layer(list[i], a, (a2) => step(i + 1, a2), onTimeout, () => ran)
  }
  return step(0, args)
}

/** One handler: timed until it calls next() (the clock stopped while waitUser waits), next() run at most once. */
function layer(l: Layer, a: unknown, down: (a: unknown) => Promise<unknown>, onTimeout: 'cancel' | 'skip', ran: () => unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let nextP: Promise<unknown> | null = null
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let left = l.timeoutMs
    let since = 0
    let waiting = 0
    const settle = (p: Promise<unknown>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      p.then(resolve, reject)
    }
    const next = (a2: unknown) => {
      if (!nextP) {
        clearTimeout(timer)
        // Given up on already (cancelled): the default must not run after all.
        nextP = settled && onTimeout === 'cancel' ? Promise.resolve({ cancel: '시간 초과' }) : down(a2)
      }
      return nextP
    }
    const giveUp = (why: string) => {
      if (nextP || settled) return
      note(l, why)
      settle(onTimeout === 'skip' ? next(a) : Promise.resolve({ cancel: '시간 초과' }))
    }
    const arm = () => {
      since = Date.now()
      timer = setTimeout(() => giveUp(`${l.timeoutMs}ms 안에 끝나지 않았어요`), left)
    }
    const waitUser = async <T>(p: Promise<T>) => {
      if (nextP || settled) return p
      if (!waiting++) (clearTimeout(timer), (left -= Date.now() - since))
      try {
        return await p
      } finally {
        if (!--waiting && !nextP && !settled) arm()
      }
    }
    const ctx = ctxOf(l, waitUser)
    arm()
    const failed = (e: unknown) => {
      if (nextP) settle(nextP)
      else giveUp(`오류: ${e instanceof Error ? e.message : e}`)
    }
    let out: unknown
    try {
      if (l.kind === 'before') {
        void Promise.resolve((l.fn as (a: unknown, c: Ctx) => unknown)(a, ctx)).then((r) => {
          if (settled) return undefined
          if (isCancel(r)) return (settle(Promise.resolve(r)), undefined)
          return settle(next(r && typeof r === 'object' ? r : a))
        }, failed)
        return
      }
      if (l.kind === 'after') {
        settle(
          next(a).then((r) => {
            if (!isCancel(r))
              try {
                ;(l.fn as (a: unknown, r: unknown, c: Ctx) => unknown)(ran(), r, ctx)
              } catch (e) {
                note(l, `오류: ${e instanceof Error ? e.message : e}`)
              }
            return r
          }),
        )
        return
      }
      out = (l.fn as (a: unknown, n: Next, c: Ctx) => unknown)(a, next as Next, ctx)
    } catch (e) {
      return failed(e)
    }
    Promise.resolve(out).then((r) => settle(Promise.resolve(r)), failed)
  })
}
