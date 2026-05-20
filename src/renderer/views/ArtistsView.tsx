import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { consumeDrillIn } from '../utils/drillIn'
import { SpeakerPlayingIcon } from '../assets/icons/SpeakerIcon'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import { useCynthia } from '../context/CynthiaContext'
import { toCynthiaTrack } from '../utils/cynthia'
import ConfirmDialog from '../components/ConfirmDialog'
import GetInfoModal from '../components/GetInfoModal'
import { ratingMenuEntries } from '../components/StarRating'
import { Track } from '../types'
import { setNotice } from '../activity'
import '../styles/artists.css'

interface ArtistGroup {
  name: string
  tracks: Track[]
  albums: { name: string; tracks: Track[] }[]
}

const AVATAR_COLORS = ['#c0392b', '#8e44ad', '#2980b9', '#27ae60', '#f39c12', '#d35400', '#1abc9c', '#7f8c8d']

function hashColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}

function initials(name: string): string {
  return name.split(/\s+/).map(w => w[0] || '').join('').toUpperCase().slice(0, 2)
}

export default function ArtistsView() {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { openCynthia } = useCynthia()
  const { state: pb, dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()
  // Brief 032: accordion mode — only one artist and one album expanded
  // at a time. Was Set<string> for multi-expand; the multi-expand UX
  // accumulated stacked tracklists and became visually messy.
  const [expandedArtist, setExpandedArtist] = useState<string | null>(null)
  const [expandedAlbum, setExpandedAlbum] = useState<string | null>(null)
  // 4.4.40: artist photo cache. Key = artist name, value = slug ('found'),
  // null ('no image available, don't retry'), or absent (haven't fetched).
  // Fetches are batched and rate-limited via the IPC handler in main.
  const [artistImages, setArtistImages] = useState<Map<string, string | null>>(new Map())
  const artistImagesRef = useRef(artistImages)
  artistImagesRef.current = artistImages
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: Track; tracks: Track[]; idx: number } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: number[]; count: number } | null>(null)
  const [getInfoState, setGetInfoState] = useState<{ tracks: Track[]; index: number } | null>(null)

  const artists = useMemo((): ArtistGroup[] => {
    const map = new Map<string, Track[]>()
    for (const t of lib.tracks) {
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
      for (const raw of contributors) {
        const name = raw || 'Unknown Artist'
        if (!map.has(name)) map.set(name, [])
        map.get(name)!.push(t)
      }
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, tracks]) => {
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
  }, [lib.tracks])

  // Filter against the global toolbar Search Pill. Matches artist
  // name, album name, or track title.
  const effectiveQuery = (lib.searchQuery || '').trim().toLowerCase()
  const filteredArtists = useMemo(() => {
    const q = effectiveQuery
    if (!q) return artists
    return artists.filter(a => {
      if (a.name.toLowerCase().includes(q)) return true
      if (a.albums.some(al => al.name.toLowerCase().includes(q))) return true
      if (a.tracks.some(t => (t.title || '').toLowerCase().includes(q))) return true
      return false
    })
  }, [artists, effectiveQuery])

  const toggleArtist = useCallback((name: string) => {
    // Brief 032 Decision 4: clicking a different artist collapses the
    // previous one AND resets the album state — reopening an artist
    // starts with no album expanded. Clicking the same artist again
    // collapses it (sets to null).
    setExpandedArtist(prev => prev === name ? null : name)
    setExpandedAlbum(null)
  }, [])

  const toggleAlbum = useCallback((key: string) => {
    // Brief 032 Decision 6: clicking the currently-expanded album
    // collapses it; clicking a different album switches to it.
    setExpandedAlbum(prev => prev === key ? null : key)
  }, [])

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
      ...ratingMenuEntries([track], libDispatch),
      { separator: true as const },
      { label: 'Get Info', onClick: () => setGetInfoState({ tracks: [track], index: idx }) },
      ...artworkItems,
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
  }, [ctxMenu, playTrack, pbDispatch, libDispatch, openCynthia])

  const handleGetInfoSave = useCallback(
    async (updates: { id: number; field: string; value: string }[]) => {
      libDispatch({ type: 'UPDATE_TRACKS', updates })
      for (const u of updates) await window.electronAPI.saveMetadataOverride(u.id, u.field, u.value)
    },
    [libDispatch]
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
    const albumName = t.album || 'Unknown Album'
    const albumKey = `${artistName}::${albumName}`
    const exists = filteredArtists.some(a => a.name === artistName)
    if (!exists) return
    isAutoScrollAtRef.current = Date.now()
    // Brief 032: with single-value state, just set the expanded artist
    // and album directly. Decision 5: auto-expand-on-track-play behavior
    // preserved — it now sets both fields to the playing track's
    // artist + album instead of adding to two sets.
    setExpandedArtist(artistName)
    setExpandedAlbum(albumKey)
    requestAnimationFrame(() => {
      const root = viewRootRef.current
      if (!root) return
      const row = root.querySelector(`[data-artist-name="${CSS.escape(artistName)}"]`) as HTMLElement | null
      if (row) row.scrollIntoView({ block: 'nearest', behavior: 'auto' })
    })
  }, [pb.nowPlaying?.id, lib.currentView, filteredArtists])

  // 4.4.40: prefetch artist photos for the visible/filtered set on mount.
  // Throttled fetch-batches of 6 at a time so we don't slam Bandsintown
  // for libraries with 200+ unique artists. The IPC handler does its own
  // per-artist 30-day disk cache, so subsequent app launches are instant.
  useEffect(() => {
    let cancelled = false
    const api = window.electronAPI as Record<string, unknown> | undefined
    const fn = api && typeof api.getArtistImage === 'function'
      ? api.getArtistImage as (artist: string) => Promise<{ ok: boolean; slug?: string | null }>
      : null
    if (!fn) return
    const names = filteredArtists
      .map(a => a.name)
      .filter(n => n && n !== 'Unknown Artist')
      .filter(n => !artistImagesRef.current.has(n))
    if (names.length === 0) return
    void (async () => {
      const BATCH = 6
      for (let i = 0; i < names.length; i += BATCH) {
        if (cancelled) return
        const batch = names.slice(i, i + BATCH)
        const results = await Promise.all(
          batch.map(async (name) => {
            try {
              const r = await fn(name)
              return [name, r.ok && r.slug ? r.slug : null] as const
            } catch {
              return [name, null] as const
            }
          })
        )
        if (cancelled) return
        setArtistImages(prev => {
          const next = new Map(prev)
          for (const [n, s] of results) next.set(n, s)
          return next
        })
      }
    })()
    return () => { cancelled = true }
    // Only re-run when the artist set CHANGES, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredArtists.map(a => a.name).join('|')])

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
    setExpandedAlbum(null)
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
      {filteredArtists.map((artist) => (
        <div key={artist.name} className="artist-group" data-artist-name={artist.name}>
          <div className="artist-row" onClick={() => toggleArtist(artist.name)}>
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
            <span className="artist-count">{artist.tracks.length} songs</span>
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
                const albumKey = `${artist.name}::${album.name}`
                const isExpanded = expandedAlbum === albumKey
                // 4.4.37: look up real album art instead of always
                // rendering a placeholder. Try the artist as-typed
                // first; fall back to lowercased artist or albumArtist
                // from any track on the album.
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
                // 4.4.40: stack layout when expanded. The 4.4.37/38 design
                // put the cover on the LEFT and the tracklist on the right
                // inside a flex column — when the tracklist was longer than
                // the cover (15-track albums, etc.) the cover left a huge
                // empty void underneath. New: cover + title/meta/Play live
                // in a HEADER row at the top; tracklist sits BELOW the
                // header spanning the full card width. Tall albums (>10
                // tracks) auto-split into 2 columns via CSS `column-count`.
                const isTall = isExpanded && album.tracks.length > 10
                return (
                  <div
                    key={albumKey}
                    className={[
                      'artist-album-card',
                      isExpanded ? 'artist-album-card--expanded' : '',
                      isTall ? 'artist-album-card--tall' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    <div className="artist-album-art" onClick={() => toggleAlbum(albumKey)}>
                      {artworkLookup ? (
                        <img
                          src={`album-art://${artworkLookup}.jpg`}
                          alt={album.name}
                          className="artist-album-art-img"
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
                      {isExpanded ? (
                        <>
                          {(() => {
                            const totalMs = album.tracks.reduce((sum, t) => sum + (Number(t.duration) || 0), 0)
                            const totalMin = Math.round(totalMs / 60000)
                            const yearStr = album.tracks.find(t => t.year)?.year
                            const totalPlays = album.tracks.reduce((sum, t) => sum + (Number(t.playCount) || 0), 0)
                            const parts: string[] = []
                            if (yearStr) parts.push(String(yearStr))
                            parts.push(`${album.tracks.length} song${album.tracks.length === 1 ? '' : 's'}`)
                            if (totalMin > 0) parts.push(`${totalMin} min`)
                            if (totalPlays > 0) parts.push(`${totalPlays.toLocaleString()} play${totalPlays === 1 ? '' : 's'}`)
                            return <div className="artist-album-meta">{parts.join(' · ')}</div>
                          })()}
                          <button
                            className="artist-album-play"
                            onClick={(e) => {
                              e.stopPropagation()
                              if (album.tracks.length > 0) playTrack(album.tracks[0], album.tracks, 0, undefined, true)
                            }}
                            title="Play this album from the top"
                          >
                            <svg width="11" height="11" viewBox="0 0 32 32" fill="currentColor"><path d="M10 7v18l16-9z" /></svg>
                            Play Album
                          </button>
                        </>
                      ) : (
                        <div className="artist-album-count">{album.tracks.length} track{album.tracks.length === 1 ? '' : 's'}</div>
                      )}
                    </div>
                    {/* 4.4.40: tracklist as a SIBLING of art + info (not a
                        child of info) so the CSS grid can put it on its own
                        row spanning both columns. */}
                    {/* Brief 032: tracklist stays in DOM at all times so
                        the album-content-wrapper can animate its height
                        on expand/collapse. */}
                    <div className={`album-content-wrapper ${isExpanded ? 'is-expanded' : ''}`}>
                      <div className="album-content-inner">
                        <div className="artist-album-tracklist">
                          {album.tracks.map((track, idx) => {
                            const isPlaying = pb.nowPlaying?.id === track.id
                            const durMs = Number(track.duration) || 0
                            const mins = Math.floor(durMs / 60000)
                            const secs = Math.floor((durMs % 60000) / 1000)
                            const durLabel = durMs ? `${mins}:${secs.toString().padStart(2, '0')}` : ''
                            return (
                              <div
                                key={track.id}
                                className={`artist-track-row ${isPlaying ? 'artist-track-row--playing' : ''}`}
                                onDoubleClick={() => playTrack(track, album.tracks, album.tracks.indexOf(track), undefined, true)}
                                onContextMenu={(e) => handleContextMenu(e, track, album.tracks, album.tracks.indexOf(track))}
                                draggable
                                onDragStart={(e) => {
                                  e.dataTransfer.setData('application/jaketunes-tracks', JSON.stringify([track.id]))
                                  e.dataTransfer.effectAllowed = 'copy'
                                }}
                              >
                                <span className="artist-track-icon">{isPlaying && <SpeakerPlayingIcon />}</span>
                                <span className="artist-track-num">{track.trackNumber || idx + 1}</span>
                                <span className="artist-track-title">{track.title}</span>
                                <span className="artist-track-time">{durLabel}</span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            </div>
          </div>
        </div>
      ))}
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
