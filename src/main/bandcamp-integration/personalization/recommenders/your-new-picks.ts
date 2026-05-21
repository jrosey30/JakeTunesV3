// Your New Picks (Brief 036 v2.2, Tier 1).
// New releases from followed artists, ranked by recency + engagement.
import { StoreAlbum, UnifiedProfile } from '../../types'
import { rankAlbums } from '../ranking'

export function yourNewPicks(candidates: StoreAlbum[], profile: UnifiedProfile, limit = 20): StoreAlbum[] {
  return rankAlbums(candidates, profile, 'your-new-picks').slice(0, limit)
}
