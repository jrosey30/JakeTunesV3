import { useMemo, useSyncExternalStore, useCallback } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { subscribeLiveSets, getLiveSetsSnapshot } from '../liveSets'
import { buildNormalizedArtworkIndex, lookupArtwork } from '../utils/artworkLookup'
import AlbumArtImage from '../components/AlbumArtImage'
import type { LiveSetEntry } from '../types'
import '../styles/albums.css'
import '../styles/concerts.css'

// Full Live Concerts — a browse section for declared live concerts only.
// A "concert" = a live-sets sidecar entry (albumKey → LiveSetEntry). Its
// merged "Full Set" track + constituents are hidden from the regular library
// (useRegularLibraryTracks); this is where the whole show lives. Clicking a
// concert opens its detail page (the existing AlbumDetailView, which already
// has the continuous-scrubber Play Live Set + setlist), reached by the source
// album key.

function hms(ms: number): string {
  const s = Math.floor((ms || 0) / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
}

interface ConcertCard {
  albumKey: string
  entry: LiveSetEntry
  band: string
  show: string
  venue?: string
  date?: string
  artHash?: string
}

// Extract venue + date for the poster from grounded sources ONLY — a persisted
// concert.* override first, else the "(Live at VENUE, DATE)" tag pattern the
// tracks already carry, else a date pulled from the show name. Never invents.
function parseConcertMeta(
  showName: string,
  sampleTitle: string,
  override?: { venue?: string; city?: string; date?: string },
): { venue?: string; date?: string } {
  if (override && (override.venue || override.date)) return { venue: override.venue, date: override.date }
  let venue: string | undefined
  let date: string | undefined
  const m = /\(live\s+(?:at|from)\s+([^,]+),\s*(.+?)\)\s*$/i.exec(sampleTitle || '')
  if (m) { venue = m[1].trim(); date = m[2].trim() }
  if (!date) {
    const d = /([A-Z][a-z]+\.?\s+\d[\d\s&,–-]*\d{4})/.exec(showName || '')
    if (d) date = d[1].trim()
  }
  return { venue, date }
}

export default function ConcertsView() {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const snap = useSyncExternalStore(subscribeLiveSets, getLiveSetsSnapshot)
  const normalizedArtIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])

  const concerts = useMemo((): ConcertCard[] => {
    const liveIds = new Set(lib.tracks.map((t) => t.id))
    const out: ConcertCard[] = []
    for (const [albumKey, entry] of Object.entries(snap.sets)) {
      // Skip stale sets whose merged track is gone (parity with liveSetFor).
      if (!liveIds.has(entry.mergedTrackId)) continue
      // Derive band + clean show name from a constituent (still in lib.tracks,
      // just projected out of the regular views), falling back to the merged track.
      const src = lib.tracks.find((t) => t.id === entry.cues[0]?.trackId)
        ?? lib.tracks.find((t) => t.id === entry.mergedTrackId)
      const band = entry.cues[0]?.artist || src?.artist || ''
      const show = src?.album?.replace(/\s*\(Live Set\)\s*$/i, '') || albumKey.split('|||')[1] || 'Live Concert'
      const artHash = lookupArtwork(lib.artworkMap, normalizedArtIndex, band, show)
      const { venue, date } = parseConcertMeta(show, entry.cues[0]?.title || '', entry.concert)
      out.push({ albumKey, entry, band, show, venue, date, artHash: entry.concert?.poster || artHash })
    }
    return out.sort((a, b) => (b.entry.createdAt || '').localeCompare(a.entry.createdAt || ''))
  }, [snap, lib.tracks, lib.artworkMap, normalizedArtIndex])

  const openConcert = useCallback((albumKey: string) => {
    libDispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey })
  }, [libDispatch])

  return (
    <div className="concerts-view albums-view">
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
        <div className="concerts-grid">
          {concerts.map((c) => (
            <div
              key={c.albumKey}
              className="concert-poster"
              data-album-key={c.albumKey}
              onClick={() => openConcert(c.albumKey)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openConcert(c.albumKey) } }}
              role="button"
              tabIndex={0}
              title={`${c.show} — ${c.band}`}
            >
              <div className="concert-poster-art">
                {c.artHash ? (
                  <AlbumArtImage hash={c.artHash} alt={c.show} className="concert-poster-img" size={320} />
                ) : (
                  <div className="concert-poster-noart" aria-hidden="true">
                    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="#c9b98a" strokeWidth="1.4">
                      <circle cx="20" cy="18" r="14" /><circle cx="20" cy="18" r="4" fill="#c9b98a" stroke="none" />
                      <path d="M20 2 L24 13 L20 10 L16 13 Z" fill="#c9b98a" stroke="none" />
                    </svg>
                  </div>
                )}
              </div>
              <div className="concert-poster-band">
                <div className="concert-poster-artist">{c.band || c.show}</div>
                <div className="concert-poster-rule" />
                {c.venue && <div className="concert-poster-venue">{c.venue}</div>}
                <div className="concert-poster-date">
                  {c.date || `${c.entry.cues.length} songs · ${hms(c.entry.totalDurationMs)}`}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
