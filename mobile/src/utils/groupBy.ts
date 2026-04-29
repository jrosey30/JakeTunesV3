import type { Track } from '@/types'

export interface AlbumGroup {
  key: string
  album: string
  albumArtist: string
  year: number | string
  tracks: Track[]
}

export interface ArtistGroup {
  artist: string
  albumCount: number
  trackCount: number
}

// Stable album key matches the desktop's grouping key shape so the
// same albums collapse the same way on both clients. Keep these in
// sync with the desktop's groupBy logic.
export function albumKey(track: Track): string {
  const artist = (track.albumArtist || track.artist || 'Unknown').toLowerCase()
  const album = (track.album || 'Unknown').toLowerCase()
  return `${artist}::${album}`
}

export function groupByAlbum(tracks: Track[]): AlbumGroup[] {
  const map = new Map<string, AlbumGroup>()
  for (const t of tracks) {
    const key = albumKey(t)
    const existing = map.get(key)
    if (existing) {
      existing.tracks.push(t)
    } else {
      map.set(key, {
        key,
        album: t.album || 'Unknown Album',
        albumArtist: t.albumArtist || t.artist || 'Unknown Artist',
        year: t.year,
        tracks: [t],
      })
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    a.albumArtist.localeCompare(b.albumArtist) || a.album.localeCompare(b.album),
  )
}

export function groupByArtist(tracks: Track[]): ArtistGroup[] {
  const map = new Map<string, { albums: Set<string>; tracks: number }>()
  for (const t of tracks) {
    const artist = t.albumArtist || t.artist || 'Unknown Artist'
    const entry = map.get(artist) ?? { albums: new Set<string>(), tracks: 0 }
    entry.albums.add(t.album || 'Unknown Album')
    entry.tracks += 1
    map.set(artist, entry)
  }
  return Array.from(map.entries())
    .map(([artist, v]) => ({ artist, albumCount: v.albums.size, trackCount: v.tracks }))
    .sort((a, b) => a.artist.localeCompare(b.artist))
}
