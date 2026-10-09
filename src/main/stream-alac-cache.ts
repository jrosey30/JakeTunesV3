/**
 * Laptop decode cache for streamed ALAC.
 *
 * Chromium cannot decode ALAC. Homemini is not asked to transcode it:
 * `?fmt=flac` is a JakeTunesMobile backend behavior, and that repo is not
 * changed here. The protocol handler downloads the raw master
 * (`/audio/:id`, no format query) and ffmpeg-decodes it to FLAC on this
 * machine. FLAC is what the existing play-cache already hands Chromium,
 * and its PCM matches the ALAC.
 *
 * The cache is capped (default 2 GB) and evicts least-recently-touched
 * files. It must not grow with the library. A playing track is touched
 * on every serve so a new decode does not evict it.
 *
 * Seeking and gapless, before the decode finishes:
 * a Range request waits on the single in-flight decode, then is served
 * from the completed FLAC. A partial file is never returned — FLAC's
 * seek table is only valid once ffmpeg exits, and swapping containers
 * mid-play is the crackle the serve-pin exists to prevent. The player's
 * Range (including a seek that arrived during the wait) is applied to
 * the finished file, so the offset is a real PCM position, not a guess
 * into a growing encode. Once the FLAC is on disk, later ranges and the
 * next gapless handoff are local reads with Content-Range and a known
 * length, the same as the play-cache.
 *
 * ffmpeg is the PATH binary (`ffmpeg`), not a file bundled in the app.
 * On a Mac that is whichever ffmpeg is on PATH (typically Homebrew).
 */
import { createReadStream, createWriteStream } from 'fs'
import { mkdir, rename, stat, unlink, readdir, utimes } from 'fs/promises'
import { join } from 'path'
import { Readable } from 'stream'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execP = promisify(execFile)

/** 2 GB. A hi-res FLAC is large; the cap is what keeps the laptop from
 *  becoming a second copy of the library. */
export const STREAM_ALAC_CACHE_CAP_BYTES = 2 * 1024 * 1024 * 1024

export interface StreamAlacCacheDeps {
  dir: string
  capBytes?: number
  /** Write the raw ALAC master for this track id to `dest`. */
  fetchRaw: (trackId: string, dest: string) => Promise<void>
  /** Decode that ALAC to a complete FLAC at `tmp`. */
  transcode: (src: string, tmp: string) => Promise<void>
  log?: (msg: string) => void
}

export interface StreamAlacCache {
  readonly dir: string
  readonly capBytes: number
  ensureDir(): Promise<void>
  /** Completed FLAC path. Concurrent callers share one decode. */
  ensure(trackId: string | number): Promise<string>
  /** Range (or whole-file) response. Waits out an in-flight decode. */
  serve(trackId: string | number, rangeHeader: string | null): Promise<Response>
  inflightCount(): number
}

function safeId(trackId: string | number): string {
  const id = String(trackId).replace(/[^a-zA-Z0-9._-]/g, '_')
  if (!id) throw new Error('stream-alac-cache: empty track id')
  return id
}

/** Download a URL to `dest`. Used for the raw homemini ALAC master. */
export async function downloadUrlToFile(
  url: string,
  dest: string,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(10 * 60_000) })
  if ((!res.ok && res.status !== 206) || !res.body) {
    throw new Error(`alac fetch ${res.status}`)
  }
  const out = createWriteStream(dest)
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(res.body as never).pipe(out).on('finish', resolve).on('error', reject)
  })
  const st = await stat(dest)
  if (st.size <= 0) throw new Error('alac fetch wrote no bytes')
}

/** PATH `ffmpeg` → FLAC, same args as the play-cache (bit-exact PCM). */
export async function ffmpegAlacToFlac(src: string, tmp: string): Promise<void> {
  await execP('ffmpeg', [
    '-y', '-i', src, '-vn',
    '-c:a', 'flac', '-compression_level', '0',
    '-map_metadata', '0',
    tmp,
  ], { timeout: 300000 })
}

/**
 * True when this path is a streamed symlink, missing, or not a regular
 * file. lstat does not follow the link, so a NAS target is never touched.
 * A real local ALAC (not yet stream-converted) returns false — the
 * play-cache transcodes that file in place and we do not re-download it.
 */
export async function localFileNeedsStreamAlacDecode(
  absPath: string,
  lstat: (p: string) => Promise<{ isSymbolicLink(): boolean; isFile(): boolean }>,
): Promise<boolean> {
  try {
    const st = await lstat(absPath)
    if (st.isSymbolicLink()) return true
    return !st.isFile()
  } catch {
    return true
  }
}

function serveFileRange(file: string, total: number, rangeHeader: string | null): Response {
  const headersBase = {
    'Content-Type': 'audio/flac',
    'Accept-Ranges': 'bytes',
    'X-JT-Audio-Source': 'stream-alac-cache',
  }
  if (rangeHeader) {
    const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader)
    if (m) {
      const start = parseInt(m[1], 10)
      const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= total || start > end) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } })
      }
      const nodeStream = createReadStream(file, { start, end })
      return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
        status: 206,
        headers: {
          ...headersBase,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${total}`,
        },
      })
    }
  }
  const nodeStream = createReadStream(file)
  return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
    status: 200,
    headers: { ...headersBase, 'Content-Length': String(total) },
  })
}

export function createStreamAlacCache(opts: StreamAlacCacheDeps): StreamAlacCache {
  const dir = opts.dir
  const capBytes = opts.capBytes ?? STREAM_ALAC_CACHE_CAP_BYTES
  const fetchRaw = opts.fetchRaw
  const transcode = opts.transcode
  const log = opts.log ?? ((m: string) => console.log(m))
  const inflight = new Map<string, Promise<string>>()

  async function enforceCap(justWritten: string): Promise<void> {
    try {
      const entries: Array<{ p: string; size: number; at: number }> = []
      let total = 0
      for (const name of await readdir(dir)) {
        if (!name.endsWith('.flac')) continue
        const p = join(dir, name)
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
      log(`[stream-alac-cache] cap ${(capBytes / 1e9).toFixed(1)} GB — evicted down to ${(total / 1e6).toFixed(1)} MB`)
    } catch { /* cap enforcement must never break playback */ }
  }

  async function ensure(trackId: string | number): Promise<string> {
    const id = safeId(trackId)
    const final = join(dir, `${id}.flac`)
    try {
      const st = await stat(final)
      if (st.size > 0) return final
    } catch { /* not cached yet */ }

    const existing = inflight.get(id)
    if (existing) return existing

    const p = (async () => {
      const raw = join(dir, `${id}.alac.partial`)
      const tmp = join(dir, `${id}.flac.partial`)
      try {
        await mkdir(dir, { recursive: true })
        await fetchRaw(String(trackId), raw)
        await transcode(raw, tmp)
        await rename(tmp, final)
        await unlink(raw).catch((err) => {
          log(`[stream-alac-cache] leftover ALAC ${raw}: ${err instanceof Error ? err.message : err}`)
        })
        await enforceCap(final)
        return final
      } catch (err) {
        await unlink(tmp).catch((err) => {
          log(`[stream-alac-cache] partial FLAC cleanup: ${err instanceof Error ? err.message : err}`)
        })
        await unlink(raw).catch((err) => {
          log(`[stream-alac-cache] partial ALAC cleanup: ${err instanceof Error ? err.message : err}`)
        })
        throw err
      } finally {
        inflight.delete(id)
      }
    })()
    inflight.set(id, p)
    return p
  }

  async function serve(trackId: string | number, rangeHeader: string | null): Promise<Response> {
    const file = await ensure(trackId)
    const now = new Date()
    await utimes(file, now, now).catch((err) => {
      log(`[stream-alac-cache] touch failed: ${err instanceof Error ? err.message : err}`)
    })
    const st = await stat(file)
    return serveFileRange(file, st.size, rangeHeader)
  }

  return {
    dir,
    capBytes,
    ensureDir: async () => { await mkdir(dir, { recursive: true }) },
    ensure,
    serve,
    inflightCount: () => inflight.size,
  }
}
