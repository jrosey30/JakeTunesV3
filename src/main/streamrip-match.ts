/** Pure Qobuz search-result matching for streamrip — shared by download-by-query and tests. */
import { recoArtistMatches, recoNorm, recoTitleMatches } from './reco-match.ts'

export interface StreamripSearchHit { source: string; mediaType: string; id: string; desc: string }

/** streamrip result descs end with " by <artist>" — split on the LAST " by ". */
export function parseStreamripDesc(desc: string): { title: string; artist: string } {
  const i = desc.lastIndexOf(' by ')
  if (i > 0) return { title: desc.slice(0, i).trim(), artist: desc.slice(i + 4).trim() }
  return { title: desc.trim(), artist: '' }
}

/** Pick the best Qobuz hit for a reco title + artist. `wantMediaType` gates
 *  which result rows are eligible — 'track' for a song query, 'album' for an
 *  album query. This MUST match what the caller searched for: an album search
 *  returns mediaType:'album' rows, and the old hard-coded `!== 'track'` skip
 *  rejected every one of them, so album downloads silently failed (the Charli
 *  XCX "Music, Fashion, Film" / "downloads only one song" bug, 2026-07-24). */
export function pickBestStreamripMatch(
  wantTitle: string,
  wantArtist: string,
  results: StreamripSearchHit[],
  wantMediaType: 'track' | 'album' = 'track',
): StreamripSearchHit | null {
  let best: StreamripSearchHit | null = null
  let bestScore = -1
  for (const r of results) {
    if (r.mediaType !== wantMediaType) continue
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

/**
 * Pick the best SoundCloud hit for a reco title + artist (2026-07-22:
 * Qobuz-first, SoundCloud-fallback for tracks Qobuz doesn't carry —
 * indie/underground singles like "Mr Vibe" by Villanova).
 *
 * SoundCloud descs don't split cleanly into title/artist the way Qobuz
 * does — the uploader is often a label ("… by Indie House Records") and
 * the real artist + title are packed into the track name
 * ("Villanova - Mr Vibe feat. Mike Dunn [Indie House Records]"). So we
 * match against the WHOLE desc: the wanted title must appear, and the
 * wanted artist must appear somewhere in it. Both present = the right
 * upload; artist-absent = reject (avoids grabbing a random cover/bootleg).
 */
export function pickBestSoundcloudMatch(
  wantTitle: string,
  wantArtist: string,
  results: StreamripSearchHit[],
): StreamripSearchHit | null {
  const nTitle = recoNorm(wantTitle)
  const nArtist = recoNorm(wantArtist)
  if (!nTitle) return null
  let best: StreamripSearchHit | null = null
  let bestScore = -1
  for (const r of results) {
    if (r.mediaType !== 'track') continue
    const hay = recoNorm(r.desc)
    if (!hay.includes(nTitle)) continue        // title must be present
    let score = 1
    if (nArtist) {
      if (!hay.includes(nArtist)) continue     // artist required when we have one
      score += 5
    }
    // Prefer the shortest desc that still matches — usually the original
    // upload, not a "X (Y remix) [Z edit] (bootleg)" derivative.
    score += Math.max(0, 40 - r.desc.length / 4)
    if (score > bestScore) {
      bestScore = score
      best = r
    }
  }
  return best
}
