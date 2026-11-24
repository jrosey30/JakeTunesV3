/**
 * One seek at a time (V7 steady, 2026-11-24). Twin of the iPhone's SeekChase.
 *
 * A song streamed from homemini answers a seek with a new Range request. Handing
 * the element a second seek while the first still waits on its bytes cancels that
 * request and starts another: a hole in the sound at each, and nothing lands
 * ("glitches everywhere"). So:
 *   - with nothing in flight, a position goes over at once;
 *   - while one is in flight, only the NEWEST position waits, and goes over once
 *     the element answers (`landed`);
 *   - a seek with no answer for STALE_MS is replaced by the next request;
 *   - a waiting position belongs to the song it was asked for (`key`): it is
 *     never handed to the next song.
 * Pure: the caller owns the clock, the element and the timers.
 */
export const SEEK_STALE_MS = 2000

export interface SeekChaseState<K> {
  inFlight: { pos: number; key: K; at: number } | null
  pending: { pos: number; key: K } | null
}

export function newSeekChase<K>(): SeekChaseState<K> {
  return { inFlight: null, pending: null }
}

/** A position is asked for. Returns the position to hand the element now, or null (it waits). */
export function requestSeek<K>(s: SeekChaseState<K>, pos: number, key: K, now: number): number | null {
  const busy = s.inFlight && s.inFlight.key === key && now - s.inFlight.at < SEEK_STALE_MS
  if (busy) {
    s.pending = { pos, key }
    return null
  }
  s.inFlight = { pos, key, at: now }
  s.pending = null
  return pos
}

/** The element answered the seek in flight for `key` (or its timer gave up).
 *  Returns the waiting position to hand over now, or null. */
export function seekLanded<K>(s: SeekChaseState<K>, key: K, now: number): number | null {
  if (s.inFlight && s.inFlight.key !== key) return null // an old song's answer
  s.inFlight = null
  const p = s.pending
  s.pending = null
  if (!p) return null // a waiting position always shares the in-flight key (requestSeek)
  s.inFlight = { pos: p.pos, key, at: now }
  return p.pos
}
