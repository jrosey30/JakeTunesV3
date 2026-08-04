import {
  isPhaseLocked, phaseDelta, secondsToNextPhrase, tempoDistance, camelotCompatible,
} from './beatgrid.ts'

/**
 * The coach: what to do next, and why.
 *
 * Pure. It takes a reading of both decks and returns the one instruction that
 * matters right now. Keeping it out of the view means the teaching can be
 * tested — you can assert that a deck running early is told to slow down,
 * which is exactly the kind of thing that silently inverts and then teaches
 * someone the wrong reflex for a month.
 *
 * The order of steps is the order the craft is actually learned:
 *   1. get a record on the other deck
 *   2. find its first downbeat (cue)
 *   3. match the tempo
 *   4. match the PHASE — the part nobody can see, and the part that separates
 *      a mix from a car crash
 *   5. bring it in with the bass out of the way
 *   6. swap the low end over
 *   7. finish the fade
 */

export type CoachStepId =
  | 'load' | 'cue' | 'tempo' | 'phase' | 'bring-in' | 'bass-swap' | 'complete' | 'idle'

export interface DeckReading {
  loaded: boolean
  playing: boolean
  position: number
  bpm: number
  beatOffset: number
  rate: number
  camelotKey?: string
  bassKilled: boolean
}

export interface CoachAdvice {
  step: CoachStepId
  /** One line, imperative. What to do. */
  instruction: string
  /** One line. Why it matters — the part that actually teaches. */
  why: string
  /** Live nudge direction when phase-matching: -1 slow down, +1 speed up, 0 locked. */
  nudge?: -1 | 0 | 1
  /** Beats of drift, signed, when phase-matching. */
  drift?: number
  /** Seconds to the next phrase line, when the move should land on one. */
  countdown?: number
  /** True when this step is satisfied and the next press should advance. */
  satisfied: boolean
}

const TEMPO_OK = 0.005   // half a percent apart is inaudible over a blend

export function advise(live: DeckReading, incoming: DeckReading): CoachAdvice {
  if (!live.loaded && !incoming.loaded) {
    return {
      step: 'idle',
      instruction: 'Pick a song to start with.',
      why: 'This is the one that will already be playing when you mix the next track in. Everything else gets matched to it, so pick something you know well.',
      satisfied: false,
    }
  }

  if (!incoming.loaded) {
    return {
      step: 'load',
      instruction: 'Now pick the song to mix into.',
      why: 'Drag one in from the list below, or click it. That list is already filtered to tracks close enough in speed to blend, in keys that will not clash with what is playing.',
      satisfied: false,
    }
  }

  if (live.loaded && !live.playing && !incoming.playing) {
    return {
      step: 'idle',
      instruction: 'Press play to start it.',
      why: 'You always mix FROM something. Get this one going first, then we bring the next one in underneath it.',
      satisfied: false,
    }
  }

  // Tempo first: phase-matching against a different tempo is pointless, because
  // whatever you align drifts apart again within a bar.
  const liveEff = live.bpm * live.rate
  const inEff = incoming.bpm * incoming.rate
  const tempoOff = tempoDistance(liveEff, inEff)
  if (tempoOff > TEMPO_OK) {
    const faster = inEff > liveEff
    return {
      step: 'tempo',
      instruction: `Press SYNC on the other deck — it is running ${Math.abs(inEff - liveEff).toFixed(1)} BPM too ${faster ? 'fast' : 'slow'}.`,
      why: 'Get both tracks to the same speed first. If they differ even slightly, anything you line up now slides apart again a few seconds later.',
      satisfied: false,
    }
  }

  if (!incoming.playing) {
    const c = secondsToNextPhrase(live.position, live.bpm, live.beatOffset)
    return {
      step: 'cue',
      instruction: 'Wait for the counter to reach zero, then press PLAY on the other deck.',
      why: 'Tracks are built out of repeating blocks of 16 beats. Starting the next one exactly as a new block begins is what makes a mix sound deliberate instead of dropped on top. The counter is the time until the next one.',
      countdown: c,
      satisfied: c < 0.25,
    }
  }

  // Both running at the same tempo — now the real lesson.
  const drift = phaseDelta(
    live.position, live.bpm, live.beatOffset,
    incoming.position, incoming.bpm, incoming.beatOffset,
  )
  if (!isPhaseLocked(drift)) {
    return {
      step: 'phase',
      instruction: drift > 0
        ? 'The new track is dragging behind — hold NUDGE + until the meter turns green.'
        : 'The new track is running ahead — hold NUDGE − until the meter turns green.',
      why: 'Same speed is not the same as in step. Both tracks can sit at an identical BPM and still have their beats landing at different moments, which your ear hears as a stumble. Nudge shoves this one forward or back until they land together.',
      nudge: drift > 0 ? 1 : -1,
      drift,
      satisfied: false,
    }
  }

  if (!incoming.bassKilled) {
    return {
      step: 'bring-in',
      instruction: 'Mute the bass on the new track (its LOW button), then slide the crossfader toward it.',
      why: 'Two basslines at once turn to mud — they fight each other and everything gets loud and shapeless. Mute the low end on the incoming track and you can have both playing together and still hear each one clearly.',
      drift,
      nudge: 0,
      satisfied: false,
    }
  }

  const c = secondsToNextPhrase(live.position, live.bpm, live.beatOffset)
  return {
    step: 'bass-swap',
    instruction: 'At zero, swap the bass over: LOW off on the old track, LOW back on the new one.',
    why: 'This is the moment the mix actually turns over. The low end is what your ear follows, so whichever track has the bass is the one people think is playing. Do it as a new block starts and the handover sounds intended.',
    countdown: c,
    drift,
    nudge: 0,
    satisfied: c < 0.25,
  }
}

/**
 * A pre-flight read on a pairing, shown before you commit to it. Separate from
 * the step-by-step because it answers a different question: not "what now" but
 * "is this even a good idea".
 */
export function assessPairing(a: { bpm?: number; camelotKey?: string }, b: { bpm?: number; camelotKey?: string }): {
  ok: boolean
  tempoNote: string
  keyNote: string
} {
  const ta = Number(a.bpm) || 0
  const tb = Number(b.bpm) || 0
  const d = tempoDistance(ta, tb)
  const pct = Number.isFinite(d) ? d * 100 : Infinity
  const tempoNote = !Number.isFinite(pct)
    ? 'Tempo unknown for one of these.'
    : pct < 2 ? `${pct.toFixed(1)}% apart — an easy blend.`
    : pct < 6 ? `${pct.toFixed(1)}% apart — sync will handle it, but you will hear the pitch move.`
    : `${pct.toFixed(1)}% apart — too far. Pitching this much changes how the record sounds.`
  const harmonic = camelotCompatible(a.camelotKey, b.camelotKey)
  const keyNote = !a.camelotKey || !b.camelotKey
    ? 'Key unknown for one of these.'
    : harmonic
      ? `${a.camelotKey} into ${b.camelotKey} — harmonically compatible.`
      : `${a.camelotKey} into ${b.camelotKey} — these clash. Fine under a bass swap, rough if both are exposed.`
  return { ok: Number.isFinite(pct) && pct < 6 && harmonic, tempoNote, keyNote }
}
