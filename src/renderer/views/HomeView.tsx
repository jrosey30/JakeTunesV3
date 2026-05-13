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

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { useAudio } from '../hooks/useAudio'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { requestDrillIn } from '../utils/drillIn'
import type { Track, MusicNewsItem, TourDate, UpcomingRelease } from '../types'
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

  // 4.4.21 polish: persist scroll position across view switches (4.4.13 hook).
  // The scrollable element is .home-view itself (vertical), but the
  // *important* scroll on this view is the HORIZONTAL scroll inside each
  // card row — 4.4.23 widens useScrollPersistence to handle both axes,
  // and we wire one hook call per scrollable element below.
  const rootRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('home', rootRef)

  // 4.4.23: per-row horizontal scroll persistence. Scrolling right
  // through Recently Added then bouncing to Songs and back used to
  // reset both rows to leftmost; not anymore.
  const recentRowRef = useRef<HTMLDivElement>(null)
  const artistsRowRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('home-row-recent', recentRowRef)
  useScrollPersistence('home-row-artists', artistsRowRef)

  // 4.4.27: removed the JS-based useElasticOverscroll calls — the
  // implementation was fighting Chromium's native macOS bounce
  // (because the hook set `overscroll-behavior: contain` to avoid
  // double-bouncing). Native bounce is what we actually want; let it
  // through.

  // 4.4.21 polish: brief flash on the clicked card so the click feels
  // acknowledged. Identified by album key; cleared after 380ms.
  const [flashedKey, setFlashedKey] = useState<string | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashCard = useCallback((key: string) => {
    setFlashedKey(key)
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => setFlashedKey(null), 380)
  }, [])

  // 4.4.28: Music News + Notable Releases. Both back-ends share a 1-hour
  // cache in main, so the parallel fetch here is cheap. Null means
  // "still loading"; [] means "loaded but empty".
  const [news, setNews] = useState<MusicNewsItem[] | null>(null)
  const [releases, setReleases] = useState<MusicNewsItem[] | null>(null)
  const [tourDates, setTourDates] = useState<TourDate[] | null>(null)
  const [upcoming, setUpcoming] = useState<UpcomingRelease[] | null>(null)
  const newsRowRef = useRef<HTMLDivElement>(null)
  const releasesRowRef = useRef<HTMLDivElement>(null)
  const tourDatesRowRef = useRef<HTMLDivElement>(null)
  const upcomingRowRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('home-row-news', newsRowRef)
  useScrollPersistence('home-row-releases', releasesRowRef)
  useScrollPersistence('home-row-tours', tourDatesRowRef)
  useScrollPersistence('home-row-upcoming', upcomingRowRef)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // News + releases are short RSS fetches — fire in parallel.
        const [n, r] = await Promise.all([
          window.electronAPI.getMusicNews(),
          window.electronAPI.getNotableReleases(),
        ])
        if (cancelled) return
        setNews(n.ok ? n.items : [])
        setReleases(r.ok ? r.items : [])
      } catch {
        if (cancelled) return
        setNews([])
        setReleases([])
      }
    })()
    // 4.4.32: tour dates run separately because the cold-cache call
    // takes ~3-8 sec (Bandsintown queries up to 60 artists, throttled
    // 8-concurrent in main). Don't block the news/releases UI on it.
    void (async () => {
      try {
        const t = await window.electronAPI.getTourDates()
        if (cancelled) return
        setTourDates(t.ok ? t.dates : [])
      } catch {
        if (cancelled) return
        setTourDates([])
      }
    })()
    // 4.4.34: upcoming releases also runs separately. MusicBrainz
    // batched-OR queries take ~2-4 sec on cold cache; instant after.
    void (async () => {
      try {
        const u = await window.electronAPI.getUpcomingReleasesPersonal()
        if (cancelled) return
        setUpcoming(u.ok ? u.items : [])
      } catch {
        if (cancelled) return
        setUpcoming([])
      }
    })()
    return () => { cancelled = true }
  }, [])

  // 4.4.31: 70/30 personalization. Items whose headlines mention an
  // artist in your library are surfaced first (~70% of the row); the
  // rest fills with universal music news. Matching is case-insensitive
  // word-boundary against the user's top 200 artists by playCount.
  // Artist names shorter than 3 chars are skipped to avoid junk
  // matches ("Of Mice & Men" headline matching "Of" the band, etc.).
  const personalizedNews = useMemo(() => {
    if (!news) return null
    if (news.length === 0) return []

    // Build the artist set: top 200 by aggregate playCount. Using
    // play count (not just presence) so the bias is toward artists
    // Jake actually listens to, not every obscure artist whose name
    // happens to appear in a track tag.
    const byArtist = new Map<string, number>()
    for (const t of lib.tracks) {
      const a = t.albumArtist || t.artist
      if (!a) continue
      const folded = a.toLowerCase().trim()
      if (folded.length < 3) continue
      byArtist.set(folded, (byArtist.get(folded) || 0) + (Number(t.playCount) || 0) + 1)
      // The "+ 1" gives every artist with even ONE track a baseline so
      // unplayed library entries still count as "library-relevant"
      // (just ranked below played ones).
    }
    const topArtists = Array.from(byArtist.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200)
      .map(([a]) => a)

    // Pre-compile regexes once. Word-boundary + escape special chars.
    const patterns = topArtists.map(a => {
      const escaped = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`\\b${escaped}\\b`, 'i')
    })

    const relevant: typeof news = []
    const universal: typeof news = []
    for (const item of news) {
      const matched = patterns.some(re => re.test(item.title))
      if (matched) relevant.push(item)
      else universal.push(item)
    }

    // 70/30 split, total ~10 items. If relevant is short, top up from
    // universal. If relevant is plentiful, hold to 70% so the user
    // still sees some "what's happening generally" alongside their own
    // bubble.
    const total = 10
    const targetRelevant = Math.ceil(total * 0.7)
    const out = [...relevant.slice(0, targetRelevant)]
    const remaining = total - out.length
    out.push(...universal.slice(0, remaining))
    return out
  }, [news, lib.tracks])

  const openLink = useCallback((url: string) => {
    void window.electronAPI.openExternalUrl(url)
  }, [])

  // 4.4.34: format a partial MusicBrainz release date as friendly future-tense
  // ("Sep 15", "September 2026", "2027").
  const formatUpcomingDate = (raw: string): string => {
    if (!raw) return 'TBA'
    if (raw.length === 4) return raw                                    // "2027"
    if (raw.length === 7) {
      const [y, m] = raw.split('-')
      const d = new Date(Number(y), Number(m) - 1, 1)
      return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    }
    const d = new Date(raw)
    if (isNaN(d.getTime())) return raw
    const sameYear = d.getFullYear() === new Date().getFullYear()
    return d.toLocaleDateString(undefined,
      sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
  }

  // "2 days ago" / "today" / "Apr 14" — short, friendly relative date.
  const formatDate = (iso: string): string => {
    if (!iso) return ''
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    const diffMs = Date.now() - d.getTime()
    const diffH = diffMs / (1000 * 60 * 60)
    if (diffH < 24) return 'today'
    if (diffH < 48) return 'yesterday'
    if (diffH < 24 * 7) return `${Math.floor(diffH / 24)} days ago`
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  // 4.4.29: welcoming header — time-of-day greeting, today's date,
  // Brooklyn weather (when the API key's configured), and a friendly
  // library-stats line. The greeting cycles by hour to feel less
  // robotic across a long listening day.
  const [weather, setWeather] = useState<{ tempF: number; condition: string; description: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.electronAPI.getBrooklynWeather().then(r => {
      if (!cancelled && r.ok) setWeather(r.weather)
    }).catch(() => { /* fall through to date-only header */ })
    return () => { cancelled = true }
  }, [])

  const greeting = useMemo(() => {
    const h = new Date().getHours()
    if (h < 5)  return 'Up late'
    if (h < 12) return 'Good morning'
    if (h < 17) return 'Good afternoon'
    if (h < 22) return 'Good evening'
    return 'Up late'
  }, [])

  const todayPretty = useMemo(() => {
    return new Date().toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric',
    })
  }, [])

  // A weather glyph that fits the iTunes-era aesthetic — small SVG icon,
  // not an emoji (emojis feel out of place in the iTunes 8 look).
  const weatherIcon = useMemo(() => {
    if (!weather) return null
    const cond = (weather.condition || '').toLowerCase()
    if (cond.includes('clear')) return '☀'
    if (cond.includes('cloud')) return '☁'
    if (cond.includes('rain') || cond.includes('drizzle')) return '☂'
    if (cond.includes('snow')) return '❄'
    if (cond.includes('thunder')) return '⚡'
    if (cond.includes('mist') || cond.includes('fog') || cond.includes('haze')) return '≋'
    return '·'
  }, [weather])

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

  // ── 4.4.33: Featured Album — "Today's Pick" hero. Date-seeded so the
  // same album shows all day, rotates to a different one tomorrow.
  // Picks from the user's top 50 by aggregate play count (filters out
  // the long tail of single-track no-name imports). Falls back to top
  // by newestAdded if the library has no play history yet. ──────────
  const featuredAlbum = useMemo(() => {
    interface AlbumStat extends AlbumCard {
      totalPlays: number
    }
    const map = new Map<string, AlbumStat>()
    for (const t of lib.tracks) {
      const artist = t.albumArtist || t.artist || 'Unknown Artist'
      const album = t.album || 'Unknown Album'
      const artistFolded = artist.toLowerCase().trim()
      const albumFolded = album.toLowerCase().trim()
      const key = `${artistFolded}|||${albumFolded}`
      let stat = map.get(key)
      if (!stat) {
        stat = {
          key,
          artist,
          artistFolded,
          album,
          year: t.year || '',
          tracks: [],
          newestAdded: t.dateAdded || '',
          totalPlays: 0,
        }
        map.set(key, stat)
      }
      stat.tracks.push(t)
      stat.totalPlays += Number(t.playCount) || 0
      if (t.dateAdded && t.dateAdded > stat.newestAdded) stat.newestAdded = t.dateAdded
      if (!stat.year && t.year) stat.year = t.year
    }
    const candidates = Array.from(map.values())
    if (candidates.length === 0) return null
    // Try top-50 by play count first; if all zeros, fall back to recency.
    candidates.sort((a, b) => b.totalPlays - a.totalPlays || b.newestAdded.localeCompare(a.newestAdded))
    const pool = candidates.slice(0, 50)
    // Day-of-year seed: floor(now / 86400 sec). Same value all day,
    // different next day — gives a curated daily-pick feel without
    // any randomness that resets on a re-render.
    const day = Math.floor(Date.now() / 86_400_000)
    return pool[day % pool.length]
  }, [lib.tracks])

  const playFeatured = useCallback(() => {
    if (!featuredAlbum || featuredAlbum.tracks.length === 0) return
    // Reuse the existing album-play machinery (sorts by disc/track no.).
    const sorted = [...featuredAlbum.tracks].sort((a, b) => {
      const da = Number(a.discNumber) || 1, db = Number(b.discNumber) || 1
      if (da !== db) return da - db
      const ta = Number(a.trackNumber) || 0, tb = Number(b.trackNumber) || 0
      return ta - tb
    })
    flashCard(featuredAlbum.key)
    playTrack(sorted[0], sorted, 0)
  }, [featuredAlbum, playTrack, flashCard])

  // ── 4.4.33: quick lifetime stats for the strip under the hero. All
  // derived from lib.tracks — no extra IPC, recomputes on import. ───
  const stats = useMemo(() => {
    let totalPlays = 0
    let totalDurationMs = 0
    const byArtist = new Map<string, number>()
    const byGenre = new Map<string, number>()
    for (const t of lib.tracks) {
      const plays = Number(t.playCount) || 0
      totalPlays += plays
      totalDurationMs += Number(t.duration) || 0
      const artist = t.albumArtist || t.artist
      if (artist) byArtist.set(artist, (byArtist.get(artist) || 0) + plays + 1)
      if (t.genre) byGenre.set(t.genre, (byGenre.get(t.genre) || 0) + plays + 1)
    }
    const topArtist = Array.from(byArtist.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || ''
    const topGenre = Array.from(byGenre.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || ''
    const totalHours = totalDurationMs / 3_600_000
    const hoursLabel =
      totalHours >= 1000 ? `${(totalHours / 1000).toFixed(1)}k hrs` :
      totalHours >= 100  ? `${Math.round(totalHours)} hrs` :
      totalHours >= 10   ? `${totalHours.toFixed(1)} hrs` :
                           `${totalHours.toFixed(1)} hrs`
    return { totalPlays, hoursLabel, topArtist, topGenre }
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
    flashCard(card.key)
    playTrack(card.tracks[0], card.tracks, 0)
  }

  return (
    <div className="home-view" ref={rootRef}>
      <div className="home-header">
        <h1 className="home-title">{greeting}, Jake.</h1>
        <div className="home-meta">
          <span className="home-meta-date">{todayPretty}</span>
          {weather && (
            <span className="home-meta-weather" title={weather.description}>
              <span className="home-meta-weather-icon" aria-hidden="true">{weatherIcon}</span>
              {Math.round(weather.tempF)}°{' '}{weather.description.replace(/^\w/, c => c.toUpperCase())}
            </span>
          )}
        </div>
        <p className="home-subtitle">
          {lib.tracks.length.toLocaleString()} tracks in your library
          {recentAlbums.length > 0 && (
            <> · last import {new Date(recentAlbums[0].newestAdded).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</>
          )}
        </p>
      </div>

      {/* ── 4.4.33: Featured Album hero — "Today's Pick from Your Library" ── */}
      {featuredAlbum && (
        <section className="home-featured">
          <div
            className="home-featured-art"
            onClick={playFeatured}
            role="button"
            tabIndex={0}
            title={`Play ${featuredAlbum.album} by ${featuredAlbum.artist}`}
          >
            {artHashForKey(featuredAlbum.key) ? (
              <img
                src={`album-art://${artHashForKey(featuredAlbum.key)}.jpg`}
                alt={featuredAlbum.album}
                draggable={false}
                onLoad={(e) => e.currentTarget.classList.add('home-album-art-loaded')}
              />
            ) : (
              <div className="home-album-art-placeholder home-featured-art-placeholder">
                <svg width="48" height="48" viewBox="0 0 40 40" fill="none" stroke="#999" strokeWidth="1.5">
                  <circle cx="20" cy="20" r="18" />
                  <circle cx="20" cy="20" r="6" />
                  <circle cx="20" cy="20" r="2" fill="#999" />
                </svg>
              </div>
            )}
            <div className="home-featured-play-overlay" aria-hidden="true">
              <svg width="32" height="32" viewBox="0 0 32 32" fill="#fff">
                <path d="M10 7v18l16-9z" />
              </svg>
            </div>
          </div>
          <div className="home-featured-info">
            <div className="home-featured-label">Today's pick from your library</div>
            <h2 className="home-featured-title">{featuredAlbum.album}</h2>
            <div className="home-featured-artist">{featuredAlbum.artist}</div>
            <div className="home-featured-meta">
              {featuredAlbum.tracks.length} track{featuredAlbum.tracks.length === 1 ? '' : 's'}
              {featuredAlbum.year && <> · {featuredAlbum.year}</>}
              {featuredAlbum.totalPlays > 0 && <> · {featuredAlbum.totalPlays.toLocaleString()} play{featuredAlbum.totalPlays === 1 ? '' : 's'}</>}
            </div>
            <div className="home-featured-actions">
              <button className="home-featured-btn home-featured-btn--primary" onClick={playFeatured}>
                <svg width="12" height="12" viewBox="0 0 32 32" fill="currentColor"><path d="M10 7v18l16-9z" /></svg>
                Play Album
              </button>
              <button
                className="home-featured-btn"
                onClick={() => {
                  requestDrillIn('artist', featuredAlbum.artist)
                  dispatch({ type: 'SET_VIEW', view: 'artists' })
                }}
              >
                More from {featuredAlbum.artist.length > 22 ? `${featuredAlbum.artist.slice(0, 22)}…` : featuredAlbum.artist}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* ── 4.4.33: Quick stats strip — total plays, library duration, top artist, top genre ── */}
      {lib.tracks.length > 0 && (
        <section className="home-stats">
          <div className="home-stat">
            <div className="home-stat-value">{stats.totalPlays.toLocaleString()}</div>
            <div className="home-stat-label">Total Plays</div>
          </div>
          <div className="home-stat">
            <div className="home-stat-value">{stats.hoursLabel}</div>
            <div className="home-stat-label">In Your Library</div>
          </div>
          {stats.topArtist && (
            <div className="home-stat">
              <div className="home-stat-value" title={stats.topArtist}>{stats.topArtist}</div>
              <div className="home-stat-label">Top Artist</div>
            </div>
          )}
          {stats.topGenre && (
            <div className="home-stat">
              <div className="home-stat-value" title={stats.topGenre}>{stats.topGenre}</div>
              <div className="home-stat-label">Top Genre</div>
            </div>
          )}
        </section>
      )}

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
          <div className="home-card-row" role="list" ref={recentRowRef}>
            {recentAlbums.map((card) => {
              const hash = artHashForKey(card.key)
              const flashing = flashedKey === card.key
              return (
                <div
                  key={card.key}
                  className={`home-album-card${flashing ? ' is-playing-flash' : ''}`}
                  role="listitem"
                  onClick={() => playAlbum(card)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    dispatch({ type: 'SET_VIEW', view: 'albums' })
                  }}
                  title={`${card.artist} — ${card.album}\nClick plays. Right-click jumps to Albums view.`}
                >
                  <div className="home-album-art">
                    {hash ? (
                      <img
                        src={`album-art://${hash}.jpg`}
                        alt={card.album}
                        draggable={false}
                        onLoad={(e) => e.currentTarget.classList.add('home-album-art-loaded')}
                      />
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
          <div className="home-card-row home-card-row--artists" role="list" ref={artistsRowRef}>
            {topArtists.map((card) => {
              const hash = artHashForKey(card.firstAlbumKey)
              return (
                <div
                  key={card.nameFolded}
                  className="home-artist-card"
                  role="listitem"
                  onClick={() => {
                    // 4.4.27: drill into THIS artist, not the generic
                    // Artists view. ArtistsView consumes the request
                    // on mount and expands + scrolls to the artist.
                    requestDrillIn('artist', card.name)
                    dispatch({ type: 'SET_VIEW', view: 'artists' })
                  }}
                  title={`${card.name}\n${card.totalPlays.toLocaleString()} plays across ${card.trackCount} track${card.trackCount === 1 ? '' : 's'}`}
                >
                  <div className="home-artist-art">
                    {hash ? (
                      <img
                        src={`album-art://${hash}.jpg`}
                        alt={card.name}
                        draggable={false}
                        onLoad={(e) => e.currentTarget.classList.add('home-artist-art-loaded')}
                      />
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

      {/* ── 4.4.32: Tour Dates (Bandsintown, 100% library-personalized) ──── */}
      {tourDates !== null && tourDates.length > 0 && (
        <section className="home-section">
          <div className="home-section-header">
            <h2 className="home-section-title">Coming to a Stage Near You</h2>
            <span className="home-section-source">via Bandsintown · your library's artists</span>
          </div>
          <div className="home-card-row" role="list" ref={tourDatesRowRef}>
            {tourDates.slice(0, 20).map((ev, i) => {
              const d = new Date(ev.date)
              const dateLabel = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
              const yearSuffix = d.getFullYear() !== new Date().getFullYear() ? `, ${d.getFullYear()}` : ''
              return (
                <div
                  key={`${ev.url}-${i}`}
                  className="home-tour-card"
                  role="listitem"
                  onClick={() => ev.url && openLink(ev.url)}
                  title={`${ev.artist} — ${ev.venue}\n${ev.city}\n${d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}\nOpen in Bandsintown`}
                >
                  <div className="home-tour-date">
                    <div className="home-tour-date-month">{d.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}</div>
                    <div className="home-tour-date-day">{d.getDate()}</div>
                  </div>
                  <div className="home-tour-info">
                    <div className="home-tour-artist">{ev.artist}</div>
                    <div className="home-tour-venue">{ev.venue}</div>
                    <div className="home-tour-city">{ev.city}{yearSuffix && <span className="home-tour-year"> · {d.getFullYear()}</span>}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* ── 4.4.34: Upcoming Releases (MusicBrainz, library-personalized) ── */}
      {upcoming !== null && upcoming.length > 0 && (
        <section className="home-section">
          <div className="home-section-header">
            <h2 className="home-section-title">On the Horizon</h2>
            <span className="home-section-source">via MusicBrainz · upcoming albums from your artists</span>
          </div>
          <div className="home-card-row" role="list" ref={upcomingRowRef}>
            {upcoming.map((item, i) => (
              <div
                key={`${item.mbid}-${i}`}
                className="home-upcoming-card"
                role="listitem"
                onClick={() => openLink(`https://musicbrainz.org/release-group/${item.mbid}`)}
                title={`${item.title} — ${item.artist}\nReleases ${formatUpcomingDate(item.releaseDate)}\nOpen on MusicBrainz`}
              >
                <div className="home-upcoming-art">
                  <img
                    src={item.coverUrl}
                    alt={item.title}
                    draggable={false}
                    onLoad={(e) => e.currentTarget.classList.add('home-album-art-loaded')}
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                  />
                  <div className="home-upcoming-art-fallback" aria-hidden="true">
                    {item.title.charAt(0).toUpperCase() || '?'}
                  </div>
                  <div className="home-upcoming-date-badge">
                    {formatUpcomingDate(item.releaseDate)}
                  </div>
                </div>
                <div className="home-album-info">
                  <div className="home-album-title">{item.title}</div>
                  <div className="home-album-artist">{item.artist}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── 4.4.28: Notable Releases (Pitchfork Best New Albums) ─────────── */}
      {releases !== null && releases.length > 0 && (
        <section className="home-section">
          <div className="home-section-header">
            <h2 className="home-section-title">New This Week</h2>
            <span className="home-section-source">via Pitchfork</span>
          </div>
          <div className="home-card-row" role="list" ref={releasesRowRef}>
            {releases.map((item) => (
              <div
                key={item.link}
                className="home-release-card"
                role="listitem"
                onClick={() => openLink(item.link)}
                title={`${item.title}\nOpen review in browser`}
              >
                <div className="home-release-art">
                  {item.imageUrl ? (
                    <img
                      src={item.imageUrl}
                      alt={item.title}
                      draggable={false}
                      onLoad={(e) => e.currentTarget.classList.add('home-album-art-loaded')}
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                    />
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
                  <div className="home-album-title">{item.title}</div>
                  <div className="home-album-artist">{formatDate(item.pubDate)}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── 4.4.28 / 4.4.30 / 4.4.31: Music News, 70/30 personalized ─────── */}
      {personalizedNews !== null && personalizedNews.length > 0 && (
        <section className="home-section">
          <div className="home-section-header">
            <h2 className="home-section-title">Music News</h2>
            <span className="home-section-source">
              {/* 4.4.30: derive source list from actual items so the
                  attribution stays in sync if the upstream feed mix
                  ever changes again. Cap to 4 names so the header
                  doesn't wrap on smaller windows. */}
              via {Array.from(new Set(personalizedNews.map(n => n.source))).slice(0, 4).join(', ')}
            </span>
          </div>
          <div className="home-card-row" role="list" ref={newsRowRef}>
            {personalizedNews.map((item) => (
              <div
                key={item.link}
                className="home-news-card"
                role="listitem"
                onClick={() => openLink(item.link)}
                title={`${item.title}\nOpen in browser`}
              >
                {item.imageUrl && (
                  <div className="home-news-art">
                    <img
                      src={item.imageUrl}
                      alt=""
                      draggable={false}
                      onLoad={(e) => e.currentTarget.classList.add('home-album-art-loaded')}
                      onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = 'none' }}
                    />
                  </div>
                )}
                <div className="home-news-meta">{item.source} · {formatDate(item.pubDate)}</div>
                <div className="home-news-title">{item.title}</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
