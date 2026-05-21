import { StoreAlbumWire } from '../../types'
import AlbumTile from './AlbumTile'

interface Props {
  albums: StoreAlbumWire[]
  onOpen: (album: StoreAlbumWire) => void
  emptyLabel?: string
}

export default function AlbumGrid({ albums, onOpen, emptyLabel }: Props) {
  if (albums.length === 0) {
    return <div className="bcs-empty">{emptyLabel || 'Nothing to show yet.'}</div>
  }
  return (
    <div className="bcs-grid">
      {albums.map((a) => (
        <AlbumTile key={`${a.id}-${a.url}`} album={a} onOpen={onOpen} />
      ))}
    </div>
  )
}
