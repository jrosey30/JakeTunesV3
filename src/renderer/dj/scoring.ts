// Explicit .ts: these modules run under node --experimental-strip-types in the
// test suite, which does not do extensionless resolution. Vite is fine with it.
import { beatsInRange } from './beatgrid.ts'

/**
 * Challenge mode: the scored layer that sits on top of the decks.
 *
 * Deliberately pure. The engine reports "the user did X at time T", this decides
 * what that was worth, and the view draws the result. Keeping judgement out of
 * the audio callback means scoring can be tested exactly, and a bug in the game
 * can never stall the sound.
 */

export type DJAction = 'crossfade' | 'bass-kill' | 'filter' | 'cue-drop'

export interface Prompt {
  id: number
  /** Deck-time in seconds when this should be performed. */
  time: number
  action: DJAction
  /** Which deck the move applies to. */
  deck: 'A' | 'B'
}

export type Verdict = 'perfect' | 'great' | 'good' | 'miss'

/**
 * Timing windows, in seconds.
 *
 * A beat at 128 BPM is 469 ms, and a sixteenth is 117 ms. PERFECT at 45 ms is
 * tight enough that landing it means you actually heard the beat rather than
 * mashed near it; MISS past 180 ms is roughly "closer to the next subdivision
 * than to this one", which is the point at which a listener hears it as wrong.
 */
export const WINDOWS: Record<Exclude<Verdict, 'miss'>, number> = {
  perfect: 0.045,
  great: 0.090,
  good: 0.180,
}

export const POINTS: Record<Verdict, number> = {
  perfect: 100,
  great: 60,
  good: 25,
  miss: 0,
}

export function judge(deltaSeconds: number): Verdict {
  const d = Math.abs(deltaSeconds)
  if (d <= WINDOWS.perfect) return 'perfect'
  if (d <= WINDOWS.great) return 'great'
  if (d <= WINDOWS.good) return 'good'
  return 'miss'
}

/**
 * Streak multiplier. Caps at 4x — past that the last thirty seconds of a good
 * run decide the whole score and everything before it stops mattering.
 */
export function multiplierFor(streak: number): number {
  if (streak >= 32) return 4
  if (streak >= 16) return 3
  if (streak >= 8) return 2
  return 1
}

export interface RunState {
  score: number
  streak: number
  best: number
  hits: Record<Verdict, number>
}

export function emptyRun(): RunState {
  return { score: 0, streak: 0, best: 0, hits: { perfect: 0, great: 0, good: 0, miss: 0 } }
}

/** Apply one judged action. Returns a NEW state — no mutation, so React sees it. */
export function applyHit(state: RunState, verdict: Verdict): RunState {
  const streak = verdict === 'miss' ? 0 : state.streak + 1
  return {
    score: state.score + POINTS[verdict] * multiplierFor(state.streak),
    streak,
    best: Math.max(state.best, streak),
    hits: { ...state.hits, [verdict]: state.hits[verdict] + 1 },
  }
}

/** Accuracy as a percentage of the maximum available for the prompts attempted. */
export function accuracy(state: RunState): number {
  const attempted = Object.values(state.hits).reduce((a, b) => a + b, 0)
  if (attempted === 0) return 0
  const earned = (Object.keys(POINTS) as Verdict[])
    .reduce((sum, v) => sum + POINTS[v] * state.hits[v], 0)
  return Math.round((earned / (attempted * POINTS.perfect)) * 100)
}

/**
 * Lay out a run's prompts over a stretch of a track.
 *
 * Placed on PHRASE boundaries rather than sprinkled over beats. Dance music is
 * built in 4-bar and 8-bar phrases, and the moves a DJ actually makes — dropping
 * the bass, throwing the crossfader, opening a filter — happen at those seams.
 * Prompts on random beats would teach bad habits and feel arbitrary; on phrase
 * lines the game is practising the real thing.
 *
 * `beatsPerBar` is 4 for essentially everything in this library; it's a
 * parameter rather than a constant so odd-meter tracks don't silently get a
 * grid that doesn't fit them.
 */
export function buildPrompts(opts: {
  bpm: number
  offset?: number
  from: number
  to: number
  deck: 'A' | 'B'
  beatsPerBar?: number
  /** Phrase length in bars between prompts. 4 = busy, 8 = musical, 16 = sparse. */
  barsPerPhrase?: number
}): Prompt[] {
  const { bpm, offset = 0, from, to, deck } = opts
  const beatsPerBar = opts.beatsPerBar ?? 4
  const barsPerPhrase = opts.barsPerPhrase ?? 4
  const stride = beatsPerBar * barsPerPhrase
  const beats = beatsInRange(from, to, bpm, offset)
  // Rotate through the moves so a run exercises the whole controller rather
  // than hammering one key.
  const cycle: DJAction[] = ['bass-kill', 'crossfade', 'filter', 'cue-drop']
  const out: Prompt[] = []
  for (let i = 0; i < beats.length; i += stride) {
    out.push({
      id: out.length,
      time: beats[i],
      action: cycle[out.length % cycle.length],
      deck,
    })
  }
  return out
}

/**
 * Match a player input to the prompt it was aiming at: the nearest unresolved
 * prompt of that action within the widest window.
 *
 * Matching on action as well as time matters — otherwise hitting the bass kill
 * early would "consume" the crossfade prompt sitting next to it and the run
 * would desync from the chart.
 */
export function matchPrompt(
  prompts: Prompt[],
  resolved: ReadonlySet<number>,
  action: DJAction,
  atTime: number,
): Prompt | null {
  let best: Prompt | null = null
  let bestD = Infinity
  for (const p of prompts) {
    if (p.action !== action || resolved.has(p.id)) continue
    const d = Math.abs(p.time - atTime)
    if (d < bestD) { bestD = d; best = p }
  }
  return best && bestD <= WINDOWS.good ? best : null
}
