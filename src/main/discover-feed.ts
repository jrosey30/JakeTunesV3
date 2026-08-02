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
  /** The artist ALREADY IN THE LIBRARY this pick bridges from — the "you play
   *  a lot of X, so try Y" link. Jake asked for this by name: a recommendation
   *  with no stated reason reads as random, and the generic `why` lines were
   *  filler ("Boards of Canada. That's the whole reason.").
   *
   *  MUST be validated against the real taste anchors before it is set. A
   *  fabricated "because you like …" is worse than none — it claims to know
   *  the listener and gets it wrong. Unvalidated = left undefined. */
  because?: string
}

interface ItunesHit {
  artistName?: string
  trackName?: string
  collectionName?: string
  releaseDate?: string
  artworkUrl100?: string
  previewUrl?: string
}

/** Fuzzy field match: equal, one contains the other, or ≥60% token overlap.
 *  Catches "The Garden" vs "Garden", "… (Deluxe)" suffixes, feat. noise. */
function fieldMatches(a: string, b: string): boolean {
  const na = normKey(a), nb = normKey(b)
  if (!na || !nb) return false
  if (na === nb || na.includes(nb) || nb.includes(na)) return true
  const ta = new Set(na.split(' ').filter(Boolean))
  const tb = nb.split(' ').filter(Boolean)
  if (tb.length === 0) return false
  const hits = tb.filter((t) => ta.has(t)).length
  return hits / Math.max(ta.size, tb.length) >= 0.6
}

/** Verify a candidate against iTunes Search; returns canonical fields or null.
 *  Tolerates Apple's occasional 403/rate-limit by simply returning null —
 *  an unverified card is dropped, never shown on faith.
 *
 *  `want` (2026-07-23): when the caller KNOWS the artist/title (journalism +
 *  MusicBrainz cards being dressed with art), we must not accept whatever
 *  iTunes returns first — "The Garden Bootleg" was matching *With The Beatles*
 *  and stamping the wrong cover on the card. With `want`, scan the top hits and
 *  take the FIRST whose artist (and album title, for albums) actually matches;
 *  return null (→ placeholder, honest) if none do. */
export async function itunesVerify(
  term: string,
  entity: 'song' | 'album' | 'musicArtist',
  want?: { artist?: string; title?: string },
): Promise<{ artist: string; title: string; year?: string; artUrl?: string; previewUrl?: string } | null> {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=${entity}&limit=6`
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return null
    const results = (await res.json() as { results?: ItunesHit[] }).results || []
    const titleOf = (h: ItunesHit) => entity === 'song' ? String(h.trackName || '').trim()
      : entity === 'album' ? String(h.collectionName || '').trim()
      : String(h.artistName || '').trim()
    const hit = want
      ? results.find((h) => {
          const artistOk = !want.artist || fieldMatches(String(h.artistName || ''), want.artist)
          const titleOk = !want.title || entity === 'musicArtist' || fieldMatches(titleOf(h), want.title)
          return artistOk && titleOk
        })
      : results[0]
    if (!hit) return null
    const artist = String(hit.artistName || '').trim()
    if (!artist) return null
    const title = titleOf(hit)
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
