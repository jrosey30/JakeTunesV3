/**
 * The three Home rows under launch page "G" (Jake, 2026-10-20) — the document
 * the desktop Home draws.
 *
 *   GET {MOBILE_BACKEND_URL}/api/home-shelves   (ETag; If-None-Match → 304)
 *   → { version: 1, generatedAt, day,
 *       listenMore: { items: [{ track, reason }] } | null,
 *       listeningALot: { windowDays: 30, items: [{ track, plays, lastPlayedAt }],
 *                        playlist: { id, name, trackCount, …, trackIds } | null },
 *       recentlyAdded: { items: [{ album, dateAdded, trackIds }], playlist: { id, name } | null } }
 *
 * homemini computes it from the MERGED play history (desktop + phone) with the
 * shared rulebook (./home-shelves.ts); `track` is the song as /api/tracks
 * serves it and `album` the album as /api/albums serves it (the phone plays and
 * opens straight from them). The desktop reads ids, counts, reasons and dates
 * and draws its OWN library rows for them. Contract as the backend ships it:
 * JakeTunesMobile backend/src/util/homeShelvesDoc.ts.
 *
 * On Repeat (2026-10-28, Jake: "on repeat needs its own playlist and see all
 * needs to take you to that playlist"): listeningALot.playlist.trackIds is the
 * same ranking ON_REPEAT_SIZE deep — the sidebar's On Repeat and the row's
 * "See All" — and the row is its head, so the two never disagree. A document
 * from before then has no playlist; `onRepeat` falls back to the row's songs.
 *
 * When homemini can't be reached and nothing fresh is cached, the desktop
 * builds the same rows from this Mac's own history with the same rulebook
 * (localHomeShelves). Hidden gems need a taste score; with none, that row is
 * null — hidden, never invented.
 *
 * parseHomeShelves is strict about meaning — an unknown version, a song with
 * no id, a count that isn't a number — is dropped, never guessed.
 *
 * Pure and import-light (the rulebook only) — main, preload and renderer share it.
 */
import {
  listeningALot, recentlyAddedAlbums, hiddenGems, localDayKey, SHELF_MAX, RECENT_ALBUMS_MAX, ON_REPEAT_SIZE,
  type ShelfTrack, type ShelfPlay, type ShelfRules,
} from './home-shelves.ts'

export interface GemRef { id: number; reason: string }
export interface HeavyRef { id: number; plays: number }
export interface AddedAlbumRef {
  artist: string
  album: string
  /** ISO — the album's newest song */
  dateAdded: string
  trackIds: number[]
}

export interface HomeShelves {
  version: 1
  generatedAt: string | null
  /** the hidden-gem rotation day ("2026-10-20") */
  day: string | null
  /** null = no taste signal: the row hides */
  listenMore: GemRef[] | null
  listeningALot: HeavyRef[]
  /** The On Repeat playlist's song ids, in order (its head is listeningALot). */
  onRepeat: number[]
  recentlyAdded: AddedAlbumRef[]
}

/** Where the drawn rows came from. */
export type ShelvesSource = 'homemini' | 'cache' | 'local' | 'none'

/** What main hands the renderer. `doc: null` → the renderer computes locally. */
export interface HomeShelvesState {
  doc: HomeShelves | null
  source: ShelvesSource
  /** Last network verdict this session: true = answered, false = didn't, null = not tried. */
  reachable: boolean | null
  /** ms epoch homemini last confirmed the drawn document (200 or 304); null for local/none. */
  fetchedAt: number | null
}

// ── tolerant field readers ─────────────────────────────────────────────
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null)
const iso = (v: unknown): string | null => {
  const s = text(v)
  return s && Number.isFinite(Date.parse(s)) ? s : null
}
/** A library id: a number, or a numeric string (the backend keeps library.json's own type). */
const trackId = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}
const items = (v: unknown): unknown[] => {
  const o = obj(v)
  return o && Array.isArray(o.items) ? o.items : []
}

function parseGem(v: unknown): GemRef | null {
  const o = obj(v)
  const id = o ? trackId(obj(o.track)?.id) : null
  const reason = o ? text(o.reason) : null
  return id !== null && reason ? { id, reason } : null
}

function parseHeavy(v: unknown): HeavyRef | null {
  const o = obj(v)
  const id = o ? trackId(obj(o.track)?.id) : null
  const plays = o ? count(o.plays) : null
  return id !== null && plays !== null && plays > 0 ? { id, plays } : null
}

function parseAdded(v: unknown): AddedAlbumRef | null {
  const o = obj(v)
  const album = o ? obj(o.album) : null
  const artist = album ? text(album.artist) : null
  const name = album ? text(album.album) : null
  const dateAdded = o ? iso(o.dateAdded) : null
  const ids = o && Array.isArray(o.trackIds) ? o.trackIds.map(trackId).filter((n): n is number => n !== null) : []
  return artist && name && dateAdded && ids.length > 0 ? { artist, album: name, dateAdded, trackIds: ids } : null
}

const keep = <T,>(list: Array<T | null>): T[] => list.filter((x): x is T => x !== null)

/** listeningALot.playlist.trackIds → distinct ids in order, at most ON_REPEAT_SIZE. */
function parseOnRepeat(v: unknown): number[] {
  const pl = obj(obj(v)?.playlist)
  const raw = pl && Array.isArray(pl.trackIds) ? pl.trackIds : []
  const out: number[] = []
  for (const id of raw.map(trackId)) {
    if (id !== null && !out.includes(id)) out.push(id)
    if (out.length >= ON_REPEAT_SIZE) break
  }
  return out
}

/** The backend's reply → the rows, or null when it isn't one (wrong version,
 *  not an object). A bad row drops on its own. */
export function parseHomeShelves(raw: unknown): HomeShelves | null {
  const o = obj(raw)
  if (!o || o.version !== 1) return null
  const day = text(o.day)
  const heavy = keep(items(o.listeningALot).map(parseHeavy)).slice(0, SHELF_MAX)
  const onRepeat = parseOnRepeat(o.listeningALot)
  return {
    version: 1,
    generatedAt: iso(o.generatedAt),
    day: day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null,
    listenMore: o.listenMore === null || !obj(o.listenMore) ? null : keep(items(o.listenMore).map(parseGem)).slice(0, SHELF_MAX),
    listeningALot: heavy,
    onRepeat: onRepeat.length > 0 ? onRepeat : heavy.map((h) => h.id),
    recentlyAdded: keep(items(o.recentlyAdded).map(parseAdded)).slice(0, RECENT_ALBUMS_MAX),
  }
}

/** Nothing to draw in any row. */
export function isEmptyShelves(doc: HomeShelves | null): boolean {
  return !doc || ((doc.listenMore?.length ?? 0) === 0 && doc.listeningALot.length === 0 && doc.recentlyAdded.length === 0)
}

export interface LocalShelvesInput<T extends ShelfTrack> {
  /** the WHOLE library (stars and plays on concert songs still say something true) */
  tracks: readonly T[]
  /** this Mac's own play history */
  plays: readonly ShelfPlay[]
  now: number
  rules: ShelfRules
  /** the taste score, or null when there is nothing to rank by */
  score: ((t: T) => number) | null
  /** the album key this app groups by */
  albumKeyOf: (t: T) => string | null | undefined
}

/**
 * The offline fallback: the same rows from THIS Mac's own history and library,
 * through the same rulebook. Its plays are only this Mac's (the merged
 * history lives on homemini), so the counts can be lower than the phone's.
 */
export function localHomeShelves<T extends ShelfTrack>(input: LocalShelvesInput<T>): HomeShelves {
  const { tracks, plays, now, rules } = input
  const byId = new Map<string, T>()
  for (const t of tracks) byId.set(String(t.id), t)
  const num = (id: string): number | null => trackId(byId.get(id)?.id ?? id)
  const day = localDayKey(now)
  // One ranking for the row and the On Repeat playlist: the row is its head.
  const lot = keep(listeningALot(tracks, plays, now, rules, ON_REPEAT_SIZE).map((e) => {
    const id = num(e.id)
    return id === null ? null : { id, plays: e.plays }
  }))
  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    day,
    listenMore: input.score
      ? keep(hiddenGems(tracks, plays, now, rules, input.score, { day }).map((g) => {
        const id = num(g.id)
        return id === null ? null : { id, reason: g.reason }
      }))
      : null,
    listeningALot: lot.slice(0, SHELF_MAX),
    onRepeat: lot.map((e) => e.id),
    recentlyAdded: recentlyAddedAlbums(tracks, rules, input.albumKeyOf).map((a) => ({
      artist: a.artist,
      album: a.album,
      dateAdded: new Date(a.addedMs).toISOString(),
      trackIds: keep(a.ids.map(num)),
    })),
  }
}
