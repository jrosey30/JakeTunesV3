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
import { setTapeSession, refreshMixtapes, pickInk } from '../mixtapes'
import { MAX_TAPE_SONGS } from '../../common/tape-physics'
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
import type { Mixtape, Track } from '../types'
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
  const [exporting, setExporting] = useState(false)
  const [exportNote, setExportNote] = useState('')
  const [keeping, setKeeping] = useState(false)
  const [keptNote, setKeptNote] = useState('')
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

  // Double-clicking a row starts THE MIX, from the top — you can't drop into
  // the middle of a tape ("you cant start from anywhere either. has to be
  // from the beginning").
  const handleDoubleClick = useCallback((_idx: number) => {
    window.getSelection()?.removeAllRanges()
    if (!tracks.length) return
    setTapeSession({ mixtapeId: `mix:${mix?.id ?? 'unknown'}`, tapeTrackIds: tracks.map((t) => t.id), cuts: [] })
    playTrack(tracks[0], tracks, 0, undefined, true, /* preserveOrder — a mix's arc IS the product */ true)
  }, [tracks, playTrack, mix])

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
      { label: 'Play the mix from the top', onClick: () => {
        setTapeSession({ mixtapeId: `mix:${mix?.id ?? 'unknown'}`, tapeTrackIds: tracks.map((t) => t.id), cuts: [] })
        playTrack(tracks[0], tracks, 0, undefined, true, /* preserveOrder — a mix's arc IS the product */ true)
      } },
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
  }, [ctxMenu, lib.selectedTrackIds, tracks, playTrack, pbDispatch, dispatch, openCynthia, mix])

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

  /**
   * A daily mix IS a mixtape (Jake, 2026-08-08: "turn daily mixes into
   * mixtapes replace the current process", then: "the daily mixes still
   * arent mixtapes, i can pick any song out of its 25 songs").
   *
   * So playing one opens a TAPE SESSION, exactly like pressing PLAY on a
   * tape: the pill switches to the whole-mix clock, prev/next/shuffle go
   * dead, and it runs start to finish. The session id is namespaced 'mix:'
   * — these have no Mixtape record on the shelf, and TapeMonitor simply
   * finds no tape for it, which is right: there are no cuts, no talkovers
   * and no intro to fire, just the running order and the rules.
   */
  /**
   * Export the mix as one continuous file — the same thing the tape page
   * does. Jake, 2026-08-08: "no way i can export the daily mixes? why not?"
   * No reason at all; I built it on MixtapeView and never carried it across,
   * even after making mixes BE tapes. A daily mix has no intro, talkovers or
   * start offsets, so it's one plain side.
   */
  const exportMix = async (): Promise<void> => {
    if (!tracks.length || exporting) return
    setExporting(true)
    setExportNote('Exporting… rendering the mix.')
    try {
      const mount = await window.electronAPI?.getMusicLibraryPath?.() ?? ''
      const r = await window.electronAPI.dubMixtape?.({
        title: mix?.title || 'Mix',
        sides: [{
          label: 'A',
          songs: tracks.map((t) => ({ absPath: mount + String(t.path || '').replace(/:/g, '/') })),
          talkovers: [],
        }],
      })
      setExportNote(r?.ok
        ? `Exported to Desktop → JakeTunes Dubs → ${mix?.title || 'Mix'}.`
        : (r?.error || 'Export failed.'))
    } catch (err) {
      setExportNote(err instanceof Error ? err.message : 'Export failed.')
    } finally {
      setExporting(false)
      setTimeout(() => setExportNote(''), 12_000)
    }
  }

  /**
   * Keep this mix as a real tape. Jake, 2026-08-08: "no way to save a daily
   * mix to the mixtape area. if i dont save it i will likely lose it
   * forever" — correct, and a real loss: the daily row regenerates, so a mix
   * he liked is gone tomorrow with nothing he could have done about it.
   *
   * Saving COPIES the running order onto the shelf as its own tape with its
   * own id. The mix on the row is untouched and still rotates out; the tape
   * is his and stays. Capped at the tape limit like any other.
   */
  const keepAsTape = async (): Promise<void> => {
    if (!tracks.length || keeping) return
    setKeeping(true)
    try {
      const id = `mix-${Date.now().toString(36)}`
      const r = await window.electronAPI.saveMixtape?.({
        id,
        title: mix?.title || 'Mix',
        commentary: mix?.subtitle || '',
        tracks: tracks.slice(0, MAX_TAPE_SONGS).map((t) => t.id),
        // Legacy fields the record still carries for older tapes.
        tapeLength: 90,
        sideA: [],
        sideB: [],
        linerNotes: [],
        createdAt: new Date().toISOString(),
        inkColor: pickInk(id),
      } as Mixtape)
      if (!r?.ok) { setKeptNote(r?.error || 'Could not save the tape.'); return }
      await refreshMixtapes()
      setKeptNote('Saved to Mixtapes — it\'s yours now, this row still rotates.')
    } catch (err) {
      setKeptNote(err instanceof Error ? err.message : 'Could not save the tape.')
    } finally {
      setKeeping(false)
      setTimeout(() => setKeptNote(''), 12_000)
    }
  }

  const playMix = (): void => {
    if (!tracks.length) return
    setTapeSession({ mixtapeId: `mix:${mix.id}`, tapeTrackIds: tracks.map((t) => t.id), cuts: [] })
    playTrack(tracks[0], tracks, 0, undefined, true, /* preserveOrder — a mix's arc IS the product */ true)
  }

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
            <button type="button" className="album-page-play" onClick={playMix}>▶ Play</button>
            <button type="button" className="album-page-shuffle" disabled={keeping}
              onClick={() => { void keepAsTape() }}>
              {keeping ? 'Saving…' : 'Save to Mixtapes'}
            </button>
            <button type="button" className="album-page-shuffle" disabled={exporting}
              onClick={() => { void exportMix() }}>
              {exporting ? 'Exporting…' : 'Export as one file'}
            </button>
            {/* No shuffle on a mix — it plays in its running order. */}
          </div>
          {keptNote && <div className="album-page-creditline">{keptNote}</div>}
          {exportNote && <div className="album-page-creditline">{exportNote}</div>}
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
