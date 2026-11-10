/**
 * Songs Jake just got or just played come back onto this Mac (2026-11-10).
 *
 * offload-keep-recent.ts stops the queue from offloading them. This is the
 * other half: on 2026-11-09 and 11-10 the queue had already turned 694 such
 * songs (36 GB) into links, "Transistor" among them. They are pulled back a
 * few per pass, newest first, and put back on the queue, where the keep rule
 * holds them until they are no longer recent.
 *
 * A file is written only from this Mac's own record of what it replaced
 * (offload-replacements.jsonl): homemini's bytes must be that size and that
 * whole-file sha1, or nothing is written (rehydrateReplacements, the same
 * check "Undo offload" uses). A song with no such record stays streamed.
 * A song the player asked for lately is left alone: swapping the file under a
 * song that is playing is the one thing this must never do.
 *
 * Electron-free; every effect is injected (__tests__/offload-recent-return.test.ts).
 */
import type { OffloadReplacementRecord, RehydrateResult } from './offload-audio.ts'

/** At most this many files a pass (a pass runs every 90 s). */
export const RETURN_PER_PASS = 6
/** A file is fetched whole into memory before it is checked, so a show-sized file (a merged concert is 1 GB) stays streamed. */
export const RETURN_MAX_BYTES = 300 * 1024 * 1024

/** The newest record of each path that is in `keep`, newest first. A record with no whole-file sha1 can't restore anything; a show-sized file is left streamed. */
export function recentReturnCandidates(
  records: ReadonlyArray<OffloadReplacementRecord>,
  keep: { has(colonPath: string): boolean },
): OffloadReplacementRecord[] {
  const newest = new Map<string, OffloadReplacementRecord>()
  for (const r of records) {
    if (!r?.path || !keep.has(r.path)) continue
    if (!/^[0-9a-f]{40}$/i.test(r.fullSha1 || '')) continue
    if (!(Number(r.bytes) > 0) || Number(r.bytes) > RETURN_MAX_BYTES) continue
    const have = newest.get(r.path)
    if (!have || String(r.ts) >= String(have.ts)) newest.set(r.path, r)
  }
  return [...newest.values()].sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
}

export interface ReturnRecentResult { restored: number; looked: number; stoppedBecause: string | null }

export async function returnRecentSongs(opts: {
  records: ReadonlyArray<OffloadReplacementRecord>
  keep: { has(colonPath: string): boolean }
  /** The player asked for this song lately: leave it alone. */
  inUse: (colonPath: string) => boolean
  currentKind: (record: OffloadReplacementRecord) => Promise<'symlink' | 'file' | 'missing'>
  /** rehydrateReplacements with its real effects: checks size + sha1, then writes. */
  rehydrate: (records: OffloadReplacementRecord[]) => Promise<RehydrateResult>
  /** Back on the offload queue, so the song is offloaded again once it is no longer recent. */
  requeue: (records: OffloadReplacementRecord[]) => Promise<void>
  max?: number
  log: (msg: string) => void
}): Promise<ReturnRecentResult> {
  const max = opts.max ?? RETURN_PER_PASS
  const picked: OffloadReplacementRecord[] = []
  let looked = 0
  for (const r of recentReturnCandidates(opts.records, opts.keep)) {
    if (picked.length >= max) break
    if (opts.inUse(r.path)) continue
    looked++
    let kind: 'symlink' | 'file' | 'missing'
    try { kind = await opts.currentKind(r) } catch { continue }
    if (kind === 'symlink') picked.push(r)
  }
  if (!picked.length) return { restored: 0, looked, stoppedBecause: null }
  const result = await opts.rehydrate(picked)
  const back: OffloadReplacementRecord[] = []
  for (const r of picked) {
    try { if ((await opts.currentKind(r)) === 'file') back.push(r) } catch { /* not known to be back: not requeued */ }
  }
  if (back.length) {
    await opts.requeue(back)
    opts.log(`[offload] ${back.length} recent song(s) are back on this Mac: ${back.map((r) => r.id).join(', ')}`)
  }
  if (result.stoppedBecause) opts.log(`[offload] bringing recent songs back stopped: ${result.stoppedBecause}`)
  return { restored: back.length, looked, stoppedBecause: result.stoppedBecause }
}
