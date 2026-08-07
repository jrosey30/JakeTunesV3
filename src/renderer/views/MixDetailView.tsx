/**
 * 4.5: detail page for a "Your Mixes" mix — opened when you click a mix card on
 * Home (instead of auto-playing), mirroring the iOS MixDetailView (commit #144).
 * Reuses the album-page layout + classes so it reads as the same app. The mix is
 * held in activeMix (ephemeral, fetched from the homemini backend — not a library
 * object). Cover uses MixArtwork (the playlist 2×2 mosaic rule).
 *
 * Selection AND right-click match the rest of the app: mix tracks are real library
 * tracks, so they share selectedTrackIds and the same track context menu.
 */
import { useCallback, useRef, useState } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import { useCynthia } from '../context/CynthiaContext'
import { toCynthiaTrack } from '../utils/cynthia'
import { canonicalArtist } from '../utils/artistAlias'
import { clearArtworkNegativeCache } from '../utils/artworkLookup'
import { ratingMenuEntries } from '../components/StarRating'
import { downloadMenuEntries } from '../utils/downloadStore'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import GetInfoModal from '../components/GetInfoModal'
import MixArtwork from '../components/MixArtwork'
import { SpeakerPlayingIcon } from '../assets/icons/SpeakerIcon'
import { getActiveMix, getMixReturnView } from '../utils/activeMix'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { setNotice } from '../activity'
import type { Track } from '../types'
import '../styles/songs.css'
import '../styles/album-page.css'
import { addToPlaylistEntry } from '../utils/playlistMenu'
import { setTrackDragPayload } from '../utils/trackDrag'

const GRID = '44px minmax(0, 1.8fr) minmax(0, 1.2fr) 70px'
const fmtDur = (ms?: number): string => {
  if (!ms || ms <= 0) return ''
  const totalSecs = Math.floor(ms / 1000)
  return `${Math.floor(totalSecs / 60)}:${(totalSecs % 60).toString().padStart(2, '0')}`
}

export default function MixDetailView() {
  const { state: lib, dispatch } = useLibrary()
  const { state: pb, dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()
  const { openCynthia } = useCynthia()

  const mix = getActiveMix()
  const mixTracklistRef = useRef<HTMLDivElement>(null)
  useScrollPersistence(`mix-detail:${mix?.id ?? 'none'}`, mixTracklistRef)
  const tracks = mix?.tracks ?? []
  const lastClickedIdx = useRef<number>(-1)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: Track; idx: number } | null>(null)
  const [getInfoState, setGetInfoState] = useState<{ tracks: Track[]; index: number } | null>(null)

  // Click-to-select, exactly like SongsView / AlbumDetailView: plain click selects
  // one row (blue highlight), cmd/ctrl-click toggles, shift-click extends a range.
  const handleClick = useCallback((id: number, idx: number, e: React.MouseEvent) => {
    window.getSelection()?.removeAllRanges()
    if (e.shiftKey && lastClickedIdx.current >= 0 && lastClickedIdx.current < tracks.length) {
      const from = Math.min(lastClickedIdx.current, idx)
      const to = Math.max(lastClickedIdx.current, idx)
      dispatch({ type: 'SELECT_RANGE', ids: tracks.slice(from, to + 1).map((t) => t.id) })
    } else {
      dispatch({ type: 'SELECT_TRACK', id, multi: e.metaKey || e.ctrlKey })
      lastClickedIdx.current = idx
    }
  }, [tracks, dispatch])

  const handleDoubleClick = useCallback((idx: number) => {
    window.getSelection()?.removeAllRanges()
    const track = tracks[idx]
    if (track) playTrack(track, tracks, idx, undefined, true)
  }, [tracks, playTrack])

  // Right-click → the same track context menu the rest of the app uses.
  const handleContextMenu = useCallback((e: React.MouseEvent, track: Track, idx: number) => {
    e.preventDefault()
    if (!lib.selectedTrackIds.has(track.id)) dispatch({ type: 'SELECT_TRACK', id: track.id })
    setCtxMenu({ x: e.clientX, y: e.clientY, track, idx })
  }, [lib.selectedTrackIds, dispatch])

  // ⚠️ TWIN: SongsView / AlbumDetailView getContextMenuItems — keep in sync. The
  // mix-scoped subset omits Delete (the mix is an ephemeral set, not a stored list).
  const getContextMenuItems = useCallback((): MenuEntry[] => {
    if (!ctxMenu) return []
    const { track, idx } = ctxMenu
    const selectedTracks = lib.selectedTrackIds.size > 1 ? tracks.filter((t) => lib.selectedTrackIds.has(t.id)) : [track]
    const count = selectedTracks.length
    const label = count > 1 ? `${count} Songs` : track.title
    return [
      { label: `Play "${label}"`, onClick: () => playTrack(track, tracks, idx, undefined, true) },
      { separator: true as const },
      { label: 'Play Next', onClick: () => pbDispatch({ type: 'PLAY_NEXT', tracks: selectedTracks }) },
      { label: 'Add to Up Next', onClick: () => pbDispatch({ type: 'ADD_TO_QUEUE', tracks: selectedTracks }) },
      addToPlaylistEntry(selectedTracks, lib.playlists, (pid, ids) => dispatch({ type: 'ADD_TRACKS_TO_PLAYLIST', playlistId: pid, trackIds: ids })),
      { separator: true as const },
      { label: 'Go to Artist', onClick: () => dispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: canonicalArtist(track.albumArtist || track.artist || '') }) },
      ...(track.album ? [{ label: 'Go to Album', onClick: () => dispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: `${(track.albumArtist || track.artist || '').toLowerCase().trim()}|||${(track.album || '').toLowerCase().trim()}` }) }] : []),
      ...ratingMenuEntries(selectedTracks, dispatch),
      { separator: true as const },
      { label: 'Get Info', onClick: () => setGetInfoState({ tracks: selectedTracks, index: idx }) },
      ...downloadMenuEntries(selectedTracks),
      { separator: true as const },
      { label: 'Cynthia!!', onClick: () => openCynthia({ x: ctxMenu.x, y: ctxMenu.y, scope: { type: 'tracks', label: count > 1 ? `${count} tracks` : track.title, tracks: selectedTracks.map(toCynthiaTrack) } }) },
    ]
  }, [ctxMenu, lib.selectedTrackIds, tracks, playTrack, pbDispatch, dispatch, openCynthia])

  // Get Info save / artwork handlers — mirror AlbumDetailView (which mirrors SongsView).
  const handleGetInfoSave = useCallback(async (updates: { id: number; field: string; value: string }[]) => {
    const fpById = new Map<number, string>()
    const oldArtAlbumById = new Map<number, { artist: string; album: string }>()
    for (const u of updates) {
      if (fpById.has(u.id)) continue
      const t = lib.tracks.find((tr) => tr.id === u.id)
      if (!t) continue
      fpById.set(u.id, `${(t.title || '').toLowerCase().trim()}|${(t.artist || '').toLowerCase().trim()}|${t.duration || 0}`)
      oldArtAlbumById.set(u.id, { artist: t.artist || '', album: t.album || '' })
    }
    for (const u of updates) {
      await window.electronAPI.saveMetadataOverride(u.id, u.field, u.value, fpById.get(u.id))
    }
    if (updates.some((u) => u.field === 'artist' || u.field === 'album')) {
      const newById = new Map(oldArtAlbumById)
      for (const u of updates) {
        const cur = newById.get(u.id)
        if (!cur) continue
        if (u.field === 'artist') cur.artist = u.value
        else if (u.field === 'album') cur.album = u.value
      }
      for (const v of newById.values()) clearArtworkNegativeCache(v.artist, v.album)
    }
    dispatch({ type: 'UPDATE_TRACKS', updates })
  }, [dispatch, lib.tracks])

  const handleFetchArt = useCallback(async (artist: string, album: string, force?: boolean) => {
    const result = await window.electronAPI.fetchAlbumArt(artist, album, force)
    if (result.ok && result.key && result.hash) {
      dispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
      return { key: result.key, hash: result.hash }
    }
    return null
  }, [dispatch])

  const handleSetCustomArt = useCallback(async (artist: string, album: string, imagePath: string) => {
    const result = await window.electronAPI.setCustomArtwork(artist, album, imagePath)
    if (result.ok && result.key && result.hash) {
      dispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
      return { key: result.key, hash: result.hash }
    }
    setNotice(result.error ? `Couldn't save artwork: ${result.error}` : "Couldn't save artwork.", { kind: 'error' })
    return null
  }, [dispatch])

  const goBack = (): void => { dispatch({ type: 'SET_VIEW', view: getMixReturnView() }) }

  if (!mix) {
    return (
      <div className="album-page">
        <div className="album-page-topbar">
          <button type="button" className="album-page-back" onClick={goBack}>‹ Back</button>
        </div>
      </div>
    )
  }

  const playAll = (): void => { if (tracks.length) playTrack(tracks[0], tracks, 0, undefined, true) }
  const shuffle = (): void => { const s = tracks.slice().sort(() => Math.random() - 0.5); if (s.length) playTrack(s[0], s, 0, undefined, true) }

  return (
    <div className="album-page">
      <div className="album-page-topbar">
        <button type="button" className="album-page-back" onClick={goBack}>‹ Back</button>
      </div>
      <div className="album-page-hero">
        <div className="album-page-cover">
          <MixArtwork tracks={tracks} alt={mix.title} priority />
        </div>
        <div className="album-page-meta">
          <div className="album-page-artist">Your Mix</div>
          <h1 className="album-page-title">{mix.title}</h1>
          <div className="album-page-facts">{tracks.length} song{tracks.length === 1 ? '' : 's'}</div>
          <div className="album-page-actions">
            <button type="button" className="album-page-play" onClick={playAll}>▶ Play</button>
            <button type="button" className="album-page-shuffle" onClick={shuffle}>⤮ Shuffle</button>
          </div>
          {mix.subtitle && <div className="album-page-creditline">{mix.subtitle}</div>}
        </div>
      </div>

      <div className="album-page-tracklist songs-view" ref={mixTracklistRef}>
        <div className="songs-header" style={{ gridTemplateColumns: GRID }}>
          <div className="songs-header-cell" style={{ textAlign: 'center', justifyContent: 'center' }}>#</div>
          <div className="songs-header-cell">Name</div>
          <div className="songs-header-cell">Artist</div>
          <div className="songs-header-cell">Time</div>
        </div>
        <div className="album-page-track-body">
          {tracks.map((track, idx) => {
            const isPlaying = pb.nowPlaying?.id === track.id
            const isSelected = lib.selectedTrackIds.has(track.id)
            return (
              <div
                key={`${track.id}-${idx}`}
                className={`songs-row ${idx % 2 ? 'songs-row--alt' : ''} ${isPlaying ? 'songs-row--playing' : ''} ${isSelected ? 'songs-row--selected' : ''}`}
                style={{ gridTemplateColumns: GRID }}
                onClick={(e) => handleClick(track.id, idx, e)}
                onDoubleClick={() => handleDoubleClick(idx)}
                onContextMenu={(e) => handleContextMenu(e, track, idx)}
                title={`${track.title} — ${track.artist}`}
                draggable
                onDragStart={(e) => setTrackDragPayload(e, track.id, lib.selectedTrackIds)}
              >
                <div className="songs-cell songs-cell--icon">{isPlaying ? <SpeakerPlayingIcon /> : <span className="album-page-tracknum">{idx + 1}</span>}</div>
                <div className="songs-cell songs-cell--title"><span className="title-row-text">{track.title || ''}</span></div>
                <div className="songs-cell">{track.artist || ''}</div>
                <div className="songs-cell songs-cell--time">{fmtDur(track.duration)}</div>
              </div>
            )
          })}
        </div>
      </div>

      {ctxMenu && <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={getContextMenuItems()} onClose={() => setCtxMenu(null)} />}
      {getInfoState && (
        <GetInfoModal
          tracks={getInfoState.tracks}
          allTracks={tracks}
          initialIndex={getInfoState.index}
          artworkMap={lib.artworkMap}
          onClose={() => setGetInfoState(null)}
          onSave={handleGetInfoSave}
          onFetchArt={handleFetchArt}
          onSetCustomArt={handleSetCustomArt}
        />
      )}
    </div>
  )
}
