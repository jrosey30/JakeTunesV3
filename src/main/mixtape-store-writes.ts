/**
 * The LOCAL writers of the tape shelf (mixtapes.json + mixtape-tombstones.json),
 * pulled out of mixtapes.ts so they carry the A02 guard (hub-local-state.ts)
 * and so tests drive the very same code the IPC handlers run.
 *
 * Every writer here:
 *   - runs under the shelf's lock — the hub client holds the same lock while
 *     it adopts a reply, so a read-modify-write of the shelf (or of its
 *     tombstones) can never interleave with an adoption and lose either side;
 *   - bumps the mixtape generations when it is asked and again when its writes
 *     have landed — a hub reply computed from a snapshot older than that is
 *     dropped by the hub client, never adopted (a tape deleted, edited or
 *     recorded during a sync request stays that way).
 *
 * Electron-free: the store IO is injected. node --test loads it.
 */
import { loadTombstones, saveTombstones } from './playlist-tombstones.ts'
import { bumpLocalGen, withLocalLock, lockKeys } from './hub-local-state.ts'

export interface MixtapeStoreIo<T extends { id: string }> {
  load: () => Promise<T[]>
  save: (all: T[]) => Promise<void>
  /** Also names the shelf's lock. */
  tombstonesFile: string
}

/**
 * Run one read-modify-write on the shelf. `fn` does its own load/save through
 * the injected IO; it must not call another locked writer.
 */
export function mutateMixtapeStore<R>(tombstonesFile: string, fn: () => Promise<R>): Promise<R> {
  bumpLocalGen('mixtapes')
  bumpLocalGen('mixtapeTombstones')
  return withLocalLock(lockKeys.mixtapeStore(tombstonesFile), async () => {
    try {
      return await fn()
    } finally {
      bumpLocalGen('mixtapes')
      bumpLocalGen('mixtapeTombstones')
    }
  })
}

/**
 * Upsert by id (mixtape-save). Stamps modifiedAt — the hub merge keys on it —
 * and, because a saved tape is alive by the owner's word, clears any tombstone
 * for its id so a deliberate re-creation isn't re-deleted by the next sync.
 */
export async function upsertMixtape<T extends { id: string; modifiedAt?: string }>(
  io: MixtapeStoreIo<T>,
  tape: T,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  await mutateMixtapeStore(io.tombstonesFile, async () => {
    const all = await io.load()
    tape.modifiedAt = now()   // hub merge keys on this
    const idx = all.findIndex((m) => m.id === tape.id)
    if (idx >= 0) all[idx] = tape
    else all.unshift(tape)
    await io.save(all)
    const ts = await loadTombstones(io.tombstonesFile)
    if (ts.some((t) => t.id === tape.id)) {
      await saveTombstones(ts.filter((t) => t.id !== tape.id), io.tombstonesFile)
    }
  })
}

/**
 * Delete by id (mixtape-delete) and leave the durable record of the deletion —
 * the hub and the harvest union it, so the tape stays dead everywhere and can
 * never be resurrected by a sync ("existence is not memory"). Null when no
 * tape has that id (nothing written).
 */
export async function removeMixtape<T extends { id: string; title?: string }>(
  io: MixtapeStoreIo<T>,
  id: string,
  now: () => string = () => new Date().toISOString(),
): Promise<{ gone: T | undefined } | null> {
  return mutateMixtapeStore(io.tombstonesFile, async () => {
    const all = await io.load()
    const gone = all.find((m) => m.id === id)
    const next = all.filter((m) => m.id !== id)
    if (next.length === all.length) return null
    await io.save(next)
    const ts = await loadTombstones(io.tombstonesFile)
    if (!ts.some((t) => t.id === id)) {
      await saveTombstones([...ts, { id, name: gone?.title ?? '', deletedAt: now() }], io.tombstonesFile)
    }
    return { gone }
  })
}
