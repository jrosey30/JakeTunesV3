import { useMemo } from 'react'
import { useLibrary } from '../../context/LibraryContext'
import { albumKeyFromStrings } from '../../utils/albumKey'
import type { ViewName } from '../../types'

/**
 * 4.5: live breadcrumb in the titlebar — replaces the dead "JakeTunes" label.
 *
 * Tells you WHERE you are and lets you jump UP a level in one click
 * (Artists › The Beatles › Abbey Road). Pairs with the existing ‹ › history
 * buttons to its left. Pure observer on LibraryContext (do-not-touch) — every
 * jump goes through the same dispatch actions the rest of the app uses.
 */

const VIEW_LABELS: Partial<Record<ViewName, string>> = {
  home: 'Home', songs: 'Songs', artists: 'Artists', albums: 'Albums',
  genres: 'Genres', discovery: 'Discovery', musicman: 'The Music Man',
  store: 'Store', download: 'Download', recordstore: 'Record Store',
  device: 'iPod', 'cd-import': 'CD Import', scotus: 'SCOTUS Archive',
}
const SMART_LABELS: Record<string, string> = {
  'recently-added': 'Recently Added', 'recently-played': 'Recently Played',
  'top-25': 'Top 25 Most Played', 'top-rated': 'Starred',
  'youd-star': "Songs You'd Star",
  'musicman-picks': 'The Music Man Picks', 'megan-picks': 'Megan Picks',
  'dj-hands-picks': 'DJ Stephen Hands Picks',
}

interface Crumb { label: string; onClick?: () => void }

export default function Breadcrumb() {
  const { state: lib, dispatch } = useLibrary()
  const v = lib.currentView

  // The album key is lowercased, so resolve the display artist + name from the
  // owning track. Only runs on album-detail; memoized on the key.
  const albumInfo = useMemo(() => {
    if (v !== 'album-detail' || !lib.pendingAlbumKey) return null
    const t = lib.tracks.find(tk => albumKeyFromStrings(tk.albumArtist || tk.artist, tk.album) === lib.pendingAlbumKey)
    return t ? { artist: t.albumArtist || t.artist || 'Unknown Artist', album: t.album || 'Unknown Album' } : null
  }, [v, lib.pendingAlbumKey, lib.tracks])

  const crumbs: Crumb[] = useMemo(() => {
    const go = (view: ViewName): (() => void) => () => dispatch({ type: 'SET_VIEW', view })
    switch (v) {
      case 'artist-detail':
        return [{ label: 'Artists', onClick: go('artists') }, { label: lib.activeArtist || 'Artist' }]
      case 'album-detail': {
        const album = albumInfo?.album || 'Album'
        if (lib.albumDetailReturnView === 'artist-detail' && albumInfo?.artist) {
          const artist = albumInfo.artist
          return [
            { label: 'Artists', onClick: go('artists') },
            { label: artist, onClick: () => dispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: artist }) },
            { label: album },
          ]
        }
        return [{ label: 'Albums', onClick: go('albums') }, { label: album }]
      }
      case 'playlist':
        return [{ label: lib.playlists.find(p => p.id === lib.activePlaylistId)?.name || 'Playlist' }]
      case 'smart-playlist':
        return [{ label: SMART_LABELS[lib.activeSmartPlaylist || ''] || 'Playlist' }]
      default:
        return [{ label: VIEW_LABELS[v] || 'JakeTunes' }]
    }
  }, [v, lib.activeArtist, lib.albumDetailReturnView, lib.playlists, lib.activePlaylistId, lib.activeSmartPlaylist, albumInfo, dispatch])

  return (
    <nav className="titlebar-crumbs" aria-label="Location">
      {crumbs.map((c, i) => (
        <span className="titlebar-crumb-seg" key={`${i}-${c.label}`}>
          {i > 0 && <span className="titlebar-crumb-sep" aria-hidden="true">›</span>}
          {c.onClick
            ? <button type="button" className="titlebar-crumb-link" onClick={c.onClick} title={`Go to ${c.label}`}>{c.label}</button>
            : <span className="titlebar-crumb-current" title={c.label}>{c.label}</span>}
        </span>
      ))}
    </nav>
  )
}
