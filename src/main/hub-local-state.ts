/**
 * Local-change generations and write locks for the hub clients
 * (2026-10-22, audit A02 — "an older hub reply overwrites newer local state").
 *
 * THE BUG. A converge snapshots local playlists / tombstones / pins (or tapes
 * and tape tombstones), POSTs the snapshot, waits for the hub (which persists
 * before it answers — seconds on a bad day), and then REPLACED local state
 * with the reply. Whatever Jake did during the wait was overwritten by an
 * answer computed from state that no longer existed:
 *   - a playlist or tape deleted during the wait came back (the reply's
 *     older, tombstone-less list REPLACED the tombstone file that had just
 *     recorded the delete — then it spread to every device, for good),
 *   - a fresh rename / added song / new playlist / newly recorded tape was
 *     replaced by the old copy whenever an unrelated remote change made the
 *     reply "differ",
 *   - a newer pin change lost to an older remote one.
 *
 * THE RULE ("existence is not memory": a tombstone beats stale presence).
 *   1. Every LOCAL writer bumps the generation of the collection it touches
 *      (bumpLocalGen) — at the moment it mutates, and for async writers again
 *      when the write has landed.
 *   2. A converge records the generations BEFORE it reads local state.
 *   3. When the reply arrives it takes the same write locks local writers
 *      take, then compares. Unchanged → nothing local moved since the
 *      snapshot, so adopting the reply is exactly today's behaviour.
 *      Changed → DROP the reply and converge again at once. Nothing is lost:
 *      the hub already merged the snapshot we sent, local state was never
 *      touched, and the next request carries the newer local state, which the
 *      hub's own rules (newest modifiedAt wins, a newer tombstone beats an
 *      older copy) resolve. No copy of the hub's merge rules lives in the
 *      client, so there is nothing to drift.
 *   4. The adoption itself bumps too, so a second converge that was in flight
 *      with an older snapshot (reordered replies) is dropped the same way.
 *
 * The locks close the last gap: a writer that starts AFTER the check queues
 * behind the adoption's file writes instead of interleaving with them, so a
 * read-modify-write of a tombstone file can never lose the other side.
 *
 * Electron-free (node --test loads it). Per-process state, deliberately: the
 * only writers are inside this one main process.
 */

export type HubCollection = 'playlists' | 'playlistTombstones' | 'pins' | 'mixtapes' | 'mixtapeTombstones'
export type LocalGens = Readonly<Record<HubCollection, number>>

/** What a playlist converge must see unmoved to adopt a reply. */
export const PLAYLIST_HUB_COLLECTIONS: readonly HubCollection[] = ['playlists', 'playlistTombstones', 'pins']
/** What a mixtape converge must see unmoved to adopt a reply. */
export const MIXTAPE_HUB_COLLECTIONS: readonly HubCollection[] = ['mixtapes', 'mixtapeTombstones']

const gens: Record<HubCollection, number> = {
  playlists: 0,
  playlistTombstones: 0,
  pins: 0,
  mixtapes: 0,
  mixtapeTombstones: 0,
}

/** Call from EVERY local writer of the named collection. */
export function bumpLocalGen(collection: HubCollection): void {
  gens[collection] += 1
}

export function snapshotLocalGens(): LocalGens {
  return { ...gens }
}

/** The watched collections whose generation differs from the snapshot. */
export function movedGens(since: LocalGens, watch: readonly HubCollection[]): HubCollection[] {
  return watch.filter((c) => gens[c] !== since[c])
}

// ── Keyed FIFO lock ──────────────────────────────────────────────────
// One queue per key. A failure inside one holder never blocks the next, and
// the map entry is dropped once the queue drains. NOT re-entrant: never take
// the same key inside itself.
const tails = new Map<string, Promise<void>>()

export function withLocalLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve()
  const run = prev.then(fn)
  const tail = run.then(() => undefined, () => undefined)
  tails.set(key, tail)
  void tail.then(() => { if (tails.get(key) === tail) tails.delete(key) })
  return run
}

/**
 * Lock keys. The tombstone and pin files are locked per file; a tape shelf
 * (mixtapes.json + its tombstones) is one lock, named by its tombstone file.
 * Converge order is always tombstones, then pins; no local writer holds two.
 */
export const lockKeys = {
  tombstones: (file: string): string => `tombstones:${file}`,
  pins: (file: string): string => `pins:${file}`,
  mixtapeStore: (tombstonesFile: string): string => `mixtape-store:${tombstonesFile}`,
}
