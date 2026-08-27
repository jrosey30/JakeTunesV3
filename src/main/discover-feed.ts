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
import { recoArtistMatches } from './reco-match.ts'
import { binForGenre, pickHookIndex } from '../common/record-shop-bins.ts'

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
  if (start < 0) return []
  // A TRUNCATED reply used to return [] — the whole lane, silently zero.
  // 2026-08-25: the brand-new ask went 24 -> 40 rows without raising the token
  // budget, the JSON was cut mid-array, and the one lane carrying NEW music
  // collapsed to a single card. Salvage the objects that DID arrive.
  if (end <= start) return salvageObjects<T>(body.slice(start))
  try {
    const arr = JSON.parse(body.slice(start, end + 1))
    return Array.isArray(arr) ? arr as T[] : []
  } catch { return salvageObjects<T>(body.slice(start)) }
}

const normKey = (s: string) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()
/** Accent-FOLDING key: combining marks are removed BEFORE the non-alnum
 *  strip, so "Récord" → "record" and "JAŸ-Z" → "jay z" (normKey turns the
 *  orphaned marks into spaces — "re cord"). normKey itself CANNOT change:
 *  cardKey feeds the persisted served/notForMe ledgers, and refolding it
 *  would orphan every verdict Jake has already given. Use foldKey only for
 *  ephemeral, rebuilt-per-run comparisons. */
export const foldKey = (s: string): string => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
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
  for (const [lane, arr] of byLane) {
    // Quota lanes (25/25, "NO LESS"): the brain ORDERS them, it never
    // starves them — the count is the contract, not the cosine.
    if (QUOTA_LANES.has(lane)) { out.push(...arr); continue }
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

/**
 * Release types that are NOISE in a discovery shelf (2026-08-25, Jake: "i see
 * a lack of new music in discovery pretty much always....its glitchy").
 *
 * The gap lane asks MusicBrainz for everything an artist released and the brain
 * stamps it with ARTIST affinity, so a blink-182 "Studio Outtakes" scored 99%
 * — a confident recommendation of something nobody wants. One audit of the live
 * feed found outtakes, an "EP" of an album, "Spotify Singles", "Shady Beats",
 * a bootleg-shaped "Dark Ages Chronicles - The Red Handle Pandemic PT1", and
 * the TRON: Legacy soundtrack THREE times (album, score, collector's EP).
 *
 * Deliberately NOT filtered: live albums and remixes as such — some are
 * canonical works. This targets non-releases: session leftovers, promo
 * exclusives, and interview/sampler discs.
 */
const JUNK_RELEASE = new RegExp([
  'outtakes?', 'studio\\s+sessions?', 'rough\\s+mixes?', 'demos?\\b',
  'unreleased', 'bootleg', 'sampler', 'interview', 'karaoke', 'tribute',
  'spotify\\s+singles?', 'itunes\\s+session', 'aol\\s+sessions?',
  'radio\\s+sessions?', 'beats?\\b', 'chronicles?\\b',
  'instrumentals?$', 'a\\s+cappellas?$',
].join('|'), 'i')

/** A film/game SCORE — fine as a record, noise when the same soundtrack also
 *  appears as album and collector's EP. Used to keep ONE per soundtrack. */
const SCORE_MARKER = /\b(score|original motion picture|soundtrack|ost)\b/i

export function isJunkRelease(title: string): boolean {
  return JUNK_RELEASE.test(String(title || ''))
}

/**
 * Trim a gap-lane to real records: drop noise releases, collapse a soundtrack
 * to a single entry, and cap how many one artist may take — four blink-182
 * albums in a row is a completion list, not discovery.
 */
export function trimGapLane<T extends { artist?: string; title?: string }>(
  cards: T[],
  opts: { perArtist?: number } = {},
): T[] {
  const perArtist = opts.perArtist ?? 1
  const nk = (s: unknown) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()
  const count = new Map<string, number>()
  const scored = new Set<string>()
  const out: T[] = []
  for (const c of cards) {
    const title = String(c.title || '')
    if (!title || isJunkRelease(title)) continue
    const a = nk(c.artist)
    // One soundtrack per artist — the TRON: Legacy hat-trick.
    if (SCORE_MARKER.test(title) || /tron|legacy/i.test(title)) {
      const base = `${a}|${nk(title).split(' ').slice(0, 2).join(' ')}`
      if (scored.has(base)) continue
      scored.add(base)
    }
    const n = count.get(a) || 0
    if (n >= perArtist) continue
    count.set(a, n + 1)
    out.push(c)
  }
  return out
}

/** Build the completion shelf from fetched discographies: drop owned records,
 *  drop noise, one per artist, hard ceiling. Lives here (not index.ts) so the
 *  rationale sits beside the filters it depends on. */
export function buildGapCards(
  input: Array<{ artist: string; tracks: number; albums: Array<{ title: string; year?: string | number }> }>,
  ownedAlbumKeys: Set<string>,
  opts: { limit?: number } = {},
): FeedCard[] {
  const nk = (s: unknown) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()
  const gap: FeedCard[] = []
  for (const a of input) {
    for (const al of a.albums) {
      if (ownedAlbumKeys.has(`${nk(a.artist)}|${nk(al.title)}`)) continue
      // The why-line is a FACT (owned-track count), not a model claim.
      gap.push({ lane: 'missing', type: 'album', artist: a.artist, title: al.title, year: String(al.year || ''), why: `${a.tracks} of their tracks already yours`, because: a.artist } as FeedCard)
    }
  }
  return trimGapLane(gap, { perArtist: 1 }).slice(0, opts.limit ?? 6)
}

/** Existence gate for a journalism-sourced pick: iTunes first, Cover Art
 *  Archive second (the underground lives off Apple's map), no art = no card.
 *  Extracted so the brand-new lane reads as one call — 2026-08-25, when that
 *  lane was found to be the only LLM lane shipping UNVERIFIED cards and a
 *  third of the shop turned out to be phrases lifted from article prose
 *  ("Kelela — new avatar", "Arca — XXXXX": Apple returns zero for both). */
export async function dressJournalismPick(
  r: { artist?: string; title?: string; year?: string; why?: string },
  deps: {
    verify: (q: string, entity: 'album', hint: { artist: string; title: string }) => Promise<{ artist: string; title: string; year?: string; artUrl?: string; genre?: string; collectionId?: number } | null>
    caa: (artist: string, title: string) => Promise<string | null>
    clipWhy: (s: string) => string
  },
): Promise<FeedCard | null> {
  if (!r.artist || !r.title) return null
  const artist = String(r.artist), title = String(r.title)
  // DEEZER FIRST here too (2026-08-25). This gate kept asking Apple first while
  // Apple was throttling us, so the one lane that carries NEW music sat at 3
  // cards while every other lane recovered. Apple is the enrichment pass now,
  // not the gatekeeper — and it never was proof of existence.
  const dz = await deezerVerify(artist, title).catch(() => null)
  const v = dz?.artUrl ? null : await deps.verify(`${artist} ${title}`, 'album', { artist, title }).catch(() => null)
  if (!dz?.artUrl) await new Promise((res) => setTimeout(res, 250))
  const caa = (v?.artUrl || dz?.artUrl) ? null : await deps.caa(artist, title).catch(() => null)
  const art = dz?.artUrl || v?.artUrl || caa
  if (!art) return null
  const why = deps.clipWhy(String(r.why || ''))
  return {
    lane: 'brand-new', type: 'album',
    artist: dz?.artist || v?.artist || artist, title: dz?.title || v?.title || title,
    year: dz?.year || v?.year || String(r.year || new Date().getFullYear()),
    why, artUrl: art,
    genre: v?.genre, collectionId: v?.collectionId, desc: why,
  } as FeedCard
}

/**
 * Deezer verification — the answer to two problems at once (2026-08-25, Jake:
 * "find ways to make it work!!!").
 *
 * 1. Apple rate-limits by IP and 403s under any real load, which starved every
 *    verified lane. Deezer's public search needs no key and is far more
 *    generous.
 * 2. Apple simply does not carry a lot of underground music. I very nearly
 *    deleted Kelela's "new avatar" and Arca's "XXXXX" as hallucinations
 *    because Apple returned zero for both — Deezer has them, with art. Those
 *    are exactly the records Jake wants surfaced, so an Apple miss must never
 *    be read as "does not exist".
 *
 * record_type is a bonus quality signal Apple's search does not give us:
 * "album" vs "single"/"ep"/"compilation" separates a record from a promo drop.
 */
export interface CatalogHit {
  artist: string
  title: string
  year?: string
  artUrl?: string
  recordType?: string
  trackCount?: number
}

export async function deezerVerify(
  artist: string,
  title: string,
  fetchFn: typeof fetch = fetch,
): Promise<CatalogHit | null> {
  const q = encodeURIComponent(`${artist} ${title}`.trim())
  if (!q) return null
  const res = await fetchFn(`https://api.deezer.com/search/album?q=${q}&limit=5`)
  if (!res.ok) return null
  const body = await res.json() as { data?: Array<Record<string, unknown>> }
  const rows = Array.isArray(body?.data) ? body.data : []
  if (!rows.length) return null
  const want = `${artist} ${title}`.toLowerCase().replace(/[^a-z0-9]+/g, '')
  // Prefer a row whose artist AND title both look right; fall back to the
  // first hit, which Deezer already ranks by relevance.
  const scored = rows.map((r) => {
    const a = String((r.artist as { name?: string })?.name || '')
    const t = String(r.title || '')
    const joined = `${a} ${t}`.toLowerCase().replace(/[^a-z0-9]+/g, '')
    let score = 0
    if (joined === want) score += 4
    if (want.includes(t.toLowerCase().replace(/[^a-z0-9]+/g, '')) && t) score += 2
    if (want.includes(a.toLowerCase().replace(/[^a-z0-9]+/g, '')) && a) score += 2
    if (String(r.record_type || '') === 'album') score += 1
    return { r, a, t, score }
  }).sort((x, y) => y.score - x.score)
  const best = scored[0]
  if (!best || best.score < 2) return null
  const r = best.r
  return {
    artist: best.a || artist,
    title: best.t || title,
    year: String(r.release_date || '').slice(0, 4) || undefined,
    artUrl: String(r.cover_big || r.cover_medium || '') || undefined,
    recordType: String(r.record_type || '') || undefined,
    trackCount: typeof r.nb_tracks === 'number' ? r.nb_tracks : undefined,
  }
}

/** Deezer track lookup — also yields a 30s preview, which the songs lane needs. */
export async function deezerTrack(artist: string, title: string, fetchFn: typeof fetch = fetch): Promise<(CatalogHit & { previewUrl?: string }) | null> {
  const q = encodeURIComponent(`${artist} ${title}`.trim())
  if (!q) return null
  const res = await fetchFn(`https://api.deezer.com/search/track?q=${q}&limit=5`)
  if (!res.ok) return null
  const body = await res.json() as { data?: Array<Record<string, unknown>> }
  const rows = Array.isArray(body?.data) ? body.data : []
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const wantA = norm(artist), wantT = norm(title)
  for (const r of rows) {
    const a = String((r.artist as { name?: string })?.name || '')
    const t = String(r.title || '')
    if (!norm(a).includes(wantA) && !wantA.includes(norm(a))) continue
    if (!norm(t).includes(wantT) && !wantT.includes(norm(t))) continue
    const al = r.album as { cover_big?: string; cover_medium?: string } | undefined
    return { artist: a, title: t, artUrl: al?.cover_big || al?.cover_medium, previewUrl: String(r.preview || '') || undefined }
  }
  return null
}

/**
 * The verification any lane should use: Apple first (richest metadata), Deezer
 * second. Apple 403s this IP under load and does not carry much underground
 * music, and BOTH failure modes previously read as "this record is not real" —
 * which starved time-machine to 2 cards and songs to 3 on a live run.
 */
export async function catalogVerify(
  q: string,
  entity: 'album' | 'song' | 'musicArtist',
  hint: { artist: string; title?: string },
  itunes: (q: string, e: 'album' | 'song' | 'musicArtist', h: { artist: string; title?: string }) => Promise<{ artist: string; title: string; year?: string; artUrl?: string; genre?: string; collectionId?: number; previewUrl?: string } | null>,
): Promise<{ artist: string; title: string; year?: string; artUrl?: string; genre?: string; collectionId?: number; previewUrl?: string } | null> {
  // 2026-08-25 — DEEZER FIRST. Apple was primary and it 403s this IP under any
  // real load: six test regenerations in an hour throttled it hard enough that
  // every verified lane shrank (39 cards -> 20) and Jake got served the worst
  // one. Deezer needs no key, does not throttle like this, and carries the
  // underground Apple omits. Apple is now the ENRICHMENT pass (genre,
  // collectionId) for the rows Deezer cannot answer.
  const title = hint.title || ''
  if (entity !== 'musicArtist' && title) {
    if (entity === 'song') {
      const t = await deezerTrack(hint.artist, title).catch(() => null)
      if (t?.artUrl && acceptableHit(hint, t)) return { artist: t.artist, title: t.title, artUrl: t.artUrl, previewUrl: t.previewUrl }
    } else {
      const d = await deezerVerify(hint.artist, title).catch(() => null)
      if (d?.artUrl && acceptableHit(hint, d)) return { artist: d.artist, title: d.title, year: d.year, artUrl: d.artUrl }
    }
  }
  const v = await itunes(q, entity, hint).catch(() => null)
  if (v?.artUrl && acceptableHit(hint, v)) return v
  if (entity === 'musicArtist') return v
  if (!title) return v
  return null
}

/**
 * Does a catalogue row actually answer what we asked for? (2026-08-25)
 *
 * Two ways a "verified" card was still wrong on the live shop:
 *  - WRONG ARTIST. "Killing in the Name" came back credited to "Rage Against
 *    the Blues" — a soundalike — and shipped, because verification only
 *    checked that SOMETHING came back. Flagged once before and it recurred,
 *    so it is a guard now, not a note.
 *  - WRONG CUT. "Liquid Swords (Instrumental)" and "Born Slippy (Radio Edit)"
 *    are not the record you would hand someone.
 *
 * Both guards are REUSED, not re-written: recoArtistMatches (reco-match.ts)
 * and unwantedVersionOf (streamrip-match.ts, the download wrong-version guard).
 */
export function acceptableHit(
  want: { artist: string; title?: string },
  got: { artist?: string; title?: string },
): boolean {
  if (want.artist && got.artist && !recoArtistMatches(want.artist, got.artist)) return false
  const cut = want.title && got.title ? unwantedVersionOf(want.title, got.title) : null
  // Downloads must refuse ANY unasked-for version; discovery only refuses an
  // artefact nobody would shelve. A remaster or a live pressing is still the
  // record. Rejecting all of them cost real cards for no quality gain.
  if (cut && /^(karaoke|tribute|instrumental|instrumentals|acappella|commentary)$/i.test(cut)) return false
  return true
}

/** No single band's orbit may own the scene shelf. A live run gave 6 of 12
 *  cards to the Chili Peppers orbit (Frusciante x2, Klinghoffer x2, Navarro,
 *  Irons) — technically all real scene reach, but it reads as one rabbit hole
 *  instead of a shop. Round-robin already spreads the SOURCE anchors; this
 *  caps what survives verification. 2026-08-25. */
export function capOrbits<T extends { because?: string; artist?: string }>(cards: T[], perAnchor = 3): T[] {
  const n = new Map<string, number>()
  const out: T[] = []
  for (const c of cards) {
    const k = String(c.because || '').toLowerCase().trim()
    if (!k) { out.push(c); continue }
    const seen = n.get(k) || 0
    if (seen >= perAnchor) continue
    n.set(k, seen + 1)
    out.push(c)
  }
  return out
}

/** Pull complete {...} objects out of a cut-off JSON array. A truncated model
 *  reply should cost the last row, never the whole lane. 2026-08-25. */
export function salvageObjects<T>(body: string): T[] {
  const out: T[] = []
  let depth = 0, startIdx = -1, inStr = false, esc = false
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') { if (depth === 0) startIdx = i; depth++; continue }
    if (ch === '}') {
      depth--
      if (depth === 0 && startIdx >= 0) {
        try { out.push(JSON.parse(body.slice(startIdx, i + 1)) as T) } catch { /* skip the broken one */ }
        startIdx = -1
      }
    }
  }
  return out
}

// ── Bulk supply lanes (2026-08-27) ──────────────────────────────────
// Jake: "25 new songs each day as well as 25 new albums that I DO NOT
// HAVE IN MY LIBRARY. NO LESS". These two lanes carry that quota; the
// harvest itself lives in discover-supply.ts (fixture-tested, offline).

/** Lanes whose card COUNT is the contract — the quality floor never
 *  starves them below quota, it only orders them. */
export const QUOTA_LANES = new Set(['fresh-albums', 'fresh-songs'])

/**
 * Harvest the daily 25/25 from the Deezer related-artist graph and dress
 * the results as feed cards. Ownership closures are built over the SAME
 * normalized-key sets index.ts feeds filterFeed, so "not in my library"
 * means the same thing at harvest time as it does at filter time.
 * Harvests 40 of each so verdict tombstones and cross-lane dedupe can
 * take their cut and 25 still stand on the shelf.
 */
export async function supplyLanes(
  anchorNames: string[],
  dayNumber: number,
  owned: { artists: Set<string>; albumKeys: Set<string>; baseKeys: Set<string> },
  fetchFn: typeof fetch = fetch,
  sleepMs = 120,   // Deezer politeness (50 req / 5 s per IP); tests pass 0
): Promise<FeedCard[]> {
  const { buildDailyDiscovery } = await import('./discover-supply.ts')
  // Accent bridge: the library sets were keyed with normKey, which turns a
  // decomposed accent into a SPACE ("Récord" → "re cord"), so an accented
  // title on one side and a plain one on the other never match. Squashing
  // spaces out of both sides after folding makes the comparison accent-proof
  // in BOTH directions without touching normKey (persisted-ledger keys).
  // Over-matching only makes the gate stricter — the safe direction for
  // "I DO NOT HAVE IN MY LIBRARY".
  const squash = (k: string): string => k.replace(/ /g, '')
  const albumSq = new Set([...owned.albumKeys].map(squash))
  const baseSq = new Set([...owned.baseKeys].map(squash))
  const artistSq = new Set([...owned.artists].map(squash))
  const deps = {
    fetchJson: async (url: string): Promise<unknown> => {
      if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs))
      const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) })
      return res.json()
    },
    ownsAlbum: (artist: string, album: string): boolean =>
      owned.albumKeys.has(`${normKey(artist)}|${normKey(album)}`) ||
      albumSq.has(squash(`${foldKey(artist)}|${foldKey(album)}`)) ||
      owned.baseKeys.has(`${normKey(artist)}|${baseTitleKey(album)}`) ||
      baseSq.has(squash(`${foldKey(artist)}|${baseTitleKey(album)}`)),
    ownsSong: (artist: string, title: string): boolean =>
      owned.albumKeys.has(`${normKey(artist)}|${normKey(title)}`) ||
      albumSq.has(squash(`${foldKey(artist)}|${foldKey(title)}`)) ||
      owned.baseKeys.has(`${normKey(artist)}|${baseTitleKey(title)}`) ||
      baseSq.has(squash(`${foldKey(artist)}|${baseTitleKey(title)}`)),
    ownsArtist: (artist: string): boolean =>
      owned.artists.has(normKey(artist)) || artistSq.has(squash(foldKey(artist))),
  }
  const daily = await buildDailyDiscovery(anchorNames, deps, { want: 40, dayNumber })
  if (daily.report.shortfall.length) {
    console.warn(`[discover] supply shortfall: ${daily.report.shortfall.join(', ')} (pool ${daily.report.poolSize}, ${daily.report.passes} passes)`)
  }
  const cards: FeedCard[] = []
  for (const a of daily.albums) {
    cards.push({ lane: 'fresh-albums', type: 'album', artist: a.artist, title: a.title, year: a.year, why: clipWhy(a.because ? `Neighbors with ${a.because}` : 'Near your library'), artUrl: a.artUrl, because: a.because })
  }
  for (const s of daily.songs) {
    cards.push({ lane: 'fresh-songs', type: 'song', artist: s.artist, title: s.title, why: clipWhy(s.because ? `Neighbors with ${s.because}` : 'Near your library'), artUrl: s.artUrl, previewUrl: s.previewUrl, because: s.because })
  }
  return cards
}

/** One place decides what a shelf holds. Quota lanes seat exactly 25 when
 *  supply allows (Jake: "NO LESS"); narrative lanes stay at 24; the scene
 *  lane keeps its per-anchor orbit cap. Extracted from index.ts under the
 *  line ratchet — the rail said new capability belongs in a module. */
export function assembleLanes(shelved: FeedCard[]): Array<{ id: string; title: string; cards: FeedCard[] }> {
  const laneDefs = [
    { id: 'brand-new', title: 'Brand New', cap: 24 },
    { id: 'fresh-albums', title: 'New Records', cap: 25 },
    { id: 'fresh-songs', title: 'New Songs', cap: 25 },
    { id: 'scene', title: 'From the Scene', cap: 24 },
    { id: 'missing', title: "You're Missing", cap: 24 },
    { id: 'time-machine', title: 'Time Machine', cap: 24 },
    { id: 'songs', title: 'Songs to Try', cap: 24 },
  ]
  return laneDefs
    .map((l) => ({
      id: l.id, title: l.title,
      cards: (l.id === 'scene' ? capOrbits(shelved.filter((c) => c.lane === l.id)) : shelved.filter((c) => c.lane === l.id))
        .sort((a, b) => (b.brainPct ?? 0) - (a.brainPct ?? 0))
        .slice(0, l.cap),
    }))
    .filter((l) => l.cards.length > 0)
}
