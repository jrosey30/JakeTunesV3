/**
 * Right-click and drag for the Home's library items (Jake, 2026-10-20: "i
 * should also be able to right click the songs/albums/whatever on the home
 * page and also drag to the queue, like it is a regular song in the library").
 *
 * Nothing here is a new menu. A song card opens the Songs view's song menu, an
 * album the Albums view's album menu — both from utils/libraryMenus.ts, where
 * those views build theirs — and Get Info / Delete open the Songs view's
 * own sheet and confirmation (hooks/useGetInfoHandlers.ts,
 * components/DeleteSongsDialog.tsx). Drags carry the library's one payload
 * (utils/trackDrag.ts), so a Home card drops wherever a library row does: the
 * Up Next panel and button, the sidebar's playlists, the iPod Pool.
 *
 * HomeView hosts it (useHomeItemMenusHost) and renders `overlays` BESIDE
 * .home-view, not inside it: the menu, Get Info and the confirmation are
 * fixed overlays, and .home-view is an isolated stacking context (launch page
 * G's backdrop paints in it) that would trap their z-index under the toolbar
 * and sidebar. Components under the Home reach the menus with
 * useHomeItemMenus() (HomeItemMenusProvider carries them).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import ContextMenu, { type MenuEntry } from './ContextMenu'
import GetInfoModal from './GetInfoModal'
import DeleteSongsDialog from './DeleteSongsDialog'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useCynthia } from '../context/CynthiaContext'
import { useGetInfoHandlers } from '../hooks/useGetInfoHandlers'
import { songMenuEntries, albumMenuEntries } from '../utils/libraryMenus'
import { withSongMenuExtras, type SongMenuExtras } from '../utils/songMenuExtras'
import { groupTracksIntoAlbums } from '../utils/albumGroups'
import { ensureLiveSetsLoaded } from '../liveSets'
import type { GetInfoTarget } from '../../common/get-info-target'
import type { Track } from '../types'

type PlayTrack = (track: Track, queue?: Track[], queueIndex?: number, djTransition?: boolean, freshContext?: boolean, preserveOrder?: boolean) => void

export interface HomeItemMenusApi {
  /** A song card. `play` is what "Play" does — the same thing the card's
   *  click does; `row` + `index` let Get Info step through the row. */
  openSongMenu: (e: React.MouseEvent, track: Track, play: () => void, row: Track[], index: number, extras?: SongMenuExtras) => void
  /** An album (any of its tracks; grouped the way the Albums view groups). */
  openAlbumMenu: (e: React.MouseEvent, tracks: Track[]) => void
}

const HomeItemMenusContext = createContext<HomeItemMenusApi | null>(null)
export const HomeItemMenusProvider = HomeItemMenusContext.Provider

/** The menus, when the Home is the host (null anywhere else — callers then
 *  simply don't offer a menu). */
export function useHomeItemMenus(): HomeItemMenusApi | null {
  return useContext(HomeItemMenusContext)
}

export function useHomeItemMenusHost(playTrack: PlayTrack): { api: HomeItemMenusApi; overlays: JSX.Element } {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { dispatch: pbDispatch } = usePlayback()
  const { openCynthia } = useCynthia()
  const { onSave, onFetchArt, onSetCustomArt } = useGetInfoHandlers()
  // The album menu reads the declared live sets (Play Live Set / Declare).
  useEffect(() => { void ensureLiveSetsLoaded() }, [])

  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null)
  const [getInfo, setGetInfo] = useState<GetInfoTarget<Track> | null>(null)
  const [deleteIds, setDeleteIds] = useState<number[] | null>(null)

  const openSongMenu = useCallback((e: React.MouseEvent, track: Track, play: () => void, row: Track[], index: number, extras?: SongMenuExtras) => {
    e.preventDefault()
    e.stopPropagation()
    const at = { x: e.clientX, y: e.clientY }
    const askDelete = (): void => setDeleteIds([track.id])
    const items = songMenuEntries({
      track,
      tracks: [track],
      play,
      library: lib.tracks,
      playlists: lib.playlists,
      libDispatch,
      pbDispatch,
      openGetInfo: () => setGetInfo({ tracks: [track], index: Math.max(0, index), allTracks: row.length ? row : [track] }),
      askDelete,
      openCynthia,
      at,
    })
    setMenu({ ...at, items: withSongMenuExtras(items, askDelete, extras) })
  }, [lib.tracks, lib.playlists, libDispatch, pbDispatch, openCynthia])

  const openAlbumMenu = useCallback((e: React.MouseEvent, tracks: Track[]) => {
    e.preventDefault()
    e.stopPropagation()
    const album = groupTracksIntoAlbums(tracks)[0]
    if (!album) return
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: albumMenuEntries({ album, library: lib.tracks, playlists: lib.playlists, playTrack, libDispatch, pbDispatch }),
    })
  }, [lib.tracks, lib.playlists, playTrack, libDispatch, pbDispatch])

  const api = useMemo(() => ({ openSongMenu, openAlbumMenu }), [openSongMenu, openAlbumMenu])
  const overlays = (
    <>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {getInfo && (
        <GetInfoModal
          tracks={getInfo.tracks}
          allTracks={getInfo.allTracks ?? getInfo.tracks}
          initialIndex={getInfo.index}
          artworkMap={lib.artworkMap}
          onClose={() => setGetInfo(null)}
          onSave={onSave}
          onFetchArt={onFetchArt}
          onSetCustomArt={onSetCustomArt}
        />
      )}
      {deleteIds && <DeleteSongsDialog ids={deleteIds} onClose={() => setDeleteIds(null)} />}
    </>
  )
  return { api, overlays }
}
