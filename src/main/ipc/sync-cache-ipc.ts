/**
 * The sync-convert cache's IPC and its upkeep (Brief 265 Part 5; sync-convert-cache.ts).
 *
 *   sync-convert-cache:status   files, bytes, leftover partials, the cap (null = off)
 *   sync-convert-cache:set-cap  { capGb: number | null }; null turns pruning off
 *   sync-convert-cache:clear    empty it (refused while a sync runs)
 *
 * At startup: leftover partials are swept (ten minutes or older, never during a sync). Every
 * ten minutes, and right after a cap is set: prune to the cap. With no cap (the default)
 * nothing is deleted. The Device page's controls arrive with the profile editor.
 */
import { join } from 'node:path'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import {
  CACHE_SETTINGS_FILE, SYNC_CONVERT_CACHE_SUBDIR, cacheStatus, clearCache, pruneToCap, readCapGb, sweepPartials, writeCapGb,
} from '../sync-convert-cache.ts'

export interface SyncCacheHost {
  userData: string
  syncInFlight: () => boolean
  /** The cache names a size limit may never take: the copies the songs on the iPods were made from. */
  protectedNames?: () => Promise<ReadonlySet<string>>
}

const PRUNE_EVERY_MS = 10 * 60 * 1000

export function startSyncConvertCache(ipc: IpcRegistrar, host: SyncCacheHost): { stop: () => void } {
  const dir = join(host.userData, SYNC_CONVERT_CACHE_SUBDIR)
  const settings = join(host.userData, CACHE_SETTINGS_FILE)
  const inFlight = host.syncInFlight

  const prune = async (why: string): Promise<void> => {
    const r = await pruneToCap(dir, await readCapGb(settings), { syncInFlight: inFlight, protect: host.protectedNames })
    if (r.pruned) console.log(`[sync-cache] ${why}: pruned ${r.removed} least-recently-used file(s), ${(r.freedBytes / 1e9).toFixed(2)} GB freed, ${(r.leftBytes / 1e9).toFixed(2)} GB left`)
  }

  void sweepPartials(dir, { syncInFlight: inFlight }).then((gone) => {
    if (gone.length > 0) console.log(`[sync-cache] removed ${gone.length} leftover partial file(s) from an interrupted convert`)
  }).catch((err) => console.warn('[sync-cache] partial sweep:', err instanceof Error ? err.message : err))
  void prune('startup').catch((err) => console.warn('[sync-cache] prune:', err instanceof Error ? err.message : err))
  const timer = setInterval(() => { void prune('periodic').catch((err) => console.warn('[sync-cache] prune:', err instanceof Error ? err.message : err)) }, PRUNE_EVERY_MS)
  timer.unref?.()

  ipc.handle('sync-convert-cache:status', async () => ({ ok: true, ...(await cacheStatus(dir, settings)) }), { refuse: REFUSED_SENDER })
  ipc.handle('sync-convert-cache:set-cap', async (_e, raw) => {
    const v = (raw as { capGb?: unknown } | null)?.capGb
    const capGb = v === null || v === undefined ? null : Number(v)
    if (capGb !== null && !(Number.isFinite(capGb) && capGb >= 1 && capGb <= 4000)) return { ok: false, error: 'Pick a size between 1 and 4000 GB, or turn the limit off.' }
    await writeCapGb(settings, capGb)
    await prune('cap set')
    return { ok: true, ...(await cacheStatus(dir, settings)) }
  }, { refuse: REFUSED_SENDER })
  ipc.handle('sync-convert-cache:clear', async () => {
    const r = await clearCache(dir, { syncInFlight: inFlight })
    if (r.ok) console.log(`[sync-cache] cleared by request: ${r.removed} file(s), ${(r.freedBytes / 1e9).toFixed(2)} GB`)
    return r
  }, { refuse: REFUSED_SENDER })

  return { stop: () => clearInterval(timer) }
}
