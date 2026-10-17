/**
 * New arrivals, live side (2026-10-17). The rules are pure in
 * common/arrivals.ts; this gathers the library facts and runs the IPCs.
 *
 * Art: an import used to get only its EMBEDDED cover, the boot pass stops
 * at 16 albums, and phone downloads got nothing — so new albums sat
 * coverless. After a batch lands, each album still without art goes
 * through the same two steps as everywhere else: disk/normalized resolve
 * (requestArtworkResolution), then fetchAlbumArt WITHOUT force — so a
 * hand-set (locked) cover or one already on disk is never replaced, and the
 * fetch keeps its strict artist/album match. Two at a time.
 */
import type { Track } from '../types'
import { albumArtKey, albumsNeedingArt, runLimited } from '../../common/arrivals'
import { buildNormalizedArtworkIndex, lookupArtwork, requestArtworkResolution, clearArtworkNegativeCache } from './artworkLookup'
import { evaluateSmartPlaylist } from './smartPlaylists'

type ArtDispatch = (action: { type: 'ADD_ARTWORK'; key: string; hash: string }) => void

const ARRIVAL_ART_CONCURRENCY = 2
/** Albums this session already sent through the pass — two batches from
 *  the same album (or a retry) never fetch it twice. */
const attempted = new Set<string>()

export function fetchArtForArrivals(
  tracks: readonly Pick<Track, 'artist' | 'album'>[],
  getArtworkMap: () => Record<string, string>,
  dispatch: ArtDispatch,
): void {
  const map = getArtworkMap()
  const index = buildNormalizedArtworkIndex(map)
  const missing = albumsNeedingArt(tracks, (artist, album) => !!lookupArtwork(map, index, artist, album))
    .filter(({ artist, album }) => !attempted.has(albumArtKey(artist, album)))
  if (missing.length === 0) return
  for (const { artist, album } of missing) attempted.add(albumArtKey(artist, album))
  console.log(`[arrival-art] ${missing.length} new album(s) without art — resolving`)
  void runLimited(missing, ARRIVAL_ART_CONCURRENCY, async ({ artist, album }) => {
    // Disk first: embedded art the import just wrote, or a cover filed
    // under a variant spelling, resolves without the network.
    if (await requestArtworkResolution(artist, album, dispatch)) return
    try {
      const r = await window.electronAPI.fetchAlbumArt(artist, album)
      if (r.ok && r.key && r.hash) {
        clearArtworkNegativeCache(artist, album)
        dispatch({ type: 'ADD_ARTWORK', key: r.key, hash: r.hash })
      }
    } catch (err) {
      console.warn(`[arrival-art] fetch failed for ${artist} — ${album}:`, err)
    }
  })
}

/** How many of `arrivals` are in Recently Added right now — counted on the
 *  library PLUS the arrivals, since the reducer may not have re-rendered
 *  the last of them yet. The same smart-list rule the sync pins. */
export function countInRecentlyAdded(arrivals: readonly Track[], library: readonly Track[]): number {
  if (arrivals.length === 0) return 0
  const byId = new Map<number, Track>()
  for (const t of library) byId.set(t.id, t)
  for (const t of arrivals) if (!byId.has(t.id)) byId.set(t.id, t)
  const ra = new Set(evaluateSmartPlaylist('recently-added', [...byId.values()]).map((t) => t.id))
  let n = 0
  for (const t of arrivals) if (ra.has(t.id)) n++
  return n
}
