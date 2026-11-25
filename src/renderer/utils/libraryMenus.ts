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
 *   songMenuEntries   — every song list's row menu (components/SongTable.tsx)
 *                       and the Home's song cards, in one order (V7). The
 *                       host supplies what is its own: Get Info, Delete,
 *                       its extra entries, and (cards only) what Play plays.
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
import { downloadMenuEntries } from './downloadStore'
import { canonicalArtist } from './artistAlias'
import { compareAlbumNames } from './artistSort'
import { albumKeyOf, albumKeyFromStrings } from './albumKey'
import { toCynthiaTrack } from './cynthia'
import { sortAlbumTracks } from './albumTrackOrder'
import { addToPlaylistEntry, queueMenuEntries } from './playlistMenu'
import { addToIpodPlaylistEntries } from '../ipodPlaylistAdd'
import { liveSetFor } from '../liveSets'
import { declareLiveSet, isDeclareInFlight } from '../liveSetDeclare'
import { verifyLiveSetCompleteness } from './liveSetCompleteness'
import { islandMenuEntry } from '../components/IslandAlbumsShelf'
import { getSyncedPicksSnapshot } from '../syncedPicks'
import { openFriendShare } from '../components/FriendShareDialog'
import { assembleSongMenu } from './songTableRules'
import { shuffle } from '../../common/shuffle'

type LibraryDispatch = ReturnType<typeof useLibrary>['dispatch']
type PlaybackDispatch = ReturnType<typeof usePlayback>['dispatch']
type OpenCynthia = ReturnType<typeof useCynthia>['openCynthia']
type PlayTrack = (track: Track, queue?: Track[], queueIndex?: number, djTransition?: boolean, freshContext?: boolean, preserveOrder?: boolean) => void

export interface SongMenuOptions {
  /** The row that was right-clicked. */
  track: Track
  /** The songs the menu acts on — the multi-selection when the row is in
   *  it, else just [track]. */
  tracks: Track[]
  /** What "Play" plays. Only a surface with no double-click to play passes
   *  it (the Home's cards); the song table's rows play on double-click and
   *  Return, so its menu starts at Play Next. */
  play?: () => void
  /** The whole library (Start <artist> Radio collects from it). */
  library: Track[]
  playlists: Playlist[]
  libDispatch: LibraryDispatch
  pbDispatch: PlaybackDispatch
  /** The host's Get Info sheet / delete confirmation, for `tracks`. */
  openGetInfo: () => void
  /** "Delete Song" (from the library). Absent = the page doesn't offer it
   *  (a playlist: Remove from Playlist sits there instead, 4.4.10). */
  askDelete?: () => void
  /** Its words, where "Delete Song" would read as "out of this list" (a
   *  playlist says "Delete from Library"). */
  deleteLabel?: string
  /** The page's own entries (Remove from Playlist, Make a Mixtape…), after
   *  the shared ones and before Delete. */
  extras?: MenuEntry[]
  /** Cynthia opens at the click. */
  openCynthia: OpenCynthia
  at: { x: number; y: number }
}

/**
 * The song menu — every song list's and the Home's (V7: one order everywhere,
 * utils/songTableRules.ts assembleSongMenu): Play Next, Add to Up Next, Add to
 * Playlist ▸, Add to iPod Playlist ▸, Go to Album, Go to Artist, Star,
 * Download, Share…, Get Info; then radio, the tape, artwork, Cynthia; then
 * the page's own; then Delete Song where the page offers it.
 */
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

  const star = ratingMenuEntries(selectedTracks, libDispatch).find((m) => !m.separator)!
  const download = (downloadMenuEntries(selectedTracks).find((m) => !m.separator)) as MenuEntry | undefined

  return assembleSongMenu({
    play: o.play ? { label: `Play "${label}"`, onClick: o.play } : undefined,
    queue: queueMenuEntries(selectedTracks, pbDispatch),
    playlist: addToPlaylistEntry(selectedTracks, o.playlists, (pid, ids) => libDispatch({ type: 'ADD_TRACKS_TO_PLAYLIST', playlistId: pid, trackIds: ids })),
    ipodPlaylist: addToIpodPlaylistEntries(selectedTracks, o.library)[0],
    goAlbum: { label: 'Go to Album', onClick: () => libDispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: albumKeyOf(track) }) },
    goArtist: { label: 'Go to Artist', onClick: () => libDispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: canonicalArtist(track.albumArtist || track.artist || '') }) },
    star,
    download,
    // Friend share (2026-10-29): the message (signature + Spotify + Apple Music) and the iPod card. One song at a time.
    share: count === 1
      ? { label: 'Share…', onClick: () => openFriendShare({ kind: 'song', track }) }
      : { label: 'Share…', disabled: true },
    getInfo: { label: 'Get Info', onClick: o.openGetInfo },
    more: [
      ...(trackArtist && artistTracks.length > 0 ? [{
        label: `Start ${trackArtist} Radio`,
        onClick: () => {
          window.dispatchEvent(new CustomEvent('jaketunes-start-artist-radio', {
            detail: { tracks: artistTracks, label: trackArtist },
          }))
        },
      }] : []),
      ...(getDeckState() ? [{
        label: `Add to Tape (${count} song${count === 1 ? '' : 's'})`,
        onClick: () => {
          void layOnDeck(selectedTracks.map(t => t.id), (id) => selectedTracks.find(t => t.id === id)?.duration || undefined)
            .then(async (msg) => { const a = await import('../activity'); a.setNotice(msg) })
        },
      }] : []),
      ...artworkItems.filter((m) => !m.separator),
      {
        label: 'Cynthia',
        onClick: () => {
          o.openCynthia({
            x: o.at.x, y: o.at.y,
            scope: {
              type: 'tracks',
              label: count > 1 ? `${count} songs` : track.title,
              tracks: selectedTracks.map(toCynthiaTrack),
            },
          })
        },
      },
    ],
    extras: o.extras ?? [],
    del: o.askDelete ? { label: o.deleteLabel ?? (count > 1 ? `Delete ${count} Songs` : 'Delete Song'), onClick: o.askDelete } : undefined,
  })
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
    ? [{ label: 'Play Live Album', onClick: () => playTrack(mergedTrack, [mergedTrack], 0, undefined, true) }]
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
            if (isDeclareInFlight()) { setNotice('A live album is already merging'); return }
            setNotice(`Merging live album — ${album.name}…`)
            declareLiveSet({ albumKey: key, name: album.name, artist: album.artist, genre: ordered[0]?.genre, year: album.year, tracks: ordered })
              .then(() => setNotice(`Live album ready — ${album.name}`))
              .catch((err) => setNotice(`Live album failed: ${err instanceof Error ? err.message : String(err)}`))
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
    { label: 'Shuffle', onClick: () => { const s = shuffle(ordered); if (s.length) playTrack(s[0], s, 0, undefined, true) } },
    ...(liveEntries.length ? [{ separator: true as const }, ...liveEntries] : []),
    { separator: true as const },
    ...queueMenuEntries(ordered, pbDispatch),
    addToPlaylistEntry(ordered, o.playlists, (pid, ids) => libDispatch({ type: 'ADD_TRACKS_TO_PLAYLIST', playlistId: pid, trackIds: ids })),
    ...addToIpodPlaylistEntries(ordered, ordered),
    ...(islandEntry ? [islandEntry] : []),
    ...(ordered.length ? [{ label: 'Share Album…', onClick: () => openFriendShare({ kind: 'album', track: ordered[0], albumTracks: ordered }) }] : []),
    { separator: true as const },
    { label: 'Go to Artist', onClick: () => libDispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: canonicalArtist(album.artist || '') }) },
  ]
}

/** An artist's songs the way the Artists tile's ▶ plays them: album by album
 *  (A–Z by album name), each in disc and track order. */
export function artistRunningOrder(tracks: Track[]): Track[] {
  const n = (v: number | string | undefined): number => Number(v) || 0
  return [...tracks].sort((x, y) => compareAlbumNames(x.album || '', y.album || '') || n(x.discNumber) - n(y.discNumber) || n(x.trackNumber) - n(y.trackNumber))
}

export interface ArtistMenuOptions {
  name: string
  /** The artist's songs (any order; the menu plays them in running order). */
  tracks: Track[]
  playlists: Playlist[]
  playTrack: PlayTrack
  libDispatch: LibraryDispatch
  pbDispatch: PlaybackDispatch
}

/** The artist menu (V7, 2026-11-24): every artist tile — the Artists grid,
 *  Home's Top Artists and Rediscover, the shop's artist cards — offers these
 *  lines. Before this the Artists grid had no menu at all. */
export function artistMenuEntries(o: ArtistMenuOptions): MenuEntry[] {
  const { name, playTrack, libDispatch, pbDispatch } = o
  const ordered = artistRunningOrder(o.tracks)
  const label = name || 'this artist'
  return [
    { label: `Play "${label}"`, disabled: !ordered.length, onClick: () => { if (ordered.length) playTrack(ordered[0], ordered, 0, undefined, true, true) } },
    { label: 'Shuffle', disabled: !ordered.length, onClick: () => { const s = [...ordered].sort(() => Math.random() - 0.5); if (s.length) playTrack(s[0], s, 0, undefined, true) } },
    ...(ordered.length ? [{
      label: `Start ${label} Radio`,
      onClick: () => { window.dispatchEvent(new CustomEvent('jaketunes-start-artist-radio', { detail: { tracks: ordered, label: name } })) },
    }] : []),
    { separator: true as const },
    ...queueMenuEntries(ordered, pbDispatch),
    addToPlaylistEntry(ordered, o.playlists, (pid, ids) => libDispatch({ type: 'ADD_TRACKS_TO_PLAYLIST', playlistId: pid, trackIds: ids })),
    ...addToIpodPlaylistEntries(ordered, ordered),
    { separator: true as const },
    { label: 'Go to Artist', onClick: () => libDispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: canonicalArtist(name) }) },
  ]
}

export interface PlaylistMenuOptions {
  name: string
  /** The playlist's songs in its own order. */
  tracks: Track[]
  /** What clicking the card does (its page). */
  open: () => void
  playlists: Playlist[]
  playTrack: PlayTrack
  libDispatch: LibraryDispatch
  pbDispatch: PlaybackDispatch
}

/** The playlist menu (V7): playlists, mixes and Home rows that open a
 *  playlist all offer these lines. */
export function playlistMenuEntries(o: PlaylistMenuOptions): MenuEntry[] {
  const { tracks, playTrack, libDispatch, pbDispatch } = o
  return [
    { label: `Play "${o.name}"`, disabled: !tracks.length, onClick: () => { if (tracks.length) playTrack(tracks[0], tracks, 0, undefined, true, true) } },
    { label: 'Shuffle', disabled: !tracks.length, onClick: () => { const s = [...tracks].sort(() => Math.random() - 0.5); if (s.length) playTrack(s[0], s, 0, undefined, true) } },
    { separator: true as const },
    ...queueMenuEntries(tracks, pbDispatch),
    addToPlaylistEntry(tracks, o.playlists, (pid, ids) => libDispatch({ type: 'ADD_TRACKS_TO_PLAYLIST', playlistId: pid, trackIds: ids })),
    ...addToIpodPlaylistEntries(tracks, tracks),
    { separator: true as const },
    { label: 'Open', onClick: o.open },
  ]
}

export interface ConcertMenuOptions {
  /** The show's one merged recording. */
  merged: Track
  band: string
  /** Opens the show's page (what clicking its row does). */
  open: () => void
  playlists: Playlist[]
  playTrack: PlayTrack
  libDispatch: LibraryDispatch
  pbDispatch: PlaybackDispatch
}

/** A declared concert's menu (V7): the Concerts page's rows had none. A show
 *  is one recording, so it queues and lands on playlists as that one track. */
export function concertMenuEntries(o: ConcertMenuOptions): MenuEntry[] {
  const { merged, playTrack, libDispatch, pbDispatch } = o
  return [
    { label: 'Play the Show', onClick: () => playTrack(merged, [merged], 0, undefined, true) },
    { label: 'Open', onClick: o.open },
    { separator: true as const },
    ...queueMenuEntries([merged], pbDispatch),
    addToPlaylistEntry([merged], o.playlists, (pid, ids) => libDispatch({ type: 'ADD_TRACKS_TO_PLAYLIST', playlistId: pid, trackIds: ids })),
    { separator: true as const },
    ...(o.band ? [{ label: 'Go to Artist', onClick: () => libDispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: canonicalArtist(o.band) }) }] : []),
  ]
}
