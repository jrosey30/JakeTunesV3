import { useMemo } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { useNavigation } from '../context/NavigationContext'
import { backLabelForLocation } from '../utils/albumBackLabel'
import { albumKeyFromStrings } from '../utils/albumKey'
import { SMART_PLAYLIST_TITLES } from '../utils/smartPlaylists'

/**
 * The name of the page Back lands on, as the back pill says it (Jake,
 * 2026-10-30: "make going back obvious on every page"). ONE place resolves
 * the names a history step only holds ids for — the album's title from its
 * key, the playlist's name from its id — so the shell's pill and the album /
 * artist / concert pages' own pills say the same thing (utils/albumBackLabel.ts
 * is the single naming; this hands it the names). Null when there is nothing
 * to go back to — callers fall back to their stored return view, as before.
 */
export function useBackLabel(): string | null {
  const { canGoBack, backTo, backToSearch } = useNavigation()
  const { state: lib } = useLibrary()
  const albumKey = backTo?.view === 'album-detail' ? backTo.albumKey : null
  // The key is lowercased, so the title comes from the owning track (the
  // titlebar breadcrumb resolves it the same way). Memoized on the key.
  const album = useMemo(() => {
    if (!albumKey) return null
    const t = lib.tracks.find((tk) => albumKeyFromStrings(tk.albumArtist || tk.artist, tk.album) === albumKey)
    return t?.album || null
  }, [albumKey, lib.tracks])
  const playlist = backTo?.view === 'playlist' && backTo.playlistId
    ? lib.playlists.find((p) => p.id === backTo.playlistId)?.name ?? null
    : backTo?.view === 'smart-playlist' && backTo.smartPlaylistId
      ? SMART_PLAYLIST_TITLES[backTo.smartPlaylistId] ?? null
      : null
  if (!canGoBack) return null
  return backLabelForLocation(backTo, backToSearch, { album, playlist })
}
