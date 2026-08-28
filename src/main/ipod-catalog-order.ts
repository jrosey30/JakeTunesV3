/**
 * iPod Mini catalog ordering (2026-08-28, Jake: "is there a reason why the
 * artists on the ipod mini, even after successful sync, are not in
 * alphabetical order?").
 *
 * The Mini's 1.4.1 firmware predates the type-52 sort tables the DB writer
 * dutifully builds — it walks the mhit records in PHYSICAL order. We were
 * writing them in library order, so the Artists menu came out 48% shuffled.
 * The fix is not in the writer (core/ is Do-Not-Touch): the engine sorts
 * the track array before handing it over, because mhits are emitted in
 * input order and playlists reference tracks by dbid — reordering the
 * catalog cannot touch playlist order.
 *
 * Sort convention is iTunes': leading articles fold away ("The Beatles"
 * files under B), accents fold BEFORE the strip (Motörhead under M, not
 * after Z — the JAŸ-Z lesson), case ignored. Within an artist: album,
 * then numeric track number, then title.
 */

const fold = (s: string): string =>
  String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

export function ipodArtistSortKey(name: string): string {
  return fold(name).replace(/^(the|a|an) /, '')
}

export function orderForIpodCatalog<T extends Record<string, unknown>>(tracks: T[]): T[] {
  const key = (t: T): [string, string, number, string] => [
    ipodArtistSortKey(String(t['artist'] || t['albumArtist'] || 'Unknown Artist')),
    fold(String(t['album'] || '')),
    Number(t['trackNumber']) || 0,
    fold(String(t['title'] || '')),
  ]
  // Decorate–sort–undecorate keeps this O(n log n) with stable ties.
  return tracks
    .map((t, i) => ({ t, i, k: key(t) }))
    .sort((a, b) => {
      if (a.k[0] !== b.k[0]) return a.k[0] < b.k[0] ? -1 : 1
      if (a.k[1] !== b.k[1]) return a.k[1] < b.k[1] ? -1 : 1
      if (a.k[2] !== b.k[2]) return a.k[2] - b.k[2]
      if (a.k[3] !== b.k[3]) return a.k[3] < b.k[3] ? -1 : 1
      return a.i - b.i
    })
    .map((x) => x.t)
}
