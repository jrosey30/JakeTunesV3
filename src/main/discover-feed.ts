/**
 * Discover feed — typed, multi-lane recommendations (2026-07-14 rebuild).
 *
 * Jake's verdict on the old radar: "it doesn't know what it is recommending
 * at all. songs, artists, albums, new old in between." He's right — it only
 * knew ONE thing (this year's releases from journalism). The rebuilt feed
 * recommends across the whole space, and every card KNOWS WHAT IT IS:
 *
 *   type: 'song' | 'album' | 'artist'   +   era (the year, or "New")
 *
 * Lanes (assembled in index.ts's get-discover-feed):
 *   brand-new     — this year's releases, grounded in music journalism (Exa)
 *   missing       — albums Jake DOESN'T own from artists he loves, grounded
 *                   in MusicBrainz discographies (real gaps, never guessed)
 *   time-machine  — any-era albums/artists adjacent to his taste
 *   songs         — individual tracks to try (previewable)
 *
 * GROUNDING: LLM-suggested cards (time-machine, songs) are only shown after
 * iTunes Search CONFIRMS they exist — we render Apple's canonical name, art,
 * year, and preview, never the model's memory. Unverified = dropped.
 */

export type FeedCardType = 'song' | 'album' | 'artist'

export interface FeedCard {
  lane: string
  type: FeedCardType
  artist: string
  title: string          // song/album title; for type 'artist' same as artist
  year?: string
  why: string            // ≤ 8 words, enforced at prompt + clipped here
  artUrl?: string
  previewUrl?: string
  brainPct?: number
}

interface ItunesHit {
  artistName?: string
  trackName?: string
  collectionName?: string
  releaseDate?: string
  artworkUrl100?: string
  previewUrl?: string
}

/** Verify a candidate against iTunes Search; returns canonical fields or null.
 *  Tolerates Apple's occasional 403/rate-limit by simply returning null —
 *  an unverified card is dropped, never shown on faith. */
export async function itunesVerify(
  term: string,
  entity: 'song' | 'album' | 'musicArtist',
): Promise<{ artist: string; title: string; year?: string; artUrl?: string; previewUrl?: string } | null> {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=${entity}&limit=3`
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return null
    const data = await res.json() as { results?: ItunesHit[] }
    const hit = (data.results || [])[0]
    if (!hit) return null
    const artist = String(hit.artistName || '').trim()
    if (!artist) return null
    const title = entity === 'song' ? String(hit.trackName || '').trim()
      : entity === 'album' ? String(hit.collectionName || '').trim()
      : artist
    if (!title) return null
    return {
      artist,
      title,
      year: hit.releaseDate ? String(new Date(hit.releaseDate).getFullYear()) : undefined,
      artUrl: hit.artworkUrl100?.replace('100x100', '300x300'),
      previewUrl: entity === 'song' ? hit.previewUrl : undefined,
    }
  } catch {
    return null
  }
}

/** Tolerant parse of an LLM JSON array (fences/prose stripped). */
export function parseFeedJson<T>(text: string): T[] {
  if (!text) return []
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fence ? fence[1] : text).trim()
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const arr = JSON.parse(body.slice(start, end + 1))
    return Array.isArray(arr) ? arr as T[] : []
  } catch { return [] }
}

const normKey = (s: string) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()
export const cardKey = (c: { artist: string; title: string }) => `${normKey(c.artist)}|${normKey(c.title)}`

/** Clip a "why" to at most n words — the feed shows phrases, not paragraphs. */
export function clipWhy(why: string, maxWords = 9): string {
  const words = String(why || '').replace(/["""]/g, '').trim().split(/\s+/)
  return words.slice(0, maxWords).join(' ')
}

/** Drop cards the user owns (artist match against owned artist set for
 *  artist-cards, artist+title for albums/songs), has vetoed, or that are
 *  resting from rotation. Dedupes across lanes (first lane wins). */
export function filterFeed(
  cards: FeedCard[],
  opts: {
    ownedArtists: Set<string>
    ownedAlbumKeys: Set<string>
    notForMe: Record<string, unknown>
    served: Record<string, { views: number; last: number }>
    now: number
    rotateViews?: number
    rotateRestMs?: number
  },
): FeedCard[] {
  const seen = new Set<string>()
  const rv = opts.rotateViews ?? 4
  const rr = opts.rotateRestMs ?? 14 * 24 * 3600 * 1000
  return cards.filter((c) => {
    const ak = normKey(c.artist)
    const key = cardKey(c)
    if (seen.has(key)) return false
    seen.add(key)
    if (opts.notForMe[ak]) return false
    if (c.type === 'artist' && opts.ownedArtists.has(ak)) return false
    if (c.type !== 'artist' && opts.ownedAlbumKeys.has(key)) return false
    const sv = opts.served[key]
    if (sv && sv.views >= rv && opts.now - sv.last < rr) return false
    return true
  })
}
