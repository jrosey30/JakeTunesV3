import { useState, useEffect, useCallback, useRef } from 'react'
import { useLibrary } from '../../context/LibraryContext'
import { usePlayback } from '../../context/PlaybackContext'
import SidebarSection from './SidebarSection'
import SidebarItem from './SidebarItem'
import AlbumArtPanel from './AlbumArtPanel'
import ContextMenu from '../ContextMenu'
import ConfirmDialog from '../ConfirmDialog'
import type { ViewName, SmartPlaylistId } from '../../types'
import { setNotice } from '../../activity'

const LIBRARY_ICONS: Record<string, JSX.Element> = {
  home: <HomeIcon />,
  songs: <SongsIcon />,
  artists: <ArtistsIcon />,
  albums: <AlbumsIcon />,
  concerts: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="2" width="10" height="12" rx="1" />
      <path d="M8 4.4l0.85 1.75 1.95 0.28-1.4 1.37 0.33 1.93L8 8.79l-1.73 0.91 0.33-1.93-1.4-1.37 1.95-0.28z" />
    </svg>
  ),
  genres: <GenresIcon />,
  discovery: <DiscoveryIcon />,
}

const libraryItems: { label: string; view: ViewName; highlight?: string }[] = [
  // 4.4.19: Home/Dashboard. Surfaces Recently Added + Top Artists,
  // future ships add Listening Stats / Picks / Music News / Bandsintown.
  { label: 'Home', view: 'home' },
  { label: 'Songs', view: 'songs' },
  { label: 'Artists', view: 'artists' },
  { label: 'Albums', view: 'albums' },
  { label: 'Live Concerts', view: 'concerts' },
  { label: 'Genres', view: 'genres' },
  // Backlog 2026-06-06: "Listen to the List" + "New for You" merged into one
  // teal "Discovery" entry (two-tab toggle inside). Teal is distinct from the
  // Music Man's #bb4308 below, which used to clash with New for You's orange.
  { label: 'Discovery', view: 'discovery', highlight: '#1f7a8c' },
  { label: 'The Music Man', view: 'musicman', highlight: '#bb4308' },
]

// 4.4.0: split into two sections so the WJLR Picks panel stands out as
// the featured/curated content, separate from the standard system smart
// playlists. Picks render with a distinct background tint, slightly
// taller rows, and bolder labels — see styles/sidebar.css.
const featuredPicks: { label: string; id: SmartPlaylistId }[] = [
  { label: 'The Music Man Picks',  id: 'musicman-picks' },
  { label: 'Megan Picks',          id: 'megan-picks' },
  { label: 'DJ Stephen Hands Picks', id: 'dj-hands-picks' },
]

const smartPlaylists: { label: string; id: SmartPlaylistId }[] = [
  { label: 'Recently Added', id: 'recently-added' },
  { label: 'Recently Played', id: 'recently-played' },
  { label: 'Top 25 Most Played', id: 'top-25' },
  { label: 'Starred', id: 'top-rated' },
  { label: "Songs You'd Star", id: 'youd-star' },
]

// iPod playlists with these names duplicate the built-in smart playlists — hide them
const SMART_PLAYLIST_NAMES = new Set([
  'Recently Added', 'Recently Played', 'Top 25 Most Played', 'My Top Rated', 'Starred',
  "Songs You'd Star",
  'Classical Music', // empty iPod smart playlist
])

// iTunes 8 sidebar icons stayed COLORED (the monochrome conversion didn't
// happen until iTunes 10). Each icon takes a category-tied color:
// blue music notation, purple gear/playlist, green genre grid, etc.
const ICON_BLUE   = '#4a7fbf'   // Songs / Albums (Music)
const ICON_PURPLE = '#a557a6'   // Artists (person silhouette)
const ICON_GREEN  = '#5b9b54'   // Genres (category grid)
const ICON_PLAYLIST_PURPLE = '#7351a3'   // Playlist + Smart Playlist gear
// 4.4.47: the brand orange, sampled from the app logo (#bb4308). Used
// for the Home icon and the Music Man sidebar entry's icon + highlight.
const ICON_HOME_ORANGE = '#bb4308'  // Home — warm color, distinct from the cooler library icons.
// Backlog 2026-06-06: Discovery's cool teal — deliberately unlike Music Man's #bb4308.
const ICON_DISCOVERY_TEAL = '#1f7a8c'

function HomeIcon() {
  // Simple gable-roof house silhouette — instantly readable at 12 px,
  // doesn't fight the existing library icon set.
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill={ICON_HOME_ORANGE}>
      <path d="M6 1.2 1 5.4V10.5a.6.6 0 0 0 .6.6h2.6V7.6h3.6V11.1h2.6a.6.6 0 0 0 .6-.6V5.4Z" />
    </svg>
  )
}

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

function DiscoveryIcon() {
  // Compass — "Discovery". Teal needle (NE filled pointer / SW faded tail)
  // reads cool, distinct from the Music Man's warm orange sparkle.
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke={ICON_DISCOVERY_TEAL} strokeWidth="1.2">
      <circle cx="7" cy="7" r="5.6" />
      <path d="M7 7L10 4L8.1 7.8Z" fill={ICON_DISCOVERY_TEAL} stroke="none" />
      <path d="M7 7L4 10L5.9 6.2Z" fill={ICON_DISCOVERY_TEAL} stroke="none" opacity="0.4" />
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
      <circle cx="6" cy="6" r="5" stroke="#bb4308" strokeWidth="0.9" />
      <circle cx="6" cy="6" r="2.8" stroke="#bb4308" strokeWidth="0.5" opacity="0.5" />
      <circle cx="6" cy="6" r="1.2" fill="#bb4308" />
      {/* Sparkle */}
      <path d="M10 1.5L10.4 2.8 11.5 2 10.4 2.4 10 3.5 9.6 2.4 8.5 2 9.6 2.8z" fill="#bb4308" />
    </svg>
  )
}

// Megan picks gets a vinyl too — same shape so the picks pair reads as a
// pair, but in a teal/blue tone to differentiate her from MM's orange.
function MeganPicksIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" stroke="#3a7ca5" strokeWidth="0.9" />
      <circle cx="6" cy="6" r="2.8" stroke="#3a7ca5" strokeWidth="0.5" opacity="0.5" />
      <circle cx="6" cy="6" r="1.2" fill="#3a7ca5" />
      <path d="M10 1.5L10.4 2.8 11.5 2 10.4 2.4 10 3.5 9.6 2.4 8.5 2 9.6 2.8z" fill="#3a7ca5" />
    </svg>
  )
}

// DJ Hands picks — vinyl in deep purple, the third color in the picks
// trio. Beats / electronic / hip-hop tone.
function DjHandsPicksIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" stroke="#7a3a9c" strokeWidth="0.9" />
      <circle cx="6" cy="6" r="2.8" stroke="#7a3a9c" strokeWidth="0.5" opacity="0.5" />
      <circle cx="6" cy="6" r="1.2" fill="#7a3a9c" />
      <path d="M10 1.5L10.4 2.8 11.5 2 10.4 2.4 10 3.5 9.6 2.4 8.5 2 9.6 2.8z" fill="#7a3a9c" />
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
  const { state: pb, dispatch: pbDispatch } = usePlayback()
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

  useEffect(() => {
    if (creatingPlaylist) {
      const t = setTimeout(() => newPlaylistRef.current?.select(), 0)
      return () => clearTimeout(t)
    }
  }, [creatingPlaylist])

  useEffect(() => {
    if (editingPlaylistId) {
      const t = setTimeout(() => renameRef.current?.select(), 0)
      return () => clearTimeout(t)
    }
  }, [editingPlaylistId])

  const handleNewPlaylist = useCallback(() => {
    setCreatingPlaylist(true)
  }, [])

  // File → New Playlist (⌘N) arrives here via App's menu-action bridge.
  useEffect(() => {
    const handler = () => handleNewPlaylist()
    window.addEventListener('jaketunes-new-playlist', handler)
    return () => window.removeEventListener('jaketunes-new-playlist', handler)
  }, [handleNewPlaylist])

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
            // 4.5: dispatch eject event on the true→false transition
            // so App-level listeners (sync-pill cleanup) can react.
            // Pre-fix only the explicit Eject button fired this event;
            // a physical unplug left stale sync banners in the pill.
            if (prevMounted) {
              window.dispatchEvent(new Event('jaketunes-ipod-ejected'))
            }
            prevMounted = false
          }
        }
      }).catch(() => {
        // Treat IPC error same as a miss, with the same debouncing.
        ipodMissStreak += 1
        if (ipodMissStreak >= 2) {
          setIpodMounted(false)
          if (prevMounted) {
            window.dispatchEvent(new Event('jaketunes-ipod-ejected'))
          }
          prevMounted = false
        }
      })
      window.electronAPI.checkCdDrive().then(r => {
        setCdMounted(r.hasCd)
        if (r.volumeName) setCdName(r.volumeName)
      }).catch(() => {})
    }
    check()
    // 4.5: 5s → 2.5s. The 5s gap meant a user plugging in a freshly-
    // mounted iPod could wait up to 5s for the sidebar entry. 2.5s
    // halves that worst case without adding meaningful main-process
    // load (a stat + readdir per tick is negligible).
    const interval = setInterval(check, 2500)
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

        <SidebarSection title="STORE">
          <SidebarItem
            label="Bandcamp Store"
            icon={(
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 3h10l-1.2 7.5a1.5 1.5 0 0 1-1.48 1.25H5.68A1.5 1.5 0 0 1 4.2 10.5L3 3z" fill="#2c5aa0" />
                <circle cx="6" cy="13.5" r="1" fill="#2c5aa0" />
                <circle cx="11" cy="13.5" r="1" fill="#2c5aa0" />
              </svg>
            )}
            selected={state.currentView === 'store'}
            onClick={() => dispatch({ type: 'SET_VIEW', view: 'store' })}
          />
          <SidebarItem
            label="Download"
            icon={(
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="#7a5ca8" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 2.5v6" />
                <path d="M5.5 6 8 8.7 10.5 6" />
                <path d="M3 11.5h10" />
              </svg>
            )}
            selected={state.currentView === 'download'}
            onClick={() => dispatch({ type: 'SET_VIEW', view: 'download' })}
          />
          <SidebarItem
            label="Beck v. Prupis"
            icon={(
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="#9a7b3a" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 6 8 2.3 14 6" />
                <path d="M2.6 6.6v6M6 6.6v6M10 6.6v6M13.4 6.6v6" />
                <path d="M1.4 13h13.2" />
              </svg>
            )}
            selected={state.currentView === 'scotus'}
            onClick={() => dispatch({ type: 'SET_VIEW', view: 'scotus' })}
          />
          {/* Brief 037 Record Store — entry HIDDEN for the 4.5.0-111
              release (shipping listen-to-the-list only; Phase-2 store held).
              Re-add this SidebarItem when RECORD_STORE_ENABLED flips back on:
              <SidebarItem
                label="Record Store"
                icon={(
                  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.5" fill="#b87333" />
                    <circle cx="8" cy="8" r="2.2" fill="#fff" />
                    <circle cx="8" cy="8" r="0.8" fill="#b87333" />
                  </svg>
                )}
                selected={state.currentView === 'recordstore'}
                onClick={() => dispatch({ type: 'SET_VIEW', view: 'recordstore' })}
              /> */}
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
                <button className="sidebar-eject-btn" title="Eject" onClick={async (e) => {
                  e.stopPropagation()
                  // If we're playing a track from the iPod, the file handle
                  // would prevent diskutil eject from succeeding. STOP unloads
                  // the Howl which closes the ipod-audio:// streaming read.
                  // 500ms is comfortably more than the unload takes locally
                  // and shorter than the user's perceptible delay budget.
                  const playingFromIpod = pb.isPlaying && pb.nowPlaying?.path?.startsWith('iPod_Control:')
                  if (playingFromIpod) {
                    pbDispatch({ type: 'STOP' })
                    await new Promise((resolve) => setTimeout(resolve, 500))
                  }
                  const r = await window.electronAPI.ejectIpod()
                  if (r.ok) {
                    window.dispatchEvent(new Event('jaketunes-ipod-ejected'))
                  } else {
                    setNotice(`Eject failed: ${r.error || 'unknown error'}`, { kind: 'error', durationMs: 6000 })
                  }
                }}><EjectIcon /></button>
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

        {/* 4.4.0: WJLR Picks featured section — stands above the standard
            smart playlists with a distinct visual treatment. */}
        <SidebarSection title="WJLR PICKS">
          <div className="sidebar-picks-group">
            {featuredPicks.map((sp) => (
              <SidebarItem
                key={sp.id}
                label={sp.label}
                className="sidebar-item--picks"
                icon={
                  sp.id === 'musicman-picks' ? <MusicManPicksIcon /> :
                  sp.id === 'megan-picks' ? <MeganPicksIcon /> :
                  sp.id === 'dj-hands-picks' ? <DjHandsPicksIcon /> :
                  <SmartPlaylistIcon />
                }
                selected={state.currentView === 'smart-playlist' && state.activeSmartPlaylist === sp.id}
                onClick={() => dispatch({ type: 'VIEW_SMART_PLAYLIST', id: sp.id })}
              />
            ))}
          </div>
        </SidebarSection>

        {/* 2026-07-18 — saved activity syncs get their own category so a
            kept sync reads as a different kind of thing than a hand-made
            playlist. Section renders only when at least one exists. */}
        {state.playlists.some(pl => pl.category === 'synced-set') && (
          <SidebarSection title="SYNCED SETS">
            {state.playlists.filter(pl => pl.category === 'synced-set').map((pl) => (
              <div key={pl.id} onContextMenu={(e) => handlePlaylistContextMenu(e, pl.id, pl.name)}>
                <SidebarItem
                  label={pl.name}
                  icon={<SmartPlaylistIcon />}
                  selected={state.currentView === 'playlist' && state.activePlaylistId === pl.id}
                  onClick={() => dispatch({ type: 'VIEW_PLAYLIST', id: pl.id })}
                />
              </div>
            ))}
          </SidebarSection>
        )}

        <SidebarSection title="PLAYLISTS">
          {smartPlaylists.map((sp) => (
            <SidebarItem
              key={sp.id}
              label={sp.label}
              icon={<SmartPlaylistIcon />}
              selected={state.currentView === 'smart-playlist' && state.activeSmartPlaylist === sp.id}
              onClick={() => dispatch({ type: 'VIEW_SMART_PLAYLIST', id: sp.id })}
            />
          ))}
          {state.playlists.filter(pl => !SMART_PLAYLIST_NAMES.has(pl.name) && pl.category !== 'synced-set').map((pl) => (
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
