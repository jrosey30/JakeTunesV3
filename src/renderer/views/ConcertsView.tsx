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
  artHash?: string
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
      out.push({ albumKey, entry, band, show, artHash: entry.concert?.poster || artHash })
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
        <div className="albums-grid concerts-grid">
          {concerts.map((c) => (
            <div
              key={c.albumKey}
              className="album-card concert-card"
              data-album-key={c.albumKey}
              onClick={() => openConcert(c.albumKey)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openConcert(c.albumKey) } }}
              role="button"
              tabIndex={0}
            >
              <div className="album-card-art concert-card-poster">
                {c.artHash ? (
                  <AlbumArtImage hash={c.artHash} alt={c.show} className="album-card-img" size={320} />
                ) : (
                  <svg width="32" height="32" viewBox="0 0 32 32" fill="#bbb" aria-hidden="true">
                    <circle cx="16" cy="16" r="14" fill="none" stroke="#bbb" strokeWidth="1" />
                    <circle cx="16" cy="16" r="5" fill="none" stroke="#bbb" strokeWidth="1" />
                    <circle cx="16" cy="16" r="1.5" fill="#bbb" />
                  </svg>
                )}
              </div>
              <div className="album-card-title">{c.entry.concert?.date ? `${c.show}` : c.show}</div>
              <div className="album-card-artist">
                {c.band}
                <span className="concert-card-meta">
                  {' · '}{c.entry.cues.length} songs · {hms(c.entry.totalDurationMs)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
