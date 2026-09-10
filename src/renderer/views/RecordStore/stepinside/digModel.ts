/**
 * The dig — pure state, no three.js, no React.
 *
 * Digging is not a carousel. In a real crate you push sleeves forward one
 * at a time, you can't wrap around from the last to the first, and pulling
 * one out is a separate act from flipping past it. Those three rules are
 * the whole feel, so they live here where they can be tested.
 */
import type { DigState } from './types'

export const digStart = (): DigState => ({ index: 0, pulled: false })

/** Flip one sleeve forward or back. Clamped — a crate has a front and a
 *  back, and hitting either is information ("that's the whole bin"). */
export function digFlip(state: DigState, delta: number, count: number): DigState {
  if (count <= 0) return { index: 0, pulled: false }
  const next = Math.min(count - 1, Math.max(0, state.index + delta))
  // Flipping past a record you'd pulled out puts it back first.
  return next === state.index ? state : { index: next, pulled: false }
}

/** Pull the current sleeve out to read the back, or slide it back in. */
export function digTogglePull(state: DigState): DigState {
  return { ...state, pulled: !state.pulled }
}

/** How far through the crate you are, for the HUD. 1-based. */
export function digPosition(state: DigState, count: number): { at: number; of: number } {
  return { at: count === 0 ? 0 : state.index + 1, of: count }
}

/** True when the flip would hit a wall — the UI uses it to resist rather
 *  than silently ignore the key, so the crate has ends you can feel. */
export function digAtEdge(state: DigState, count: number): 'front' | 'back' | null {
  if (count <= 0) return null
  if (state.index <= 0) return 'front'
  if (state.index >= count - 1) return 'back'
  return null
}
