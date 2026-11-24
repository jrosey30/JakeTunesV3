/**
 * What the DJ page shows, reduced to what a person can SEE change.
 *
 * The decks move every animation frame. The page used to put the playheads in
 * React state on every frame, so the whole 1,000-line view rendered 60 (or 120)
 * times a second while a deck played. The usage log counted the cost: 2,360
 * renderer long tasks in 10 days.
 *
 * Now the frame loop asks these keys, and the view only renders when a key
 * moves: the coach's words, its countdown to a tenth of a second, its drift
 * meter to a hundredth of a beat, a deck starting or stopping. The waveform
 * draws itself on its own canvas, only when the played edge moves a pixel.
 *
 * Pure, no DOM, no React: tested in src/main/__tests__/dj-frame-gate.test.ts.
 */
import type { CoachAdvice } from './coach'

/** Everything the coach panels print, at the precision they print it. */
export function coachFrameKey(a: CoachAdvice): string {
  const count = typeof a.countdown === 'number' && Number.isFinite(a.countdown)
    ? a.countdown.toFixed(1) : '-'
  const drift = a.drift === undefined ? '-' : a.drift.toFixed(2)
  return `${a.step}|${a.instruction}|${count}|${drift}|${a.nudge ?? '-'}|${a.satisfied ? 1 : 0}`
}

export interface PlayingPair { A: boolean; B: boolean }

/** The same object when nothing changed, so React's setState bails out. */
export function nextPlaying(prev: PlayingPair, A: boolean, B: boolean): PlayingPair {
  return prev.A === A && prev.B === B ? prev : { A, B }
}

/**
 * Everything the waveform canvas depends on. The played edge is whole device
 * pixels: a redraw that moves it less than a pixel draws the same picture.
 */
export function waveFrameKey(o: {
  position: number
  duration: number
  cssWidth: number
  cssHeight: number
  dpr: number
  cuePoint: number
  peaks: number
  bpm: number
  beatOffset: number
}): string {
  const devW = Math.round(o.cssWidth * o.dpr)
  const played = o.duration > 0 ? Math.floor((o.position / o.duration) * devW) : 0
  return `${played}|${devW}|${Math.round(o.cssHeight * o.dpr)}|${o.duration}|${o.cuePoint}|${o.peaks}|${o.bpm}|${o.beatOffset}`
}
