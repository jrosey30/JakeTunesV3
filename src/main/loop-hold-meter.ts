/**
 * The main event loop held (usage log `main.loop-held`), measured so a hold
 * says whose it is (weekly fix, 2026-11-27).
 *
 * From 2026-11-22 to 11-26 the MacBook reported holds of 7 s to 18 min, up to
 * 196 a day, while workmini and homemini, on the same builds, never passed
 * 2.2 s. A late timer alone can't tell the app's own work from macOS: a
 * sleeping or napping Mac, or one starved by a build, makes the same number.
 * So each hold also carries:
 *
 *   cpuMs     this process's CPU time across the late tick, every thread in
 *             it (the main thread, the thread pool, GC). Near or over `ms`:
 *             the process was busy, not necessarily the main thread. Far
 *             under it: the app was waiting on the machine.
 *   (sinceSuspendMs is read when the window is reported, up to 10 s after
 *   the hold.)
 *   wallMs    the wall clock across the same tick. Far over `ms`: the Mac
 *             slept and the monotonic clock stood still.
 *   sinceSuspendMs  wall ms since the Mac last said it was going to sleep
 *             (powerMonitor 'suspend'), or null if it hasn't since launch.
 *             Small: the hold came with a sleep.
 *
 * Pure: the clocks and CPU counter are passed in. The wiring is in
 * usage-log-start.ts.
 */

export interface LoopHoldClocks {
  /** Monotonic ms (performance.now). */
  mono: () => number
  /** Wall ms (Date.now). */
  wall: () => number
  /** This process's CPU time in ms, user + system (process.cpuUsage). */
  cpu: () => number
}

export interface LoopHoldReport {
  count: number
  /** The longest hold in the window, monotonic ms. */
  max: number
  /** CPU ms used across the longest hold's tick. */
  cpuMs: number
  /** Wall ms across the longest hold's tick. */
  wallMs: number
  /** Wall ms since the Mac last said it was going to sleep; null if never since launch. */
  sinceSuspendMs: number | null
}

export interface LoopHoldMeter {
  /** Called every tickMs by an interval timer. */
  tick: () => void
  /** The Mac said it is going to sleep. */
  suspend: () => void
  /** The window's holds, or null when there were none; starts a new window. */
  take: () => LoopHoldReport | null
}

export function createLoopHoldMeter(clocks: LoopHoldClocks, tickMs: number, heldMs: number): LoopHoldMeter {
  let lastMono = clocks.mono()
  let lastWall = clocks.wall()
  let lastCpu = clocks.cpu()
  let count = 0
  let max = 0
  let cpuMs = 0
  let wallMs = 0
  let suspendedAt: number | null = null
  return {
    tick() {
      const mono = clocks.mono()
      const wall = clocks.wall()
      const cpu = clocks.cpu()
      const late = mono - lastMono - tickMs
      if (late > heldMs) {
        count++
        if (late > max) {
          max = Math.round(late)
          cpuMs = Math.max(0, Math.round(cpu - lastCpu))
          wallMs = Math.max(0, Math.round(wall - lastWall))
        }
      }
      lastMono = mono
      lastWall = wall
      lastCpu = cpu
    },
    suspend() { suspendedAt = clocks.wall() },
    take() {
      if (!count) return null
      const sinceSuspendMs = suspendedAt === null ? null : Math.max(0, Math.round(clocks.wall() - suspendedAt))
      const out = { count, max, cpuMs, wallMs, sinceSuspendMs }
      count = 0; max = 0; cpuMs = 0; wallMs = 0
      return out
    },
  }
}
