import { useEffect, useMemo, useState } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import type { Track } from '../types'
import '../styles/artist-detail.css'

// 4.5: hierarchy page for one artist. Reached from ArtistsView via a
// VIEW_ARTIST_DETAIL dispatch (sets currentView + activeArtist on the
// library state). Layout:
//   - back arrow + breadcrumb to Artists
//   - hero: artist photo (from getArtistImage IPC) + name + track / album count
//   - Wikipedia summary (getArtistWiki IPC, 24h disk cache)
//   - albums grid: every album the artist has in the local library
// Phase 2 (not yet): discography tracker showing albums via MusicBrainz
// that AREN'T in the library, with a "missing" badge.

interface AlbumGroup {
  name: string
  year: number | string
  tracks: Track[]
}

export default function ArtistDetailView() {
  const { state: lib, dispatch } = useLibrary()
  const { } = usePlayback()
  const { playTrack } = useAudio()
  const artist = lib.activeArtist || ''

  // Albums grouped from this artist's tracks. Match on either `artist`
  // exact OR contributingArtists.includes (handles 4.4 collab splits).
  const albums = useMemo<AlbumGroup[]>(() => {
    const a = artist.toLowerCase().trim()
    if (!a) return []
    const map = new Map<string, AlbumGroup>()
    for (const t of lib.tracks) {
      const direct = (t.artist || '').toLowerCase().trim() === a
      const viaCollab = (t.contributingArtists || []).some(x => (x || '').toLowerCase().trim() === a)
      if (!direct && !viaCollab) continue
      const name = (t.album || 'Unknown Album').trim()
      const key = name.toLowerCase()
      let g = map.get(key)
      if (!g) {
        g = { name, year: t.year || '', tracks: [] }
        map.set(key, g)
      }
      g.tracks.push(t)
      // Latest year wins for the group label (some compilations carry mixed years).
      if (Number(t.year) > Number(g.year)) g.year = t.year || g.year
    }
    return Array.from(map.values()).sort((x, y) => {
      const yx = Number(x.year) || 0
      const yy = Number(y.year) || 0
      return yy - yx
    })
  }, [lib.tracks, artist])

  // Sort tracks inside each album by disc + track number.
  useMemo(() => {
    for (const g of albums) {
      g.tracks.sort((a, b) => {
        const da = Number(a.discNumber) || 1
        const db = Number(b.discNumber) || 1
        if (da !== db) return da - db
        return (Number(a.trackNumber) || 0) - (Number(b.trackNumber) || 0)
      })
    }
  }, [albums])

  const totalTracks = albums.reduce((s, g) => s + g.tracks.length, 0)

  // Artist photo via the existing per-artist photo IPC (synology branch).
  const [photoSlug, setPhotoSlug] = useState<string | null>(null)
  useEffect(() => {
    if (!artist) return
    let cancelled = false
    window.electronAPI.getArtistImage(artist).then(r => {
      if (cancelled) return
      setPhotoSlug(r.ok ? r.slug : null)
    }).catch(() => { /* keep null — UI shows the monogram fallback */ })
    return () => { cancelled = true }
  }, [artist])

  // Wikipedia summary.
  const [wiki, setWiki] = useState<{ extract: string | null; pageUrl: string | null } | null>(null)
  const [wikiLoading, setWikiLoading] = useState(false)
  useEffect(() => {
    if (!artist) return
    let cancelled = false
    setWikiLoading(true)
    setWiki(null)
    window.electronAPI.getArtistWiki(artist).then(r => {
      if (cancelled) return
      setWiki({ extract: r.extract, pageUrl: r.pageUrl })
    }).catch(() => { /* leave wiki null */ })
      .finally(() => { if (!cancelled) setWikiLoading(false) })
    return () => { cancelled = true }
  }, [artist])

  // Artwork lookup for album tiles.
  const findArtHash = (artistName: string, albumName: string): string | undefined => {
    const key = `${artistName.toLowerCase().trim()}|||${albumName.toLowerCase().trim()}`
    return lib.artworkMap[key]
  }

  if (!artist) {
    return (
      <div className="artist-detail">
        <button className="artist-detail-back" onClick={() => dispatch({ type: 'SET_VIEW', view: 'artists' })}>‹ Artists</button>
        <div className="artist-detail-empty">No artist selected.</div>
      </div>
    )
  }

  return (
    <div className="artist-detail">
      <button
        className="artist-detail-back"
        onClick={() => dispatch({ type: 'SET_VIEW', view: 'artists' })}
      >
        ‹ Artists
      </button>

      <header className="artist-detail-hero">
        <div className="artist-detail-photo">
          {photoSlug ? (
            <img
              src={`artist-image://${photoSlug}.jpg`}
              alt=""
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          ) : (
            <div className="artist-detail-monogram">{artist.charAt(0).toUpperCase()}</div>
          )}
        </div>
        <div className="artist-detail-hero-info">
          <h1 className="artist-detail-name">{artist}</h1>
          <div className="artist-detail-stats">
            {albums.length} {albums.length === 1 ? 'album' : 'albums'} · {totalTracks} {totalTracks === 1 ? 'track' : 'tracks'}
          </div>
        </div>
      </header>

      <section className="artist-detail-wiki">
        {wikiLoading ? (
          <div className="artist-detail-wiki-loading">Looking up Wikipedia…</div>
        ) : wiki?.extract ? (
          <>
            <p className="artist-detail-wiki-extract">{wiki.extract}</p>
            {wiki.pageUrl && (
              <a
                className="artist-detail-wiki-link"
                href={wiki.pageUrl}
                onClick={(e) => {
                  e.preventDefault()
                  window.electronAPI.openExternalUrl(wiki.pageUrl!).catch(() => {})
                }}
              >
                Read more on Wikipedia →
              </a>
            )}
          </>
        ) : (
          <div className="artist-detail-wiki-empty">No Wikipedia entry found for this artist.</div>
        )}
      </section>

      <section className="artist-detail-albums">
        <h2 className="artist-detail-section-title">Albums in your library</h2>
        <div className="artist-detail-album-grid">
          {albums.map(album => {
            const hash = findArtHash(artist, album.name)
            return (
              <button
                key={album.name}
                className="artist-detail-album-card"
                onClick={() => {
                  // Open the first track of the album — playTrack will
                  // populate the queue with the album's tracks. Future
                  // pass: instead navigate to the album detail row in
                  // AlbumsView (needs scrollIntoView wiring).
                  const first = album.tracks[0]
                  if (first) playTrack(first, album.tracks, 0, undefined, true)
                }}
                title={`Play ${album.name}`}
              >
                <div className="artist-detail-album-art">
                  {hash ? (
                    <img src={`album-art://${hash}.jpg`} alt={album.name} />
                  ) : (
                    <div className="artist-detail-album-art-placeholder" />
                  )}
                </div>
                <div className="artist-detail-album-name">{album.name}</div>
                <div className="artist-detail-album-meta">
                  {album.year ? `${album.year} · ` : ''}{album.tracks.length} {album.tracks.length === 1 ? 'track' : 'tracks'}
                </div>
              </button>
            )
          })}
        </div>
      </section>

      {/* Phase 2 placeholder — MusicBrainz query for albums NOT in
          library would slot in here as "Discography you don't have". */}
    </div>
  )
}
