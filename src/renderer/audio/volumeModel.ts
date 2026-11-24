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

/** The volume one step up (dir 1) or down (dir -1), on the 5% grid. */
export function stepVolume(v: number, dir: 1 | -1): number {
  const next = clamp01(v) + dir * VOLUME_STEP
  return clamp01(Math.round(next * 100) / 100)
}

/** What the speaker icon does. `lastAudible` is the level before the mute. */
export function toggleMute(volume: number, lastAudible: number): { volume: number; lastAudible: number } {
  if (volume > 0) return { volume: 0, lastAudible: volume }
  const back = lastAudible > 0 ? lastAudible : 0.5
  return { volume: clamp01(back), lastAudible: back }
}

/** What the speakers get: Jake's volume times the duck. */
export function outputVolume(userVolume: number, duck: number): number {
  return clamp01(userVolume) * clamp01(duck)
}

/** The duck level at `step` of `steps` going from `from` to `to` (linear). */
export function duckAt(from: number, to: number, step: number, steps: number): number {
  if (step >= steps) return to
  return from + (to - from) * (step / steps)
}
