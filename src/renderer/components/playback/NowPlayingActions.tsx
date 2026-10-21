/**
 * Act on what's playing, from the toolbar pill (parity audit #7).
 *
 * The phone's Now Playing lets you tap the artist name to open the artist's
 * page and the album name to open the album page, and its cover menu stars
 * the song, adds it to a playlist, opens Get Info and goes to the album or
 * artist (NowPlayingView ordinaryTitleBlock, IPodTouchNowPlaying coverMenu).
 * The desktop pill had none of it. In the desktop's own idiom:
 *
 *   • click the ARTIST line → the artist page; the ALBUM line → the album
 *     page (the song menu's own Go to Artist / Go to Album targets);
 *   • right-click the song / artist / album → the library's song menu
 *     (utils/libraryMenus.ts via HomeItemMenus — Star, Add to Playlist, Get
 *     Info, Go to Album / Artist, …), the same menu a library row opens.
 *
 * Only while the pill shows the playing song: not over an import / sync /
 * notice / caption, not over a store preview, and — like the phone's concert
 * line, which has no taps — no click-through while a live concert plays (its
 * lines are the setlist song and "3/16"). The right-click menu still works on
 * a concert, minus Delete (removing a show is the concert page's job).
 *
 * Why delegation, not handlers inside NowPlaying.tsx: NowPlaying is on
 * CLAUDE.md's Do-Not-Touch list. This wrapper is `display: contents` (no box,
 * so the pill's flex layout is unchanged) and reads the clicked element's
 * class — names locked by src/main/__tests__/now-playing-actions.test.ts.
 */
import { useCallback, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { usePlayback } from '../../context/PlaybackContext'
import { useLibrary } from '../../context/LibraryContext'
import { useAudio } from '../../hooks/useAudio'
import { useHomeItemMenusHost } from '../HomeItemMenus'
import { subscribePreview, getPreviewSnapshot } from '../../previewPlayer'
import { subscribeLiveSets, getLiveSetsSnapshot, mergedTrackIndex } from '../../liveSets'
import { canonicalArtist } from '../../utils/artistAlias'
import { albumKeyOf } from '../../utils/albumKey'
import type { Track } from '../../types'

const previewPlaying = (): boolean => getPreviewSnapshot().playingId != null

/** The pill's song lines, when they are showing the playing song. */
function songLinesAt(target: EventTarget | null): HTMLElement | null {
  const el = target instanceof Element ? target : null
  const info = el?.closest<HTMLElement>('.now-playing-info--stacked') ?? null
  const pill = info?.closest('.now-playing-pill')
  if (!info || !pill || pill.classList.contains('now-playing-pill--activity')) return null
  if (previewPlaying()) return null
  return info
}

export function artistPageFor(track: Track): string {
  return canonicalArtist(track.albumArtist || track.artist || '')
}

export default function NowPlayingActions({ children }: { children: ReactNode }) {
  const { state: pb } = usePlayback()
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { playTrack } = useAudio()
  const { api, overlays } = useHomeItemMenusHost(playTrack)
  const preview = useSyncExternalStore(subscribePreview, previewPlaying)
  useSyncExternalStore(subscribeLiveSets, getLiveSetsSnapshot)
  const track = pb.nowPlaying
  const isConcert = !!track && mergedTrackIndex().has(track.id)
  // What the hover affordance may promise (toolbar.css reads it).
  const mode = !track || preview ? undefined : isConcert ? 'concert' : 'song'

  const onClick = useCallback((e: React.MouseEvent) => {
    if (!track || isConcert || !songLinesAt(e.target)) return
    const el = e.target as Element
    if (el.closest('.now-playing-artist')) {
      const artistName = artistPageFor(track)
      if (artistName) libDispatch({ type: 'VIEW_ARTIST_DETAIL', artistName })
    } else if (el.closest('.now-playing-album')) {
      if (track.album) libDispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: albumKeyOf(track) })
    }
  }, [track, isConcert, libDispatch])

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    if (!track || !songLinesAt(e.target)) return
    // The library's copy: the playing snapshot doesn't see a Star or an edit
    // made since it started.
    const song = lib.tracks.find((t) => t.id === track.id) ?? track
    const queue = pb.queue.length ? pb.queue : [song]
    const at = Math.max(0, queue.findIndex((t) => t.id === song.id))
    api.openSongMenu(e, song, () => playTrack(song, queue, at), [song], 0, { omitDelete: isConcert })
  }, [track, isConcert, lib.tracks, pb.queue, api, playTrack])

  return (
    <div className="np-actions" data-np-actions={mode} onClick={onClick} onContextMenu={onContextMenu}>
      {children}
      {createPortal(overlays, document.body)}
    </div>
  )
}
