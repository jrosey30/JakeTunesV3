/**
 * Home / Dashboard — the desktop launch page (first view after splash).
 *
 * Hierarchy: greeting + invite → library shelves (catalog cards with
 * counts), then the featured pick (or empty-library welcome) and the
 * existing rails (mixes, recents, artists, news).
 *
 * Aggregation runs in useMemo against lib.tracks — same source as
 * AlbumsView/ArtistsView, no separate state.
 */

import { useEffect, useMemo, useRef, useState, useCallback, useSyncExternalStore } from 'react'
import { getPreviewSnapshot, subscribePreview, togglePreview } from '../previewPlayer'
import { PlayIcon, PauseIcon } from '../components/TransportIcons'
import { useLibrary } from '../context/LibraryContext'
import { useAudio } from '../hooks/useAudio'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { getCached, setCached, isWarm } from '../homeCache'
import { useRegularLibraryTracks } from '../hooks/useRegularLibraryTracks'
import { requestDrillIn } from '../utils/drillIn'
import { formatAppDate } from '../utils/formatDate'
import ScrollTopButton from '../components/ScrollTopButton'
import { buildNormalizedArtworkIndex, lookupArtwork, queueArtworkResolutions } from '../utils/artworkLookup'
import { prefetchAlbumArtHashes } from '../utils/artworkPrefetch'
import AlbumArtImage from '../components/AlbumArtImage'
import MadeForYou from '../components/MadeForYou'
import { sortAlbumTracks } from '../utils/albumTrackOrder'
import type { Track, MusicNewsItem, TourDate, VenueShow, UpcomingRelease, ListeningMemoryData, RediscoveryPick } from '../types'
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

/** Enter/Space on role=button cards — mouse click already works. */
function activateOnKey(action: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      action()
    }
  }
}

/** Small weather marks — SVG, not emoji (emojis fight the iTunes-8 type). */
function WeatherGlyph({ condition }: { condition: string }) {
  const c = (condition || '').toLowerCase()
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (c.includes('clear')) {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
        <circle cx="8" cy="8" r="2.8" />
        <path d="M8 1.6v1.4M8 13v1.4M1.6 8h1.4M13 8h1.4M3.3 3.3l1 1M11.7 11.7l1 1M3.3 12.7l1-1M11.7 4.3l1-1" />
      </svg>
    )
  }
  if (c.includes('rain') || c.includes('drizzle')) {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
        <path d="M4.6 9.2h6.8A2.4 2.4 0 0 0 11.6 4.6 3.2 3.2 0 0 0 5.6 3.6 2.3 2.3 0 0 0 4.6 9.2z" />
        <path d="M6 11.2v2.2M8 11.6v2.2M10 11.2v2.2" />
      </svg>
    )
  }
  if (c.includes('snow')) {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
        <path d="M8 2v12M3.2 5.2l9.6 5.6M3.2 10.8l9.6-5.6" />
      </svg>
    )
  }
  if (c.includes('thunder')) {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
        <path d="M9.2 1.8 4.6 9h3.2L6.6 14.2 12 7.2H8.6z" />
      </svg>
    )
  }
  if (c.includes('mist') || c.includes('fog') || c.includes('haze')) {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
        <path d="M2.5 6h11M3.5 8.5h9M4.5 11h7" />
      </svg>
    )
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
      <path d="M4.5 11.2h7.2a2.6 2.6 0 0 0 .3-5.2 3.4 3.4 0 0 0-6.4-1.1A2.5 2.5 0 0 0 4.5 11.2z" />
    </svg>
  )
}

type ShelfKind = 'songs' | 'albums' | 'artists' | 'shop' | 'recent'

/** Line glyphs for the library shelf cards — 20×20 in a 36×36 well.
 *  Warm currentColor, not the sidebar's 12px category fills, so the
 *  row reads as shop bays rather than a second LIBRARY menu. */
function ShelfGlyph({ kind }: { kind: ShelfKind }) {
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (kind === 'songs') {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" {...stroke}>
        <path d="M7.5 16.2a2.4 2.4 0 1 1-2.4-2.4V6.1L16 4.2v7.8" />
        <circle cx="13.6" cy="14.4" r="2.4" />
      </svg>
    )
  }
  if (kind === 'albums') {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" {...stroke}>
        <circle cx="10" cy="10" r="7.2" />
        <circle cx="10" cy="10" r="2.1" />
      </svg>
    )
  }
  if (kind === 'artists') {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" {...stroke}>
        <circle cx="10" cy="7" r="3" />
        <path d="M4.4 16.2c.6-3 2.7-4.6 5.6-4.6s5 1.6 5.6 4.6" />
      </svg>
    )
  }
  if (kind === 'shop') {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" {...stroke}>
        <path d="M3.4 8.6h13.2v8.2H3.4z" />
        <path d="M3.4 11.6h13.2" />
        <path d="M6.2 8.6V6.4a3.8 2.2 0 0 1 7.6 0v2.2" />
      </svg>
    )
  }
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" {...stroke}>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M10 6.2V10l2.8 1.8" />
    </svg>
  )
}

function formatShelfCount(n: number, singular: string, plural: string): string {
  if (n <= 0) return 'Empty'
  return `${n.toLocaleString()} ${n === 1 ? singular : plural}`
}

export default function HomeView() {
  const { state: lib, dispatch } = useLibrary()

  // 2026-08-08 — Home's rails must use the REGULAR library. A declared
  // concert's 55 constituent songs were counted here, inflating artist
  // play totals and letting a setlist album surface as 'Recently Added'.
  // Same projection every other list already wraps its source in.
  const regularTracks = useRegularLibraryTracks(lib.tracks)
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
  const [news, setNews] = useState<MusicNewsItem[] | null>(() => getCached('news') ?? null)
  const [releases, setReleases] = useState<MusicNewsItem[] | null>(() => getCached('releases') ?? null)
  // 30s iTunes preview per New This Week album, fetched on first ▶ press
  // (Jake, 2026-08-07: "a way to preview a song from each of those new
  // albums without leaving that screen"). link → url; null = looked up,
  // iTunes has nothing (button hides rather than lying).
  const [releasePreviews, setReleasePreviews] = useState<Map<string, string | null>>(() => new Map())
  const preview = useSyncExternalStore(subscribePreview, getPreviewSnapshot)
  const previewRelease = async (e: React.MouseEvent, item: MusicNewsItem): Promise<void> => {
    e.stopPropagation()   // the card itself opens the review link
    const known = releasePreviews.get(item.link)
    if (known) { togglePreview(item.link, known, item.title, item.artist || ''); return }
    if (known === null) return
    // iTunes-with-Deezer-fallback lookup in main — survives Apple's
    // rate-limit windows, which is what made the first cut of this
    // button die silently (Jake: "shit dont work!!!!").
    const r = await window.electronAPI.lookupAlbumPreview?.({ artist: item.artist || '', album: item.title })
    const url = r?.previewUrl || null
    setReleasePreviews((m) => new Map(m).set(item.link, url))
    if (url) togglePreview(item.link, url, item.title, item.artist || '')
  }
  const [tourDates, setTourDates] = useState<TourDate[] | null>(() => getCached('tour') ?? null)
  const [venueShows, setVenueShows] = useState<VenueShow[] | null>(() => getCached('venues') ?? null)
  const [upcoming, setUpcoming] = useState<UpcomingRelease[] | null>(() => getCached('upcoming') ?? null)
  const newsRowRef = useRef<HTMLDivElement>(null)
  const releasesRowRef = useRef<HTMLDivElement>(null)
  const tourDatesRowRef = useRef<HTMLDivElement>(null)
  const venueRowRef = useRef<HTMLDivElement>(null)
  const upcomingRowRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('home-row-news', newsRowRef)
  useScrollPersistence('home-row-releases', releasesRowRef)
  useScrollPersistence('home-row-tours', tourDatesRowRef)
  useScrollPersistence('home-row-venues', venueRowRef)
  useScrollPersistence('home-row-upcoming', upcomingRowRef)

  // 2026-08-08 — Bandsintown lists every NIGHT of a residency as its own
  // event, so "Live Near You" was showing 20 cards for 6 actual shows
  // (Olivia Rodrigo alone took 10 slots at Barclays). Collapse consecutive
  // nights by artist+venue into ONE card that says how many nights it runs.
  // Grouping key is artist+venue (identity), never the display string.
  const tourRuns = useMemo(() => {
    if (!tourDates) return []
    const byPlace = new Map<string, TourDate[]>()
    for (const ev of tourDates) {
      const k = `${(ev.artist || '').toLowerCase().trim()}|${(ev.venue || '').toLowerCase().trim()}`
      const arr = byPlace.get(k)
      if (arr) arr.push(ev)
      else byPlace.set(k, [ev])
    }
    const runs: Array<{ ev: TourDate; nights: number; lastDate: string | null }> = []
    for (const evs of byPlace.values()) {
      const sorted = [...evs].sort((a, b) => a.date.localeCompare(b.date))
      runs.push({
        ev: sorted[0],
        nights: sorted.length,
        lastDate: sorted.length > 1 ? sorted[sorted.length - 1].date : null,
      })
    }
    return runs.sort((a, b) => a.ev.date.localeCompare(b.ev.date))
  }, [tourDates])

  // Cache-writing setters: the fetch bodies below are unchanged, they just
  // now persist what they got so the next visit doesn't have to ask
  // (2026-08-09, "they appear too often"). See homeCache.ts.
  const cacheThen = useCallback(<T,>(key: string, set: (v: T) => void) => (v: T) => {
    setCached(key, v)
    set(v)
  }, [])

  // Every lane Home waits on. Named once so `isWarm` and the settle map can't
  // drift apart — a lane added to one and not the other would either gate
  // forever or paint half-empty.
  const HOME_LANES = ['memory', 'rediscovery', 'news', 'releases', 'tour', 'venues', 'upcoming', 'weather'] as const

  // ── one-paint gate ────────────────────────────────────────────────────────
  // Home fires six independent fetches (memory, rediscover, news+releases,
  // tour dates, upcoming, weather) and each card used to pop in whenever its
  // data landed — the page assembled in random order over seconds (Jake: "the
  // features on every page need to load at same time"). Hold one skeleton
  // until all slots settle, capped at 2.5s: tour dates can take 3-8s cold
  // (Bandsintown across 60 artists) and holding the whole Home page on that
  // would be worse than one late card. Warm visits paint once, instantly.
  const [homeSettled, setHomeSettled] = useState({ memory: false, rediscovery: false, newsRel: false, tour: false, upcoming: false, weather: false })
  const settleHome = useCallback((k: keyof typeof homeSettled) => {
    setHomeSettled((s) => (s[k] ? s : { ...s, [k]: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [homeCapHit, setHomeCapHit] = useState(false)
  useEffect(() => {
    const cap = setTimeout(() => setHomeCapHit(true), 2500)
    return () => clearTimeout(cap)
  }, [])
  // A RETURN VISIT PAINTS IMMEDIATELY. `warm` is computed once, before the
  // first render, so a revisit has real content on frame one and the gate is
  // never mounted at all — the whole point of the cache (2026-08-09: "they
  // appear too often"). Cold visits behave exactly as before: hold one
  // skeleton until the lanes settle, capped at 2.5s.
  const [warm] = useState(() => isWarm(HOME_LANES))
  const pageReady = warm || homeCapHit || Object.values(homeSettled).every(Boolean)

  // Brain #1 — Listening Memory. One fetch per mount; main computes streaks/
  // habits from the local play log (no network). Null → card hidden.
  const [memory, setMemory] = useState<ListeningMemoryData | null>(() => getCached('memory') ?? null)
  useEffect(() => {
    let cancelled = false
    window.electronAPI.getListeningMemory?.().then((r) => {
      if (!cancelled) { const v = (r?.ok && r.insights) ? (r as ListeningMemoryData) : null; setCached('memory', v); if (v) setMemory(v) }
    }).catch(() => { /* card just doesn't render */ })
      .finally(() => { if (!cancelled) settleHome('memory') })
    return () => { cancelled = true }
  }, [])

  // Brain — Rediscover: owned-but-overlooked artists with Music Man's pitch.
  const rediscoverRowRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('home-row-rediscover', rediscoverRowRef)
  const [rediscovery, setRediscovery] = useState<RediscoveryPick[] | null>(() => getCached('rediscovery') ?? null)
  useEffect(() => {
    let cancelled = false
    window.electronAPI.getRediscovery?.().then((r) => {
      if (!cancelled) { const v = (r?.ok && r.picks) ? r.picks : null; setCached('rediscovery', v); if (v) setRediscovery(v) }
    }).catch(() => { /* section just doesn't render */ })
      .finally(() => { if (!cancelled) settleHome('rediscovery') })
    return () => { cancelled = true }
  }, [])
  const playRediscovery = useCallback((pick: RediscoveryPick) => {
    const norm = (s: string) => (s || '').trim().toLowerCase()
    const tracks = lib.tracks.filter((t) => norm(t.albumArtist || t.artist) === norm(pick.artist))
    if (tracks.length) playTrack(tracks[0], tracks, 0, undefined, true)
  }, [lib.tracks, playTrack])

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
        { const nv = n.ok ? n.items : []; const rv = r.ok ? r.items : []
          setCached('news', nv); setCached('releases', rv); setNews(nv); setReleases(rv) }
      } catch {
        if (cancelled) return
        { setCached('news', []); setCached('releases', []); setNews([]); setReleases([]) }
      } finally {
        if (!cancelled) settleHome('newsRel')
      }
    })()
    // 4.4.32: tour dates run separately because the cold-cache call
    // takes ~3-8 sec (Bandsintown queries up to 60 artists, throttled
    // 8-concurrent in main). Don't block the news/releases UI on it.
    void (async () => {
      try {
        const t = await window.electronAPI.getTourDates()
        if (cancelled) return
        { const v = t.ok ? t.dates : []; setCached('tour', v); setTourDates(v) }
      } catch {
        if (cancelled) return
        { setCached('tour', []); setTourDates([]) }
      } finally {
        if (!cancelled) settleHome('tour')
      }
    })()
    // 2026-08-08: venue shows — independent of the artist query above, and
    // deliberately not gated on it. Ten small unofficial venue scrapes; a
    // rotted one yields [] and the lane just renders fewer rooms.
    void (async () => {
      try {
        const v = await window.electronAPI.getVenueShows()
        if (cancelled) return
        { const vv = v.ok ? v.shows : []; setCached('venues', vv); setVenueShows(vv) }
      } catch {
        if (cancelled) return
        { setCached('venues', []); setVenueShows([]) }
      }
    })()
    // 4.4.34: upcoming releases also runs separately. MusicBrainz
    // batched-OR queries take ~2-4 sec on cold cache; instant after.
    void (async () => {
      try {
        const u = await window.electronAPI.getUpcomingReleasesPersonal()
        if (cancelled) return
        { const uv = u.ok ? u.items : []; setCached('upcoming', uv); setUpcoming(uv) }
      } catch {
        if (cancelled) return
        { setCached('upcoming', []); setUpcoming([]) }
      } finally {
        if (!cancelled) settleHome('upcoming')
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
  const [weather, setWeather] = useState<{ tempF: number; condition: string; description: string } | null>(() => getCached('weather') ?? null)
  useEffect(() => {
    let cancelled = false
    void window.electronAPI.getBrooklynWeather().then(r => {
      if (!cancelled) { const wv = r.ok ? r.weather : null; setCached('weather', wv); if (wv) setWeather(wv) }
    }).catch(() => { /* fall through to date-only header */ })
      .finally(() => { if (!cancelled) settleHome('weather') })
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

  const openImport = useCallback(() => {
    window.dispatchEvent(new Event('jaketunes-import-files'))
  }, [])

  const goView = useCallback((view: 'songs' | 'albums' | 'artists' | 'discovery') => {
    dispatch({ type: 'SET_VIEW', view })
  }, [dispatch])

  // ── Recently Added: aggregate by album, sort by newest track dateAdded ─
  const recentAlbums = useMemo((): AlbumCard[] => {
    const map = new Map<string, AlbumCard>()
    for (const t of regularTracks) {
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
      card.tracks = sortAlbumTracks(card.tracks)
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
    const sorted = sortAlbumTracks(featuredAlbum.tracks)
    flashCard(featuredAlbum.key)
    playTrack(sorted[0], sorted, 0, undefined, true)
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

  // Shelf inventory — same regular-library projection Songs/Albums/Artists
  // use, so the counts match the views the cards open. One pass.
  const shelfCounts = useMemo(() => {
    const albums = new Set<string>()
    const artists = new Set<string>()
    for (const t of regularTracks) {
      const artist = (t.albumArtist || t.artist || '').toLowerCase().trim()
      const album = (t.album || '').toLowerCase().trim()
      if (artist && artist !== 'unknown artist') artists.add(artist)
      if (album) albums.add(`${artist}|||${album}`)
    }
    return { songs: regularTracks.length, albums: albums.size, artists: artists.size }
  }, [regularTracks])

  // ── Top Artists: aggregate by artist, sort by total play count ────────
  const topArtists = useMemo((): ArtistCard[] => {
    const map = new Map<string, ArtistCard>()
    for (const t of regularTracks) {
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

  // 4.5: artwork lookup with normalization fallback. The key passed
  // in is the canonical "artistFolded|||albumFolded" pre-built by the
  // card aggregator, but the artworkMap may store the entry under a
  // VARIANT (e.g. an album imported as "X (Remastered)" while the
  // grouped card key is just "X"). lookupArtwork tries exact first
  // then falls back to a normalized scan that strips parens/diacritics.
  const normalizedArtIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])
  const artHashForKey = useCallback((key: string | null): string | undefined => {
    if (!key) return undefined
    if (lib.artworkMap[key]) return lib.artworkMap[key]
    const [artist, album] = key.split('|||')
    return lookupArtwork(lib.artworkMap, normalizedArtIndex, artist || '', album || '')
  }, [lib.artworkMap, normalizedArtIndex])

  useEffect(() => {
    if (lib.currentView !== 'home') return
    const keys = [
      featuredAlbum?.key,
      ...recentAlbums.map(c => c.key),
    ].filter((k): k is string => !!k)
    const missing = keys.filter(k => !artHashForKey(k))
    if (missing.length === 0) return
    queueArtworkResolutions(
      missing.map(k => {
        const [artist, album] = k.split('|||')
        return { artist: artist || '', album: album || '' }
      }),
      dispatch,
    )
  }, [lib.currentView, featuredAlbum?.key, recentAlbums, artHashForKey, dispatch])

  useEffect(() => {
    if (lib.currentView !== 'home') return
    const hashes = [
      featuredAlbum?.key && artHashForKey(featuredAlbum.key),
      ...recentAlbums.map(c => artHashForKey(c.key)),
    ]
    prefetchAlbumArtHashes(hashes, 320)
  }, [lib.currentView, featuredAlbum?.key, recentAlbums, lib.artworkMap, normalizedArtIndex])

  const playAlbum = (card: AlbumCard) => {
    if (card.tracks.length === 0) return
    flashCard(card.key)
    playTrack(card.tracks[0], card.tracks, 0, undefined, true)
  }

  const libraryEmpty = lib.tracks.length === 0
  const invite = libraryEmpty
    ? 'Your library is waiting. Import a folder, or browse the Record Shop.'
    : featuredAlbum
      ? `Today’s pick is ${featuredAlbum.album} — play it, or open a shelf.`
      : 'Pick a shelf and start listening.'

  // 2026-09-02 — no whole-page gate. A cold Home (every fresh launch, right
  // after the splash) used to show "Warming up the room…" for up to 2.5 s.
  // Now it paints whatever is ready on frame one and the network bands ease
  // in as they land (`.home-section` mount fade in home.css) — arrivals read
  // as intentional instead of as pops. `pageReady` stays for the bookkeeping.
  void pageReady

  return (
    <div className="home-view" ref={rootRef}>
      <ScrollTopButton targetRef={rootRef} />
      <header className="home-header">
        <div className="home-header-copy">
          <p className="home-kicker">Welcome</p>
          <h1 className="home-title">{greeting}, Jake.</h1>
          <div className="home-meta">
            <span className="home-meta-date">{todayPretty}</span>
            {weather && (
              <span className="home-meta-weather" title={weather.description}>
                <span className="home-meta-weather-icon" aria-hidden="true">
                  <WeatherGlyph condition={weather.condition} />
                </span>
                {Math.round(weather.tempF)}°{' '}{weather.description.replace(/^\w/, c => c.toUpperCase())}
              </span>
            )}
            {!libraryEmpty && (
              <span className="home-meta-count">
                {lib.tracks.length.toLocaleString()} track{lib.tracks.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
          <p className="home-invite">{invite}</p>
        </div>
        <nav
          className={`home-shelves${libraryEmpty ? '' : ' home-shelves--5'}`}
          aria-label="Library shelves"
        >
          <button type="button" className="home-shelf" onClick={() => goView('songs')}>
            <span className="home-shelf-icon" aria-hidden="true"><ShelfGlyph kind="songs" /></span>
            <span className="home-shelf-copy">
              <span className="home-shelf-label">Songs</span>
              <span className="home-shelf-count">{formatShelfCount(shelfCounts.songs, 'song', 'songs')}</span>
            </span>
            <span className="home-shelf-go" aria-hidden="true">›</span>
          </button>
          <button type="button" className="home-shelf" onClick={() => goView('albums')}>
            <span className="home-shelf-icon" aria-hidden="true"><ShelfGlyph kind="albums" /></span>
            <span className="home-shelf-copy">
              <span className="home-shelf-label">Albums</span>
              <span className="home-shelf-count">{formatShelfCount(shelfCounts.albums, 'album', 'albums')}</span>
            </span>
            <span className="home-shelf-go" aria-hidden="true">›</span>
          </button>
          <button type="button" className="home-shelf" onClick={() => goView('artists')}>
            <span className="home-shelf-icon" aria-hidden="true"><ShelfGlyph kind="artists" /></span>
            <span className="home-shelf-copy">
              <span className="home-shelf-label">Artists</span>
              <span className="home-shelf-count">{formatShelfCount(shelfCounts.artists, 'artist', 'artists')}</span>
            </span>
            <span className="home-shelf-go" aria-hidden="true">›</span>
          </button>
          <button type="button" className="home-shelf home-shelf--shop" onClick={() => goView('discovery')}>
            <span className="home-shelf-icon" aria-hidden="true"><ShelfGlyph kind="shop" /></span>
            <span className="home-shelf-copy">
              <span className="home-shelf-label">Record Shop</span>
              <span className="home-shelf-count">Find records</span>
            </span>
            <span className="home-shelf-go" aria-hidden="true">›</span>
          </button>
          {!libraryEmpty && (
            <button
              type="button"
              className="home-shelf"
              onClick={() => dispatch({ type: 'VIEW_SMART_PLAYLIST', id: 'recently-added' })}
            >
              <span className="home-shelf-icon" aria-hidden="true"><ShelfGlyph kind="recent" /></span>
              <span className="home-shelf-copy">
                <span className="home-shelf-label">Recently Added</span>
                <span className="home-shelf-count">New arrivals</span>
              </span>
              <span className="home-shelf-go" aria-hidden="true">›</span>
            </button>
          )}
        </nav>
      </header>

      {libraryEmpty && (
        <section className="home-welcome-empty" aria-label="Start your library">
          <div className="home-welcome-empty-mark" aria-hidden="true">
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
              <circle cx="20" cy="20" r="18" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="20" cy="20" r="6" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="20" cy="20" r="2" fill="currentColor" />
            </svg>
          </div>
          <h2 className="home-welcome-empty-title">The shelves are empty</h2>
          <p className="home-welcome-empty-body">
            Drop a folder of music onto this window, or import files to start a library.
            JakeTunes will take it from there.
          </p>
          <div className="home-welcome-empty-actions">
            <button type="button" className="home-featured-btn home-featured-btn--primary" onClick={openImport}>
              Import music…
            </button>
            <button type="button" className="home-featured-btn" onClick={() => goView('discovery')}>
              Browse the Record Shop
            </button>
          </div>
        </section>
      )}

      {/* ── 4.4.33: Featured Album hero — "Today's Pick from Your Library" ── */}
      {featuredAlbum && (
        <section className="home-featured">
          {artHashForKey(featuredAlbum.key) && (
            <div className="home-featured-bleed" aria-hidden="true">
              {/* Blurred backdrop — a 320px thumb blurs identically to the full art. */}
              <AlbumArtImage hash={artHashForKey(featuredAlbum.key)!} alt="" size={320} />
            </div>
          )}
          <div
            className="home-featured-art"
            onClick={playFeatured}
            onKeyDown={activateOnKey(playFeatured)}
            role="button"
            tabIndex={0}
            aria-label={`Play ${featuredAlbum.album} by ${featuredAlbum.artist}`}
            title={`Play ${featuredAlbum.album} by ${featuredAlbum.artist}`}
          >
            {artHashForKey(featuredAlbum.key) ? (
              <AlbumArtImage
                hash={artHashForKey(featuredAlbum.key)!}
                alt={featuredAlbum.album}
                priority
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
            <div className="home-featured-label">Today's pick</div>
            <h2 className="home-featured-title">{featuredAlbum.album}</h2>
            <div className="home-featured-artist">{featuredAlbum.artist}</div>
            <div className="home-featured-meta">
              {featuredAlbum.tracks.length} track{featuredAlbum.tracks.length === 1 ? '' : 's'}
              {featuredAlbum.year && <> · {featuredAlbum.year}</>}
              {featuredAlbum.totalPlays > 0 && <> · {featuredAlbum.totalPlays.toLocaleString()} play{featuredAlbum.totalPlays === 1 ? '' : 's'}</>}
            </div>
            <div className="home-featured-actions">
              <button type="button" className="home-featured-btn home-featured-btn--primary" onClick={playFeatured}>
                <svg width="12" height="12" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><path d="M10 7v18l16-9z" /></svg>
                Play Album
              </button>
              <button
                type="button"
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

      {/* ── 4.5: Your Mixes — Spotify-style temporary vibe / daily mixes (below the hero) ── */}
      <MadeForYou />

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
              <div className="home-stat-value home-stat-value--name" title={stats.topArtist}>{stats.topArtist}</div>
              <div className="home-stat-label">Top Artist</div>
            </div>
          )}
          {stats.topGenre && (
            <div className="home-stat">
              <div className="home-stat-value home-stat-value--name" title={stats.topGenre}>{stats.topGenre}</div>
              <div className="home-stat-label">Top Genre</div>
            </div>
          )}
        </section>
      )}

      {/* ── Listening Memory (brain #1) — habits from the local play log:
            streak, golden hour, this week's artist, comebacks, binges —
            plus Music Man's latest observation about the listener. ──── */}
      {memory && memory.insights.totals.plays > 0 && (
        <section className="home-section home-memory">
          <div className="home-section-header">
            <h2 className="home-section-title">Listening Memory</h2>
            <span className="home-memory-since">
              {memory.insights.totals.daysActive} active day{memory.insights.totals.daysActive === 1 ? '' : 's'}
            </span>
          </div>
          <div className="home-stats home-stats--memory">
            <div className="home-stat">
              <div className="home-stat-value">
                {memory.insights.streak.currentDays > 0
                  ? `${memory.insights.streak.currentDays} day${memory.insights.streak.currentDays === 1 ? '' : 's'}`
                  : '—'}
              </div>
              <div className="home-stat-label">Current Streak</div>
              <div className="home-stat-sub">{memory.insights.streak.bestDays > 1 ? `Best: ${memory.insights.streak.bestDays} days` : ' '}</div>
            </div>
            {memory.insights.clock.peakHourLabel && (
              <div className="home-stat">
                <div className="home-stat-value">{memory.insights.clock.peakHourLabel}</div>
                <div className="home-stat-label">Golden Hour</div>
                <div className="home-stat-sub">{' '}</div>
              </div>
            )}
            {memory.insights.clock.peakWeekdayLabel && (
              <div className="home-stat">
                <div className="home-stat-value">{memory.insights.clock.peakWeekdayLabel}</div>
                <div className="home-stat-label">Biggest Day</div>
                <div className="home-stat-sub">{' '}</div>
              </div>
            )}
            {memory.insights.topArtists7d[0] && (
              <div className="home-stat">
                <div className="home-stat-value home-stat-value--name" title={memory.insights.topArtists7d[0].artist}>{memory.insights.topArtists7d[0].artist}</div>
                <div className="home-stat-label">This Week</div>
                <div className="home-stat-sub">{memory.insights.topArtists7d[0].plays} play{memory.insights.topArtists7d[0].plays === 1 ? '' : 's'}</div>
              </div>
            )}
            {memory.insights.comeback && (
              <div className="home-stat">
                <div className="home-stat-value home-stat-value--name" title={memory.insights.comeback.artist}>{memory.insights.comeback.artist}</div>
                <div className="home-stat-label">Comeback</div>
                <div className="home-stat-sub">{memory.insights.comeback.gapDays} days away</div>
              </div>
            )}
            {memory.insights.binge && (
              <div className="home-stat">
                <div className="home-stat-value home-stat-value--name" title={memory.insights.binge.artist}>{memory.insights.binge.artist}</div>
                <div className="home-stat-label">Binge Record</div>
                <div className="home-stat-sub">{memory.insights.binge.plays} in one day</div>
              </div>
            )}
          </div>
          {/* Music Man's notebook was here — removed 2026-07-14. LLM prose
              can't be safely clipped (a "sentence" boundary landed inside a
              quoted song title). The full notebook lives in Music Man's view;
              the dashboard shows numbers, not essays. */}
        </section>
      )}

      {/* ── Rediscover (Brain) — owned gems you've overlooked, in his voice ── */}
      {rediscovery && rediscovery.length > 0 && (
        <section className="home-section">
          <div className="home-section-header">
            <h2 className="home-section-title">Rediscover</h2>
            <span className="home-section-source">Music Man</span>
          </div>
          <div className="home-card-row" role="list" ref={rediscoverRowRef}>
            {rediscovery.map((pick) => {
              const hash = artHashForKey(`${pick.artist}|||${pick.album}`)
              return (
                <div
                  key={`${pick.artist}|||${pick.album}`}
                  className="home-rediscover-card"
                  role="listitem"
                  title={`${pick.artist}${pick.album ? ` — ${pick.album}` : ''}\nYou own ${pick.ownedTracks}, played ${pick.plays}× here`}
                >
                  <div className="home-rediscover-art" onClick={() => playRediscovery(pick)} onKeyDown={activateOnKey(() => playRediscovery(pick))} role="button" tabIndex={0} title="Play" aria-label={`Play ${pick.artist}`}>
                    {hash ? (
                      <AlbumArtImage hash={hash} alt={pick.artist} size={320} onLoad={(e) => e.currentTarget.classList.add('home-album-art-loaded')} />
                    ) : (
                      <div className="home-album-art-placeholder home-rediscover-art-ph">{pick.artist.split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('')}</div>
                    )}
                    <div className="home-rediscover-play" aria-hidden="true">▶</div>
                  </div>
                  <button
                    type="button"
                    className="home-rediscover-artist"
                    onClick={() => { requestDrillIn('artist', pick.artist); dispatch({ type: 'SET_VIEW', view: 'artists' }) }}
                  >{pick.artist}</button>
                  <div className="home-rediscover-pitch">“{pick.reason}”</div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* ── Recently Added ───────────────────────────────────────────────── */}
      {recentAlbums.length > 0 && (
      <section className="home-section">
        <div className="home-section-header">
          <h2 className="home-section-title">Recently Added</h2>
          <button
            type="button"
            className="home-section-more"
            onClick={() => dispatch({ type: 'VIEW_SMART_PLAYLIST', id: 'recently-added' })}
          >
            See All
          </button>
        </div>
          <div className="home-card-row" role="list" ref={recentRowRef}>
            {recentAlbums.map((card) => {
              const hash = artHashForKey(card.key)
              const flashing = flashedKey === card.key
              const openAlbum = () => dispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: card.key })
              return (
                <div
                  key={card.key}
                  className={`home-album-card${flashing ? ' is-playing-flash' : ''}`}
                  role="listitem"
                  tabIndex={0}
                  onClick={openAlbum}
                  onKeyDown={activateOnKey(openAlbum)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    playAlbum(card)
                  }}
                  title={`${card.artist} — ${card.album}\nClick opens the album. Right-click plays it.`}
                >
                  <div className="home-album-art">
                    {hash ? (
                      <AlbumArtImage
                        hash={hash}
                        alt={card.album}
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
      </section>
      )}

      {/* ── Top Artists ──────────────────────────────────────────────────── */}
      {topArtists.length > 0 && (
        <section className="home-section">
          <div className="home-section-header">
            <h2 className="home-section-title">Top Artists</h2>
            <button
              type="button"
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
                  tabIndex={0}
                  onClick={() => {
                    requestDrillIn('artist', card.name)
                    dispatch({ type: 'SET_VIEW', view: 'artists' })
                  }}
                  onKeyDown={activateOnKey(() => {
                    requestDrillIn('artist', card.name)
                    dispatch({ type: 'SET_VIEW', view: 'artists' })
                  })}
                  title={`${card.name}\n${card.totalPlays.toLocaleString()} plays across ${card.trackCount} track${card.trackCount === 1 ? '' : 's'}`}
                >
                  <div className="home-artist-art">
                    {hash ? (
                      <AlbumArtImage
                        hash={hash}
                        alt={card.name}
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

      {/* ── Placement audit 9/2: Live Near You + At Your Venues + On the Horizon
            were three headed bands for one idea — the longest stretch of the
            page. Now one "Shows" band with three rows. Each row keeps its own
            data, cap, and ref; only the chrome merged. ─────────────────── */}
      {((tourDates !== null && tourDates.length > 0) || (venueShows !== null && venueShows.length > 0) || (upcoming !== null && upcoming.length > 0)) && (
        <section className="home-section home-section--shows">
          <div className="home-section-header">
            <h2 className="home-section-title">Shows</h2>
          </div>
        {/* ── 4.4.32: Tour Dates (Bandsintown, 100% library-personalized) ──── */}
        {tourDates !== null && tourDates.length > 0 && (
          <div className="home-shows-group">
            <div className="home-section-subhead">
              <h3 className="home-section-subtitle">Live Near You</h3>
              <span className="home-section-source">via Bandsintown</span>
            </div>
            <div className="home-card-row" role="list" ref={tourDatesRowRef}>
              {tourRuns.slice(0, 20).map(({ ev, nights, lastDate }, i) => {
                const d = new Date(ev.date)
                const yearSuffix = d.getFullYear() !== new Date().getFullYear() ? `, ${d.getFullYear()}` : ''
                return (
                  <div
                    key={`${ev.url}-${i}`}
                    className="home-tour-card"
                    role="listitem"
                    tabIndex={0}
                    onClick={() => ev.url && openLink(ev.url)}
                    onKeyDown={activateOnKey(() => { if (ev.url) openLink(ev.url) })}
                    title={`${ev.artist} — ${ev.venue}\n${ev.city}\n${nights > 1 && lastDate
                      ? `${nights} nights: ${d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })} – ${new Date(lastDate).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}`
                      : d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}\nOpen in Bandsintown`}
                  >
                    <div className="home-tour-date">
                      <div className="home-tour-date-month">{d.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}</div>
                      <div className={`home-tour-date-day${nights > 1 ? ' home-tour-date-day--range' : ''}`}>
                        {d.getDate()}{nights > 1 && lastDate ? `–${new Date(lastDate).getDate()}` : ''}
                      </div>
                      {nights > 1 && <div className="home-tour-date-nights">{nights} nights</div>}
                    </div>
                    <div className="home-tour-info">
                      <div className="home-tour-artist">{ev.artist}</div>
                      <div className="home-tour-venue">{ev.venue}</div>
                      <div className="home-tour-city">{ev.city}{typeof ev.miles === 'number' && <span className="home-tour-miles"> · {ev.miles < 1 ? '<1' : Math.round(ev.miles)} mi</span>}{yearSuffix && <span className="home-tour-year"> · {d.getFullYear()}</span>}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── 2026-08-08: At Your Venues — the rooms Jake actually goes to,
              regardless of whether the artist is in his library. Library
              artists carry a mark so the "don't miss this" signal survives
              inside the discovery lane. ──────────────────────────────────── */}
        {venueShows !== null && venueShows.length > 0 && (
          <div className="home-shows-group">
            <div className="home-section-subhead">
              <h3 className="home-section-subtitle">At Your Venues</h3>
              <span className="home-section-source">Brooklyn rooms</span>
            </div>
            <div className="home-card-row" role="list" ref={venueRowRef}>
              {venueShows.slice(0, 40).map((s, i) => {
                const d = new Date(s.date)
                return (
                  <div
                    key={`${s.venueKey}-${s.date}-${i}`}
                    className={`home-tour-card${s.known ? ' home-tour-card--known' : ''}`}
                    role="listitem"
                    tabIndex={0}
                    onClick={() => s.url && openLink(s.url)}
                    onKeyDown={activateOnKey(() => { if (s.url) openLink(s.url) })}
                    title={`${s.artist} — ${s.venue}\n${d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}${s.known ? '\nIn your library' : ''}`}
                  >
                    <div className="home-tour-date">
                      <div className="home-tour-date-month">{d.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}</div>
                      <div className="home-tour-date-day">{d.getDate()}</div>
                    </div>
                    <div className="home-tour-info">
                      <div className="home-tour-artist">
                        {s.artist}
                        {s.known && <span className="home-venue-known" title="In your library"> ★</span>}
                      </div>
                      <div className="home-tour-venue">{s.venue}</div>
                      <div className="home-tour-city">{s.city}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── 4.4.34: Upcoming Releases (MusicBrainz, library-personalized) ── */}
        {upcoming !== null && upcoming.length > 0 && (
          <div className="home-shows-group">
            <div className="home-section-subhead">
              <h3 className="home-section-subtitle">On the Horizon</h3>
              <span className="home-section-source">via MusicBrainz</span>
            </div>
            <div className="home-card-row" role="list" ref={upcomingRowRef}>
              {upcoming.map((item, i) => (
                <div
                  key={`${item.mbid}-${i}`}
                  className="home-upcoming-card"
                  role="listitem"
                  tabIndex={0}
                  onClick={() => openLink(`https://musicbrainz.org/release-group/${item.mbid}`)}
                  onKeyDown={activateOnKey(() => openLink(`https://musicbrainz.org/release-group/${item.mbid}`))}
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
          </div>
        )}
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
                tabIndex={0}
                onClick={() => openLink(item.link)}
                onKeyDown={activateOnKey(() => openLink(item.link))}
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
                  {item.artist && (
                    // A miss stays VISIBLE (muted disc, honest tooltip) —
                    // a button that silently vanishes reads as broken.
                    <button
                      type="button"
                      className={`home-release-play${preview.playingId === item.link ? ' home-release-play--on' : ''}${releasePreviews.get(item.link) === null ? ' home-release-play--none' : ''}`}
                      title={releasePreviews.get(item.link) === null ? 'No preview available for this album' : preview.playingId === item.link ? 'Stop' : 'Preview a song from this album'}
                      onClick={(e) => void previewRelease(e, item)}
                    >
                      {preview.playingId === item.link ? <PauseIcon /> : <PlayIcon />}
                    </button>
                  )}
                </div>
                <div className="home-album-info">
                  <div className="home-album-title">{item.title}</div>
                  {item.artist && <div className="home-album-artist">{item.artist}</div>}
                  <div className="home-release-meta">{[item.genre, formatDate(item.pubDate)].filter(Boolean).join(' · ')}</div>
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
                tabIndex={0}
                onClick={() => openLink(item.link)}
                onKeyDown={activateOnKey(() => openLink(item.link))}
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
