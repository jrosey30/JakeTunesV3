import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import { useRegularLibraryTracks } from '../hooks/useRegularLibraryTracks'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { buildNormalizedArtworkIndex, lookupArtwork, queueArtworkResolutions } from '../utils/artworkLookup'
import { prefetchAlbumArtHashes } from '../utils/artworkPrefetch'
import AlbumArtImage from '../components/AlbumArtImage'
import { canonicalArtist, isSameArtist, artistIdentityKey, subscribeAliases, getAliasVersion } from '../utils/artistAlias'
import type { RelatedArtist } from '../types'
import ScrollTopButton from '../components/ScrollTopButton'
import { albumKeyFromStrings } from '../utils/albumKey'
import { albumDetailBackLabel } from '../utils/albumBackLabel'
import { useNavigation } from '../context/NavigationContext'
import { sortAlbumTracks } from '../utils/albumTrackOrder'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import type { Track } from '../types'
import '../styles/artist-detail.css'
import { addToPlaylistEntry } from '../utils/playlistMenu'

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

interface DiscographyAlbum {
  title: string
  year: string
  tracks: { title: string; position: number }[]
}

/**
 * 4.5.0-45 — "Personas". An artist like Paul McCartney has multiple
 * project tags in the library ("Paul McCartney", "Paul McCartney &
 * Wings"). Personas split the page by tag so the story of each project
 * is told separately: solo McCartney, Wings, etc. Each persona carries
 * its own album group AND its own MusicBrainz discography fetch.
 */
interface Persona {
  /** Raw artist tag as it appears in track metadata. The display label
   *  and the MusicBrainz lookup key. */
  name: string
  /** Human-friendly year range for this persona's tracks. */
  yearRange: string
  albums: AlbumGroup[]
}

/**
 * Normalize a track title for cross-source matching. Strips parens
 * (Remastered), (Deluxe), (feat. X), trailing " - 2019 Mix" suffixes,
 * then collapses non-alphanumeric so canonical → library matching
 * tolerates the small label/release variants that otherwise sink the
 * match rate. Conservative — leans toward false-misses over false-hits
 * since a wrong "owned" badge would be more confusing than missing one.
 */
function normTitle(s: string): string {
  return s.toLowerCase()
    // 4.5.0-74 — expand common title-word abbreviations BEFORE stripping
    // punctuation, so "Dr. Robert" matches "Doctor Robert", "St. Anger"
    // matches "Saint Anger", "Rock & Roll" matches "Rock and Roll".
    // Pre-fix, "Dr. Robert" normalized to "drrobert" and "Doctor Robert"
    // to "doctorrobert" — different strings, owned-match failed, the
    // track Jake was literally playing rendered as not-owned in the
    // discography. Match runs in both directions because both sides
    // route through this same function.
    .replace(/\bdr\.?\s+/g, 'doctor ')
    .replace(/\bmr\.?\s+/g, 'mister ')
    .replace(/\bms\.?\s+/g, 'miss ')
    .replace(/\bst\.?\s+/g, 'saint ')
    .replace(/\bpt\.?\s+/g, 'part ')
    .replace(/\bft\.?\s+/g, 'featuring ')
    .replace(/\bfeat\.?\s+/g, 'featuring ')
    .replace(/\bvs\.?\s+/g, 'versus ')
    .replace(/\bno\.?\s+(\d)/g, 'number $1')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s*\((?:feat\.?|featuring|with|prod\.?|produced by)[^)]+\)/g, '')
    .replace(/\s*\[(?:feat\.?|featuring|with)[^\]]+\]/g, '')
    .replace(/\s*\((?:remaster(?:ed)?|deluxe|bonus|live|single version|album version|edit|mono|stereo|reissue|expanded|remix|alternate|demo)[^)]*\)/g, '')
    .replace(/\s+-\s+(?:remaster(?:ed)?|deluxe|bonus|live|single version|album version|edit|mono|stereo|reissue|expanded|remix|alternate|demo)[^-]*$/g, '')
    .replace(/[^a-z0-9]+/g, '')
}

// Related artists cached per canonical name across visits (main caches a day
// too; this avoids even the round-trip on re-open).
const relatedArtistsCache: Record<string, RelatedArtist[]> = {}

// Spotify-style release-type bucket, inferred from the title. MusicBrainz's
// types are accurate but the user's owned titles ("Past Masters, Vol. 1") don't
// reliably match MB's ("Past Masters · Volume One"), so classifying by title is
// the robust path — covers the common naming and needs no extra lookups.
function releaseType(title: string): 'album' | 'ep' | 'single' | 'compilation' | 'live' {
  const t = (title || '').toLowerCase()
  if (/\blive\b|unplugged|in concert|live at|live from|live in|at the bbc|bbc sessions|live!/.test(t)) return 'live'
  if (/past masters|greatest hits|\bbest of\b|the best of|\bhits\b|anthology|\bcollection\b|rarities|b-sides|b sides|\bessential\b|the very best|\bsingles\b|love songs|ballads|mixtape|compilation/.test(t)) return 'compilation'
  if (/\bep\b|-\s*ep$|\(ep\)/.test(t)) return 'ep'
  if (/-\s*single$|\(single\)|\bsingle\b/.test(t)) return 'single'
  return 'album'
}
// Display sections, in order. index 0=albums, 1=singles/eps, 2=comps, 3=live.
const DISCO_GROUP_LABELS = ['Albums', 'Singles & EPs', 'Compilations', 'Live']

function relationLabel(rel: string): string {
  switch (rel) {
    case 'band': return 'band'
    case 'member': return 'member'
    case 'sideProject': return 'side project'
    case 'bandmate': return 'bandmate'
    case 'collaborator': return 'collab'
    case 'similar': return 'similar'
    default: return rel || 'related'
  }
}

export default function ArtistDetailView() {
  const { state: lib, dispatch } = useLibrary()
  // A full live concert is its OWN thing, not an album of the artist — exclude
  // its tracks from this artist's album grouping (they live in Live Concerts).
  const regularTracks = useRegularLibraryTracks(lib.tracks)
  const { dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()
  const [albumCtx, setAlbumCtx] = useState<{ x: number; y: number; name: string; tracks: Track[] } | null>(null)
  const albumCtxItems = useCallback((name: string, albumTracks: Track[]): MenuEntry[] => {
    const ordered = sortAlbumTracks(albumTracks)
    return [
      { label: `Play "${name}"`, onClick: () => { if (ordered.length) playTrack(ordered[0], ordered, 0, undefined, true) } },
      { label: 'Shuffle', onClick: () => { const s = [...ordered].sort(() => Math.random() - 0.5); if (s.length) playTrack(s[0], s, 0, undefined, true) } },
      { separator: true as const },
      { label: 'Play Next', onClick: () => pbDispatch({ type: 'PLAY_NEXT', tracks: ordered }) },
      { label: 'Add to Up Next', onClick: () => pbDispatch({ type: 'ADD_TO_QUEUE', tracks: ordered }) },
      addToPlaylistEntry(ordered, lib.playlists, (pid, ids) => dispatch({ type: 'ADD_TRACKS_TO_PLAYLIST', playlistId: pid, trackIds: ids })),
    ]
  }, [playTrack, pbDispatch])
  const artist = lib.activeArtist || ''

  // Contextual back navigation. Artist detail is reachable from Artists,
  // the Bandcamp Store, and Search — mirror AlbumDetailView so "back"
  // returns to wherever the user came from instead of always Artists.
  const { canGoBack, goBack: navBack } = useNavigation()
  const artistReturnView = lib.artistDetailReturnView || 'artists'
  const backLabel = albumDetailBackLabel(artistReturnView)
  // Prefer real history (matches the titlebar ‹ and ⌘[); fall back to the
  // stored return view only when there's nothing to go back to.
  const goBack = useCallback(() => {
    if (canGoBack) navBack()
    else dispatch({ type: 'SET_VIEW', view: artistReturnView })
  }, [canGoBack, navBack, dispatch, artistReturnView])

  // `.artist-detail` is itself the scroll container (overflow-y: auto in
  // artist-detail.css). Persist its scrollTop per-artist so opening an
  // album from a long discography and coming back lands the user where
  // they left off. Keyed by artist name so a different artist's page
  // opens fresh instead of inheriting a stale offset.
  const scrollRef = useRef<HTMLDivElement>(null)
  useScrollPersistence(`artist-detail:${artist}`, scrollRef)

  // 4.5.0-45: Persona-aware aggregation. Match on either `artist` exact
  // OR contributingArtists.includes — canonicalize so "Paul McCartney
  // & Wings" tracks land on the "Paul McCartney" page — then SPLIT by
  // the raw tag so each persona keeps its own discography.
  const aliasVersion = useSyncExternalStore(subscribeAliases, getAliasVersion)
  const personas = useMemo<Persona[]>(() => {
    if (!artist) return []
    const canonicalActive = canonicalArtist(artist)
    // personaName → albumName → AlbumGroup
    const byPersona = new Map<string, Map<string, AlbumGroup>>()
    for (const t of regularTracks) {
      const directMatch = isSameArtist(t.artist || '', canonicalActive)
      const collabMatch = (t.contributingArtists || []).find(x => isSameArtist(x || '', canonicalActive))
      if (!directMatch && !collabMatch) continue
      // Pick the raw tag string to use as the persona label. Prefer the
      // primary `artist` field when it canonicalizes; fall back to the
      // matched contributingArtist string (used for collab tracks).
      const personaName = directMatch ? (t.artist || canonicalActive) : (collabMatch || canonicalActive)
      let albumMap = byPersona.get(personaName)
      if (!albumMap) { albumMap = new Map(); byPersona.set(personaName, albumMap) }
      const name = (t.album || 'Unknown Album').trim()
      const key = name.toLowerCase()
      let g = albumMap.get(key)
      if (!g) {
        g = { name, year: t.year || '', tracks: [] }
        albumMap.set(key, g)
      }
      g.tracks.push(t)
      if (Number(t.year) > Number(g.year)) g.year = t.year || g.year
    }
    // Build Persona[] with per-persona year range + sorted albums.
    const out: Persona[] = []
    for (const [name, albumMap] of byPersona.entries()) {
      const albums = Array.from(albumMap.values()).sort((x, y) => {
        const yx = Number(x.year) || 0
        const yy = Number(y.year) || 0
        return yy - yx
      })
      // Track-level sort inside each album.
      for (const g of albums) {
        g.tracks = sortAlbumTracks(g.tracks)
      }
      let minY = Infinity, maxY = -Infinity
      for (const g of albums) for (const t of g.tracks) {
        const y = Number(t.year)
        if (y > 0 && y < 9999) { if (y < minY) minY = y; if (y > maxY) maxY = y }
      }
      const yearRange = minY !== Infinity && maxY !== -Infinity
        ? (minY === maxY ? `${minY}` : `${minY}–${maxY}`) : ''
      out.push({ name, yearRange, albums })
    }
    // Sort personas: the one matching the canonical name first (the
    // "main" identity), then the rest by earliest year ascending so
    // the timeline reads chronologically beneath it.
    out.sort((a, b) => {
      const aCanonical = isSameArtist(a.name, canonicalActive) && a.name.toLowerCase() === canonicalActive.toLowerCase()
      const bCanonical = isSameArtist(b.name, canonicalActive) && b.name.toLowerCase() === canonicalActive.toLowerCase()
      if (aCanonical && !bCanonical) return -1
      if (bCanonical && !aCanonical) return 1
      // Earliest album year first
      const aMin = a.albums.reduce((m, g) => Math.min(m, Number(g.year) || Infinity), Infinity)
      const bMin = b.albums.reduce((m, g) => Math.min(m, Number(g.year) || Infinity), Infinity)
      return aMin - bMin
    })
    return out
  }, [regularTracks, artist, aliasVersion])

  // Flattened album list — kept for hero stats + genre chips.
  const albums = useMemo<AlbumGroup[]>(
    () => personas.flatMap(p => p.albums),
    [personas]
  )
  const totalTracks = albums.reduce((s, g) => s + g.tracks.length, 0)

  // Derive top genres + active year range for the chips in the hero.
  // These come from the artist's own library tracks (canonical-matched),
  // so they're "what you have by this artist", not the canonical genre.
  const { topGenres, activeYears } = useMemo(() => {
    const genreCount = new Map<string, number>()
    let minYear = Infinity
    let maxYear = -Infinity
    for (const g of albums) {
      for (const t of g.tracks) {
        const genre = (t.genre || '').trim()
        if (genre) genreCount.set(genre, (genreCount.get(genre) || 0) + 1)
        const y = Number(t.year)
        if (y > 0 && y < 9999) {
          if (y < minYear) minYear = y
          if (y > maxYear) maxYear = y
        }
      }
    }
    const genres = [...genreCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([g]) => g)
    const yearRange = minYear !== Infinity && maxYear !== -Infinity
      ? (minYear === maxYear ? `${minYear}` : `${minYear}–${maxYear}`)
      : ''
    return { topGenres: genres, activeYears: yearRange }
  }, [albums])

  // Artist photo via the existing per-artist photo IPC (synology branch).
  // 4.5.0-44: canonicalize before lookup so an alias-merged row (e.g.
  // "Paul McCartney & Wings") still pulls the real Paul McCartney photo
  // / wiki / discography instead of returning empty.
  const lookupName = useMemo(() => canonicalArtist(artist), [artist, aliasVersion])
  const [photoSlug, setPhotoSlug] = useState<string | null>(null)
  useEffect(() => {
    if (!lookupName) return
    let cancelled = false
    window.electronAPI.getArtistImage(lookupName).then(r => {
      if (cancelled) return
      setPhotoSlug(r.ok ? r.slug : null)
    }).catch(() => { /* keep null — UI shows the monogram fallback */ })
    return () => { cancelled = true }
  }, [lookupName])

  // Related-artists graph (associate, not merge): this artist's band(s),
  // bandmates, side projects + key collaborators. The ones you OWN are
  // clickable; the rest show as connections you don't have yet.
  const [related, setRelated] = useState<RelatedArtist[]>(() => relatedArtistsCache[lookupName] || [])
  const [relatedLoading, setRelatedLoading] = useState(false)
  const ownedArtistKeys = useMemo(() => {
    const s = new Set<string>()
    for (const t of lib.tracks) {
      const a = (t.artist || '').trim()
      if (a) s.add(artistIdentityKey(canonicalArtist(a)))
    }
    return s
  }, [lib.tracks, aliasVersion])
  useEffect(() => {
    if (!lookupName) { setRelated([]); return }
    if (relatedArtistsCache[lookupName]) { setRelated(relatedArtistsCache[lookupName]); return }
    let cancelled = false
    setRelatedLoading(true)
    window.electronAPI.getRelatedArtists?.(lookupName).then((r) => {
      if (cancelled) return
      const list = (r?.ok && r.related) ? r.related : []
      relatedArtistsCache[lookupName] = list
      setRelated(list)
    }).catch(() => { /* leave empty */ }).finally(() => { if (!cancelled) setRelatedLoading(false) })
    return () => { cancelled = true }
  }, [lookupName])

  // 4.5: full discography from MusicBrainz (release groups + tracklists).
  // Cached 7 days in main; first call per artist is slow (~15s for 12-
  // album discographies) due to MB's 1 req/sec rate limit. Subsequent
  // visits return instantly.
  // 4.5.0-45: per-persona discography. Fire one MusicBrainz lookup per
  // distinct persona tag in parallel (e.g. "Paul McCartney" + "Paul
  // McCartney & Wings") so each chapter of the artist's career renders
  // its own canonical discography. Keyed by persona name.
  const [discoByPersona, setDiscoByPersona] = useState<Map<string, DiscographyAlbum[] | 'loading' | 'empty'>>(new Map())
  const [expandedAlbumTitle, setExpandedAlbumTitle] = useState<string | null>(null)
  const personaNames = useMemo(() => personas.map(p => p.name).join('|'), [personas])
  useEffect(() => {
    if (personas.length === 0) return
    let cancelled = false
    setExpandedAlbumTitle(null)
    setDiscoByPersona(new Map(personas.map(p => [p.name, 'loading' as const])))
    Promise.all(personas.map(async p => {
      try {
        const r = await window.electronAPI.getArtistDiscography?.(p.name)
        return [p.name, (r?.ok && r.albums?.length) ? r.albums : 'empty' as const] as const
      } catch {
        return [p.name, 'empty' as const] as const
      }
    })).then(results => {
      if (cancelled) return
      const m = new Map<string, DiscographyAlbum[] | 'loading' | 'empty'>()
      for (const [name, value] of results) m.set(name, value)
      setDiscoByPersona(m)
    })
    return () => { cancelled = true }
    // personaNames captures the identity of the set without re-running
    // when an internal album array reference shuffles.
  }, [personaNames]) // eslint-disable-line react-hooks/exhaustive-deps

  // 4.5: normalized-title → library Track map for this artist. Used to
  // compute owned/not-owned per canonical track. Built once per artist
  // change so the per-row lookup in the drill-down is O(1). Same alias-
  // aware matching as the album grouping above.
  const ownedByTitle = useMemo(() => {
    const m = new Map<string, Track>()
    if (!artist) return m
    const canonicalActive = canonicalArtist(artist)
    for (const t of lib.tracks) {
      const matchesArtist = isSameArtist(t.artist || '', canonicalActive) ||
        (t.contributingArtists || []).some(x => isSameArtist(x || '', canonicalActive))
      if (matchesArtist) m.set(normTitle(t.title || ''), t)
    }
    return m
  }, [lib.tracks, artist])

  // Wikipedia summary.
  const [wiki, setWiki] = useState<{ extract: string | null; pageUrl: string | null } | null>(null)
  const [wikiLoading, setWikiLoading] = useState(false)
  useEffect(() => {
    if (!lookupName) return
    let cancelled = false
    setWikiLoading(true)
    setWiki(null)
    window.electronAPI.getArtistWiki(lookupName).then(r => {
      if (cancelled) return
      setWiki({ extract: r.extract, pageUrl: r.pageUrl })
    }).catch(() => { /* leave wiki null */ })
      .finally(() => { if (!cancelled) setWikiLoading(false) })
    return () => { cancelled = true }
  }, [lookupName])

  // Artwork lookup for album tiles. 4.5: routes through lookupArtwork
  // so the cover sticks even when album/artist strings drift between
  // import time and render time ("(Remastered)", "feat.", diacritics).
  const normalizedArtIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])
  // 4.5.0-51: on miss, fire a server-side resolver (deduped per pair)
  // that checks normalized JSON keys + disk-existence and caches the
  // hit via ADD_ARTWORK. Next render hits cleanly.
  const findArtHash = useCallback((artistName: string, albumName: string): string | undefined => {
    return lookupArtwork(lib.artworkMap, normalizedArtIndex, artistName, albumName)
  }, [lib.artworkMap, normalizedArtIndex])

  useEffect(() => {
    const hashes: (string | undefined)[] = []
    const missing: { artist: string; album: string }[] = []
    for (const p of personas) {
      for (const a of p.albums) {
        const hit = findArtHash(p.name, a.name)
        if (hit) hashes.push(hit)
        else if (missing.length < 24) missing.push({ artist: p.name, album: a.name })
      }
    }
    prefetchAlbumArtHashes(hashes.slice(0, 32), 320)
    if (missing.length > 0) queueArtworkResolutions(missing, dispatch)
  }, [personas, lib.artworkMap, normalizedArtIndex, findArtHash, dispatch])

  if (!artist) {
    return (
      <div className="artist-detail">
        <button className="artist-detail-back" onClick={goBack}>{backLabel}</button>
        <div className="artist-detail-empty">No artist selected.</div>
      </div>
    )
  }

  return (
    <div className="artist-detail" ref={scrollRef}>
      <ScrollTopButton targetRef={scrollRef} />
      <button
        className="artist-detail-back"
        onClick={goBack}
      >
        {backLabel}
      </button>

      <header className="artist-detail-hero">
        {/* Banner backdrop: blurred photo at large scale + warm ink
            gradient on top so the foreground text stays readable. */}
        <div
          className="artist-detail-hero-backdrop"
          style={photoSlug
            ? { backgroundImage: `url("artist-image://${photoSlug}.jpg")` }
            : undefined}
        />
        <div className="artist-detail-hero-shade" />
        <div className="artist-detail-hero-inner">
          <div className="artist-detail-photo">
            {photoSlug ? (
              <img
                src={`artist-image://${photoSlug}.jpg`}
                alt=""
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            ) : (
              <div className="artist-detail-monogram" style={{ background: `linear-gradient(135deg, var(--brand-orange, #bb4308), #6f2c08)` }}>
                {/* 4.5.0-72: strip leading "The "/"A "/"An " for the
                    monogram letter so "The Beatles" reads "B" not "T",
                    "A Tribe Called Quest" → "T", "An Awesome Wave" → "A"
                    (Awesome). Falls back to the first character if
                    everything was articles or the artist name is empty. */}
                {(() => {
                  const stripped = artist.trim().replace(/^(the|a|an)\s+/i, '')
                  const ch = (stripped || artist).charAt(0).toUpperCase()
                  return ch || '?'
                })()}
              </div>
            )}
          </div>
          <div className="artist-detail-hero-info">
            <div className="artist-detail-eyebrow">Artist</div>
            <h1 className="artist-detail-name">{artist}</h1>
            <div className="artist-detail-stats">
              <span className="artist-detail-stat">
                <span className="artist-detail-stat-num">{albums.length}</span>
                <span className="artist-detail-stat-label">{albums.length === 1 ? 'album' : 'albums'}</span>
              </span>
              <span className="artist-detail-stat-sep" />
              <span className="artist-detail-stat">
                <span className="artist-detail-stat-num">{totalTracks}</span>
                <span className="artist-detail-stat-label">{totalTracks === 1 ? 'track' : 'tracks'}</span>
              </span>
              {activeYears && (
                <>
                  <span className="artist-detail-stat-sep" />
                  <span className="artist-detail-stat">
                    <span className="artist-detail-stat-num">{activeYears}</span>
                    <span className="artist-detail-stat-label">years</span>
                  </span>
                </>
              )}
            </div>
            {topGenres.length > 0 && (
              <div className="artist-detail-chips">
                {topGenres.map(g => (
                  <span key={g} className="artist-detail-chip">{g}</span>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      <section className="artist-detail-wiki">
        {wikiLoading ? (
          <div className="artist-detail-wiki-loading">
            <span className="artist-detail-wiki-spinner" />
            Looking up Wikipedia…
          </div>
        ) : wiki?.extract ? (
          <div className="artist-detail-wiki-card">
            <div className="artist-detail-wiki-rule" />
            <div className="artist-detail-wiki-label">Biography</div>
            <p className="artist-detail-wiki-extract">{wiki.extract}</p>
            <div className="artist-detail-wiki-actions">
              {wiki.pageUrl && (
                <button
                  type="button"
                  className="artist-detail-wiki-btn"
                  onClick={() => { window.electronAPI.openExternalUrl(wiki.pageUrl!).catch(() => {}) }}
                >
                  <span className="artist-detail-wiki-btn-glyph">W</span>
                  Read on Wikipedia
                  <span className="artist-detail-wiki-btn-arrow">↗</span>
                </button>
              )}
              <button
                type="button"
                className="artist-detail-wiki-btn artist-detail-wiki-btn--ghost"
                onClick={() => { window.electronAPI.openExternalUrl(`https://musicbrainz.org/search?type=artist&query=${encodeURIComponent(artist)}`).catch(() => {}) }}
                title="Find on MusicBrainz"
              >
                MusicBrainz
                <span className="artist-detail-wiki-btn-arrow">↗</span>
              </button>
            </div>
          </div>
        ) : (
          // 4.5.0-66 — empty state with "search anyway" affordances.
          // Pre-fix the backend used to leak Wikipedia's disambiguation
          // page ("Drake may refer to:") into the bio area; now those
          // come through as null extract and land here. Give the user
          // a path to keep looking instead of a dead message.
          <div className="artist-detail-wiki-empty">
            <div className="artist-detail-wiki-empty-text">No biography found for this artist.</div>
            <div className="artist-detail-wiki-actions">
              <button
                type="button"
                className="artist-detail-wiki-btn"
                onClick={() => { window.electronAPI.openExternalUrl(`https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(artist + ' musician')}`).catch(() => {}) }}
              >
                <span className="artist-detail-wiki-btn-glyph">W</span>
                Search Wikipedia
                <span className="artist-detail-wiki-btn-arrow">↗</span>
              </button>
              <button
                type="button"
                className="artist-detail-wiki-btn artist-detail-wiki-btn--ghost"
                onClick={() => { window.electronAPI.openExternalUrl(`https://musicbrainz.org/search?type=artist&query=${encodeURIComponent(artist)}`).catch(() => {}) }}
              >
                MusicBrainz
                <span className="artist-detail-wiki-btn-arrow">↗</span>
              </button>
            </div>
          </div>
        )}
      </section>

      {/* 4.5.0-45: chapters. For a single-persona artist this renders as
          one "Albums in your library" + one "Full discography" — same
          UX as before. For a multi-persona artist (Paul McCartney has
          solo + Wings), each persona becomes its own labeled chapter
          with its own album grid AND its own MusicBrainz discography
          underneath, so the story of the career reads top-to-bottom. */}
      {personas.map(persona => {
        const isMulti = personas.length > 1
        const disco = discoByPersona.get(persona.name)
        const discoLoading = disco === 'loading'
        const discoList = (disco && disco !== 'loading' && disco !== 'empty') ? disco : null
        const discoEmpty = disco === 'empty'
        // Merge MB's discography with the albums you actually OWN. Your library
        // is ground truth: every owned album always appears (MusicBrainz buries
        // A Hard Day's Night / Help! under hundreds of Beatles bootlegs), and
        // any MB "album" that just repackages songs you already own on real
        // albums (the US Capitol comps) drops out. MB still contributes the
        // records you DON'T own, for discovery.
        const ownedDisco: DiscographyAlbum[] = persona.albums.map(g => ({
          title: g.name,
          year: String(g.year || ''),
          tracks: g.tracks.slice()
            .sort((a, b) => (Number(a.trackNumber) || 0) - (Number(b.trackNumber) || 0))
            .map(t => ({ title: t.title, position: Number(t.trackNumber) || 0 })),
        }))
        const ownedAlbumTitles = new Set(ownedDisco.map(a => normTitle(a.title)))
        const ownedTrackTitles = new Set<string>()
        for (const a of ownedDisco) for (const t of a.tracks) ownedTrackTitles.add(normTitle(t.title))
        const mbTitles = new Set((discoList || []).map(a => normTitle(a.title)))
        // Keep MB's CANONICAL tracklist for every kept album — that's what makes
        // the bar read "2 of 12" instead of a misleading "2 / 2". (Earlier this
        // used your owned tracks as the album's total, so owning 2 of From
        // Chaos showed a full green 2/2.) Drop only unowned comps of songs you
        // already have on real albums (e.g. the US Capitol Beatles repackagings).
        const mbKept = (discoList || []).filter(album => {
          if (ownedAlbumTitles.has(normTitle(album.title))) return true   // owned album — keep MB's full tracklist
          const titles = album.tracks.map(t => normTitle(t.title)).filter(Boolean)
          if (titles.length >= 4) {
            const overlap = titles.filter(t => ownedTrackTitles.has(t)).length / titles.length
            if (overlap > 0.5) return false   // a comp of songs you already own → drop
          }
          return true   // an album you don't own → keep for discovery
        })
        // Owned albums MB is missing ENTIRELY (it buried A Hard Day's Night /
        // Help! under bootlegs) → add with your tracklist; no canonical count
        // exists for these, so they read X/X, which is the best we can show.
        const ownedMissing = ownedDisco.filter(a => !mbTitles.has(normTitle(a.title)))
        const mergedDisco: DiscographyAlbum[] = [...mbKept, ...ownedMissing]
          .sort((a, b) => (b.year || '').localeCompare(a.year || ''))
        // Spotify-style sections: Albums → Singles & EPs → Compilations → Live,
        // newest-first within each. Past Masters lands under Compilations.
        const discoGroup = (title: string): number => {
          const ty = releaseType(title)
          return ty === 'album' ? 0 : (ty === 'ep' || ty === 'single') ? 1 : ty === 'compilation' ? 2 : 3
        }
        const groupedDisco = mergedDisco
          .map(album => ({ album, g: discoGroup(album.title) }))
          .sort((a, b) => a.g - b.g || (b.album.year || '').localeCompare(a.album.year || ''))
        // Group the owned-albums grid the same way (Past Masters → Compilations),
        // so it matches the discography below. Sub-headers appear only when the
        // library actually spans more than one type.
        const ownedAlbumGroups = (() => {
          const m = new Map<number, typeof persona.albums>()
          for (const a of persona.albums) {
            const g = discoGroup(a.name)
            const arr = m.get(g)
            if (arr) arr.push(a); else m.set(g, [a])
          }
          return [...m.entries()].sort((a, b) => a[0] - b[0])
        })()
        return (
          <div key={persona.name} className={`artist-detail-chapter ${isMulti ? 'artist-detail-chapter--multi' : ''}`}>
            {isMulti && (
              <div className="artist-detail-chapter-header">
                <div className="artist-detail-chapter-title">{persona.name}</div>
                {persona.yearRange && (
                  <div className="artist-detail-chapter-years">{persona.yearRange}</div>
                )}
              </div>
            )}

            <section className="artist-detail-albums">
              <h2 className="artist-detail-section-title">
                {isMulti ? 'In your library' : 'Albums in your library'}
              </h2>
              {ownedAlbumGroups.map(([g, albums]) => (
                <Fragment key={g}>
                  {ownedAlbumGroups.length > 1 && (
                    <div className="artist-detail-album-subhead">{DISCO_GROUP_LABELS[g]}</div>
                  )}
                  <div className="artist-detail-album-grid">
                {albums.map(album => {
                  const hash = findArtHash(persona.name, album.name)
                  return (
                    <button
                      key={album.name}
                      className="artist-detail-album-card"
                      onClick={() => {
                        dispatch({
                          type: 'VIEW_ALBUM_DETAIL',
                          albumKey: albumKeyFromStrings(persona.name, album.name),
                        })
                      }}
                      onContextMenu={(e) => { e.preventDefault(); setAlbumCtx({ x: e.clientX, y: e.clientY, name: album.name, tracks: album.tracks }) }}
                      title={`Open ${album.name}`}
                    >
                      <div className="artist-detail-album-art">
                        {hash ? (
                          <AlbumArtImage hash={hash} alt={album.name} />
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
                </Fragment>
              ))}
            </section>

            <section className="artist-detail-discography">
              <h2 className="artist-detail-section-title">
                {isMulti ? `Full ${persona.name} discography` : 'Full discography'}
              </h2>
              {discoLoading && mergedDisco.length === 0 && (
                <div className="artist-detail-disco-loading">
                  Loading from MusicBrainz… (first lookup per artist takes ~15s)
                </div>
              )}
              {discoEmpty && mergedDisco.length === 0 && (
                <div className="artist-detail-disco-empty">
                  No canonical discography found for {persona.name}.
                </div>
              )}
              {mergedDisco.length > 0 && (
                <div className="artist-detail-disco-list">
                  {groupedDisco.map(({ album, g }, i) => {
                    const ownedCount = album.tracks.reduce((n, t) => n + (ownedByTitle.has(normTitle(t.title)) ? 1 : 0), 0)
                    const total = album.tracks.length
                    const pct = total > 0 ? Math.round((ownedCount / total) * 100) : 0
                    const expandKey = `${persona.name}|||${album.title}`
                    const expanded = expandedAlbumTitle === expandKey
                    const fullyOwned = ownedCount === total && total > 0
                    const showHead = i === 0 || groupedDisco[i - 1].g !== g
                    return (
                      <Fragment key={expandKey}>
                        {showHead && <div className="artist-detail-disco-subhead">{DISCO_GROUP_LABELS[g]}</div>}
                        <div className={`artist-detail-disco-album ${expanded ? 'artist-detail-disco-album--expanded' : ''} ${fullyOwned ? 'artist-detail-disco-album--owned' : ''}`}>
                        <button
                          className="artist-detail-disco-album-header"
                          onClick={() => setExpandedAlbumTitle(expanded ? null : expandKey)}
                          title={`${ownedCount} of ${total} tracks in your library`}
                        >
                          <span className="artist-detail-disco-album-chev">{expanded ? '▼' : '▸'}</span>
                          <span className="artist-detail-disco-album-title">{album.title}</span>
                          <span className="artist-detail-disco-album-year">{album.year || '—'}</span>
                          <span className="artist-detail-disco-album-count">{ownedCount} / {total}</span>
                          <span className="artist-detail-disco-album-bar">
                            <span className="artist-detail-disco-album-bar-fill" style={{ width: `${pct}%` }} />
                          </span>
                        </button>
                        {expanded && (
                          <ol className="artist-detail-disco-tracks">
                            {album.tracks.map(ct => {
                              const owned = ownedByTitle.get(normTitle(ct.title))
                              return (
                                <li
                                  key={`${ct.position}-${ct.title}`}
                                  className={`artist-detail-disco-track ${owned ? 'artist-detail-disco-track--owned' : 'artist-detail-disco-track--missing'}`}
                                  onClick={() => { if (owned) playTrack(owned, [owned], 0, undefined, true) }}
                                  title={owned ? 'In your library — click to play' : 'Not in your library'}
                                >
                                  <span className="artist-detail-disco-track-num">{ct.position}</span>
                                  <span className="artist-detail-disco-track-dot" />
                                  <span className="artist-detail-disco-track-title">{ct.title}</span>
                                </li>
                              )
                            })}
                          </ol>
                        )}
                        </div>
                      </Fragment>
                    )
                  })}
                </div>
              )}
            </section>
          </div>
        )
      })}

      {/* Related artists — at the very bottom of the page (after the full
          discography), so the page leads with the artist's own music. */}
      {(related.length > 0 || relatedLoading) && (
        <section className="artist-detail-related artist-detail-related--bottom">
          <div className="artist-detail-related-head">Related artists</div>
          {relatedLoading && related.length === 0 ? (
            <div className="artist-detail-related-loading">Finding connections…</div>
          ) : (
            <div className="artist-detail-related-row">
              {related.map((r) => {
                const owned = ownedArtistKeys.has(artistIdentityKey(canonicalArtist(r.name)))
                return (
                  <button
                    key={r.name}
                    className={`artist-detail-related-chip ${owned ? 'is-owned' : 'is-unowned'}`}
                    onClick={() => { if (owned) dispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: canonicalArtist(r.name) }) }}
                    disabled={!owned}
                    title={owned ? `Go to ${r.name}` : `${r.name} — not in your library yet`}
                  >
                    <span className="artist-detail-related-name">{r.name}</span>
                    <span className="artist-detail-related-rel">{relationLabel(r.relation)}</span>
                  </button>
                )
              })}
            </div>
          )}
        </section>
      )}
      {albumCtx && (
        <ContextMenu x={albumCtx.x} y={albumCtx.y} items={albumCtxItems(albumCtx.name, albumCtx.tracks)} onClose={() => setAlbumCtx(null)} />
      )}
    </div>
  )
}
