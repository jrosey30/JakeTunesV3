/**
 * A freed track id is never handed out again (2026-10-20).
 *
 * Every allocator here took max(library id) + 1 (nextLibraryId, the
 * renderer's import counter) and then probed the disk for a free
 * imported_<id> slot. Deleting the newest track freed both: its id left the
 * library and save-library unlinked its file. At 21:48 Jake deleted phone
 * download 12915; at 21:50 a new download got 12915 — and homemini, still
 * holding the phone's sidecar row 12915, read the reuse as an id collision
 * and brought the deleted song back (track-tombstones.ts has the rest).
 *
 * The mark is persistent (userData/track-id-high-water.json) and only rises:
 * every id an allocator hands out, every id a save writes, and every id seen
 * in the phone-import mirror (an id the phone used is spent even if its row
 * never reaches this library). findFreeImportedId starts above it, so every
 * allocator — drag-drop, downloads, CD rips — inherits the rule.
 *
 * Electron-free — __tests__/track-tombstones.test.ts.
 *
 * ⚠️ TWIN: ~/JakeTunesMobile backend/src/util/metadataFields.ts nextImportId
 * + backend/src/util/importAbsorb.ts raiseHighWater (homemini's persisted
 * importIdHighWater, Brief 197, which likewise counts every id the desktop's
 * library carries). Same rule both sides: next id = max(every live id, the
 * mark) + 1, and the mark only rises.
 */
import { readFile } from 'node:fs/promises'
import { writeJsonAtomic } from './atomic-write.ts'

export const TRACK_ID_HIGH_WATER_FILE = 'track-id-high-water.json'

/** The mark after seeing `ids`: never lower. Junk ids don't count. */
export function raiseHighWater(mark: number, ids: Iterable<unknown>): number {
  let out = Number.isFinite(mark) && mark > 0 ? Math.floor(mark) : 0
  for (const id of ids) {
    const n = Number(id)
    if (Number.isFinite(n) && Math.floor(n) > out) out = Math.floor(n)
  }
  return out
}

/** next id = max(1, every live id + 1, mark + 1). */
export function nextIdAbove(ids: Iterable<unknown>, mark = 0): number {
  return Math.max(1, raiseHighWater(mark, ids) + 1)
}

export interface IdHighWater {
  /** The highest id ever handed out or seen. */
  floor(): Promise<number>
  /** Raise the mark to cover these ids (persisted when it moves). */
  raise(ids: Iterable<unknown>): Promise<void>
}

export function createIdHighWater(filePath: string, warn: (msg: string) => void = (m) => console.warn(m)): IdHighWater {
  let mark: number | null = null
  let saved = 0
  let chain: Promise<unknown> = Promise.resolve()
  let warned = false

  async function load(): Promise<number> {
    if (mark !== null) return mark
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf-8')) as { highWater?: unknown }
      mark = raiseHighWater(0, [raw?.highWater])
    } catch {
      mark = mark ?? 0   // none yet: the first save or allocation seeds it from the library
    }
    saved = mark
    return mark
  }

  return {
    floor: load,
    async raise(ids) {
      const before = await load()
      const next = raiseHighWater(Math.max(before, mark ?? 0), ids)
      if (next <= (mark ?? 0)) return
      mark = next
      const run = chain.then(async () => {
        if ((mark ?? 0) <= saved) return
        const value = mark ?? 0
        await writeJsonAtomic(filePath, { v: 1, highWater: value, updatedAt: new Date().toISOString() })
        saved = value
        warned = false
      })
      chain = run.catch((err) => {
        // Held in memory for this session; the next raise retries the write.
        if (!warned) warn(`[id-high-water] could not save ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
        warned = true
      })
      await chain
    },
  }
}
