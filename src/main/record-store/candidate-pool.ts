// candidate-pool.ts — the anti-repeat math (Brief 037 §3.4)
//
// The LLM only ever sees a FILTERED, RANKED slice of the library when
// it's asked to pick shelves. This module builds that slice. Without
// it, day 4 picks from the same 30 albums as day 1 — the music-loving
// part of MM's brain doesn't add taste, it just re-rolls the top of
// the play-count list.
//
// Four rules baked in:
//   1. RECENCY PENALTY     — items picked in last 14 days are weighted
//                            down exponentially. A pick made today gets
//                            ~zero weight; a pick made 14 days ago gets
//                            near-full weight.
//   2. LONG-TAIL BOOST     — items the user owns but hasn't played in
//                            90+ days get a *rediscover* multiplier.
//                            This is what makes the store feel alive —
//                            "you forgot you owned this".
//   3. DIVERSITY GUARD     — within a single shelf candidate set, no
//                            more than 1 item per artist; across the
//                            whole day's candidate pool, no more than
//                            2 per artist. Caller passes the day-level
//                            exclude set.
//   4. SHELF-TYPE SHAPING  — MM's Picks favors high-affinity items
//                            (high playCount baseline); Deep Cuts
//                            inverts the playCount axis to favor low-
//                            play items the user owns; New Arrivals
//                            is shaped by dateAdded recency.
//
// The output is an array of ranked album units that the LLM picks
// FROM (it doesn't get to invent items — Brief §3.3 library-grounded
// rule). The LLM's role is to apply *taste* — picking the 5 BEST from
// the top 50, with reasoning — not to do the math itself.

import type { ShelfId } from './types'

// ── Public types ─────────────────────────────────────────────────────

export interface CandTrack {
  id: number
  title: string
  artist: string
  albumArtist?: string
  album: string
  year?: number | string
  genre?: string
  dateAdded: string
  playCount: number
  lastPlayedAt?: number
  skipCount?: number
}

export interface AlbumCandidate {
  /** Stable key: `<album>::<artist>` — matches Phase 0's album grouping. */
  albumKey: string
  album: string
  artist: string
  year?: number | string
  genre?: string
  trackIds: number[]
  /** Sum of playCount across tracks (the "affinity" axis). */
  totalPlays: number
  /** Max dateAdded across tracks (most-recent-import axis). */
  maxDateAdded: string
  /** Most recent natural-completion play across tracks (epoch ms),
   *  0 if never played to completion. */
  lastPlayedAt: number
  /** Days since lastPlayedAt; Infinity if never played to completion. */
  daysSinceLastPlay: number
  /** Computed weighted score AFTER all rules applied. Higher = better
   *  for the requested shelf type. */
  score: number
}

export interface CandidatePoolInput {
  tracks: CandTrack[]
  shelfId: ShelfId
  /** YYYY-MM-DD of today, local. Used as the reference for "days since". */
  todayISO: string
  /** Item ids that were picked in the last 14 days (across all shelves).
   *  Format: 'lib:album:<albumKey>'. Caller derives from cached
   *  ShelfBundles via RecordStoreCache. */
  recentlyPickedIds?: Set<string>
  /** Artist names already used by other shelves on TODAY. Per Brief
   *  §3.4 diversity: max 2 per artist across the day. The caller
   *  builds this set as it generates each shelf in sequence. */
  artistsUsedToday?: Map<string, number>
  /** Hard limit on candidates returned. Default 50 — matches Brief
   *  §3.3 "50 most theme-relevant items". */
  limit?: number
  /** Optional theme-relevance scorer. Multiplies into the base score.
   *  Called by Phase 1d once the day-theme is picked. Pure function;
   *  no I/O. Return 0 to exclude, >1 to boost. */
  themeScorer?: (cand: AlbumCandidate) => number
}

// ── Tuning constants ─────────────────────────────────────────────────
//
// These are baked in for now — if Phase 1 verification finds the pool
// shape wrong, the fix is here, not in the LLM prompt. Keep the levers
// explicit so they're easy to tune.

/** Recency-penalty half-life in days. An item picked TODAY gets weight
 *  ~2^(-14/HALFLIFE). Set so 14-day-old picks weigh ~0.5x. */
const RECENCY_HALFLIFE_DAYS = 14
/** Long-tail rediscover multiplier ceiling (90+ day cold items). */
const REDISCOVER_BOOST = 2.5
/** Above this day count, the rediscover boost saturates. */
const REDISCOVER_SATURATION_DAYS = 180
/** Below this day count, no rediscover boost at all. */
const REDISCOVER_MIN_DAYS = 60
/** Cap per artist within a single candidate pool (one shelf). */
const PER_SHELF_ARTIST_CAP = 1
/** Cap per artist across a single day's pools (set by the caller via
 *  artistsUsedToday). Reference: Brief §3.4 — max 2 per artist/day. */
const PER_DAY_ARTIST_CAP = 2

// ── Album grouping (shared with Phase 0 index.ts; kept inline so
//    this module is self-contained for the script-probe in §1a verify) ─

function groupAlbums(tracks: CandTrack[], todayMs: number): AlbumCandidate[] {
  const map = new Map<string, AlbumCandidate>()
  for (const t of tracks) {
    if (!t.album) continue
    const artist = (t.albumArtist && t.albumArtist.trim()) || (t.artist || '').trim()
    if (!artist) continue
    const key = `${t.album}::${artist}`
    let unit = map.get(key)
    if (!unit) {
      unit = {
        albumKey: key,
        album: t.album,
        artist,
        year: t.year,
        genre: t.genre,
        trackIds: [],
        totalPlays: 0,
        maxDateAdded: t.dateAdded || '',
        lastPlayedAt: 0,
        daysSinceLastPlay: Infinity,
        score: 0,
      }
      map.set(key, unit)
    }
    unit.trackIds.push(t.id)
    unit.totalPlays += Number(t.playCount) || 0
    if (t.dateAdded && t.dateAdded > unit.maxDateAdded) {
      unit.maxDateAdded = t.dateAdded
    }
    if (typeof t.lastPlayedAt === 'number' && t.lastPlayedAt > unit.lastPlayedAt) {
      unit.lastPlayedAt = t.lastPlayedAt
    }
  }
  for (const u of map.values()) {
    u.daysSinceLastPlay =
      u.lastPlayedAt > 0 ? Math.max(0, (todayMs - u.lastPlayedAt) / 86_400_000) : Infinity
  }
  return Array.from(map.values())
}

// ── Scoring axes ─────────────────────────────────────────────────────

/** Base score for the requested shelf type. */
function baseScore(cand: AlbumCandidate, shelfId: ShelfId, todayMs: number): number {
  switch (shelfId) {
    case 'mm-picks': {
      // Affinity-driven. log1p so the top-10 doesn't dominate.
      return Math.log1p(cand.totalPlays)
    }
    case 'new-arrivals': {
      // Recency-of-import. Most-recent gets 1.0, drops off over 60 days.
      const ageDays =
        cand.maxDateAdded
          ? Math.max(
              0,
              (todayMs - Date.parse(cand.maxDateAdded)) / 86_400_000,
            )
          : 365
      return Math.max(0, 1 - ageDays / 60)
    }
    case 'deep-cuts': {
      // Long-tail: low playCount but >0. Owned and forgotten beats
      // never-played. Score is inverse-playCount with a floor so
      // play=1 doesn't infinite-rocket.
      if (cand.totalPlays < 1) return 0
      return 1 / (1 + cand.totalPlays / 3)
    }
    case 'megan-picks':
    case 'stephen-crate':
      // v1.1 personas — fall back to affinity for now.
      return Math.log1p(cand.totalPlays)
  }
}

/** Recency penalty — items picked within the last 14 days fade. */
function recencyPenalty(albumKey: string, recentlyPicked?: Set<string>): number {
  if (!recentlyPicked || recentlyPicked.size === 0) return 1.0
  // For Phase 1a we know membership but not WHEN; treat any membership
  // as "picked within window" and apply a flat half-weight. Phase 1d
  // can refine by passing a Map<albumKey, daysAgo>.
  return recentlyPicked.has(`lib:album:${albumKey}`)
    ? Math.pow(2, -RECENCY_HALFLIFE_DAYS / RECENCY_HALFLIFE_DAYS) // = 0.5
    : 1.0
}

/** Rediscover boost for long-cold items. Returns a multiplier in
 *  [1.0 .. REDISCOVER_BOOST]. Items that were never played get the
 *  full boost; recently-played items get 1.0. */
function rediscoverBoost(cand: AlbumCandidate): number {
  const d = cand.daysSinceLastPlay
  if (d < REDISCOVER_MIN_DAYS) return 1.0
  if (d >= REDISCOVER_SATURATION_DAYS || d === Infinity) return REDISCOVER_BOOST
  // Linear ramp between MIN and SATURATION
  const t = (d - REDISCOVER_MIN_DAYS) / (REDISCOVER_SATURATION_DAYS - REDISCOVER_MIN_DAYS)
  return 1.0 + t * (REDISCOVER_BOOST - 1.0)
}

// ── Diversity guard ──────────────────────────────────────────────────

function applyDiversity(
  ranked: AlbumCandidate[],
  artistsUsedToday?: Map<string, number>,
): AlbumCandidate[] {
  const out: AlbumCandidate[] = []
  const shelfArtistCount = new Map<string, number>()
  for (const cand of ranked) {
    const artist = cand.artist
    const shelfSoFar = shelfArtistCount.get(artist) ?? 0
    if (shelfSoFar >= PER_SHELF_ARTIST_CAP) continue
    const daySoFar = artistsUsedToday?.get(artist) ?? 0
    if (daySoFar >= PER_DAY_ARTIST_CAP) continue
    out.push(cand)
    shelfArtistCount.set(artist, shelfSoFar + 1)
  }
  return out
}

// ── Public entry point ───────────────────────────────────────────────

export function buildCandidatePool(input: CandidatePoolInput): AlbumCandidate[] {
  const todayMs = Date.parse(`${input.todayISO}T12:00:00`) || Date.now()
  const limit = input.limit ?? 50

  // 1. Group library tracks into album units
  const albums = groupAlbums(input.tracks, todayMs)

  // 2. Score each one through the four axes
  for (const cand of albums) {
    const base = baseScore(cand, input.shelfId, todayMs)
    const recency = recencyPenalty(cand.albumKey, input.recentlyPickedIds)
    const rediscover = rediscoverBoost(cand)
    const themeMul = input.themeScorer ? input.themeScorer(cand) : 1.0
    cand.score = base * recency * rediscover * themeMul
  }

  // 3. Drop zero-score items (excluded by theme or shelf-base rules)
  const eligible = albums.filter((c) => c.score > 0)

  // 4. Sort by score descending
  eligible.sort((a, b) => b.score - a.score)

  // 5. Apply diversity guard (caps per artist) BEFORE truncating to
  //    limit so we don't slot in 5 copies of an over-represented
  //    artist's records.
  const diverse = applyDiversity(eligible, input.artistsUsedToday)

  // 6. Truncate to limit
  return diverse.slice(0, limit)
}

/** Helper for the orchestration layer (Phase 1d): mutate the day-level
 *  artist-count map as a shelf's items are committed. */
export function recordPickedArtists(
  picked: AlbumCandidate[],
  artistsUsedToday: Map<string, number>,
): void {
  for (const p of picked) {
    artistsUsedToday.set(p.artist, (artistsUsedToday.get(p.artist) ?? 0) + 1)
  }
}

/** Tuning levers exported so the verification probe can introspect
 *  them in its report. */
export const TUNING = {
  RECENCY_HALFLIFE_DAYS,
  REDISCOVER_BOOST,
  REDISCOVER_SATURATION_DAYS,
  REDISCOVER_MIN_DAYS,
  PER_SHELF_ARTIST_CAP,
  PER_DAY_ARTIST_CAP,
} as const
