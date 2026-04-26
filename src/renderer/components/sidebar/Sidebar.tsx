import { useState, useEffect, useCallback, useRef } from 'react'
import { useLibrary } from '../../context/LibraryContext'
import SidebarSection from './SidebarSection'
import SidebarItem from './SidebarItem'
import AlbumArtPanel from './AlbumArtPanel'
import ContextMenu from '../ContextMenu'
import ConfirmDialog from '../ConfirmDialog'
import type { ViewName, SmartPlaylistId } from '../../types'

const LIBRARY_ICONS: Record<string, JSX.Element> = {
  songs: <SongsIcon />,
  artists: <ArtistsIcon />,
  albums: <AlbumsIcon />,
  genres: <GenresIcon />,
}

const libraryItems: { label: string; view: ViewName; highlight?: string }[] = [
  { label: 'Songs', view: 'songs' },
  { label: 'Artists', view: 'artists' },
  { label: 'Albums', view: 'albums' },
  { label: 'Genres', view: 'genres' },
  { label: 'The Music Man', view: 'musicman', highlight: '#c87828' },
]

const smartPlaylists: { label: string; id: SmartPlaylistId }[] = [
  { label: 'Recently Added', id: 'recently-added' },
  { label: 'Recently Played', id: 'recently-played' },
  { label: 'Top 25 Most Played', id: 'top-25' },
  { label: 'My Top Rated', id: 'top-rated' },
  { label: 'The Music Man Picks', id: 'musicman-picks' },
]

// iPod playlists with these names duplicate the built-in smart playlists — hide them
const SMART_PLAYLIST_NAMES = new Set([
  'Recently Added', 'Recently Played', 'Top 25 Most Played', 'My Top Rated',
  'Classical Music', // empty iPod smart playlist
])

// iTunes 8 sidebar icons stayed COLORED (the monochrome conversion didn't
// happen until iTunes 10). Each icon takes a category-tied color:
// blue music notation, purple gear/playlist, green genre grid, etc.
const ICON_BLUE   = '#4a7fbf'   // Songs / Albums (Music)
const ICON_PURPLE = '#a557a6'   // Artists (person silhouette)
const ICON_GREEN  = '#5b9b54'   // Genres (category grid)
const ICON_PLAYLIST_PURPLE = '#7351a3'   // Playlist + Smart Playlist gear

function SongsIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill={ICON_BLUE}>
      <path d="M10 1.5v7a1.75 1.75 0 11-1.2-1.6V3L5 4v5.5a1.75 1.75 0 11-1.2-1.6V2.5L10 1.5z" />
    </svg>
  )
}

function ArtistsIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill={ICON_PURPLE}>
      <circle cx="6" cy="4" r="2.2" />
      <path d="M2 10.5c0-2.2 1.8-3.5 4-3.5s4 1.3 4 3.5" />
    </svg>
  )
}

function AlbumsIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill={ICON_BLUE}>
      <circle cx="6" cy="6" r="5" fill="none" stroke={ICON_BLUE} strokeWidth="1.2" />
      <circle cx="6" cy="6" r="2" fill="none" stroke={ICON_BLUE} strokeWidth="1" />
      <circle cx="6" cy="6" r="0.8" />
    </svg>
  )
}

function GenresIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke={ICON_GREEN} strokeWidth="1.2">
      <rect x="1" y="1" width="4.5" height="4.5" rx="0.8" />
      <rect x="6.5" y="1" width="4.5" height="4.5" rx="0.8" />
      <rect x="1" y="6.5" width="4.5" height="4.5" rx="0.8" />
      <rect x="6.5" y="6.5" width="4.5" height="4.5" rx="0.8" />
    </svg>
  )
}

function PlaylistIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke={ICON_PLAYLIST_PURPLE} strokeWidth="1.2">
      <path d="M1 3h8M1 6h8M1 9h5" strokeLinecap="round" />
    </svg>
  )
}

function SmartPlaylistIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      {/* Playlist lines */}
      <path d="M1 2.5h5M1 5h4" stroke={ICON_PLAYLIST_PURPLE} strokeWidth="1.2" strokeLinecap="round" />
      {/* Gear */}
      <g transform="translate(8,8)">
        <circle cx="0" cy="0" r="1.2" stroke={ICON_PLAYLIST_PURPLE} strokeWidth="0.7" fill="none" />
        <path d="M0-2.8v1M0 1.8v1M-2.8 0h1M1.8 0h1M-2-2 l.7.7M1.3 1.3 l.7.7M2-2 l-.7.7M-1.3 1.3 l-.7.7"
              stroke={ICON_PLAYLIST_PURPLE} strokeWidth="0.7" strokeLinecap="round" />
      </g>
    </svg>
  )
}

function MusicManPicksIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      {/* Vinyl record */}
      <circle cx="6" cy="6" r="5" stroke="#c87828" strokeWidth="0.9" />
      <circle cx="6" cy="6" r="2.8" stroke="#c87828" strokeWidth="0.5" opacity="0.5" />
      <circle cx="6" cy="6" r="1.2" fill="#c87828" />
      {/* Sparkle */}
      <path d="M10 1.5L10.4 2.8 11.5 2 10.4 2.4 10 3.5 9.6 2.4 8.5 2 9.6 2.8z" fill="#c87828" />
    </svg>
  )
}

function EjectIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="#555">
      <path d="M5 1L1 6h8zM1 8h8v1.5H1z" />
    </svg>
  )
}

function IpodIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#555" strokeWidth="1">
      <rect x="2" y="1" width="8" height="10" rx="1" />
      <rect x="3" y="2" width="6" height="4" rx="0.5" fill="#555" opacity="0.2" />
      <circle cx="6" cy="8.5" r="1.5" />
    </svg>
  )
}

function CdIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" fill="none" stroke="#555" strokeWidth="1" />
      <circle cx="6" cy="6" r="2" fill="none" stroke="#555" strokeWidth="0.7" />
      <circle cx="6" cy="6" r="0.6" fill="#555" />
    </svg>
  )
}

export default function Sidebar() {
  const { state, dispatch } = useLibrary()
  const [ipodMounted, setIpodMounted] = useState(false)
  const [ipodName, setIpodName] = useState('iPod')
  const [cdMounted, setCdMounted] = useState(false)
  const [cdName, setCdName] = useState('Audio CD')
  const [plCtxMenu, setPlCtxMenu] = useState<{ x: number; y: number; playlistId: string; playlistName: string } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null)
  const [creatingPlaylist, setCreatingPlaylist] = useState(false)
  const [editingPlaylistId, setEditingPlaylistId] = useState<string | null>(null)
  const newPlaylistRef = useRef<HTMLInputElement>(null)
  const renameRef = useRef<HTMLInputElement>(null)

  const handleNewPlaylist = useCallback(() => {
    setCreatingPlaylist(true)
  }, [])

  const handleNewPlaylistSubmit = useCallback((name: string) => {
    setCreatingPlaylist(false)
    if (!name.trim()) return
    const playlist = { id: `pl-${Date.now()}`, name: name.trim(), trackIds: [] as number[] }
    dispatch({ type: 'ADD_PLAYLIST', playlist })
    dispatch({ type: 'VIEW_PLAYLIST', id: playlist.id })
  }, [dispatch])

  const handlePlaylistContextMenu = useCallback((e: React.MouseEvent, id: string, name: string) => {
    e.preventDefault()
    e.stopPropagation()
    setPlCtxMenu({ x: e.clientX, y: e.clientY, playlistId: id, playlistName: name })
  }, [])

  const handleRenamePlaylist = useCallback(() => {
    if (!plCtxMenu) return
    setEditingPlaylistId(plCtxMenu.playlistId)
    setPlCtxMenu(null)
  }, [plCtxMenu])

  const handleRenameSubmit = useCallback((id: string, name: string) => {
    setEditingPlaylistId(null)
    if (!name.trim()) return
    dispatch({ type: 'RENAME_PLAYLIST', id, name: name.trim() })
  }, [dispatch])

  const handleDeletePlaylist = useCallback(() => {
    if (!plCtxMenu) return
    setDeleteConfirm({ id: plCtxMenu.playlistId, name: plCtxMenu.playlistName })
    setPlCtxMenu(null)
  }, [plCtxMenu])

  useEffect(() => {
    // Counts consecutive polls where the iPod check came back "not
    // mounted". We only flip ipodMounted -> false after two in a row
    // so a transient stat() miss during heavy CD activity doesn't
    // kick the user off the Device page (which reads as "the iPod
    // auto-ejected").
    let ipodMissStreak = 0
    let prevMounted = false
    const check = () => {
      window.electronAPI.checkIpodMounted().then(r => {
        if (r.mounted) {
          ipodMissStreak = 0
          setIpodMounted(true)
          if (!prevMounted) {
            // 4.0: notify app-level listeners (e.g. auto-sync-on-connect).
            // Dispatched only on the false→true transition so a user who
            // ejects + replugs gets exactly one event per session.
            window.dispatchEvent(new Event('jaketunes-ipod-mounted'))
          }
          prevMounted = true
          if (r.name) setIpodName(r.name)
        } else {
          ipodMissStreak += 1
          if (ipodMissStreak >= 2) {
            setIpodMounted(false)
            prevMounted = false
          }
        }
      }).catch(() => {
        // Treat IPC error same as a miss, with the same debouncing.
        ipodMissStreak += 1
        if (ipodMissStreak >= 2) {
          setIpodMounted(false)
          prevMounted = false
        }
      })
      window.electronAPI.checkCdDrive().then(r => {
        setCdMounted(r.hasCd)
        if (r.volumeName) setCdName(r.volumeName)
      }).catch(() => {})
    }
    check()
    const interval = setInterval(check, 5000)
    // Listen for eject events so sidebar updates immediately. Explicit
    // eject resets the miss streak and forces an unmounted state.
    const onIpodEject = () => { ipodMissStreak = 2; setTimeout(check, 500) }
    const onCdEject = () => setTimeout(check, 500)
    window.addEventListener('jaketunes-ipod-ejected', onIpodEject)
    window.addEventListener('jaketunes-cd-ejected', onCdEject)
    return () => {
      clearInterval(interval)
      window.removeEventListener('jaketunes-ipod-ejected', onIpodEject)
      window.removeEventListener('jaketunes-cd-ejected', onCdEject)
    }
  }, [])

  // If iPod is unmounted while viewing device page, switch to songs
  useEffect(() => {
    if (!ipodMounted && state.currentView === 'device') {
      dispatch({ type: 'SET_VIEW', view: 'songs' })
    }
  }, [ipodMounted, state.currentView, dispatch])

  // If CD is ejected while viewing cd-import page, switch to songs
  useEffect(() => {
    if (!cdMounted && state.currentView === 'cd-import') {
      dispatch({ type: 'SET_VIEW', view: 'songs' })
    }
  }, [cdMounted, state.currentView, dispatch])

  return (
    <div className="sidebar">
      <div className="sidebar-scroll">
        <SidebarSection title="LIBRARY">
          {libraryItems.map((item) => (
            <SidebarItem
              key={item.view}
              label={item.label}
              icon={LIBRARY_ICONS[item.view]}
              highlight={item.highlight}
              selected={state.currentView === item.view}
              onClick={() => dispatch({ type: 'SET_VIEW', view: item.view })}
            />
          ))}
        </SidebarSection>

        {(ipodMounted || cdMounted) && (
          <SidebarSection title="DEVICES">
            {ipodMounted && (
              <li
                className={`sidebar-item sidebar-device-row ${state.currentView === 'device' ? 'sidebar-item--selected' : ''}`}
                onClick={() => dispatch({ type: 'SET_VIEW', view: 'device' })}
              >
                <span className="sidebar-item-icon"><IpodIcon /></span>
                <span className="sidebar-item-label">{ipodName}</span>
                <button className="sidebar-eject-btn" title="Eject" onClick={(e) => { e.stopPropagation(); window.electronAPI.ejectIpod().then(() => window.dispatchEvent(new Event('jaketunes-ipod-ejected'))) }}><EjectIcon /></button>
              </li>
            )}
            {cdMounted && (
              <li
                className={`sidebar-item sidebar-device-row ${state.currentView === 'cd-import' ? 'sidebar-item--selected' : ''}`}
                onClick={() => dispatch({ type: 'SET_VIEW', view: 'cd-import' })}
              >
                <span className="sidebar-item-icon"><CdIcon /></span>
                <span className="sidebar-item-label">{cdName}</span>
                <button className="sidebar-eject-btn" title="Eject CD" onClick={(e) => { e.stopPropagation(); window.electronAPI.ejectCd().then(() => window.dispatchEvent(new Event('jaketunes-cd-ejected'))) }}><EjectIcon /></button>
              </li>
            )}
          </SidebarSection>
        )}

        <SidebarSection title="PLAYLISTS">
          {smartPlaylists.map((sp) => (
            <SidebarItem
              key={sp.id}
              label={sp.label}
              icon={sp.id === 'musicman-picks' ? <MusicManPicksIcon /> : <SmartPlaylistIcon />}
              selected={state.currentView === 'smart-playlist' && state.activeSmartPlaylist === sp.id}
              onClick={() => dispatch({ type: 'VIEW_SMART_PLAYLIST', id: sp.id })}
            />
          ))}
          {state.playlists.filter(pl => !SMART_PLAYLIST_NAMES.has(pl.name)).map((pl) => (
            editingPlaylistId === pl.id ? (
              <div key={pl.id} className="sidebar-item" style={{ paddingLeft: 22 }}>
                <span className="sidebar-item-icon"><PlaylistIcon /></span>
                <input
                  ref={renameRef}
                  className="sidebar-inline-input"
                  defaultValue={pl.name}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRenameSubmit(pl.id, e.currentTarget.value)
                    if (e.key === 'Escape') setEditingPlaylistId(null)
                  }}
                  onBlur={(e) => handleRenameSubmit(pl.id, e.currentTarget.value)}
                />
              </div>
            ) : (
              <div key={pl.id} onContextMenu={(e) => handlePlaylistContextMenu(e, pl.id, pl.name)}>
                <SidebarItem
                  label={pl.name}
                  icon={<PlaylistIcon />}
                  selected={state.currentView === 'playlist' && state.activePlaylistId === pl.id}
                  onClick={() => dispatch({ type: 'VIEW_PLAYLIST', id: pl.id })}
                  droppable
                  onDrop={(trackIds) => dispatch({ type: 'ADD_TRACKS_TO_PLAYLIST', playlistId: pl.id, trackIds })}
                />
              </div>
            )
          ))}
          {creatingPlaylist && (
            <div className="sidebar-item" style={{ paddingLeft: 22 }}>
              <span className="sidebar-item-icon"><PlaylistIcon /></span>
              <input
                ref={newPlaylistRef}
                className="sidebar-inline-input"
                placeholder="Playlist name"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleNewPlaylistSubmit(e.currentTarget.value)
                  if (e.key === 'Escape') setCreatingPlaylist(false)
                }}
                onBlur={(e) => handleNewPlaylistSubmit(e.currentTarget.value)}
              />
            </div>
          )}
        </SidebarSection>
      </div>

      <AlbumArtPanel onNewPlaylist={handleNewPlaylist} />

      {plCtxMenu && (
        <ContextMenu
          x={plCtxMenu.x}
          y={plCtxMenu.y}
          items={[
            { label: 'Rename…', onClick: handleRenamePlaylist },
            { separator: true as const },
            { label: 'Delete Playlist', onClick: handleDeletePlaylist },
          ]}
          onClose={() => setPlCtxMenu(null)}
        />
      )}
      {deleteConfirm && (
        <ConfirmDialog
          message={`Delete the playlist "${deleteConfirm.name}"?`}
          detail="The songs will remain in your library."
          confirmLabel="Delete"
          onConfirm={() => {
            dispatch({ type: 'REMOVE_PLAYLIST', id: deleteConfirm.id })
            setDeleteConfirm(null)
          }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </div>
  )
}
