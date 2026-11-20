/**
 * An album's page inside the Record Shop (Brief 256): the tracklist of the
 * edition Jake clicked, the record's other editions, Save album, Save on each
 * song, and ticks for "Save N songs" (Brief 255's few-songs save).
 *
 * Every save goes through DownloadView (`onSave`): the same queue, the album
 * preflight, the credential notice and the search funnel. The songs are the
 * edition's own rows, so each song save pins the recording on this record
 * (albumEditions songJobsFor, the Search tab's song save).
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { editionOptionLabel, type AlbumEdition } from '../../../common/album-preflight'
import { baseAlbumTitle, displayAlbumTitle, listedAlbum, listedSong, markLine, ownedAlbum, ownsSong, releaseKind, type LibraryMarks, type ListMarks } from '../../../common/shop-search'
import { losslessOf, losslessTitle } from '../../../common/shop-lossless'
import { albumJobFor, editionsState, editionsWithCard, loadEditions, saveSongsLabel, songJobsFor, subscribeEditions, type EditionTrack } from './albumEditions'
import { getQueue, itemFor, subscribeQueue, type QItem, type QResult } from './downloadQueue'
import { askLossless, losslessFor, losslessVersion, subscribeLossless } from './shopLossless'
import OfferButtons from './OfferButtons'

const mmss = (secs: number): string => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`

/** What the album page is opened on: a search hit, an artist page card, or a row with no id (by name). */
export interface ShopAlbumRef {
  artist: string
  name: string
  collectionId?: number
  artworkUrl?: string
  releaseYear?: number
  trackCount?: number
  genre?: string
  explicitness?: string
}

/** The album page's dots: one Qobuz search for the artist and the record. */
export const albumLosslessWords = (r: ShopAlbumRef): string => `${r.artist} ${baseAlbumTitle(r.name)}`

export default function ShopAlbumPage({ album, marks, onSave, renderAction, onBack, backLabel }: {
  album: ShopAlbumRef
  marks: { lib: LibraryMarks; list: ListMarks }
  /** DownloadView's save (an album with a job opens Downloads on it). */
  /** `bulk`: one of several saved at once — answered from the not-found memory, never a manual try. */
  onSave: (q: QResult, opts?: { bulk?: boolean }) => void
  /** DownloadView's per-row lifecycle control (Save / Queued / timer + Cancel / Retry). */
  renderAction: (q: QResult, item: QItem | undefined) => ReactNode
  onBack: () => void
  backLabel: string
}) {
  const lookupTitle = displayAlbumTitle(album.name)
  const eds = useSyncExternalStore(subscribeEditions, () => editionsState(album.artist, lookupTitle))
  useSyncExternalStore(subscribeQueue, getQueue)
  useSyncExternalStore(subscribeLossless, losslessVersion)
  const words = albumLosslessWords(album)

  // The edition on screen: the one clicked, until Jake picks another.
  const [editionId, setEditionId] = useState<number | null>(album.collectionId ?? null)
  const [picked, setPicked] = useState(false)
  useEffect(() => { setEditionId(album.collectionId ?? null); setPicked(false) }, [album.artist, album.name, album.collectionId])
  useEffect(() => { void loadEditions(album.artist, lookupTitle, { front: true }) }, [album.artist, lookupTitle])
  useEffect(() => { askLossless(words) }, [words])

  const card: AlbumEdition | null = album.collectionId
    ? { collectionId: album.collectionId, name: album.name, label: 'This edition', trackCount: album.trackCount, releaseYear: album.releaseYear, explicitness: album.explicitness }
    : null
  const editions = useMemo(() => editionsWithCard(eds.editions, card), [eds.editions, card?.collectionId])  // eslint-disable-line react-hooks/exhaustive-deps
  const edition = editions.find((e) => e.collectionId === editionId) ?? null

  const [tracks, setTracks] = useState<{ loading: boolean; list?: EditionTrack[]; albumName?: string; artworkUrl?: string; releaseYear?: number; trackCount?: number; genre?: string; error?: string }>({ loading: true })
  const [ticked, setTicked] = useState<Set<number>>(() => new Set())
  /** Which album and edition the songs on screen are: a by-name page learning its edition keeps its songs and ticks. */
  const loadedRef = useRef<{ key: string; id: number } | null>(null)
  useEffect(() => {
    const key = `${album.artist}\u0000${album.name}`
    if (editionId != null && loadedRef.current?.key === key && loadedRef.current.id === editionId) return
    loadedRef.current = null
    let live = true
    setTracks({ loading: true }); setTicked(new Set())
    const ref = editionId ?? { artist: album.artist, album: album.name }
    window.electronAPI.itunesAlbumTracks?.(ref)
      .then((r) => {
        if (!live) return
        if (r?.ok && r.tracks?.length) {
          setTracks({ loading: false, list: r.tracks, albumName: r.album, artworkUrl: r.artworkUrl, releaseYear: r.releaseYear, trackCount: r.trackCount, genre: r.genre })
          const id = editionId ?? r.collectionId
          if (id != null) loadedRef.current = { key, id }
          // A by-name page now knows its edition (the songs above are its songs: no second load).
          if (editionId == null && r.collectionId) setEditionId(r.collectionId)
        } else setTracks({ loading: false, error: editionId ? 'Couldn’t load the songs.' : 'Couldn’t find this edition. Search it by name to pick one.' })
      })
      .catch(() => { if (live) setTracks({ loading: false, error: 'Couldn’t load the songs.' }) })
    return () => { live = false }
  }, [album.artist, album.name, editionId])  // eslint-disable-line react-hooks/exhaustive-deps

  const list = tracks.list ?? []
  const shownName = edition?.name ?? tracks.albumName ?? album.name
  const count = tracks.trackCount ?? edition?.trackCount ?? album.trackCount
  const year = tracks.releaseYear ?? edition?.releaseYear ?? album.releaseYear
  const kind = releaseKind(shownName, count)
  const idx = losslessFor(words)
  const albumDot = losslessOf(idx, 'album', album.artist, shownName)
  const owned = ownedAlbum(marks.lib, album.artist, shownName, count)
  const mark = markLine({ owned, listed: listedAlbum(marks.list, album.artist, shownName) })

  const albumJob = (): QResult => albumJobFor({
    artist: album.artist,
    album: shownName,
    edition: edition ?? (editionId ? { collectionId: editionId, name: shownName, label: '', trackCount: count, releaseYear: year } : null),
    editionFrom: picked ? 'picked' : 'card',
    surface: 'search',
    clickedAt: Date.now(),
  })
  const albumItem = itemFor(albumJob())
  const songJob = (i: number): QResult | undefined => songJobsFor({ tracks: list, ticked: [i], owned: new Set(), albumName: tracks.albumName ?? shownName })[0]
  // songJobsFor reads `owned` as title|artist name keys, the library marks' own keys.
  const tickedJobs = songJobsFor({ tracks: list, ticked, owned: marks.lib.songs, albumName: tracks.albumName ?? shownName })
  const toggle = (i: number) => setTicked((prev) => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n })

  return (
    <div className="shop-page">
      <button type="button" className="shop-back" onClick={onBack}>‹ {backLabel}</button>
      <div className="shop-page-head">
        {(tracks.artworkUrl ?? album.artworkUrl)
          ? <img className="shop-album-art" src={tracks.artworkUrl ?? album.artworkUrl} alt="" />
          : <span className="shop-album-art shop-album-art--ph" aria-hidden="true">♪</span>}
        <div className="shop-page-titles">
          <span className="shop-page-kind">{kind === 'ALBUM' ? 'Album' : kind === 'EP' ? 'EP' : 'Single'}</span>
          <span className="shop-page-title" title={shownName}>{displayAlbumTitle(shownName)}</span>
          <span className="shop-page-sub">
            <span>{album.artist}</span>
            {year ? <span>{year}</span> : null}
            {count ? <span>{count} song{count === 1 ? '' : 's'}</span> : null}
            {tracks.genre ?? album.genre ? <span>{tracks.genre ?? album.genre}</span> : null}
            {albumDot ? <span className="shop-dot-label"><span className={`shop-dot shop-dot--${albumDot}`} aria-hidden="true" />{albumDot === 'hires' ? 'Hi-res' : 'Lossless'}</span> : null}
            {mark ? <span className={`shop-mark${mark === 'On your list' ? ' shop-mark--list' : ''}`}>{mark}</span> : null}
          </span>
          <span className="shop-page-actions">
            <button type="button" className="download-result-btn" onClick={() => onSave(albumJob())} title={albumItem ? 'Show it in Downloads' : 'Save the album'}>Save album</button>
            {tickedJobs.length > 0 && (
              <button type="button" className="download-result-btn download-result-btn--sm" onClick={() => { for (const j of tickedJobs) onSave(j, { bulk: true }); setTicked(new Set()) }}>{saveSongsLabel(tickedJobs.length)}</button>
            )}
            {editions.length >= 2 && (
              <label className="edition-menu" title="Which edition Save album takes">
                <span className="edition-menu-label">Edition</span>
                <select
                  className="edition-menu-select"
                  value={editionId != null ? String(editionId) : ''}
                  onChange={(e) => { const v = Number(e.target.value); if (v) { setEditionId(v); setPicked(true) } }}
                >
                  {editionId == null && <option value="">Choose…</option>}
                  {editions.map((ed) => <option key={ed.collectionId} value={String(ed.collectionId)}>{editionOptionLabel(ed, editions)}</option>)}
                </select>
              </label>
            )}
          </span>
          {/* Brief 257: Qobuz said no to this edition: what can be had instead, here too (one tap each). */}
          {albumItem?.status === 'failed' && <OfferButtons jobKey={albumItem.key} className="shop-page-offer" />}
        </div>
      </div>
      {tracks.loading && <div className="dl-rel-panel-note"><span className="dl-spinner" aria-hidden="true" /> Loading songs…</div>}
      {tracks.error && <div className="dl-rel-panel-note dl-rel-panel-note--err">{tracks.error}</div>}
      {list.length > 0 && (
        <ul className="shop-tracks" role="list">
          {list.map((t, i) => {
            const job = songJob(i)
            const item = job ? itemFor(job) : undefined
            const have = ownsSong(marks.lib, t.artist, t.song)
            const tickable = !have && (!item || item.status === 'failed' || item.status === 'canceled')
            const dot = losslessOf(idx, 'song', t.artist, t.song)
            const songMark = have ? null : listedSong(marks.list, t.artist, t.song) ? 'On your list' : null
            return (
              <li key={`${i}-${t.song}`} className={`shop-track${have ? ' is-owned' : ''}${item ? ` is-${item.status}` : ''}`}>
                <input type="checkbox" className="dl-track-tick" aria-label={`Pick ${t.song}`} disabled={!tickable} checked={tickable && ticked.has(i)} onChange={() => toggle(i)} />
                <span className="shop-track-num">{t.trackNumber ?? i + 1}</span>
                <span className="shop-track-title" title={t.song}>{t.song}{t.artist !== album.artist ? <span className="shop-track-feat"> · {t.artist}</span> : null}</span>
                <span className="shop-track-dot">{dot ? <span className={`shop-dot shop-dot--${dot}`} title={losslessTitle(dot)} /> : null}</span>
                <span className="shop-track-dur">{t.durationSecs ? mmss(t.durationSecs) : ''}</span>
                <span className="shop-track-act">
                  {have && !item ? <span className="dl-inlib">In library</span> : job ? <>{songMark && !item ? <span className="shop-mark shop-mark--list">{songMark}</span> : null}{renderAction(job, item)}</> : null}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
