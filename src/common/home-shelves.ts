/**
 * Home shelves (Jake, 2026-10-20): "I want to add to home: you should listen
 * to more, songs you've been listening to a lot, and recently added. 5 each.
 * With a see all option bringing it to 10." Three rows right under launch
 * page "G" (under Now Digging), on desktop AND phone. One rulebook:
 *
 *  - listenMore — hidden gems. Songs Jake already owns that his taste score
 *    rates highly but he has barely played: at most GEM_MAX_PLAYS lifetime
 *    plays, none in GEM_QUIET_DAYS, not added in the last GEM_NEW_DAYS (that
 *    is Recently Added's job), and not starred (a star already says "I know I
 *    love this"). The score is INJECTED: the shared tasteScore (the nightly
 *    taste engine's learned score while it is promoted and fresh, the v5
 *    formula otherwise). The best GEM_POOL rotate daily — a shuffle seeded by
 *    the local day, so the row is fresh each morning and steady all day — and
 *    no two share an artist (then an album) where the pool allows. Each song
 *    carries a reason built only from real stars, plays and genre; a song
 *    with no groundable reason is not shown.
 *  - listeningALot — most plays in the last LOT_WINDOW_DAYS (at least
 *    LOT_MIN_PLAYS), ties → the most recent play.
 *  - recentlyAdded — newest albums by dateAdded (an album's newest song), one
 *    entry per album exactly as each app groups albums (the key is
 *    INJECTED), never a bucket of untitled loose songs.
 *
 * Every row:
 *  - plays are the MERGED history (desktop + phone);
 *  - nothing under a minute appears (Jake: "nothing under 1 min in ANY
 *    ranking") — `rankable` is the shared isTop25Rankable, injected; plays of
 *    short songs still count toward everything else;
 *  - a declared concert's tracks never appear (`hidden` = each merged full
 *    show and its setlist songs) — concerts live on the Live Concerts shelf.
 *
 * Pure and import-free.
 *
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/homeShelves.ts — keep the rules,
 * thresholds and copy byte-for-byte in step (the phone backend is a
 * leaf-module test runner; this file must stay import-free).
 */

export interface ShelfTrack {
  id: number | string
  title?: string | null
  artist?: string | null
  albumArtist?: string | null
  album?: string | null
  genre?: string | null
  /** ms */
  duration?: number
  rating?: number | null
  playCount?: number | null
  /** ms since epoch, when the caller knows it (desktop's own field) */
  lastPlayedAt?: number | null
  dateAdded?: string | null
}

export interface ShelfPlay {
  id: number | string
  /** ms since epoch */
  ts: number
}

export interface ShelfRules {
  /** Concert-owned track ids, as strings. */
  hidden: ReadonlySet<string>
  /** Jake's one-minute rule — the shared isTop25Rankable. */
  rankable(t: ShelfTrack): boolean
}

export const DAY_MS = 86_400_000
/** What each row shows before "See All". */
export const SHELF_SHOWN = 5
/** What "See All" opens to (Recently Added opens its playlist instead). */
export const SHELF_MAX = 10
export const RECENT_ALBUMS_MAX = 5
/** How many of the newest songs Recently Added fetches, and queues behind a click. */
export const RECENT_SONGS_QUEUE = 25
export const LOT_WINDOW_DAYS = 30
export const LOT_MIN_PLAYS = 2
export const GEM_MAX_PLAYS = 2
export const GEM_QUIET_DAYS = 90
export const GEM_NEW_DAYS = 30
export const GEM_POOL = 40
/** An artist needs this many plays before a reason may lean on them. */
export const REASON_MIN_PLAYS = 10

const sid = (id: number | string): string => String(id)
const clean = (s: string | null | undefined): string => String(s ?? '').trim()
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export function primaryArtist(t: ShelfTrack): string {
  return clean(t.albumArtist) || clean(t.artist)
}
const artistKey = (t: ShelfTrack): string => primaryArtist(t).toLowerCase()
/** "Various Artists" is a shelf label, not someone whose plays or stars mean
 *  anything — never a reason, never a genre peer. */
const VARIOUS = /^various( artists)?$/
const albumKey = (t: ShelfTrack): string => artistKey(t) + '\u0000' + clean(t.album).toLowerCase()
const starred = (t: ShelfTrack): boolean => (Number(t.rating) || 0) > 0

/** A real album title — not blank, not the "Unknown Album" bucket both apps
 *  file untitled songs under (grouping those would invent an album). */
export function hasRealAlbum(t: ShelfTrack): boolean {
  const a = clean(t.album).toLowerCase()
  return a !== '' && a !== 'unknown album' && a !== 'unknown'
}

export function addedMs(t: ShelfTrack): number | null {
  const s = clean(t.dateAdded)
  if (!s) return null
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms : null
}

/** "2026-10-20" in local time — the daily rotation's seed. */
export function localDayKey(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => (n < 10 ? '0' : '') + n
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export interface PlayTally {
  /** every play on record */
  count: number
  /** newest play, ms (0 = none) */
  last: number
}

/** Every play folded per song (string id). Plays after `now` are ignored. */
export function tallyPlays(plays: readonly ShelfPlay[], now: number): Map<string, PlayTally> {
  const out = new Map<string, PlayTally>()
  for (const p of plays) {
    if (!Number.isFinite(p.ts) || p.ts > now) continue
    const id = sid(p.id)
    const cur = out.get(id)
    if (cur) {
      cur.count += 1
      if (p.ts > cur.last) cur.last = p.ts
    } else {
      out.set(id, { count: 1, last: p.ts })
    }
  }
  return out
}

/** Lifetime plays: the play history or the library's own count, whichever
 *  knows more (old iTunes-era counts predate the history). */
function lifetimePlays(t: ShelfTrack, tally: ReadonlyMap<string, PlayTally>): number {
  return Math.max(Number(t.playCount) || 0, tally.get(sid(t.id))?.count ?? 0)
}

function lastPlay(t: ShelfTrack, tally: ReadonlyMap<string, PlayTally>): number {
  return Math.max(Number(t.lastPlayedAt) || 0, tally.get(sid(t.id))?.last ?? 0)
}

// ── Listening a lot ─────────────────────────────────────────────────────────

export interface LotEntry {
  id: string
  plays: number
  lastPlayTs: number
}

export function listeningALot<T extends ShelfTrack>(
  tracks: readonly T[],
  plays: readonly ShelfPlay[],
  now: number,
  rules: ShelfRules,
  limit: number = SHELF_MAX,
): LotEntry[] {
  const byId = new Map<string, T>()
  for (const t of tracks) byId.set(sid(t.id), t)
  const since = now - LOT_WINDOW_DAYS * DAY_MS
  const tally = new Map<string, LotEntry>()
  for (const p of plays) {
    if (p.ts < since || p.ts > now) continue
    const id = sid(p.id)
    if (rules.hidden.has(id)) continue
    const t = byId.get(id)
    if (!t || !rules.rankable(t)) continue
    const cur = tally.get(id) ?? { id, plays: 0, lastPlayTs: 0 }
    cur.plays += 1
    if (p.ts > cur.lastPlayTs) cur.lastPlayTs = p.ts
    tally.set(id, cur)
  }
  return [...tally.values()]
    .filter((e) => e.plays >= LOT_MIN_PLAYS)
    .sort((a, b) => b.plays - a.plays || b.lastPlayTs - a.lastPlayTs || order(a.id, b.id))
    .slice(0, limit)
}

// ── Recently added ──────────────────────────────────────────────────────────

export interface RecentAlbum {
  /** the album key the app groups by (injected) */
  key: string
  artist: string
  album: string
  /** the album's newest dateAdded, ms */
  addedMs: number
  /** the album's songs on show (string ids, library order) */
  ids: string[]
}

export function recentlyAddedAlbums<T extends ShelfTrack>(
  tracks: readonly T[],
  rules: ShelfRules,
  albumKeyOf: (t: T) => string | null | undefined,
  limit: number = RECENT_ALBUMS_MAX,
): RecentAlbum[] {
  const groups = new Map<string, RecentAlbum & { rankable: boolean }>()
  for (const t of tracks) {
    const id = sid(t.id)
    if (rules.hidden.has(id) || !hasRealAlbum(t)) continue
    const key = albumKeyOf(t)
    if (!key) continue
    let g = groups.get(key)
    if (!g) {
      g = { key, artist: primaryArtist(t), album: clean(t.album), addedMs: -Infinity, ids: [], rankable: false }
      groups.set(key, g)
    }
    g.ids.push(id)
    const ms = addedMs(t)
    if (ms != null && ms > g.addedMs) g.addedMs = ms
    if (rules.rankable(t)) g.rankable = true
  }
  return [...groups.values()]
    // An album of nothing but sub-minute fragments is not shown either.
    .filter((g) => Number.isFinite(g.addedMs) && g.rankable && g.artist !== '')
    .sort((a, b) => b.addedMs - a.addedMs || order(a.key, b.key))
    .slice(0, limit)
    .map(({ key, artist, album, addedMs: ms, ids }) => ({ key, artist, album, addedMs: ms, ids }))
}

/**
 * RECENTLY ADDED's songs: the newest RECENT_SONGS_QUEUE songs by dateAdded
 * (newest first, ties → higher id), minus a declared concert's songs and
 * sub-minute fragments. The row draws the first SHELF_SHOWN; a click queues
 * the whole list (Jake, 2026-10-22).
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/HomeShelves.swift RecentlyAddedShelf
 */
export function recentlyAddedSongs<T extends ShelfTrack>(
  tracks: readonly T[],
  rules: ShelfRules,
  limit: number = RECENT_SONGS_QUEUE,
): T[] {
  return tracks
    .filter((t) => !rules.hidden.has(sid(t.id)) && addedMs(t) != null && rules.rankable(t))
    .sort((a, b) => (addedMs(b) as number) - (addedMs(a) as number) || Number(b.id) - Number(a.id))
    .slice(0, limit)
}

/** What a click on chip `index` hands the player: the whole list, starting there. */
export function recentlyAddedPlay<T>(songs: readonly T[], index: number): { queue: T[]; start: number } | null {
  if (!Number.isInteger(index) || index < 0 || index >= songs.length) return null
  return { queue: [...songs], start: index }
}

// ── You should listen to more (hidden gems) ─────────────────────────────────

export interface GemEntry {
  id: string
  score: number
  reason: string
}

export interface GemOptions {
  /** the local day ("2026-10-20", localDayKey) — the rotation seed */
  day: string
  limit?: number
  pool?: number
}

interface Best {
  title: string
  plays: number
}

/** Facts the reasons may cite — stars, plays and genre, nothing else. */
interface ReasonFacts {
  albumSize: Map<string, number>
  albumStars: Map<string, number>
  albumStarBest: Map<string, Best>
  artistStars: Map<string, number>
  artistStarBest: Map<string, Best>
  artistPlays: Map<string, number>
  artistName: Map<string, string>
  genreArtists: Map<string, Map<string, number>>
}

function better(cur: Best | undefined, next: Best): boolean {
  return !cur || next.plays > cur.plays || (next.plays === cur.plays && order(next.title, cur.title) < 0)
}

function reasonFacts(tracks: readonly ShelfTrack[], tally: ReadonlyMap<string, PlayTally>): ReasonFacts {
  const f: ReasonFacts = {
    albumSize: new Map(), albumStars: new Map(), albumStarBest: new Map(),
    artistStars: new Map(), artistStarBest: new Map(), artistPlays: new Map(),
    artistName: new Map(), genreArtists: new Map(),
  }
  for (const t of tracks) {
    const ak = artistKey(t)
    if (!ak) continue
    const bk = albumKey(t)
    const plays = lifetimePlays(t, tally)
    const person = !VARIOUS.test(ak)
    f.albumSize.set(bk, (f.albumSize.get(bk) ?? 0) + 1)
    if (person) {
      if (!f.artistName.has(ak)) f.artistName.set(ak, primaryArtist(t))
      f.artistPlays.set(ak, (f.artistPlays.get(ak) ?? 0) + plays)
      const genre = clean(t.genre).toLowerCase()
      if (genre) {
        const m = f.genreArtists.get(genre) ?? new Map<string, number>()
        m.set(ak, (m.get(ak) ?? 0) + plays)
        f.genreArtists.set(genre, m)
      }
    }
    if (starred(t)) {
      const best = { title: clean(t.title), plays }
      f.albumStars.set(bk, (f.albumStars.get(bk) ?? 0) + 1)
      if (best.title && better(f.albumStarBest.get(bk), best)) f.albumStarBest.set(bk, best)
      if (person) {
        f.artistStars.set(ak, (f.artistStars.get(ak) ?? 0) + 1)
        if (best.title && better(f.artistStarBest.get(ak), best)) f.artistStarBest.set(ak, best)
      }
    }
  }
  return f
}

/** Why this song: the strongest true fact, in the taste model's own order of
 *  evidence (album > artist > genre). Null when nothing true can be said. */
function gemReason(t: ShelfTrack, f: ReasonFacts): string | null {
  const ak = artistKey(t)
  const bk = albumKey(t)
  const artist = f.artistName.get(ak) || primaryArtist(t)
  const albumStars = f.albumStars.get(bk) ?? 0
  const albumOthers = (f.albumSize.get(bk) ?? 1) - 1
  if (albumStars >= 2 && albumStars === albumOthers) return 'You starred the rest of this album'
  if (albumStars >= 2) return `You starred ${albumStars} songs on this album`
  const albumBest = f.albumStarBest.get(bk)
  if (albumStars === 1 && albumBest) return `You starred “${albumBest.title}” on this album`
  const artistStars = f.artistStars.get(ak) ?? 0
  if (artistStars >= 2) return `You starred ${artistStars} ${artist} songs`
  const artistBest = f.artistStarBest.get(ak)
  if (artistStars === 1 && artistBest) return `You starred “${artistBest.title}” by ${artist}`
  const artistPlays = f.artistPlays.get(ak) ?? 0
  if (artistPlays >= REASON_MIN_PLAYS) return `You’ve played ${artist} ${artistPlays} times`
  const genre = clean(t.genre)
  const peers = f.genreArtists.get(genre.toLowerCase())
  if (peers) {
    const top = [...peers.entries()]
      .filter(([k, n]) => k !== ak && n >= REASON_MIN_PLAYS)
      .sort((a, b) => b[1] - a[1] || order(a[0], b[0]))
      .slice(0, 2)
      .map(([k]) => f.artistName.get(k) || k)
    if (top.length === 2) return `${genre}, like your ${top[0]} and ${top[1]}`
    if (top.length === 1) return `${genre}, like your ${top[0]}`
  }
  return null
}

function seedOf(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** mulberry32 — small, deterministic, identical in every JS runtime. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The same order all day, a new one tomorrow. */
export function dailyShuffle<V>(items: readonly V[], day: string): V[] {
  const out = [...items]
  const next = rng(seedOf(`home-shelves|${day}`))
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

export function isGemEligible(t: ShelfTrack, tally: ReadonlyMap<string, PlayTally>, now: number, rules: ShelfRules): boolean {
  if (rules.hidden.has(sid(t.id)) || !rules.rankable(t) || starred(t)) return false
  if (!clean(t.title) || !primaryArtist(t)) return false
  if (lifetimePlays(t, tally) > GEM_MAX_PLAYS) return false
  const last = lastPlay(t, tally)
  if (last > 0 && now - last < GEM_QUIET_DAYS * DAY_MS) return false
  const added = addedMs(t)
  if (added != null && now - added < GEM_NEW_DAYS * DAY_MS) return false
  return true
}

export function hiddenGems<T extends ShelfTrack>(
  tracks: readonly T[],
  plays: readonly ShelfPlay[],
  now: number,
  rules: ShelfRules,
  score: (t: T) => number,
  opts: GemOptions,
): GemEntry[] {
  const limit = opts.limit ?? SHELF_MAX
  const poolSize = opts.pool ?? GEM_POOL
  const tally = tallyPlays(plays, now)
  const facts = reasonFacts(tracks, tally)
  const scored: Array<GemEntry & { ak: string; bk: string }> = []
  for (const t of tracks) {
    if (!isGemEligible(t, tally, now, rules)) continue
    const s = score(t)
    if (!Number.isFinite(s)) continue
    const reason = gemReason(t, facts)
    if (!reason) continue
    scored.push({ id: sid(t.id), score: s, reason, ak: artistKey(t), bk: albumKey(t) })
  }
  scored.sort((a, b) => b.score - a.score || order(a.id, b.id))
  const pool = dailyShuffle(scored.slice(0, poolSize), opts.day)
  const picked: typeof pool = []
  const taken = new Set<string>()
  const artists = new Set<string>()
  const albums = new Set<string>()
  // Distinct artists first, then distinct albums, then whatever is left.
  for (const pass of [0, 1, 2] as const) {
    for (const g of pool) {
      if (picked.length >= limit) break
      if (taken.has(g.id)) continue
      if (pass === 0 && artists.has(g.ak)) continue
      if (pass === 1 && albums.has(g.bk)) continue
      picked.push(g)
      taken.add(g.id)
      artists.add(g.ak)
      albums.add(g.bk)
    }
  }
  return picked.map(({ id, score: s, reason }) => ({ id, score: s, reason }))
}

// ── Copy ────────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function playsLabel(n: number): string {
  return `${n} ${n === 1 ? 'play' : 'plays'}`
}

/** "Added Oct 19" (local time). */
export function addedLabel(ms: number): string {
  const d = new Date(ms)
  return `Added ${MONTHS[d.getMonth()]} ${d.getDate()}`
}
