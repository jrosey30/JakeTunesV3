/**
 * One playlist on one iPod (2026-11-14), opened from under the iPod in the
 * sidebar. A normal playlist page: the album page's layout and the song table
 * every list uses (MixDetailView's shape), so it reads as the same app.
 *
 * Three kinds, said in one quiet line under the title:
 *   - a default ("worked out from punkPod's songs at each sync"): read-only;
 *   - an On-The-Go list ("made on punkPod, brought home at a sync"): read-only;
 *   - Jake's own: Rename…, Delete…, drag songs in (or "Add to <iPod> Playlist"
 *     on any song), drag rows to reorder, Delete / right-click to take one out.
 * What hasn't reached homemini yet says so ("Waiting for homemini"); a playlist
 * homemini held asks its question at the top, in words.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import ConfirmDialog from '../components/ConfirmDialog'
import MixArtwork from '../components/MixArtwork'
import { SpeakerPlayingIcon } from '../assets/icons/SpeakerIcon'
import { canonicalArtist } from '../utils/artistAlias'
import { ratingMenuEntries } from '../components/StarRating'
import { addToPlaylistEntry, queueMenuEntries } from '../utils/playlistMenu'
import { setTrackDragPayload } from '../utils/trackDrag'
import { setNotice } from '../activity'
import type { Track } from '../types'
import {
  answerIpodPlaylist, deleteIpodPlaylist, knownIpod, saveIpodPlaylist, useIpodDefaults, useIpodPlaylists, useOpenIpodPlaylist,
} from '../ipodPlaylists'
import { addToIpodPlaylistEntries, askToAddToIpodPlaylist } from '../ipodPlaylistAdd'
import { checkPlaylistName, notOnIpodQuestion } from '../../common/ipod-playlists-view'
import '../styles/songs.css'
import '../styles/album-page.css'

const GRID = '44px minmax(0, 1.6fr) minmax(0, 1.1fr) minmax(0, 1.1fr) 60px'
const REORDER_TYPE = 'application/jaketunes-ipod-playlist-row'
const NO_IDS: number[] = []
const fmtDur = (ms?: number): string => {
  if (!ms || ms <= 0) return ''
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
}

export default function IpodPlaylistView() {
  const { state: lib, dispatch } = useLibrary()
  const { state: pb, dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()
  const open = useOpenIpodPlaylist()
  const ipod = open ? knownIpod(open.device) : null
  const device = open?.device ?? null
  const ipodName = ipod?.ipodName ?? 'this iPod'
  const stored = useIpodPlaylists(device, ipodName)
  const defaults = useIpodDefaults(device, lib.tracks, ipod?.ipodIds ?? NO_IDS, ipod?.setName ?? '', !!ipod)
  const defaultNames = useMemo(() => defaults.map((d) => d.name), [defaults])

  const def = open ? defaults.find((d) => d.id === open.id) ?? null : null
  const own = open ? stored.rows.find((p) => p.id === open.id) ?? null : null
  const editable = own?.source === 'jake'
  const byId = useMemo(() => new Map(lib.tracks.map((t) => [t.id, t])), [lib.tracks])
  const ids = def?.trackIds ?? own?.trackIds ?? NO_IDS
  const tracks = useMemo(() => ids.map((id) => byId.get(id)).filter((t): t is Track => !!t), [ids, byId])

  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: Track; idx: number } | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const lastClickedIdx = useRef(-1)

  const goBack = (): void => {
    if (!device) { dispatch({ type: 'SET_VIEW', view: 'songs' }); return }
    dispatch({ type: 'VIEW_SMART_PLAYLIST', id: (device === 'top1000' ? 'top-1000' : `ipod-list-${device}`) as never })
  }

  const setSongs = useCallback(async (next: number[]): Promise<void> => {
    if (!device || !own) return
    const r = await saveIpodPlaylist({ device, ipodName, id: own.id, trackIds: next, defaults: defaultNames })
    if (!r.ok) setNotice(r.error, { kind: 'error', durationMs: 5000 })
  }, [device, own, ipodName, defaultNames])

  const removeSelected = useCallback((only?: number) => {
    if (!own || !editable) return
    const gone = only !== undefined && !lib.selectedTrackIds.has(only) ? new Set([only]) : new Set(lib.selectedTrackIds)
    const next = own.trackIds.filter((id) => !gone.has(id))
    if (next.length === own.trackIds.length) return
    void setSongs(next)
    setNotice(`Took ${own.trackIds.length - next.length === 1 ? 'a song' : `${own.trackIds.length - next.length} songs`} out of “${own.name}”. ${own.trackIds.length - next.length === 1 ? 'It stays' : 'They stay'} on ${ipodName}.`)
  }, [own, editable, lib.selectedTrackIds, setSongs, ipodName])

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

  const menuItems = useCallback((): MenuEntry[] => {
    if (!ctxMenu) return []
    const { track, idx } = ctxMenu
    const selected = lib.selectedTrackIds.size > 1 ? tracks.filter((t) => lib.selectedTrackIds.has(t.id)) : [track]
    return [
      { label: `Play “${selected.length > 1 ? `${selected.length} Songs` : track.title}”`, onClick: () => playTrack(track, tracks, idx, undefined, true, true) },
      { separator: true as const },
      ...queueMenuEntries(selected, pbDispatch),
      addToPlaylistEntry(selected, lib.playlists, (pid, ids2) => dispatch({ type: 'ADD_TRACKS_TO_PLAYLIST', playlistId: pid, trackIds: ids2 })),
      ...addToIpodPlaylistEntries(selected, lib.tracks),
      ...(editable ? [{ label: selected.length > 1 ? `Remove ${selected.length} Songs from “${own?.name}”` : `Remove from “${own?.name}”`, onClick: () => removeSelected(track.id) }] : []),
      { separator: true as const },
      { label: 'Go to Artist', onClick: () => dispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: canonicalArtist(track.albumArtist || track.artist || '') }) },
      ...(track.album ? [{ label: 'Go to Album', onClick: () => dispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: `${(track.albumArtist || track.artist || '').toLowerCase().trim()}|||${(track.album || '').toLowerCase().trim()}` }) }] : []),
      ...ratingMenuEntries(selected, dispatch),
    ]
  }, [ctxMenu, lib.selectedTrackIds, lib.playlists, lib.tracks, tracks, playTrack, pbDispatch, dispatch, editable, own, removeSelected])

  if (!open || !ipod || (!def && !own)) {
    return (
      <div className="album-page">
        <div className="album-page-topbar">
          <button type="button" className="album-page-back" onClick={goBack}>‹ Back</button>
        </div>
        <div className="album-page-creditline" style={{ padding: '24px 32px' }}>
          {stored.loaded || defaults.length ? 'This playlist isn’t on this iPod any more.' : 'Loading…'}
        </div>
      </div>
    )
  }

  const name = def?.name ?? own?.name ?? ''
  const kindLine = def
    ? (def.kind === 'set' ? `${ipodName}’s own list` : `A default playlist, worked out from ${ipodName}’s songs at each sync`)
    : own?.source === 'on-the-go' ? `Made on ${ipodName} with the click wheel, brought home at a sync`
      : own?.source === 'jake' ? `Your playlist on ${ipodName}. It reaches the iPod at its next sync.`
        : `Approved for ${ipodName}`
  const minutes = Math.round(tracks.reduce((s, t) => s + (t.duration || 0), 0) / 60_000)
  const hold = own?.hold ?? null
  const holdTitles = hold?.kind === 'not-on-ipod' ? hold.trackIds.map((id) => byId.get(id)?.title || 'a song') : []

  const commitRename = async (): Promise<void> => {
    if (renaming === null || !own || !device) return
    const check = checkPlaylistName(renaming, ipodName, { defaults: defaultNames, others: stored.rows.filter((p) => p.id !== own.id).map((p) => p.name) })
    if (!check.ok) { setRenameError(check.error); return }
    setRenaming(null)
    setRenameError(null)
    const r = hold?.kind === 'name-taken'
      ? await answerIpodPlaylist({ device, ipodName, id: own.id, choice: 'rename', name: check.name, defaults: defaultNames })
      : await saveIpodPlaylist({ device, ipodName, id: own.id, name: check.name, defaults: defaultNames })
    if (!r.ok) setNotice(r.error, { kind: 'error', durationMs: 5000 })
  }

  const onRowDragStart = (e: React.DragEvent, track: Track, idx: number): void => {
    setTrackDragPayload(e, track.id, lib.selectedTrackIds)
    if (editable) e.dataTransfer.setData(REORDER_TYPE, String(idx))
  }
  const onRowDrop = (e: React.DragEvent, idx: number): void => {
    setDragOver(null)
    if (!editable || !own) return
    const from = e.dataTransfer.getData(REORDER_TYPE)
    if (from !== '') {
      e.preventDefault()
      const f = Number(from)
      if (!Number.isInteger(f) || f === idx) return
      // Reorder by the songs shown (a song this library lacks keeps its place at the end).
      const shownIds = tracks.map((t) => t.id)
      const [moved] = shownIds.splice(f, 1)
      shownIds.splice(idx > f ? idx - 1 : idx, 0, moved)
      const rest = own.trackIds.filter((id) => !shownIds.includes(id))
      void setSongs([...shownIds, ...rest])
      return
    }
    const raw = e.dataTransfer.getData('application/jaketunes-tracks')
    if (!raw || !device) return
    e.preventDefault()
    try {
      const dropped = (JSON.parse(raw) as unknown[]).map(Number).filter((n) => Number.isInteger(n))
      void askToAddToIpodPlaylist({ device, ipodName, ipodIds: ipod.ipodIds, playlist: own, trackIds: dropped, library: lib.tracks })
    } catch {
      // Not a list of songs: nothing to add.
    }
  }

  return (
    <div
      className="album-page ipod-playlist-page"
      tabIndex={-1}
      onKeyDown={(e) => { if ((e.key === 'Delete' || e.key === 'Backspace') && editable && lib.selectedTrackIds.size) { e.preventDefault(); removeSelected() } }}
    >
      <div className="album-page-topbar">
        <button type="button" className="album-page-back" onClick={goBack}>‹ {ipodName}</button>
      </div>
      <div className="album-page-hero">
        <div className="album-page-cover">
          <MixArtwork tracks={tracks} alt={name} priority />
        </div>
        <div className="album-page-meta">
          <div className="album-page-artist">{ipodName}</div>
          {renaming !== null ? (
            <input
              className="album-page-title ipod-playlist-rename"
              aria-label="Playlist name"
              autoFocus
              value={renaming}
              maxLength={80}
              onChange={(e) => { setRenaming(e.target.value); setRenameError(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(); if (e.key === 'Escape') { setRenaming(null); setRenameError(null) } }}
              onBlur={() => { if (renaming.trim() === name) setRenaming(null) }}
            />
          ) : (
            <h1 className="album-page-title">{name}</h1>
          )}
          {renameError && <div className="album-page-creditline ipod-playlist-error" role="alert">{renameError}</div>}
          <div className="album-page-facts">{tracks.length.toLocaleString()} song{tracks.length === 1 ? '' : 's'}{minutes ? `, ${minutes.toLocaleString()} min` : ''}</div>
          <div className="album-page-creditline">{kindLine}</div>
          {own?.waiting && !hold && <div className="album-page-creditline ipod-playlist-waiting">Waiting for homemini. Saved on this Mac; it goes when homemini answers.</div>}
          <div className="album-page-actions">
            <button type="button" className="album-page-play" disabled={!tracks.length} onClick={() => tracks.length && playTrack(tracks[0], tracks, 0, undefined, true, true)}>▶ Play</button>
            {editable && renaming === null && <button type="button" className="album-page-shuffle" onClick={() => { setRenaming(name); setRenameError(null) }}>Rename…</button>}
            {editable && <button type="button" className="album-page-shuffle" onClick={() => setConfirmDelete(true)}>Delete…</button>}
          </div>
          {(own?.notices ?? []).map((n) => <div key={n} className="album-page-creditline ipod-playlist-notice">{n}</div>)}
        </div>
      </div>

      {hold && device && own && (
        <div className="ipod-playlist-question" role="alert">
          {hold.kind === 'not-on-ipod' ? (
            <>
              <span className="ipod-playlist-question-text">
                {(() => {
                  const q = notOnIpodQuestion(device, ipodName, holdTitles)
                  return q.canAdd ? `homemini says: ${q.message}` : q.message
                })()}
              </span>
              {device !== 'top1000' && (
                <button type="button" className="album-page-play" onClick={() => { void answerIpodPlaylist({ device, ipodName, id: own.id, choice: 'add' }) }}>Add to {ipodName}</button>
              )}
              <button type="button" className="album-page-shuffle" onClick={() => { void answerIpodPlaylist({ device, ipodName, id: own.id, choice: 'drop' }) }}>{holdTitles.length === 1 ? 'Take it out' : 'Take them out'}</button>
            </>
          ) : (
            <>
              <span className="ipod-playlist-question-text">{ipodName} already has a playlist called “{hold.name}”. Rename this one.</span>
              <button type="button" className="album-page-play" onClick={() => { setRenaming(name); setRenameError(null) }}>Rename…</button>
            </>
          )}
        </div>
      )}

      <div
        className="album-page-tracklist songs-view"
        onDragOver={(e) => { if (editable && (e.dataTransfer.types.includes('application/jaketunes-tracks') || e.dataTransfer.types.includes(REORDER_TYPE))) e.preventDefault() }}
        onDrop={(e) => onRowDrop(e, tracks.length)}
      >
        <div className="songs-header" style={{ gridTemplateColumns: GRID }}>
          <div className="songs-header-cell" style={{ textAlign: 'center', justifyContent: 'center' }}>#</div>
          <div className="songs-header-cell">Name</div>
          <div className="songs-header-cell">Artist</div>
          <div className="songs-header-cell">Album</div>
          <div className="songs-header-cell">Time</div>
        </div>
        <div className="album-page-track-body">
          {tracks.length === 0 && (
            <div className="album-page-creditline" style={{ padding: '16px 12px' }}>
              {editable ? `No songs yet. Drag songs here, or right-click any song: Add to ${ipodName} Playlist.` : 'No songs.'}
            </div>
          )}
          {tracks.map((track, idx) => {
            const isPlaying = pb.nowPlaying?.id === track.id
            const isSelected = lib.selectedTrackIds.has(track.id)
            return (
              <div
                key={`${track.id}-${idx}`}
                className={`songs-row ${idx % 2 ? 'songs-row--alt' : ''} ${isPlaying ? 'songs-row--playing' : ''} ${isSelected ? 'songs-row--selected' : ''} ${dragOver === idx ? 'ipod-playlist-row--dropline' : ''}`}
                style={{ gridTemplateColumns: GRID }}
                onClick={(e) => handleClick(track.id, idx, e)}
                onDoubleClick={() => { window.getSelection()?.removeAllRanges(); playTrack(track, tracks, idx, undefined, true, true) }}
                onContextMenu={(e) => { e.preventDefault(); if (!lib.selectedTrackIds.has(track.id)) dispatch({ type: 'SELECT_TRACK', id: track.id }); setCtxMenu({ x: e.clientX, y: e.clientY, track, idx }) }}
                draggable
                onDragStart={(e) => onRowDragStart(e, track, idx)}
                onDragOver={(e) => { if (editable) { e.preventDefault(); setDragOver(idx) } }}
                onDragLeave={() => setDragOver(null)}
                onDrop={(e) => { e.stopPropagation(); onRowDrop(e, idx) }}
                title={`${track.title} — ${track.artist}`}
              >
                <div className="songs-cell songs-cell--icon">{isPlaying ? <SpeakerPlayingIcon /> : <span className="album-page-tracknum">{idx + 1}</span>}</div>
                <div className="songs-cell songs-cell--title"><span className="title-row-text">{track.title || ''}</span></div>
                <div className="songs-cell">{track.artist || ''}</div>
                <div className="songs-cell">{track.album || ''}</div>
                <div className="songs-cell songs-cell--time">{fmtDur(track.duration)}</div>
              </div>
            )
          })}
        </div>
      </div>

      {ctxMenu && <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={menuItems()} onClose={() => setCtxMenu(null)} />}
      {confirmDelete && own && device && (
        <ConfirmDialog
          message={`Delete “${own.name}” from ${ipodName}?`}
          detail={`The songs stay on ${ipodName} and in your library. The playlist leaves ${ipodName} at its next sync.`}
          confirmLabel="Delete"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false)
            void deleteIpodPlaylist({ device, ipodName, id: own.id }).then((r) => {
              if (!r.ok) { setNotice(r.error, { kind: 'error', durationMs: 5000 }); return }
              goBack()
            })
          }}
        />
      )}
    </div>
  )
}
