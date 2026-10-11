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
 *    pickRetrievalIndex — same fold, same filters.
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
export function queryNamesArtist(query: string, artists: Iterable<string>): boolean {
  const qNorm = ` ${nameKey(query)} `
  for (const a of artists) {
    if (qNorm.includes(` ${a} `)) return true
  }
  return false
}
