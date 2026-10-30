/**
 * The album page's credits line — released, label, producer — kept on disk
 * (userData/album-credits.json) so a once-fetched fact "is just there" (Jake
 * 2026-10-30: "it should just be there. it shouldnt have to load
 * everytime"). It lived in a per-session Map before: every launch asked
 * iTunes and MusicBrainz again for every album opened.
 *
 * Same shape as album-notes.ts: loaded once, written atomically, writes
 * serialized, a failed write is one warning. An empty answer (neither API
 * knew the record) is kept too, and asked again after 30 days.
 *
 * The facts themselves come from the personnel lookup when it found the
 * record (album-personnel.ts carries the group's first release date and the
 * record's label along with the people — creditsFromPersonnel below), so the
 * page's two MusicBrainz sections cost one round, and the prefetch fills
 * this file at no extra request. ipc/album-info-ipc.ts is the wire.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic-write.ts'
import type { AlbumPerson } from './album-personnel.ts'

export type AlbumCredits = { released?: string; label?: string; producer?: string; recorded?: string }
export interface AlbumCreditsEntry { credits: AlbumCredits; at: number }
export interface AlbumCreditsFile { v: 1; entries: Record<string, AlbumCreditsEntry> }

export const ALBUM_CREDITS_FILE = 'album-credits.json'
/** An empty answer is asked again after this long. */
export const CREDITS_EMPTY_RECHECK_MS = 30 * 24 * 3600 * 1000

export const albumCreditsPath = (dir: string): string => join(dir, ALBUM_CREDITS_FILE)

/** The same key the in-memory cache used: artist|album, plus the tag year
 *  the plausibility check ran against (a different year is a different answer). */
export const albumCreditsKey = (artist: string, album: string, tagYear: string): string =>
  `${String(artist ?? '').toLowerCase().trim()}|${String(album ?? '').toLowerCase().trim()}|y:${tagYear || '?'}`

const CREDIT_FIELDS = ['released', 'label', 'producer', 'recorded'] as const

/** Only the four string fields, only when non-blank. */
export function cleanCredits(raw: unknown): AlbumCredits {
  const out: AlbumCredits = {}
  if (!raw || typeof raw !== 'object') return out
  for (const f of CREDIT_FIELDS) {
    const v = (raw as Record<string, unknown>)[f]
    if (typeof v === 'string' && v.trim()) out[f] = v.trim()
  }
  return out
}

export const isEmptyCredits = (c: AlbumCredits): boolean => CREDIT_FIELDS.every((f) => !c[f])

/** Keep well-formed entries; anything else in the file is ignored, not trusted. */
export function normalizeAlbumCredits(raw: unknown): AlbumCreditsFile {
  const out: AlbumCreditsFile = { v: 1, entries: {} }
  if (!raw || typeof raw !== 'object') return out
  const entries = (raw as { entries?: unknown }).entries
  if (!entries || typeof entries !== 'object') return out
  for (const [k, v] of Object.entries(entries as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const e = v as { credits?: unknown; at?: unknown }
    if (typeof e.at !== 'number' || !Number.isFinite(e.at) || !e.credits || typeof e.credits !== 'object') continue
    out.entries[k] = { credits: cleanCredits(e.credits), at: e.at }
  }
  return out
}

/** Only an empty answer goes stale, after 30 days; facts stay. */
export function isCreditsStale(entry: AlbumCreditsEntry, now: number): boolean {
  return isEmptyCredits(entry.credits) && now - entry.at > CREDITS_EMPTY_RECHECK_MS
}

/**
 * The credits line from what the personnel lookup found: the group's first
 * release date, the record's label, and the main producer — the person whose
 * producer credit covers the most of the record (a release-level credit
 * covers all of it; ties keep the lookup's order, performers first). null
 * when the lookup found no release group for this album — nothing is known.
 */
export function creditsFromPersonnel(entry: { people: readonly AlbumPerson[]; trackCount: number; releaseMbid?: string; released?: string; label?: string }): AlbumCredits | null {
  if (!entry.releaseMbid && !entry.released && !entry.label) return null
  const out: AlbumCredits = {}
  if (entry.released) out.released = entry.released
  if (entry.label) out.label = entry.label
  let best: { name: string; covers: number } | null = null
  for (const p of entry.people) {
    const credit = p.credits.find((c) => c.role === 'producer')
    if (!credit && !p.roles.includes('producer')) continue
    const covers = credit ? (credit.tracks.length === 0 ? Math.max(entry.trackCount, 1) : credit.tracks.length) : p.tracks
    if (!best || covers > best.covers) best = { name: p.name, covers }
  }
  if (best) out.producer = best.name
  return out
}

export interface AlbumCreditsStore {
  /** The remembered credits, or undefined when unknown or due a re-check. */
  get(key: string): Promise<AlbumCredits | undefined>
  /** True when `get` would answer. */
  has(key: string): Promise<boolean>
  /** Remember an answer (an empty one too). Writes are queued and atomic; the
   *  promise is the write landing — callers that do not care `void` it. */
  set(key: string, credits: AlbumCredits): Promise<void>
  /** Wait for queued writes (tests, quit path). */
  flush(): Promise<void>
}

export function createAlbumCreditsStore(dir: string, deps: { now?: () => number; log?: (m: string) => void } = {}): AlbumCreditsStore {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((m: string) => console.warn(m))
  const file = albumCreditsPath(dir)
  let state: AlbumCreditsFile | null = null
  let loading: Promise<AlbumCreditsFile> | null = null
  const load = (): Promise<AlbumCreditsFile> => {
    if (state) return Promise.resolve(state)
    if (!loading) {
      loading = (async () => {
        let loaded: AlbumCreditsFile = { v: 1, entries: {} }
        try {
          loaded = normalizeAlbumCredits(JSON.parse(await readFile(file, 'utf8')))
        } catch (err) {
          // No file yet is the first launch; anything else is worth one line.
          if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') log(`[album-credits] ${ALBUM_CREDITS_FILE} unreadable, starting empty: ${err instanceof Error ? err.message : String(err)}`)
        }
        state = loaded
        return loaded
      })()
    }
    return loading
  }

  // One serialized, coalescing writer (the album-personnel pattern): the
  // write serializes `state` as it is when it RUNS.
  let writeChain: Promise<void> = Promise.resolve()
  let writeQueued = false
  const scheduleWrite = (): void => {
    if (writeQueued) return
    writeQueued = true
    writeChain = writeChain.then(async () => {
      writeQueued = false
      if (!state) return
      try {
        await writeJsonAtomic(file, state)
      } catch (err) {
        log(`[album-credits] could not write ${ALBUM_CREDITS_FILE}: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  }

  const live = async (key: string): Promise<AlbumCreditsEntry | undefined> => {
    const e = (await load()).entries[key]
    return e && !isCreditsStale(e, now()) ? e : undefined
  }

  return {
    get: async (key) => (await live(key))?.credits,
    has: async (key) => !!(await live(key)),
    set: async (key, credits) => {
      const s = await load()
      s.entries[key] = { credits: cleanCredits(credits), at: now() }
      scheduleWrite()
      return writeChain
    },
    flush: () => writeChain,
  }
}
