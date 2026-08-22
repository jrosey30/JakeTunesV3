/**
 * "Add to Playlist ▸" — the context-menu entry, built once and shared by every
 * view that lists songs.
 *
 * Jake (2026-07-26): "there should be an add to playlist option when you right
 * click songs." Before this, the only ways into a playlist were dragging rows
 * onto the sidebar or the add box inside PlaylistView — neither discoverable
 * from the song list itself.
 *
 * Eleven views build their own track context menu. This lives in one place so
 * the entry can't drift between them: the list of playlists, the ordering, the
 * duplicate handling, and the confirmation wording are defined here only.
 */
import type { MenuEntry } from '../components/ContextMenu'
import type { Playlist, Track } from '../types'
import { setNotice } from '../activity'

/** iPod-imported playlists whose names duplicate the built-in smart playlists.
 *  The sidebar hides them, and they're rule-driven, so a manual add would be
 *  silently recomputed away — they never appear as a drop target.
 *
 *  ⚠️ TWIN: consumed by components/sidebar/Sidebar.tsx for the PLAYLISTS
 *  section. Defined here so the sidebar list and the menu list are the same
 *  list; if these two ever disagree, the menu offers a playlist the user
 *  cannot see. */
export const SMART_PLAYLIST_NAMES = new Set([
  `Best of ${new Date().getFullYear()}`,
  'Recently Added', 'Recently Played', 'Top 25 Most Played', 'My Top Rated', 'Starred',
  "Songs You'd Star",
  'Classical Music', // empty iPod smart playlist
])

/** The playlists a song can actually be added to, in the order the sidebar
 *  shows them — so the submenu reads top-to-bottom like the sidebar does.
 *  Synced sets are excluded: they're activity-sync output with their own
 *  section, not hand-curated lists. */
export function manualPlaylists(playlists: Playlist[]): Playlist[] {
  return playlists.filter(pl => !SMART_PLAYLIST_NAMES.has(pl.name) && pl.category !== 'synced-set')
}

/**
 * Build the entry. `addTracks` is passed in rather than a dispatch so this
 * module doesn't need LibraryContext's non-exported action union; every caller
 * hands over the same ADD_TRACKS_TO_PLAYLIST dispatch.
 */
export function addToPlaylistEntry(
  tracks: Track[],
  playlists: Playlist[],
  addTracks: (playlistId: string, trackIds: number[]) => void,
): MenuEntry {
  const targets = manualPlaylists(playlists)
  const ids = tracks.map(t => t.id)
  const noun = ids.length === 1 ? 'song' : `${ids.length} songs`

  if (targets.length === 0) {
    return { label: 'Add to Playlist', disabled: true }
  }

  return {
    label: 'Add to Playlist',
    submenu: targets.map(pl => {
      // The reducer already drops ids the playlist holds, so adding twice is
      // harmless — but saying "added" when nothing moved is a small lie, and
      // this is the only feedback the user gets. Work out the real delta.
      const have = new Set(pl.trackIds)
      const fresh = ids.filter(id => !have.has(id))
      return {
        label: pl.name,
        onClick: () => {
          if (fresh.length === 0) {
            setNotice(
              ids.length === 1
                ? `Already in “${pl.name}”.`
                : `All ${ids.length} songs are already in “${pl.name}”.`,
            )
            return
          }
          addTracks(pl.id, fresh)
          const skipped = ids.length - fresh.length
          setNotice(
            skipped > 0
              ? `Added ${fresh.length} of ${noun} to “${pl.name}” — ${skipped} already there.`
              : `Added ${noun} to “${pl.name}”.`,
            { kind: 'success' },
          )
        },
      }
    }),
  }
}
