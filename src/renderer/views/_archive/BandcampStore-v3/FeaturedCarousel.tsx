import { useEffect, useState } from 'react'
import { StoreAlbumWire } from '../../types'
import { albumArt } from './helpers'

interface Props {
  items: StoreAlbumWire[]
  onOpen: (album: StoreAlbumWire) => void
}

export default function FeaturedCarousel({ items, onOpen }: Props) {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (items.length <= 1) return
    const id = setInterval(() => setIndex((i) => (i + 1) % items.length), 6000)
    return () => clearInterval(id)
  }, [items.length])

  if (items.length === 0) return null
  const safe = index % items.length
  const album = items[safe]
  const art = albumArt(album, 16)

  return (
    <div className="bcs-carousel">
      <button className="bcs-carousel-banner" onClick={() => onOpen(album)}>
        {art && <img className="bcs-carousel-img" src={art} alt="" />}
        <div className="bcs-carousel-overlay">
          <div className="bcs-carousel-kicker">Featured for you</div>
          <div className="bcs-carousel-title">{album.title}</div>
          <div className="bcs-carousel-artist">{album.artist}</div>
        </div>
      </button>
      {items.length > 1 && (
        <div className="bcs-carousel-dots">
          {items.map((_, i) => (
            <button
              key={i}
              className={`bcs-dot ${i === safe ? 'bcs-dot--active' : ''}`}
              onClick={() => setIndex(i)}
              aria-label={`Slide ${i + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  )
}
