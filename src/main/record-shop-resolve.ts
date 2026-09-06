/** Resolve a shop item's catalogue identity and library ownership — main's
 *  job (the catalogue lookup and the identity matcher live here). Injected
 *  deps keep it unit-testable without iTunes or the library file. */
import { buildRequestedAlbum, type LibraryTrackLite } from './album-identity.ts'
import { assessShopReleaseOwnership } from './record-shop-adapters.ts'
import { shopSnapshot, type ShopSelection, type ShopOwnership, type Snapshot } from '../common/record-shop.ts'
import type { RequestedRecording } from '../common/acquisition-identity.ts'
import type { ShopResolveRequest, ShopResolveResult } from '../common/record-shop-live.ts'

export interface ShopResolveDeps {
  albumTracks: (ref: number | { artist?: string; album: string }) => Promise<{ ok: boolean; tracks: Array<{ song: string; trackNumber?: number; discNumber?: number; discCount?: number; durationSecs?: number; explicitness?: string }>; album?: string; artist?: string; releaseYear?: number; trackCount?: number; collectionId?: number }>
  library: () => Promise<LibraryTrackLite[]>
}

const norm = (s: string): string => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** Changes whenever a row is added or removed — enough to invalidate verdicts. */
export function libraryRevisionOf(lib: LibraryTrackLite[]): string {
  let max = 0
  for (const t of lib) if ((t.id ?? 0) > max) max = t.id as number
  return `library@${lib.length}:${max}`
}

export async function resolveShopSelection(req: ShopResolveRequest, deps: ShopResolveDeps): Promise<ShopResolveResult> {
  const lib = await deps.library().catch(() => [] as LibraryTrackLite[])
  const libraryRevision = libraryRevisionOf(lib)
  if (req.kind === 'release') {
    type AlbumTracks = Awaited<ReturnType<ShopResolveDeps['albumTracks']>>
    const found: AlbumTracks = await deps.albumTracks(req.collectionId ?? { artist: req.artist, album: req.album }).catch((): AlbumTracks => ({ ok: false, tracks: [] }))
    if (!found.ok || !found.tracks.length) return { ok: false, error: 'tracklist-unavailable' }
    const cid = found.collectionId ?? req.collectionId
    const request = buildRequestedAlbum({
      artist: found.artist || req.artist, title: found.album || req.album,
      trackCount: found.trackCount ?? req.trackCount,
      tracks: found.tracks.map((t) => ({ title: t.song, trackNumber: t.trackNumber, discNumber: t.discNumber, durationSec: t.durationSecs, explicitness: t.explicitness })),
      discCount: found.tracks.reduce((m, t) => Math.max(m, t.discCount ?? t.discNumber ?? 1), 0) || undefined,
      releaseYear: found.releaseYear ?? req.releaseYear, collectionId: cid,
    })
    const selection = shopSnapshot({ kind: 'release' as const, revision: cid ? `itunes:collection:${cid}` : `itunes:album:${norm(request.artist)}:${norm(request.title)}`, request })
    return { ok: true, selection, ownership: assessShopReleaseOwnership(selection, lib, libraryRevision), libraryRevision }
  }
  const artist = req.artist.trim(), title = req.title.trim()
  const request: RequestedRecording = { artist, title, album: (req.album || '').trim(), artistNorm: norm(artist), titleNorm: norm(title), durationSec: req.durationSec || 0, durationTolSec: 5, explicit: 'unknown', requestedMarkers: [], providerIds: {} }
  const selection = shopSnapshot({ kind: 'recording' as const, revision: `recording:${norm(artist)}:${norm(title)}:${req.durationSec || 0}`, request })
  // Without a runtime a title is only text; the shop says "unknown" rather
  // than calling a different recording of the same name owned.
  let ownership: Snapshot<ShopOwnership> = { status: 'unknown' }
  if (req.durationSec) {
    const one = buildRequestedAlbum({ artist, title: request.album || title, trackCount: 1, tracks: [{ title, durationSec: req.durationSec }] })
    ownership = assessShopReleaseOwnership({ kind: 'release', revision: selection.revision, request: one } as Snapshot<Extract<ShopSelection, { kind: 'release' }>>, lib, libraryRevision)
  }
  return { ok: true, selection, ownership, libraryRevision }
}
