/**
 * The progress bar while a finger (mouse) is on it (V7 steady, 2026-11-24).
 * Dragging moves only the knob; the song is sought once, on release. A click is
 * a press and a release in one place, so it still seeks there.
 */
export interface ScrubState { dragging: boolean; pct: number }

export const scrubIdle: ScrubState = { dragging: false, pct: 0 }

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0)

export type ScrubEvent =
  | { type: 'down'; pct: number }
  | { type: 'move'; pct: number }
  | { type: 'up'; pct: number }
  | { type: 'cancel' }

/** Next state, and the one position to seek to (only ever on 'up'). */
export function scrub(s: ScrubState, e: ScrubEvent): { state: ScrubState; seekTo: number | null } {
  switch (e.type) {
    case 'down': return { state: { dragging: true, pct: clamp01(e.pct) }, seekTo: null }
    case 'move': return s.dragging ? { state: { dragging: true, pct: clamp01(e.pct) }, seekTo: null } : { state: s, seekTo: null }
    case 'up': return s.dragging ? { state: scrubIdle, seekTo: clamp01(e.pct) } : { state: s, seekTo: null }
    case 'cancel': return { state: scrubIdle, seekTo: null }
  }
}

/** Where the knob is drawn: the drag while dragging, else the song. */
export function knobPct(s: ScrubState, position: number, duration: number): number {
  if (s.dragging) return s.pct
  return duration > 0 ? clamp01(position / duration) : 0
}
