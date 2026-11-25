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
import { useCallback, useMemo, useState } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { useAudio } from '../hooks/useAudio'
import ConfirmDialog from '../components/ConfirmDialog'
import MixArtwork from '../components/MixArtwork'
import SongTable, { type SongTableLead, type SongTableRemoval } from '../components/SongTable'
import { useListSort } from '../hooks/useListSort'
import { filterSongs, moveRows, removedFromListNotice, sortSongs } from '../utils/songTableRules'
import { usePlaysElsewhere } from '../playsElsewhere'
import { setNotice } from '../activity'
import type { Track } from '../types'
import {
  answerIpodPlaylist, deleteIpodPlaylist, knownIpod, saveIpodPlaylist, useIpodDefaults, useIpodPlaylists, useOpenIpodPlaylist,
} from '../ipodPlaylists'
import { askToAddToIpodPlaylist } from '../ipodPlaylistAdd'
import { checkPlaylistName, notOnIpodQuestion } from '../../common/ipod-playlists-view'
import '../styles/songs.css'
import '../styles/album-page.css'

const NO_IDS: number[] = []

export default function IpodPlaylistView() {
  const { state: lib, dispatch } = useLibrary()
  const { playTrack } = useAudio()
  const elsewhere = usePlaysElsewhere()
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
  // The one song table (V7): the "This page" search, then a column sort (null = the playlist's own order).
  const [sort, setSort] = useListSort(`ipod-playlist:${open?.device ?? ''}:${open?.id ?? ''}`)
  const shown = useMemo(() => sortSongs(filterSongs(tracks, lib.searchQuery), sort, elsewhere), [tracks, lib.searchQuery, sort, elsewhere])
  const ownPlace = useMemo(() => new Map(tracks.map((t, i) => [t.id, i + 1])), [tracks])

  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const goBack = (): void => {
    if (!device) { dispatch({ type: 'SET_VIEW', view: 'songs' }); return }
    dispatch({ type: 'VIEW_SMART_PLAYLIST', id: (device === 'top1000' ? 'top-1000' : `ipod-list-${device}`) as never })
  }

  const setSongs = useCallback(async (next: number[]): Promise<void> => {
    if (!device || !own) return
    const r = await saveIpodPlaylist({ device, ipodName, id: own.id, trackIds: next, defaults: defaultNames })
    if (!r.ok) setNotice(r.error, { kind: 'error', durationMs: 5000 })
  }, [device, own, ipodName, defaultNames])

  // Delete / "Remove from …": out of this playlist, with Undo. The songs stay on the iPod.
  const removeSongs = useCallback((songs: Track[]): SongTableRemoval | null => {
    if (!own || !editable) return null
    const before = own.trackIds
    const gone = new Set(songs.map((t) => t.id))
    const next = before.filter((id) => !gone.has(id))
    const n = before.length - next.length
    if (n === 0) return null
    void setSongs(next)
    return {
      message: `${removedFromListNotice(n, own.name)}. ${n === 1 ? 'It stays' : 'They stay'} on ${ipodName}.`,
      undo: () => { void setSongs(before) },
    }
  }, [own, editable, setSongs, ipodName])

  // Drag rows to reorder, by the songs shown (a song this library lacks keeps its place at the end).
  const reorder = useCallback((moving: number[], beforeId: number | null) => {
    if (!own || !editable) return
    const shownIds = tracks.map((t) => t.id)
    const to = beforeId === null ? shownIds.length : shownIds.indexOf(beforeId)
    const next = moveRows(shownIds, moving, to < 0 ? shownIds.length : to)
    const rest = own.trackIds.filter((id) => !next.includes(id))
    void setSongs([...next, ...rest])
  }, [own, editable, tracks, setSongs])

  // Songs dragged in from anywhere: asked about the same way as the menu's "Add to iPod Playlist".
  const dropSongs = useCallback((dropped: number[]) => {
    if (!own || !editable || !device || !ipod) return
    void askToAddToIpodPlaylist({ device, ipodName, ipodIds: ipod.ipodIds, playlist: own, trackIds: dropped, library: lib.tracks })
  }, [own, editable, device, ipod, ipodName, lib.tracks])

  // '#': the song's place in the playlist's own order, whatever the sort.
  const lead = useMemo((): SongTableLead => ({
    label: '#',
    width: 44,
    render: (track) => <span className="album-page-tracknum">{ownPlace.get(track.id) ?? ''}</span>,
  }), [ownPlace])

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

  return (
    <div className="album-page ipod-playlist-page">
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

      <SongTable
        listKey={`ipod-playlist:${device ?? ''}:${open.id}`}
        scrollKey={`ipod-playlist:${device ?? ''}:${open.id}`}
        className="album-page-tracklist"
        tracks={shown}
        active={lib.currentView === 'ipod-playlist'}
        sort={sort}
        onSort={setSort}
        lead={lead}
        // A playlist plays in its running order, as the iPod plays it.
        playFrom={(idx) => { if (shown[idx]) playTrack(shown[idx], shown, idx, undefined, true, true) }}
        onRemove={editable ? removeSongs : undefined}
        removeLabel={(n) => (n > 1 ? `Remove ${n} Songs from “${own?.name}”` : `Remove from “${own?.name}”`)}
        deleteFromLibrary={false}
        onReorder={editable ? reorder : undefined}
        onDropSongs={editable ? dropSongs : undefined}
        empty={(
          <div className="album-page-creditline" style={{ padding: '16px 12px' }}>
            {editable ? 'No songs yet. Drag songs here, or right-click any song: Add to iPod Playlist.' : 'No songs.'}
          </div>
        )}
      />

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
