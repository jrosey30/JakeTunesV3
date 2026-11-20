/**
 * Which edition a one-click album save takes (Brief 255).
 *
 * A For You card or a Listen List row names a record by artist and title and
 * carries no iTunes collection id, so until now Save album sent Jake to Search
 * to pick one. Here Apple's albums for that name become a short list of real
 * editions, and one is chosen the way he would:
 *
 *   - Only the record itself: the artist must be the row's, the base title
 *     the row's, and no recording version the row didn't ask for (live,
 *     remix, demo…), the same words the identity contract refuses.
 *   - The clean edit never stands where Apple also has the explicit one
 *     (common/explicit.ts explicitWins, the Search tab's rule).
 *   - The default carries the row's own labels (a "Deluxe" row gets a Deluxe,
 *     a plain row a plain record), then the title exactly as the row writes
 *     it, then no remaster stamp, then the earliest release.
 *
 * When nothing carries the row's labels, nothing is chosen and the walk
 * resolves the album by name, as before (itunesFindAlbum). Pure; the fetch
 * is download-search.ts itunesAlbumEditions.
 */
import { packagingMarkersOf } from './album-identity.ts'
import { recoArtistMatches, recoNorm, recoTitleMatches } from './reco-match.ts'
import { requestedVersionMarkers, searchTitle, unwantedVersionOf } from './streamrip-match.ts'
import type { AlbumEdition, AlbumEditions } from '../common/album-preflight.ts'

export interface ItunesAlbumRow {
  collectionId: number
  collectionName: string
  artistName?: string
  trackCount?: number
  releaseYear?: number
  explicitness?: string
}

const REMASTER = /\bremaster(ed)?\b/i

/** The words that tell one edition from another: the bracket groups and a
 *  trailing " - …" of Apple's name, "Edition"/"Version" kept. Plain = "Standard". */
export function editionLabelOf(name: string, explicitness?: string, rowTitle = ''): string {
  const t = String(name || '')
  const parts: string[] = []
  for (const m of t.matchAll(/[([{]([^()[\]{}]*)[)\]}]/g)) if (m[1].trim()) parts.push(m[1].trim())
  const dash = t.match(/\s+[-–—]\s+([^-–—]+)$/)
  if (dash) parts.push(dash[1].trim())
  // Apple's " - Single" / " - EP" stamps say what the release is, not which edition,
  // and a bracket the row's own title has is the record's name ("Enter the Wu-Tang (36 Chambers)").
  const own = recoNorm(rowTitle)
  const kept = parts.filter((p) => !/^(single|ep)$/i.test(p) && !(own && recoNorm(p) && own.includes(recoNorm(p))))
  // A name that is more than the row's title plus labels ("Animals 50") is its own label.
  const bare = t.replace(/[([{][^()[\]{}]*[)\]}]/g, '').replace(/\s+[-–—]\s+[^-–—]+$/, '').replace(/\s{2,}/g, ' ').trim()
  const rowBare = String(rowTitle || '').replace(/[([{][^()[\]{}]*[)\]}]/g, '').replace(/\s+[-–—]\s+[^-–—]+$/, '').trim()
  if (rowBare && bare && recoNorm(bare) !== recoNorm(rowBare)) kept.unshift(bare)
  const label = kept.join(', ') || 'Standard'
  return explicitness === 'cleaned' ? (label === 'Standard' ? 'Clean' : `${label}, clean`) : label
}

const markersOf = (x: string): string => JSON.stringify([packagingMarkersOf(x), requestedVersionMarkers(x).sort()])

export function chooseAlbumEditions(rows: readonly ItunesAlbumRow[], artist: string, title: string): AlbumEditions {
  const a = (artist || '').trim(), t = (title || '').trim()
  if (!a || !t) return { ok: true, editions: [], chosenId: null }
  const base = searchTitle(t) || t
  const real = rows.filter((r) => r.collectionId > 0 && r.collectionName
    && r.artistName && recoArtistMatches(a, r.artistName)
    && recoTitleMatches(base, searchTitle(r.collectionName) || r.collectionName)
    && !unwantedVersionOf(t, r.collectionName))
  const unique = [...new Map(real.map((r) => [r.collectionId, r])).values()]
  // The clean edit of an edition Apple also has explicit is not an edition.
  const sameRecord = (x: ItunesAlbumRow, y: ItunesAlbumRow): boolean =>
    recoNorm(x.collectionName.replace(/\s*[([{][^)\]}]*(clean|edited|amended)[^)\]}]*[)\]}]/gi, '')) === recoNorm(y.collectionName.replace(/\s*[([{][^)\]}]*(clean|edited|amended)[^)\]}]*[)\]}]/gi, ''))
    && (x.trackCount ?? -1) === (y.trackCount ?? -1)
  const kept = unique.filter((r) => !(r.explicitness === 'cleaned' && unique.some((o) => o !== r && o.explicitness !== 'cleaned' && sameRecord(r, o))))
  const editions: AlbumEdition[] = kept.map((r) => ({
    collectionId: r.collectionId,
    name: r.collectionName,
    label: editionLabelOf(r.collectionName, r.explicitness, t),
    ...(r.trackCount ? { trackCount: r.trackCount } : {}),
    ...(r.releaseYear ? { releaseYear: r.releaseYear } : {}),
    ...(r.explicitness ? { explicitness: r.explicitness } : {}),
  }))
  const want = markersOf(t)
  const exactName = recoNorm(t)
  const wantsRemaster = REMASTER.test(t)
  const rank = (e: AlbumEdition): number[] => [
    recoNorm(e.name) === exactName ? 0 : 1,
    !wantsRemaster && REMASTER.test(e.name) ? 1 : 0,
    e.explicitness === 'cleaned' ? 1 : 0,
    e.releaseYear ?? 9999,
    e.collectionId,
  ]
  const byRank = (x: AlbumEdition, y: AlbumEdition): number => {
    const rx = rank(x), ry = rank(y)
    for (let i = 0; i < rx.length; i++) if (rx[i] !== ry[i]) return rx[i] - ry[i]
    return 0
  }
  const chosen = editions.filter((e) => markersOf(e.name) === want).sort(byRank)[0] ?? null
  // The menu: the chosen one first, then the rest by release.
  const rest = editions.filter((e) => e !== chosen).sort((x, y) => (x.releaseYear ?? 9999) - (y.releaseYear ?? 9999) || x.collectionId - y.collectionId)
  return { ok: true, editions: chosen ? [chosen, ...rest] : rest, chosenId: chosen?.collectionId ?? null }
}
