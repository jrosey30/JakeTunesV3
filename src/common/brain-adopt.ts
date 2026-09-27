/**
 * The laptop ADOPTS homemini's brain; it never pushes its own.
 *
 * 2026-09-27. Ask #2 of the nightly brain exercise
 * (brain-eval/PROPOSAL-mood-import-clobber.md, fixes 4 + 5). homemini's
 * nightly trainer owns embeddings.bin + mood-index.bin on the NAS since
 * 2026-07-11, and the sync script stopped pushing them then. But the
 * app's own auto-backup (autoBackupStateToNas, mtime-wins, whole file)
 * still pushed both: every import day it replayed the laptop's stale,
 * un-enriched copy over the trained one (14 of 14 import days by 9/4,
 * once reverting 612 of the trainer's re-embeds in a single night).
 *
 * Now the brain files flow ONE way, NAS → laptop. This module is the
 * pure half: decide whether a NAS copy is safe to adopt, and merge in
 * the laptop's vectors for songs imported since the trainer last ran.
 * Pure, so node --test loads it.
 */

/** Files homemini's trainer owns. The desktop may read them, never push them. */
export const HOMEMINI_OWNED_BRAIN_FILES = ['embeddings.bin', 'mood-index.bin'] as const

export function assertNoBrainPush(files: readonly string[], label: string): void {
  const hits = files.filter((f) => (HOMEMINI_OWNED_BRAIN_FILES as readonly string[]).includes(f))
  if (hits.length > 0) {
    throw new Error(`[brain] ${label} must not push ${hits.join(', ')}: homemini's trainer owns them (see src/common/brain-adopt.ts)`)
  }
}

/** A NAS copy must cover at least this share of the library to be adopted. */
export const ADOPT_MIN_LIBRARY_COVERAGE = 0.9

export interface AdoptPlan {
  adopt: boolean
  reason: string
  merged?: Map<number, Float32Array>
  /** Laptop vectors carried over: in the library, missing from the NAS copy. */
  keptLocal: number
}

/**
 * @param headerCount  the vector count the NAS file's header claims
 * @param nas          what actually parsed out of the NAS file
 * @param local        the laptop's current map
 * @param libraryIds   every track id in the laptop's library
 */
export function planBrainAdopt(
  headerCount: number,
  nas: Map<number, Float32Array>,
  local: Map<number, Float32Array>,
  libraryIds: Set<number>,
): AdoptPlan {
  if (nas.size === 0) return { adopt: false, reason: 'NAS copy is empty or unreadable', keptLocal: 0 }
  // parseEmbeddingsBlob stops quietly at the end of the bytes, so a short
  // SMB read parses as a smaller brain. The header is the truth.
  if (nas.size !== headerCount) {
    return { adopt: false, reason: `NAS copy is truncated: header says ${headerCount} vectors, ${nas.size} parsed`, keptLocal: 0 }
  }
  if (libraryIds.size > 0) {
    let covered = 0
    for (const id of libraryIds) if (nas.has(id)) covered++
    if (covered < libraryIds.size * ADOPT_MIN_LIBRARY_COVERAGE) {
      return { adopt: false, reason: `NAS copy covers only ${covered} of ${libraryIds.size} library tracks`, keptLocal: 0 }
    }
  }
  const merged = new Map(nas)
  let keptLocal = 0
  for (const [id, v] of local) {
    if (libraryIds.has(id) && !merged.has(id)) { merged.set(id, v); keptLocal++ }
  }
  return { adopt: true, reason: 'ok', merged, keptLocal }
}
