/**
 * Tape physics — THE single implementation (main's mixtape builder AND
 * the renderer's mixing-deck live counter both import this; do not fork
 * it — that's the twin trap this file exists to prevent).
 *
 * A cassette side is EXACTLY its length. Songs record in order until the
 * tape runs out. The song that crosses the end is kept and CUT at the
 * boundary — if at least MIN_CUT_MS of tape remains for it. Everything
 * after the boundary song never records.
 */

export const MIN_CUT_MS = 20_000
/** Assumed length when a track has no known duration (≈3:30). */
export const UNKNOWN_DURATION_MS = 210_000

// ── The 2026-08-08 model ────────────────────────────────────────────────
// Jake: "all mixtapes are no longer doing side a side b. 25 songs max …
// manually made can be any playlist … as long as 25 or less songs. it can
// be a whole album if i want. my choice."
//
// A tape is now ONE sequence with a song-count limit. There is no A/B
// boundary, no minutes budget, and no boundary-song cut — fitSide() above
// still exists only to read tapes recorded under the old rules.

/** The only limit a tape has now. */
export const MAX_TAPE_SONGS = 25

/** Minimum shape this helper needs — the full Mixtape in main and renderer
 *  both satisfy it, which is why this lives here and not next to either. */
export interface TapeLike {
  tracks?: number[]
  sideA?: number[]
  sideB?: number[]
}

/**
 * What's on the tape, in play order — THE one answer.
 *
 * New tapes carry `tracks`. Tapes Jake recorded under the two-sided rules
 * are grandfathered ("old mixtapes i made already should be grandfathered
 * in") by reading straight through A into B, which is the order they always
 * played in anyway. Never read tape.sideA/sideB directly for playback; go
 * through here so both eras behave the same everywhere.
 */
export function tapeTracks(tape: TapeLike): number[] {
  if (Array.isArray(tape.tracks)) return tape.tracks
  return [...(tape.sideA || []), ...(tape.sideB || [])]
}

/** Trim to the song cap, preserving order. */
export function fitTape(ids: number[], max: number = MAX_TAPE_SONGS): number[] {
  return ids.slice(0, max)
}

/**
 * One song per artist, keeping the first appearance — the rule for
 * AI-generated mixes only (Jake: "AI mixes follow the one song per artist
 * rule"). Hand-made tapes are explicitly exempt: a whole album is allowed
 * when that's what he wants.
 */
export function oneSongPerArtist(
  ids: number[],
  artistOf: (id: number) => string | undefined,
): number[] {
  const seen = new Set<string>()
  const out: number[] = []
  for (const id of ids) {
    const key = (artistOf(id) || '').trim().toLowerCase()
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    out.push(id)
  }
  return out
}

export interface SideFit {
  /** Songs that actually made it onto the tape, in order. */
  ids: number[]
  /** ms into the LAST song where the tape runs out (absent = side ends clean). */
  cutMs?: number
  /** Total tape consumed (== budget when cut). */
  usedMs: number
  /** Songs that were placed after the tape ran out — they never recorded. */
  overflowIds: number[]
}

export function fitSide(
  ids: number[],
  durationMsById: (id: number) => number | undefined,
  sideBudgetMs: number,
): SideFit {
  let total = 0
  const out: number[] = []
  const overflow: number[] = []
  let cutMs: number | undefined
  for (const id of ids) {
    if (cutMs !== undefined) { overflow.push(id); continue }
    const dur = durationMsById(id) || UNKNOWN_DURATION_MS
    if (total + dur <= sideBudgetMs) {
      total += dur
      out.push(id)
      continue
    }
    const remaining = sideBudgetMs - total
    if (remaining >= MIN_CUT_MS) {
      out.push(id)
      cutMs = remaining
      total = sideBudgetMs
    } else {
      overflow.push(id)
      cutMs = 0 // tape effectively full; nothing more records
    }
  }
  // cutMs === 0 means the boundary was too tight to start another song —
  // side ends clean, but the tape is full.
  return {
    ids: out,
    cutMs: cutMs && cutMs > 0 ? cutMs : undefined,
    usedMs: total,
    overflowIds: overflow,
  }
}

/**
 * Wrap a raw duration lookup with per-track start offsets (REC pressed
 * mid-song → only the tail is on tape). Every fitSide call site that
 * handles a tape with startOffsets must use this — one adapter, no forks.
 */
export function effectiveDurationFn(
  durOf: (id: number) => number | undefined,
  startOffsets?: Record<string, number>,
): (id: number) => number {
  return (id: number) => {
    const full = durOf(id) || UNKNOWN_DURATION_MS
    const off = startOffsets?.[String(id)] || 0
    return Math.max(1000, full - off)
  }
}

// ── Voices on the tape (2026-10-09, spec-01) ────────────────────────────
// Play and Export are the same tape. A voice laid down with the music (a
// talkover: the mic, or a DJ break taped off the radio) is pinned to a spot
// on the tape, and the deck that pins it, Play Tape and Export all measure
// that spot with the functions below — one ruler, no forks.
//
// Since 2026-08-08 the deck pins every voice by where the pen sits on the
// tape's ONE run of songs, and writes side 'A' only to fill the legacy
// field. Playback still looked the voice up by Side A / Side B; a one-sided
// tape has no sides, so every voice recorded since then was skipped while
// the export mixed it in.

/** What the voice helpers read off a tape (main's and the renderer's
 *  Mixtape both satisfy it). */
export interface TapeRunLike extends TapeLike {
  startOffsets?: Record<string, number>
  sideACutMs?: number
  sideBCutMs?: number
}

/** Where a voice is pinned. 'A' = ms into the tape's run of songs — every
 *  pin since 2026-08-08, and every older Side A pin (Side A is the head of
 *  the run). 'B' = two-sided era only: ms after the flip. */
export interface TalkoverPin {
  side: 'A' | 'B'
  atMs: number
}

/** A two-sided-era cut on this song (ms of tape after its start), when it is
 *  a side's boundary song. Play Tape still honors these cuts, so the run
 *  does too. */
export function tapeCutMs(tape: TapeRunLike, id: number): number | undefined {
  const a = tape.sideA || []
  const b = tape.sideB || []
  if (tape.sideACutMs && a.length > 0 && a[a.length - 1] === id) return tape.sideACutMs
  if (tape.sideBCutMs && b.length > 0 && b[b.length - 1] === id) return tape.sideBCutMs
  return undefined
}

/** The songs Play Tape actually plays, in order. A Side B cut is the end of
 *  the tape (playback stops there), so nothing after it is on the run. */
export function tapePlayIds(tape: TapeRunLike): number[] {
  const ids = tapeTracks(tape)
  const b = tape.sideB || []
  if (tape.sideBCutMs && b.length > 0) {
    const end = ids.indexOf(b[b.length - 1])
    if (end >= 0) return ids.slice(0, end + 1)
  }
  return ids
}

/** How much tape one song takes: its tail after any start offset, stopped
 *  at a cut. */
export function tapeSongMs(tape: TapeRunLike, id: number, durOf: (id: number) => number | undefined): number {
  const eff = effectiveDurationFn(durOf, tape.startOffsets)(id)
  const cut = tapeCutMs(tape, id)
  return cut !== undefined ? Math.min(eff, cut) : eff
}

/** The whole run, in ms of tape. */
export function tapeRunMs(tape: TapeRunLike, durOf: (id: number) => number | undefined): number {
  return tapePlayIds(tape).reduce((sum, id) => sum + tapeSongMs(tape, id, durOf), 0)
}

/** ms of tape played when song `id` is `positionMs` into its file, or null
 *  when that song is not on the run. */
export function tapeElapsedMs(
  tape: TapeRunLike,
  id: number,
  positionMs: number,
  durOf: (id: number) => number | undefined,
): number | null {
  const ids = tapePlayIds(tape)
  const idx = ids.indexOf(id)
  if (idx < 0) return null
  let before = 0
  for (let i = 0; i < idx; i++) before += tapeSongMs(tape, ids[i], durOf)
  const off = tape.startOffsets?.[String(id)] || 0
  return before + Math.min(tapeSongMs(tape, id, durOf), Math.max(0, positionMs - off))
}

/** Side A's length in ms of tape (two-sided era: where the flip falls). */
function sideAMs(tape: TapeRunLike, durOf: (id: number) => number | undefined): number {
  return (tape.sideA || []).reduce((sum, id) => sum + tapeSongMs(tape, id, durOf), 0)
}

/** Where a voice sits on the run, in ms of tape. */
export function talkoverRunMs(tape: TapeRunLike, pin: TalkoverPin, durOf: (id: number) => number | undefined): number {
  return pin.side === 'B' ? sideAMs(tape, durOf) + pin.atMs : pin.atMs
}

/** A voice plays only where there is music under it. A pin at or past the
 *  end of the run never plays, and the export's mix ends with the music. */
export function talkoverPlays(tape: TapeRunLike, pin: TalkoverPin, durOf: (id: number) => number | undefined): boolean {
  const at = talkoverRunMs(tape, pin, durOf)
  return at >= 0 && at < tapeRunMs(tape, durOf)
}

/** How late a voice may still start once its spot has passed. Playback
 *  ticks about once a second, so a pin is caught on the next tick. */
export const TALKOVER_CATCH_MS = 4000

/** The voices due to start right now: song `id` at `positionMs` into its
 *  file. The caller keeps each voice to one shot per playthrough. */
export function talkoversDue<P extends TalkoverPin>(
  tape: TapeRunLike,
  pins: readonly P[],
  id: number,
  positionMs: number,
  durOf: (id: number) => number | undefined,
): P[] {
  const elapsed = tapeElapsedMs(tape, id, positionMs, durOf)
  if (elapsed === null) return []
  // Where this song's tape ends. A pin exactly there belongs to the next
  // song (it was laid down as that song started), not to this one's last tick.
  const songEnd = tapeElapsedMs(tape, id, Number.MAX_SAFE_INTEGER, durOf) ?? elapsed
  return pins.filter((p) => {
    if (!talkoverPlays(tape, p, durOf)) return false
    const at = talkoverRunMs(tape, p, durOf)
    return at < songEnd && elapsed >= at && elapsed - at < TALKOVER_CATCH_MS
  })
}

/** The voices an export mixes into each file, as ms from the head of that
 *  file's music. One file: every voice at its run position. Two files (a
 *  grandfathered two-sided tape): split at the flip. Voices that would not
 *  play are left out, so the export never carries one the player skips. */
export function dubTalkovers<P extends TalkoverPin>(
  tape: TapeRunLike,
  pins: readonly P[],
  durOf: (id: number) => number | undefined,
  twoSided: boolean,
): { A: P[]; B: P[] } {
  const flip = sideAMs(tape, durOf)
  const out: { A: P[]; B: P[] } = { A: [], B: [] }
  for (const p of pins) {
    if (!talkoverPlays(tape, p, durOf)) continue
    const at = talkoverRunMs(tape, p, durOf)
    if (twoSided && at >= flip) out.B.push({ ...p, side: 'B', atMs: at - flip })
    else out.A.push({ ...p, side: 'A', atMs: at })
  }
  return out
}
