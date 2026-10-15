/**
 * Brief 161 — body inactivity timeout for streamed playback bodies.
 *
 * fetchHeadersWithin (fetch-headers.ts) budgets only the wait for
 * headers — by design, because an AbortSignal on the whole response
 * once cut healthy long transfers mid-body. The hole that left: a
 * stream whose headers arrived and whose body then wedged (homemini
 * alive, link dead, zero bytes forever) hung the track indefinitely.
 * Chromium sat on a body that would never move, Howler never errored,
 * and the song just never played.
 *
 * This wrapper is the other half of the budget: it passes chunks
 * through untouched while bytes flow, and errors the stream after
 * `timeoutMs` of ZERO bytes. Erroring surfaces to the consumer as a
 * load failure — on the desktop that is Brief 160's ending (advance,
 * counted) instead of silence forever. The timer resets on every
 * chunk, so a slow-but-alive stream is never cut: only a dead one.
 *
 * Playback-path only. The background spool (stream-spool.ts) fills at
 * its own pace for later plays and deliberately does NOT use this —
 * its behaviour is unchanged.
 */

export const STREAM_BODY_INACTIVITY_MS = 10_000

/**
 * Wrap a web ReadableStream so it errors after `timeoutMs` without a
 * single chunk. `onTimeout` (optional) fires exactly once, just
 * before the error, for logging at the call site.
 */
export function withBodyInactivityTimeout<T>(
  body: ReadableStream<T>,
  timeoutMs: number = STREAM_BODY_INACTIVITY_MS,
  onTimeout?: () => void,
): ReadableStream<T> {
  const reader = body.getReader()
  let timer: ReturnType<typeof setTimeout> | null = null
  let settled = false

  const clear = (): void => {
    if (timer) { clearTimeout(timer); timer = null }
  }

  const arm = (controller: ReadableStreamDefaultController<T>): void => {
    clear()
    timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { onTimeout?.() } catch { /* an observer must never break the stream */ }
      try {
        controller.error(new Error(`stream body stalled: no bytes for ${timeoutMs}ms`))
      } catch { /* stream already closed/errored — the timeout still stands */ }
      // Release the wedged underlying source; its bytes are unwanted now.
      reader.cancel().catch(() => undefined)
    }, timeoutMs)
    // Deliberately NOT unref'd: the timer is bounded and self-clearing (it
    // fires or is cleared within timeoutMs), and unref'ing it let Node exit
    // while a stalled read was still pending (the tests were cancelled).
  }

  return new ReadableStream<T>({
    start(controller) { arm(controller) },
    async pull(controller) {
      try {
        const { value, done } = await reader.read()
        if (done) {
          settled = true
          clear()
          controller.close()
          return
        }
        arm(controller)
        controller.enqueue(value)
      } catch (err) {
        settled = true
        clear()
        controller.error(err)
      }
    },
    cancel(reason) {
      settled = true
      clear()
      return reader.cancel(reason)
    },
  })
}
