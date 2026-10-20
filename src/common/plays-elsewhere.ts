/**
 * Plays heard elsewhere (2026-10-20) — the songs Jake played on the phone and
 * on workmini, counted on this Mac too. Jake: workmini plays "should count on
 * the macbook pro and homemini too", "count all of them", and every finished
 * song inside a mixtape is a play.
 *
 *   GET {MOBILE_BACKEND_URL}/api/plays/elsewhere   (ETag; If-None-Match → 304)
 *   → { version: 1,
 *       counts: { [trackId]: n },          what homemini adds to each song's count
 *       plays: [{ id, ts, from }] }        each play's moment, oldest first
 *
 * `counts` is the number to show: exactly what homemini adds on top of this
 * Mac's own counts (the phone's running counter + every workmini-only play), so
 * a song reads the same on every device. `plays` is for recency (last played,
 * Recently Played, Top 25's week/month): the phone's counter predates its play
 * log, so the two don't add up and must not be mixed. Contract as the backend
 * ships it: JakeTunesMobile backend/src/routes/playsElsewhere.ts.
 *
 * DISPLAY ONLY. These plays live in memory beside the library and are never
 * written into a track's playCount, the overrides or library.json: homemini
 * adds these same plays to the counts this Mac publishes, so saving them here
 * would count every one twice (__tests__/plays-elsewhere.test.ts locks the
 * wiring). Only the hub reads them — a replica's own plays are in the feed.
 *
 * Pure and import-free — main, preload and renderer share it.
 */

export const PLAYS_ELSEWHERE_PATH = '/api/plays/elsewhere'

export interface ElsewherePlay {
  id: number
  /** epoch ms */
  ts: number
  /** 'phone' or the replica's name ('workmini') */
  from: string
}

export interface PlaysElsewhere {
  /** track id → plays heard elsewhere */
  counts: Record<string, number>
  /** oldest first */
  plays: ElsewherePlay[]
}

export type ElsewhereSource = 'homemini' | 'cache' | 'none' | 'off'

export interface PlaysElsewhereState {
  doc: PlaysElsewhere | null
  /** 'off' on a replica — its own plays are already in the feed */
  source: ElsewhereSource
  fetchedAt: number | null
}

const isId = (n: number): boolean => Number.isInteger(n) && n > 0

/** The route's body → plays, or null when it isn't one (wrong version, HTML, torn). */
export function parsePlaysElsewhere(body: unknown): PlaysElsewhere | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { version?: unknown; counts?: unknown; plays?: unknown }
  if (b.version !== 1 || !b.counts || typeof b.counts !== 'object' || Array.isArray(b.counts) || !Array.isArray(b.plays)) return null
  const counts: Record<string, number> = {}
  for (const [k, v] of Object.entries(b.counts as Record<string, unknown>)) {
    if (isId(Number(k)) && typeof v === 'number' && Number.isInteger(v) && v > 0) counts[String(Number(k))] = v
  }
  const plays: ElsewherePlay[] = []
  for (const p of b.plays as unknown[]) {
    if (!p || typeof p !== 'object') continue
    const { id, ts, from } = p as { id?: unknown; ts?: unknown; from?: unknown }
    const n = Number(id)
    if ((typeof id !== 'number' && typeof id !== 'string') || !isId(n) || typeof ts !== 'number' || !Number.isFinite(ts)) continue
    plays.push({ id: n, ts, from: typeof from === 'string' && from ? from : 'elsewhere' })
  }
  plays.sort((a, b) => a.ts - b.ts)
  return { counts, plays }
}

/** The lookups a view needs: each song's extra plays and its latest moment heard elsewhere. */
export interface ElsewhereOverlay {
  counts: ReadonlyMap<number, number>
  lastPlayedAt: ReadonlyMap<number, number>
}

export const NO_PLAYS_ELSEWHERE: ElsewhereOverlay = { counts: new Map(), lastPlayedAt: new Map() }

export function overlayOf(doc: PlaysElsewhere | null): ElsewhereOverlay {
  if (!doc) return NO_PLAYS_ELSEWHERE
  const counts = new Map<number, number>()
  for (const [k, n] of Object.entries(doc.counts)) counts.set(Number(k), n)
  const lastPlayedAt = new Map<number, number>()
  for (const p of doc.plays) if (p.ts > (lastPlayedAt.get(p.id) ?? 0)) lastPlayedAt.set(p.id, p.ts)
  return { counts, lastPlayedAt }
}

/** Plays heard elsewhere at or after `cutoff`, per track id — the shape of get-windowed-play-counts. */
export function windowedElsewhere(doc: PlaysElsewhere | null, cutoff: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of doc?.plays ?? []) if (p.ts >= cutoff) out[String(p.id)] = (out[String(p.id)] ?? 0) + 1
  return out
}

/** a + b per key (this Mac's windowed counts + elsewhere's). Inputs untouched. */
export function addWindowed(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a }
  for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n
  return out
}

interface PlayedLike { id: number; playCount?: number; lastPlayedAt?: number }

/** A song's play count as it reads everywhere: this Mac's + elsewhere's. */
export function playsEverywhere(t: PlayedLike, o: ElsewhereOverlay): number {
  return (Number(t.playCount) || 0) + (o.counts.get(t.id) ?? 0)
}

/** A song's last-played moment across every device (0 = never). */
export function lastPlayedEverywhere(t: PlayedLike, o: ElsewhereOverlay): number {
  return Math.max(Number(t.lastPlayedAt) || 0, o.lastPlayedAt.get(t.id) ?? 0)
}

/**
 * Tracks as they read everywhere — for RANKING and SELECTING only (Top 25,
 * Recently Played, Best of). New objects for the songs that change, the rest
 * untouched; the same array back when there is nothing elsewhere. Never
 * dispatch or save what this returns: map results back to the library's own
 * tracks by id.
 */
export function withPlaysElsewhere<T extends PlayedLike>(tracks: T[], o: ElsewhereOverlay): T[] {
  if (o.counts.size === 0 && o.lastPlayedAt.size === 0) return tracks
  return tracks.map((t) => {
    const extra = o.counts.get(t.id) ?? 0
    const last = o.lastPlayedAt.get(t.id) ?? 0
    if (extra === 0 && last <= (Number(t.lastPlayedAt) || 0)) return t
    return { ...t, playCount: playsEverywhere(t, o), lastPlayedAt: lastPlayedEverywhere(t, o) || undefined }
  })
}
