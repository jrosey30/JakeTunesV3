/**
 * The volume's small rules (V7 steady, 2026-11-24).
 *
 * - One step everywhere: the menu and the arrow keys move it by VOLUME_STEP.
 * - Mute remembers: the speaker icon mutes, and pressed again brings back the
 *   level it was at.
 * - Ducking is its own stage: while the Music Man talks the music is multiplied
 *   by a duck level; Jake's own volume (the slider, the saved value) is never
 *   touched by it.
 */
export const VOLUME_STEP = 0.05
/** How far the music goes down under the host's voice. */
export const DUCK_LEVEL = 0.15

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0)

/** The volume one step (5%) up (dir 1) or down (dir -1), rounded to 1% so
 *  repeated steps never drift. */
export function stepVolume(v: number, dir: 1 | -1): number {
  const next = clamp01(v) + dir * VOLUME_STEP
  return clamp01(Math.round(next * 100) / 100)
}

/** Below this a level is not worth coming back to (a slider dragged to ~1%). */
export const MUTE_RESTORE_FLOOR = 0.1
/** What unmute gives when there is nothing sensible to come back to. */
export const MUTE_RESTORE_DEFAULT = 0.5

/** The level to remember, given the one remembered and a new candidate
 *  (the level when mute is pressed, or where the slider was let go). */
export function rememberLevel(remembered: number, candidate: number): number {
  return candidate >= MUTE_RESTORE_FLOOR ? clamp01(candidate) : remembered
}

/** What the speaker icon does. `lastAudible` is the level to come back to. */
export function toggleMute(volume: number, lastAudible: number): { volume: number; lastAudible: number } {
  if (volume > 0) return { volume: 0, lastAudible: rememberLevel(lastAudible, volume) }
  const back = lastAudible >= MUTE_RESTORE_FLOOR ? clamp01(lastAudible) : MUTE_RESTORE_DEFAULT
  return { volume: back, lastAudible: back }
}

/** What the speakers get: Jake's volume times the duck. */
export function outputVolume(userVolume: number, duck: number): number {
  return clamp01(userVolume) * clamp01(duck)
}

/** A duck with no voice over it for this long is lifted (a talk path that
 *  returned early, a clip that never played). */
export const DUCK_ORPHAN_MS = 10_000

/** The duck watchdog, one look. `quietSince` is when the duck was first seen
 *  with no voice playing (null: not quiet). Returns the new quietSince and
 *  whether to lift the duck now. */
export function duckWatch(quietSince: number | null, duck: number, voicePlaying: boolean, now: number): { quietSince: number | null; lift: boolean } {
  if (duck >= 1 || voicePlaying) return { quietSince: null, lift: false }
  const since = quietSince ?? now
  if (now - since >= DUCK_ORPHAN_MS) return { quietSince: null, lift: true }
  return { quietSince: since, lift: false }
}

/** The duck level at `step` of `steps` going from `from` to `to` (linear). */
export function duckAt(from: number, to: number, step: number, steps: number): number {
  if (step >= steps) return to
  return from + (to - from) * (step / steps)
}
