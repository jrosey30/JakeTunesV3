import { useState, useMemo, useCallback, useRef, useEffect, useSyncExternalStore } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { sessionArtistImages, ARTIST_PHOTO_PREFETCH_CAP, ARTIST_PHOTO_BATCH, hashColor, initials } from '../utils/artistPortrait'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import { useRegularLibraryTracks } from '../hooks/useRegularLibraryTracks'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { compareNames, artistSectionLetter } from '../utils/artistSort'
import ScrollTopButton from '../components/ScrollTopButton'
import FindBar from '../components/FindBar'
import { useFindState } from '../hooks/useFindState'
import { consumeDrillIn } from '../utils/drillIn'
import { setAlbumDragPayload } from '../utils/trackDrag'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import { downloadMenuEntries } from '../utils/downloadStore'
import { useCynthia } from '../context/CynthiaContext'
import { toCynthiaTrack } from '../utils/cynthia'
import { clearArtworkNegativeCache } from '../utils/artworkLookup'
import EmptyState from '../components/EmptyState'
import ConfirmDialog from '../components/ConfirmDialog'
import GetInfoModal from '../components/GetInfoModal'
import ArtistGroupingModal from '../components/ArtistGroupingModal'
import { ratingMenuEntries } from '../components/StarRating'
import { Track } from '../types'
import { setNotice } from '../activity'
import { artistIdentityKey, canonicalArtist, subscribeAliases, getAliasVersion } from '../utils/artistAlias'
import { albumKeyFromStrings } from '../utils/albumKey'
import '../styles/artists.css'
import { addToPlaylistEntry } from '../utils/playlistMenu'

// A–Z jump rail letters; '#' collects digits/symbols.
const AZ_LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']

interface ArtistGroup {
  name: string
  tracks: Track[]
  albums: { name: string; tracks: Track[] }[]
}

/* Artist avatar helpers now live in utils/artistPortrait so the Discover
 * feed's artist cards and this list agree on what an artist looks like.
 * Two copies would drift — the Overlooked lane was already showing album
 * covers where this list showed portraits. */

export default function ArtistsView() {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { openCynthia } = useCynthia()
  const { state: pb, dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()
  // Brief 032: accordion mode — only one artist and one album expanded
  // at a time. Was Set<string> for multi-expand; the multi-expand UX
  // accumulated stacked tracklists and became visually messy.
  const [expandedArtist, setExpandedArtist] = useState<string | null>(null)
  // 4.4.40: artist photo cache. Key = artist name, value = slug ('found'),
  // null ('no image available, don't retry'), or absent (haven't fetched).
  // Fetches are batched and rate-limited via the IPC handler in main.
  const [artistImages, setArtistImages] = useState<Map<string, string | null>>(
    () => new Map(sessionArtistImages),
  )
  const artistImagesRef = useRef(artistImages)
  artistImagesRef.current = artistImages
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: Track; tracks: Track[]; idx: number } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: number[]; count: number } | null>(null)
  const [getInfoState, setGetInfoState] = useState<{ tracks: Track[]; index: number } | null>(null)

  const [groupingOpen, setGroupingOpen] = useState(false)
  // Regroup when the user/AI alias map changes (boot load or an approve/edit).
  const aliasVersion = useSyncExternalStore(subscribeAliases, getAliasVersion)
  // Concert-owned tracks don't appear under Artists (the concert lives in the
  // Full Live Concerts section); a reimported song brings its artist back.
  const regularTracks = useRegularLibraryTracks(lib.tracks)
  const artists = useMemo((): ArtistGroup[] => {
    const map = new Map<string, Track[]>()
    const displayNames = new Map<string, string>()
    for (const t of regularTracks) {
      // Brief 031 Phase 4c: fan out each track across every artist
      // listed in contributingArtists, not just t.artist. For sole-
      // artist tracks, contributingArtists is [artist] so behavior is
      // unchanged. For collab tracks (e.g., "JAY-Z & Linkin Park"
      // with contributingArtists ["JAY-Z", "Linkin Park"]), the
      // track is added to BOTH artist groups. Fallback to [t.artist]
      // protects against legacy tracks that lack the field (iPod-
      // sync imports pre-Phase-4, defensive).
      const contributors = (t.contributingArtists && t.contributingArtists.length > 0)
        ? t.contributingArtists
        : [t.artist || 'Unknown Artist']
      // 4.5.0-43: canonicalize each contributor so "Paul McCartney & Wings"
      // and "Wings" both collapse into the "Paul McCartney" row. Dedup
      // within a single track's contributor list so the same track isn't
      // double-counted when the raw + alias resolve to the same canonical.
      const seenForTrack = new Set<string>()
      for (const raw of contributors) {
        const display = canonicalArtist(raw || 'Unknown Artist')
        const key = artistIdentityKey(display)
        if (seenForTrack.has(key)) continue
        seenForTrack.add(key)
        if (!map.has(key)) {
          map.set(key, [])
          displayNames.set(key, display)
        }
        map.get(key)!.push(t)
      }
    }
    return Array.from(map.entries())
      // iTunes-style shared comparator (article/punctuation-insensitive + numeric)
      // so Artists and Albums sort identically. The Beatles files under B.
      .sort(([a], [b]) => compareNames(displayNames.get(a) || a, displayNames.get(b) || b))
      .map(([key, tracks]) => {
        const name = displayNames.get(key) || key
        const albumMap = new Map<string, Track[]>()
        for (const t of tracks) {
          const aName = t.album || 'Unknown Album'
          if (!albumMap.has(aName)) albumMap.set(aName, [])
          albumMap.get(aName)!.push(t)
        }
        return {
          name,
          tracks,
          albums: Array.from(albumMap.entries()).map(([n, t]) => ({ name: n, tracks: t }))
        }
      })
  }, [regularTracks, aliasVersion])

  // Filter against the global toolbar Search Pill. Matches artist
  // name, album name, or track title.
  const effectiveQuery = (lib.searchQuery || '').trim().toLowerCase()
  const [listFilter, setListFilter] = useState('')
  const lf = listFilter.trim().toLowerCase()
  const filteredArtists = useMemo(() => {
    let result = artists
    if (effectiveQuery) {
      const q = effectiveQuery
      result = result.filter(a =>
        a.name.toLowerCase().includes(q) ||
        a.albums.some(al => al.name.toLowerCase().includes(q)) ||
        a.tracks.some(t => (t.title || '').toLowerCase().includes(q)),
      )
    }
    // In-view filter box — narrows by artist name (the fast-find case).
    if (lf) result = result.filter(a => a.name.toLowerCase().includes(lf))
    return result
  }, [artists, effectiveQuery, lf])

  const toggleArtist = useCallback((name: string) => {
    // Brief 032 Decision 4: clicking a different artist collapses the
    // previous one AND resets the album state — reopening an artist
    // starts with no album expanded. Clicking the same artist again
    // collapses it (sets to null).
    setExpandedArtist(prev => prev === name ? null : name)
  }, [])

  const openAlbum = useCallback((artistName: string, albumName: string) => {
    libDispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: albumKeyFromStrings(artistName, albumName) })
  }, [libDispatch])

  const handleContextMenu = useCallback((e: React.MouseEvent, track: Track, tracks: Track[], idx: number) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, track, tracks, idx })
  }, [])

  const getContextMenuItems = useCallback((): MenuEntry[] => {
    if (!ctxMenu) return []
    const { track, tracks, idx } = ctxMenu
    const artworkItems: MenuEntry[] = track.artist && track.album ? [
      { separator: true as const },
      {
        label: 'Add Artwork…',
        onClick: async () => {
          const file = await window.electronAPI.chooseArtworkFile()
          if (!file.ok || !file.path) return
          const result = await window.electronAPI.setCustomArtwork(track.artist, track.album, file.path)
          if (result.ok && result.key && result.hash) {
            libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
          } else {
            // 4.4.12: surface failure (usually sips conversion).
            setNotice(result.error ? `Couldn't save artwork: ${result.error}` : "Couldn't save artwork.", { kind: 'error' })
          }
        },
      },
      {
        label: 'Fetch Artwork from Internet',
        onClick: async () => {
          const result = await window.electronAPI.fetchAlbumArt(track.artist, track.album, true)
          if (result.ok && result.key && result.hash) {
            libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
          }
        },
      },
    ] : []
    const albumLabel = `${track.albumArtist || track.artist} — ${track.album}`

    return [
      { label: `Play "${track.title}"`, onClick: () => playTrack(track, tracks, idx, undefined, true) },
      { separator: true as const },
      { label: 'Play Next', onClick: () => pbDispatch({ type: 'PLAY_NEXT', tracks: [track] }) },
      { label: 'Add to Up Next', onClick: () => pbDispatch({ type: 'ADD_TO_QUEUE', tracks: [track] }) },
      addToPlaylistEntry([track], lib.playlists, (pid, ids) => libDispatch({ type: 'ADD_TRACKS_TO_PLAYLIST', playlistId: pid, trackIds: ids })),
      // Mirrors SongsView's "Start X Radio" (contributing-artists aware) so the
      // action exists where it's most natural — browsing an artist's albums.
      ...(() => {
        const trackArtist = (track.artist || '').trim()
        const sourceContribs = (
          track.contributingArtists && track.contributingArtists.length > 0
            ? track.contributingArtists
            : [trackArtist]
        )
          .map(s => (s || '').trim().toLowerCase())
          .filter(s => s.length > 0)
        const artistTracks = sourceContribs.length
          ? lib.tracks.filter(t => {
              const candidates = (t.contributingArtists && t.contributingArtists.length > 0
                ? t.contributingArtists
                : [(t.artist || '').trim()]
              )
                .map(s => (s || '').trim().toLowerCase())
                .filter(s => s.length > 0)
              return candidates.some(c => sourceContribs.includes(c))
            })
          : []
        return trackArtist && artistTracks.length > 0 ? [
          { separator: true as const },
          {
            label: `Start ${trackArtist} Radio`,
            onClick: () => {
              window.dispatchEvent(new CustomEvent('jaketunes-start-artist-radio', {
                detail: { tracks: artistTracks, label: trackArtist },
              }))
            },
          },
        ] : []
      })(),
      ...ratingMenuEntries([track], libDispatch),
      { separator: true as const },
      { label: 'Get Info', onClick: () => setGetInfoState({ tracks: [track], index: idx }) },
      ...artworkItems,
      ...downloadMenuEntries([track]),
      { separator: true as const },
      {
        label: 'Cynthia!! (this album)',
        onClick: () => {
          openCynthia({
            x: ctxMenu.x, y: ctxMenu.y,
            scope: {
              type: 'album',
              label: albumLabel,
              tracks: tracks.map(toCynthiaTrack),
            },
          })
        },
      },
      { separator: true as const },
      { label: 'Delete Song', onClick: () => setDeleteConfirm({ ids: [track.id], count: 1 }) },
    ]
  }, [ctxMenu, playTrack, pbDispatch, libDispatch, openCynthia, lib.tracks])

  const handleGetInfoSave = useCallback(
    async (updates: { id: number; field: string; value: string }[]) => {
      // 4.5.0-67 — save-first ordering, see SongsView for full rationale.
      const oldArtAlbumById = new Map<number, { artist: string; album: string }>()
      for (const u of updates) {
        if (oldArtAlbumById.has(u.id)) continue
        const t = lib.tracks.find(tr => tr.id === u.id)
        if (t) oldArtAlbumById.set(u.id, { artist: t.artist || '', album: t.album || '' })
      }
      for (const u of updates) await window.electronAPI.saveMetadataOverride(u.id, u.field, u.value)
      if (updates.some(u => u.field === 'artist' || u.field === 'album')) {
        const newArtAlbumById = new Map<number, { artist: string; album: string }>()
        for (const [id, old] of oldArtAlbumById) newArtAlbumById.set(id, { ...old })
        for (const u of updates) {
          const cur = newArtAlbumById.get(u.id)
          if (!cur) continue
          if (u.field === 'artist') cur.artist = u.value
          else if (u.field === 'album') cur.album = u.value
        }
        for (const v of newArtAlbumById.values()) clearArtworkNegativeCache(v.artist, v.album)
      }
      libDispatch({ type: 'UPDATE_TRACKS', updates })
    },
    [libDispatch, lib.tracks]
  )

  const handleFetchArt = useCallback(
    async (artist: string, album: string, force?: boolean): Promise<{ key: string; hash: string } | null> => {
      const result = await window.electronAPI.fetchAlbumArt(artist, album, force)
      if (result.ok && result.key && result.hash) {
        libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
        return { key: result.key, hash: result.hash }
      }
      return null
    },
    [libDispatch]
  )

  const handleSetCustomArt = useCallback(
    async (artist: string, album: string, imagePath: string): Promise<{ key: string; hash: string } | null> => {
      const result = await window.electronAPI.setCustomArtwork(artist, album, imagePath)
      if (result.ok && result.key && result.hash) {
        libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
        return { key: result.key, hash: result.hash }
      }
      // 4.4.12: surface failure (usually sips conversion) so the user
      // doesn't think the art stuck just because the Get Info preview
      // still shows it from localArtHash.
      setNotice(result.error ? `Couldn't save artwork: ${result.error}` : "Couldn't save artwork.", { kind: 'error' })
      return null
    },
    [libDispatch]
  )

  // Auto-follow now-playing (4.0). When the playing track changes and
  // the user has been idle for >5s, expand the artist + album that own
  // the new track, and scroll the artist row into view. Same idle-gate
  // pattern as SongsView.
  const viewRootRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('artists', viewRootRef)
  // Letters present in the current (filtered) list — drive the A–Z rail.
  const presentLetters = useMemo(
    () => new Set(filteredArtists.map(a => artistSectionLetter(a.name))),
    [filteredArtists],
  )

  // ⌘F find-in-view: jump to an artist row + flash it. Rows are all in the
  // DOM (not virtualized) so an imperative scrollIntoView + class flash works.
  const find = useFindState()
  const findMatches = useMemo(() => {
    const q = find.query.trim().toLowerCase()
    if (!q) return [] as string[]
    return filteredArtists.filter(a => a.name.toLowerCase().includes(q)).map(a => a.name)
  }, [filteredArtists, find.query])
  const jumpToFind = useCallback((c: number) => {
    const name = findMatches[c]
    if (!name) return
    const el = viewRootRef.current?.querySelector(`[data-artist-name="${CSS.escape(name)}"]`) as HTMLElement | null
    if (!el) return
    isAutoScrollAtRef.current = Date.now()
    el.scrollIntoView({ block: 'center' })
    el.classList.add('find-hit')
    window.setTimeout(() => el.classList.remove('find-hit'), 1400)
  }, [findMatches])
  useEffect(() => {
    if (!find.open || findMatches.length === 0) return
    jumpToFind(Math.min(find.cursor, findMatches.length - 1))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find.open, find.query, findMatches.length])
  const findNext = useCallback(() => {
    if (findMatches.length === 0) return
    const c = (find.cursor + 1) % findMatches.length
    find.setCursor(c); jumpToFind(c)
  }, [findMatches.length, find, jumpToFind])
  const findPrev = useCallback(() => {
    if (findMatches.length === 0) return
    const c = (find.cursor - 1 + findMatches.length) % findMatches.length
    find.setCursor(c); jumpToFind(c)
  }, [findMatches.length, find, jumpToFind])
  const lastUserActivityAtRef = useRef<number>(0)
  const isAutoScrollAtRef = useRef<number>(0)
  const FOLLOW_IDLE_MS = 5000
  const noteUserActivity = useCallback(() => {
    if (Date.now() - isAutoScrollAtRef.current > 200) {
      lastUserActivityAtRef.current = Date.now()
    }
  }, [])

  useEffect(() => {
    if (lib.currentView !== 'artists') return
    if (!pb.nowPlaying) return
    if (Date.now() - lastUserActivityAtRef.current < FOLLOW_IDLE_MS) return
    const t = pb.nowPlaying
    const artistName = t.artist || 'Unknown Artist'
    const exists = filteredArtists.some(a => a.name === artistName)
    if (!exists) return
    isAutoScrollAtRef.current = Date.now()
    setExpandedArtist(artistName)
    requestAnimationFrame(() => {
      const root = viewRootRef.current
      if (!root) return
      const row = root.querySelector(`[data-artist-name="${CSS.escape(artistName)}"]`) as HTMLElement | null
      if (row) row.scrollIntoView({ block: 'nearest', behavior: 'auto' })
    })
  }, [pb.nowPlaying?.id, lib.currentView, filteredArtists])

  // 4.4.40: prefetch artist photos for the first screenful only.
  // Pre-fix walked every filtered artist (200+) on mount. Idle-deferred
  // + session cache + cap keeps navigation snappy; disk cache in main
  // makes return visits instant.
  useEffect(() => {
    if (lib.currentView !== 'artists') return
    let cancelled = false
    const api = window.electronAPI as Record<string, unknown> | undefined
    const fn = api && typeof api.getArtistImage === 'function'
      ? api.getArtistImage as (artist: string) => Promise<{ ok: boolean; slug?: string | null }>
      : null
    if (!fn) return
    const names = filteredArtists
      .map(a => a.name)
      .filter(n => n && n !== 'Unknown Artist')
      .filter(n => !artistImagesRef.current.has(n) && !sessionArtistImages.has(n))
      .slice(0, ARTIST_PHOTO_PREFETCH_CAP)
    if (names.length === 0) return

    const run = () => {
      if (cancelled) return
      void (async () => {
        for (let i = 0; i < names.length; i += ARTIST_PHOTO_BATCH) {
          if (cancelled) return
          const batch = names.slice(i, i + ARTIST_PHOTO_BATCH)
          const results = await Promise.all(
            batch.map(async (name) => {
              try {
                const r = await fn(name)
                return [name, r.ok && r.slug ? r.slug : null] as const
              } catch {
                return [name, null] as const
              }
            }),
          )
          if (cancelled) return
          setArtistImages(prev => {
            const next = new Map(prev)
            for (const [n, s] of results) {
              next.set(n, s)
              sessionArtistImages.set(n, s)
            }
            return next
          })
          await new Promise(r => window.setTimeout(r, 200))
        }
      })()
    }

    const schedule = typeof requestIdleCallback === 'function'
      ? (cb: () => void) => requestIdleCallback(cb, { timeout: 2000 })
      : (cb: () => void) => window.setTimeout(cb, 48)
    schedule(run)
    return () => { cancelled = true }
    // Only re-run when the artist set CHANGES, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib.currentView, filteredArtists.map(a => a.name).join('|')])

  // 4.4.27: drill-in from another view (e.g. clicking an artist card on
  // Home). Consume on mount; if a target name is queued, expand that
  // artist and scroll their row into view.
  //
  // Name matching: HomeView keys cards by `t.albumArtist || t.artist`,
  // ArtistsView groups by `t.artist` only. They match for 95%+ of music
  // where the two fields agree. For the remainder (collaboration
  // singles where albumArtist != artist), we fall back to a
  // case-insensitive search before giving up.
  useEffect(() => {
    const requested = consumeDrillIn('artist')
    if (!requested) return
    // Find a matching artist in the grouped list. Prefer exact match;
    // fall back to case-insensitive; give up if neither matches.
    const exact = filteredArtists.find(a => a.name === requested)
    const ci = exact || filteredArtists.find(
      a => a.name.toLowerCase() === requested.toLowerCase()
    )
    if (!ci) return
    const matchedName = ci.name
    isAutoScrollAtRef.current = Date.now()
    // Brief 032: single-value state — set directly. Decision 5:
    // HomeView → ArtistsView nav-handoff behavior preserved.
    setExpandedArtist(matchedName)
    requestAnimationFrame(() => {
      const root = viewRootRef.current
      if (!root) return
      const row = root.querySelector(`[data-artist-name="${CSS.escape(matchedName)}"]`) as HTMLElement | null
      if (row) row.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      className="artists-view"
      ref={viewRootRef}
      onClickCapture={noteUserActivity}
      onWheelCapture={noteUserActivity}
      onScrollCapture={noteUserActivity}
      onKeyDownCapture={noteUserActivity}
    >
      <div className="artists-toolbar">
        <div className="list-filter">
          <span className="list-filter-icon" aria-hidden="true">⌕</span>
          <input
            className="list-filter-input"
            type="text"
            placeholder="Filter artists…"
            value={listFilter}
            onChange={(e) => setListFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setListFilter('') }}
            spellCheck={false}
            aria-label="Filter artists"
          />
          {listFilter && (
            <button className="list-filter-clear" onClick={() => setListFilter('')} aria-label="Clear filter" title="Clear">×</button>
          )}
        </div>
        <button
          className="artists-group-btn"
          onClick={() => setGroupingOpen(true)}
          title="Let the Music Man group bands, side projects & aliases under one artist"
        >✦ Group artists</button>
      </div>
      <ScrollTopButton targetRef={viewRootRef} />
      {find.open && (
        <FindBar
          query={find.query}
          onQuery={find.setQuery}
          current={find.cursor}
          total={findMatches.length}
          onNext={findNext}
          onPrev={findPrev}
          onClose={find.close}
          placeholder="Find artist…"
        />
      )}
      {filteredArtists.length === 0 && (
        <EmptyState query={lib.searchQuery} noun="artists" />
      )}
      {/* A–Z jump rail — pinned right; letters with no artists are greyed out. */}
      {filteredArtists.length > 0 && (
        <div className="artists-az-anchor">
          <div className="artists-az-rail">
            {AZ_LETTERS.map((L) => (
              <button
                key={L}
                type="button"
                className="artists-az-letter"
                disabled={!presentLetters.has(L)}
                onClick={() => {
                  isAutoScrollAtRef.current = Date.now()
                  const el = viewRootRef.current?.querySelector(`.artists-letter-header[data-letter="${L}"]`)
                  if (el) el.scrollIntoView({ block: 'start', behavior: 'auto' })
                }}
              >{L}</button>
            ))}
          </div>
        </div>
      )}
      {filteredArtists.map((artist, idx) => {
        const letter = artistSectionLetter(artist.name)
        const showLetterHeader = idx === 0 || artistSectionLetter(filteredArtists[idx - 1].name) !== letter
        return (
        <div key={artist.name} className="artist-group" data-artist-name={artist.name}>
          {showLetterHeader && (
            <div className="artists-letter-header" data-letter={letter}>{letter}</div>
          )}
          {/* 4.5: click navigates to the dedicated artist detail page
              (hero photo + Wikipedia summary + library albums) instead
              of expanding inline. The old inline-expand machinery
              (expandedArtist state, content-wrapper render below) is
              left in place for now but never triggers — Phase 2
              cleanup will rip it out once the detail page proves
              itself. */}
          <div
            className="artist-row"
            onClick={() => libDispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: artist.name })}
            // 2026-09-02: an artist row drags as the whole discography —
            // onto a playlist or the iPod Pool.
            draggable
            onDragStart={(e) => setAlbumDragPayload(e, artist.tracks.map((t) => t.id))}
          >
            {(() => {
              // 4.4.40: real artist photo via the artist-image:// scheme
              // (fetched from Bandsintown, cached locally 30 days). Falls
              // back to the original hash-colored initials disc when the
              // artist isn't on Bandsintown or the fetch failed.
              const slug = artistImages.get(artist.name)
              if (slug) {
                return (
                  <img
                    src={`artist-image://${slug}.jpg`}
                    alt=""
                    className="artist-avatar artist-avatar--photo"
                    draggable={false}
                  />
                )
              }
              return (
                <div className="artist-avatar" style={{ background: hashColor(artist.name) }}>
                  {initials(artist.name)}
                </div>
              )
            })()}
            <span className="artist-name">{artist.name}</span>
            <span className="artist-count">{artist.tracks.length} {artist.tracks.length === 1 ? 'song' : 'songs'}</span>
            <svg className={`artist-chevron ${expandedArtist === artist.name ? 'open' : ''}`} width="10" height="10" viewBox="0 0 10 10" fill="#999">
              <path d="M3 1l5 4-5 4z" />
            </svg>
          </div>

          {/* Brief 032: keep the albums grid in the DOM at all times so
              the wrapper can animate grid-template-rows 0fr → 1fr on
              expand/collapse. Conditional class on the wrapper, not
              conditional rendering. */}
          <div className={`artist-content-wrapper ${expandedArtist === artist.name ? 'is-expanded' : ''}`}>
            <div className="artist-content-inner">
            <div className="artist-albums-grid">
              {artist.albums.map((album) => {
                const canonicalKey = albumKeyFromStrings(artist.name, album.name)
                const artworkLookup = (() => {
                  const albumFolded = album.name.toLowerCase().trim()
                  const candidates = new Set<string>()
                  candidates.add(artist.name.toLowerCase().trim())
                  for (const t of album.tracks) {
                    if (t.artist) candidates.add(t.artist.toLowerCase().trim())
                    if (t.albumArtist) candidates.add(t.albumArtist.toLowerCase().trim())
                  }
                  for (const a of candidates) {
                    const k = `${a}|||${albumFolded}`
                    if (lib.artworkMap[k]) return lib.artworkMap[k]
                  }
                  return undefined
                })()
                return (
                  <div
                    key={canonicalKey}
                    className="artist-album-card"
                    role="button"
                    tabIndex={0}
                    onClick={() => openAlbum(artist.name, album.name)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        openAlbum(artist.name, album.name)
                      }
                    }}
                    title={`Open ${album.name}`}
                  >
                    <div className="artist-album-art">
                      {artworkLookup ? (
                        <img
                          src={`album-art://${artworkLookup}.jpg?s=320`}
                          alt={album.name}
                          className="artist-album-art-img"
                          loading="lazy"
                          decoding="async"
                          draggable={false}
                        />
                      ) : (
                        <div className="artist-album-placeholder">
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="#bbb">
                            <circle cx="12" cy="12" r="10" fill="none" stroke="#bbb" strokeWidth="1" />
                            <circle cx="12" cy="12" r="3" fill="none" stroke="#bbb" strokeWidth="1" />
                          </svg>
                        </div>
                      )}
                    </div>
                    <div className="artist-album-info">
                      <div className="artist-album-title">{album.name}</div>
                      <div className="artist-album-count">{album.tracks.length} track{album.tracks.length === 1 ? '' : 's'}</div>
                    </div>
                  </div>
                )
              })}
            </div>
            </div>
          </div>
        </div>
        )
      })}
      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={getContextMenuItems()} onClose={() => setCtxMenu(null)} />
      )}
      {getInfoState && (
        <GetInfoModal
          tracks={getInfoState.tracks}
          allTracks={lib.tracks}
          initialIndex={lib.tracks.findIndex(t => t.id === getInfoState.tracks[0]?.id)}
          artworkMap={lib.artworkMap}
          onClose={() => setGetInfoState(null)}
          onSave={handleGetInfoSave}
          onFetchArt={handleFetchArt}
          onSetCustomArt={handleSetCustomArt}
        />
      )}
      {groupingOpen && <ArtistGroupingModal onClose={() => setGroupingOpen(false)} />}
      {deleteConfirm && (
        <ConfirmDialog
          message="Are you sure you want to delete this song from your library?"
          detail="This will remove them from all playlists. This cannot be undone."
          confirmLabel="Delete"
          onConfirm={() => { libDispatch({ type: 'DELETE_TRACKS', ids: deleteConfirm.ids }); setDeleteConfirm(null) }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </div>
  )
}
