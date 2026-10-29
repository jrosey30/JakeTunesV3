/**
 * One genre filer, on the hub only (2026-10-29, Jake: "the genre filer must
 * work across the board, why would it work on one device but not the other??").
 *
 * What was wrong. workmini is a replica: its genres come from the hub catalog
 * (src/common/hub-catalog-merge.ts, 'genre' is a HUB_CATALOG_FIELDS field), and
 * at load its own metadata-overrides.json loses every hub-carried field
 * (replicaOverlay, src/common/user-edits.ts) — only Jake's journaled edits beat
 * the hub. But the genre filer (ipc/genre-filer-ipc.ts) still ran its whole
 * sweep there; only the one-time corrections pass was hub-only. It judged
 * workmini's library through that RAW overrides file — a stale copy holding
 * 2,581 old catch-all genres the window never showed (measured 10/29: workmini's
 * library.json matched the hub on every song; its overrides file differed on
 * 2,581 across 714 albums) — so it re-judged and re-filed albums the MacBook had
 * already settled (The Avalanches "No Bad Memories" → Experimental on workmini at
 * 08:06 10/29, four minutes after the MacBook put it back to Electronic), wrote
 * its picks into its own overrides + genre-provenance.json + genre-check.json,
 * and pushed them into workmini's window ('genre-filer:applied'), where they sat
 * over the hub's genre until a hub delta happened to touch the song or the app
 * relaunched. None of it ever reached the MacBook or the phone: the filer's
 * writes are not Jake's edits, so they are not journaled.
 *
 * The rule now:
 *   - the filer (sweep, corrections, rulings) runs on the HUB only. A replica
 *     never files, never asks Claude, never writes a genre. Its genres are the
 *     hub catalog's, plus Jake's own Get Info edits on that replica (the
 *     journal carries those to the hub, which absorbs and republishes them).
 *   - a replica's check list is empty: the questions live on the MacBook,
 *     which is the one machine that can answer them for every device.
 *   - once, on a replica: back up metadata-overrides.json and take the stale
 *     genre values out of it (keeping only a genre Jake himself set there and
 *     journaled), so nothing that reads the file raw sees old genres again.
 *     A marker makes the second launch a no-op.
 *
 * Electron-free (tests: __tests__/genre-replica.test.ts).
 */
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type FilerRole = 'hub' | 'replica'

/** Which role the filer plays on this Mac right now. An error is a replica:
 *  the safe side is a filer that does not write. */
export async function filerRole(isReplica?: () => Promise<boolean>): Promise<FilerRole> {
  if (!isReplica) return 'hub'
  try { return (await isReplica()) ? 'replica' : 'hub' } catch { return 'replica' }
}

/** One filer pass: the hub files; a replica only runs its one-time repair. */
export async function genreFilerPass(o: {
  isReplica?: () => Promise<boolean>
  hub: () => Promise<void>
  replica: () => Promise<void>
}): Promise<FilerRole> {
  const role = await filerRole(o.isReplica)
  if (role === 'hub') await o.hub()
  else await o.replica()
  return role
}

type Entry = { fp?: string; fields?: Record<string, string> }

/**
 * The replica's overrides with the stale genres taken out. A genre stays only
 * where this replica's own journal says Jake set exactly that genre here
 * (the overlay would put it back anyway; keeping it keeps the file honest).
 * Everything else in an entry (bpm, plays, rating...) is untouched.
 */
export function stripReplicaGenres(
  overrides: Record<string, unknown>,
  journalGenre: (id: string) => string | undefined,
): { next: Record<string, unknown>; stripped: number; kept: number } {
  const next: Record<string, unknown> = {}
  let stripped = 0
  let kept = 0
  for (const [id, raw] of Object.entries(overrides)) {
    const e = raw as Entry
    if (!e || typeof e !== 'object' || !e.fields || typeof e.fields !== 'object' || !('genre' in e.fields)) { next[id] = raw; continue }
    const mine = journalGenre(id)
    if (mine !== undefined && mine.trim() === String(e.fields.genre).trim()) { next[id] = raw; kept++; continue }
    const { genre: _drop, ...rest } = e.fields
    next[id] = { ...e, fields: rest }
    stripped++
  }
  return { next, stripped, kept }
}

export const REPLICA_REPAIR_MARKER = 'replica-genre-repair.json'
export const REPLICA_REPAIR_ID = 'replica-genres-follow-hub-2026-10-29'

export interface ReplicaRepairDeps {
  userData: string
  /** flush the overrides cache to disk before the backup */
  flushOverrides?(): Promise<void>
  /** the app's own serialized override writer (writeOverridesSerialized) */
  updateOverrides(mutate: (cur: Record<string, unknown>) => Record<string, unknown>): Promise<void>
  /** this replica's journaled genre per song id (user-edits.json) */
  journalGenres(): Promise<Map<string, { v: string }>>
  log?(msg: string): void
  now?(): Date
}

export interface ReplicaRepairResult { ran: boolean; stripped: number; kept: number; backup?: string }

/** Once per replica: back up, strip stale genres, mark done. Idempotent. */
export async function runReplicaGenreRepair(deps: ReplicaRepairDeps): Promise<ReplicaRepairResult> {
  const markerPath = join(deps.userData, REPLICA_REPAIR_MARKER)
  try {
    const m = JSON.parse(await readFile(markerPath, 'utf8')) as { id?: string }
    if (m.id === REPLICA_REPAIR_ID) return { ran: false, stripped: 0, kept: 0 }
  } catch { /* never ran */ }
  const log = (s: string): void => deps.log?.(`[genre-replica] ${s}`)
  const now = (deps.now ?? (() => new Date()))()
  await deps.flushOverrides?.()
  const src = join(deps.userData, 'metadata-overrides.json')
  const backup = `${src}.bak-replica-genres-${now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}`
  try { await copyFile(src, backup) } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log(`no backup of metadata-overrides.json (${err instanceof Error ? err.message : String(err)}) — repair not run`)
      return { ran: false, stripped: 0, kept: 0 }
    }
    // No file at all: nothing stale to strip. Still mark done.
    await writeFile(markerPath, JSON.stringify({ id: REPLICA_REPAIR_ID, at: now.toISOString(), stripped: 0, kept: 0 }, null, 2))
    return { ran: true, stripped: 0, kept: 0 }
  }
  const journal = await deps.journalGenres()
  let stripped = 0
  let kept = 0
  await deps.updateOverrides((cur) => {
    const r = stripReplicaGenres(cur, (id) => journal.get(id)?.v)
    stripped = r.stripped; kept = r.kept
    return r.next
  })
  await deps.flushOverrides?.()
  await writeFile(markerPath, JSON.stringify({ id: REPLICA_REPAIR_ID, at: now.toISOString(), backup, stripped, kept }, null, 2))
  log(`this Mac is a replica: its genres come from the hub. Took ${stripped} stale genre(s) out of metadata-overrides.json (kept ${kept} he set here himself); backup ${backup}`)
  return { ran: true, stripped, kept, backup }
}
