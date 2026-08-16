/**
 * Pass-through storage: the laptop stages imports, it does not keep them.
 *
 * Jake, 2026-08-15: "make sure that the files i download are not stored here
 * and are stored on homemini/NAS. its annoying that we keep having to do
 * these exercises." The architecture already agrees with him — every import
 * lands under the local MUSIC_DIR, macbook-nas-sync pushes it to the NAS
 * vault within a minute, homemini pulls it from the vault within another,
 * playback resolves across every mount and streams homemini-first — and then
 * the local copy just sits there forever. ~/Music was 9.4GB of already-
 * propagated files on the day this shipped, regrowing with every add. The
 * missing piece was never transport; it was the goodbye.
 *
 * The goodbye is gated on IDENTITY, not existence (house rule for anything
 * destructive): a local file is evicted only when homemini's copy of the
 * SAME relative path hashes byte-identical to ours. That single check proves
 * the whole chain, because homemini cannot have the file except by pulling
 * it from the NAS after our push — its copy is a receipt for both hops. The
 * flaky SMB mount never gates anything (a wedged mount already burned one
 * night this week); ssh to homemini is the only oracle.
 *
 * Further guards, all cheap and all deliberate:
 *   - 24h grace: a file evicts only after a full day local, so same-day
 *     re-tagging, format churn, or a bad import gets caught while the
 *     original is still at arm's reach.
 *   - Library-alive: the file's track must still be IN library.json. An
 *     orphan on disk is the orphan-cleanup feature's problem, not ours —
 *     evicting it here would hide inventory bugs instead of surfacing them.
 *   - Trash, never unlink: reversible for 30 days by macOS's own rules.
 *   - Bounded batches: at most EVICT_BATCH files per sweep, one ssh call
 *     for the whole batch, so a 9GB backlog drains over hours of idle
 *     sweeps instead of hammering the Mini in one storm.
 *   - Journal: every eviction appends {when, rel, md5, bytes} to
 *     evictions.log BEFORE the trash call. If anything ever looks wrong,
 *     the receipt exists.
 *
 * Electron-free: every side effect arrives injected, so node --test can
 * exercise the decision logic against fakes.
 */

import { createHash } from 'crypto'
import { readFile } from 'fs/promises'

export const EVICT_GRACE_MS = 24 * 60 * 60 * 1000
export const EVICT_BATCH = 40

export interface EvictionCandidate {
  /** Absolute local path. */
  abs: string
  /** Path relative to the music root — identical on homemini. */
  rel: string
  mtimeMs: number
  sizeBytes: number
}

export interface EvictionDeps {
  /** All audio files currently under the local music root. */
  listLocalAudio: () => Promise<EvictionCandidate[]>
  /** Relative paths of every track library.json currently references. */
  libraryRelPaths: () => Promise<Set<string>>
  /** md5 of each relative path AS HOMEMINI HOLDS IT; missing/error entries omitted. */
  remoteMd5Batch: (rels: string[]) => Promise<Map<string, string>>
  /** Reversible removal — Electron shell.trashItem in production. */
  trash: (abs: string) => Promise<void>
  /** Append one line to the eviction journal. */
  journal: (line: string) => Promise<void>
  now: () => number
}

export interface SweepResult {
  examined: number
  tooYoung: number
  notInLibrary: number
  notOnHomemini: number
  hashMismatch: number
  evicted: number
  evictedBytes: number
  errors: number
}

async function localMd5(abs: string): Promise<string> {
  return createHash('md5').update(await readFile(abs)).digest('hex')
}

/**
 * One bounded sweep. Never throws: an error on one file is counted and the
 * sweep moves on — eviction is a background nicety and must never take the
 * app down or wedge on a single unreadable file.
 */
export async function sweepOnce(deps: EvictionDeps): Promise<SweepResult> {
  const r: SweepResult = {
    examined: 0, tooYoung: 0, notInLibrary: 0, notOnHomemini: 0,
    hashMismatch: 0, evicted: 0, evictedBytes: 0, errors: 0,
  }
  let candidates: EvictionCandidate[]
  let alive: Set<string>
  try {
    candidates = await deps.listLocalAudio()
    alive = await deps.libraryRelPaths()
  } catch {
    r.errors++
    return r
  }

  const cutoff = deps.now() - EVICT_GRACE_MS
  // Oldest first: the longest-settled files are the safest and the first to
  // free their space; a fresh import is always at the back of the queue.
  const eligible = candidates
    .filter((c) => {
      r.examined++
      if (c.mtimeMs > cutoff) { r.tooYoung++; return false }
      if (!alive.has(c.rel)) { r.notInLibrary++; return false }
      return true
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(0, EVICT_BATCH)

  if (eligible.length === 0) return r

  let remote: Map<string, string>
  try {
    remote = await deps.remoteMd5Batch(eligible.map((c) => c.rel))
  } catch {
    r.errors++
    return r
  }

  for (const c of eligible) {
    try {
      const theirs = remote.get(c.rel)
      if (!theirs) { r.notOnHomemini++; continue }
      const ours = await localMd5(c.abs)
      if (ours !== theirs) { r.hashMismatch++; continue }
      // Receipt BEFORE the act — if the trash call dies mid-flight, the
      // journal shows intent + proof of the remote copy.
      await deps.journal(JSON.stringify({
        when: new Date(deps.now()).toISOString(),
        rel: c.rel, md5: ours, bytes: c.sizeBytes,
      }))
      await deps.trash(c.abs)
      r.evicted++
      r.evictedBytes += c.sizeBytes
    } catch {
      r.errors++
    }
  }
  return r
}
