/**
 * The one object main/index.ts holds for "a deleted song stays deleted"
 * (2026-10-20). It wires the two halves together so index.ts only calls it:
 *
 *   • track-tombstones.ts — deletions recorded after each save, pushed to
 *     homemini, and used to filter the phone-import mirror before the
 *     renderer's absorb (ADD_IMPORTED_TRACKS) ever sees a deleted row;
 *   • track-id-high-water.ts — the persisted mark every allocator starts
 *     above, raised by each save and by every id in the phone-import mirror.
 *
 * Electron-free — __tests__/track-tombstones.test.ts.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTrackTombstones, liveFingerprints, type SavedTrackLike, type TrackTombstones } from './track-tombstones.ts'
import { createIdHighWater, TRACK_ID_HIGH_WATER_FILE, type IdHighWater } from './track-id-high-water.ts'

export interface PhoneImportGuardOptions {
  /** userData. */
  dir: string
  /** homemini's backend origin. */
  baseUrl: string
  /** This Mac's library tracks (its audioFingerprints decide what is still live). */
  libraryTracks: () => Promise<readonly SavedTrackLike[]>
  fetchImpl?: Parameters<typeof createTrackTombstones>[0]['fetchImpl']
  warn?: (key: string, msg: string) => void
  log?: (msg: string) => void
}

export interface PhoneImportGuard {
  tombstones: TrackTombstones
  idHighWater: IdHighWater
  /** save-library landed: record what it deleted and raise the id mark. Never throws. */
  afterSave(prev: readonly SavedTrackLike[], next: readonly SavedTrackLike[], ctx: { adoption?: boolean; force?: boolean }): Promise<void>
  /**
   * The rows of this Mac's phone-import mirror (mobile-imports.json) that the
   * absorb may take: every row's id — and homemini's own importIdHighWater —
   * raises the mark (the phone spent them), and rows a deletion covers are
   * left out. [] when there is no readable mirror.
   */
  absorbableImports(mirrorPath: string): Promise<unknown[]>
}

export function createPhoneImportGuard(opts: PhoneImportGuardOptions): PhoneImportGuard {
  const warn = opts.warn ?? ((_k: string, m: string) => console.warn(m))
  const log = opts.log ?? ((m: string) => console.log(m))
  const tombstones = createTrackTombstones({ dir: opts.dir, baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl, warn, log })
  const idHighWater = createIdHighWater(join(opts.dir, TRACK_ID_HIGH_WATER_FILE), (m) => warn('id-high-water', m))
  let lastWithheld = ''

  return {
    tombstones,
    idHighWater,
    async afterSave(prev, next, ctx) {
      try {
        await idHighWater.raise([...prev, ...next].map((t) => t?.id))
        await tombstones.recordSave(prev, next, ctx)
      } catch (err) {
        warn('phone-import-guard-save', `[track-tombstones] after-save bookkeeping failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    async absorbableImports(mirrorPath) {
      let rows: unknown[]
      let phoneMark: unknown
      try {
        const parsed = JSON.parse(await readFile(mirrorPath, 'utf-8')) as { tracks?: unknown; importIdHighWater?: unknown }
        rows = Array.isArray(parsed?.tracks) ? parsed.tracks : []
        phoneMark = parsed?.importIdHighWater
      } catch {
        return []   // no imports mirrored yet — the next tick retries
      }
      // ⚠️ TWIN: homemini's importIdHighWater rides in the same file — an id
      // the phone ever handed out is spent here too, row or no row.
      await idHighWater.raise([...rows.map((r) => (r as { id?: unknown } | null)?.id), phoneMark])
      const live = liveFingerprints(await opts.libraryTracks().catch(() => []))
      const { kept, withheld } = await tombstones.filterImportRows(rows as Array<{ id?: unknown }>, live)
      const key = withheld.join(',')
      if (key && key !== lastWithheld) log(`[phone-sync] not absorbing ${withheld.length} phone download(s) deleted here: ${key}`)
      lastWithheld = key
      return kept
    },
  }
}
