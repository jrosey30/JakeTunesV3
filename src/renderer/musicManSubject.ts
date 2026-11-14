/**
 * What the Music Man is asked about when Jake presses the mic: the page he is
 * on, else the song that's playing (Jake, 2026-11-13: "if he sees im on the
 * artist page, he should know about the artist, if album know about the
 * album").
 *
 *   album page            that album
 *   artist page           that artist
 *   a playlist            that playlist
 *   an iPod's list        that list, with what it is for
 *   anywhere else         the song playing; nothing playing, nothing to ask
 *
 * Pure: the Toolbar's mic and the drawer's chat both ask this, so they can
 * never disagree about what "this" is. node --test loads it
 * (__tests__/music-man-subject.test.ts).
 */
import type { AskSubject } from '../common/music-man-packet'

export interface SubjectPage {
  currentView: string
  activeArtist: string | null
  pendingAlbumKey: string | null
  activePlaylistId: string | null
  activeSmartPlaylist: string | null
  playlists: ReadonlyArray<{ id: string; name: string; trackIds: number[] }>
  tracks: ReadonlyArray<{ id: number; artist?: string; albumArtist?: string; album?: string; year?: string | number }>
}

export interface SubjectIpodList { id: string; name: string; purpose: string | null; ids: number[] }

const IPOD_LIST_PREFIX = 'ipod-list-'

/** ⚠️ TWIN: utils/albumKey.ts albumKeyFromStrings (the album page's own key). */
const albumKeyOf = (artist: string | undefined, album: string | undefined): string =>
  `${(artist || 'Unknown Artist').toLowerCase().trim()}|||${(album || 'Unknown').toLowerCase().trim()}`

export function askSubjectFor(
  page: SubjectPage,
  nowPlaying: { id: number } | null | undefined,
  ipodLists: ReadonlyArray<SubjectIpodList> = [],
): AskSubject | null {
  if (page.currentView === 'album-detail' && page.pendingAlbumKey) {
    const t = page.tracks.find((tk) => albumKeyOf(tk.albumArtist || tk.artist, tk.album) === page.pendingAlbumKey)
    if (t?.album) {
      return { kind: 'album', artist: t.albumArtist || t.artist || '', album: t.album, year: t.year ? String(t.year) : undefined }
    }
  }
  if (page.currentView === 'artist-detail' && page.activeArtist) return { kind: 'artist', name: page.activeArtist }
  if (page.currentView === 'playlist' && page.activePlaylistId) {
    const pl = page.playlists.find((p) => p.id === page.activePlaylistId)
    if (pl && pl.trackIds.length) return { kind: 'list', what: 'playlist', name: pl.name, trackIds: pl.trackIds }
  }
  if (page.currentView === 'smart-playlist' && page.activeSmartPlaylist?.startsWith(IPOD_LIST_PREFIX)) {
    const id = page.activeSmartPlaylist.slice(IPOD_LIST_PREFIX.length)
    const list = ipodLists.find((l) => l.id === id)
    if (list && list.ids.length) return { kind: 'list', what: 'ipod', name: list.name, trackIds: list.ids, purpose: list.purpose || undefined }
  }
  return nowPlaying ? { kind: 'song', trackId: nowPlaying.id } : null
}

/** The mic's tooltip: what a press will ask about. */
export function askSubjectHint(subject: AskSubject | null): string {
  if (!subject) return 'Ask the Music Man: open an album, an artist or a playlist, or play something'
  const what = subject.kind === 'album' ? `the album “${subject.album}”`
    : subject.kind === 'artist' ? subject.name
      : subject.kind === 'list' ? `“${subject.name}”`
        : 'this song'
  return `Ask the Music Man about ${what} (right-click: toggle bubble)`
}
