/** Pure Qobuz search-result matching for streamrip — shared by download-by-query and tests. */
import { recoArtistMatches, recoTitleMatches } from './reco-match.ts'

export interface StreamripSearchHit { source: string; mediaType: string; id: string; desc: string }

/** streamrip result descs end with " by <artist>" — split on the LAST " by ". */
// ⚠️ TWIN: src/renderer/views/DownloadStore/DownloadView.tsx → parseDesc
export function parseStreamripDesc(desc: string): { title: string; artist: string } {
  const i = desc.lastIndexOf(' by ')
  if (i > 0) return { title: desc.slice(0, i).trim(), artist: desc.slice(i + 4).trim() }
  return { title: desc.trim(), artist: '' }
}

/** Pick the best Qobuz track hit for a reco title + artist. */
export function pickBestStreamripMatch(
  wantTitle: string,
  wantArtist: string,
  results: StreamripSearchHit[],
): StreamripSearchHit | null {
  let best: StreamripSearchHit | null = null
  let bestScore = -1
  for (const r of results) {
    if (r.mediaType !== 'track') continue
    const { title, artist } = parseStreamripDesc(r.desc)
    if (!recoTitleMatches(wantTitle, title)) continue
    let score = 2
    if (wantArtist && artist) {
      score += recoArtistMatches(wantArtist, artist) ? 5 : -3
    } else if (artist) {
      score += 1
    }
    if (score > bestScore) {
      bestScore = score
      best = r
    }
  }
  return best
}
