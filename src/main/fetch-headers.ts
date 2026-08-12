/**
 * Fetch helpers for the streaming playback path.
 *
 * Jake, 2026-08-11: workmini still needed a restart for "certain songs."
 * Root cause of that leftover: AbortSignal.timeout(N) on fetch() aborts the
 * WHOLE response — including the body stream after headers have already
 * returned. A 7-minute ALAC→FLAC transfer that took 9s of wall clock to
 * finish buffering was cut mid-stream; Howler sat dead until relaunch.
 * After restart homemini often had the FLAC cached, so the same song worked.
 *
 * Rule: a header deadline may abort the wait for status/headers. Once the
 * Response exists, clear the timer and let the body stream for as long as
 * Chromium needs it.
 */

/**
 * Like fetch(), but `headerTimeoutMs` only covers the wait until headers
 * arrive. The returned body's stream is never aborted by that timer.
 */
export async function fetchHeadersWithin(
  url: string,
  init: RequestInit | undefined,
  headerTimeoutMs: number,
): Promise<Response> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), headerTimeoutMs)

  // Honor a caller-supplied signal too (pin/identity checks, etc.).
  const onCallerAbort = () => ac.abort()
  const caller = init?.signal
  if (caller) {
    if (caller.aborted) {
      clearTimeout(timer)
      ac.abort()
    } else {
      caller.addEventListener('abort', onCallerAbort, { once: true })
    }
  }

  try {
    const res = await fetch(url, { ...init, signal: ac.signal })
    clearTimeout(timer)
    if (caller) caller.removeEventListener('abort', onCallerAbort)
    return res
  } catch (err) {
    clearTimeout(timer)
    if (caller) caller.removeEventListener('abort', onCallerAbort)
    throw err
  }
}
