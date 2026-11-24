/**
 * The visualizer's clock, in real seconds.
 *
 * It used to add 0.016 s per animation frame and ease by a fixed amount per
 * frame. On a 120 Hz display that is twice as fast: everything moved at double
 * speed, and the "at most one ring per 0.4 s" photosensitivity limit became
 * one per 0.2 s, five a second, over the WCAG three-flash line it was written
 * to keep. Every rate below is the old per-frame number at 60 fps, applied for
 * the time that really passed, so a 60 Hz screen looks exactly as before.
 *
 * Pure: tested in src/main/__tests__/visualizer-clock.test.ts.
 */

/** Seconds since the last frame, capped so a stalled tab doesn't leap. */
export function frameSeconds(now: number, last: number | null): number {
  if (last == null || !(now > last)) return 1 / 60
  return Math.min(0.1, (now - last) / 1000)
}

/** A per-frame easing step at 60 fps (x += (target - x) * k), for dt seconds. */
export function easeFor(k60: number, dt: number): number {
  return 1 - Math.pow(1 - k60, dt * 60)
}

/** A per-frame multiplier at 60 fps (x *= m), for dt seconds. */
export function decayFor(m60: number, dt: number): number {
  return Math.pow(m60, dt * 60)
}

/** The fewest seconds between two rings: under 3 a second, the WCAG flash limit. */
export const RING_GAP_S = 0.4

export interface BloomState {
  t: number
  bassEnv: number
  bassVis: number
  lastRingT: number
}

export function newBloom(): BloomState {
  return { t: 0, bassEnv: 0, bassVis: 0, lastRingT: -10 }
}

/**
 * Advance the bass follower by dt seconds. Returns true when a ring should be
 * born this frame: a kick above the envelope, and at least RING_GAP_S since the
 * last one by the real clock.
 */
export function stepBloom(s: BloomState, bass: number, dt: number): boolean {
  s.t += dt
  const env = decayFor(0.92, dt)
  s.bassEnv = s.bassEnv * env + bass * (1 - env)
  s.bassVis += (bass - s.bassVis) * easeFor(0.09, dt)
  const kick = Math.max(0, bass - s.bassEnv)
  if (kick > 0.07 && s.t - s.lastRingT > RING_GAP_S) {
    s.lastRingT = s.t
    return true
  }
  return false
}
