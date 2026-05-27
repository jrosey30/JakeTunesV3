import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio, prefetchTrackForPlay, prefetchTrackImmediate } from '../hooks/useAudio'
import { buildNormalizedArtworkIndex, lookupArtwork, requestArtworkResolution } from '../utils/artworkLookup'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { SpeakerPlayingIcon } from '../assets/icons/SpeakerIcon'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import ConfirmDialog from '../components/ConfirmDialog'
import GetInfoModal from '../components/GetInfoModal'
import { ratingMenuEntries } from '../components/StarRating'
import { useCynthia } from '../context/CynthiaContext'
import { toCynthiaTrack } from '../utils/cynthia'
import { clearArtworkNegativeCache } from '../utils/artworkLookup'
import { albumKeyOf, albumKeyFromStrings } from '../utils/albumKey'
import EmptyState from '../components/EmptyState'
import { Track } from '../types'
import { setNotice } from '../activity'
import '../styles/albums.css'

interface Album {
  name: string
  artist: string
  artists: string[]   // all unique artist variants for art lookup
  year: string | number
  tracks: Track[]
}

export default function AlbumsView() {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { state: pb, dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()
  const { openCynthia } = useCynthia()
  const [selected, setSelected] = useState<string | null>(null)

  // 4.5: pending-album-key consumer. HomeView's Recently Added card
  // click dispatches VIEW_ALBUM_DETAIL with the album's lowercased
  // "artist|||album" key; the reducer flips to the 'albums' view and
  // stashes the key here. We adopt it into local `selected`, then
  // clear the pending so a later return to AlbumsView (sidebar nav,
  // etc.) doesn't re-select the same album the user already moved on
  // from. Same dance the existing artist-detail wiring does.
  useEffect(() => {
    if (lib.pendingAlbumKey) {
      const key = lib.pendingAlbumKey
      setSelected(key)
      libDispatch({ type: 'CLEAR_PENDING_ALBUM_KEY' })
      // 4.5.0-73: also scroll the picked album into view. Pre-fix even
      // when the key DID match (after the key-format alignment in this
      // same commit), the user could still be staring at row 1 of a
      // 200-album grid with the picked album on row 47 — they'd see
      // "nothing happened" and assume the click failed. Defer to the
      // next paint so the card has rendered with its selected class.
      window.setTimeout(() => {
        const card = document.querySelector(`.album-card[data-album-key="${CSS.escape(key)}"]`)
        if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }, 60)
    }
  }, [lib.pendingAlbumKey, libDispatch])
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: Track; tracks: Track[]; idx: number } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: number[]; count: number } | null>(null)
  const [getInfoState, setGetInfoState] = useState<{ tracks: Track[]; index: number } | null>(null)
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<number>>(new Set())
  const lastClickedTrackIdx = useRef<number>(-1)

  const albums = useMemo((): Album[] => {
    const map = new Map<string, Album>()
    for (const t of lib.tracks) {
      // 4.5.0-73: routed through shared `albumKeyOf` helper so this
      // matches the SearchPanel's index key format exactly. Pre-fix
      // every view computed its own key and they diverged — click-
      // through from search dropped the user on the full grid with
      // nothing selected.
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
      // Collect all unique artist variants for artwork lookup
      const a = (t.artist || '').trim()
      if (a && !album.artists.includes(a)) album.artists.push(a)
      if (t.albumArtist) {
        const aa = t.albumArtist.trim()
        if (aa && !album.artists.includes(aa)) album.artists.push(aa)
      }
      // Keep year from first track that has one
      if (!album.year && t.year) album.year = t.year
    }
    // Sort tracks within each album by disc then track number
    for (const album of map.values()) {
      album.tracks.sort((a, b) => {
        const da = Number(a.discNumber) || 1, db = Number(b.discNumber) || 1
        if (da !== db) return da - db
        const ta = Number(a.trackNumber) || 0, tb = Number(b.trackNumber) || 0
        return ta - tb
      })
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [lib.tracks])

  // Filter against the global toolbar Search Pill. Matches album name,
  // artist, or any track title — so typing a song title finds the
  // album it lives on even if you don't remember the album name.
  const effectiveQuery = (lib.searchQuery || '').trim().toLowerCase()
  const filteredAlbums = useMemo(() => {
    const q = effectiveQuery
    if (!q) return albums
    return albums.filter(a => {
      if (a.name.toLowerCase().includes(q)) return true
      if (a.artist.toLowerCase().includes(q)) return true
      if (a.artists.some(art => art.toLowerCase().includes(q))) return true
      if (a.tracks.some(t => (t.title || '').toLowerCase().includes(q))) return true
      return false
    })
  }, [albums, effectiveQuery])

  // 4.5: normalized-artwork index built once per render. The
  // lookupArtwork fall-through (exact → normalized) catches the
  // "(Remastered)" / "feat." / diacritic variants that broke the
  // old exact-string-match lookup. Multiple artists tried in
  // sequence so a compilation with the album credited under any
  // contributing artist still finds its cover.
  const normalizedArtIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])
  const findArtHash = (album: Album): string | undefined => {
    for (const artist of album.artists) {
      const hit = lookupArtwork(lib.artworkMap, normalizedArtIndex, artist, album.name)
      if (hit) return hit
    }
    const fallback = lookupArtwork(lib.artworkMap, normalizedArtIndex, album.artist, album.name)
    if (fallback) return fallback
    // 4.5.0-51: still nothing — fire the server-side resolver for the
    // primary artist+album. Disk-existence check + normalized variants
    // will hit any JPG file that's on disk under a near-match key.
    requestArtworkResolution(album.artist || album.artists[0] || '', album.name, libDispatch)
    return undefined
  }

  const handleContextMenu = useCallback((e: React.MouseEvent, track: Track, tracks: Track[], idx: number) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, track, tracks, idx })
  }, [])

  const handleTrackClick = useCallback((track: Track, idx: number, albumTracks: Track[], e: React.MouseEvent) => {
    if (e.shiftKey && lastClickedTrackIdx.current >= 0 && lastClickedTrackIdx.current < albumTracks.length) {
      const from = Math.min(lastClickedTrackIdx.current, idx)
      const to = Math.max(lastClickedTrackIdx.current, idx)
      setSelectedTrackIds(new Set(albumTracks.slice(from, to + 1).map(t => t.id)))
    } else if (e.metaKey || e.ctrlKey) {
      setSelectedTrackIds(prev => {
        const next = new Set(prev)
        if (next.has(track.id)) next.delete(track.id)
        else next.add(track.id)
        return next
      })
      lastClickedTrackIdx.current = idx
    } else {
      setSelectedTrackIds(new Set([track.id]))
      lastClickedTrackIdx.current = idx
    }
  }, [])

  // Reset track selection when switching albums
  useEffect(() => {
    setSelectedTrackIds(new Set())
    lastClickedTrackIdx.current = -1
  }, [selected])

  const getContextMenuItems = useCallback((): MenuEntry[] => {
    if (!ctxMenu) return []
    const { track, tracks, idx } = ctxMenu
    const sel = selectedTrackIds.size > 1
      ? tracks.filter(t => selectedTrackIds.has(t.id))
      : [track]
    const count = sel.length
    const label = count > 1 ? `${count} Songs` : track.title

    // Batch artwork for all unique artist+album combos
    const artPairs = new Map<string, { artist: string; album: string }>()
    for (const t of sel) {
      if (t.artist && t.album) {
        const k = `${t.artist.toLowerCase().trim()}|||${t.album.toLowerCase().trim()}`
        if (!artPairs.has(k)) artPairs.set(k, { artist: t.artist, album: t.album })
      }
    }

    const artworkItems: MenuEntry[] = artPairs.size > 0 ? [
      { separator: true as const },
      {
        label: 'Add Artwork…',
        onClick: async () => {
          const file = await window.electronAPI.chooseArtworkFile()
          if (!file.ok || !file.path) return
          let failed = 0
          let lastErr = ''
          for (const { artist, album } of artPairs.values()) {
            const result = await window.electronAPI.setCustomArtwork(artist, album, file.path)
            if (result.ok && result.key && result.hash) {
              libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
            } else {
              failed += 1
              lastErr = result.error || ''
            }
          }
          // 4.4.12: surface failures so the user knows the save didn't stick.
          if (failed > 0) {
            setNotice(
              failed === 1
                ? (lastErr ? `Couldn't save artwork: ${lastErr}` : "Couldn't save artwork.")
                : `Couldn't save artwork for ${failed} albums.`,
              { kind: 'error' }
            )
          }
        },
      },
      {
        label: 'Fetch Artwork from Internet',
        onClick: async () => {
          for (const { artist, album } of artPairs.values()) {
            const result = await window.electronAPI.fetchAlbumArt(artist, album, true)
            if (result.ok && result.key && result.hash) {
              libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
            }
          }
        },
      },
    ] : []

    // Album-level scope for Cynthia — the popover sees every track in
    // the album, which is exactly what she needs for "find the missing
    // tracks" / "fix track numbers" type questions. The user's right-
    // click coordinates anchor the popover near where they clicked.
    const albumLabel = `${track.albumArtist || track.artist} — ${track.album}`

    return [
      { label: `Play "${label}"`, onClick: () => playTrack(track, tracks, idx, undefined, true) },
      { separator: true as const },
      { label: 'Play Next', onClick: () => pbDispatch({ type: 'PLAY_NEXT', tracks: sel }) },
      { label: 'Add to Up Next', onClick: () => pbDispatch({ type: 'ADD_TO_QUEUE', tracks: sel }) },
      ...ratingMenuEntries(sel, libDispatch),
      { separator: true as const },
      { label: 'Get Info', onClick: () => setGetInfoState({ tracks: sel, index: idx }) },
      ...artworkItems,
      { separator: true as const },
      {
        label: 'Cynthia!! (this album)',
        onClick: () => {
          openCynthia({
            x: ctxMenu.x, y: ctxMenu.y,
            scope: {
              type: 'album',
              label: albumLabel,
              tracks: tracks.map(toCynthiaTrack),
            },
          })
        },
      },
      { separator: true as const },
      { label: count > 1 ? `Delete ${count} Songs` : 'Delete Song', onClick: () => setDeleteConfirm({ ids: sel.map(t => t.id), count }) },
    ]
  }, [ctxMenu, selectedTrackIds, playTrack, pbDispatch, libDispatch, openCynthia])

  const handleGetInfoSave = useCallback(
    async (updates: { id: number; field: string; value: string }[]) => {
      // 4.5.0-67 — save-first ordering. See SongsView.handleGetInfoSave
      // for the full rationale. Short version: dispatching UPDATE_TRACKS
      // before awaiting save lets the re-render fire resolveArtwork on
      // the new key before main's migration has populated it, which
      // poisons the renderer's 60s negative cache and leaves the album
      // tile blank for a minute.
      const oldArtAlbumById = new Map<number, { artist: string; album: string }>()
      for (const u of updates) {
        if (oldArtAlbumById.has(u.id)) continue
        const t = lib.tracks.find(tr => tr.id === u.id)
        if (t) oldArtAlbumById.set(u.id, { artist: t.artist || '', album: t.album || '' })
      }
      for (const u of updates) {
        await window.electronAPI.saveMetadataOverride(u.id, u.field, u.value)
      }
      if (updates.some(u => u.field === 'artist' || u.field === 'album')) {
        const newArtAlbumById = new Map<number, { artist: string; album: string }>()
        for (const [id, old] of oldArtAlbumById) newArtAlbumById.set(id, { ...old })
        for (const u of updates) {
          const cur = newArtAlbumById.get(u.id)
          if (!cur) continue
          if (u.field === 'artist') cur.artist = u.value
          else if (u.field === 'album') cur.album = u.value
        }
        for (const v of newArtAlbumById.values()) clearArtworkNegativeCache(v.artist, v.album)
      }
      libDispatch({ type: 'UPDATE_TRACKS', updates })
    },
    [libDispatch, lib.tracks]
  )

  const handleFetchArt = useCallback(
    async (artist: string, album: string, force?: boolean): Promise<{ key: string; hash: string } | null> => {
      const result = await window.electronAPI.fetchAlbumArt(artist, album, force)
      if (result.ok && result.key && result.hash) {
        libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
        return { key: result.key, hash: result.hash }
      }
      return null
    },
    [libDispatch]
  )

  const handleSetCustomArt = useCallback(
    async (artist: string, album: string, imagePath: string): Promise<{ key: string; hash: string } | null> => {
      const result = await window.electronAPI.setCustomArtwork(artist, album, imagePath)
      if (result.ok && result.key && result.hash) {
        libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
        return { key: result.key, hash: result.hash }
      }
      // 4.4.12: surface failure (usually sips conversion) so the user
      // doesn't think the art stuck just because the Get Info preview
      // still shows it from localArtHash.
      setNotice(result.error ? `Couldn't save artwork: ${result.error}` : "Couldn't save artwork.", { kind: 'error' })
      return null
    },
    [libDispatch]
  )

  // Track columns per row so we can insert the detail panel after the last album in the row
  const gridRef = useRef<HTMLDivElement>(null)
  const [colsPerRow, setColsPerRow] = useState(6)

  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const measure = () => {
      const style = getComputedStyle(grid)
      const cols = style.gridTemplateColumns.split(' ').length
      setColsPerRow(cols || 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [])

  // Auto-follow now-playing (4.0). Mirrors the SongsView pattern: when the
  // playing track changes and the user has been idle for >5s, reveal the
  // album that owns the new track — select it (so the detail panel opens
  // and the SpeakerPlayingIcon shows on the right row) and scroll the
  // card into view. lastUserActivityAtRef is bumped on any
  // click/scroll/wheel inside the view; programmatic scrolls within
  // 200ms of isAutoScrollAtRef are not counted as activity.
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
    const t = pb.nowPlaying
    const key = albumKeyOf(t)
    const exists = filteredAlbums.some(a => albumKeyFromStrings(a.artist, a.name) === key)
    if (!exists) return
    isAutoScrollAtRef.current = Date.now()
    setSelected(key)
    // Defer scroll until after React renders the (possibly newly inserted)
    // detail panel — querySelector on the previous DOM would miss layout
    // changes from the just-set selected key.
    requestAnimationFrame(() => {
      const root = viewRootRef.current
      if (!root) return
      const card = root.querySelector(`[data-album-key="${CSS.escape(key)}"]`) as HTMLElement | null
      if (card) card.scrollIntoView({ block: 'nearest', behavior: 'auto' })
    })
  }, [pb.nowPlaying?.id, lib.currentView, filteredAlbums])

  // Find the selected album's index — must match the same canonical
  // key format the albums Map uses (and that the SearchPanel hands us).
  const selectedIdx = selected
    ? filteredAlbums.findIndex(a => albumKeyFromStrings(a.artist, a.name) === selected)
    : -1
  // The detail should appear after the last album in the selected album's row
  const detailAfterIdx = selectedIdx >= 0
    ? Math.min(Math.floor(selectedIdx / colsPerRow) * colsPerRow + colsPerRow - 1, filteredAlbums.length - 1)
    : -1
  const selectedAlbum = selectedIdx >= 0 ? filteredAlbums[selectedIdx] : null

  return (
    <div
      className="albums-view"
      ref={viewRootRef}
      onClickCapture={noteUserActivity}
      onWheelCapture={noteUserActivity}
      onScrollCapture={noteUserActivity}
      onKeyDownCapture={noteUserActivity}
    >
      {filteredAlbums.length === 0 && (
        <EmptyState query={lib.searchQuery} noun="albums" />
      )}
      <div className="albums-grid" ref={gridRef}>
        {filteredAlbums.map((album, albumIdx) => {
          const key = albumKeyFromStrings(album.artist, album.name)
          const artHash = findArtHash(album)
          const isSelected = selected === key
          // Show detail after the last album in this row
          const showDetailHere = albumIdx === detailAfterIdx && selectedAlbum
          return (
            <React.Fragment key={key}>
              <div
                className={`album-card ${isSelected ? 'album-card--selected' : ''}`}
                data-album-key={key}
                onClick={() => setSelected(isSelected ? null : key)}
              >
                <div className="album-card-art">
                  {artHash ? (
                    <img src={`album-art://${artHash}.jpg`} alt={album.name} className="album-card-img" />
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
              {showDetailHere && (() => {
                // 4.5: dropped the redundant 48px thumbnail (the album's
                // grid tile right above it is already huge). Replaced
                // with a denser metadata block — Jake asked for date
                // released, genre, runtime, etc. All aggregates derive
                // from the album's tracks since we don't carry album-
                // level metadata yet (label / catalogue # would need a
                // schema add at import time — flagged for later).
                const totalMs = selectedAlbum.tracks.reduce((s, t) => s + (Number(t.duration) || 0), 0)
                const totalH = Math.floor(totalMs / 3_600_000)
                const totalM = Math.floor((totalMs % 3_600_000) / 60_000)
                const runtime = totalH > 0 ? `${totalH}h ${totalM}m` : `${totalM}m`
                // Most-common non-empty genre across the album's tracks.
                const genreCount = new Map<string, number>()
                for (const t of selectedAlbum.tracks) {
                  const g = (t.genre || '').trim()
                  if (g) genreCount.set(g, (genreCount.get(g) || 0) + 1)
                }
                const topGenre = [...genreCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
                // Earliest dateAdded = when the album first hit the library.
                const addedAtMs = selectedAlbum.tracks
                  .map(t => t.dateAdded ? new Date(t.dateAdded).getTime() : Infinity)
                  .reduce((m, v) => Math.min(m, v), Infinity)
                const addedFmt = isFinite(addedAtMs)
                  ? new Date(addedAtMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
                  : ''
                const totalPlays = selectedAlbum.tracks.reduce((s, t) => s + (Number(t.playCount) || 0), 0)

                return (
                  <div className="album-detail album-detail--inline">
                    <div className="album-detail-header">
                      <div className="album-detail-title">{selectedAlbum.name}</div>
                      <div className="album-detail-artist">{selectedAlbum.artist}</div>
                      <div className="album-detail-meta">
                        <span>{selectedAlbum.tracks.length} tracks</span>
                        <span>{runtime}</span>
                        {selectedAlbum.year && <span>Released {selectedAlbum.year}</span>}
                        {topGenre && <span>{topGenre}</span>}
                        {addedFmt && <span>Added {addedFmt}</span>}
                        {totalPlays > 0 && <span>{totalPlays} plays</span>}
                      </div>
                    </div>
                    <div className="album-detail-tracks">
                      {(() => {
                        const discNums = new Set(selectedAlbum.tracks.map(t => Number(t.discNumber) || 1))
                        const isMultiDisc = discNums.size > 1
                        let lastDisc = -1
                        let rowIdx = 0
                        return selectedAlbum.tracks.map((track, i) => {
                          const disc = Number(track.discNumber) || 1
                          const showDiscHeader = isMultiDisc && disc !== lastDisc
                          lastDisc = disc
                          const currentRowIdx = rowIdx++
                          const isPlaying = pb.nowPlaying?.id === track.id
                          const isTrackSelected = selectedTrackIds.has(track.id)
                          return (
                            <React.Fragment key={track.id}>
                              {showDiscHeader && (
                                <div className="album-detail-disc-header">
                                  Disc {disc}
                                </div>
                              )}
                              <div
                                className={`album-detail-row ${isPlaying ? 'album-detail-row--playing' : ''} ${isTrackSelected ? 'album-detail-row--selected' : ''} ${currentRowIdx % 2 ? 'album-detail-row--alt' : ''}`}
                                onClick={(e) => handleTrackClick(track, i, selectedAlbum.tracks, e)}
                                onDoubleClick={() => playTrack(track, selectedAlbum.tracks, i, undefined, true)}
                                onMouseEnter={() => prefetchTrackForPlay(track)}
                                onMouseDown={() => prefetchTrackImmediate(track)}
                                onContextMenu={(e) => {
                                  if (!selectedTrackIds.has(track.id)) {
                                    setSelectedTrackIds(new Set([track.id]))
                                    lastClickedTrackIdx.current = i
                                  }
                                  handleContextMenu(e, track, selectedAlbum.tracks, i)
                                }}
                                draggable
                                onDragStart={(e) => {
                                  const sel = selectedTrackIds.size > 1 && selectedTrackIds.has(track.id)
                                    ? selectedAlbum.tracks.filter(t => selectedTrackIds.has(t.id))
                                    : [track]
                                  e.dataTransfer.setData('application/jaketunes-tracks', JSON.stringify(sel.map(t => t.id)))
                                  e.dataTransfer.effectAllowed = 'copy'
                                }}
                              >
                                <span className="album-detail-icon">{isPlaying ? <SpeakerPlayingIcon /> : <span className="album-detail-num">{track.trackNumber || i + 1}</span>}</span>
                                <span className="album-detail-track-title">{track.title}</span>
                              </div>
                            </React.Fragment>
                          )
                        })
                      })()}
                    </div>
                  </div>
                )
              })()}
            </React.Fragment>
          )
        })}
      </div>
      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={getContextMenuItems()} onClose={() => setCtxMenu(null)} />
      )}
      {getInfoState && (
        <GetInfoModal
          tracks={getInfoState.tracks}
          allTracks={lib.tracks}
          initialIndex={lib.tracks.findIndex(t => t.id === getInfoState.tracks[0]?.id)}
          artworkMap={lib.artworkMap}
          onClose={() => setGetInfoState(null)}
          onSave={handleGetInfoSave}
          onFetchArt={handleFetchArt}
          onSetCustomArt={handleSetCustomArt}
        />
      )}
      {deleteConfirm && (
        <ConfirmDialog
          message={deleteConfirm.count === 1
            ? 'Are you sure you want to delete this song from your library?'
            : `Are you sure you want to delete ${deleteConfirm.count} songs from your library?`}
          detail="This will remove them from all playlists. This cannot be undone."
          confirmLabel="Delete"
          onConfirm={() => { libDispatch({ type: 'DELETE_TRACKS', ids: deleteConfirm.ids }); setDeleteConfirm(null) }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </div>
  )
}
