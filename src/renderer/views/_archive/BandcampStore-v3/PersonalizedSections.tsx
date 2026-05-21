import { StoreAlbumWire } from '../../types'
import AlbumGrid from './AlbumGrid'

interface Props {
  title: string
  albums: StoreAlbumWire[]
  onOpen: (album: StoreAlbumWire) => void
  emptyLabel?: string
}

/** A titled iTunes-Store-style section (grey rounded header bar + grid). */
export default function PersonalizedSection({ title, albums, onOpen, emptyLabel }: Props) {
  return (
    <section className="bcs-section">
      <div className="bcs-section-head">
        <h3 className="bcs-section-title">{title}</h3>
      </div>
      <AlbumGrid albums={albums} onOpen={onOpen} emptyLabel={emptyLabel} />
    </section>
  )
}
