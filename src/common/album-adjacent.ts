/**
 * Album adjacency — the merged-work seam test (2026-08-23, Jake: albums
 * "WHERE SONGS SOUND LIKE THEY ARE MERGED SHOULD SOUND LIKE THAT EXACTLY
 * (THE WALL, DISCOVERY… DARK SIDE OF THE MOON, ABBEY ROAD)").
 *
 * True when `next` is the SAME album's next track on the SAME disc — the
 * case where the playback seam must be sample-accurate. Cross-disc breaks
 * are physical-media gaps and stay ordinary. Pure + node-tested; consumed
 * by useAudio's gapless preload and crossfade gating.
 */
export interface AdjacencyTrack {
  album?: string | null
  artist?: string | null
  albumArtist?: string | null
  trackNumber?: number | string | null
  discNumber?: number | string | null
}

export function albumAdjacent(cur: AdjacencyTrack | null | undefined, next: AdjacencyTrack | null | undefined): boolean {
  if (!cur || !next) return false
  if (!cur.album || !next.album) return false
  const key = (t: AdjacencyTrack): string =>
    (((t.albumArtist || t.artist || '') as string).trim().toLowerCase()) + ':::' + ((t.album || '') as string).trim().toLowerCase()
  if (key(cur) !== key(next)) return false
  const disc = (t: AdjacencyTrack): number => Number(t.discNumber) || 1
  if (disc(cur) !== disc(next)) return false
  const cn = Number(cur.trackNumber) || 0
  const nn = Number(next.trackNumber) || 0
  return cn > 0 && nn === cn + 1
}
