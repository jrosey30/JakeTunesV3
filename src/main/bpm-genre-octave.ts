/**
 * Genre-prior octave repair — the case onset scoring provably cannot solve.
 *
 * 2026-08-25, Jake: "the BPM analyzer sucks because searching is a house song
 * and it measured at 64 BPM????? IS IT LOST????" It is not lost — 80% of the
 * library sits in the ordinary 90-159 band — but four-on-the-floor is the one
 * shape where the analyser is blind: a half-speed grid lands on exactly the
 * same kicks, so onset strength scores 64 and 128 identically and the tie-break
 * keeps whatever was measured. core/audio_analysis.py's genre-free plausibility
 * clamp cannot help either, because 64 BPM is a perfectly plausible tempo — it
 * is only wrong once you know the record is house.
 *
 * ⚠️ The trap this deliberately avoids: scripts/fix-bpm-octaves.mjs guesses
 * from genre with GENEROUS ranges and, dry-run today, wanted to push blink-182
 * to 191-204 BPM ("First Date" is ~158). Wide ranges plus doubling is how you
 * wreck good data. So this covers ONLY genres with a hard tempo convention,
 * uses TIGHT bands, and fires only when the doubled value lands inside one.
 */
export interface OctaveTrack { id: number; bpm?: number | string | null; genre?: string | null }

/** Genres whose tempo convention is strong enough to arbitrate an octave. */
const FOUR_ON_THE_FLOOR: Array<[RegExp, number, number]> = [
  [/\bhouse\b|\bdeep house\b|\bfrench house\b|\btech house\b/i, 115, 132],
  [/\btechno\b/i, 125, 150],
  [/\btrance\b/i, 130, 145],
  [/\bdisco\b|\bnu-?disco\b/i, 108, 128],
  [/\bgarage\b|\bukg\b/i, 128, 140],
]

/** The doubled reading a halved dance track would have had. */
export function genreOctaveFix(t: OctaveTrack): number | null {
  const bpm = typeof t.bpm === 'string' ? parseFloat(t.bpm) : t.bpm
  if (!bpm || !Number.isFinite(bpm) || bpm <= 0) return null
  const genre = String(t.genre || '')
  if (!genre) return null
  // Only ever a DOUBLING, and only from the halved window. Anything already in
  // a plausible dance range is left alone — no policing tempo.
  if (bpm < 55 || bpm > 85) return null
  for (const [re, lo, hi] of FOUR_ON_THE_FLOOR) {
    if (!re.test(genre)) continue
    const doubled = Math.round(bpm * 2 * 10) / 10
    if (doubled >= lo && doubled <= hi) return doubled
    return null
  }
  return null
}
