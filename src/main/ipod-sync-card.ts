/**
 * Card I/O shared by activity sync and full-library sync.
 *
 * Confirm-on-write, remount-verify, and firmware scratch retirement.
 * Activity sync lives in ipod-activity-engine.ts; this file has no
 * catalog writer and no auto-repair.
 */

import { spawn } from 'child_process'
import { copyFile, mkdir, readdir, stat, unlink } from 'fs/promises'
import { join } from 'path'
import { fullFsync, remountVolume } from './platform.ts'
import { partitionLanded, type IntendedTrack } from './ipod-reconcile.ts'
import { ensureScratchArchived } from './ipod-plays-archive.ts'

export async function confirmWriteOnCard(src: string, dst: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    await fullFsync(dst)
    const [sSt, dSt] = await Promise.all([stat(src), stat(dst)])
    if (sSt.size !== dSt.size) return { ok: false, reason: `on-card size ${dSt.size} != source ${sSt.size}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export const flushCardCaches = (): Promise<void> => new Promise((resolve) => {
  try {
    const p = spawn('/bin/sync')
    p.on('close', () => resolve())
    p.on('error', () => resolve())
  } catch { resolve() }
})

export async function remountVerifyEntries(
  mountPoint: string,
  entries: Array<{ id: number; dstPath: string; localFile: string; expectedSize: number }>,
  opts: {
    maxPasses: number
    label?: string
    isCancelled?: () => boolean
    /** Restage a streamed master for a recopy, then delete it. Default is the local file. */
    prepareSource?: (entry: { id: number; localFile: string }) => Promise<{ abs: string; cleanup: () => Promise<void> }>
  } = { maxPasses: 4 },
): Promise<{ ok: boolean; landedIds: Set<number>; attempts: number; remountFailed: boolean }> {
  const landedIds = new Set<number>()
  if (entries.length === 0) return { ok: true, landedIds, attempts: 0, remountFailed: false }
  const intended: IntendedTrack[] = entries.map((e) => ({ id: e.id, expectedSize: e.expectedSize }))
  const byId = new Map(entries.map((e) => [e.id, e]))
  let attempts = 0
  let remountFailed = false
  for (let pass = 1; pass <= opts.maxPasses; pass++) {
    attempts = pass
    if (opts.isCancelled?.()) break
    const rm = await remountVolume(mountPoint)
    if (!rm.ok) {
      console.warn(`ipod-card: ${opts.label || 'verify'} remount failed (pass ${pass}): ${rm.error}`)
      remountFailed = true
      break
    }
    remountFailed = false
    const landedSizeById = new Map<number, number>()
    for (const e of entries) {
      try { landedSizeById.set(e.id, (await stat(e.dstPath)).size) } catch { /* missing */ }
    }
    const { landed, failed } = partitionLanded(intended, landedSizeById)
    landedIds.clear()
    for (const id of landed) landedIds.add(id)
    console.log(`ipod-card: ${opts.label || 'verify'} pass ${pass} — ${landed.length}/${entries.length} on card, ${failed.length} missing`)
    if (failed.length === 0) return { ok: true, landedIds, attempts, remountFailed: false }
    if (pass === opts.maxPasses) break
    if (opts.isCancelled?.()) break
    let recopied = 0
    for (const id of failed) {
      if (opts.isCancelled?.()) break
      const e = byId.get(id)
      if (!e) continue
      let release = async () => {}
      try {
        const prepared = opts.prepareSource
          ? await opts.prepareSource(e)
          : { abs: e.localFile, cleanup: async () => {} }
        release = prepared.cleanup
        const dir = e.dstPath.substring(0, Math.max(e.dstPath.lastIndexOf('/'), e.dstPath.lastIndexOf('\\')))
        if (dir) await mkdir(dir, { recursive: true })
        await copyFile(prepared.abs, e.dstPath)
        const conf = await confirmWriteOnCard(prepared.abs, e.dstPath)
        if (!conf.ok) { console.warn(`ipod-card: recopy NOT confirmed for track ${id} — ${conf.reason}`); continue }
        recopied++
      } catch (err) {
        console.warn(`ipod-card: recopy failed for track ${id}:`, err)
      } finally {
        await release()
      }
    }
    await flushCardCaches()
    console.log(`ipod-card: ${opts.label || 'verify'} pass ${pass} — recopied ${recopied} missing file(s)`)
  }
  return { ok: landedIds.size === entries.length, landedIds, attempts, remountFailed }
}

/**
 * iTunes/libgpod doctrine: after writing iTunesDB, Play Counts and OTG
 * must not be on the card when the Mini next boots. A leftover Play Counts
 * from a partial index is how a 500-row catalog became Songs 450.
 *
 * 2026-10-28: and nothing leaves the card without a copy. `keep.stateDir` is
 * the iPod's own state dir (resolveIpodState); ensureScratchArchived copies
 * the scratch files there first (or finds the pre-sync gate's copy of these
 * exact bytes). If the copy fails, NOTHING is deleted and this returns 0 —
 * it does not throw, because several callers sit inside spawn callbacks where
 * a throw would hang the sync. Plays outrank a tidy card: the pre-sync gate
 * already kept the pre-sync bytes, so this only bites if NEW bytes appear
 * mid-sync and this Mac can't write a copy.
 */
export async function retireIpodFirmwareScratch(
  mount: string,
  keep: { stateDir: string; reason: string },
): Promise<number> {
  const itunes = join(mount, 'iPod_Control', 'iTunes')
  let present: string[]
  let archiveDir: string | null
  try {
    ({ present, archiveDir } = await ensureScratchArchived(mount, keep.stateDir, keep.reason))
  } catch (err) {
    console.error(`ipod-card: NOT retiring firmware scratch — could not keep a copy first (${err instanceof Error ? err.message : err}); ${keep.reason}`)
    return 0
  }
  let retired = 0
  for (const name of present) {
    try {
      await unlink(join(itunes, name))
      retired++
    } catch { /* already absent */ }
  }
  if (retired > 0) {
    console.warn(`ipod-card: firmware scratch retired (${present.join(', ')}) — ${keep.reason}; copy kept in ${archiveDir}`)
  } else {
    console.log(`ipod-card: firmware scratch retired (0 file(s) gone) — ${keep.reason}`)
  }
  return retired
}

export async function listIpodMusicFiles(mount: string): Promise<string[]> {
  const musicRoot = join(mount, 'iPod_Control', 'Music')
  const found: string[] = []
  for (let i = 0; i < 50; i++) {
    const sub = join(musicRoot, `F${String(i).padStart(2, '0')}`)
    const entries = await readdir(sub).catch(() => [] as string[])
    for (const fn of entries) {
      if (fn === '.' || fn === '..') continue
      found.push(join(sub, fn))
    }
  }
  return found
}
