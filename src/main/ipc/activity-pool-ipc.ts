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
import { dirname, join } from 'path'
import { mkdir, readFile, writeFile, rename } from 'fs/promises'
import { app } from 'electron'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { blockedByOtherIpods, mergeIntoPool, removeFromPool, POOL_MAX, type OtherIpodPool, type PoolCandidate } from '../activity-pool.ts'
import { swapInPool, type PoolName } from '../../common/pool-health.ts'
import { ORIGINAL_DEFAULTS, type IpodDeviceMarker } from '../../common/ipod-identity.ts'
import { loadIpodRegistry, poolFileFor } from '../ipod-identity.ts'
import { isSkitOrIntro } from '../workout-sync.ts'
import { createHubPoolMirror } from '../hub-pool-mirror.ts'

/** A replica (workmini) shows the MacBook's pool read-only; it never edits one. */
const REPLICA_READ_ONLY = 'The iPod Pool is edited on the MacBook — this Mac only shows it.'

const STATE_DIR = () => app.getPath('userData')
const LEDGER_FILE = () => join(STATE_DIR(), 'activity-sync-ledger.jsonl')

/**
 * ONE POOL PER iPOD (step 2, 2026-10-27; step 1 = ipod-identity.ts). The pool being edited
 * is the plugged-in iPod's. null = the Original's: its pool is the legacy root file, and it
 * is also what you see and edit with no iPod plugged in (or an iPod JakeTunes doesn't know).
 * Any other known iPod has its own file under ipod-pools/<id>/, and NO SONG RIDES TWO iPODS:
 * a drop is checked against every other iPod's pool (blockedByOtherIpods) before the merge.
 */
type PoolOwner = IpodDeviceMarker | null

interface PoolFile { ids: number[]; names: Record<string, PoolName> }

async function loadPoolFile(owner: PoolOwner): Promise<PoolFile> {
  try {
    const parsed = JSON.parse(await readFile(poolFileFor(STATE_DIR(), owner), 'utf-8')) as { ids?: unknown; names?: unknown }
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

/** The Original's pool (the legacy file) — what the sync script ships and the phone mirrors. */
export async function loadActivityPool(): Promise<number[]> {
  return (await loadPoolFile(null)).ids
}

async function saveActivityPool(owner: PoolOwner, ids: number[], names: Record<string, PoolName>): Promise<void> {
  // Keep names only for ids still pooled — the file never grows unbounded.
  const keep: Record<string, PoolName> = {}
  for (const id of ids) { const n = names[String(id)]; if (n) keep[String(id)] = n }
  const path = poolFileFor(STATE_DIR(), owner)
  if (owner) await mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  await writeFile(tmp, JSON.stringify({ ids, names: keep, updatedAt: new Date().toISOString() }, null, 2))
  await rename(tmp, path)
}

/** Every OTHER registered iPod's pool, for the no-overlap gate. */
async function otherIpodPools(owner: PoolOwner): Promise<OtherIpodPool[]> {
  const reg = await loadIpodRegistry(STATE_DIR())
  const out: OtherIpodPool[] = []
  for (const d of reg.devices) {
    if (owner ? d.id === owner.id : d.primary) continue
    const f = await loadPoolFile(d.primary ? null : d)
    if (f.ids.length) out.push({ name: d.name, ids: f.ids })
  }
  return out
}

/** Whose pool this is, for the page header and the notices. */
function ownerOut(owner: PoolOwner): { id: string | null; name: string; primary: boolean } {
  return owner ? { id: owner.id, name: owner.name, primary: false } : { id: null, name: ORIGINAL_DEFAULTS.name, primary: true }
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

export function registerActivityPoolIpc(
  ipc: IpcRegistrar,
  opts: {
    hubBase?: () => Promise<string | null>
    /** The plugged-in iPod, when JakeTunes knows it (index.ts: the detected mount → identifyIpod). */
    currentIpod?: () => Promise<IpodDeviceMarker | null>
  } = {},
): void {
  // Replica mode: the pool comes from the hub (homemini), read-only. The local
  // activity-pool.json is never read or written there. Twin of the phone's
  // built-in "iPod Pool" playlist (see common/hub-pool.ts).
  const hub = createHubPoolMirror({ stateDir: app.getPath('userData'), hubBase: opts.hubBase ?? (async () => null) })
  const replicaIds = (): Promise<number[] | null> => hub.get()
  // The Original's pool (null) unless another known iPod is plugged in.
  const currentOwner = async (): Promise<PoolOwner> => {
    try {
      const d = await opts.currentIpod?.()
      return d && !d.primary ? d : null
    } catch {
      return null
    }
  }

  ipc.handle('activity-pool-get', async () => {
    const hubIds = await replicaIds()
    if (hubIds) return { ok: true, ids: hubIds, names: {} as Record<string, PoolName>, max: POOL_MAX, readOnly: true, device: ownerOut(null) }
    const owner = await currentOwner()
    const file = await loadPoolFile(owner)
    // The Original's ledger names its pool's early drops; another iPod has no ledger yet.
    if (!owner && await backfillNamesFromLedger(file.ids, file.names)) await saveActivityPool(owner, file.ids, file.names)
    return { ok: true, ids: file.ids, names: file.names, max: POOL_MAX, device: ownerOut(owner) }
  }, { public: true })

  // Swap a dead id for its re-added copy, in place — the pool page's
  // "Use the new copy". Order is the pool's order; it is preserved.
  ipc.handle('activity-pool-swap', async (_e, args: { oldId: number; newId: number; name?: PoolName }) => {
    if (await replicaIds()) return { ok: false, error: REPLICA_READ_ONLY }
    const oldId = Number(args?.oldId)
    const newId = Number(args?.newId)
    if (!Number.isFinite(oldId) || !Number.isFinite(newId)) return { ok: false, error: 'Bad ids.' }
    const owner = await currentOwner()
    const gate = blockedByOtherIpods([{ id: newId }], await otherIpodPools(owner))
    if (gate.blocked.length) return { ok: false, error: `That song is on ${gate.blocked[0]!.by} — no song rides two iPods.` }
    const file = await loadPoolFile(owner)
    const next = swapInPool(file.ids, oldId, newId)
    if (next === file.ids) return { ok: false, error: 'That song is not in the pool, or the new copy already is.' }
    const names = { ...file.names }
    names[String(newId)] = args?.name && typeof args.name === 'object' ? { t: String(args.name.t ?? ''), a: String(args.name.a ?? '') } : (names[String(oldId)] ?? { t: '', a: '' })
    delete names[String(oldId)]
    await saveActivityPool(owner, next, names)
    return { ok: true, ids: next, names }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('activity-pool-add', async (_e, candidates: PoolCandidate[]) => {
    if (await replicaIds()) return { ok: false, error: REPLICA_READ_ONLY }
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return { ok: false, error: 'Nothing to add.' }
    }
    const owner = await currentOwner()
    // No song rides two iPods: whatever already lives on another iPod's pool stays there.
    const gate = blockedByOtherIpods(candidates, await otherIpodPools(owner))
    const file = await loadPoolFile(owner)
    const r = mergeIntoPool(file.ids, gate.allowed, (c) => isSkitOrIntro({
      id: Number(c.id), title: c.title, duration: c.duration, genre: c.genre,
      playCount: c.playCount, rating: c.rating,
    }))
    const names = { ...file.names }
    for (const id of r.rolledOffIds) delete names[String(id)]
    const pooled = new Set(r.ids)
    for (const c of gate.allowed) {
      const id = Number(c?.id)
      if (Number.isFinite(id) && pooled.has(id)) names[String(id)] = { t: String(c.title ?? ''), a: String(c.artist ?? '') }
    }
    if (r.added > 0 || r.rolledOff > 0) await saveActivityPool(owner, r.ids, names)
    console.log(`[activity-pool] ${ownerOut(owner).name}: +${r.added} (dupes ${r.dupes}, skits ${r.skits}, on another iPod ${gate.blocked.length}, rolled off ${r.rolledOff}, overflow ${r.overflow}) → ${r.ids.length}/${POOL_MAX}`)
    return { ok: true, ...r, names, max: POOL_MAX, blocked: gate.blocked, device: ownerOut(owner) }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('activity-pool-remove', async (_e, ids: number[]) => {
    if (await replicaIds()) return { ok: false, error: REPLICA_READ_ONLY }
    const owner = await currentOwner()
    const file = await loadPoolFile(owner)
    const next = removeFromPool(file.ids, Array.isArray(ids) ? ids : [])
    await saveActivityPool(owner, next, file.names)
    return { ok: true, ids: next }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('activity-pool-clear', async () => {
    if (await replicaIds()) return { ok: false, error: REPLICA_READ_ONLY }
    await saveActivityPool(await currentOwner(), [], {})
    return { ok: true, ids: [] as number[] }
  }, { refuse: REFUSED_SENDER })
}
