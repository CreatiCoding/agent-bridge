// 쓰는 중이면 기다렸다 가져오기 (REQ-F-867): the Mac refuses an adopt while another tool holds the conversation or
// wrote it in the last minute (REQ-F-048 rule 4b, REQ-F-853). That is a wait, not a failure: the page tries again
// on its own until the conversation is free, instead of telling the person to come back in a minute.

/** The Mac's refusal for a conversation another tool is using (Claude Code and Codex wordings). */
export const ADOPT_BUSY = /지금 쓰는 중이에요/
/** How often the page asks again. The Mac's own window is 60 s since the last write. */
export const ADOPT_RETRY_MS = 15_000
/** How long the page keeps waiting before it gives up with the Mac's words (a terminal left open holds it forever). */
export const ADOPT_WAIT_MS = 10 * 60_000

export type AdoptWait = { tries: number; leftMs: number }

/** Thrown when the person stops the wait. */
export class AdoptWaitStopped extends Error {
  constructor() {
    super('기다리기를 멈췄어요')
  }
}

/**
 * Runs `once` and, while it fails with the busy refusal, waits `retryMs` and runs it again, for at most `waitMs`.
 * Any other error, or the busy one after `waitMs`, is thrown as it came. `onWait` hears each wait before it starts.
 */
export async function adoptWhenFree<T>(
  once: () => Promise<T>,
  opts: {
    message: (e: unknown) => string
    onWait?: (w: AdoptWait) => void
    stopped?: () => boolean
    retryMs?: number
    waitMs?: number
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  },
): Promise<T> {
  const retryMs = opts.retryMs ?? ADOPT_RETRY_MS
  const waitMs = opts.waitMs ?? ADOPT_WAIT_MS
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const start = now()
  for (let tries = 1; ; tries++) {
    try {
      return await once()
    } catch (e) {
      const left = waitMs - (now() - start)
      if (!ADOPT_BUSY.test(opts.message(e)) || left <= 0) throw e
      if (opts.stopped?.()) throw new AdoptWaitStopped()
      opts.onWait?.({ tries, leftMs: left })
      // Waited in short steps so a stop is heard within a second.
      for (let t = 0; t < Math.min(retryMs, left); t += 1000) {
        await sleep(Math.min(1000, retryMs - t))
        if (opts.stopped?.()) throw new AdoptWaitStopped()
      }
    }
  }
}

/** Thrown when the page that ran the adopt is gone: the whole run ends, nothing after it is sent. */
export class AdoptLeft extends Error {
  constructor() {
    super('목록 화면을 떠나 가져오기를 멈췄어요')
  }
}

/**
 * The two ways a run stops, kept apart (REQ-F-867 rule 2): `skip` (기다리지 않기) gives up only the conversation being
 * waited on and the run goes on to the next; `leave` (the list page unmounted) ends the whole run and is never undone,
 * so no later conversation and no retry is sent after it.
 */
export function adoptControl() {
  let skipped = false
  let gone = false
  return {
    skip: () => void (skipped = true),
    leave: () => void (gone = true),
    left: () => gone,
    /** One conversation: `adoptWhenFree` that hears both stops. A skip only lasts for this conversation. */
    async one<T>(once: () => Promise<T>, opts: Omit<Parameters<typeof adoptWhenFree<T>>[1], 'stopped'>): Promise<T> {
      if (gone) throw new AdoptLeft()
      skipped = false
      try {
        return await adoptWhenFree(() => (gone ? Promise.reject(new AdoptLeft()) : once()), { ...opts, stopped: () => skipped || gone })
      } catch (e) {
        throw gone ? new AdoptLeft() : e
      }
    },
  }
}
export type AdoptControl = ReturnType<typeof adoptControl>

/**
 * Several, one after another. A failure (or a skip) is noted and the run goes on; leaving the page ends it at once
 * with `left: true`, and the caller must not touch the page after that.
 */
export async function adoptEach<C>(
  items: C[],
  ctl: AdoptControl,
  adopt: (c: C) => Promise<unknown>,
  onItem?: (i: number, failed: { item: C; error: unknown }[]) => void,
): Promise<{ failed: { item: C; error: unknown }[]; left: boolean }> {
  const failed: { item: C; error: unknown }[] = []
  for (const [i, c] of items.entries()) {
    if (ctl.left()) return { failed, left: true }
    onItem?.(i, [...failed])
    try {
      await adopt(c)
    } catch (e) {
      if (e instanceof AdoptLeft || ctl.left()) return { failed, left: true }
      failed.push({ item: c, error: e })
    }
  }
  return { failed, left: ctl.left() }
}
