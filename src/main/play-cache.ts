/**
 * play-cache — the lossless transcode cache behind ipod-audio:// (6.0, the
 * "caches seam", 2026-09-02).
 *
 * Chromium can't decode ALAC. When the renderer asks for an ALAC source,
 * the protocol handler hands back a cached FLAC transcode instead; the ALAC
 * on disk is never touched (Jake wants lossless for iPod sync). This module
 * is the STATE OBJECT the handler is given — cache dir, in-flight
 * coalescing, codec probe cache, the 20 GB cap — extracted move-only from
 * the app.whenReady() closure in index.ts. Serving policy (homemini-first,
 * symlink refusal, containment) stays in the handler, where the
 * stream-playback-path locks can see it.
 *
 * ffprobe/ffmpeg are injectable so the coalescing, eviction and cap logic
 * are unit-tested for the first time (play-cache.test.ts). Defaults shell
 * out exactly as before.
 *
 * Cache file name = <pathHash>-<contentTag>.flac (play-cache-name.ts).
 * ⚠️ The content tag is the whole point. This used to be <pathHash>.m4a with
 * a freshness test of `cache.mtime >= source.mtime`, and that test is not an
 * identity check — mtime moves BACKWARD all the time (unzipped Bandcamp
 * archives, rsync -a, Finder copies, restores). Replacing a bad file with a
 * good one left the old entry looking "fresh" forever: an audit found 11
 * tracks whose cache disagreed with their source, two of them 30-second
 * previews standing in for full songs. Size+mtime as a TAG has no direction
 * to get wrong: any replacement changes the name, which misses the cache.
 */
import { join } from 'path'
import { mkdir, readdir, rename, stat, unlink } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { pathHashFor, playCacheName, isEntryFor } from './play-cache-name.ts'

const execP = promisify(execFile)

export interface PlayCacheDeps {
  /** Lower-cased codec name of the first audio stream, or null when the
   *  probe is unavailable (→ serve the raw file). Default: ffprobe. */
  probeCodec?: (src: string) => Promise<string | null>
  /** Write a lossless FLAC of `src` to `tmp` (atomic rename happens here). Default: ffmpeg. */
  transcode?: (src: string, tmp: string) => Promise<void>
  log?: (msg: string) => void
}

export interface PlayCacheOptions extends PlayCacheDeps {
  dir: string
  /** FLAC entries are ~3x the old AAC ones; a full-library lossless cache
   *  would be ~95 GB — the no-local-space rule caps it (parity with the
   *  AAC cache it replaced). Least-recently-touched entries fall off. */
  capBytes?: number
}

export const PLAY_CACHE_CAP_BYTES = 20 * 1024 * 1024 * 1024
const CACHE_EXT = (n: string): boolean => n.endsWith('.m4a') || n.endsWith('.flac')

async function defaultProbeCodec(src: string): Promise<string | null> {
  try {
    const { stdout } = await execP('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', src,
    ], { timeout: 5000 })
    return (stdout || '').trim().toLowerCase()
  } catch {
    return null  // ffprobe unavailable — fall through to raw file
  }
}

async function defaultTranscode(src: string, tmp: string): Promise<void> {
  // FLAC, not AAC (2026-08-06): the cache used to hand Chromium a lossy 256k
  // mirror of every ALAC file — the single biggest quality ceiling in the
  // whole playback path. FLAC decodes natively in Chromium and its decoded
  // PCM is bit-identical to the ALAC source (proved by MD5 of the decoded
  // streams). compression_level 0 encodes ~100x realtime at ~1.03x the ALAC
  // size, so a cache miss costs about a second.
  await execP('ffmpeg', [
    '-y', '-i', src, '-vn',
    '-c:a', 'flac', '-compression_level', '0',
    '-map_metadata', '0',
    tmp,
  ], { timeout: 300000 })
}

export interface PlayCache {
  readonly dir: string
  readonly capBytes: number
  ensureDir(): Promise<void>
  /** The cached lossless path for an ALAC source (transcoding on a miss,
   *  coalescing concurrent misses), or null when the source plays raw. */
  cachePathFor(src: string, srcMtime: number, srcSize: number): Promise<string | null>
  /** Background warm of newly-imported ALAC files, 4 workers, stops at the cap. */
  prewarm(paths: string[]): Promise<void>
  /** Seed the codec probe cache for a file we just wrote (skips ffprobe on first play). */
  registerKnownCodec(path: string, mtime: number, codec: string): void
  /** The entry name a source WOULD have — the maintenance IPCs count cache
   *  hits with the same naming rule the cache writes with ("or the count lies"). */
  entryFor(src: string, size: number, mtimeMs: number): { pathHash: string; file: string }
  /** Test/inspection hooks. */
  inflightCount(): number
}

export function createPlayCache(opts: PlayCacheOptions): PlayCache {
  const dir = opts.dir
  const capBytes = opts.capBytes ?? PLAY_CACHE_CAP_BYTES
  const probeCodec = opts.probeCodec ?? defaultProbeCodec
  const transcode = opts.transcode ?? defaultTranscode
  const log = opts.log ?? ((m: string) => console.log(m))

  // In-flight transcodes, to coalesce concurrent range requests for the
  // same source file into a single ffmpeg pass.
  const transcodeInFlight = new Map<string, Promise<string>>()
  // Codec-detection cache. ffprobe is ~200-500ms per call; running it on
  // every play — even for AAC files that don't need any transcode — made
  // first-play latency user-visible. Keyed by source path with the mtime
  // at the time we probed, so the entry is invalidated if the file changes.
  const codecCache = new Map<string, { mtime: number; codec: string }>()

  function cacheNameFor(src: string, size: number, mtimeMs: number): { pathHash: string; file: string } {
    return { pathHash: pathHashFor(src), file: join(dir, playCacheName(src, size, mtimeMs)) }
  }

  // Drop every other cache entry for this source. Because the name encodes
  // content, a superseded file is dead weight the moment we transcode a new
  // one — without this the cache would grow one entry per edit, forever.
  async function evictOtherCacheEntries(pathHash: string, keep: string): Promise<void> {
    try {
      for (const name of await readdir(dir)) {
        if (!isEntryFor(name, pathHash)) continue
        const full = join(dir, name)
        if (full === keep) continue
        await unlink(full).catch(() => {})
      }
    } catch { /* cache dir unreadable — nothing to evict */ }
  }

  let enforcingCap = false
  async function enforceCacheCap(justWritten: string): Promise<void> {
    if (enforcingCap) return
    enforcingCap = true
    try {
      const names = await readdir(dir)
      const entries: Array<{ p: string; size: number; at: number }> = []
      let total = 0
      for (const n of names) {
        if (!CACHE_EXT(n)) continue
        const p = join(dir, n)
        try {
          const st = await stat(p)
          entries.push({ p, size: st.size, at: st.atimeMs || st.mtimeMs })
          total += st.size
        } catch { /* raced a delete */ }
      }
      if (total <= capBytes) return
      entries.sort((a, b) => a.at - b.at)
      for (const e of entries) {
        if (total <= capBytes) break
        if (e.p === justWritten) continue
        try { await unlink(e.p); total -= e.size } catch { /* already gone */ }
      }
    } catch { /* cap enforcement must never break playback */ } finally {
      enforcingCap = false
    }
  }

  async function cachePathFor(src: string, srcMtime: number, srcSize: number): Promise<string | null> {
    let codec = ''
    const prev = codecCache.get(src)
    if (prev && prev.mtime === srcMtime) {
      codec = prev.codec
    } else {
      const probed = await probeCodec(src)
      if (probed == null) return null
      codec = probed
      codecCache.set(src, { mtime: srcMtime, codec })
    }
    if (codec !== 'alac') return null  // AAC and others play fine raw

    const { pathHash, file: cached } = cacheNameFor(src, srcSize, srcMtime)
    try {
      const cStat = await stat(cached)
      // Name match IS the freshness proof. Size guard only rejects the
      // empty file a crashed transcode can leave behind.
      if (cStat.size > 0) return cached
    } catch { /* not cached yet */ }

    // NOTE: pre-FLAC entries (.m4a, lossy AAC-256) are deliberately NOT
    // adopted — a lossy mirror must not masquerade as the lossless cache.
    // They are swept by evictOtherCacheEntries when the FLAC lands.

    // Need to transcode. Dedupe concurrent requests.
    const existing = transcodeInFlight.get(src)
    if (existing) return existing

    const p = (async () => {
      // Atomic write: transcode → tmp file → rename into place. Without this
      // a killed ffmpeg (app quit mid-transcode, OS reap) leaves a partial
      // file at `cached` that would be served as a truncated song. rename()
      // guarantees the final path is either complete or absent.
      const tmp = cached + '.partial.flac'
      try {
        await transcode(src, tmp)
        await rename(tmp, cached)
        await evictOtherCacheEntries(pathHash, cached)
        void enforceCacheCap(cached)
        return cached
      } catch (err) {
        try { await unlink(tmp) } catch { /* already gone */ }
        throw err
      } finally {
        transcodeInFlight.delete(src)
      }
    })()
    transcodeInFlight.set(src, p)
    return p
  }

  // CRITICAL: cap concurrency at 4. The original implementation fired every
  // file in the loop — 800 simultaneous ffmpeg processes on a fresh install,
  // every core pegged, and the on-demand transcode for the song the user
  // just hit play on queued behind 799 background jobs.
  async function prewarm(paths: string[]): Promise<void> {
    const CONCURRENCY = 4
    // With the cap, warming past it is pure churn — each new entry would
    // evict another. Warm until full, then stop and say so.
    let capReached = false
    const atCap = async (): Promise<boolean> => {
      try {
        let total = 0
        for (const n of await readdir(dir)) {
          if (!CACHE_EXT(n)) continue
          try { total += (await stat(join(dir, n))).size } catch { /* raced */ }
        }
        return total >= capBytes
      } catch { return false }
    }
    let i = 0
    const worker = async (): Promise<void> => {
      while (i < paths.length) {
        if (capReached) return
        const idx = i++
        // Re-check the cap every 25 files — cheap, and bounds the overshoot.
        if (idx % 25 === 0 && await atCap()) {
          capReached = true
          log(`[play-cache] prewarm stopped at the ${(capBytes / 1e9).toFixed(0)} GB cap — hot set is warm, cold tracks transcode on first play`)
          return
        }
        const p = paths[idx]
        try {
          const s = await stat(p)
          await cachePathFor(p, s.mtimeMs, s.size).catch(() => {})
        } catch { /* file missing — skip */ }
      }
    }
    const workers: Promise<void>[] = []
    for (let w = 0; w < CONCURRENCY; w++) workers.push(worker())
    await Promise.all(workers)
  }

  return {
    dir,
    capBytes,
    ensureDir: async () => { await mkdir(dir, { recursive: true }).catch(() => {}) },
    cachePathFor,
    prewarm,
    registerKnownCodec: (path, mtime, codec) => { codecCache.set(path, { mtime, codec }) },
    entryFor: cacheNameFor,
    inflightCount: () => transcodeInFlight.size,
  }
}
