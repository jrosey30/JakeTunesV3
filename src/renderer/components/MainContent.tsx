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

  // For PlaylistView and SmartPlaylistView the "identity" of the view
  // is the active playlist id — we want a fresh fade-in when the user
  // clicks a different playlist, not just when they switch view type.
  const transitionKey =
    state.currentView === 'playlist' ? `playlist:${state.activePlaylistId}` :
    state.currentView === 'smart-playlist' ? `smart:${state.activeSmartPlaylist}` :
    state.currentView

  let viewElement
  switch (state.currentView) {
    case 'home': viewElement = <HomeView />; break
    case 'songs': viewElement = <SongsView />; break
    case 'artists': viewElement = <ArtistsView />; break
    case 'albums': viewElement = <AlbumsView />; break
    case 'genres': viewElement = <GenresView />; break
    case 'musicman': viewElement = <MusicManView />; break
    case 'playlist': viewElement = <PlaylistView />; break
    case 'smart-playlist': viewElement = <SmartPlaylistView />; break
    case 'device': viewElement = <DeviceView />; break
    case 'cd-import': viewElement = <CDImportView />; break
    default: viewElement = <SongsView />
  }

  // 4.4.24: subtle 140ms fade-in on view switch. The `key` forces a
  // re-mount of the wrapper on every transition so the CSS animation
  // replays. The wrapper has `display: contents` so it doesn't disrupt
  // any view's intended layout (height: 100% etc. still flow through).
  return (
    <div className="main-content-view" key={transitionKey}>
      {viewElement}
    </div>
  )
}
