import { useState, useMemo, useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import { buildNormalizedArtworkIndex, lookupArtwork, queueArtworkResolutions } from '../utils/artworkLookup'
import { prefetchAlbumArtHashes } from '../utils/artworkPrefetch'
import AlbumGrid, { type AlbumGridItem } from './AlbumGrid'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import EmptyState from '../components/EmptyState'
import { albumKeyFromStrings } from '../utils/albumKey'
import { albumMenuEntries } from '../utils/libraryMenus'
import { sortAlbumTracks } from '../utils/albumTrackOrder'
import { ensureLiveSetsLoaded } from '../liveSets'
import { isCompleteRecord } from '../utils/liveSetCompleteness'
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
/// everywhere. Click opens the album detail; the hover ▶ plays the
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

  // V7: the Albums view's own album menu (utils/libraryMenus.ts), not a copy
  // that drifted (this grid's lacked Live Concert Mode, Island Albums, Share).
  useEffect(() => { void ensureLiveSetsLoaded() }, [])
  const albumMenuItems = useCallback((album: Album): MenuEntry[] => albumMenuEntries({
    album, library: lib.tracks, playlists: lib.playlists, playTrack, libDispatch, pbDispatch,
  }), [lib.tracks, lib.playlists, playTrack, libDispatch, pbDispatch])

  // 2026-10-21: the same windowed, memoized wall as Albums (components/
  // AlbumGrid.tsx) — only rows near the viewport are mounted, and a playback
  // tick re-renders no cards. V7: click opens the album; on a complete record
  // the hover ▶ plays it in running order, as on the Albums view (double-click no longer plays: the
  // first click had already opened the album, so it never could).
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridItems = useMemo((): AlbumGridItem[] => albums.map((album) => ({
    key: albumKeyFromStrings(album.artist, album.name), album, artHash: findArtHash(album), ordered: sortAlbumTracks(album.tracks),
    fullAlbum: isCompleteRecord(album.tracks),
  })), [albums, findArtHash])
  const openAlbum = useCallback((key: string) => libDispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: key }), [libDispatch])
  const openMenu = useCallback((e: ReactMouseEvent, album: Album) => setCtxMenu({ x: e.clientX, y: e.clientY, album }), [])
  const playAlbum = useCallback((ordered: Track[]) => { if (ordered.length) playTrack(ordered[0], ordered, 0, undefined, true, true) }, [playTrack])

  if (albums.length === 0) {
    return <EmptyState query={lib.searchQuery} noun={emptyNoun} />
  }

  return (
    <div className="track-grid-view" ref={scrollRef}>
      <AlbumGrid
        items={gridItems}
        scrollRef={scrollRef}
        geometryKey="track-grid"
        onOpen={openAlbum}
        onContextMenu={openMenu}
        onPlayAlbum={playAlbum}
        draggable
      />
      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={albumMenuItems(ctxMenu.album)} onClose={() => setCtxMenu(null)} />
      )}
    </div>
  )
}
