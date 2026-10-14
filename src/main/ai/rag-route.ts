/**
 * The artist half of the RAG router (rag-retrieval.ts): does a query name a
 * library artist? Pure, so node tests reach it — rag-retrieval itself drags
 * electron in through STATE_DIR.
 *
 * Both sides fold through nameKey, in any script. Under [a-z0-9] a Hebrew
 * artist folded to '' and was never in the set, so "play some ברי סחרוף"
 * routed to the mood index, which strips identity (2026-10-11).
 *
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/rag.ts libraryArtistSet +
 *    pickRetrievalIndex — same fold, same filters, same "The"-stripped guard.
 */
import { nameKey } from '../../common/fold-text.ts'

// Genre-ish words that can also be band names — an artist match on one
// of these must not hijack a vibe query ("house and dance music" is not
// about a band named House).
export const GENRE_WORD_ARTISTS = new Set([
  'house', 'dance', 'funk', 'soul', 'punk', 'metal', 'grunge', 'jazz', 'blues',
  'rock', 'pop', 'disco', 'techno', 'ambient', 'folk', 'country', 'rap',
  'reggae', 'ska', 'indie', 'emo', 'hardcore', 'trance', 'garage', 'gospel',
])

/** The set key for a library artist, or null when it must not route
 *  (under 4 characters, or a genre word). */
export function routeArtistKey(a: string | undefined): string | null {
  const norm = nameKey(a)
  return norm.length >= 4 && !GENRE_WORD_ARTISTS.has(norm) ? norm : null
}

/** True when the query names one of the artists (whole words). */
export function queryNamesArtist(query: string, artists: Iterable<string>, stripped?: StrippedArtists): boolean {
  const q = nameKey(query)
  const qNorm = ` ${q} `
  for (const a of artists) {
    if (qNorm.includes(` ${a} `)) return true
  }
  if (!stripped) return false
  for (const v of stripped.plain) {
    if (qNorm.includes(` ${v} `)) return true
  }
  // An ordinary-word variant ("doors", "cars") only on an artist-intent query.
  for (const v of stripped.wordy) {
    if (ARTIST_INTENT.some((t) => t(v) === q)) return true
  }
  return false
}

// ── "The"-stripped artist guard (E6, 2026-10-13; brain-eval
// PROPOSAL-p2-stripped-artist-guard, variant S2) ──────────────────────────
// The set holds "the beatles", so "beatles songs" missed it and went to the
// mood index, which strips identity (recall@20 for a band's own songs:
// identity 1.00 vs mood 0.00-0.70, mean +0.75). Every "The X" artist also
// counts as "X" — but 57 of the 142 variants are ordinary words ("doors",
// "cars", "sleeping", "beat"), and a plain match on those hijacked 10 of 12
// vibe queries ("songs about cars" -> artist). S2: those match only when the
// whole query is an artist-intent template. Measured: 0/12 hijacks, 142/142
// bare names reach their band.

/** The artist-intent shapes an ordinary-word band name must be asked in. */
export const ARTIST_INTENT: ReadonlyArray<(x: string) => string> = [
  (x) => x, (x) => `${x} songs`, (x) => `${x} tracks`, (x) => `${x} music`, (x) => `play ${x}`,
  (x) => `play some ${x}`, (x) => `songs by ${x}`, (x) => `tracks by ${x}`, (x) => `music by ${x}`,
  (x) => `best ${x} songs`,
]

export interface StrippedArtists { plain: Set<string>; wordy: Set<string> }

/** "the beatles" -> "beatles"; null when there's no "the " or the rest is
 *  too short or a genre word. */
export function strippedVariant(key: string): string | null {
  if (!key.startsWith('the ')) return null
  const v = key.slice(4)
  return v.length >= 4 && !GENRE_WORD_ARTISTS.has(v) ? v : null
}

/** An ordinary word (or its plural) — such a variant only matches artist-
 *  intent queries. With no dictionary, every single word counts as ordinary
 *  (the cautious side: nothing can hijack a vibe query). */
export function isOrdinaryWord(v: string, words: ReadonlySet<string> | null): boolean {
  if (v.includes(' ')) return false
  if (!words) return true
  return words.has(v) || (v.endsWith('s') && words.has(v.slice(0, -1)))
}

/** Sort the "The X" variants of a set of artist keys into plain vs wordy. */
export function buildStrippedArtists(keys: Iterable<string>, words: ReadonlySet<string> | null): StrippedArtists {
  const out: StrippedArtists = { plain: new Set(), wordy: new Set() }
  for (const k of keys) {
    const v = strippedVariant(k)
    if (v) (isOrdinaryWord(v, words) ? out.wordy : out.plain).add(v)
  }
  return out
}

/** The query text to EMBED once the router knows the band: "clash songs" ->
 *  "the clash songs". On the right index the bare word still means the word
 *  (measured 10/13 through the production bridge: "clash songs" 8/20 of the
 *  band's own songs vs 20/20 for "the clash songs"; doors 6 vs 15). Only when
 *  the bare name is how the band was recognized; otherwise unchanged. */
export function restoreStrippedArtist(query: string, artists: Iterable<string>, stripped: StrippedArtists): string {
  if (queryNamesArtist(query, artists)) return query
  const q = nameKey(query)
  const qn = ` ${q} `
  for (const v of stripped.plain) if (qn.includes(` ${v} `)) return qn.replace(` ${v} `, ` the ${v} `).trim()
  for (const v of stripped.wordy) if (ARTIST_INTENT.some((t) => t(v) === q)) return qn.replace(` ${v} `, ` the ${v} `).trim()
  return query
}
