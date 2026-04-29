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

// Album grouping key.
//
// ⚠️ NOT a true twin of the desktop's grouping key (which is
// `${groupArtist}|||${albumKey}` with a `|||` separator and a
// `.trim()` step on the album side — see
// src/renderer/views/AlbumsView.tsx and src/renderer/views/ArtistsView.tsx,
// which themselves use TWO different shapes: `|||` and `::`).
// Mobile's key is used ONLY for navigation params (Album detail
// route) — it never crosses the wire. If we ever sync grouping
// metadata with the desktop or have to merge album-level user state,
// this needs to be unified across the renderer/mobile boundary in a
// single canonicalization function with explicit Pt./Part rules
// (see docs/postmortems/2026-04-25-verify-repair-cascade.md).
//
// Until then, the rule is: never compare an albumKey on this side to
// an albumKey from the desktop. They're both derived locally for
// local use.
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
