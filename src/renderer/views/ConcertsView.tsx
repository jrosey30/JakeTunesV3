/**
 * ConcertsView — the Live Concerts index, rebuilt 2026-09-02 to follow the
 * concert page's makeover: one ROW per show (poster at its own aspect + a
 * short blurb), bands A→Z, ties in chronological order (Jake). The blurb is
 * `concert.blurb` when set, else the first grounded fact — never invented.
 * White / silver / charcoal / one orange; the brown poster wall is retired.
 */
import { useMemo, useRef, useSyncExternalStore, useCallback } from 'react'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { useLibrary } from '../context/LibraryContext'
import { subscribeLiveSets, getLiveSetsSnapshot } from '../liveSets'
import { buildNormalizedArtworkIndex, lookupArtwork } from '../utils/artworkLookup'
import AlbumArtImage from '../components/AlbumArtImage'
import { setConcertKey } from '../concertNav'
import type { LiveSetEntry } from '../types'
import { declaredConcerts } from '../../common/concert-meta'
import '../styles/albums.css'
import '../styles/concerts.css'
import '../styles/concert-stage.css'

function hms(ms: number): string {
  const s = Math.floor((ms || 0) / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
}

interface ConcertRow {
  albumKey: string
  entry: LiveSetEntry
  band: string
  show: string
  venue?: string
  city?: string
  date?: string
  artHash?: string
  blurb?: string
  when: number   // sortable date (ms); NaN-safe
}

/** Sort key for the band: drop a leading "The " so The Postal Service files under P. */
function bandKey(band: string): string {
  return band.toLowerCase().replace(/^the\s+/, '').trim()
}

export default function ConcertsView() {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const snap = useSyncExternalStore(subscribeLiveSets, getLiveSetsSnapshot)
  const normalizedArtIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])

  const concerts = useMemo((): ConcertRow[] => {
    // Band / show / venue / date come from the shared reading the artist
    // page's Live wall uses too (common/concert-meta.ts).
    const byId = new Map(lib.tracks.map((t) => [t.id, t] as const))
    const out: ConcertRow[] = declaredConcerts(snap.sets, (id) => byId.get(id)).map((c) => ({
      albumKey: c.albumKey, entry: c.entry, band: c.band, show: c.show, venue: c.venue, city: c.city, date: c.date,
      artHash: c.poster || lookupArtwork(lib.artworkMap, normalizedArtIndex, c.band, c.show), blurb: c.blurb, when: c.when,
    }))
    return out.sort((a, b) => bandKey(a.band).localeCompare(bandKey(b.band)) || (a.when - b.when) || a.show.localeCompare(b.show))
  }, [snap, lib.tracks, lib.artworkMap, normalizedArtIndex])

  const openConcert = useCallback((albumKey: string) => {
    setConcertKey(albumKey)
    libDispatch({ type: 'SET_VIEW', view: 'concert-detail' })
  }, [libDispatch])

  const concertsPageRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('concerts-page', concertsPageRef)
  return (
    <div className="concerts-view albums-view" ref={concertsPageRef}>
      <div className="concerts-header">
        <h2 className="concerts-title">Full Live Concerts</h2>
        <span className="concerts-count">
          {concerts.length} concert{concerts.length !== 1 ? 's' : ''}
        </span>
      </div>

      {concerts.length === 0 ? (
        <div className="concerts-empty">
          No live concerts yet. Open an album of a full show and choose
          <span className="concerts-empty-em"> Declare Live Concert Mode</span> to add it here.
        </div>
      ) : (
        <div className="concerts-rows">
          {concerts.map((c) => (
            <div
              key={c.albumKey}
              className="concert-row"
              data-album-key={c.albumKey}
              onClick={() => openConcert(c.albumKey)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openConcert(c.albumKey) } }}
              role="button"
              tabIndex={0}
              title={`${c.show} — ${c.band}`}
            >
              <div className="concert-row-art">
                {c.artHash
                  ? <AlbumArtImage hash={c.artHash} alt={c.show} className="concert-row-img" size={320} />
                  : <div className="concert-row-noart" aria-hidden="true" />}
              </div>
              <div className="concert-row-body">
                <div className="concert-row-band">{c.band || c.show}</div>
                <div className="concert-row-show">{c.show}</div>
                <div className="concert-row-where">
                  {c.venue && <b>{c.venue}</b>}{c.venue && c.city ? ', ' : ''}{c.city}{(c.venue || c.city) && c.date ? ' · ' : ''}{c.date}
                </div>
                {c.blurb && <p className="concert-row-blurb">{c.blurb}</p>}
                <div className="concert-row-stat">{c.entry.cues.length} songs · {hms(c.entry.totalDurationMs)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
