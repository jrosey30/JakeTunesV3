/**
 * The nearest thing Qobuz has, when it doesn't have the edition asked for
 * (Brief 257, Record Shop Phase 4). Pure: Qobuz's listings and Apple's
 * editions in, offers out. The live side is closest-edition-live.ts.
 *
 * Nothing here relaxes the album identity contract. An edition is offered
 * only when Qobuz has a listing that verifyAlbumCandidate (unchanged) calls
 * EXACTLY that Apple edition, explicit rules included; taking it queues an
 * ordinary Save album of that edition, which asks its own preflight and runs
 * the walk unchanged. The songs offer names songs by the asked edition's own
 * rows; each is saved as a song, which the song walk verifies by length.
 */
import { verifyAlbumCandidate, ALBUM_TRACK_TOLERANCE_SEC, packagingMarkersOf, type CandidateAlbum, type RequestedAlbum } from './album-identity.ts'
import { editionLabelOf, type ItunesAlbumRow } from './album-editions.ts'
import { recoArtistMatches, recoTitleMatches } from './reco-match.ts'
import { searchTitle, titleReads, unwantedVersionOf } from './streamrip-match.ts'
import { PACKAGING_WORDS } from './album-preflight.ts'
import type { AlbumEdition } from '../common/album-preflight.ts'
import type { EditionDiff, OfferSong, ShopOffer } from '../common/closest-edition.ts'

/** The asked edition in words for "The … isn't on Qobuz": its packaging ("Deluxe", "Expanded edition"), else "Standard". */
export function askedLabel(req: RequestedAlbum): string {
  const p = req.packaging.includes('super') ? 'super' : req.packaging[0]
  return (p && PACKAGING_WORDS[p]) || 'Standard'
}

interface SongLike { title: string; durationSec?: number | null }

/**
 * Which of `theirs` is each of `want`, by title (and by length when
 * `tolSec` is given and both sides have one). One-to-one, in order of
 * `want`; -1 where none is. Two songs of the same title pair in turn.
 */
export function pairSongs(want: readonly SongLike[], theirs: readonly SongLike[], tolSec?: number): number[] {
  const used = new Set<number>()
  return want.map((w) => {
    for (let j = 0; j < theirs.length; j++) {
      if (used.has(j)) continue
      const t = theirs[j]
      if (!titleReads(w.title, t.title)) continue
      if (tolSec != null && w.durationSec != null && t.durationSec != null && Math.abs(w.durationSec - t.durationSec) > tolSec) continue
      used.add(j)
      return j
    }
    return -1
  })
}

/** How `theirs` differs from `want`, in songs. */
export function editionDiff(want: readonly SongLike[], theirs: readonly SongLike[]): EditionDiff {
  const pairs = pairSongs(want, theirs)
  const hit = new Set(pairs.filter((j) => j >= 0))
  const lengths: EditionDiff['lengths'] = []
  pairs.forEach((j, i) => {
    if (j < 0) return
    const a = want[i].durationSec, b = theirs[j].durationSec
    if (a != null && b != null && Math.round(b - a) !== 0) lengths.push({ title: want[i].title, deltaSec: Math.round(b - a) })
  })
  return {
    missing: want.filter((_, i) => pairs[i] < 0).map((w) => w.title),
    added: theirs.filter((_, j) => !hit.has(j)).map((t) => t.title),
    lengths,
  }
}

/**
 * Apple's editions of the record, the clean ones kept (the clean-only case
 * offers one). The same record test as album-editions.ts chooseAlbumEditions:
 * the row's artist, its base title, no recording version it didn't ask for.
 */
export function editionsOfRecord(rows: readonly ItunesAlbumRow[], artist: string, title: string): AlbumEdition[] {
  const base = searchTitle(title) || title
  const seen = new Set<number>()
  const out: AlbumEdition[] = []
  for (const r of rows) {
    if (!(r.collectionId > 0) || !r.collectionName || seen.has(r.collectionId)) continue
    if (!r.artistName || !recoArtistMatches(artist, r.artistName)) continue
    if (!recoTitleMatches(base, searchTitle(r.collectionName) || r.collectionName)) continue
    if (unwantedVersionOf(title, r.collectionName)) continue
    seen.add(r.collectionId)
    out.push({
      collectionId: r.collectionId, name: r.collectionName, label: editionLabelOf(r.collectionName, r.explicitness, title),
      ...(r.trackCount ? { trackCount: r.trackCount } : {}), ...(r.releaseYear ? { releaseYear: r.releaseYear } : {}), ...(r.explicitness ? { explicitness: r.explicitness } : {}),
    })
  }
  return out
}

/** Same record, another edition: the listings verifyAlbumCandidate refused for what they hold, not for who or what they are. */
export function sameRecordListings(req: RequestedAlbum, listings: readonly CandidateAlbum[]): CandidateAlbum[] {
  return listings.filter((c) => {
    const v = verifyAlbumCandidate(req, c)
    return v.verdict === 'reject' && v.kind !== 'artist' && v.kind !== 'title' && v.kind !== 'version'
  })
}

/** Which Apple editions are worth a tracklist lookup: the size of a Qobuz listing of the record, never the asked one. At most `max`. */
export function editionsToCheck(req: RequestedAlbum, editions: readonly AlbumEdition[], listings: readonly CandidateAlbum[], max = 4): AlbumEdition[] {
  const sizes = new Set(sameRecordListings(req, listings).map((c) => c.trackCount ?? c.tracks?.length).filter((n): n is number => typeof n === 'number' && n > 0))
  return editions
    .filter((e) => e.collectionId !== req.providerIds.itunesCollectionId && e.trackCount != null && sizes.has(e.trackCount))
    // An explicit row: the explicit editions first; any row: the editions nearest its size first.
    .sort((a, b) => cleanRank(req, a) - cleanRank(req, b) || Math.abs((a.trackCount ?? 0) - wantCount(req)) - Math.abs((b.trackCount ?? 0) - wantCount(req)) || (a.releaseYear ?? 9999) - (b.releaseYear ?? 9999))
    .slice(0, max)
}

const wantCount = (req: RequestedAlbum): number => req.trackCount ?? req.tracks.length
const cleanRank = (req: RequestedAlbum, e: AlbumEdition): number => (req.explicit === 'explicit' && e.explicitness === 'cleaned' ? 1 : 0)

/** An Apple edition with the request built for it (buildRequestedAlbum, as the walk would build it). */
export interface CheckedEdition { edition: AlbumEdition; req: RequestedAlbum }

/**
 * The nearest edition Qobuz has: an Apple edition (not the asked one) that a
 * Qobuz listing IS, by the identity contract. Nearest = shares the most of the
 * asked songs, then misses the fewest, adds the fewest, is nearest in size,
 * keeps the asked packaging words, then the earliest. For an explicit row the
 * clean edition comes only when nothing explicit is there, and says "clean".
 */
export function chooseEditionOffer(req: RequestedAlbum, listings: readonly CandidateAlbum[], checked: readonly CheckedEdition[]): Extract<ShopOffer, { kind: 'edition' }> | null {
  const asked = req.providerIds.itunesCollectionId
  const found = checked.filter((c) => c.edition.collectionId !== asked && c.req.tracks.length > 0
    && listings.some((l) => verifyAlbumCandidate(c.req, l).verdict === 'exact'))
  if (!found.length) return null
  const scored = found.map((c) => {
    const diff = editionDiff(req.tracks, c.req.tracks)
    const shared = req.tracks.length - diff.missing.length
    const sameWords = JSON.stringify(packagingMarkersOf(c.edition.name)) === JSON.stringify(req.packaging) ? 0 : 1
    return { c, diff, key: [cleanRank(req, c.edition), -shared, diff.missing.length, diff.added.length, Math.abs((c.edition.trackCount ?? c.req.tracks.length) - wantCount(req)), sameWords, c.edition.releaseYear ?? 9999, c.edition.collectionId] }
  })
  scored.sort((a, b) => { for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i]; return 0 })
  const best = scored[0]
  return {
    kind: 'edition', edition: best.c.edition, diff: best.diff,
    ...(req.explicit === 'explicit' && best.c.edition.explicitness === 'cleaned' ? { clean: true } : {}),
  }
}

/**
 * The songs of the asked edition that a Qobuz listing of the record holds:
 * same title, and the same length within the identity contract's slack when
 * both sides know it. The listing that holds the most wins. For an explicit
 * row a listing Qobuz marks clean is never used: its songs are the clean edits.
 * `owned` are the asked edition's song indices already in the library.
 */
export function chooseSongsOffer(req: RequestedAlbum, listings: readonly CandidateAlbum[], owned: ReadonlySet<number> = new Set()): Extract<ShopOffer, { kind: 'songs' }> | null {
  if (!req.tracks.length) return null
  let best: { pairs: number[]; hits: number; size: number } | null = null
  for (const c of sameRecordListings(req, listings)) {
    if (!c.tracks?.length) continue
    if (req.explicit === 'explicit' && c.parentalWarning === false) continue
    const pairs = pairSongs(req.tracks, c.tracks, ALBUM_TRACK_TOLERANCE_SEC)
    const hits = pairs.filter((j) => j >= 0).length
    const size = c.trackCount ?? c.tracks.length
    if (hits > 0 && (!best || hits > best.hits || (hits === best.hits && size < best.size))) best = { pairs, hits, size }
  }
  if (!best) return null
  const song = (i: number): OfferSong => {
    const t = req.tracks[i]
    return { title: t.title, ...(t.trackNumber ? { trackNumber: t.trackNumber } : {}), ...(t.discNumber ? { discNumber: t.discNumber } : {}), ...(t.durationSec ? { durationSec: t.durationSec } : {}), ...(t.explicitness ? { explicitness: t.explicitness } : {}) }
  }
  const have: OfferSong[] = [], missing: OfferSong[] = []
  best.pairs.forEach((j, i) => { if (owned.has(i)) return; (j >= 0 ? have : missing).push(song(i)) })
  if (!have.length) return null
  return { kind: 'songs', have, missing, owned: owned.size, of: req.tracks.length, from: best.size }
}

/** Every offer for a "no", in the order a row shows them: the edition, the songs, the lossy copy. */
export function offersFor(o: {
  req: RequestedAlbum
  listings: readonly CandidateAlbum[]
  checked: readonly CheckedEdition[]
  owned?: ReadonlySet<number>
  bandcamp?: { url: string; name: string; band: string } | null
}): ShopOffer[] {
  const out: ShopOffer[] = []
  const edition = chooseEditionOffer(o.req, o.listings, o.checked)
  if (edition) out.push(edition)
  const songs = chooseSongsOffer(o.req, o.listings, o.owned)
  // The songs offer is the asked edition's own songs; it stands beside an edition
  // offer unless that edition is the very same songs.
  if (songs && !(edition && edition.diff.missing.length === 0 && edition.diff.added.length === 0)) out.push(songs)
  if (o.bandcamp) out.push({ kind: 'bandcamp', ...o.bandcamp })
  return out
}
