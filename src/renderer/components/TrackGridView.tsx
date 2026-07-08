import { useState, useMemo, useCallback, useEffect } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import { buildNormalizedArtworkIndex, lookupArtwork, queueArtworkResolutions } from '../utils/artworkLookup'
import { prefetchAlbumArtHashes } from '../utils/artworkPrefetch'
import AlbumArtImage from '../components/AlbumArtImage'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import EmptyState from '../components/EmptyState'
import { albumKeyFromStrings } from '../utils/albumKey'
import { canonicalArtist } from '../utils/artistAlias'
import { groupTracksIntoAlbums, type Album } from '../utils/albumGroups'
import type { Track } from '../types'
import '../styles/albums.css'

/// V5 facelift: Grid mode for the flat-table views (Songs / Playlist /
/// Smart Playlist) — the iTunes-10 album-tile wall. This is a shared
/// presentational component parameterized by the CALLER's track list
/// (already sorted/filtered), so a playlist's Grid shows only that
/// playlist's albums. Rendering + interactions mirror AlbumsView's
/// existing grid exactly (same albums.css classes, same artwork lookup
/// chain, same context-menu shape) — one visual language for tiles
/// everywhere. Click opens the album detail; double-click plays the
/// album; right-click gives the same menu AlbumsView has.
interface TrackGridViewProps {
  tracks: Track[]
  emptyNoun: string   // EmptyState noun when the caller's list is empty
}

export default function TrackGridView({ tracks, emptyNoun }: TrackGridViewProps) {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; album: Album } | null>(null)

  const albums = useMemo(() => groupTracksIntoAlbums(tracks), [tracks])

  const normalizedArtIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])
  const findArtHash = useCallback((album: Album): string | undefined => {
    for (const artist of album.artists) {
      const hit = lookupArtwork(lib.artworkMap, normalizedArtIndex, artist, album.name)
      if (hit) return hit
    }
    return lookupArtwork(lib.artworkMap, normalizedArtIndex, album.artist, album.name)
  }, [lib.artworkMap, normalizedArtIndex])

  // Same idle-batched artwork resolution + first-screenful prefetch
  // pattern as AlbumsView (no currentView gate — this component only
  // mounts while its host view is active).
  useEffect(() => {
    const missing = albums.slice(0, 32).filter(a => !findArtHash(a))
    if (missing.length === 0) return
    queueArtworkResolutions(
      missing.map(a => ({ artist: a.artist || a.artists[0] || '', album: a.name })),
      libDispatch,
    )
  }, [albums, findArtHash, libDispatch])

  useEffect(() => {
    prefetchAlbumArtHashes(albums.slice(0, 48).map(a => findArtHash(a)), 320)
  }, [albums, findArtHash, lib.artworkMap])

  const albumMenuItems = useCallback((album: Album): MenuEntry[] => {
    const ordered = album.tracks
    return [
      { label: `Play "${album.name}"`, onClick: () => { if (ordered.length) playTrack(ordered[0], ordered, 0, undefined, true) } },
      { label: 'Shuffle', onClick: () => { const s = [...ordered].sort(() => Math.random() - 0.5); if (s.length) playTrack(s[0], s, 0, undefined, true) } },
      { separator: true as const },
      { label: 'Play Next', onClick: () => pbDispatch({ type: 'PLAY_NEXT', tracks: ordered }) },
      { label: 'Add to Up Next', onClick: () => pbDispatch({ type: 'ADD_TO_QUEUE', tracks: ordered }) },
      { separator: true as const },
      { label: 'Go to Album', onClick: () => libDispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: albumKeyFromStrings(album.artist, album.name) }) },
      { label: 'Go to Artist', onClick: () => libDispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: canonicalArtist(album.artist || '') }) },
    ]
  }, [playTrack, pbDispatch, libDispatch])

  if (albums.length === 0) {
    return <EmptyState query={lib.searchQuery} noun={emptyNoun} />
  }

  return (
    <div className="track-grid-view">
      <div className="albums-grid">
        {albums.map((album) => {
          const key = albumKeyFromStrings(album.artist, album.name)
          const artHash = findArtHash(album)
          return (
            <div
              key={key}
              className="album-card"
              data-album-key={key}
              onClick={() => libDispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: key })}
              onDoubleClick={() => { if (album.tracks.length) playTrack(album.tracks[0], album.tracks, 0, undefined, true) }}
              onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, album }) }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); libDispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: key }) } }}
              role="button"
              tabIndex={0}
            >
              <div className="album-card-art">
                {artHash ? (
                  <AlbumArtImage hash={artHash} alt={album.name} className="album-card-img" size={320} />
                ) : (
                  <svg width="32" height="32" viewBox="0 0 32 32" fill="#bbb">
                    <circle cx="16" cy="16" r="14" fill="none" stroke="#bbb" strokeWidth="1" />
                    <circle cx="16" cy="16" r="5" fill="none" stroke="#bbb" strokeWidth="1" />
                    <circle cx="16" cy="16" r="1.5" fill="#bbb" />
                  </svg>
                )}
              </div>
              <div className="album-card-title">{album.name}</div>
              <div className="album-card-artist">{album.artist}</div>
            </div>
          )
        })}
      </div>
      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={albumMenuItems(ctxMenu.album)} onClose={() => setCtxMenu(null)} />
      )}
    </div>
  )
}
