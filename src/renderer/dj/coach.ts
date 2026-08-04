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
      instruction: 'Load a track onto deck A and press play.',
      why: 'The deck that is already playing is the one the crowd is hearing. Everything else gets matched to it.',
      satisfied: false,
    }
  }

  if (!incoming.loaded) {
    return {
      step: 'load',
      instruction: 'Load your next track onto the other deck.',
      why: 'Pick one that is close in tempo and harmonically compatible — the list below is filtered to exactly those.',
      satisfied: false,
    }
  }

  if (live.loaded && !live.playing && !incoming.playing) {
    return {
      step: 'idle',
      instruction: 'Press play on the deck you want to mix out of.',
      why: 'You always mix FROM something. Start the record that is already out there.',
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
      instruction: `Press SYNC on the incoming deck${faster ? '' : ''} — it is ${Math.abs(inEff - liveEff).toFixed(1)} BPM ${faster ? 'fast' : 'slow'}.`,
      why: 'Match tempo before anything else. If the tempos differ, any alignment you make drifts apart again within a bar.',
      satisfied: false,
    }
  }

  if (!incoming.playing) {
    const c = secondsToNextPhrase(live.position, live.bpm, live.beatOffset)
    return {
      step: 'cue',
      instruction: 'Start the incoming deck on the next phrase line.',
      why: 'Dance music is built in 4-bar phrases. Coming in on the seam is what makes a mix sound intentional instead of dropped in.',
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
        ? 'Incoming deck is BEHIND — hold NUDGE + to catch it up.'
        : 'Incoming deck is AHEAD — hold NUDGE − to let it fall back.',
      why: 'Same tempo is not the same as in time. The beats have to land together, or you hear it as a stumble even though both records are at the same BPM.',
      nudge: drift > 0 ? 1 : -1,
      drift,
      satisfied: false,
    }
  }

  if (!incoming.bassKilled) {
    return {
      step: 'bring-in',
      instruction: 'Kill the bass on the incoming deck, then bring the crossfader toward it.',
      why: 'Two basslines at once turns to mud and eats all the headroom. Drop one out and you can have both records audible at the same time.',
      drift,
      nudge: 0,
      satisfied: false,
    }
  }

  const c = secondsToNextPhrase(live.position, live.bpm, live.beatOffset)
  return {
    step: 'bass-swap',
    instruction: 'On the next phrase, swap the bass: outgoing down, incoming up.',
    why: 'The bass swap is the moment the mix actually turns over. Landing it on a phrase line is what makes the change feel like it was meant.',
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
