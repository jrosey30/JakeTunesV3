/**
 * Homemini bytes for a copy that cannot follow a library symlink.
 *
 * Playback talks to homemini. The Mini cannot. Pass-through leaves a
 * symlink (or nothing) where a real file used to be. Two callers:
 *
 *   - Pin / Download / a cassette dub wants the bytes to STAY in the
 *     library path. materializeTrackFromHomemini does that, over HTTP,
 *     never SMB. It refuses when the write would leave less than
 *     MATERIALIZE_FREE_FLOOR_BYTES free.
 *   - iPod sync must not do that. A full-library pull of lossless
 *     masters would fill the laptop, and nothing re-streams the file
 *     until the next boot. stageTrackForSync writes ONE song into a
 *     temp directory. The caller deletes it after the iPod copy. The
 *     library symlink is never replaced.
 */

import { createHash } from 'crypto'
import { dirname, join } from 'path'
import { colonPathToAbs, type LstatLike } from './activity-boardable.ts'

/** Leave at least this much free on the laptop. A sync that cannot is skipped. */
export const MATERIALIZE_FREE_FLOOR_BYTES = 10 * 1024 * 1024 * 1024

export function diskWriteWouldBreachFloor(
  freeBytes: number,
  incomingBytes: number,
  floor = MATERIALIZE_FREE_FLOOR_BYTES,
): boolean {
  if (!Number.isFinite(freeBytes)) return true
  return freeBytes - Math.max(0, incomingBytes) < floor
}

export function formatFreeSpaceRefuse(freeBytes: number, floor = MATERIALIZE_FREE_FLOOR_BYTES): string {
  const gb = (n: number) => (n / (1024 * 1024 * 1024)).toFixed(1)
  const free = Number.isFinite(freeBytes) ? Math.max(0, freeBytes) : 0
  return `free disk would drop below ${gb(floor)} GB (${gb(free)} GB free)`
}

export interface MaterializeFetchResult {
  ok: boolean
  status: number
  buffer: Buffer
}

export interface MaterializeTrackOpts {
  colonPath: string
  trackId: number | string
  localMount: string
  pathSep: string
  homeminiAudioBase: string
  lstat: LstatLike
  mkdir: (p: string, o: { recursive: true }) => Promise<unknown>
  writeFile: (p: string, buf: Buffer) => Promise<unknown>
  rename: (a: string, b: string) => Promise<unknown>
  unlink: (p: string) => Promise<unknown>
  fetchAudio: (url: string) => Promise<MaterializeFetchResult>
  /** When set, a write that would pass the floor is refused and nothing is written. */
  freeBytes?: () => Promise<number>
}

export type MaterializeTrackResult =
  | { ok: true; abs: string; pulled: boolean }
  | { ok: false; error: string }

export interface StageTrackOpts extends MaterializeTrackOpts {
  stageDir: string
}

export type StageCleanup = () => Promise<void>

export type StageTrackResult =
  | { ok: true; abs: string; staged: boolean; pulled: boolean; cleanup: StageCleanup }
  | { ok: false; error: string; reason: 'free-space' | 'fetch' | 'write' | 'path' }

const noopCleanup: StageCleanup = async () => {}

function audioUrl(base: string, trackId: number | string): string {
  return `${base.replace(/\/$/, '')}/${encodeURIComponent(String(trackId))}`
}

async function refuseIfFloor(opts: MaterializeTrackOpts, incoming: number): Promise<string | null> {
  if (!opts.freeBytes) return null
  let free = 0
  try {
    free = await opts.freeBytes()
  } catch (err) {
    return err instanceof Error ? err.message : 'free-space check failed'
  }
  if (diskWriteWouldBreachFloor(free, incoming)) return formatFreeSpaceRefuse(free)
  return null
}

async function fetchHomemini(opts: MaterializeTrackOpts): Promise<
  | { ok: true; buffer: Buffer }
  | { ok: false; error: string }
> {
  const url = audioUrl(opts.homeminiAudioBase, opts.trackId)
  let audio: MaterializeFetchResult
  try {
    audio = await opts.fetchAudio(url)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'homemini fetch failed' }
  }
  if (!audio.ok && audio.status !== 200 && audio.status !== 206) {
    return { ok: false, error: `homemini ${audio.status}` }
  }
  if (!audio.buffer || audio.buffer.length <= 0) {
    return { ok: false, error: 'homemini returned no bytes' }
  }
  return { ok: true, buffer: audio.buffer }
}

export async function materializeTrackFromHomemini(opts: MaterializeTrackOpts): Promise<MaterializeTrackResult> {
  const colon = String(opts.colonPath || '').trim()
  if (!colon) return { ok: false, error: 'no path' }
  const abs = colonPathToAbs(colon, opts.localMount, opts.pathSep)
  try {
    const st = await opts.lstat(abs)
    if (!st.isSymbolicLink() && st.isFile()) return { ok: true, abs, pulled: false }
  } catch {
    /* evicted or never staged — pull */
  }
  const early = await refuseIfFloor(opts, 0)
  if (early) return { ok: false, error: early }
  const audio = await fetchHomemini(opts)
  if (!audio.ok) return audio
  const late = await refuseIfFloor(opts, audio.buffer.length)
  if (late) return { ok: false, error: late }
  const tmp = `${abs}.dl.tmp`
  try {
    await opts.mkdir(dirname(abs), { recursive: true })
    try { await opts.unlink(tmp) } catch { /* no stale tmp */ }
    await opts.writeFile(tmp, audio.buffer)
    await opts.rename(tmp, abs)
  } catch (err) {
    try { await opts.unlink(tmp) } catch { /* tmp may not exist */ }
    return { ok: false, error: err instanceof Error ? err.message : 'failed to write pulled file' }
  }
  return { ok: true, abs, pulled: true }
}

function stageFileName(trackId: number | string, colon: string): string {
  const h = createHash('sha1').update(colon).digest('hex').slice(0, 8)
  const ext = colon.slice(colon.lastIndexOf('.'))
  const safeExt = /^\.[A-Za-z0-9]{1,5}$/.test(ext) ? ext : '.bin'
  return `${String(trackId)}-${h}${safeExt}`
}

/**
 * Bytes for one iPod copy. A real library file is returned as-is.
 * A symlink or a missing file is downloaded into stageDir. cleanup
 * deletes that temp file and nothing else.
 */
export async function stageTrackForSync(opts: StageTrackOpts): Promise<StageTrackResult> {
  const colon = String(opts.colonPath || '').trim()
  if (!colon) return { ok: false, error: 'no path', reason: 'path' }
  if (!opts.stageDir) return { ok: false, error: 'no stage dir', reason: 'path' }
  const abs = colonPathToAbs(colon, opts.localMount, opts.pathSep)
  try {
    const st = await opts.lstat(abs)
    if (!st.isSymbolicLink() && st.isFile()) {
      return { ok: true, abs, staged: false, pulled: false, cleanup: noopCleanup }
    }
  } catch {
    /* evicted — stage a copy, do not create a library file */
  }
  const early = await refuseIfFloor(opts, 0)
  if (early) return { ok: false, error: early, reason: 'free-space' }
  const audio = await fetchHomemini(opts)
  if (!audio.ok) return { ok: false, error: audio.error, reason: 'fetch' }
  const late = await refuseIfFloor(opts, audio.buffer.length)
  if (late) return { ok: false, error: late, reason: 'free-space' }
  const dest = join(opts.stageDir, stageFileName(opts.trackId, colon))
  const tmp = `${dest}.tmp`
  try {
    await opts.mkdir(opts.stageDir, { recursive: true })
    try { await opts.unlink(tmp) } catch { /* no stale tmp */ }
    await opts.writeFile(tmp, audio.buffer)
    await opts.rename(tmp, dest)
  } catch (err) {
    try { await opts.unlink(tmp) } catch { /* tmp may not exist */ }
    return { ok: false, error: err instanceof Error ? err.message : 'failed to write staged file', reason: 'write' }
  }
  return {
    ok: true,
    abs: dest,
    staged: true,
    pulled: true,
    cleanup: async () => {
      try { await opts.unlink(dest) } catch (err) {
        console.warn(`[sync-stage] cleanup failed for ${dest}:`, err instanceof Error ? err.message : err)
      }
    },
  }
}

export async function probeHomeminiAudio(opts: {
  trackId: number | string
  homeminiAudioBase: string
  probe: (url: string) => Promise<{ ok: boolean; status: number; bytes?: number }>
}): Promise<{ ok: true; bytes: number } | { ok: false; error: string }> {
  const url = audioUrl(opts.homeminiAudioBase, opts.trackId)
  try {
    const r = await opts.probe(url)
    if (r.ok || r.status === 200 || r.status === 206) {
      return { ok: true, bytes: Number(r.bytes) > 0 ? Number(r.bytes) : 0 }
    }
    return { ok: false, error: `homemini ${r.status}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'homemini probe failed' }
  }
}
