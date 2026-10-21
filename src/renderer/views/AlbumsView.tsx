import { useState, useMemo, useCallback, useRef, useEffect, type MouseEvent as ReactMouseEvent } from 'react'
import type { Track } from '../types'
import { useLibrary } from '../context/LibraryContext'
import { useRegularLibraryTracks } from '../hooks/useRegularLibraryTracks'
import { usePlayback } from '../context/PlaybackContext'
import { buildNormalizedArtworkIndex, lookupArtwork, queueArtworkResolutions } from '../utils/artworkLookup'
import { prefetchAlbumArtHashes } from '../utils/artworkPrefetch'
import AlbumGrid, { type AlbumGridHandle, type AlbumGridItem } from '../components/AlbumGrid'
import { useScrollPersistence, getSavedScrollTop } from '../hooks/useScrollPersistence'
import { albumKeyOf, albumKeyFromStrings } from '../utils/albumKey'
import ScrollTopButton from '../components/ScrollTopButton'
import FindBar from '../components/FindBar'
import { useFindState } from '../hooks/useFindState'
import { sortAlbumTracks } from '../utils/albumTrackOrder'
import EmptyState from '../components/EmptyState'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import { useAudio } from '../hooks/useAudio'
// V5 facelift: Album type + grouping extracted to utils/albumGroups.ts,
// shared with TrackGridView (Grid mode) and CoverFlowView.
import { groupTracksIntoAlbums, type Album } from '../utils/albumGroups'
// V5 Live Concert Mode — declared-set lookups for the context menu.
import { useSyncExternalStore } from 'react'
import { subscribeLiveSets, getLiveSetsSnapshot, ensureLiveSetsLoaded } from '../liveSets'
import { verifyLiveSetCompleteness } from '../utils/liveSetCompleteness'
import '../styles/albums.css'
import { albumMenuEntries } from '../utils/libraryMenus'
// 2026-10-18 — TOP 10 ISLAND ALBUMS, synced with the phone through homemini.
import IslandAlbumsShelf from '../components/IslandAlbumsShelf'
import { useSyncedPicksLive } from '../syncedPicks'

export default function AlbumsView() {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { state: pb, dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; album: Album } | null>(null)
  // V5 Live Concert Mode — menu entries reflect the album's declared state.
  // Undeclare deliberately lives ONLY on the album detail page (it's a
  // deletion; it gets the full ConfirmDialog there, not a one-click menu).
  useEffect(() => { void ensureLiveSetsLoaded() }, [])
  useSyncExternalStore(subscribeLiveSets, getLiveSetsSnapshot)
  // Island Albums stay fresh while this view is up even when the shelf is
  // hidden by a filter — the album menu's "Add to Island Albums…" edits the
  // shared list from the snapshot, so it must not be a stale one.
  useSyncedPicksLive('island-albums')
  // The menu itself is shared (utils/libraryMenus.ts) — the Home's album
  // cards, G's covers and Today's pick open the same one.
  const albumMenuItems = useCallback((album: Album): MenuEntry[] => albumMenuEntries({
    album,
    library: lib.tracks,
    playlists: lib.playlists,
    playTrack,
    libDispatch,
    pbDispatch,
  }), [playTrack, pbDispatch, libDispatch, lib.tracks, lib.playlists])

  // Returning from AlbumDetailView leaves pendingAlbumKey set — clear it.
  // 2026-10-21: no longer scrolls to that album's card. The page you return to
  // is the page you left (kept alive under the album page, scroll intact), so
  // the card you opened from the grid is already in view; the scroll only ever
  // MOVED you — a 200–350 px smooth drift after every back, and an album opened
  // from the Island shelf at the top threw the page 53,000 px down the grid.
  useEffect(() => {
    if (lib.currentView !== 'albums') return
    if (!lib.pendingAlbumKey) return
    libDispatch({ type: 'CLEAR_PENDING_ALBUM_KEY' })
  }, [lib.pendingAlbumKey, lib.currentView, libDispatch])

  // Declared full concerts (both the "(Live Set)" merged album tile AND the raw
  // constituent album) drop out of the Albums grid — they live in the Full Live
  // Concerts section. Constituents re-appear here once individually reimported.
  const regularTracks = useRegularLibraryTracks(lib.tracks)
  const albums = useMemo((): Album[] => groupTracksIntoAlbums(regularTracks), [regularTracks])

  const effectiveQuery = (lib.searchQuery || '').trim().toLowerCase()
  const [albFilter, setAlbFilter] = useState('')
  const af = albFilter.trim().toLowerCase()
  const filteredAlbums = useMemo(() => {
    let result = albums
    if (effectiveQuery) {
      const q = effectiveQuery
      result = result.filter(a =>
        a.name.toLowerCase().includes(q) ||
        a.artist.toLowerCase().includes(q) ||
        a.artists.some(art => art.toLowerCase().includes(q)) ||
        a.tracks.some(t => (t.title || '').toLowerCase().includes(q)),
      )
    }
    // In-view filter box — album or artist name.
    if (af) result = result.filter(a => a.name.toLowerCase().includes(af) || a.artist.toLowerCase().includes(af))
    return result
  }, [albums, effectiveQuery, af])

  // ⌘F find-in-view: jump to an album card + flash it (cards carry
  // data-album-key, all in the DOM).
  const find = useFindState(lib.currentView === 'albums')   // a kept-alive (hidden) grid never answers ⌘F
  const findMatches = useMemo(() => {
    const q = find.query.trim().toLowerCase()
    if (!q) return [] as string[]
    return filteredAlbums
      .filter(a => a.name.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q))
      .map(a => albumKeyFromStrings(a.artist, a.name))
  }, [filteredAlbums, find.query])
  // The grid is windowed: the match may not be mounted — reveal it by index.
  const gridHandleRef = useRef<AlbumGridHandle>(null)
  const jumpToFind = useCallback((c: number) => {
    const key = findMatches[c]
    if (!key) return
    const index = filteredAlbums.findIndex(a => albumKeyFromStrings(a.artist, a.name) === key)
    if (index < 0) return
    gridHandleRef.current?.reveal(index, 'center', (el) => {
      el.classList.add('find-hit')
      window.setTimeout(() => el.classList.remove('find-hit'), 1400)
    })
  }, [findMatches, filteredAlbums])
  useEffect(() => {
    if (!find.open || findMatches.length === 0) return
    jumpToFind(Math.min(find.cursor, findMatches.length - 1))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find.open, find.query, findMatches.length])
  const findNext = useCallback(() => {
    if (findMatches.length === 0) return
    const c = (find.cursor + 1) % findMatches.length
    find.setCursor(c); jumpToFind(c)
  }, [findMatches.length, find, jumpToFind])
  const findPrev = useCallback(() => {
    if (findMatches.length === 0) return
    const c = (find.cursor - 1 + findMatches.length) % findMatches.length
    find.setCursor(c); jumpToFind(c)
  }, [findMatches.length, find, jumpToFind])

  const normalizedArtIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])
  const findArtHash = useCallback((album: Album): string | undefined => {
    for (const artist of album.artists) {
      const hit = lookupArtwork(lib.artworkMap, normalizedArtIndex, artist, album.name)
      if (hit) return hit
    }
    return lookupArtwork(lib.artworkMap, normalizedArtIndex, album.artist, album.name)
  }, [lib.artworkMap, normalizedArtIndex])

  // Island shelf: covers for picks this library doesn't group as an album,
  // and the same idle resolver for any shelf cover the map lacks.
  const lookupArt = useCallback((artist: string, album: string) => lookupArtwork(lib.artworkMap, normalizedArtIndex, artist, album), [lib.artworkMap, normalizedArtIndex])
  const requestArt = useCallback((list: Array<{ artist: string; album: string }>) => queueArtworkResolutions(list, libDispatch), [libDispatch])

  // Resolve missing covers in small idle batches — never during render.
  useEffect(() => {
    if (lib.currentView !== 'albums') return
    const missing = filteredAlbums.slice(0, 32).filter(a => !findArtHash(a))
    if (missing.length === 0) return
    queueArtworkResolutions(
      missing.map(a => ({ artist: a.artist || a.artists[0] || '', album: a.name })),
      libDispatch,
    )
  }, [lib.currentView, filteredAlbums, findArtHash, libDispatch])

  // Warm caches for the first screenful so covers pop in without stagger.
  useEffect(() => {
    if (lib.currentView !== 'albums') return
    prefetchAlbumArtHashes(filteredAlbums.slice(0, 48).map(a => findArtHash(a)), 320)
  }, [lib.currentView, filteredAlbums, findArtHash, lib.artworkMap])

  const openAlbum = useCallback((key: string) => {
    libDispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: key })
  }, [libDispatch])

  // Per-album work done ONCE per album list, not per card per render (it used
  // to run for all 2,579 cards on every playback tick). Running order + the
  // Album Mode gate: the ▶ Album button appears ONLY when the record is
  // verifiably complete — the same completeness doctrine the live-set merge
  // uses (one definition, no twin).
  const albumMeta = useMemo(() => filteredAlbums.map((album) => {
    const ordered = sortAlbumTracks(album.tracks)
    const comp = verifyLiveSetCompleteness(ordered)
    return { key: albumKeyFromStrings(album.artist, album.name), album, ordered, fullAlbum: !!(comp.complete && comp.verifiedTotal) }
  }), [filteredAlbums])
  // Covers resolve while you browse (artworkMap changes) — a cheap second pass.
  const gridItems = useMemo((): AlbumGridItem[] => albumMeta.map((m) => ({ ...m, artHash: findArtHash(m.album) })), [albumMeta, findArtHash])
  const openAlbumMenu = useCallback((e: ReactMouseEvent, album: Album) => setCtxMenu({ x: e.clientX, y: e.clientY, album }), [])
  const playFullAlbum = useCallback((ordered: Track[]) => {
    if (ordered.length) playTrack(ordered[0], ordered, 0, undefined, true, /* an album's running order IS the record */ true)
  }, [playTrack])

  const viewRootRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('albums', viewRootRef)
  const lastUserActivityAtRef = useRef<number>(0)
  const isAutoScrollAtRef = useRef<number>(0)
  const FOLLOW_IDLE_MS = 5000
  const noteUserActivity = useCallback(() => {
    if (Date.now() - isAutoScrollAtRef.current > 200) {
      lastUserActivityAtRef.current = Date.now()
    }
  }, [])

  // Follow the playing album when the TRACK CHANGES while this page is up and
  // idle — never on mount or on a return (same rule as Artists, 2026-10-21).
  const followedIdRef = useRef(pb.nowPlaying?.id)
  useEffect(() => {
    const id = pb.nowPlaying?.id
    if (id === followedIdRef.current) return
    followedIdRef.current = id
    if (lib.currentView !== 'albums') return
    if (!pb.nowPlaying) return
    if (Date.now() - lastUserActivityAtRef.current < FOLLOW_IDLE_MS) return
    const key = albumKeyOf(pb.nowPlaying)
    const index = filteredAlbums.findIndex(a => albumKeyFromStrings(a.artist, a.name) === key)
    if (index < 0) return
    isAutoScrollAtRef.current = Date.now()
    requestAnimationFrame(() => gridHandleRef.current?.reveal(index, 'nearest'))
  }, [pb.nowPlaying?.id, lib.currentView, filteredAlbums])

  return (
    <div
      className="albums-view"
      ref={viewRootRef}
      onClickCapture={noteUserActivity}
      onWheelCapture={noteUserActivity}
      onScrollCapture={noteUserActivity}
      onKeyDownCapture={noteUserActivity}
    >
      <div className="albums-toolbar">
        <div className="list-filter">
          <span className="list-filter-icon" aria-hidden="true">⌕</span>
          <input
            className="list-filter-input"
            type="text"
            placeholder="Filter albums…"
            value={albFilter}
            onChange={(e) => setAlbFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setAlbFilter('') }}
            spellCheck={false}
            aria-label="Filter albums"
          />
          {albFilter && (
            <button className="list-filter-clear" onClick={() => setAlbFilter('')} aria-label="Clear filter" title="Clear">×</button>
          )}
        </div>
      </div>
      <ScrollTopButton targetRef={viewRootRef} />
      {find.open && (
        <FindBar
          query={find.query}
          onQuery={find.setQuery}
          current={find.cursor}
          total={findMatches.length}
          onNext={findNext}
          onPrev={findPrev}
          onClose={find.close}
          placeholder="Find album or artist…"
        />
      )}
      {/* Hidden while the search pill or the filter narrows the grid — the
          results are the point then (same rule as the Artists shelves). */}
      {!effectiveQuery && !af && (
        <IslandAlbumsShelf albums={albums} findArtHash={findArtHash} lookupArt={lookupArt} requestArt={requestArt} onOpenAlbum={openAlbum} />
      )}
      {filteredAlbums.length === 0 && (
        <EmptyState query={lib.searchQuery} noun="albums" />
      )}
      <AlbumGrid
        ref={gridHandleRef}
        items={gridItems}
        scrollRef={viewRootRef}
        geometryKey="albums"
        initialScrollTop={getSavedScrollTop('albums')}
        onOpen={openAlbum}
        onContextMenu={openAlbumMenu}
        onPlayAlbum={playFullAlbum}
        draggable
      />
      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={albumMenuItems(ctxMenu.album)} onClose={() => setCtxMenu(null)} />
      )}
    </div>
  )
}
