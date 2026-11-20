/**
 * A song that wasn't found anywhere isn't searched again the same way for a
 * week (Brief 257, Record Shop Phase 4). Jake's Listen List asked Qobuz,
 * Bandcamp and SoundCloud for the same missing songs on every Save all.
 *
 * The memory is keyed by the request itself: who, what, which album, which
 * length, which edition. Anything that changes the question (another title,
 * another artist, another edition or length) is a new key and is asked at
 * once. A manual retry (Retry, Try again) forgets the key and asks. Only a
 * real answer is remembered: "not found" or "no exact copy" with every lane
 * asked; provider trouble, a cancel or a lane that wasn't searched never is.
 *
 * Pure: the store is main/not-found-memory-store.ts (a small JSON file in the
 * app's data dir), the queue asks it (renderer downloadQueue.ts).
 */

export const NOT_FOUND_WEEK_MS = 7 * 24 * 60 * 60 * 1000
/** At most this many remembered requests; the oldest go first. */
export const NOT_FOUND_CAP = 400

export interface NotFoundEntry { at: number; outcome: string }
export type NotFoundMemory = Record<string, NotFoundEntry>

/** The parts of a queue job that say what was asked. */
export interface AskedFor {
  mediaType?: string
  artist?: string
  title?: string
  album?: string
  durationMs?: number
  collectionId?: number
  trackCount?: number
  explicitSource?: boolean
  cleanedSource?: boolean
}

const n = (s: unknown): string => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** The request's key, or null when there is nothing to name (no artist, no title). */
export function notFoundKey(r: AskedFor): string | null {
  const album = r.mediaType === 'album'
  const what = album ? n(r.album) : n(r.title)
  const who = n(r.artist)
  if (!what || !who) return null
  const cut = r.explicitSource ? 'e' : r.cleanedSource ? 'c' : ''
  return album
    ? ['album', who, what, r.collectionId ?? '', r.trackCount ?? '', cut].join('|')
    : ['song', who, what, n(r.album), r.durationMs ? Math.round(r.durationMs / 1000) : '', cut].join('|')
}

/** Is this outcome an answer worth a week? Never provider trouble, a cancel, or a lane left unasked. */
export function rememberable(outcome: string | undefined, detail?: string | null): boolean {
  if (outcome !== 'not-found' && outcome !== 'exact-not-found') return false
  // The walk's own words for a lane it couldn't ask (streamrip-store laneNotes / describeOutcome).
  return !/wasn[’']t searched|could not be searched|could not be fetched/i.test(String(detail || ''))
}

/** The remembered answer, if it's under a week old. */
export function remembered(mem: NotFoundMemory, key: string | null, now: number): NotFoundEntry | null {
  if (!key) return null
  const e = mem[key]
  return e && now - e.at >= 0 && now - e.at < NOT_FOUND_WEEK_MS ? e : null
}

/** Drop what's a week old (or from the future: a clock moved), then the oldest past the cap. */
export function pruneNotFound(mem: NotFoundMemory, now: number, cap = NOT_FOUND_CAP): NotFoundMemory {
  const live = Object.entries(mem).filter(([, e]) => e && typeof e.at === 'number' && now - e.at >= 0 && now - e.at < NOT_FOUND_WEEK_MS)
  live.sort((a, b) => b[1].at - a[1].at)
  return Object.fromEntries(live.slice(0, cap))
}

export function noteNotFound(mem: NotFoundMemory, key: string | null, outcome: string, now: number): NotFoundMemory {
  if (!key) return mem
  return pruneNotFound({ ...mem, [key]: { at: now, outcome } }, now)
}

export function forgetNotFound(mem: NotFoundMemory, key: string | null): NotFoundMemory {
  if (!key || !(key in mem)) return mem
  const { [key]: _gone, ...rest } = mem
  return rest
}

const DAY = 24 * 60 * 60 * 1000
/** "today", "yesterday", "3 days ago". */
export function whenWords(at: number, now: number): string {
  const days = Math.floor((now - at) / DAY)
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`
}

/** The job's line when the memory answers, and the sentence under it. */
export function rememberedVerdict(e: NotFoundEntry, now: number): { outcome: string; primary: string; detail: string } {
  return {
    outcome: e.outcome,
    primary: `Not found ${whenWords(e.at, now)}`,
    detail: 'Nothing was searched this time. It’s asked again after a week, or now if you press Retry.',
  }
}
