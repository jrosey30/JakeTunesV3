import type { Track } from '../types'
import { albumKeyOf } from './albumKey'
import { sortAlbumTracks } from './albumTrackOrder'
import { compareNames } from './artistSort'

/// V5 facelift: the album-grouping logic extracted verbatim from
/// AlbumsView.tsx so three consumers share ONE implementation instead of
/// three drifting copies: AlbumsView (whole library), TrackGridView
/// (Grid mode over any track list), CoverFlowView (Cover Flow carousel).
/// Grouping key = albumKeyOf (canonical artist|||album); track order
/// within an album = sortAlbumTracks; album order = compareNames.

export interface Album {
  name: string
  artist: string
  artists: string[]   // all unique artist variants for art lookup
  year: string | number
  tracks: Track[]
}

export function groupTracksIntoAlbums(tracks: Track[]): Album[] {
  const map = new Map<string, Album>()
  for (const t of tracks) {
    const key = albumKeyOf(t)
    if (!map.has(key)) {
      map.set(key, {
        name: t.album || 'Unknown Album',
        artist: t.albumArtist || t.artist || 'Unknown Artist',
        artists: [],
        year: t.year || '',
        tracks: [],
      })
    }
    const album = map.get(key)!
    album.tracks.push(t)
    const a = (t.artist || '').trim()
    if (a && !album.artists.includes(a)) album.artists.push(a)
    if (t.albumArtist) {
      const aa = t.albumArtist.trim()
      if (aa && !album.artists.includes(aa)) album.artists.push(aa)
    }
    if (!album.year && t.year) album.year = t.year
  }
  for (const album of map.values()) {
    album.tracks = sortAlbumTracks(album.tracks)
  }
  return Array.from(map.values()).sort((a, b) => compareNames(a.name, b.name))
}
