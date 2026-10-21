/**
 * Track deletions as identity tombstones (2026-10-20).
 *
 * Jake: "why is fucked up on beer and drugs in my library i deleted it".
 * A phone download (12915) was absorbed here; homemini could not save the
 * absorb stamp that evening (NAS EBUSY), so its sidecar row stayed. Jake
 * deleted the song; two minutes later this Mac gave a new download the
 * freed id 12915 (see track-id-high-water.ts). homemini read "sidecar 12915
 * ≠ library 12915" as a collision, re-homed the row to 12916 — and the next
 * mirror tick absorbed the deleted song straight back into this library.
 *
 * A deletion is identity, not a guess. When save-library drops a track's id
 * AND its audio fingerprint leaves the library, this records a tombstone
 * (id, audioFingerprint, title, artist, durationMs, deletedAt) and:
 *   • POSTs the whole list to homemini's /api/track-tombstones/merge, which
 *     drops the matching sidecar row, holds its audio, and never re-homes
 *     it (the same push-until-it-lands shape as star-hub-push.ts);
 *   • filters the phone-import mirror before the absorb, so a deleted row
 *     can never come back here even while homemini is unreachable or can't
 *     save — and its audio is never pulled down again.
 * Matching is by audioFingerprint only: the absorb copies the phone's row
 * verbatim, fingerprint included, so the deleted track and its sidecar row
 * share it (CLAUDE.md: destructive steps gate on identity, never text).
 *
 * Electron-free (injected fetch, plain paths) — __tests__/track-tombstones.test.ts.
 *
 * ⚠️ TWIN: ~/JakeTunesMobile backend/src/util/trackTombstones.ts —
 * parseTombstones, mergeTombstones, indexTombstones, tombstoneFor and
 * partitionTombstoned are the same rules on both sides (homemini drops
 * exactly the rows this absorb skips). Route: backend/src/routes/trackTombstones.ts.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic-write.ts'
import { withCompanionInit } from './hub-companion.ts'

export interface TrackTombstone {
  /** The library id the track had when it was deleted. */
  id: string
  /** The track's audioFingerprint — the identity every match uses. */
  audioFingerprint: string
  /** Informational (logs, diagnosis) — never matched on. */
  title: string
  artist: string
  durationMs: number
  /** ISO time of the deletion. */
  deletedAt: string
}

export const TRACK_TOMBSTONES_FILE = 'track-tombstones.json'
export const TRACK_TOMBSTONES_MERGE_PATH = '/api/track-tombstones/merge'
/** Newest N kept. Jake deletes dozens a month; this is years of them. */
export const TRACK_TOMBSTONE_CAP = 10_000

// ── The shared rules (⚠️ TWIN with homemini) ─────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
}

/** One tombstone, defensively. Null when it carries no usable identity. */
export function parseTombstone(raw: unknown): TrackTombstone | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const audioFingerprint = str(r.audioFingerprint).trim()
  const deletedAt = str(r.deletedAt)
  if (!audioFingerprint || !Number.isFinite(Date.parse(deletedAt))) return null
  const durationMs = Number(r.durationMs)
  return {
    id: str(r.id),
    audioFingerprint,
    title: str(r.title),
    artist: str(r.artist),
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0,
    deletedAt: new Date(Date.parse(deletedAt)).toISOString(),
  }
}

/** `{ v: 1, tombstones: [...] }` (the file and the POST body) or a bare array. */
export function parseTombstones(raw: unknown): TrackTombstone[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { tombstones?: unknown }).tombstones)
      ? (raw as { tombstones: unknown[] }).tombstones
      : []
  const out: TrackTombstone[] = []
  for (const item of list) {
    const t = parseTombstone(item)
    if (t) out.push(t)
  }
  return out
}

export function tombstoneKey(t: Pick<TrackTombstone, 'audioFingerprint' | 'id'>): string {
  return `${t.audioFingerprint}|${t.id}`
}

/** Union by (fingerprint, id); the same key keeps the LATER deletion; capped to the newest. */
export function mergeTombstones(
  base: readonly TrackTombstone[],
  incoming: readonly TrackTombstone[],
): { merged: TrackTombstone[]; added: number; changed: boolean } {
  const byKey = new Map<string, TrackTombstone>()
  for (const t of base) {
    const k = tombstoneKey(t)
    const prev = byKey.get(k)
    if (!prev || Date.parse(t.deletedAt) > Date.parse(prev.deletedAt)) byKey.set(k, t)
  }
  const before = byKey.size
  let changed = false
  for (const t of incoming) {
    const k = tombstoneKey(t)
    const prev = byKey.get(k)
    if (!prev) { byKey.set(k, t); changed = true; continue }
    if (Date.parse(t.deletedAt) > Date.parse(prev.deletedAt)) { byKey.set(k, t); changed = true }
  }
  let merged = [...byKey.values()].sort((a, b) => Date.parse(a.deletedAt) - Date.parse(b.deletedAt))
  if (merged.length > TRACK_TOMBSTONE_CAP) {
    merged = merged.slice(merged.length - TRACK_TOMBSTONE_CAP)
    changed = true
  }
  return { merged, added: byKey.size - before, changed }
}

/** fingerprint → latest deletedAt (ms). */
export type TombstoneIndex = ReadonlyMap<string, number>

export function indexTombstones(tombs: readonly TrackTombstone[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const t of tombs) {
    const at = Date.parse(t.deletedAt)
    if (!Number.isFinite(at)) continue
    const prev = out.get(t.audioFingerprint)
    if (prev === undefined || at > prev) out.set(t.audioFingerprint, at)
  }
  return out
}

/** Every audioFingerprint a library still carries. */
export function liveFingerprints(tracks: readonly { audioFingerprint?: unknown }[]): Set<string> {
  const out = new Set<string>()
  for (const t of tracks) {
    const fp = typeof t.audioFingerprint === 'string' ? t.audioFingerprint.trim() : ''
    if (fp) out.add(fp)
  }
  return out
}

/**
 * Does a deletion cover this row? The deletion time (ms), or null.
 *   1. Identity: the row's audioFingerprint equals a tombstone's.
 *   2. Still deleted: no track in `live` carries that fingerprint (a
 *      deleted duplicate copy deletes nothing while the song remains).
 *   3. Before the deletion: the row was added at or before deletedAt; a
 *      later phone download is a deliberate re-add. No readable dateAdded
 *      counts as before — the deletion wins.
 */
export function tombstoneFor(
  row: { audioFingerprint?: unknown; dateAdded?: unknown },
  index: TombstoneIndex,
  live: ReadonlySet<string> = new Set(),
): number | null {
  const fp = typeof row.audioFingerprint === 'string' ? row.audioFingerprint.trim() : ''
  if (!fp) return null
  const deletedAt = index.get(fp)
  if (deletedAt === undefined) return null
  if (live.has(fp)) return null
  const addedAt = typeof row.dateAdded === 'string' ? Date.parse(row.dateAdded) : NaN
  if (Number.isFinite(addedAt) && addedAt > deletedAt) return null
  return deletedAt
}

/** The rows an absorb may take, and the ids a deletion keeps out. */
export function partitionTombstoned<T extends { id?: unknown; audioFingerprint?: unknown; dateAdded?: unknown }>(
  rows: readonly T[],
  index: TombstoneIndex,
  live: ReadonlySet<string>,
): { kept: T[]; withheld: string[] } {
  const kept: T[] = []
  const withheld: string[] = []
  for (const row of rows) {
    if (tombstoneFor(row, index, live) !== null) withheld.push(String(row.id))
    else kept.push(row)
  }
  return { kept, withheld }
}

// ── Desktop only: what a save deleted ───────────────────────────────

export interface SavedTrackLike {
  id?: unknown
  audioFingerprint?: unknown
  title?: unknown
  artist?: unknown
  duration?: unknown
}

/**
 * The tracks a save deleted: present in `prev` (the library on disk), id gone
 * from `next`, AND fingerprint gone from `next`. A dedupe that keeps another
 * copy of the same bytes deletes no identity, so it records nothing. A track
 * with no fingerprint has no identity to record.
 */
export function tombstonesForRemoved(
  prev: readonly SavedTrackLike[],
  next: readonly SavedTrackLike[],
  deletedAt: string,
): TrackTombstone[] {
  const nextIds = new Set<string>()
  for (const t of next) if (t?.id !== undefined && t?.id !== null) nextIds.add(String(t.id))
  const nextFps = liveFingerprints(next)
  const out: TrackTombstone[] = []
  const seen = new Set<string>()
  for (const t of prev) {
    if (t?.id === undefined || t?.id === null || nextIds.has(String(t.id))) continue
    const fp = typeof t.audioFingerprint === 'string' ? t.audioFingerprint.trim() : ''
    if (!fp || nextFps.has(fp) || seen.has(fp)) continue
    seen.add(fp)
    const durationMs = Number(t.duration)
    out.push({
      id: String(t.id),
      audioFingerprint: fp,
      title: str(t.title),
      artist: str(t.artist),
      durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0,
      deletedAt,
    })
  }
  return out
}

// ── Store + push ────────────────────────────────────────────────────

export interface TrackTombstonesOptions {
  /** userData — the list is this Mac's own (never synced as a file). */
  dir: string
  /** homemini's backend origin. */
  baseUrl: string
  fetchImpl?: (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number }>
  warn?: (key: string, msg: string) => void
  log?: (msg: string) => void
  now?: () => Date
  debounceMs?: number
  timeoutMs?: number
}

export interface TrackTombstones {
  /**
   * After a save landed: record the tracks it deleted. `adoption` (a hub
   * catalog save on a replica — rows the hub stopped listing, not Jake's
   * deletes) and `force` (recovery) record nothing. Returns how many.
   */
  recordSave(prev: readonly SavedTrackLike[], next: readonly SavedTrackLike[], ctx?: { adoption?: boolean; force?: boolean }): Promise<number>
  list(): Promise<TrackTombstone[]>
  /** Phone-import rows minus the ones a deletion covers (`live` = this library's fingerprints). */
  filterImportRows<T extends { id?: unknown; audioFingerprint?: unknown; dateAdded?: unknown }>(rows: readonly T[], live: ReadonlySet<string>): Promise<{ kept: T[]; withheld: string[] }>
  /** Mirror tick: push if something is owed. */
  tick(): Promise<void>
  /** One push now; true when homemini took it. */
  pushNow(): Promise<boolean>
}

export function createTrackTombstones(opts: TrackTombstonesOptions): TrackTombstones {
  const path = join(opts.dir, TRACK_TOMBSTONES_FILE)
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as NonNullable<TrackTombstonesOptions['fetchImpl']>)
  const warn = opts.warn ?? ((_k: string, m: string) => console.warn(m))
  const log = opts.log ?? ((m: string) => console.log(m))
  const now = opts.now ?? (() => new Date())
  const url = `${opts.baseUrl.replace(/\/+$/, '')}${TRACK_TOMBSTONES_MERGE_PATH}`
  let cache: TrackTombstone[] | null = null
  let index: TombstoneIndex = new Map()
  let chain: Promise<unknown> = Promise.resolve()
  let owed = true          // nothing has landed this session yet
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<boolean> | null = null

  async function load(): Promise<TrackTombstone[]> {
    if (cache) return cache
    try {
      cache = parseTombstones(JSON.parse(await readFile(path, 'utf-8')))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        warn('track-tombstones-read', `[track-tombstones] could not read ${path} (${err instanceof Error ? err.message : String(err)}) — starting from none`)
      }
      cache = []
    }
    index = indexTombstones(cache)
    return cache
  }

  async function pushNow(): Promise<boolean> {
    if (inFlight) return inFlight
    inFlight = (async () => {
      owed = false
      try {
        const tombstones = await load()
        const res = await fetchImpl(url, withCompanionInit({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ v: 1, tombstones }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        }) as Record<string, unknown>)
        if (!res.ok) {
          owed = true
          warn('track-tombstones-http', `[track-tombstones] homemini refused the deletions (${res.status}) — next tick retries`)
          return false
        }
        return true
      } catch (err) {
        owed = true
        warn('track-tombstones-unreachable', `[track-tombstones] homemini unreachable for the deletions (${err instanceof Error ? err.message : String(err)}) — next tick retries`)
        return false
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  function changed(): void {
    owed = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; void pushNow() }, opts.debounceMs ?? 2000)
    timer.unref?.()   // never what keeps a process alive; the mirror tick retries anyway
  }

  async function recordSave(prev: readonly SavedTrackLike[], next: readonly SavedTrackLike[], ctx: { adoption?: boolean; force?: boolean } = {}): Promise<number> {
    if (ctx.adoption === true || ctx.force === true) return 0
    const fresh = tombstonesForRemoved(prev, next, now().toISOString())
    if (fresh.length === 0) return 0
    const run = chain.then(async () => {
      const r = mergeTombstones(await load(), fresh)
      if (!r.changed) return 0
      // Memory first: a refused write still honours the deletion this session.
      cache = r.merged
      index = indexTombstones(cache)
      try {
        await writeJsonAtomic(path, { v: 1, tombstones: cache })
      } catch (err) {
        warn('track-tombstones-write', `[track-tombstones] could not save ${path} (${err instanceof Error ? err.message : String(err)}) — held in memory, homemini still told`)
      }
      log(`[track-tombstones] ${r.added} deleted track(s) recorded: ${fresh.slice(0, 5).map((t) => `${t.id} ${t.title}`).join(', ')}${fresh.length > 5 ? ', …' : ''}`)
      return r.added
    })
    chain = run.catch((err) => warn('track-tombstones-record', `[track-tombstones] record failed: ${err instanceof Error ? err.message : String(err)}`))
    const added = await run.catch(() => 0)   // warned on the chain line above; save-library never waits on this
    if (added > 0) changed()
    return added
  }

  return {
    recordSave,
    list: load,
    async filterImportRows(rows, live) {
      await load()
      return partitionTombstoned(rows, index, live)
    },
    async tick() { if (owed) await pushNow() },
    pushNow,
  }
}
