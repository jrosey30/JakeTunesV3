import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { buildNormalizedArtworkIndex, lookupArtwork, queueArtworkResolutions } from '../utils/artworkLookup'
import { prefetchAlbumArtHashes } from '../utils/artworkPrefetch'
import AlbumArtImage from '../components/AlbumArtImage'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { albumKeyOf, albumKeyFromStrings } from '../utils/albumKey'
import ScrollTopButton from '../components/ScrollTopButton'
import FindBar from '../components/FindBar'
import { useFindState } from '../hooks/useFindState'
import { sortAlbumTracks } from '../utils/albumTrackOrder'
import EmptyState from '../components/EmptyState'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import { useAudio } from '../hooks/useAudio'
import { canonicalArtist } from '../utils/artistAlias'
// V5 facelift: Album type + grouping extracted to utils/albumGroups.ts,
// shared with TrackGridView (Grid mode) and CoverFlowView.
import { groupTracksIntoAlbums, type Album } from '../utils/albumGroups'
// V5 Live Concert Mode — declared-set lookups for the context menu.
import { useSyncExternalStore } from 'react'
import { subscribeLiveSets, getLiveSetsSnapshot, ensureLiveSetsLoaded, liveSetFor } from '../liveSets'
import { declareLiveSet, isDeclareInFlight } from '../liveSetDeclare'
import { verifyLiveSetCompleteness } from '../utils/liveSetCompleteness'
import { setNotice } from '../activity'
import '../styles/albums.css'

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
  const albumMenuItems = useCallback((album: Album): MenuEntry[] => {
    const ordered = sortAlbumTracks(album.tracks)
    const key = albumKeyFromStrings(album.artist, album.name)
    const liveSet = album.name.endsWith(' (Live Set)') ? null : liveSetFor(key, lib.tracks)
    const mergedTrack = liveSet ? (lib.tracks.find(t => t.id === liveSet.mergedTrackId) ?? null) : null
    const liveEntries: MenuEntry[] = liveSet && mergedTrack
      ? [{ label: 'Play Live Set', onClick: () => playTrack(mergedTrack, [mergedTrack], 0, undefined, true) }]
      : album.name.endsWith(' (Live Set)')
        ? []
        : [{
            label: 'Declare Live Concert Mode',
            onClick: () => {
              // Jake's rule: complete album only. Pre-check here so the
              // notice explains; declareLiveSet re-verifies as the gate.
              const completeness = verifyLiveSetCompleteness(ordered)
              if (!completeness.complete) {
                setNotice(`Live Mode needs the complete album — ${completeness.reason}`)
                return
              }
              if (!completeness.verifiedTotal) {
                // Unproven total needs Jake's explicit confirm — the
                // dialog lives on the album page, so send him there.
                setNotice('The files can\'t confirm the total — confirm on the album page')
                libDispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: key })
                return
              }
              if (isDeclareInFlight()) { setNotice('A live set is already merging'); return }
              setNotice(`Merging live set — ${album.name}…`)
              declareLiveSet({ albumKey: key, name: album.name, artist: album.artist, genre: ordered[0]?.genre, year: album.year, tracks: ordered })
                .then(() => setNotice(`Live set ready — ${album.name}`))
                .catch((err) => setNotice(`Live set failed: ${err instanceof Error ? err.message : String(err)}`))
            },
          }]
    return [
      { label: `Play "${album.name}"`, onClick: () => { if (ordered.length) playTrack(ordered[0], ordered, 0, undefined, true) } },
      { label: 'Shuffle', onClick: () => { const s = [...ordered].sort(() => Math.random() - 0.5); if (s.length) playTrack(s[0], s, 0, undefined, true) } },
      ...(liveEntries.length ? [{ separator: true as const }, ...liveEntries] : []),
      { separator: true as const },
      { label: 'Play Next', onClick: () => pbDispatch({ type: 'PLAY_NEXT', tracks: ordered }) },
      { label: 'Add to Up Next', onClick: () => pbDispatch({ type: 'ADD_TO_QUEUE', tracks: ordered }) },
      { separator: true as const },
      { label: 'Go to Artist', onClick: () => libDispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: canonicalArtist(album.artist || '') }) },
    ]
  }, [playTrack, pbDispatch, libDispatch, lib.tracks])

  // When returning from AlbumDetailView (← Albums), pendingAlbumKey is still
  // set — scroll that card into view, then clear so a later sidebar visit
  // doesn't jump again.
  useEffect(() => {
    if (lib.currentView !== 'albums') return
    if (!lib.pendingAlbumKey) return
    const key = lib.pendingAlbumKey
    libDispatch({ type: 'CLEAR_PENDING_ALBUM_KEY' })
    window.setTimeout(() => {
      const card = document.querySelector(`.album-card[data-album-key="${CSS.escape(key)}"]`)
      if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 60)
  }, [lib.pendingAlbumKey, lib.currentView, libDispatch])

  const albums = useMemo((): Album[] => groupTracksIntoAlbums(lib.tracks), [lib.tracks])

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
  const find = useFindState()
  const findMatches = useMemo(() => {
    const q = find.query.trim().toLowerCase()
    if (!q) return [] as string[]
    return filteredAlbums
      .filter(a => a.name.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q))
      .map(a => albumKeyFromStrings(a.artist, a.name))
  }, [filteredAlbums, find.query])
  const jumpToFind = useCallback((c: number) => {
    const key = findMatches[c]
    if (!key) return
    const el = viewRootRef.current?.querySelector(`[data-album-key="${CSS.escape(key)}"]`) as HTMLElement | null
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    el.classList.add('find-hit')
    window.setTimeout(() => el.classList.remove('find-hit'), 1400)
  }, [findMatches])
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
    prefetchAlbumArtHashes(filteredAlbums.slice(0, 48).map(a => findArtHash(a)))
  }, [lib.currentView, filteredAlbums, findArtHash, lib.artworkMap])

  const openAlbum = useCallback((key: string) => {
    libDispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: key })
  }, [libDispatch])

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

  useEffect(() => {
    if (lib.currentView !== 'albums') return
    if (!pb.nowPlaying) return
    if (Date.now() - lastUserActivityAtRef.current < FOLLOW_IDLE_MS) return
    const key = albumKeyOf(pb.nowPlaying)
    const exists = filteredAlbums.some(a => albumKeyFromStrings(a.artist, a.name) === key)
    if (!exists) return
    isAutoScrollAtRef.current = Date.now()
    requestAnimationFrame(() => {
      const root = viewRootRef.current
      if (!root) return
      const card = root.querySelector(`[data-album-key="${CSS.escape(key)}"]`) as HTMLElement | null
      if (card) card.scrollIntoView({ block: 'nearest', behavior: 'auto' })
    })
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
      {filteredAlbums.length === 0 && (
        <EmptyState query={lib.searchQuery} noun="albums" />
      )}
      <div className="albums-grid">
        {filteredAlbums.map((album) => {
          const key = albumKeyFromStrings(album.artist, album.name)
          const artHash = findArtHash(album)
          return (
            <div
              key={key}
              className="album-card"
              data-album-key={key}
              onClick={() => openAlbum(key)}
              onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, album }) }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAlbum(key) } }}
              role="button"
              tabIndex={0}
            >
              <div className="album-card-art">
                {artHash ? (
                  <AlbumArtImage hash={artHash} alt={album.name} className="album-card-img" />
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
