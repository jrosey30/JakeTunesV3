// Search re-ranker (Brief 036 v2.2, Tier 1).
// Bandcamp returns results in relevance order; we multiply that order by a
// personalization boost (λ≈0.5) so taste lifts results without burying exact
// matches. Owned items are demoted (penalty), not excluded, from search.
import { StoreAlbum, UnifiedProfile } from '../../types'
import { indexProfile, scoreAlbum } from '../ranking'

const LAMBDA = 0.5

export function rerankSearch(results: StoreAlbum[], profile: UnifiedProfile): StoreAlbum[] {
  const idx = indexProfile(profile)
  const n = results.length
  return results
    .map((a, i) => {
      const relevance = n > 0 ? (n - i) / n // 1..~0, preserves Bandcamp order
        : 0
      const personal = Math.max(0, scoreAlbum(a, idx, 'search-rerank'))
      return { a, score: relevance * (1 + LAMBDA * personal) }
    })
    .sort((x, y) => y.score - x.score)
    .map((x) => x.a)
}
