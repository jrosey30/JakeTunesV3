/**
 * Stream-convert does not give up while the app is running.
 *
 * The first half hour retries on the worker interval (homemini/NAS
 * propagation is usually a minute or two). After that, a miss is
 * scheduled again one period later. The queue item stays. Dropping it
 * left the file on the laptop until the next boot.
 */

export interface StreamConvertRetryItem {
  enqueuedAt: number
  retryAfter?: number
  /** Misses so far that set a retry (2026-11-09): each doubles the wait. */
  tries?: number
}

/** The longest wait between tries. */
export const STREAM_CONVERT_MAX_WAIT_MS = 24 * 60 * 60 * 1000

/**
 * How long to wait after a miss. A try downloads the whole file from homemini
 * to compare it. At a flat 30 minutes, 105 songs whose two copies will not
 * match until one is replaced cost 80 to 107 GB a day, every day from at least
 * 2026-11-02 to 11-09 (homemini's log). So: 30 min, 1 h, 2 h ... up to a day.
 */
export function streamConvertWaitMs(tries: number, periodMs: number): number {
  const n = Number.isFinite(tries) && tries > 0 ? Math.min(Math.floor(tries), 20) : 0
  return Math.min(periodMs * 2 ** n, Math.max(periodMs, STREAM_CONVERT_MAX_WAIT_MS))
}

export function decideStreamConvertAttempt(item: { retryAfter?: number }, now: number): 'wait' | 'try' {
  if (item.retryAfter != null && now < item.retryAfter) return 'wait'
  return 'try'
}

export function decideStreamConvertMiss<T extends StreamConvertRetryItem>(
  item: T,
  now: number,
  maxAgeMs: number,
): { item: T; rescheduled: boolean } {
  const due = item.retryAfter != null && now >= item.retryAfter
  const agedOut = now - item.enqueuedAt > maxAgeMs
  if (!due && !agedOut) return { item, rescheduled: false }
  return {
    item: { ...item, retryAfter: now + streamConvertWaitMs(item.tries ?? 0, maxAgeMs), tries: (item.tries ?? 0) + 1 },
    rescheduled: true,
  }
}
