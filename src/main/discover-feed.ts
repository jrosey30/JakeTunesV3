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

import { searchTitle, unwantedVersionOf } from './streamrip-match.ts'
import { binForGenre, pickHookIndex } from './record-shop-bins.ts'

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
  /** iTunes primaryGenreName, when verification saw one — feeds the brain's
   *  candidate embedding so the cosine isn't judging an artist name alone. */
  genre?: string
  /** A sonic one-liner for the brain's embedding (usually the lane's `why` or
   *  the scene connection). Only set when it describes the MUSIC — "3 of
   *  their tracks already yours" is inventory, not sound, and stays out. */
  desc?: string
  /** Shop bin divider (2026-08-22 crate reorg) — computed from genre. */
  bin?: string
  /** iTunes collection id, when verification saw one — the key that lets
   *  the hook-sample pass look the album's tracks up. */
  collectionId?: number
  /** Album cards: the ONE 30s sample doing the selling (Jake: "one song
   *  … that is going to hook me"). Chosen by the brain over the album's
   *  tracks; song cards keep their own previewUrl as before. */
  hookPreviewUrl?: string
  hookTitle?: string
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
  primaryGenreName?: string
  collectionId?: number
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
): Promise<{ artist: string; title: string; year?: string; artUrl?: string; previewUrl?: string; genre?: string; collectionId?: number } | null> {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=${entity}&limit=6`
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return null
    const results = (await res.json() as { results?: ItunesHit[] }).results || []
    const titleOf = (h: ItunesHit) => entity === 'song' ? String(h.trackName || '').trim()
      : entity === 'album' ? String(h.collectionName || '').trim()
      : String(h.artistName || '').trim()
    const matches = want
      ? results.filter((h) => {
          const artistOk = !want.artist || fieldMatches(String(h.artistName || ''), want.artist)
          const titleOk = !want.title || entity === 'musicArtist' || fieldMatches(titleOf(h), want.title)
          return artistOk && titleOk
        })
      : results.slice(0, 1)
    // Canonical-edition preference (2026-08-21, the Kitchen Tape Demo reject):
    // when the request didn't name a version, prefer the hit that doesn't add
    // one — "Undone" should resolve to the song, not whichever demo/live/
    // remaster Apple ranks first. Preference only: if every hit is decorated,
    // the first match still wins (some records only exist decorated).
    const wantTitle = want?.title || ''
    const hit = entity === 'musicArtist'
      ? matches[0]
      : matches.find((h) => unwantedVersionOf(wantTitle, titleOf(h)) === null) ?? matches[0]
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
      genre: hit.primaryGenreName ? String(hit.primaryGenreName) : undefined,
      collectionId: typeof hit.collectionId === 'number' ? hit.collectionId : undefined,
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

/**
 * Recording-identity key for owned-matching: edition brackets, subtitles, and
 * marked dash-suffixes stripped, then normalized. "Undone -- The Sweater Song
 * (Kitchen Tape Demo)" and "Undone - The Sweater Song" collapse to the same
 * key, so owning the song blocks every decorated variant of it. Built on the
 * download pipeline's battle-tested strippers (searchTitle) rather than a
 * fresh twin.
 */
export function baseTitleKey(title: string): string {
  const s = searchTitle(String(title || ''))
    // Remaining brackets are version markers ("(Live)") or subtitles
    // ("(Hear Me Tonight)") — for IDENTITY both collapse into the base.
    .replace(/\s*[([{][^)\]}]*[)\]}]\s*/g, ' ')
    // " - Live at Reading" style suffixes: only stripped when the suffix
    // actually carries a version marker — "Song - Part 2" is a title.
    .replace(/\s+[-–—]\s+[^-–—]*\b(live|demo|acoustic|remix|session|sessions|version|instrumental|unplugged|bootleg|cover|edit|mix)\b[^-–—]*$/i, '')
  return normKey(s) || normKey(title)
}

/** Drop cards the user owns (artist match against owned artist set for
 *  artist-cards, artist+title for albums/songs — exact AND base-title, so a
 *  demo/deluxe/live variant of an owned recording is still "owned"), has
 *  vetoed, or that are resting from rotation. Dedupes across lanes (first
 *  lane wins). */
export function filterFeed(
  cards: FeedCard[],
  opts: {
    ownedArtists: Set<string>
    ownedAlbumKeys: Set<string>
    /** `artistNorm|baseTitleKey` of every owned track title + album. */
    ownedBaseKeys?: Set<string>
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
    if (c.type !== 'artist') {
      if (opts.ownedAlbumKeys.has(key)) return false
      // Base-identity check — guarded against self-titled collapse: Weezer's
      // five self-titled albums all reduce to "weezer", so a base key equal
      // to the artist name proves nothing and only the exact key counts.
      const bt = baseTitleKey(c.title)
      if (opts.ownedBaseKeys && bt && bt !== ak && opts.ownedBaseKeys.has(`${ak}|${bt}`)) return false
    }
    const sv = opts.served[key]
    if (sv && sv.views >= rv && opts.now - sv.last < rr) return false
    return true
  })
}

// ── Quality floor ────────────────────────────────────────────────────
// The brain's floor for a shelf spot. Below BRAIN_FLOOR the brain doesn't
// actually believe in the pick; a thin lane may back-fill with its best
// sub-floor cards down to BRAIN_HARD_FLOOR (a small shelf of decent picks
// beats an empty shelf), but a 40 — the "no signal" sentinel — never ships.
export const BRAIN_FLOOR = 60
export const BRAIN_HARD_FLOOR = 52
export const BRAIN_LANE_MIN = 3

/** Apply the floor per lane. Only meaningful after brainPct is stamped —
 *  callers skip this entirely when the brain didn't score (null pcts). */
export function applyQualityFloor(cards: FeedCard[]): FeedCard[] {
  const byLane = new Map<string, FeedCard[]>()
  for (const c of cards) {
    const arr = byLane.get(c.lane) || []
    arr.push(c)
    byLane.set(c.lane, arr)
  }
  const out: FeedCard[] = []
  for (const arr of byLane.values()) {
    const kept = arr.filter((c) => (c.brainPct ?? 0) >= BRAIN_FLOOR)
    if (kept.length < BRAIN_LANE_MIN) {
      const backfill = arr
        .filter((c) => (c.brainPct ?? 0) >= BRAIN_HARD_FLOOR && (c.brainPct ?? 0) < BRAIN_FLOOR)
        .sort((a, b) => (b.brainPct ?? 0) - (a.brainPct ?? 0))
        .slice(0, BRAIN_LANE_MIN - kept.length)
      kept.push(...backfill)
    }
    out.push(...kept)
  }
  return out
}

// ── Shop passes (2026-08-22 crate reorg) ────────────────────────────
// Extracted here the night the index.ts line-ratchet tripped on them —
// the rail said "new capability belongs in a MODULE" and it was right.
// Deps arrive injected so node --test can exercise both passes.

/** Every card files under a genre divider. */
export function stampBins(cards: FeedCard[]): void {
  for (const c of cards) c.bin = binForGenre(c.genre)
}

/**
 * Deeper clerk pitches for the scene lane (Jake: "all you say is that
 * bands are label mates with other bands. need you to get deeper than
 * that"). The MusicBrainz connection stays as grounding; the pitch is the
 * sale — sound, era, scene role, what carries over from the bridge
 * artist. Rewrites why + desc in place (run BEFORE scoring so the pitch
 * feeds the embedding too). Fail-soft: any error keeps connection lines.
 */
export async function applyScenePitches(
  cards: FeedCard[],
  deps: { pitchCall: (prompt: string) => Promise<string> },
): Promise<void> {
  const sceneCards = cards.filter((c) => c.lane === 'scene')
  if (!sceneCards.length) return
  try {
    const roster = sceneCards.map((c, i) => `${i}. ${c.artist} — "${c.title}" (bridge: ${c.because ?? 'the scene'}; connection fact: ${c.why})`).join('\n')
    const prompt = `You are pitching records across the counter of a Greenpoint shop. For each pick, ONE pitch line, 16 words max: the SPECIFIC thread — the sound, the era, the scene role, what carries over from the bridge artist. The connection fact is context, never the pitch itself; do not lead with "label-mates". If a band is unfamiliar, pitch from the connection + the bridge artist's sound — never invent facts.\n\n${roster}\n\nReturn ONLY JSON: [{"i":0,"pitch":"..."}] covering every pick. No prose.`
    const text = await deps.pitchCall(prompt)
    for (const r of parseFeedJson<{ i?: number; pitch?: string }>(text)) {
      const c = typeof r.i === 'number' ? sceneCards[r.i] : undefined
      if (c && r.pitch) { c.why = clipWhy(String(r.pitch), 16); c.desc = c.why }
    }
  } catch (err) {
    console.warn('[discover] scene pitch pass failed (keeping connection lines):', err)
  }
}

/**
 * Album hook samples (Jake: "one song be the 30 second sample for the
 * entire album that is going to hook me"). Bounded: floor-surviving
 * albums only, 16 max, polite spacing between lookups, ONE score batch
 * over every album's tracks. The highest-scoring previewable track is
 * the sample; artist's own track order is the no-brain fallback.
 */
export async function applyAlbumHooks(
  shelved: FeedCard[],
  deps: {
    albumTracks: (collectionId: number) => Promise<{ ok: boolean; tracks: Array<{ song: string; artist: string; previewUrl?: string; genre?: string }> }>
    scoreCandidates: (cands: Array<{ artist: string; title: string; genre: string; type: string; desc?: string }>) => Promise<number[] | null>
    sleepMs?: number
  },
): Promise<void> {
  const hookAlbums = shelved.filter((c) => c.type === 'album' && c.collectionId && !c.hookPreviewUrl).slice(0, 16)
  if (!hookAlbums.length) return
  const perAlbum: Array<{ card: FeedCard; hookTracks: Array<{ song: string; artist: string; previewUrl?: string; genre?: string }> }> = []
  for (const c of hookAlbums) {
    const r = await deps.albumTracks(c.collectionId as number).catch(() => null)
    await new Promise((r2) => setTimeout(r2, deps.sleepMs ?? 250))
    const withPrev = (r?.ok ? r.tracks : []).filter((t) => t.previewUrl)
    if (withPrev.length) perAlbum.push({ card: c, hookTracks: withPrev.slice(0, 14) })
  }
  if (!perAlbum.length) return
  const flat = perAlbum.flatMap(({ card, hookTracks }) => hookTracks.map((t) => ({ artist: t.artist, title: t.song, genre: t.genre || card.genre || '', type: 'song', desc: card.desc })))
  const hookPcts = await deps.scoreCandidates(flat)
  let off = 0
  for (const { card, hookTracks } of perAlbum) {
    const scored = hookTracks.map((t, j) => ({ previewUrl: t.previewUrl, pct: hookPcts ? hookPcts[off + j] : undefined }))
    off += hookTracks.length
    const hi = pickHookIndex(scored)
    if (hi >= 0) { card.hookPreviewUrl = hookTracks[hi].previewUrl; card.hookTitle = hookTracks[hi].song }
  }
}

/**
 * Dress artless cards from iTunes (moved from index.ts when the line
 * ratchet caught the crate-reorg growth). Existence is already grounded
 * by each card's source; a missing hit keeps the card with the honest
 * placeholder. Also backfills genre + collectionId when the lookup sees
 * them — the bins and the hook pass feed on those.
 */
export async function dressArtlessCards(cards: FeedCard[], sleepMs = 200): Promise<void> {
  for (const c of cards) {
    if (c.artUrl) continue
    const v = await itunesVerify(`${c.artist} ${c.title}`, 'album', { artist: c.artist, title: c.title }).catch(() => null)
    if (v?.artUrl) { c.artUrl = v.artUrl; if (!c.year && v.year) c.year = v.year }
    if (v?.genre && !c.genre) c.genre = v.genre
    if (v?.collectionId && !c.collectionId) c.collectionId = v.collectionId
    await new Promise((r) => setTimeout(r, sleepMs))
  }
}
