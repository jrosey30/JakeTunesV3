import { StoreAlbumWire } from '../../types'
import { coverUrl } from './helpers'

interface Props {
  album: StoreAlbumWire
  onOpen: (album: StoreAlbumWire) => void
}

export default function AlbumTile({ album, onOpen }: Props) {
  const art = coverUrl(album.coverArtId, 9)
  return (
    <button className="bcs-tile" onClick={() => onOpen(album)} title={`${album.title} — ${album.artist}`}>
      <div className="bcs-tile-art">
        {art
          ? <img className="bcs-tile-img" src={art} alt="" loading="lazy" />
          : <div className="bcs-tile-noart" />}
        {album.owned && <span className="bcs-owned-badge">In Library</span>}
      </div>
      <div className="bcs-tile-title">{album.title || 'Untitled'}</div>
      <div className="bcs-tile-artist">{album.artist}</div>
    </button>
  )
}
