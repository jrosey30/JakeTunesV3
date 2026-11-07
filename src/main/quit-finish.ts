/**
 * How the app leaves (2026-11-06, the away-from-home audit).
 *
 * Node's teardown waits for all thread-pool work, and a thread stuck in a file call
 * never lets go. On 11/5 a quit hung 21 minutes on one NAS write: Quit accepted
 * 23:52:42, user code gone 23:59:42, launchd let go 00:13:48. The install gate had
 * given up by then and left the Mac with no app running. Measured with a scratch
 * Electron 30 and one pool thread parked in open() on a FIFO: still alive after 25 s
 * the normal way, gone in under a second this way.
 *
 * So the app says what it has to say, then kills itself, the same idea as the hub's
 * hardExit (⚠️ TWIN: JakeTunesMobile backend/src/util/shutdown.ts). A hard kill skips
 * Chromium's own teardown, and that is where its storage gets committed: the same
 * scratch run with no flush lost both a cookie and a localStorage key, every time.
 * With flushStorageData + cookies.flushStore both survived. flushStorageData has no
 * completion signal, hence the short grace. Everything is bounded, because a save or a
 * flush that never settles is exactly the kind of thing this exists to outlast.
 *
 * A write already in the kernel still has to finish (state E until the SMB dead timer,
 * up to 10 minutes), but no user code waits on it, and the install gate counts that
 * state as quit (scripts/install/jaketunes-install-gate.sh). Away from home there
 * should be no such write: nasAvailable() says no without a stat.
 *
 * It runs from will-quit: every window is closed. before-quit has started flushing the
 * sidecar caches, and on a second Cmd-Q will-quit can get here while that still runs, so
 * the flush is one of the things waited for. The sync child stays out of it. It is detached
 * by design, it outlives a quit, and signalling it can cut a publish.
 *
 * The one quit that does not kill itself is a quit during an iPod sync: leaveFor.
 */

/** Grace after the flushes: flushStorageData can't say when it is done. */
export const QUIT_GRACE_MS = 300
/** The whole of it, whatever does not settle. */
export const QUIT_BOUND_MS = 4000

export function createQuitFinish(deps: {
  flushStorage: () => void
  flushCookies: () => Promise<unknown>
  /** The library save in flight, if any. Local disk: normally a moment. */
  librarySaved: () => Promise<unknown>
  /** before-quit's sidecar flush, if one is still running. */
  sidecarsFlushed: () => Promise<unknown>
  leave: () => void
  log?: (message: string) => void
  graceMs?: number
  boundMs?: number
}): () => void {
  const log = deps.log ?? ((m: string) => console.warn(m))
  const graceMs = deps.graceMs ?? QUIT_GRACE_MS
  const boundMs = deps.boundMs ?? QUIT_BOUND_MS
  let started = false
  return () => {
    if (started) return   // a second Cmd-Q while this runs is the same quit
    started = true
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    try { deps.flushStorage() } catch (err) { log(`[quit] storage flush failed: ${err instanceof Error ? err.message : err}`) }
    const settle = (what: string, p: () => Promise<unknown>): Promise<unknown> =>
      Promise.resolve().then(p).catch((err) => log(`[quit] ${what} failed: ${err instanceof Error ? err.message : err}`))
    const settled = Promise.all([
      settle('cookie flush', deps.flushCookies),
      settle('library save', deps.librarySaved),
      settle('sidecar flush', deps.sidecarsFlushed),
      sleep(graceMs),
    ]).then(() => 'settled')
    void Promise.race([settled, sleep(boundMs).then(() => 'bound')]).then((how) => {
      if (how === 'bound') log(`[quit] flushes did not settle within ${boundMs} ms — leaving anyway`)
      deps.leave()
    })
  }
}

/**
 * How to leave, asked at the moment of leaving. The iPod engine copies straight to the song's final
 * name, so a kill during a sync leaves a torn song on the card, and it can tear the catalog the
 * next sync uses as its template. The normal exit lets the copy in flight finish, as every quit
 * did before 2026-11-06. Measured on a windowless scratch Electron 30.5.1 with a 900 MB copy under
 * way: app.exit(0) ended with the whole file, 3 of 3, in 0.9 to 2.8 s; SIGKILL left 82 MB and 134 MB.
 * The cost: with a pool thread stuck for good, app.exit was still waiting 15 s on (the same run), so
 * a sync and a hung file call together wait as the old quit did. The install gate won't quit during
 * a sync at all, so this is Cmd-Q, or a quit by hand.
 */
export function leaveFor(deps: {
  syncInFlight: () => boolean
  exitNormally: () => void
  kill: () => void
}): () => void {
  return () => { if (deps.syncInFlight()) deps.exitNormally(); else deps.kill() }
}

/**
 * Leave without waiting for anything: SIGKILL on ourselves skips libuv's threadpool
 * join. process.exit() is the fallback if the signal cannot be sent.
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/shutdown.ts hardExit
 */
export function hardExit(): void {
  try {
    process.kill(process.pid, 'SIGKILL')
  } catch {
    process.exit(0)
  }
}
