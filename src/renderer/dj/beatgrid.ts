/**
 * Beat maths for DJ mode. Pure functions, no audio objects — every timing
 * decision the decks and the game make routes through here so it can be tested
 * without a sound card.
 *
 * The library already knows the BPM of all 8,857 tracks (and the Camelot key of
 * the same), which is the expensive half of beatmatching. What's left is
 * arithmetic: where the beats fall, how far the nearest one is, and what
 * playback rate makes one record run at another's tempo.
 */

/** Seconds per beat at a given tempo. */
export function beatPeriod(bpm: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return 0
  return 60 / bpm
}

/**
 * Time of the Nth beat. `offset` is where beat 0 sits in the file — the count-in
 * before the first downbeat. Almost no track starts its first beat at exactly
 * 0.000s, and being a few tens of ms out is the difference between a mix that
 * locks and one that flams.
 */
export function beatTime(n: number, bpm: number, offset = 0): number {
  return offset + n * beatPeriod(bpm)
}

/** Index of the beat nearest `t` (may be negative before the first downbeat). */
export function nearestBeatIndex(t: number, bpm: number, offset = 0): number {
  const p = beatPeriod(bpm)
  if (p === 0) return 0
  return Math.round((t - offset) / p)
}

/** Signed distance from `t` to its nearest beat. Negative = early, positive = late. */
export function beatOffsetSeconds(t: number, bpm: number, offset = 0): number {
  const p = beatPeriod(bpm)
  if (p === 0) return 0
  return t - beatTime(nearestBeatIndex(t, bpm, offset), bpm, offset)
}

/** Snap a time to the nearest beat — used for loop ends and cue drops. */
export function quantize(t: number, bpm: number, offset = 0): number {
  return beatTime(nearestBeatIndex(t, bpm, offset), bpm, offset)
}

/**
 * Every beat in a window, for drawing the grid and for spawning game prompts.
 * Bounded hard: a 14-minute track at 174 BPM is ~2,400 beats, and an unbounded
 * generator here would happily build a million-element array if handed a bad
 * BPM.
 */
export function beatsInRange(
  from: number,
  to: number,
  bpm: number,
  offset = 0,
  limit = 4096,
): number[] {
  const p = beatPeriod(bpm)
  if (p === 0 || to <= from) return []
  const out: number[] = []
  let n = Math.ceil((from - offset) / p)
  for (let t = beatTime(n, bpm, offset); t <= to && out.length < limit; n++, t = beatTime(n, bpm, offset)) {
    if (t >= from) out.push(t)
  }
  return out
}

/**
 * Playback rate that makes `sourceBpm` run at `targetBpm`.
 *
 * Clamped to ±25%. Past that a track stops sounding like itself — this is a
 * turntable, not a time-stretcher: rate and pitch move together, exactly as
 * they do on vinyl. Refusing an absurd rate is better than silently producing
 * a chipmunk.
 */
export function syncRate(sourceBpm: number, targetBpm: number, maxDrift = 0.25): number {
  if (!sourceBpm || !targetBpm || sourceBpm <= 0 || targetBpm <= 0) return 1
  const raw = targetBpm / sourceBpm
  return Math.min(1 + maxDrift, Math.max(1 - maxDrift, raw))
}

/**
 * Equal-power crossfader gains. `pos` runs -1 (hard A) to +1 (hard B).
 *
 * A linear fader dips ~3 dB in the middle, because two uncorrelated signals at
 * half amplitude don't sum back to full loudness. The sin/cos law holds
 * perceived level constant across the throw, which is what a real mixer does
 * and why a linear one always sounds like the mix is losing energy mid-blend.
 */
export function crossfadeGains(pos: number): { a: number; b: number } {
  const p = Math.min(1, Math.max(-1, pos))
  const x = (p + 1) / 2               // 0..1
  return { a: Math.cos(x * Math.PI / 2), b: Math.sin(x * Math.PI / 2) }
}

/**
 * Do two Camelot keys mix without clashing?
 *
 * The wheel: 1-12 around, A = minor, B = major. Harmonically safe moves are
 * the same key, ±1 step on the same letter, or the relative major/minor at the
 * same number. Anything else can still work musically, but it's a choice rather
 * than a safe bet, so it isn't suggested.
 */
export function camelotCompatible(a?: string, b?: string): boolean {
  const pa = parseCamelot(a)
  const pb = parseCamelot(b)
  if (!pa || !pb) return false
  if (pa.n === pb.n && pa.letter === pb.letter) return true
  if (pa.n === pb.n) return true                       // relative major/minor
  if (pa.letter !== pb.letter) return false
  const d = Math.abs(pa.n - pb.n)
  return d === 1 || d === 11                            // ±1, wrapping 12->1
}

export function parseCamelot(k?: string): { n: number; letter: 'A' | 'B' } | null {
  if (!k) return null
  const m = /^\s*(\d{1,2})\s*([AB])\s*$/i.exec(k)
  if (!m) return null
  const n = Number(m[1])
  if (n < 1 || n > 12) return null
  return { n, letter: m[2].toUpperCase() as 'A' | 'B' }
}

/**
 * Where you are WITHIN the current beat, 0..1. 0 is exactly on it.
 *
 * This is the number the whole craft turns on. Two records at identical BPM
 * still sound like a mess if their downbeats don't coincide, and "matched
 * tempo" is not the same thing as "in phase" — which is the single hardest
 * idea to convey to someone learning, because you cannot see it, you can only
 * hear it as a stumble.
 */
export function beatPhase(t: number, bpm: number, offset = 0): number {
  const p = beatPeriod(bpm)
  if (p === 0) return 0
  const x = ((t - offset) % p) / p
  return x < 0 ? x + 1 : x
}

/**
 * How far deck B's beat sits from deck A's, in BEATS, wrapped to (-0.5, 0.5].
 *
 * Signed so it can say which way to nudge rather than just "wrong": negative
 * means B is ahead (running early — slow it down), positive means B is behind.
 * Wrapping at half a beat is what makes it useful: being 0.9 of a beat late is
 * really being 0.1 early, and telling someone to slow down in that case would
 * send them the long way round.
 */
export function phaseDelta(
  posA: number, bpmA: number, offsetA: number,
  posB: number, bpmB: number, offsetB: number,
): number {
  if (!bpmA || !bpmB) return 0
  let d = beatPhase(posA, bpmA, offsetA) - beatPhase(posB, bpmB, offsetB)
  while (d > 0.5) d -= 1
  while (d <= -0.5) d += 1
  return d
}

/** Within a twentieth of a beat is inaudible — call that locked. */
export const LOCK_TOLERANCE = 0.05

export function isPhaseLocked(delta: number, tolerance = LOCK_TOLERANCE): boolean {
  return Math.abs(delta) <= tolerance
}

/**
 * Seconds until the next phrase line — where a DJ actually makes a move.
 * Returns Infinity when there's no grid to count against, so callers can show
 * "—" instead of a fake countdown.
 */
export function secondsToNextPhrase(
  t: number, bpm: number, offset = 0, beatsPerBar = 4, barsPerPhrase = 4,
): number {
  const p = beatPeriod(bpm)
  if (p === 0) return Infinity
  const phraseLen = p * beatsPerBar * barsPerPhrase
  const since = (t - offset) % phraseLen
  const rem = since < 0 ? -since : phraseLen - since
  return rem === phraseLen ? 0 : rem
}

/**
 * How close are two tempos, as a fraction? Used to rank mix candidates —
 * a track needing a 2% nudge is a far better next record than one needing 18%,
 * even if both are technically within the fader's range.
 */
export function tempoDistance(a: number, b: number): number {
  if (!a || !b) return Infinity
  return Math.abs(a - b) / Math.max(a, b)
}
