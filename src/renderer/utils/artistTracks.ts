/**
 * Which songs belong to an artist — the Artists view's rule, moved here
 * (2026-10-20) so anything else that stands for an artist (the Home's Now
 * Digging posters) carries the same songs when dragged as an Artists tile.
 *
 * One group per canonical artist (artist aliases applied); a collab track
 * counts for every contributor. Keyed by artistIdentityKey.
 */
import type { Track } from '../types'
import { artistIdentityKey, canonicalArtist } from './artistAlias'

export function groupTracksByArtist(tracks: readonly Track[]): Map<string, { name: string; tracks: Track[] }> {
  const map = new Map<string, { name: string; tracks: Track[] }>()
  for (const t of tracks) {
    const contributors = t.contributingArtists && t.contributingArtists.length > 0 ? t.contributingArtists : [t.artist || 'Unknown Artist']
    const seen = new Set<string>()
    for (const raw of contributors) {
      const display = canonicalArtist(raw || 'Unknown Artist')
      const key = artistIdentityKey(display)
      if (seen.has(key)) continue
      seen.add(key)
      const g = map.get(key) ?? { name: display, tracks: [] }
      g.tracks.push(t)
      map.set(key, g)
    }
  }
  return map
}

/** One artist's songs, in library order — exactly what that artist's tile in
 *  the Artists view puts on a drag. Empty when the library has none. */
export function tracksForArtist(tracks: readonly Track[], name: string): Track[] {
  return groupTracksByArtist(tracks).get(artistIdentityKey(canonicalArtist(name)))?.tracks ?? []
}
