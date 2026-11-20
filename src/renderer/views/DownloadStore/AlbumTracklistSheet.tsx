/**
 * An album's tracklist, opened in place from a For You card or a Listen List
 * row (Brief 255; Jake: "making it easier to see album tracklists and saving
 * only a few songs from the album if i want"). No trip to Search.
 *
 * The songs are the edition's own (the one the card's Edition menu names).
 * Tick a few and "Save N songs" queues each as an ordinary song save of that
 * edition's row; "Save album" saves the whole record. Songs already in the
 * library say so and can't be ticked.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useLibrary } from '../../context/LibraryContext'
import { enqueue, getQueue, itemFor, subscribeQueue, type QueueOrigin } from './downloadQueue'
import { editionsState, loadEditions, ownedKey, saveSongsLabel, songJobsFor, subscribeEditions, type EditionTrack } from './albumEditions'
import EditionMenu from './EditionMenu'
import './edition-menu.css'

const mmss = (secs: number): string => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`

export default function AlbumTracklistSheet({ artist, album, origin, onSaveAlbum, onMore, onClose }: {
  artist: string
  album: string
  origin?: QueueOrigin
  onSaveAlbum: () => void
  onMore: () => void
  onClose: () => void
}) {
  const eds = useSyncExternalStore(subscribeEditions, () => editionsState(artist, album))
  useSyncExternalStore(subscribeQueue, getQueue)
  const { state: lib } = useLibrary()
  const owned = useMemo(() => {
    const s = new Set<string>()
    for (const t of lib.tracks) if (t.title) s.add(ownedKey(t.title, t.artist || ''))
    return s
  }, [lib.tracks])
  const [tracks, setTracks] = useState<{ loading: boolean; list?: EditionTrack[]; albumName?: string; error?: string }>({ loading: true })
  const [ticked, setTicked] = useState<Set<number>>(() => new Set())

  // Opening the songs is Jake waiting on them: the edition lookup goes to the front of the line.
  useEffect(() => { void loadEditions(artist, album, { front: true }) }, [artist, album])
  // The edition's own tracklist; again when the Edition menu changes it. A lookup that
  // got no answer falls back to the record by name, as the songs always loaded.
  const editionId = eds.state === 'ready' ? eds.chosenId : undefined
  const settled = eds.state === 'ready' || eds.state === 'failed'
  useEffect(() => {
    if (!settled) return
    let live = true
    setTracks({ loading: true }); setTicked(new Set())
    const ref = editionId ?? { artist, album }
    window.electronAPI.itunesAlbumTracks?.(ref)
      .then((r) => { if (live) setTracks(r?.ok && r.tracks?.length ? { loading: false, list: r.tracks, albumName: r.album } : { loading: false, error: 'Couldn’t load the songs.' }) })
      .catch(() => { if (live) setTracks({ loading: false, error: 'Couldn’t load the songs.' }) })
    return () => { live = false }
  }, [artist, album, editionId, settled])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const list = tracks.list ?? []
  const jobs = songJobsFor({ tracks: list, ticked, owned, albumName: tracks.albumName, origin })
  const toggle = (i: number) => setTicked((prev) => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n })
  const saveSongs = () => { for (const j of jobs) enqueue(j); setTicked(new Set()) }

  return (
    <div className="tl-sheet-backdrop" onClick={onClose}>
      <div className="tl-sheet" role="dialog" aria-label={`${album} songs`} onClick={(e) => e.stopPropagation()}>
        <div className="tl-sheet-head">
          <div className="tl-sheet-titles">
            <span className="tl-sheet-title">{album}</span>
            <span className="tl-sheet-artist">{artist}</span>
          </div>
          <button type="button" className="tl-sheet-close" onClick={onClose} title="Close (Esc)">✕</button>
        </div>
        <EditionMenu artist={artist} album={album} onMore={onMore} />
        {tracks.loading && <div className="tl-sheet-note">Loading songs…</div>}
        {tracks.error && <div className="tl-sheet-note tl-sheet-note--err">{tracks.error}</div>}
        {list.length > 0 && (
          <ul className="tl-sheet-list" role="list">
            {list.map((t, i) => {
              const have = owned.has(ownedKey(t.song, t.artist))
              const job = songJobsFor({ tracks: list, ticked: [i], owned: new Set(), albumName: tracks.albumName })[0]
              const item = job ? itemFor(job) : undefined
              const state = item?.status === 'queued' ? 'Queued' : item?.status === 'downloading' ? 'Saving…' : item?.status === 'done' ? 'Saved' : item?.status === 'failed' ? (item.primary || 'Didn’t save') : null
              return (
                <li key={`${i}-${t.song}`} className={`tl-sheet-row${have ? ' is-owned' : ''}`}>
                  <label className="tl-sheet-pick">
                    <input type="checkbox" checked={!have && ticked.has(i)} disabled={have || (!!item && item.status !== 'failed' && item.status !== 'canceled')} onChange={() => toggle(i)} />
                    <span className="tl-sheet-num">{t.trackNumber ?? i + 1}</span>
                    <span className="tl-sheet-song" title={t.song}>{t.song}</span>
                  </label>
                  <span className="tl-sheet-dur">{t.durationSecs ? mmss(t.durationSecs) : ''}</span>
                  <span className="tl-sheet-state">{have ? 'In your library' : state ?? ''}</span>
                </li>
              )
            })}
          </ul>
        )}
        <div className="tl-sheet-foot">
          <button type="button" className="tl-sheet-btn" disabled={jobs.length === 0} onClick={saveSongs}>{jobs.length ? saveSongsLabel(jobs.length) : 'Save songs'}</button>
          <button type="button" className="tl-sheet-btn tl-sheet-btn--primary" onClick={() => { onSaveAlbum(); onClose() }}>Save album</button>
        </div>
      </div>
    </div>
  )
}
