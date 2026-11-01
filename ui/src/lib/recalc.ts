// 세션 정리 자동 다시 계산 (REQ-F-839 rule 9): after each action on the page the host's tidy is worked out again,
// once for a burst of actions. A kick waits `delay` ms after the last one; a kick while it runs asks for one more run
// after it ends, never two at once.

export interface Recalc {
  /** An action happened: run again `delay` ms after the last kick (or after the run going on now). */
  kick(): void
  /** Whether a run is waiting or going on. */
  busy(): boolean
  /** Stop: nothing more runs (the page went away). */
  stop(): void
}

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export function createRecalc(run: () => Promise<unknown>, delay = 1500, timers: Timers = realTimers): Recalc {
  let timer: unknown = null
  let running = false
  let again = false
  let stopped = false
  const schedule = () => {
    if (timer != null) timers.clear(timer)
    timer = timers.set(() => void fire(), delay)
  }
  const fire = async () => {
    timer = null
    if (stopped) return
    running = true
    try {
      await run()
    } catch {
      // The run says what went wrong itself; a later kick tries again.
    } finally {
      running = false
    }
    if (again && !stopped) {
      again = false
      schedule()
    }
  }
  return {
    kick() {
      if (stopped) return
      if (running) again = true
      else schedule()
    },
    busy: () => running || timer != null || again,
    stop() {
      stopped = true
      if (timer != null) timers.clear(timer)
      timer = null
    },
  }
}
