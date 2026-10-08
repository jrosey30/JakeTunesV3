/**
 * Subgenre lexicon — named styles the library's genre column does not
 * carry, so no vector space can find them by name (2026-09-02, the yacht
 * rock finding: 43 yacht tracks across 11 artists, and NO route — mood,
 * audio, or fusion — put one in the top 25; every space read "yacht rock"
 * as the token "rock"). A lexicon entry gives retrieval three things:
 *
 *   expand   sonic words appended to the query before embedding, so the
 *            mood/CLAP spaces hear the style instead of the word "rock"
 *   anchors  artists whose in-era tracks ARE the style — injected into the
 *            candidate pool and given the anchor bonus in the reranker
 *   years    the era window (per-anchor override when a catalog straddles)
 *
 * Grow this by adding entries — never by rewriting the matcher (memory:
 * "grow lexicons instead"). Facts here are canon-level, not guesses.
 *
 * ⚠️ TWIN: backend/src/util/subgenreLexicon.ts in ~/JakeTunesMobile — same
 * data, copied verbatim, per src/common/mix-brain-twin.ts discipline.
 */

export interface SubgenreAnchor {
  /** Folded, lowercase artist name as it appears in the library. */
  artist: string
  /** Overrides the entry window for this artist. */
  years?: [number, number]
}

export interface SubgenreEntry {
  key: string
  aliases: string[]
  expand: string
  years: [number, number]
  anchors: SubgenreAnchor[]
}

export const SUBGENRE_LEXICON: SubgenreEntry[] = [
  {
    key: 'yacht rock',
    aliases: ['yacht rock', 'yacht-rock', 'yachty', 'yacht', 'west coast soft rock', 'marina rock'],
    expand: 'smooth polished soft rock, breezy west coast studio pop, Fender Rhodes, sax, jazzy chords, late 1970s early 1980s',
    years: [1975, 1985],
    anchors: [
      { artist: 'steely dan', years: [1972, 1980] },
      { artist: 'donald fagen' },
      { artist: 'michael mcdonald' },
      { artist: 'the doobie brothers', years: [1972, 1982] },
      { artist: 'doobie brothers', years: [1972, 1982] },
      { artist: 'toto' },
      { artist: 'christopher cross' },
      { artist: 'boz scaggs' },
      { artist: 'kenny loggins' },
      { artist: 'loggins & messina' },
      { artist: 'hall & oates' },
      { artist: 'daryl hall & john oates' },
      { artist: 'ambrosia' },
      { artist: 'player' },
      { artist: 'rupert holmes' },
      { artist: 'gerry rafferty' },
      { artist: 'pablo cruise' },
      { artist: 'little river band' },
      { artist: 'england dan & john ford coley' },
      { artist: 'robbie dupree' },
      { artist: '10cc', years: [1975, 1978] },
      { artist: 'seals & crofts', years: [1972, 1980] },
      { artist: 'bobby caldwell' },
      { artist: 'george benson' },
      { artist: 'al stewart' },
      { artist: 'firefall' },
      { artist: 'bill labounty' },
      { artist: 'airplay' },
      { artist: 'the alan parsons project' },
      { artist: 'nicolette larson' },
      { artist: 'bertie higgins' },
    ],
  },
]

const foldLite = (s: string): string =>
  String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')

/** The first entry whose alias appears in the query (word-bounded), or null. */
export function matchSubgenre(query: string, lexicon: SubgenreEntry[] = SUBGENRE_LEXICON): SubgenreEntry | null {
  const q = ` ${foldLite(query).replace(/[^a-z0-9&]+/g, ' ').trim()} `
  for (const e of lexicon) {
    for (const a of e.aliases) {
      const al = ` ${foldLite(a).replace(/[^a-z0-9&]+/g, ' ').trim()} `
      if (q.includes(al)) return e
    }
  }
  return null
}

/** Query text to EMBED for a lexicon match: the query plus its sonic expansion. */
export function expandSubgenreQuery(query: string, entry: SubgenreEntry): string {
  return `${query}. ${entry.expand}`
}

/** True when a track by this artist/year is an anchor for the entry. */
export function isSubgenreAnchor(
  entry: SubgenreEntry,
  artist: string | undefined,
  year: string | number | undefined,
): boolean {
  const a = foldLite(artist || '').trim()
  if (!a) return false
  const hit = entry.anchors.find((x) => x.artist === a)
  if (!hit) return false
  const y = Number(year)
  if (!Number.isFinite(y) || y <= 0) return true   // unknown year: trust the artist
  const [lo, hi] = hit.years ?? entry.years
  return y >= lo && y <= hi
}
