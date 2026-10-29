/**
 * The library's right-click menus, built in ONE place so every surface that
 * shows a song or an album offers the same menu.
 *
 * Jake (2026-10-20): "i should also be able to right click the songs/albums/
 * whatever on the home page and also drag to the queue, like it is a regular
 * song in the library." The Songs view's song menu and the Albums view's album
 * menu used to be built inline in those views; they were MOVED here (not
 * copied) so the Home's shelves, launch page G and Today's pick get the very
 * same entries — and so the next change to either menu reaches every surface.
 *
 *   songMenuEntries   — SongsView's row menu (Play, Play Next / Add to Up
 *                       Next, Add to Playlist, iPod Pool, Go to Artist/Album,
 *                       Artist Radio, Star, Get Info, artwork, Download,
 *                       Cynthia!!, Delete). The host supplies what is
 *                       view-local: what "Play" plays, and the Get Info /
 *                       Delete / Cynthia surfaces it owns.
 *   albumMenuEntries  — AlbumsView's tile menu (Play front to back, Shuffle,
 *                       Live Concert Mode, queue, playlists, iPod Pool,
 *                       Island Albums, Go to Artist).
 *
 * The shared entries underneath (queue, playlists, iPod Pool, stars) stay in
 * utils/playlistMenu.ts and components/StarRating.tsx.
 */
import type { MenuEntry } from '../components/ContextMenu'
import type { useLibrary } from '../context/LibraryContext'
import type { usePlayback } from '../context/PlaybackContext'
import type { useCynthia } from '../context/CynthiaContext'
import type { Playlist, Track } from '../types'
import type { Album } from './albumGroups'
import { setNotice } from '../activity'
import { getDeckState, layOnDeck } from '../mixtapes'
import { ratingMenuEntries } from '../components/StarRating'
import { isStreamingLibrary, isDownloaded, isDownloading, downloadPaths, removeDownloadPaths } from './downloadStore'
import { canonicalArtist } from './artistAlias'
import { albumKeyOf, albumKeyFromStrings } from './albumKey'
import { toCynthiaTrack } from './cynthia'
import { sortAlbumTracks } from './albumTrackOrder'
import { addToPlaylistEntry, addToIpodPoolEntry, queueMenuEntries } from './playlistMenu'
import { liveSetFor } from '../liveSets'
import { declareLiveSet, isDeclareInFlight } from '../liveSetDeclare'
import { verifyLiveSetCompleteness } from './liveSetCompleteness'
import { islandMenuEntry } from '../components/IslandAlbumsShelf'
import { getSyncedPicksSnapshot } from '../syncedPicks'
import { openFriendShare } from '../components/FriendShareDialog'

type LibraryDispatch = ReturnType<typeof useLibrary>['dispatch']
type PlaybackDispatch = ReturnType<typeof usePlayback>['dispatch']
type OpenCynthia = ReturnType<typeof useCynthia>['openCynthia']
type PlayTrack = (track: Track, queue?: Track[], queueIndex?: number, djTransition?: boolean, freshContext?: boolean, preserveOrder?: boolean) => void

export interface SongMenuOptions {
  /** The row that was right-clicked. */
  track: Track
  /** The songs the menu acts on — the multi-selection when the row is in
   *  it (Songs view), else just [track]. */
  tracks: Track[]
  /** What "Play" plays: the host's own list from this row. */
  play: () => void
  /** The whole library (Start <artist> Radio collects from it). */
  library: Track[]
  playlists: Playlist[]
  libDispatch: LibraryDispatch
  pbDispatch: PlaybackDispatch
  /** The host's Get Info sheet / delete confirmation, for `tracks`. */
  openGetInfo: () => void
  askDelete: () => void
  /** Cynthia!! opens at the click. */
  openCynthia: OpenCynthia
  at: { x: number; y: number }
}

/** The song menu (moved verbatim from SongsView's getContextMenuItems). */
export function songMenuEntries(o: SongMenuOptions): MenuEntry[] {
  const { track, tracks: selectedTracks, libDispatch, pbDispatch } = o
  const count = selectedTracks.length
  const label = count > 1 ? `${count} Songs` : track.title

  // Collect unique artist+album combos from all selected tracks for batch artwork
  const artPairs = new Map<string, { artist: string; album: string }>()
  for (const t of selectedTracks) {
    if (t.artist && t.album) {
      const k = `${t.artist.toLowerCase().trim()}|||${t.album.toLowerCase().trim()}`
      if (!artPairs.has(k)) artPairs.set(k, { artist: t.artist, album: t.album })
    }
  }

  const artworkItems: MenuEntry[] = artPairs.size > 0 ? [
    { separator: true as const },
    {
      label: 'Add Artwork…',
      onClick: async () => {
        const file = await window.electronAPI.chooseArtworkFile()
        if (!file.ok || !file.path) return
        let failed = 0
        let lastErr = ''
        for (const { artist, album } of artPairs.values()) {
          const result = await window.electronAPI.setCustomArtwork(artist, album, file.path)
          if (result.ok && result.key && result.hash) {
            libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
          } else {
            failed += 1
            lastErr = result.error || ''
          }
        }
        // 4.4.12: surface failures so the user knows the save didn't stick.
        if (failed > 0) {
          setNotice(
            failed === 1
              ? (lastErr ? `Couldn't save artwork: ${lastErr}` : "Couldn't save artwork.")
              : `Couldn't save artwork for ${failed} albums.`,
            { kind: 'error' }
          )
        }
      },
    },
    {
      label: 'Fetch Artwork from Internet',
      onClick: async () => {
        for (const { artist, album } of artPairs.values()) {
          const result = await window.electronAPI.fetchAlbumArt(artist, album, true)
          if (result.ok && result.key && result.hash) {
            libDispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
          }
        }
      },
    },
  ] : []

  // Artist Radio: filter library by this song's artist, dispatch to
  // Toolbar so it shuffles + starts Radio Mode focused on that artist.
  // Toolbar listens on 'jaketunes-start-artist-radio'.
  //
  // Brief 031 Phase 4c: match by contributingArtists overlap. For a
  // sole-artist source track ("Lou Reed") this reduces to the
  // previous behavior — any track contributing to "Lou Reed" gets
  // included. For a collab source track ("JAY-Z & Linkin Park"
  // with contributingArtists ["JAY-Z", "Linkin Park"]), Artist
  // Radio expands to every track involving either canonical
  // contributor — better UX than matching only the literal
  // "JAY-Z & Linkin Park" string (which would have returned just
  // the same 6 collab tracks). Case-insensitive match preserves
  // the prior tolerance for casing differences.
  //
  // trackArtist stays as the displayed menu-label string (the
  // right-clicked track's `artist` field is what the user sees,
  // so that's what reads naturally in "Start X Radio").
  const trackArtist = (track.artist || '').trim()
  const sourceContribs = (
    track.contributingArtists && track.contributingArtists.length > 0
      ? track.contributingArtists
      : [trackArtist]
  )
    .map(s => (s || '').trim().toLowerCase())
    .filter(s => s.length > 0)
  const artistTracks = sourceContribs.length
    ? o.library.filter(t => {
        const candidates = (t.contributingArtists && t.contributingArtists.length > 0
          ? t.contributingArtists
          : [(t.artist || '').trim()]
        )
          .map(s => (s || '').trim().toLowerCase())
          .filter(s => s.length > 0)
        return candidates.some(c => sourceContribs.includes(c))
      })
    : []

  return [
    { label: `Play "${label}"`, onClick: o.play },
    { separator: true as const },
    ...queueMenuEntries(selectedTracks, pbDispatch),
    addToPlaylistEntry(selectedTracks, o.playlists, (pid, ids) => libDispatch({ type: 'ADD_TRACKS_TO_PLAYLIST', playlistId: pid, trackIds: ids })),
    addToIpodPoolEntry(selectedTracks),
    ...(getDeckState() ? [
      {
        label: `Lay on the tape (${selectedTracks.length} song${selectedTracks.length === 1 ? '' : 's'})`,
        onClick: () => {
          void layOnDeck(selectedTracks.map(t => t.id), (id) => selectedTracks.find(t => t.id === id)?.duration || undefined)
            .then(async (msg) => { const a = await import('../activity'); a.setNotice(msg) })
        },
      },
    ] : []),
    { separator: true as const },
    { label: 'Go to Artist', onClick: () => libDispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: canonicalArtist(track.albumArtist || track.artist || '') }) },
    { label: 'Go to Album', onClick: () => libDispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: albumKeyOf(track) }) },
    ...(trackArtist && artistTracks.length > 0 ? [
      { separator: true as const },
      {
        label: `Start ${trackArtist} Radio`,
        onClick: () => {
          window.dispatchEvent(new CustomEvent('jaketunes-start-artist-radio', {
            detail: { tracks: artistTracks, label: trackArtist },
          }))
        },
      },
    ] : []),
    ...ratingMenuEntries(selectedTracks, libDispatch),
    { separator: true as const },
    { label: 'Get Info', onClick: o.openGetInfo },
    // Friend share (2026-10-29): the message (signature + Spotify + Apple Music) and the iPod card.
    ...(count === 1 ? [{ label: 'Share Song…', onClick: () => openFriendShare({ kind: 'song', track }) }] : []),
    ...artworkItems,
    ...(isStreamingLibrary() ? (() => {
      const dlPaths = selectedTracks.map((t) => t.path).filter(Boolean) as string[]
      if (!dlPaths.length) return [] as MenuEntry[]
      const anyDownloading = dlPaths.some((p) => isDownloading(p))
      const allDownloaded = dlPaths.every((p) => isDownloaded(p))
      const entry: MenuEntry = anyDownloading
        ? { label: count > 1 ? `Downloading ${count}…` : 'Downloading…', onClick: () => {}, disabled: true }
        : allDownloaded
          ? { label: count > 1 ? `Remove ${count} Downloads` : 'Remove Download', onClick: () => { void removeDownloadPaths(dlPaths) } }
          : { label: count > 1 ? `Download ${count} Songs` : 'Download', onClick: () => { void downloadPaths(dlPaths) } }
      return [{ separator: true as const }, entry] as MenuEntry[]
    })() : []),
    { separator: true as const },
    {
      label: 'Cynthia!!',
      onClick: () => {
        o.openCynthia({
          x: o.at.x, y: o.at.y,
          scope: {
            type: 'tracks',
            label: count > 1 ? `${count} tracks` : track.title,
            tracks: selectedTracks.map(toCynthiaTrack),
          },
        })
      },
    },
    { separator: true as const },
    {
      label: count > 1 ? `Delete ${count} Songs` : 'Delete Song',
      onClick: o.askDelete,
    },
  ]
}

export interface AlbumMenuOptions {
  album: Album
  /** The whole library (a declared live set's merged track lives in it). */
  library: Track[]
  playlists: Playlist[]
  playTrack: PlayTrack
  libDispatch: LibraryDispatch
  pbDispatch: PlaybackDispatch
}

/** The album menu (moved verbatim from AlbumsView's albumMenuItems). The
 *  host keeps the live-set store loaded (ensureLiveSetsLoaded) — the menu
 *  reads it, and the Island Albums snapshot, at open time. */
export function albumMenuEntries(o: AlbumMenuOptions): MenuEntry[] {
  const { album, playTrack, libDispatch, pbDispatch } = o
  const ordered = sortAlbumTracks(album.tracks)
  const key = albumKeyFromStrings(album.artist, album.name)
  const liveSet = album.name.endsWith(' (Live Set)') ? null : liveSetFor(key, o.library)
  const mergedTrack = liveSet ? (o.library.find(t => t.id === liveSet.mergedTrackId) ?? null) : null
  const liveEntries: MenuEntry[] = liveSet && mergedTrack
    ? [{ label: 'Play Live Set', onClick: () => playTrack(mergedTrack, [mergedTrack], 0, undefined, true) }]
    : album.name.endsWith(' (Live Set)')
      ? []
      : [{
          label: 'Declare Live Concert Mode',
          onClick: () => {
            // Jake's rule: complete album only. Pre-check here so the
            // notice explains; declareLiveSet re-verifies as the gate.
            const completeness = verifyLiveSetCompleteness(ordered)
            if (!completeness.complete) {
              setNotice(`Live Mode needs the complete album — ${completeness.reason}`)
              return
            }
            if (!completeness.verifiedTotal) {
              // Unproven total needs Jake's explicit confirm — the
              // dialog lives on the album page, so send him there.
              setNotice('The files can\'t confirm the total — confirm on the album page')
              libDispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: key })
              return
            }
            if (isDeclareInFlight()) { setNotice('A live set is already merging'); return }
            setNotice(`Merging live set — ${album.name}…`)
            declareLiveSet({ albumKey: key, name: album.name, artist: album.artist, genre: ordered[0]?.genre, year: album.year, tracks: ordered })
              .then(() => setNotice(`Live set ready — ${album.name}`))
              .catch((err) => setNotice(`Live set failed: ${err instanceof Error ? err.message : String(err)}`))
          },
        }]
  const compCtx = verifyLiveSetCompleteness(ordered)
  // Read at menu-open time (the menu is rebuilt on every right-click).
  const islandEntry = islandMenuEntry(album, getSyncedPicksSnapshot().island)
  return [
    ...(compCtx.complete && compCtx.verifiedTotal
      ? [{ label: 'Play Album — front to back', onClick: () => { if (ordered.length) playTrack(ordered[0], ordered, 0, undefined, true, true) } }]
      : []),
    { label: `Play "${album.name}"`, onClick: () => { if (ordered.length) playTrack(ordered[0], ordered, 0, undefined, true, /* running order is the record */ true) } },
    { label: 'Shuffle', onClick: () => { const s = [...ordered].sort(() => Math.random() - 0.5); if (s.length) playTrack(s[0], s, 0, undefined, true) } },
    ...(liveEntries.length ? [{ separator: true as const }, ...liveEntries] : []),
    { separator: true as const },
    ...queueMenuEntries(ordered, pbDispatch),
    addToPlaylistEntry(ordered, o.playlists, (pid, ids) => libDispatch({ type: 'ADD_TRACKS_TO_PLAYLIST', playlistId: pid, trackIds: ids })),
    addToIpodPoolEntry(ordered),
    ...(islandEntry ? [islandEntry] : []),
    ...(ordered.length ? [{ label: 'Share Album…', onClick: () => openFriendShare({ kind: 'album', track: ordered[0], albumTracks: ordered }) }] : []),
    { separator: true as const },
    { label: 'Go to Artist', onClick: () => libDispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: canonicalArtist(album.artist || '') }) },
  ]
}
