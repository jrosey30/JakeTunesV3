/**
 * 4.4.19: Home / Dashboard view.
 *
 * The iTunes 8 era had a Music sidebar that dumped you straight into
 * Songs. Pleasant, but flat — no surface for "what's new in my library
 * this week" or "who am I actually listening to." Phase E of the design
 * plan calls for a Home/Dashboard that aggregates these surfaces.
 *
 * First ship (this version) covers two sections:
 *
 *   - **Recently Added** — top 12 albums sorted by max track dateAdded,
 *     horizontal card row. Click drills into Albums view.
 *   - **Top Artists** — top 10 artists by aggregate playCount, smaller
 *     horizontal card row. Click drills into Artists view.
 *
 * Future ships add: Listening Stats, Picks aggregator, Music News,
 * Bandsintown integration. Sections are independent React components
 * inside this file so future additions are local edits.
 *
 * The aggregation work runs in useMemo against the same lib.tracks
 * that AlbumsView/ArtistsView consume — single source of truth, no
 * separate state.
 */

import { useMemo } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { useAudio } from '../hooks/useAudio'
import type { Track } from '../types'
import '../styles/home.css'

interface AlbumCard {
  /** "artist|||album" lowercased, stable for artwork lookup. */
  key: string
  artist: string       // display
  artistFolded: string // lower for art lookup
  album: string
  year: string | number
  tracks: Track[]
  /** Most recent dateAdded among tracks in this album. ISO string. */
  newestAdded: string
}

interface ArtistCard {
  name: string         // display
  nameFolded: string   // lower for grouping / art lookup of first album
  totalPlays: number
  trackCount: number
  /** First album we can find that has artwork, for the card image. */
  firstAlbumKey: string | null
}

export default function HomeView() {
  const { state: lib, dispatch } = useLibrary()
  const { playTrack } = useAudio()

  // ── Recently Added: aggregate by album, sort by newest track dateAdded ─
  const recentAlbums = useMemo((): AlbumCard[] => {
    const map = new Map<string, AlbumCard>()
    for (const t of lib.tracks) {
      const artist = t.albumArtist || t.artist || 'Unknown Artist'
      const album = t.album || 'Unknown Album'
      const artistFolded = artist.toLowerCase().trim()
      const albumFolded = album.toLowerCase().trim()
      const key = `${artistFolded}|||${albumFolded}`
      let card = map.get(key)
      if (!card) {
        card = {
          key,
          artist,
          artistFolded,
          album,
          year: t.year || '',
          tracks: [],
          newestAdded: t.dateAdded || '',
        }
        map.set(key, card)
      }
      card.tracks.push(t)
      // Track the most recent dateAdded across all tracks in this album.
      // Re-imports of a single track on an existing album bump the album
      // back up to the top — feels right ("oh I added that bonus track
      // last night").
      if (t.dateAdded && t.dateAdded > card.newestAdded) {
        card.newestAdded = t.dateAdded
      }
      if (!card.year && t.year) card.year = t.year
    }
    // Sort tracks within each album the way AlbumsView does so click-to-play
    // hits track 1 first.
    for (const card of map.values()) {
      card.tracks.sort((a, b) => {
        const da = Number(a.discNumber) || 1, db = Number(b.discNumber) || 1
        if (da !== db) return da - db
        const ta = Number(a.trackNumber) || 0, tb = Number(b.trackNumber) || 0
        return ta - tb
      })
    }
    return Array.from(map.values())
      .filter(c => c.newestAdded)
      .sort((a, b) => b.newestAdded.localeCompare(a.newestAdded))
      .slice(0, 12)
  }, [lib.tracks])

  // ── Top Artists: aggregate by artist, sort by total play count ────────
  const topArtists = useMemo((): ArtistCard[] => {
    const map = new Map<string, ArtistCard>()
    for (const t of lib.tracks) {
      const artist = t.albumArtist || t.artist || 'Unknown Artist'
      const folded = artist.toLowerCase().trim()
      if (!folded || folded === 'unknown artist') continue
      let card = map.get(folded)
      if (!card) {
        card = {
          name: artist,
          nameFolded: folded,
          totalPlays: 0,
          trackCount: 0,
          firstAlbumKey: null,
        }
        map.set(folded, card)
      }
      card.totalPlays += Number(t.playCount) || 0
      card.trackCount += 1
      if (!card.firstAlbumKey && t.album) {
        const albumFolded = t.album.toLowerCase().trim()
        card.firstAlbumKey = `${folded}|||${albumFolded}`
      }
    }
    return Array.from(map.values())
      .filter(c => c.totalPlays > 0)
      .sort((a, b) => b.totalPlays - a.totalPlays)
      .slice(0, 10)
  }, [lib.tracks])

  // Resolve an artwork hash for an album key. Mirrors AlbumsView's
  // approach but simpler — Home's small cards only need the album-
  // artist match; we don't fall through every artist variant.
  const artHashForKey = (key: string | null): string | undefined => {
    if (!key) return undefined
    return lib.artworkMap[key]
  }

  const playAlbum = (card: AlbumCard) => {
    if (card.tracks.length === 0) return
    playTrack(card.tracks[0], card.tracks, 0)
  }

  return (
    <div className="home-view">
      <div className="home-header">
        <h1 className="home-title">JakeTunes</h1>
        <p className="home-subtitle">
          {lib.tracks.length.toLocaleString()} tracks
          {recentAlbums.length > 0 && (
            <> · last import {new Date(recentAlbums[0].newestAdded).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</>
          )}
        </p>
      </div>

      {/* ── Recently Added ───────────────────────────────────────────────── */}
      <section className="home-section">
        <div className="home-section-header">
          <h2 className="home-section-title">Recently Added</h2>
          {recentAlbums.length > 0 && (
            <button
              className="home-section-more"
              onClick={() => dispatch({ type: 'VIEW_SMART_PLAYLIST', id: 'recently-added' })}
            >
              See All
            </button>
          )}
        </div>
        {recentAlbums.length === 0 ? (
          <div className="home-empty">No tracks imported yet. Drop a folder onto JakeTunes to start.</div>
        ) : (
          <div className="home-card-row" role="list">
            {recentAlbums.map((card) => {
              const hash = artHashForKey(card.key)
              return (
                <div
                  key={card.key}
                  className="home-album-card"
                  role="listitem"
                  onClick={() => playAlbum(card)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    dispatch({ type: 'SET_VIEW', view: 'albums' })
                  }}
                  title={`${card.artist} — ${card.album}\nDouble-click or single-click plays. Right-click jumps to Albums view.`}
                >
                  <div className="home-album-art">
                    {hash ? (
                      <img src={`album-art://${hash}.jpg`} alt={card.album} draggable={false} />
                    ) : (
                      <div className="home-album-art-placeholder">
                        <svg width="32" height="32" viewBox="0 0 40 40" fill="none" stroke="#999" strokeWidth="1.5">
                          <circle cx="20" cy="20" r="18" />
                          <circle cx="20" cy="20" r="6" />
                          <circle cx="20" cy="20" r="2" fill="#999" />
                        </svg>
                      </div>
                    )}
                  </div>
                  <div className="home-album-info">
                    <div className="home-album-title">{card.album}</div>
                    <div className="home-album-artist">{card.artist}</div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ── Top Artists ──────────────────────────────────────────────────── */}
      {topArtists.length > 0 && (
        <section className="home-section">
          <div className="home-section-header">
            <h2 className="home-section-title">Top Artists</h2>
            <button
              className="home-section-more"
              onClick={() => dispatch({ type: 'SET_VIEW', view: 'artists' })}
            >
              See All
            </button>
          </div>
          <div className="home-card-row home-card-row--artists" role="list">
            {topArtists.map((card) => {
              const hash = artHashForKey(card.firstAlbumKey)
              return (
                <div
                  key={card.nameFolded}
                  className="home-artist-card"
                  role="listitem"
                  onClick={() => dispatch({ type: 'SET_VIEW', view: 'artists' })}
                  title={`${card.name}\n${card.totalPlays.toLocaleString()} plays across ${card.trackCount} track${card.trackCount === 1 ? '' : 's'}`}
                >
                  <div className="home-artist-art">
                    {hash ? (
                      <img src={`album-art://${hash}.jpg`} alt={card.name} draggable={false} />
                    ) : (
                      <div className="home-artist-art-placeholder">
                        {card.name.split(/\s+/).slice(0, 2).map(w => w.charAt(0).toUpperCase()).join('')}
                      </div>
                    )}
                  </div>
                  <div className="home-artist-info">
                    <div className="home-artist-name">{card.name}</div>
                    <div className="home-artist-plays">{card.totalPlays.toLocaleString()} plays</div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
