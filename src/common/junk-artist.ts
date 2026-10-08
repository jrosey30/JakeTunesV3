/**
 * Acts that are not the music — karaoke, tribute and cover factories,
 * lullaby / kids / meditation renditions, "instrumentals of" orchestras.
 * One regex, every surface that ingests an outside catalogue applies it.
 *
 * 2026-09-21. The Discover shelf served "Yoyo International Orchestra —
 * The Love Songs of the Beatles - Instrumentals Volume 1" because Deezer
 * lists that act (72 fans, 37 albums) as RELATED to Nirvana. Jake: "this
 * crap cannot be recommended." The title carried neither "tribute" nor
 * "instrumental version", so the title filter passed it, and nothing
 * looked at the ARTIST at all. Now three gates in the supply lane:
 *
 *   1. the artist's NAME (this regex — shared with Download search);
 *   2. the artist's SIZE on Deezer: a factory has almost no fans per
 *      album it ships (Yoyo 2 fans/album, Vitamin String Quartet 76 at
 *      499 albums) where even a small real band has hundreds
 *      (Everyone Asked About You 170, Mannequin Pussy 2,400);
 *   3. the album TITLE (discover-supply.ts JUNK, widened).
 *
 * Over-refusal is the safe direction on a discovery shelf.
 */
export const JUNK_ARTIST_NAME = /karaoke|tribute|cover band|made famous|made popular|in the style of|originally performed|8.?bit|chiptune|lullaby|rockabye|little rock star|music foundation|piano (tribute|version|renditions?)|string quartet|meditation|sleep baby|nursery|international orchestra|philharmonic orchestra|\borchestra\b.*\b(plays|performs)\b|studio (musicians|players|orchestra)|the hit crew|instrumental hits|piano dreamers|midnite string|guitar tribute|music box|kidz bop|kids' cover/i

export function isJunkArtistName(name: string | null | undefined): boolean {
  return JUNK_ARTIST_NAME.test(String(name || ''))
}

/** Minimum Deezer following for a related artist to be worth a card. */
export const RELATED_MIN_FANS = 300
/** Minimum fans per album shipped — factories ship hundreds of albums nobody follows. */
export const RELATED_MIN_FANS_PER_ALBUM = 40

/**
 * True when Deezer's numbers say "cover factory". Unknown numbers (the
 * fixture, an API that omitted them) are not evidence — allow.
 */
export function looksLikeCoverFactory(nbFan: unknown, nbAlbum: unknown): boolean {
  const fans = Number(nbFan)
  const albums = Number(nbAlbum)
  if (!Number.isFinite(fans)) return false
  if (fans < RELATED_MIN_FANS) return true
  if (Number.isFinite(albums) && albums > 0 && fans / albums < RELATED_MIN_FANS_PER_ALBUM) return true
  return false
}
