import { useLibrary } from '../context/LibraryContext'
import SongsView from '../views/SongsView'
import ArtistsView from '../views/ArtistsView'
import AlbumsView from '../views/AlbumsView'
import GenresView from '../views/GenresView'
import MusicManView from '../views/MusicManView'
import PlaylistView from '../views/PlaylistView'
import SmartPlaylistView from '../views/SmartPlaylistView'
import DeviceView from '../views/DeviceView'
import CDImportView from '../views/CDImportView'

export default function MainContent() {
  const { state } = useLibrary()

  switch (state.currentView) {
    case 'songs': return <SongsView />
    case 'artists': return <ArtistsView />
    case 'albums': return <AlbumsView />
    case 'genres': return <GenresView />
    case 'musicman': return <MusicManView />
    case 'playlist': return <PlaylistView />
    case 'smart-playlist': return <SmartPlaylistView />
    case 'device': return <DeviceView />
    case 'cd-import': return <CDImportView />
    default: return <SongsView />
  }
}
