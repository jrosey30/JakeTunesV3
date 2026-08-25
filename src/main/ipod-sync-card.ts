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
import {
  IPOD_FIRMWARE_SCRATCH_NAMES,
  isIpodFirmwareScratchName,
  partitionLanded,
  type IntendedTrack,
} from './ipod-reconcile.ts'

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
  opts: { maxPasses: number; label?: string; isCancelled?: () => boolean } = { maxPasses: 4 },
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
      try {
        const dir = e.dstPath.substring(0, Math.max(e.dstPath.lastIndexOf('/'), e.dstPath.lastIndexOf('\\')))
        if (dir) await mkdir(dir, { recursive: true })
        await copyFile(e.localFile, e.dstPath)
        const conf = await confirmWriteOnCard(e.localFile, e.dstPath)
        if (!conf.ok) { console.warn(`ipod-card: recopy NOT confirmed for track ${id} — ${conf.reason}`); continue }
        recopied++
      } catch (err) {
        console.warn(`ipod-card: recopy failed for track ${id}:`, err)
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
 */
export async function retireIpodFirmwareScratch(mount: string): Promise<number> {
  const itunes = join(mount, 'iPod_Control', 'iTunes')
  const names = new Set<string>(IPOD_FIRMWARE_SCRATCH_NAMES)
  try {
    for (const n of await readdir(itunes)) {
      if (isIpodFirmwareScratchName(n)) names.add(n)
    }
  } catch { /* iTunes dir missing — nothing to retire */ }
  let retired = 0
  for (const name of names) {
    try {
      await unlink(join(itunes, name))
      retired++
    } catch { /* already absent */ }
  }
  console.log(`ipod-card: firmware scratch retired (${retired} file(s) gone) — Mini cannot merge Play Counts into this catalog`)
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
