/**
 * Activity Pool IPC — persistence + handlers for the hand-built sync pool.
 *
 * Store: userData/activity-pool.json → { ids: number[], names, updatedAt }.
 * `names` (id → { t, a }) is the pool's own memory of what was dropped, so
 * a song that later leaves the library (removed, re-added under a new id)
 * can still be named on the pool page and matched to its new copy
 * (2026-09-19: seven of Jake's 1,000 had vanished into "992" silently).
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
import { swapInPool, type PoolName } from '../../common/pool-health.ts'
import { isSkitOrIntro } from '../workout-sync.ts'

const POOL_FILE = () => join(app.getPath('userData'), 'activity-pool.json')
const LEDGER_FILE = () => join(app.getPath('userData'), 'activity-sync-ledger.jsonl')

interface PoolFile { ids: number[]; names: Record<string, PoolName> }

async function loadPoolFile(): Promise<PoolFile> {
  try {
    const parsed = JSON.parse(await readFile(POOL_FILE(), 'utf-8')) as { ids?: unknown; names?: unknown }
    const ids = Array.isArray(parsed?.ids) ? parsed.ids.map(Number).filter((n) => Number.isFinite(n)) : []
    const names: Record<string, PoolName> = {}
    if (parsed?.names && typeof parsed.names === 'object') {
      for (const [k, v] of Object.entries(parsed.names as Record<string, { t?: unknown; a?: unknown }>)) {
        if (v && typeof v === 'object') names[k] = { t: String(v.t ?? ''), a: String(v.a ?? '') }
      }
    }
    return { ids, names }
  } catch {
    // Missing file = empty pool. A torn file also reads as empty — the
    // pool is a scratch list, not a library; nothing is lost that a drag
    // can't rebuild, and refusing to load would strand the feature.
    return { ids: [], names: {} }
  }
}

export async function loadActivityPool(): Promise<number[]> {
  return (await loadPoolFile()).ids
}

async function saveActivityPool(ids: number[], names: Record<string, PoolName>): Promise<void> {
  // Keep names only for ids still pooled — the file never grows unbounded.
  const keep: Record<string, PoolName> = {}
  for (const id of ids) { const n = names[String(id)]; if (n) keep[String(id)] = n }
  const tmp = POOL_FILE() + '.tmp'
  await writeFile(tmp, JSON.stringify({ ids, names: keep, updatedAt: new Date().toISOString() }, null, 2))
  await rename(tmp, POOL_FILE())
}

/** Ids pooled before names existed: their titles live in the sync ledger's
 *  `picked` rows (every Activity Sync writes one). One read, best-effort. */
async function backfillNamesFromLedger(ids: number[], names: Record<string, PoolName>): Promise<boolean> {
  const missing = ids.filter((id) => !names[String(id)])
  if (missing.length === 0) return false
  let raw = ''
  try { raw = await readFile(LEDGER_FILE(), 'utf-8') } catch { return false }
  const want = new Set(missing)
  let changed = false
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let e: { kind?: string; picked?: Array<{ id?: number; t?: string; a?: string }> }
    try { e = JSON.parse(line) } catch { continue }
    if (e.kind !== 'picks' || !Array.isArray(e.picked)) continue
    for (const p of e.picked) {
      const id = Number(p?.id)
      if (want.has(id) && !names[String(id)]) { names[String(id)] = { t: String(p.t ?? ''), a: String(p.a ?? '') }; changed = true }
    }
  }
  return changed
}

export function registerActivityPoolIpc(ipc: IpcRegistrar): void {
  ipc.handle('activity-pool-get', async () => {
    const file = await loadPoolFile()
    if (await backfillNamesFromLedger(file.ids, file.names)) await saveActivityPool(file.ids, file.names)
    return { ok: true, ids: file.ids, names: file.names, max: POOL_MAX }
  }, { public: true })

  // Swap a dead id for its re-added copy, in place — the pool page's
  // "Use the new copy". Order is the pool's order; it is preserved.
  ipc.handle('activity-pool-swap', async (_e, args: { oldId: number; newId: number; name?: PoolName }) => {
    const oldId = Number(args?.oldId)
    const newId = Number(args?.newId)
    if (!Number.isFinite(oldId) || !Number.isFinite(newId)) return { ok: false, error: 'Bad ids.' }
    const file = await loadPoolFile()
    const next = swapInPool(file.ids, oldId, newId)
    if (next === file.ids) return { ok: false, error: 'That song is not in the pool, or the new copy already is.' }
    const names = { ...file.names }
    names[String(newId)] = args?.name && typeof args.name === 'object' ? { t: String(args.name.t ?? ''), a: String(args.name.a ?? '') } : (names[String(oldId)] ?? { t: '', a: '' })
    delete names[String(oldId)]
    await saveActivityPool(next, names)
    return { ok: true, ids: next, names }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('activity-pool-add', async (_e, candidates: PoolCandidate[]) => {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return { ok: false, error: 'Nothing to add.' }
    }
    const file = await loadPoolFile()
    const r = mergeIntoPool(file.ids, candidates, (c) => isSkitOrIntro({
      id: Number(c.id), title: c.title, duration: c.duration, genre: c.genre,
      playCount: c.playCount, rating: c.rating,
    }))
    const names = { ...file.names }
    for (const c of candidates) {
      const id = Number(c?.id)
      if (Number.isFinite(id) && r.ids.includes(id)) names[String(id)] = { t: String(c.title ?? ''), a: String(c.artist ?? '') }
    }
    if (r.added > 0) await saveActivityPool(r.ids, names)
    console.log(`[activity-pool] +${r.added} (dupes ${r.dupes}, skits ${r.skits}, overflow ${r.overflow}) → ${r.ids.length}/${POOL_MAX}`)
    return { ok: true, ...r, names, max: POOL_MAX }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('activity-pool-remove', async (_e, ids: number[]) => {
    const file = await loadPoolFile()
    const next = removeFromPool(file.ids, Array.isArray(ids) ? ids : [])
    await saveActivityPool(next, file.names)
    return { ok: true, ids: next }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('activity-pool-clear', async () => {
    await saveActivityPool([], {})
    return { ok: true, ids: [] as number[] }
  }, { refuse: REFUSED_SENDER })
}
