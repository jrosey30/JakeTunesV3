import { useLibrary } from '../context/LibraryContext'
import HomeView from '../views/HomeView'
import SongsView from '../views/SongsView'
import ArtistsView from '../views/ArtistsView'
import AlbumsView from '../views/AlbumsView'
import GenresView from '../views/GenresView'
import MusicManView from '../views/MusicManView'
import PlaylistView from '../views/PlaylistView'
import SmartPlaylistView from '../views/SmartPlaylistView'
import DeviceView from '../views/DeviceView'
import CDImportView from '../views/CDImportView'
import '../styles/main-content.css'

export default function MainContent() {
  const { state } = useLibrary()
  const isMusicMan = state.currentView === 'musicman'

  // For PlaylistView and SmartPlaylistView the "identity" of the view
  // is the active playlist id — we want a fresh fade-in when the user
  // clicks a different playlist, not just when they switch view type.
  const transitionKey =
    state.currentView === 'playlist' ? `playlist:${state.activePlaylistId}` :
    state.currentView === 'smart-playlist' ? `smart:${state.activeSmartPlaylist}` :
    state.currentView

  // Brief 023: MusicManView stays MOUNTED across navigation — its
  // wrapper is just toggled visible/hidden based on currentView. This
  // preserves chat history, in-flight analysis state, caller selection,
  // scroll position, and DJ Mode state when the user clicks Songs /
  // Albums / etc. and comes back. The previous unmount-on-switch
  // pattern erased the whole conversation on a single Songs-view trip.
  //
  // Other views still mount/unmount per their existing fade-on-switch
  // behavior — none of them have session-local state worth preserving,
  // and unmount-on-switch keeps the React tree from accumulating
  // background work in views the user isn't looking at.
  let viewElement: JSX.Element | null = null
  switch (state.currentView) {
    case 'home': viewElement = <HomeView />; break
    case 'songs': viewElement = <SongsView />; break
    case 'artists': viewElement = <ArtistsView />; break
    case 'albums': viewElement = <AlbumsView />; break
    case 'genres': viewElement = <GenresView />; break
    case 'musicman': break  // handled by the always-mounted wrapper below
    case 'playlist': viewElement = <PlaylistView />; break
    case 'smart-playlist': viewElement = <SmartPlaylistView />; break
    case 'device': viewElement = <DeviceView />; break
    case 'cd-import': viewElement = <CDImportView />; break
    default: viewElement = <SongsView />
  }

  // 4.4.24: subtle 140ms fade-in on view switch. The `key` forces a
  // re-mount of the non-MusicMan wrapper on every transition so the
  // CSS animation replays. The MusicMan wrapper deliberately does NOT
  // have a transition key — it never re-mounts after first render, so
  // its fade-in fires once at app start and that's it. State
  // preservation > re-fade on every visit.
  return (
    <>
      {viewElement !== null && (
        <div className="main-content-view" key={transitionKey}>
          {viewElement}
        </div>
      )}
      <div
        className="main-content-view"
        style={isMusicMan ? undefined : { display: 'none' }}
      >
        <MusicManView />
      </div>
    </>
  )
}
