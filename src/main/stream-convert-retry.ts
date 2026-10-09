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
    item: { ...item, retryAfter: now + maxAgeMs },
    rescheduled: true,
  }
}
