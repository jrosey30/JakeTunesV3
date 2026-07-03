import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio, prefetchTrackForPlay } from '../hooks/useAudio'
import { buildNormalizedArtworkIndex, lookupArtwork, queueArtworkResolutions } from '../utils/artworkLookup'
import { prefetchAlbumArtHashes } from '../utils/artworkPrefetch'
import AlbumArtImage from '../components/AlbumArtImage'
import ContextMenu, { MenuEntry } from '../components/ContextMenu'
import EmptyState from '../components/EmptyState'
import { SpeakerPlayingIcon } from '../assets/icons/SpeakerIcon'
import { albumKeyFromStrings } from '../utils/albumKey'
import { canonicalArtist } from '../utils/artistAlias'
import { groupTracksIntoAlbums, type Album } from '../utils/albumGroups'
import type { Track } from '../types'
import '../styles/coverflow.css'

/// V5 facelift: Cover Flow — reimagined as THE JUKEBOX ARC (Jake's pick
/// over the classic Apple side-scroll rolodex). Same capability —
/// alphabetical order, snap-to-center, title plate, track list below —
/// different motion language: covers are pages in a Seeburg-style
/// jukebox mechanism. The focused cover faces you; advancing swings it
/// UP AND OVER the top (rotateX around a pivot at its top edge) while
/// the next sleeve rises from the queue below into face-on position.
/// Already-flipped pages hang folded above/behind; upcoming pages peek
/// below, tilted back like queued title strips.
///
/// Rendering: CSS 3D transforms on real <img> nodes (the CrateBrowse
/// precedent), -webkit-box-reflect floor, and a virtualized mount window
/// (~17 covers in the DOM regardless of library size, keyed by album key
/// so covers REPOSITION rather than remount).
///
/// Interaction model stays DISCRETE-STEP + snap transition (the snap IS
/// the mechanism's feel). Wheel and VERTICAL drag accumulate into
/// whole-page flips; ←→ and ↑↓ step; clicking a peeking page jumps to
/// it; double-clicking the focused cover plays the album.

const WINDOW_RADIUS = 8      // covers mounted each side of center
const MAX_VISIBLE = 4        // pages shown in the mechanism before fading out
const WHEEL_STEP_PX = 48     // accumulated wheel delta per page flip
const DRAG_STEP_PX = 70      // vertical drag distance per page flip

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return ''
  const totalSecs = Math.floor(ms / 1000)
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

interface CoverFlowViewProps {
  tracks: Track[]
  emptyNoun: string
}

export default function CoverFlowView({ tracks, emptyNoun }: CoverFlowViewProps) {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { state: pb, dispatch: pbDispatch } = usePlayback()
  const { playTrack } = useAudio()

  const albums = useMemo(() => groupTracksIntoAlbums(tracks), [tracks])
  const [idx, setIdx] = useState(0)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; album: Album } | null>(null)

  // Keep the index valid when the underlying list changes (search filter,
  // library edits) — clamp rather than reset so small changes don't yank
  // the carousel back to the start.
  useEffect(() => {
    setIdx(i => Math.max(0, Math.min(albums.length - 1, i)))
  }, [albums.length])

  const go = useCallback((delta: number) => {
    setIdx(i => Math.max(0, Math.min(albums.length - 1, i + delta)))
  }, [albums.length])

  // ── Artwork: same lookup + idle-resolution + prefetch chain as
  // AlbumsView/TrackGridView, but window-centered instead of top-N.
  const normalizedArtIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])
  const findArtHash = useCallback((album: Album): string | undefined => {
    for (const artist of album.artists) {
      const hit = lookupArtwork(lib.artworkMap, normalizedArtIndex, artist, album.name)
      if (hit) return hit
    }
    return lookupArtwork(lib.artworkMap, normalizedArtIndex, album.artist, album.name)
  }, [lib.artworkMap, normalizedArtIndex])

  useEffect(() => {
    const from = Math.max(0, idx - WINDOW_RADIUS - 6)
    const to = Math.min(albums.length, idx + WINDOW_RADIUS + 7)
    const around = albums.slice(from, to)
    const missing = around.filter(a => !findArtHash(a))
    if (missing.length > 0) {
      queueArtworkResolutions(
        missing.map(a => ({ artist: a.artist || a.artists[0] || '', album: a.name })),
        libDispatch,
      )
    }
    prefetchAlbumArtHashes(around.map(a => findArtHash(a)))
  }, [idx, albums, findArtHash, libDispatch, lib.artworkMap])

  // ── Input: keyboard (scoped to the view root, not window — other views
  // and the global transport own their own keys), wheel, and drag all
  // accumulate into discrete cover steps.
  const rootRef = useRef<HTMLDivElement>(null)
  const wheelAcc = useRef(0)
  const onWheel = useCallback((e: React.WheelEvent) => {
    // Horizontal intent wins when present (trackpads); vertical scrolls
    // over the stage also flip covers, like iTunes.
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    wheelAcc.current += delta
    while (wheelAcc.current >= WHEEL_STEP_PX) { wheelAcc.current -= WHEEL_STEP_PX; go(1) }
    while (wheelAcc.current <= -WHEEL_STEP_PX) { wheelAcc.current += WHEEL_STEP_PX; go(-1) }
  }, [go])

  // Jukebox arc: the natural drag axis is VERTICAL (you flip pages up and
  // over). Dominant-axis detection keeps horizontal trackpad habits alive.
  const drag = useRef<{ startX: number; startY: number; startIdx: number; moved: boolean } | null>(null)
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    drag.current = { startX: e.clientX, startY: e.clientY, startIdx: idx, moved: false }
  }, [idx])
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) d.moved = true
    // Drag UP = flip forward (page swings over the top); right also advances.
    const delta = Math.abs(dy) >= Math.abs(dx) ? -dy : -dx
    const steps = Math.round(delta / DRAG_STEP_PX)
    const next = Math.max(0, Math.min(albums.length - 1, d.startIdx + steps))
    setIdx(next)
  }, [albums.length])
  const onPointerUp = useCallback(() => { drag.current = null }, [])
  const dragMoved = () => drag.current?.moved ?? false

  // stopPropagation on handled keys is LOAD-BEARING: App.tsx has a
  // document-level transport handler (←→ = next/prev track, ↑↓ = volume)
  // and preventDefault alone doesn't stop the bubble — without this, one
  // arrow press flips the mechanism AND skips the song / moves the volume
  // (the same arrows-bleed bug SongsView fixed 2026-06-24; caught live
  // here too). ↑↓ are first-class here — the jukebox flips vertically.
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); go(-1) }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); go(1) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      const album = albums[idx]
      if (album && album.tracks.length) playTrack(album.tracks[0], album.tracks, 0, undefined, true)
    }
  }, [go, albums, idx, playTrack])

  const albumMenuItems = useCallback((album: Album): MenuEntry[] => {
    const ordered = album.tracks
    return [
      { label: `Play "${album.name}"`, onClick: () => { if (ordered.length) playTrack(ordered[0], ordered, 0, undefined, true) } },
      { label: 'Shuffle', onClick: () => { const s = [...ordered].sort(() => Math.random() - 0.5); if (s.length) playTrack(s[0], s, 0, undefined, true) } },
      { separator: true as const },
      { label: 'Play Next', onClick: () => pbDispatch({ type: 'PLAY_NEXT', tracks: ordered }) },
      { label: 'Add to Up Next', onClick: () => pbDispatch({ type: 'ADD_TO_QUEUE', tracks: ordered }) },
      { separator: true as const },
      { label: 'Go to Album', onClick: () => libDispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: albumKeyFromStrings(album.artist, album.name) }) },
      { label: 'Go to Artist', onClick: () => libDispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: canonicalArtist(album.artist || '') }) },
    ]
  }, [playTrack, pbDispatch, libDispatch])

  if (albums.length === 0) {
    return <EmptyState query={lib.searchQuery} noun={emptyNoun} />
  }

  const current = albums[Math.max(0, Math.min(albums.length - 1, idx))]

  // Virtualized mount window: only WINDOW_RADIUS covers each side exist
  // in the DOM. Keys are stable album keys, so as the window slides a
  // cover that stays visible keeps its node (no remount → no img reload).
  const from = Math.max(0, idx - WINDOW_RADIUS)
  const to = Math.min(albums.length, idx + WINDOW_RADIUS + 1)
  const windowed = albums.slice(from, to)

  return (
    <div
      className="coverflow-view"
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div
        className="coverflow-stage"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <div className="coverflow-fan">
          {windowed.map((album, wi) => {
            const i = from + wi
            const off = i - idx
            const depth = Math.min(Math.abs(off), MAX_VISIBLE + 1)
            const key = albumKeyFromStrings(album.artist, album.name)
            const artHash = findArtHash(album)
            const active = i === idx
            // The jukebox mechanism (transform-origin is the page's TOP
            // edge, set in coverflow.css):
            //   focused (off 0)  — face-on, pulled toward the viewer
            //   flipped (off<0)  — swung up and over the top pivot,
            //                      hanging folded above/behind (rotateX
            //                      past ~115°), receding with depth
            //   queued  (off>0)  — waiting below, tilted back like title
            //                      strips, each peeking under the last
            const style: CSSProperties = active
              ? {
                  transform: 'translateY(0) translateZ(110px) rotateX(0deg)',
                  zIndex: 100,
                  opacity: 1,
                }
              : off < 0
                ? {
                    transform: `translateY(${-24 - depth * 10}px) translateZ(${60 - depth * 44}px) rotateX(${115 + depth * 9}deg)`,
                    zIndex: 96 - depth,
                    opacity: depth > MAX_VISIBLE ? 0 : Math.max(0.15, 1 - depth * 0.28),
                    pointerEvents: depth > MAX_VISIBLE ? 'none' : 'auto',
                  }
                : {
                    transform: `translateY(${34 + depth * 26}px) translateZ(${40 - depth * 48}px) rotateX(${-14 - depth * 5}deg)`,
                    zIndex: 90 - depth,
                    opacity: depth > MAX_VISIBLE ? 0 : Math.max(0.2, 1 - depth * 0.2),
                    pointerEvents: depth > MAX_VISIBLE ? 'none' : 'auto',
                  }
            return (
              <button
                key={key}
                type="button"
                className={`coverflow-card${active ? ' coverflow-card--active' : ''}`}
                style={style}
                onClick={() => { if (!dragMoved() && !active) setIdx(i) }}
                onDoubleClick={() => { if (active && album.tracks.length) playTrack(album.tracks[0], album.tracks, 0, undefined, true) }}
                onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, album }) }}
                title={active ? `Play "${album.name}"` : album.name}
                aria-label={album.name}
              >
                {artHash ? (
                  <AlbumArtImage hash={artHash} alt={album.name} className="coverflow-cover" priority={depth <= 2} />
                ) : (
                  <span className="coverflow-blank">
                    <svg width="44" height="44" viewBox="0 0 32 32" fill="none" aria-hidden="true">
                      <circle cx="16" cy="16" r="14" stroke="#8a8378" strokeWidth="1" />
                      <circle cx="16" cy="16" r="5" stroke="#8a8378" strokeWidth="1" />
                      <circle cx="16" cy="16" r="1.5" fill="#8a8378" />
                    </svg>
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      <div className="coverflow-plate">
        <div className="coverflow-plate-title">{current.name}</div>
        <div className="coverflow-plate-artist">{current.artist}</div>
        <div className="coverflow-plate-counter">{idx + 1} / {albums.length}</div>
      </div>

      <div className="coverflow-tracklist">
        {current.tracks.map((track, i) => {
          const isPlaying = pb.nowPlaying?.id === track.id
          return (
            <div
              key={track.id}
              className={`coverflow-track-row${i % 2 ? ' coverflow-track-row--alt' : ''}${isPlaying ? ' coverflow-track-row--playing' : ''}`}
              onDoubleClick={() => playTrack(track, current.tracks, i, undefined, true)}
              onMouseEnter={() => prefetchTrackForPlay(track)}
            >
              <span className="coverflow-track-icon">{isPlaying && <SpeakerPlayingIcon />}</span>
              <span className="coverflow-track-num">{i + 1}</span>
              <span className="coverflow-track-title">{track.title}</span>
              <span className="coverflow-track-artist">{track.artist}</span>
              <span className="coverflow-track-time">{formatDuration(track.duration)}</span>
            </div>
          )
        })}
      </div>

      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={albumMenuItems(ctxMenu.album)} onClose={() => setCtxMenu(null)} />
      )}
    </div>
  )
}
