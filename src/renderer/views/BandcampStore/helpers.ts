import { StoreAlbumWire } from '../../types'

/** Bandcamp cover-art URL. format 16 ≈ 700px (detail), 9 ≈ 210px (tile). */
export function coverUrl(coverArtId: number | undefined, format = 9): string | null {
  if (!coverArtId) return null
  return `https://f4.bcbits.com/img/a${coverArtId}_${format}.jpg`
}

export function formatPrice(album: StoreAlbumWire): string {
  if (album.owned) return 'In Library'
  if (!album.isPurchasable) return 'Unavailable'
  if (album.price == null) return 'Buy'
  const cur = album.currency || 'USD'
  const sym = cur === 'USD' ? '$' : cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : ''
  return sym ? `${sym}${album.price.toFixed(2)}` : `${album.price.toFixed(2)} ${cur}`
}
