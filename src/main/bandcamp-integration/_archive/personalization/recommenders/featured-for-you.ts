// Featured-for-you carousel (Brief 036 v2.2, Tier 1).
// Rotating banner of new releases from followed artists + top labels.
import { StoreAlbum, UnifiedProfile } from '../../types'
import { rankAlbums } from '../ranking'

export function featuredForYou(candidates: StoreAlbum[], profile: UnifiedProfile, limit = 10): StoreAlbum[] {
  return rankAlbums(candidates, profile, 'featured-for-you').slice(0, limit)
}
