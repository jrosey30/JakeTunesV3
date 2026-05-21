import { StoreAlbumWire } from '../../types'

/** Bandcamp cover-art URL. format 16 ≈ 700px (detail), 9 ≈ 210px (tile). */
export function coverUrl(coverArtId: number | undefined, format = 9): string | null {
  if (!coverArtId) return null
  return `https://f4.bcbits.com/img/a${coverArtId}_${format}.jpg`
}

/** Resolve an album's cover image. Prefers album.imageUrl (a pre-built CDN
 *  URL set by the search normalizer) over the coverArtId-built form, so
 *  results that arrive without an art id (search via autocomplete) still
 *  render. Returns null only when neither source is available. */
export function albumArt(album: StoreAlbumWire, format = 9): string | null {
  return album.imageUrl || coverUrl(album.coverArtId, format)
}

export function formatPrice(album: StoreAlbumWire): string {
  if (album.owned) return 'In Library'
  if (!album.isPurchasable) return 'Unavailable'
  if (album.price == null) return 'Buy'
  const cur = album.currency || 'USD'
  const sym = cur === 'USD' ? '$' : cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : ''
  return sym ? `${sym}${album.price.toFixed(2)}` : `${album.price.toFixed(2)} ${cur}`
}
