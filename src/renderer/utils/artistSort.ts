/** iTunes-style sort name — used for BOTH artists and albums via compareNames().
 *  ⚠️ TWIN: src/main/ipod-artist-sort.ts artistSortName / ipodArtistSortKey
 *  ⚠️ TWIN: core/db_reader.py ipod_artist_sort_key
 *
 *  iPod Music > Artists must use the same key or a 500-song activity set
 *  files under first-seen picker order instead of A–Z.
 *  Ignore a leading article so "The Beatles" files under B, "A Tribe Called
 *  Quest" under T. Only a whole leading word counts — "a-ha" and "Theory of a
 *  Deadman" are untouched. ALL leading punctuation/symbols are stripped, so
 *  "“Weird Al” Yankovic" files under W, "...And Justice For All" under A, and
 *  "&Forever" under F (previously these floated to the top by their leading
 *  dots/ampersand). */
export function artistSortName(name: string): string {
  let s = (name || '').trim().toLowerCase()
  // Alternate the two strips until stable: removing the article can expose new
  // leading punctuation ("The '59 Sound" -> "'59 sound" -> "59 sound"), and
  // stripping punctuation can expose an article ("(The Best Of)" -> "the best
  // of" -> "best of"). One pass of each isn't enough.
  let prev = ''
  while (s && s !== prev) {
    prev = s
    s = s.replace(/^[\p{P}\p{S}\s]+/u, '')   // leading punctuation/symbols
    s = s.replace(/^(?:the|a|an)\s+/, '')      // a leading article (whole word)
    s = s.trim()
  }
  return s || (name || '').trim().toLowerCase()
}

/** iTunes-style name comparison: the article/punctuation-insensitive sort name
 *  + natural numeric ordering (so "2" precedes "10") + case/accent-insensitive.
 *  Use EVERYWHERE a list of album or artist names is alphabetized so the whole
 *  app sorts identically. */
export function compareNames(a: string, b: string): number {
  return NAME_COLLATOR.compare(artistSortName(a), artistSortName(b))
}

/** The collator compareNames uses, for comparing keys that are ALREADY sort
 *  names (precomputed once per row, so a 13,000-song sort doesn't run the
 *  strip on every comparison). Same options as before: natural numbers,
 *  case/accent-insensitive. */
export const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Albums file by the same rule as artists ("The Wall" under W, "A Night at
 *  the Opera" under N) — one rule for both, named for the call site. */
export const albumSortName = artistSortName
export const compareAlbumNames = compareNames

/** The fields a song row may carry. sortArtist / sortAlbum are iTunes'
 *  "Sort Artist" / "Sort Album" tags: when a row has one, it wins (the same
 *  as the iPod's ipodArtistSortKey), and it still goes through the strip. */
export interface SortableTrack {
  artist?: string | null
  album?: string | null
  sortArtist?: unknown
  sortAlbum?: unknown
}

const explicit = (v: unknown): string => (v == null ? '' : String(v).trim())

/** A song's artist sort name ("The Strokes" → "strokes"), sortArtist first. */
export function trackArtistSortName(t: SortableTrack): string {
  return artistSortName(explicit(t.sortArtist) || String(t.artist || ''))
}

/** A song's album sort name ("The Wall" → "wall"), sortAlbum first. */
export function trackAlbumSortName(t: SortableTrack): string {
  return albumSortName(explicit(t.sortAlbum) || String(t.album || ''))
}

/** Sort rows by a name column, iTunes-style, computing each row's key once.
 *  Ascending; the caller reverses for descending. Ties keep their order. */
export function sortTracksByName<T extends SortableTrack>(tracks: readonly T[], column: 'artist' | 'album', dir: 'asc' | 'desc' = 'asc'): T[] {
  const keyed = tracks.map((t) => ({ t, k: column === 'artist' ? trackArtistSortName(t) : trackAlbumSortName(t) }))
  const sign = dir === 'asc' ? 1 : -1
  keyed.sort((a, b) => sign * NAME_COLLATOR.compare(a.k, b.k))
  return keyed.map((x) => x.t)
}

/** Section letter for the A–Z index: first letter of the sort name, or '#'
 *  for digits/symbols/non-Latin. */
export function artistSectionLetter(name: string): string {
  const c = artistSortName(name).charAt(0).toUpperCase()
  return c >= 'A' && c <= 'Z' ? c : '#'
}
