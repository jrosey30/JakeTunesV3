/**
 * The live side of the offers (Brief 257): Apple's editions of the record,
 * their tracklists, and the library, gathered for closest-edition.ts after
 * the album preflight said no. Read-only: searches and lookups, never a
 * download. Anything that doesn't answer in time is no offer, never a guess;
 * the "no" stands on its own, as before.
 */
import { buildRequestedAlbum, matchLibraryOwnership, type CandidateAlbum, type LibraryTrackLite, type RequestedAlbum } from './album-identity.ts'
import { loadLibraryTracksLite } from './import-pipeline.ts'
import { itunesAlbumTracks, itunesYear } from './download-search.ts'
import { recoArtistMatches } from './reco-match.ts'
import { searchTitle } from './streamrip-match.ts'
import type { ItunesAlbumRow } from './album-editions.ts'
import { editionsOfRecord, editionsToCheck, offersFor, type CheckedEdition } from './closest-edition.ts'
import type { ShopOffer } from '../common/closest-edition.ts'

/** Apple's albums for the record, the clean editions kept. ⚠️ TWIN: download-search.ts itunesAlbumEditions (search + the artist's own list). */
export async function appleAlbumRows(artist: string, title: string): Promise<ItunesAlbumRow[]> {
  const rowsOf = (results: Array<Record<string, unknown>> | undefined): Array<ItunesAlbumRow & { artistId?: number }> => (results || [])
    .filter((r) => r.wrapperType === 'collection' && typeof r.collectionId === 'number' && typeof r.collectionName === 'string')
    .map((r) => ({
      collectionId: Number(r.collectionId), collectionName: String(r.collectionName),
      artistName: typeof r.artistName === 'string' ? r.artistName : undefined,
      artistId: typeof r.artistId === 'number' ? r.artistId : undefined,
      trackCount: typeof r.trackCount === 'number' ? r.trackCount : undefined,
      releaseYear: itunesYear(r.releaseDate),
      explicitness: typeof r.collectionExplicitness === 'string' ? r.collectionExplicitness : undefined,
    }))
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${searchTitle(title) || title}`.trim())}&entity=album&limit=50`
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
  if (!res.ok) return []
  const rows = rowsOf(((await res.json()) as { results?: Array<Record<string, unknown>> }).results)
  // Apple's album search leaves explicit editions out; the artist's own list has them.
  const artistId = rows.find((r) => r.artistId && r.artistName && recoArtistMatches(artist, r.artistName))?.artistId
  if (artistId) {
    try {
      const lr = await fetch(`https://itunes.apple.com/lookup?id=${artistId}&entity=album&limit=200`, { signal: AbortSignal.timeout(5000) })
      if (lr.ok) rows.push(...rowsOf(((await lr.json()) as { results?: Array<Record<string, unknown>> }).results))
    } catch { /* the search's rows stand */ }
  }
  return rows
}

/** Injected for tests; the defaults are the live lookups. */
export interface OfferDeps {
  albumRows: (artist: string, title: string) => Promise<ItunesAlbumRow[]>
  tracks: typeof itunesAlbumTracks
  library: () => Promise<LibraryTrackLite[]>
}
const LIVE: OfferDeps = { albumRows: appleAlbumRows, tracks: itunesAlbumTracks, library: loadLibraryTracksLite }

/**
 * The offers for a "no". `listings` are the Qobuz listings the preflight
 * heard (answered, with their songs); `bandcamp` the page the walk would have
 * staged after a Qobuz miss, if any. Answers within `budgetMs` or not at all
 * (an empty list).
 */
export async function findOffers(o: {
  artist: string
  title: string
  req: RequestedAlbum
  listings: readonly CandidateAlbum[]
  bandcamp?: { url: string; name: string; band: string } | null
  budgetMs: number
}, deps: OfferDeps = LIVE): Promise<ShopOffer[]> {
  // What the library holds, once known: the fallback uses it too.
  let owned = new Set<number>()
  const ownedP = o.req.tracks.length
    ? deps.library().then((lib) => { owned = new Set(matchLibraryOwnership(o.req, lib).owned.map((x) => x.index)); return owned }).catch(() => owned)
    : Promise.resolve(owned)
  // Apple too slow: the songs and the lossy copy need no Apple, only the listings heard.
  const withoutApple = (): ShopOffer[] => offersFor({ req: o.req, listings: o.listings, checked: [], owned, bandcamp: o.bandcamp })
  const work = async (): Promise<ShopOffer[]> => {
    const rows = await deps.albumRows(o.artist, o.title).catch(() => [] as ItunesAlbumRow[])
    const toCheck = editionsToCheck(o.req, editionsOfRecord(rows, o.artist, o.title), o.listings)
    const checked: CheckedEdition[] = (await Promise.all(toCheck.map(async (edition) => {
      const lookup = await deps.tracks(edition.collectionId).catch(() => null)
      if (!lookup?.ok || !lookup.tracks.length) return null
      const t = lookup.tracks
      return {
        edition,
        req: buildRequestedAlbum({
          artist: o.artist, artistAliases: o.req.artistAliases, title: edition.name,
          trackCount: edition.trackCount ?? lookup.trackCount,
          tracks: t.map((x) => ({ title: x.song, trackNumber: x.trackNumber, discNumber: x.discNumber, durationSec: x.durationSecs, explicitness: x.explicitness })),
          discCount: t.reduce((m, x) => Math.max(m, x.discCount ?? x.discNumber ?? 1), 0) || undefined,
          releaseYear: lookup.releaseYear ?? edition.releaseYear,
          collectionId: edition.collectionId,
          explicitSource: edition.explicitness === 'explicit',
          cleanRequested: edition.explicitness === 'cleaned',
        }),
      }
    }))).filter((x): x is CheckedEdition => x != null)
    return offersFor({ req: o.req, listings: o.listings, checked, owned: await ownedP, bandcamp: o.bandcamp })
  }
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<ShopOffer[]>((res) => { timer = setTimeout(() => res(withoutApple()), Math.max(0, o.budgetMs)) })
  try { return await Promise.race([work().catch(withoutApple), late]) }
  finally { if (timer) clearTimeout(timer) }
}
