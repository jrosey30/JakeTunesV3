import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type React from 'react'
import { useDelayedFlag } from '../hooks/useDelayedFlag'
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
import { addToPlaylistEntry, addToIpodPoolEntry, queueMenuEntries } from '../utils/playlistMenu'
import { setAlbumDragPayload } from '../utils/trackDrag'
import { normTitle } from '../utils/normTitle'
import { classifyRelease, RELEASE_KIND_LABEL, type ReleaseKind } from '../../common/release-kind'
import { collectAlbumFacts, groupByReleaseKind, releaseKindForRows, releaseKindRank } from '../../common/release-sections'
import { subscribeReleaseKinds, getReleaseKindsSnapshot, refreshReleaseKinds, foldName } from '../releaseKinds'
import { subscribeLiveSets, getLiveSetsSnapshot } from '../liveSets'
import { setConcertKey } from '../concertNav'
import { declaredConcerts, concertTrackIds } from '../../common/concert-meta'
import { withoutConcertTracks, concertsByPersona, withLiveWall, type LiveWallTile } from '../../common/artist-live-wall'
import ConcertPosterTile from '../components/ConcertPosterTile'
import { usePlaysElsewhere } from '../playsElsewhere'
import { playsEverywhere } from '../../common/plays-elsewhere'
import { useArtistProfile } from '../artistProfile'
import {
  topSongs, mostPlayedRecord, earliestAdded, monthYear, dayMonthYear, clock, lengthLabel, plural,
  RELEASE_KIND_SINGULAR, heroEyebrow, heroNameSize, writtenFrom,
} from '../../common/artist-page'
import MemberTile from '../components/artist/MemberTile'
import MoreFromList, { type MoreFromRelease } from '../components/artist/MoreFromList'
import { albumArtUrl } from '../artRevision'

// The artist page (rebuilt 2026-10-20 to Jake's approved design). Reached from
// ArtistsView (and Search / the stores / a member's "Solo artist" link) via a
// VIEW_ARTIST_DETAIL dispatch. Top to bottom:
//   - header: the band photo full-bleed on the right, fading into ink; eyebrow
//     (origin · since), the name, a one-line description, stats, Play / Shuffle
//   - About: homemini's pre-built bio (lede + body, every fact sourced) beside
//     the facts panel. No profile yet (404) or homemini away with nothing
//     cached → the validated Wikipedia summary, as before, with no members
//   - "Your <Artist>": top-5 songs (plays everywhere) + the most played record
//   - Members: clear face photos, legal names, solo links; Jake can set a photo
//   - Discography: Albums / EPs & Singles (/ Compilations) rows, newest first,
//     kinds from release-kinds; then "More from <Artist>" (MusicBrainz, only
//     when the identity is confirmed), collapsed
//   - Live: every full live set as its poster
//   - Related artists
// Personas (Paul McCartney / Paul McCartney & Wings) keep their own chapters
// inside the Discography, each with its own MusicBrainz lookup.

interface AlbumGroup {
  name: string
  year: number | string
  tracks: Track[]
}

interface DiscographyAlbum {
  title: string
  year: string
  tracks: { title: string; position: number }[]
  /** MusicBrainz release-group type (main's discography fetch); absent on owned-only rows and old caches. */
  mb?: { primaryType?: string; secondaryTypes?: string[] }
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

/** The Discography's rows. EPs and singles share one ("EPs & Singles"); live sets are the Live wall. */
type RowKey = 'album' | 'eps' | 'compilation'
type DiscoFilter = 'all' | RowKey | 'live'
const ROW_KINDS: Record<RowKey, ReleaseKind[]> = { album: ['album'], eps: ['ep', 'single'], compilation: ['compilation'] }
const ROW_LABEL: Record<RowKey, string> = { album: RELEASE_KIND_LABEL['album'], eps: 'EPs & Singles', compilation: RELEASE_KIND_LABEL['compilation'] }

type WallTile = LiveWallTile<ReturnType<typeof declaredConcerts>[number], AlbumGroup> & { persona: string }

// Related artists cached per canonical name across visits (main caches a day
// too; this avoids even the round-trip on re-open).
const relatedArtistsCache: Record<string, RelatedArtist[]> = {}

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

const shuffled = <T,>(xs: readonly T[]): T[] => {
  const a = xs.slice()
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a
}

function PlayGlyph() {
  return <svg width="10" height="12" viewBox="0 0 14 16" aria-hidden="true"><path d="M1 1.5v13l12-6.5z" fill="currentColor" /></svg>
}
function ShuffleGlyph() {
  return (
    <svg width="13" height="12" viewBox="0 0 18 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 3h3.5c3 0 4.5 10 8 10H17M14 10.5l3 2.5-3 2.5M1 13h3.5c1.5 0 2.4-2.4 3.2-4.6M17 3h-4.5c-1.2 0-2 1.3-2.7 3M14 .5 17 3l-3 2.5" />
    </svg>
  )
}

export default function ArtistDetailView() {
  const { state: lib, dispatch } = useLibrary()
  // A full live concert is its OWN thing, not an album of the artist — exclude
  // its tracks from this artist's album grouping; it shows once, as its
  // poster on the Live wall below (and in Live Concerts).
  const regularTracks = useRegularLibraryTracks(lib.tracks)
  const { dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()
  const elsewhere = usePlaysElsewhere()
  const playsOf = useCallback((t: Track) => playsEverywhere(t, elsewhere), [elsewhere])
  const [albumCtx, setAlbumCtx] = useState<{ x: number; y: number; name: string; tracks: Track[] } | null>(null)
  const playQueue = useCallback((q: Track[]) => { if (q.length) playTrack(q[0], q, 0, undefined, true) }, [playTrack])
  const albumCtxItems = useCallback((name: string, albumTracks: Track[]): MenuEntry[] => {
    const ordered = sortAlbumTracks(albumTracks)
    return [
      { label: `Play "${name}"`, onClick: () => playQueue(ordered) },
      { label: 'Shuffle', onClick: () => playQueue(shuffled(ordered)) },
      { separator: true as const },
      ...queueMenuEntries(ordered, pbDispatch),
      addToPlaylistEntry(ordered, lib.playlists, (pid, ids) => dispatch({ type: 'ADD_TRACKS_TO_PLAYLIST', playlistId: pid, trackIds: ids })),
      addToIpodPoolEntry(ordered),
    ]
  }, [playQueue, pbDispatch, lib.playlists, dispatch])
  const artist = lib.activeArtist || ''

  // Contextual back navigation. Artist detail is reachable from Artists,
  // the Bandcamp Store, and Search — mirror AlbumDetailView so "back"
  // returns to wherever the user came from instead of always Artists.
  const { canGoBack, goBack: navBack } = useNavigation()
  const artistReturnView = lib.artistDetailReturnView || 'artists'
  const backLabel = albumDetailBackLabel(artistReturnView)
  const goBack = useCallback(() => {
    if (canGoBack) navBack()
    else dispatch({ type: 'SET_VIEW', view: artistReturnView })
  }, [canGoBack, navBack, dispatch, artistReturnView])

  // `.artist-detail` is itself the scroll container. Persist its scrollTop
  // per-artist so opening an album and coming back lands where Jake left off.
  const scrollRef = useRef<HTMLDivElement>(null)
  useScrollPersistence(`artist-detail:${artist}`, scrollRef)

  const aliasVersion = useSyncExternalStore(subscribeAliases, getAliasVersion)
  const lookupName = useMemo(() => canonicalArtist(artist), [artist, aliasVersion])

  // Declared live concerts of this artist (2026-10-18, Jake on the Geese
  // page: "needs to be displayed via poster presentation"). A concert's
  // tracks are projected out of regularTracks, so it never groups as an
  // album; the Live section shows it once, as its poster.
  const liveSnap = useSyncExternalStore(subscribeLiveSets, getLiveSetsSnapshot)
  const trackById = useMemo(() => {
    const m = new Map<number, Track>()
    for (const t of lib.tracks) m.set(t.id, t)
    return m
  }, [lib.tracks])
  const artistConcerts = useMemo(() => {
    if (!artist) return []
    const canonicalActive = canonicalArtist(artist)
    return declaredConcerts(liveSnap.sets, (id) => trackById.get(id))
      .filter((c) => isSameArtist(c.band, canonicalActive))
  }, [liveSnap, trackById, artist, aliasVersion])
  // Every track a concert owns — promoted songs included — so a show the
  // user reimported song-by-song is still ONE tile (its concert poster).
  const concertIds = useMemo(
    () => concertTrackIds(liveSnap.sets, (id) => trackById.has(id)),
    [liveSnap, trackById],
  )
  const mergedConcertIds = useMemo(() => new Set(Object.values(liveSnap.sets).map((e) => e.mergedTrackId)), [liveSnap])

  // Every track of this artist, concerts included — for the header's song
  // and play counts (a concert's songs are songs; its merged file is not).
  const matchesArtist = useCallback((t: Track, canonicalActive: string) =>
    isSameArtist(t.artist || '', canonicalActive) || (t.contributingArtists || []).some((x) => isSameArtist(x || '', canonicalActive)), [])
  const artistAllTracks = useMemo(() => {
    if (!artist) return [] as Track[]
    const canonicalActive = canonicalArtist(artist)
    return lib.tracks.filter((t) => matchesArtist(t, canonicalActive))
  }, [lib.tracks, artist, aliasVersion, matchesArtist])

  // 4.5.0-45: Persona-aware aggregation. Match on either `artist` exact
  // OR contributingArtists.includes — canonicalize so "Paul McCartney
  // & Wings" tracks land on the "Paul McCartney" page — then SPLIT by
  // the raw tag so each persona keeps its own discography.
  const personas = useMemo<Persona[]>(() => {
    if (!artist) return []
    const canonicalActive = canonicalArtist(artist)
    const byPersona = new Map<string, Map<string, AlbumGroup>>()
    for (const t of regularTracks) {
      const directMatch = isSameArtist(t.artist || '', canonicalActive)
      const collabMatch = (t.contributingArtists || []).find(x => isSameArtist(x || '', canonicalActive))
      if (!directMatch && !collabMatch) continue
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
    const out: Persona[] = []
    for (const [name, albumMap] of byPersona.entries()) {
      const albums = Array.from(albumMap.values()).sort((x, y) => (Number(y.year) || 0) - (Number(x.year) || 0))
      for (const g of albums) g.tracks = sortAlbumTracks(g.tracks)
      let minY = Infinity, maxY = -Infinity
      for (const g of albums) for (const t of g.tracks) {
        const y = Number(t.year)
        if (y > 0 && y < 9999) { if (y < minY) minY = y; if (y > maxY) maxY = y }
      }
      const yearRange = minY !== Infinity && maxY !== -Infinity
        ? (minY === maxY ? `${minY}` : `${minY}–${maxY}`) : ''
      out.push({ name, yearRange, albums })
    }
    // The persona matching the canonical name first (the "main" identity),
    // then the rest by earliest year so the timeline reads chronologically.
    out.sort((a, b) => {
      const aCanonical = isSameArtist(a.name, canonicalActive) && a.name.toLowerCase() === canonicalActive.toLowerCase()
      const bCanonical = isSameArtist(b.name, canonicalActive) && b.name.toLowerCase() === canonicalActive.toLowerCase()
      if (aCanonical && !bCanonical) return -1
      if (bCanonical && !aCanonical) return 1
      const aMin = a.albums.reduce((m, g) => Math.min(m, Number(g.year) || Infinity), Infinity)
      const bMin = b.albums.reduce((m, g) => Math.min(m, Number(g.year) || Infinity), Infinity)
      return aMin - bMin
    })
    // An artist whose only music here is a declared concert still gets a
    // chapter, so the concert's poster has somewhere to sit.
    if (out.length === 0 && artistConcerts.length > 0) {
      out.push({ name: artistConcerts[0].band || artist, yearRange: '', albums: [] })
    }
    return out
  }, [regularTracks, artist, aliasVersion, artistConcerts])

  const concertsForPersona = useMemo(
    () => concertsByPersona(artistConcerts, personas.map((p) => p.name)),
    [artistConcerts, personas],
  )
  const openConcert = useCallback((albumKey: string) => {
    setConcertKey(albumKey)
    dispatch({ type: 'SET_VIEW', view: 'concert-detail' })
  }, [dispatch])
  const openAlbum = useCallback((personaName: string, albumName: string) => {
    dispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: albumKeyFromStrings(personaName, albumName) })
  }, [dispatch])

  // What each album IS. Stored answers re-read on every visit (the
  // MusicBrainz pass lands them over time); facts span the WHOLE library so
  // the fallback matches what main would store for the same album.
  const storedKinds = useSyncExternalStore(subscribeReleaseKinds, getReleaseKindsSnapshot)
  useEffect(() => { void refreshReleaseKinds() }, [artist])
  const albumFacts = useMemo(() => collectAlbumFacts(lib.tracks, foldName), [lib.tracks])
  const kindOfAlbum = useCallback(
    (g: AlbumGroup): ReleaseKind => releaseKindForRows(g.tracks, storedKinds, albumFacts, foldName),
    [storedKinds, albumFacts],
  )

  // Each persona's chapter: its owned releases sorted into the page's rows
  // (newest first within a row), and its Live wall — declared concerts +
  // live albums, one poster per show (promoted concert songs fold into it).
  const chapters = useMemo(() => personas.map((persona) => {
    const shownAlbums = withoutConcertTracks(persona.albums, concertIds)
    const sections = withLiveWall(
      groupByReleaseKind(shownAlbums, a => kindOfAlbum(a)),
      concertsForPersona.get(persona.name) ?? [],
    )
    const rows: Record<RowKey, AlbumGroup[]> = { album: [], eps: [], compilation: [] }
    let wall: WallTile[] = []
    for (const s of sections) {
      if (s.wall) { wall = s.wall.map((t) => ({ ...t, persona: persona.name })); continue }
      const row = (Object.keys(ROW_KINDS) as RowKey[]).find((r) => ROW_KINDS[r].includes(s.kind))
      if (row) rows[row].push(...s.items)
    }
    for (const r of Object.keys(rows) as RowKey[]) rows[r].sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0))
    return { persona, shownAlbums, rows, wall }
  }), [personas, concertIds, kindOfAlbum, concertsForPersona])

  const wallTiles = useMemo(() => chapters.flatMap((c) => c.wall).sort((a, b) => (b.when - a.when) || 0), [chapters])
  const ownedReleases = useMemo(() => chapters.flatMap((c) => c.shownAlbums), [chapters])

  // ── header stats ──
  const songCount = useMemo(() => artistAllTracks.filter((t) => !mergedConcertIds.has(t.id)).length, [artistAllTracks, mergedConcertIds])
  const totalPlays = useMemo(() => artistAllTracks.reduce((s, t) => s + playsOf(t), 0), [artistAllTracks, playsOf])
  const releaseCount = ownedReleases.filter((g) => kindOfAlbum(g) !== 'live').length + wallTiles.length
  const sinceMs = useMemo(() => earliestAdded(artistAllTracks), [artistAllTracks])

  // ── "Your <Artist>" ──
  const top = useMemo(() => topSongs(ownedReleases.flatMap((g) => g.tracks), playsOf, 5), [ownedReleases, playsOf])
  const record = useMemo(() => mostPlayedRecord(ownedReleases, playsOf), [ownedReleases, playsOf])
  const recordPersona = useMemo(() => {
    if (!record) return ''
    return chapters.find((c) => c.shownAlbums.includes(record.group))?.persona.name ?? artist
  }, [record, chapters, artist])

  // Artwork lookup for covers. Routes through lookupArtwork so the cover
  // sticks when album/artist strings drift ("(Remastered)", "feat.",
  // diacritics); a miss fires the server-side resolver (deduped per pair).
  const normalizedArtIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])
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

  // ── profile (homemini) + the fallback bio ──
  // The cached profile paints at once; the refresh lands behind it. With no
  // profile (404, or homemini away and nothing cached) the page shows the
  // validated Wikipedia summary it always had, and no members.
  const { state: profileState, cacheRead, replace: replaceProfile } = useArtistProfile(lookupName)
  const profile = profileState.profile
  // Keyed by artist: the page can move between artists without remounting.
  const [wikiEntry, setWikiEntry] = useState<{ name: string; extract: string | null; pageUrl: string | null } | null>(null)
  const wiki = wikiEntry && wikiEntry.name === lookupName ? wikiEntry : null
  const wantWiki = !!lookupName && cacheRead && !profile
  const wikiLoading = wantWiki && !wiki
  useEffect(() => {
    if (!wantWiki) return
    let cancelled = false
    const name = lookupName
    window.electronAPI.getArtistWiki(name).then(r => {
      if (!cancelled) setWikiEntry({ name, extract: r.extract, pageUrl: r.pageUrl })
    }).catch((err: unknown) => {
      console.warn('[artist-detail] wiki fallback failed:', err instanceof Error ? err.message : err)
      if (!cancelled) setWikiEntry({ name, extract: null, pageUrl: null })
    })
    return () => { cancelled = true }
  }, [wantWiki, lookupName])

  // Artist photo via the existing per-artist photo IPC (Deezer, identity-
  // confirmed). Canonicalized so an alias-merged row still pulls the photo.
  const [photoEntry, setPhotoEntry] = useState<{ name: string; slug: string | null; failed: boolean } | null>(null)
  const photo = photoEntry && photoEntry.name === lookupName ? photoEntry : null
  const photoSlug = photo?.slug ?? null
  const photoFailed = !!photo?.failed
  useEffect(() => {
    if (!lookupName) return
    let cancelled = false
    const name = lookupName
    window.electronAPI.getArtistImage(name).then(r => {
      if (!cancelled) setPhotoEntry({ name, slug: r.ok ? r.slug : null, failed: false })
    }).catch((err: unknown) => { console.warn('[artist-detail] photo lookup failed:', err instanceof Error ? err.message : err) })
    return () => { cancelled = true }
  }, [lookupName])
  const heroSlug = photoSlug || profile?.heroPhoto || null
  const recordHash = record ? findArtHash(recordPersona, record.group.name) : undefined
  // No photo of the artist: the most played record's cover (else the newest
  // record's) fills the band-photo slot, so the header never has dead space.
  const fallbackHash = recordHash ?? (() => {
    for (const ch of chapters) for (const r of ['album', 'eps', 'compilation'] as RowKey[]) for (const g of ch.rows[r]) {
      const h = findArtHash(ch.persona.name, g.name)
      if (h) return h
    }
    return undefined
  })()
  const heroSrc = heroSlug && !photoFailed
    ? `artist-image://${heroSlug}.jpg`
    : fallbackHash ? albumArtUrl(fallbackHash) : null

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
    setRelated([])
    setRelatedLoading(true)
    window.electronAPI.getRelatedArtists?.(lookupName).then((r) => {
      if (cancelled) return
      const list = (r?.ok && r.related) ? r.related : []
      relatedArtistsCache[lookupName] = list
      setRelated(list)
    }).catch((err: unknown) => { console.warn('[artist-detail] related artists failed:', err instanceof Error ? err.message : err) })
      .finally(() => { if (!cancelled) setRelatedLoading(false) })
    return () => { cancelled = true }
  }, [lookupName])

  // 4.5: full discography from MusicBrainz (release groups + tracklists),
  // per persona, cached 7 days in main. Since 10/20 (V3 #215) main refuses a
  // namesake's catalogue, so a reply here means the identity is confirmed;
  // what's drawn from it is "More from <Artist>" — the releases NOT owned.
  const [discoByPersona, setDiscoByPersona] = useState<Map<string, DiscographyAlbum[] | 'loading' | 'empty'>>(new Map())
  const personaNames = useMemo(() => personas.map(p => p.name).join('|'), [personas])
  useEffect(() => {
    if (personas.length === 0) { setDiscoByPersona(new Map()); return }
    let cancelled = false
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
      setDiscoByPersona(new Map(results))
    })
    return () => { cancelled = true }
    // personaNames captures the identity of the set without re-running
    // when an internal album array reference shuffles.
  }, [personaNames]) // eslint-disable-line react-hooks/exhaustive-deps

  // Normalized title → this artist's library track, so a "More from" release
  // can say which of its songs Jake already has (and play them).
  const ownedByTitle = useMemo(() => {
    const m = new Map<string, Track>()
    for (const t of artistAllTracks) if (!mergedConcertIds.has(t.id)) m.set(normTitle(t.title || ''), t)
    return m
  }, [artistAllTracks, mergedConcertIds])
  const ownedTrack = useCallback((title: string) => ownedByTitle.get(normTitle(title)), [ownedByTitle])

  const moreFrom = useCallback((persona: Persona, rowsOwned: AlbumGroup[]): MoreFromRelease[] => {
    const disco = discoByPersona.get(persona.name)
    if (!disco || disco === 'loading' || disco === 'empty') return []
    // Your library is ground truth: an MB release with an owned album's title
    // is that album; an unowned MB "album" that just repackages songs you own
    // (the US Capitol Beatles comps) drops out. The rest is discovery.
    const ownedTitles = new Set(persona.albums.map((a) => normTitle(a.name)))
    for (const g of rowsOwned) ownedTitles.add(normTitle(g.name))
    const ownedSongs = new Set<string>()
    for (const a of persona.albums) for (const t of a.tracks) ownedSongs.add(normTitle(t.title || ''))
    return disco
      .filter((album) => {
        if (ownedTitles.has(normTitle(album.title))) return false
        const titles = album.tracks.map(t => normTitle(t.title)).filter(Boolean)
        if (titles.length >= 4 && titles.filter(t => ownedSongs.has(t)).length / titles.length > 0.5) return false
        return true
      })
      .map((album) => ({
        title: album.title,
        year: album.year,
        tracks: album.tracks,
        kind: classifyRelease({ album: album.title, albumArtist: persona.name, declaredTrackCount: album.tracks.length, mb: album.mb ?? null }).kind,
      }))
      .sort((a, b) => releaseKindRank(a.kind) - releaseKindRank(b.kind) || (b.year || '').localeCompare(a.year || ''))
  }, [discoByPersona])

  // ── the Discography filter ──
  const [filter, setFilter] = useState<DiscoFilter>('all')
  useEffect(() => { setFilter('all') }, [artist])
  const counts = useMemo(() => {
    const c: Record<DiscoFilter, number> = { all: 0, album: 0, eps: 0, compilation: 0, live: wallTiles.length }
    for (const ch of chapters) for (const r of Object.keys(ch.rows) as RowKey[]) c[r] += ch.rows[r].length
    return c
  }, [chapters, wallTiles])
  const segments = (['album', 'eps', 'live', 'compilation'] as const).filter((k) => counts[k] > 0)

  // Play = the page in order (each row newest first, each record in running
  // order); Shuffle = every song of the artist.
  const pageQueue = useMemo(() => {
    const q: Track[] = []
    for (const ch of chapters) for (const r of ['album', 'eps', 'compilation'] as RowKey[]) for (const g of ch.rows[r]) q.push(...sortAlbumTracks(g.tracks))
    return q.length ? q : ownedReleases.flatMap((g) => sortAlbumTracks(g.tracks))
  }, [chapters, ownedReleases])

  // Quiet placeholders only when a lookup runs past 400 ms (a cache hit never flashes).
  const aboutLoadingShown = useDelayedFlag(!profile && (!cacheRead || wikiLoading))
  const relatedLoadingShown = useDelayedFlag(relatedLoading)
  const discoLoadingShown = useDelayedFlag([...discoByPersona.values()].some((v) => v === 'loading'))

  if (!artist) {
    return (
      <div className="artist-detail">
        <button className="artist-detail-back" onClick={goBack}>{backLabel}</button>
        <div className="artist-detail-empty">No artist selected.</div>
      </div>
    )
  }

  const isMulti = personas.length > 1
  const members = profile?.members
  const memberCredit = members?.photoCredit
    || (members?.people ?? []).filter((p) => p.photo?.credit).map((p) => `${p.name} photo: ${p.photo!.credit}`).join(' · ')
  const bioParas = (text: string) => text.split(/\n{2,}|\n/).map((s) => s.trim()).filter(Boolean)
  const openExternal = (url: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    window.electronAPI.openExternalUrl(url).catch((err: unknown) => console.warn('[artist-detail] open link failed:', err))
  }
  const libraryHas = (name: string) => ownedArtistKeys.has(artistIdentityKey(canonicalArtist(name)))
  const openArtist = (name: string) => dispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: canonicalArtist(name) })
  const showRow = (r: RowKey) => filter === 'all' || filter === r
  const recordKind = record ? kindOfAlbum(record.group) : 'album'
  const recordLength = record ? record.group.tracks.reduce((s, t) => s + (Number(t.duration) || 0), 0) : 0
  const recordSince = record ? earliestAdded(record.group.tracks) : null

  const cover = (personaName: string, g: AlbumGroup, kind: ReleaseKind, showKind: boolean) => {
    const hash = findArtHash(personaName, g.name)
    const plays = g.tracks.reduce((s, t) => s + playsOf(t), 0)
    const meta = [showKind ? RELEASE_KIND_SINGULAR[kind] : '', g.year ? String(g.year) : '', plays > 0 ? plural(plays, 'play') : plural(g.tracks.length, 'song')].filter(Boolean).join(' · ')
    return (
      <button
        key={g.name}
        type="button"
        className="ad-cover"
        onClick={() => openAlbum(personaName, g.name)}
        onContextMenu={(e) => { e.preventDefault(); setAlbumCtx({ x: e.clientX, y: e.clientY, name: g.name, tracks: g.tracks }) }}
        draggable
        /* Drag an album straight from the artist page onto a playlist;
           running order, same as the Albums grid. */
        onDragStart={(e) => setAlbumDragPayload(e, sortAlbumTracks(g.tracks).map(t => t.id))}
        title={`Open ${g.name}`}
      >
        <span className="ad-cover-art ad-lift">
          {hash ? <AlbumArtImage hash={hash} alt={`${g.name} cover`} size={480} /> : <span className="ad-cover-blank" aria-hidden="true" />}
        </span>
        <span className="ad-cover-title">{g.name}</span>
        <span className="ad-cover-meta">{meta}</span>
      </button>
    )
  }

  return (
    <div className="artist-detail" ref={scrollRef}>
      <ScrollTopButton targetRef={scrollRef} />
      <button className="artist-detail-back" onClick={goBack}>{backLabel}</button>

      <header className="ad-hero">
        {heroSrc && (
          <div className="ad-hero-photo">
            <img
              className="ad-drift"
              src={heroSrc}
              alt={artist}
              draggable={false}
              onError={() => { if (heroSlug && !photoFailed) setPhotoEntry({ name: lookupName, slug: photoSlug, failed: true }) }}
            />
            <div className="ad-hero-fade-x" />
            <div className="ad-hero-fade-y" />
          </div>
        )}
        <div className="ad-hero-text">
          <div className="ad-eyebrow ad-eyebrow--hero ad-rise ad-d1">{heroEyebrow(profile?.origin)}</div>
          <h1 className={`ad-name ad-name--${heroNameSize(artist)} ad-rise ad-d2`}>{artist}</h1>
          {profile?.oneLiner && <p className="ad-oneliner ad-rise ad-d3">{profile.oneLiner}</p>}
          <div className="ad-stats ad-rise ad-d4">
            <div className="ad-stat"><span className="ad-stat-num">{songCount.toLocaleString('en-US')}</span><span className="ad-stat-label">{songCount === 1 ? 'Song' : 'Songs'}</span></div>
            <div className="ad-stat"><span className="ad-stat-num">{releaseCount.toLocaleString('en-US')}</span><span className="ad-stat-label">{releaseCount === 1 ? 'Release' : 'Releases'}</span></div>
            <div className="ad-stat"><span className="ad-stat-num">{totalPlays.toLocaleString('en-US')}</span><span className="ad-stat-label">{totalPlays === 1 ? 'Play' : 'Plays'}</span></div>
            {sinceMs != null && <div className="ad-stat"><span className="ad-stat-num">{monthYear(sinceMs)}</span><span className="ad-stat-label">In your library since</span></div>}
          </div>
          <div className="ad-hero-actions ad-rise ad-d5">
            <button type="button" className="ad-btn ad-btn--play" onClick={() => playQueue(pageQueue)} disabled={pageQueue.length === 0}><PlayGlyph />Play</button>
            <button type="button" className="ad-btn ad-btn--ghost" onClick={() => playQueue(shuffled(ownedReleases.flatMap((g) => g.tracks)))} disabled={pageQueue.length === 0}><ShuffleGlyph />Shuffle</button>
          </div>
        </div>
      </header>

      <div className="ad-sheet">
        {/* About — directly under the header, facts beside it. */}
        <section className="ad-about ad-rise ad-d4">
          <div className="ad-about-main">
            <h2 className="ad-h2">About</h2>
            {profile?.bio ? (
              <>
                {profile.bio.lede && <p className="ad-lede">{profile.bio.lede}</p>}
                {bioParas(profile.bio.body).map((p, i) => <p key={i} className="ad-body">{p}</p>)}
                {profile.bio.sources.length > 0 && (
                  <p className="ad-source">
                    {writtenFrom(profile.bio.sources.map((s) => s.label))} · every fact sourced ·{' '}
                    <a href={profile.bio.sources[0].url} onClick={openExternal(profile.bio.sources[0].url)}>{profile.bio.sources[0].label}</a>
                  </p>
                )}
              </>
            ) : profile ? (
              profile.facts.length === 0 && <p className="ad-body ad-body--quiet">No biography yet.</p>
            ) : aboutLoadingShown ? (
              <p className="ad-body ad-body--quiet">Looking up {artist}…</p>
            ) : wiki?.extract ? (
              <>
                {bioParas(wiki.extract).map((p, i) => <p key={i} className="ad-body">{p}</p>)}
                <p className="ad-source">
                  From Wikipedia
                  {wiki.pageUrl && <> · <a href={wiki.pageUrl} onClick={openExternal(wiki.pageUrl)}>Wikipedia</a></>}
                  {' · '}<a href={`https://musicbrainz.org/search?type=artist&query=${encodeURIComponent(artist)}`} onClick={openExternal(`https://musicbrainz.org/search?type=artist&query=${encodeURIComponent(artist)}`)}>MusicBrainz</a>
                </p>
              </>
            ) : wiki ? (
              // Better empty than wrong: no validated page → no bio, and a way to look.
              <p className="ad-body ad-body--quiet">
                No biography found for {artist}. Search{' '}
                <a href="#" onClick={openExternal(`https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(artist + ' musician')}`)}>Wikipedia</a>
                {' '}or{' '}
                <a href="#" onClick={openExternal(`https://musicbrainz.org/search?type=artist&query=${encodeURIComponent(artist)}`)}>MusicBrainz</a>.
              </p>
            ) : null}
          </div>
          {profile && profile.facts.length > 0 && (
            <dl className="ad-facts">
              {profile.facts.map((f) => (
                <Fragment key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>{f.url ? <a href={f.url} onClick={openExternal(f.url)}>{f.value}</a> : f.value}</dd>
                </Fragment>
              ))}
            </dl>
          )}
        </section>

        {/* Your <Artist> — the top songs once, the record beside them (never the same songs twice). */}
        {top.length > 0 && (
          <section className="ad-yours ad-rise ad-d5">
            <div className="ad-yours-songs">
              <h2 className="ad-h2 ad-h2--spaced">Your {artist}</h2>
              <div className="ad-table" role="table" aria-label={`Your most played ${artist} songs`}>
                <div className="ad-table-head" role="row">
                  <span role="columnheader" className="ad-num">#</span><span role="columnheader">Name</span><span role="columnheader">Album</span><span role="columnheader" className="ad-num">Time</span><span role="columnheader">Plays</span>
                </div>
                {top.map((s, i) => {
                  const persona = chapters.find((c) => c.shownAlbums.some((g) => g.tracks.includes(s.track)))?.persona.name ?? artist
                  const hash = findArtHash(persona, s.track.album || '')
                  return (
                    <div
                      key={s.track.id}
                      role="row"
                      className={`ad-table-row${i % 2 ? ' is-alt' : ''}`}
                      tabIndex={0}
                      onClick={() => playQueue([s.track, ...top.filter((x) => x !== s).map((x) => x.track)])}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playQueue([s.track, ...top.filter((x) => x !== s).map((x) => x.track)]) } }}
                      title={`Play ${s.track.title}`}
                    >
                      <span role="cell" className="ad-num ad-rank">{i + 1}</span>
                      <span role="cell" className="ad-song">
                        {hash ? <AlbumArtImage hash={hash} alt="" className="ad-song-art" size={80} /> : <span className="ad-song-art ad-cover-blank" />}
                        <span className="ad-song-title">{s.track.title}</span>
                      </span>
                      <span role="cell" className="ad-song-album">{s.track.album}</span>
                      <span role="cell" className="ad-num ad-song-time">{clock(s.track.duration)}</span>
                      <span role="cell" className="ad-plays">
                        <span className="ad-bar"><span style={{ width: `${Math.round(s.bar * 100)}%` }} /></span>
                        <span className="ad-plays-n">{s.plays}</span>
                      </span>
                    </div>
                  )
                })}
              </div>
              <p className="ad-footnote">{elsewhere.counts.size > 0 ? 'Plays from this Mac, workmini and your phone.' : 'Plays from this Mac.'}</p>
            </div>
            {record && (
              <div className="ad-yours-record">
                <h2 className="ad-h2 ad-h2--spaced">Most played record</h2>
                <div className="ad-record ad-lift">
                  <button type="button" className="ad-record-art" onClick={() => openAlbum(recordPersona, record.group.name)} title={`Open ${record.group.name}`}>
                    {recordHash ? <AlbumArtImage hash={recordHash} alt={`${record.group.name} cover`} size={480} /> : <span className="ad-cover-blank" />}
                  </button>
                  <div className="ad-record-info">
                    <div className="ad-record-head">
                      <span className="ad-eyebrow">{RELEASE_KIND_SINGULAR[recordKind]}{record.group.year ? ` · ${record.group.year}` : ''}</span>
                      <button type="button" className="ad-record-title" onClick={() => openAlbum(recordPersona, record.group.name)}>{record.group.name}</button>
                      <span className="ad-record-sub">{plural(record.group.tracks.length, 'song')} · {lengthLabel(recordLength)}</span>
                    </div>
                    <div className="ad-record-plays">
                      <div className="ad-record-count"><span className="ad-record-n">{record.plays.toLocaleString('en-US')}</span><span>of your {totalPlays.toLocaleString('en-US')} {artist} plays</span></div>
                      <div className="ad-bar ad-bar--wide"><span style={{ width: `${Math.round((record.plays / Math.max(1, totalPlays)) * 100)}%` }} /></div>
                      {recordSince != null && <span className="ad-record-since">In your library since {dayMonthYear(recordSince)}</span>}
                    </div>
                    <button type="button" className="ad-btn ad-btn--play ad-btn--small" onClick={() => playQueue(sortAlbumTracks(record.group.tracks))}>Play album</button>
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Members — real people, clear faces; Jake's own pick always wins. */}
        {members && members.people.length > 0 && (
          <section className="ad-members ad-rise ad-d6">
            <h2 className="ad-h2">{members.mode === 'classic' ? 'Classic lineup' : 'Members'}{members.mode === 'classic' && members.era && <span className="ad-h2-note">{members.era}</span>}</h2>
            <div className={`ad-member-grid ad-member-grid--${Math.min(6, Math.max(4, members.people.length))}`}>
              {members.people.map((m) => (
                <MemberTile
                  key={m.name}
                  artist={lookupName}
                  member={m}
                  photoSlug={m.photo ? profileState.photos[m.photo.url] : undefined}
                  soloArtist={m.libraryArtist && libraryHas(m.libraryArtist) && artistIdentityKey(canonicalArtist(m.libraryArtist)) !== artistIdentityKey(lookupName) ? m.libraryArtist : undefined}
                  onOpenSolo={openArtist}
                  onPhotoSet={replaceProfile}
                />
              ))}
            </div>
            {memberCredit && <p className="ad-credit">{memberCredit}</p>}
          </section>
        )}

        {/* Discography — one row per kind, newest first; kinds from release-kinds. */}
        {(counts.album + counts.eps + counts.compilation > 0 || [...discoByPersona.values()].some((v) => Array.isArray(v))) && (
          <section className="ad-disco ad-rise ad-d6">
            <div className="ad-disco-head">
              <h2 className="ad-h2">Discography</h2>
              {segments.length > 1 && (
                <nav className="ad-seg" aria-label="Release types">
                  <button type="button" className={filter === 'all' ? 'is-on' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All</button>
                  {segments.map((k) => (
                    <button key={k} type="button" className={filter === k ? 'is-on' : ''} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                      {k === 'live' ? RELEASE_KIND_LABEL['live'] : ROW_LABEL[k]} {counts[k]}
                    </button>
                  ))}
                </nav>
              )}
            </div>
            {chapters.map(({ persona, rows }) => {
              const more = moreFrom(persona, [...rows.album, ...rows.eps, ...rows.compilation])
              const discoLoading = discoByPersona.get(persona.name) === 'loading'
              return (
                <div key={persona.name} className="ad-chapter">
                  {isMulti && (
                    <div className="ad-chapter-head">
                      <span className="ad-chapter-name">{persona.name}</span>
                      {persona.yearRange && <span className="ad-chapter-years">{persona.yearRange}</span>}
                    </div>
                  )}
                  {(['album', 'eps', 'compilation'] as RowKey[]).filter((r) => rows[r].length > 0 && showRow(r)).map((r) => (
                    <Fragment key={r}>
                      <div className="ad-row-label">{ROW_LABEL[r]}</div>
                      <div className="ad-cover-grid">
                        {rows[r].map((g) => { const k = kindOfAlbum(g); return cover(persona.name, g, k, r === 'eps') })}
                      </div>
                    </Fragment>
                  ))}
                  {filter === 'all' && (more.length > 0
                    ? <MoreFromList artist={persona.name} releases={more} ownedTrack={ownedTrack} onPlay={(t) => playQueue([t])} />
                    : discoLoading && discoLoadingShown && <div className="ad-more ad-more--loading">Looking up the rest of {persona.name}’s records on MusicBrainz…</div>)}
                </div>
              )
            })}
          </section>
        )}

        {/* Live — every full live set as its poster, whole and uncropped. */}
        {wallTiles.length > 0 && (filter === 'all' || filter === 'live') && (
          <section className="ad-live ad-rise ad-d6">
            <h2 className="ad-h2">{RELEASE_KIND_LABEL['live']}</h2>
            <div className="ad-live-wall">
              {wallTiles.map(tile => tile.type === 'concert' ? (
                <ConcertPosterTile
                  key={tile.key}
                  albumKey={tile.concert.albumKey}
                  artHash={tile.concert.poster || findArtHash(tile.concert.band, tile.concert.show)}
                  band={tile.concert.band}
                  title={tile.concert.show}
                  venue={tile.concert.venue}
                  city={tile.concert.city}
                  date={tile.concert.date}
                  year={tile.concert.year}
                  songs={tile.concert.entry.cues.length}
                  fullSet
                  studio={/\bstudio\b/i.test(`${liveSnap.sets[tile.concert.albumKey]?.concert?.source ?? ''} ${tile.concert.venue ?? ''}`)}
                  tooltip={`${tile.concert.show} — ${tile.concert.band}`}
                  onOpen={() => openConcert(tile.concert.albumKey)}
                />
              ) : (
                <ConcertPosterTile
                  key={tile.key}
                  artHash={findArtHash(tile.persona, tile.album.name)}
                  band={tile.persona}
                  title={tile.album.name}
                  venue={tile.venue}
                  date={tile.date}
                  year={tile.album.year}
                  songs={tile.album.tracks.length}
                  tooltip={`Open ${tile.album.name}`}
                  onOpen={() => openAlbum(tile.persona, tile.album.name)}
                  onContextMenu={(e) => { e.preventDefault(); setAlbumCtx({ x: e.clientX, y: e.clientY, name: tile.album.name, tracks: tile.album.tracks }) }}
                  onDragStart={(e) => setAlbumDragPayload(e, sortAlbumTracks(tile.album.tracks).map(t => t.id))}
                />
              ))}
            </div>
          </section>
        )}

        {/* Related artists — at the very bottom, so the page leads with the artist's own music. */}
        {(related.length > 0 || relatedLoadingShown) && (
          <section className="ad-related">
            <h2 className="ad-h2">Related artists</h2>
            {relatedLoadingShown && related.length === 0 ? (
              <p className="ad-body ad-body--quiet">Finding connections…</p>
            ) : (
              <div className="ad-related-row">
                {related.map((r) => {
                  const owned = libraryHas(r.name)
                  return (
                    <button
                      key={r.name}
                      type="button"
                      className={`ad-related-chip ${owned ? 'is-owned' : 'is-unowned'}`}
                      onClick={() => { if (owned) openArtist(r.name) }}
                      disabled={!owned}
                      title={owned ? `Go to ${r.name}` : `${r.name} — not in your library yet`}
                    >
                      <span className="ad-related-name">{r.name}</span>
                      <span className="ad-related-rel">{relationLabel(r.relation)}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </section>
        )}
      </div>
      {albumCtx && (
        <ContextMenu x={albumCtx.x} y={albumCtx.y} items={albumCtxItems(albumCtx.name, albumCtx.tracks)} onClose={() => setAlbumCtx(null)} />
      )}
    </div>
  )
}
