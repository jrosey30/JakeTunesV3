import { StoreAlbumWire } from '../../types'
import { formatPrice } from './helpers'

interface Props {
  album: StoreAlbumWire
  onBuy: (album: StoreAlbumWire) => void
}

export default function BuyButton({ album, onBuy }: Props) {
  if (album.owned) {
    return <span className="bcs-buy bcs-buy--owned" aria-disabled>In Library</span>
  }
  const disabled = !album.isPurchasable
  return (
    <button
      className="bcs-buy"
      disabled={disabled}
      onClick={() => onBuy(album)}
      title={disabled ? 'Not purchasable on Bandcamp' : `Buy on Bandcamp`}
    >
      {formatPrice(album)}
    </button>
  )
}
