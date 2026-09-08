/**
 * Stream spool (2026-08-28 — Jake: "yeah still blipping....do the deeper
 * buffering thing").
 *
 * Streaming clients (workmini, any streamSource machine) used to LIVE-PROXY
 * every Range request to homemini — over the WAN when remote, so every
 * wobble of internet jitter reached the player's tiny buffer as an audible
 * blip. The spool makes the WAN unable to touch a playing song:
 *
 *   • First ranged request for a track kicks a FULL-FILE download to local
 *     disk at wire speed (single-flight per track), while the live proxy
 *     keeps serving exactly as before.
 *   • The moment the spool completes (a 3-4 min track lands in well under a
 *     minute at measured office throughput), every subsequent range is
 *     served from LOCAL DISK — 206s with real Content-Range, zero WAN.
 *   • Spooled files persist under an LRU cap, so a REPLAYED track never
 *     crosses the WAN at all.
 *
 * Failure modes are deliberately boring: spool errors fall back to today's
 * live proxy, a failed spool waits out a cooldown before retrying, and a
 * .part file is never served.
 *
 * Electron-free (dir + fetch injected) so node --test loads it.
 */
import { createWriteStream, createReadStream } from 'fs'
import { readFile, writeFile, rename, mkdir, stat, readdir, unlink } from 'fs/promises'
import { join } from 'path'
import { Readable } from 'stream'

export interface SpoolMeta { contentType: string; total: number }
export interface SpoolReady { file: string; contentType: string; total: number }

const SPOOL_CAP_BYTES = 6 * 1024 * 1024 * 1024   // 6 GB LRU — replays stay free
const RETRY_COOLDOWN_MS = 60_000

const inFlight = new Map<string, Promise<void>>()
const failedAt = new Map<string, number>()

// ── One spool at a time, newest first ────────────────────────────────────
//
// The spool exists to keep WAN jitter away from a playing song. Unbounded,
// it does the exact opposite. Measured on workmini 2026-09-08: 140 tracks
// downloading AT ONCE, 920 MB spooled, the whole link split 140 ways — so
// the ONE track actually playing got a sliver, its buffer drained, and the
// music stopped and started. Every range request kicks a spool, and a
// library view or a queue walk touches many tracks, so "many at once" is
// the normal case, not an edge case.
//
// Two rules fix it:
//   • ACTIVE_LIMIT 1 — a spool takes the link, finishes fast (a 5 MB AAC
//     track lands in ~9s at office throughput), and gets out of the way.
//     Serial is not slower overall; it just stops starving the listener.
//   • LIFO — the most recently requested track is the one being listened
//     to. FIFO would make the playing song wait behind a queue of stale
//     interest from a scroll five minutes ago.
//
// Same doctrine as the cache-fill rate limit: a batch job yields to
// playback.
const ACTIVE_LIMIT = 1
// Waiting interest goes stale; a huge backlog is just the same starvation
// deferred. Oldest waiters fall off.
const WAITING_LIMIT = 24
let activeSpools = 0
const waiting: Array<{ key: string; start: () => void }> = []

function pumpSpools(): void {
  while (activeSpools < ACTIVE_LIMIT) {
    const next = waiting.pop()          // LIFO: newest interest wins
    if (!next) return
    activeSpools++
    next.start()
  }
}

/** Test seam: how many downloads are running and queued. */
export function spoolQueueState(): { active: number; waiting: number } {
  return { active: activeSpools, waiting: waiting.length }
}

const donePath = (dir: string, key: string): string => join(dir, `${key}.done`)
const metaPath = (dir: string, key: string): string => join(dir, `${key}.meta.json`)

/** The spooled file, if fully landed — null while downloading or absent. */
export async function spoolReady(dir: string, key: string): Promise<SpoolReady | null> {
  try {
    const [meta, st] = await Promise.all([
      readFile(metaPath(dir, key), 'utf-8').then((t) => JSON.parse(t) as SpoolMeta),
      stat(donePath(dir, key)),
    ])
    if (!meta?.total || st.size !== meta.total) return null   // torn spool = never served
    return { file: donePath(dir, key), contentType: meta.contentType || 'audio/mpeg', total: meta.total }
  } catch {
    return null
  }
}

/** Kick a full-file download (single-flight, cooldown after failure). */
export function ensureSpool(dir: string, key: string, url: string, fetchFn: typeof fetch = fetch): void {
  if (inFlight.has(key)) return
  const lastFail = failedAt.get(key)
  if (lastFail && Date.now() - lastFail < RETRY_COOLDOWN_MS) return
  // Registered in inFlight while QUEUED as well as while downloading, so a
  // repeat request for the same track can't stack a second entry.
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  waiting.push({ key, start: release })
  while (waiting.length > WAITING_LIMIT) waiting.shift()   // drop stalest interest
  const run = (async () => {
    await gate
    try {
    await mkdir(dir, { recursive: true })
    if (await spoolReady(dir, key)) return
    const part = join(dir, `${key}.part.${process.pid}`)
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(10 * 60_000) })
      if (!res.ok || !res.body) throw new Error(`spool fetch ${res.status}`)
      const total = Number(res.headers.get('content-length')) || 0
      const contentType = res.headers.get('content-type') || 'audio/mpeg'
      const out = createWriteStream(part)
      await new Promise<void>((resolve, reject) => {
        Readable.fromWeb(res.body as never).pipe(out).on('finish', resolve).on('error', reject)
      })
      const written = (await stat(part)).size
      if (total > 0 && written !== total) throw new Error(`spool short: ${written}/${total}`)
      await writeFile(metaPath(dir, key), JSON.stringify({ contentType, total: written } satisfies SpoolMeta))
      await rename(part, donePath(dir, key))
      failedAt.delete(key)
      console.log(`[stream-spool] landed ${key} (${(written / 1e6).toFixed(1)} MB) — serving local from here`)
      void enforceSpoolCap(dir)
    } catch (err) {
      failedAt.set(key, Date.now())
      try { await unlink(part) } catch { /* never landed */ }
      console.warn(`[stream-spool] ${key} failed (live proxy continues):`, err instanceof Error ? err.message : err)
    }
    } finally {
      activeSpools--
      pumpSpools()
    }
  })()
  inFlight.set(key, run)
  void run.finally(() => inFlight.delete(key))
  pumpSpools()
}

/** Oldest spooled tracks fall off past the cap. .part files are never touched. */
export async function enforceSpoolCap(dir: string, cap = SPOOL_CAP_BYTES): Promise<void> {
  try {
    const entries: Array<{ key: string; size: number; mtime: number }> = []
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.done')) continue
      try {
        const st = await stat(join(dir, name))
        entries.push({ key: name.slice(0, -5), size: st.size, mtime: st.mtimeMs })
      } catch { /* raced */ }
    }
    let total = entries.reduce((s, e) => s + e.size, 0)
    if (total <= cap) return
    for (const e of entries.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= cap) break
      try {
        await unlink(donePath(dir, e.key))
        await unlink(metaPath(dir, e.key)).catch(() => undefined)
        total -= e.size
      } catch { /* raced */ }
    }
  } catch { /* dir missing — nothing to enforce */ }
}

/** Serve a Range (or whole-file) request from a landed spool — local disk,
 *  proper 206/Content-Range, jitter-immune. Mirrors the ipod-audio local
 *  file serving exactly. */
export function serveSpoolRange(ready: SpoolReady, rangeHeader: string | null): Response {
  const { file, contentType, total } = ready
  const headersBase = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'X-JT-Audio-Source': 'stream-spool',
  }
  if (rangeHeader) {
    const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader)
    if (m) {
      const start = parseInt(m[1], 10)
      const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1
      if (start >= total || start > end) {
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

/** The one-call integration for fetchAudioFromHomemini: serve from a landed
 *  spool, else kick the download (ranged requests only — playback's
 *  signature; full-file pulls like pin/ingest must not double-download)
 *  and let the live proxy answer this request. */
export async function spoolAwareServe(
  dir: string,
  key: string,
  url: string,
  rangeHeader: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<Response | null> {
  const ready = await spoolReady(dir, key)
  if (ready) return serveSpoolRange(ready, rangeHeader)
  if (rangeHeader) ensureSpool(dir, key, url, fetchFn)
  return null
}
