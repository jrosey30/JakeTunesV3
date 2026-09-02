/**
 * Activity Pool IPC — persistence + handlers for the hand-built sync pool.
 *
 * Store: userData/activity-pool.json → { ids: number[], updatedAt }.
 * Add/remove/clear all re-read the file (no in-memory cache to go stale)
 * and write atomically. The merge rules are pure (activity-pool.ts); the
 * skit gate is the SAME one the picker and the mixtape builder use, so a
 * 40-second interlude can't reach the iPod by any door.
 */
import { join } from 'path'
import { readFile, writeFile, rename } from 'fs/promises'
import { app } from 'electron'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { mergeIntoPool, removeFromPool, POOL_MAX, type PoolCandidate } from '../activity-pool.ts'
import { isSkitOrIntro } from '../workout-sync.ts'

const POOL_FILE = () => join(app.getPath('userData'), 'activity-pool.json')

export async function loadActivityPool(): Promise<number[]> {
  try {
    const parsed = JSON.parse(await readFile(POOL_FILE(), 'utf-8')) as { ids?: unknown }
    return Array.isArray(parsed?.ids) ? parsed.ids.map(Number).filter((n) => Number.isFinite(n)) : []
  } catch {
    // Missing file = empty pool. A torn file also reads as empty — the
    // pool is a scratch list, not a library; nothing is lost that a drag
    // can't rebuild, and refusing to load would strand the feature.
    return []
  }
}

async function saveActivityPool(ids: number[]): Promise<void> {
  const tmp = POOL_FILE() + '.tmp'
  await writeFile(tmp, JSON.stringify({ ids, updatedAt: new Date().toISOString() }, null, 2))
  await rename(tmp, POOL_FILE())
}

export function registerActivityPoolIpc(ipc: IpcRegistrar): void {
  ipc.handle('activity-pool-get', async () => {
    return { ok: true, ids: await loadActivityPool(), max: POOL_MAX }
  }, { public: true })

  ipc.handle('activity-pool-add', async (_e, candidates: PoolCandidate[]) => {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return { ok: false, error: 'Nothing to add.' }
    }
    const existing = await loadActivityPool()
    const r = mergeIntoPool(existing, candidates, (c) => isSkitOrIntro({
      id: Number(c.id), title: c.title, duration: c.duration, genre: c.genre,
      playCount: c.playCount, rating: c.rating,
    }))
    if (r.added > 0) await saveActivityPool(r.ids)
    console.log(`[activity-pool] +${r.added} (dupes ${r.dupes}, skits ${r.skits}, overflow ${r.overflow}) → ${r.ids.length}/${POOL_MAX}`)
    return { ok: true, ...r, max: POOL_MAX }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('activity-pool-remove', async (_e, ids: number[]) => {
    const next = removeFromPool(await loadActivityPool(), Array.isArray(ids) ? ids : [])
    await saveActivityPool(next)
    return { ok: true, ids: next }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('activity-pool-clear', async () => {
    await saveActivityPool([])
    return { ok: true, ids: [] as number[] }
  }, { refuse: REFUSED_SENDER })
}
