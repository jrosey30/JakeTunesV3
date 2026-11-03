/**
 * The launch song, scored to the logo lineage (2026-11-03).
 *
 * Jake: "the launching page song needs to flow better with the logo
 * evolution." The welcome — E3 · G#3 · B3 rising into an E major(add9) bloom
 * in a hall, with a riser under it (v5 "warm, inviting, musical", then the
 * 2026-08-09 theatre pass) — was written for a boot with ONE mark. Once the
 * boot became five marks it was simply started 1.18 s late so its chord still
 * met the note's light: the portrait, the cream note and the brush J came and
 * went in silence, and its notes moved every 280 ms while the marks moved
 * every 460 ms. Two clocks, two tempos.
 *
 * Now every mark has its note, on the beat the mark dissolves in, and the
 * melody Jake knows simply carries on up through the marks that came after:
 *
 *   portrait    E3   the welcome's own warm voice, alone; the low E pedal and
 *                    the riser begin under it and swell for the whole lineage
 *   cream note  G#3  + a music-box tine — a paper note, plucked
 *   brush J     B3   + a soft brush stroke sweeping across the stage
 *   pixel iPod  E4   + the click wheel's tick and a soft 8-bit square
 *   pixel note  G#4  + the 8-bit square again, brighter — today's mark
 *   the light   the same E major(add9) bloom, with an 8-bit glint in the bells
 *
 * Each note rings on under the next (the same decay for every one, so the
 * line reads as one gesture, not five blips), the colour of the sound evolves
 * the way the marks do — warm, then plucked, then brushed, then pixel — and
 * the chord's attack peaks exactly on the note's light. Every time here comes
 * from the boot's clock in splash-eras.ts.
 *
 * Pure (no Web Audio): the cue sheet, unit-tested in
 * src/main/__tests__/splash-score.test.ts. introStinger.ts plays it.
 */
import { SPLASH_ERAS, T_LIT, eraStartMs, type SplashEra } from './splash-eras.ts'

/** The colour a note is played with — the sound of its era's mark. */
export type CueColor = 'warm' | 'music-box' | 'brush' | 'chip' | 'pixel'

export interface SongCue {
  era: SplashEra['key']
  /** When the note starts, ms on the boot's clock. */
  atMs: number
  /** Scientific pitch name, for the reader. */
  note: string
  /** Hz. */
  freq: number
  color: CueColor
  /** -1 (left) … 1 (right). */
  pan: number
  /** Peak level of the warm core, before the master. */
  peak: number
}

export interface LaunchScore {
  cues: SongCue[]
  /** When the chord starts, ms on the boot's clock. */
  bloomAtMs: number
  /** How long every melody note rings, from its own start. */
  ringMs: number
  /** When the song is over (its audio context may close), ms on the boot's clock. */
  endMs: number
}

/** A note starts this far into its mark's dissolve, so its ~40 ms attack
 *  peaks as the mark is half in. */
export const NOTE_ONSET_MS = 40
/** The chord's attack (as the voices are built) — it starts this much before
 *  the note's light so it PEAKS on the light, as the one-mark boot did. */
export const BLOOM_ATTACK_MS = 40
/** Every melody note rings this long — one decay for all, so the line flows. */
export const NOTE_RING_MS = 4200
/** The bloom's curtain: the master is silent this long after the chord. */
export const BLOOM_TAIL_MS = 4400

/** The welcome's melody, one note per mark, oldest mark first. The first three
 *  are the pitches Jake has heard since June; the line carries on up the E
 *  major triad through the two marks that came after. */
const MELODY: ReadonlyArray<Omit<SongCue, 'era' | 'atMs'>> = [
  { note: 'E3', freq: 164.81, color: 'warm', pan: -0.28, peak: 0.15 },
  { note: 'G#3', freq: 207.65, color: 'music-box', pan: 0.3, peak: 0.145 },
  { note: 'B3', freq: 246.94, color: 'brush', pan: -0.12, peak: 0.14 },
  { note: 'E4', freq: 329.63, color: 'chip', pan: 0.22, peak: 0.13 },
  { note: 'G#4', freq: 415.3, color: 'pixel', pan: -0.18, peak: 0.12 },
]

/** What the audio clock reports when the song is scheduled. */
export interface AudioClockReading {
  /** AudioContext.getOutputTimestamp(): the context time now leaving the speakers … */
  contextTime: number
  /** … and the performance time it is heard at; 0 while the device has not started. */
  performanceTime: number
  /** AudioContext.currentTime. */
  currentTime: number
  /** performance.now() at the reading. */
  nowPerfMs: number
}

/**
 * The audio-clock time of the boot's 0 — the t0 the song is built at.
 *
 * With a live output timestamp the mapping is exact (it pairs a context time
 * with the performance time it is HEARD at, so output latency is absorbed);
 * without one it falls back to currentTime. Two clamps, both learned the hard
 * way (2026-11-03, harness): a NEGATIVE time makes Web Audio throw, and the
 * song silently did not play at all when the context was young; and a first
 * note already in the past would start clipped, so the song shifts just
 * enough to start whole.
 */
export function songOrigin(clock: AudioClockReading, bootStartPerfMs: number, firstCueMs: number): number {
  const mapped = clock.performanceTime > 0
    ? clock.contextTime + (bootStartPerfMs - clock.performanceTime) / 1000
    : clock.currentTime - (clock.nowPerfMs - bootStartPerfMs) / 1000
  return Math.max(0, mapped, clock.currentTime + 0.02 - firstCueMs / 1000)
}

export function launchScore(): LaunchScore {
  if (MELODY.length !== SPLASH_ERAS.length) {
    throw new Error(`splash-score: ${MELODY.length} notes for ${SPLASH_ERAS.length} marks`)
  }
  const cues = SPLASH_ERAS.map((era, i) => ({
    era: era.key,
    atMs: eraStartMs(i) + NOTE_ONSET_MS,
    ...MELODY[i]!,
  }))
  const bloomAtMs = T_LIT - BLOOM_ATTACK_MS
  return { cues, bloomAtMs, ringMs: NOTE_RING_MS, endMs: bloomAtMs + BLOOM_TAIL_MS + 300 }
}
