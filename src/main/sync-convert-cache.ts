/**
 * Looking after the sync-convert cache (Brief 265 Part 5): the folder in userData where the
 * iPod sync keeps its converted copies (AAC / MP3 mirrors, iPod-safe ALAC). Local only, never
 * the NAS, never the library; the masters are never touched.
 *
 *   • Leftover partials: a convert killed mid-way leaves `<hash>.m4a.partial.wav` /
 *     `.partial.m4a` / `.partial.mp3`. They are swept at startup (only ones older than ten
 *     minutes, and never while a sync runs).
 *   • A size cap with least-recently-used pruning. OFF until Jake sets a cap (Jake: never
 *     trim the convert cache without his yes; 2026-11-20 a trimmed cache made the punkPod
 *     re-convert 1,190 songs and the music popped). With no cap nothing is ever deleted.
 *   • Clear: empties the cache on request. Refused while a sync runs.
 *
 * "Used" is the access time, set on purpose by touchUsed() whenever a sync takes a cached
 * copy (macOS doesn't keep access times on its own). Since the landed record (Part 5), a
 * pruned or cleared cache never makes a song be copied again; only a song that has to be
 * copied has its copy made again.
 */
import { readdir, rm, stat, unlink, utimes, readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const SYNC_CONVERT_CACHE_SUBDIR = 'sync-convert-cache'
export const CACHE_SETTINGS_FILE = 'sync-convert-cache-settings.json'
export const PARTIAL_MIN_AGE_MS = 10 * 60 * 1000

const isPartial = (name: string): boolean => /\.partial\./.test(name)

export interface CacheFile { name: string; path: string; size: number; usedMs: number; mtimeMs: number }

export async function listCache(dir: string): Promise<CacheFile[]> {
  const names = await readdir(dir).catch((err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return [] as string[]; throw err })
  const out: CacheFile[] = []
  for (const name of names) {
    const path = join(dir, name)
    const st = await stat(path).catch(() => null)
    if (!st || !st.isFile()) continue
    out.push({ name, path, size: st.size, usedMs: Math.max(st.atimeMs, st.mtimeMs), mtimeMs: st.mtimeMs })
  }
  return out
}

/** A sync took this cached copy: mark it used now (its modified time, which freshness reads, stays). */
export async function touchUsed(path: string, now = new Date()): Promise<void> {
  const st = await stat(path).catch(() => null)
  if (!st) return
  await utimes(path, now, st.mtimeMs / 1000).catch((err) => console.warn('[sync-cache] mark used:', err instanceof Error ? err.message : err))
}

/** Delete leftover partials older than minAgeMs. Returns what was removed. Never while a sync runs. */
export async function sweepPartials(dir: string, opts: { now?: number; minAgeMs?: number; syncInFlight: () => boolean }): Promise<string[]> {
  if (opts.syncInFlight()) return []
  const now = opts.now ?? Date.now()
  const removed: string[] = []
  for (const f of await listCache(dir)) {
    if (!isPartial(f.name) || now - f.mtimeMs < (opts.minAgeMs ?? PARTIAL_MIN_AGE_MS)) continue
    try { await unlink(f.path); removed.push(f.name) } catch (err) { console.warn(`[sync-cache] could not remove ${f.name}:`, err instanceof Error ? err.message : err) }
  }
  return removed
}

/** Which files go to bring the cache under capBytes: least recently used first; partials are never picked. */
export function planPrune(files: readonly CacheFile[], capBytes: number): CacheFile[] {
  const whole = files.filter((f) => !isPartial(f.name))
  let total = whole.reduce((n, f) => n + f.size, 0)
  const out: CacheFile[] = []
  for (const f of [...whole].sort((a, b) => a.usedMs - b.usedMs || a.name.localeCompare(b.name))) {
    if (total <= capBytes) break
    out.push(f)
    total -= f.size
  }
  return out
}

export type PruneResult =
  | { pruned: false; why: 'no cap set' | 'a sync is running' | 'under the cap' }
  | { pruned: true; removed: number; freedBytes: number; leftBytes: number }

/** Prune to the cap. No cap (the default) = nothing is ever deleted. */
export async function pruneToCap(dir: string, capGb: number | null, opts: { syncInFlight: () => boolean }): Promise<PruneResult> {
  if (capGb === null || !(capGb > 0)) return { pruned: false, why: 'no cap set' }
  if (opts.syncInFlight()) return { pruned: false, why: 'a sync is running' }
  const files = await listCache(dir)
  const cap = capGb * 1e9
  const victims = planPrune(files, cap)
  if (victims.length === 0) return { pruned: false, why: 'under the cap' }
  let freed = 0
  let removed = 0
  for (const f of victims) {
    if (opts.syncInFlight()) break
    try { await unlink(f.path); freed += f.size; removed++ } catch (err) { console.warn(`[sync-cache] could not remove ${f.name}:`, err instanceof Error ? err.message : err) }
  }
  const total = files.filter((f) => !isPartial(f.name)).reduce((n, f) => n + f.size, 0)
  return { pruned: true, removed, freedBytes: freed, leftBytes: total - freed }
}

/** Empty the cache. Refused while a sync runs. */
export async function clearCache(dir: string, opts: { syncInFlight: () => boolean }): Promise<{ ok: true; removed: number; freedBytes: number } | { ok: false; error: string }> {
  if (opts.syncInFlight()) return { ok: false, error: 'An iPod sync is running. Clear the cache when it’s done.' }
  let removed = 0
  let freed = 0
  for (const f of await listCache(dir)) {
    // A sync that starts part-way through stops the clear: it may be reading these files.
    if (opts.syncInFlight()) return { ok: false, error: `An iPod sync started. ${removed} file(s) were cleared; clear again when it’s done.` }
    try { await rm(f.path, { force: true }); removed++; freed += f.size } catch (err) { console.warn(`[sync-cache] could not remove ${f.name}:`, err instanceof Error ? err.message : err) }
  }
  return { ok: true, removed, freedBytes: freed }
}

/** The cap in GB, or null (off: the default). */
export async function readCapGb(settingsFile: string): Promise<number | null> {
  try {
    const v = (JSON.parse(await readFile(settingsFile, 'utf-8')) as { capGb?: unknown }).capGb
    return typeof v === 'number' && v > 0 ? v : null
  } catch { return null }
}

export async function writeCapGb(settingsFile: string, capGb: number | null): Promise<void> {
  await mkdir(dirname(settingsFile), { recursive: true })
  const tmp = `${settingsFile}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify({ capGb: capGb && capGb > 0 ? capGb : null }), 'utf-8')
  await rename(tmp, settingsFile)
}

export interface CacheStatus { files: number; bytes: number; partials: number; capGb: number | null }

export async function cacheStatus(dir: string, settingsFile: string): Promise<CacheStatus> {
  const files = await listCache(dir)
  return {
    files: files.filter((f) => !isPartial(f.name)).length,
    bytes: files.reduce((n, f) => n + f.size, 0),
    partials: files.filter((f) => isPartial(f.name)).length,
    capGb: await readCapGb(settingsFile),
  }
}

/**
 * Brief 265's one approved deletion: the AAC mirrors ffmpeg made under the old
 * `afenc-cbr-44100-2-v3` key (the afconvert check never passed, so every one is ffmpeg's).
 * Nothing reads them since the key moved to v4. Told apart by what the file says about
 * itself: AAC in an .m4a whose encoder tag is ffmpeg's ("Lavf…"). An afconvert AAC carries
 * no encoder tag, an iPod-safe ALAC mirror is ALAC, an MP3 mirror is .mp3. Used only by
 * scripts/remove-ffmpeg-aac-mirrors.ts, a separate, logged step; nothing in the app calls it.
 */
export function isFfmpegAacMirror(name: string, probe: { codec?: string | null; encoder?: string | null }): boolean {
  if (!name.toLowerCase().endsWith('.m4a') || isPartial(name)) return false
  return (probe.codec ?? '').toLowerCase() === 'aac' && /^lavf/i.test((probe.encoder ?? '').trim())
}
