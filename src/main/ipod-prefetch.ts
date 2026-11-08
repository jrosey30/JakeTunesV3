/**
 * Bring iPod songs back to this Mac, in the background (2026-11-08).
 *
 * ipod-keep-local.ts stops evicting the songs on any iPod's list. This brings
 * back the ones already evicted (a link to homemini, or nothing at all), so a
 * sync never has to fetch them while it runs.
 *
 *   • One song at a time, in the keep set's order (the Original's Top 1000 by
 *     rank, then the registered iPods' lists, then the planned ones).
 *   • Through the existing restore path: the Electron half hands the verified
 *     bytes to materializeTrackFromHomemini (ipod-sync-materialize.ts), the same
 *     "Download" / pin path, which writes a temp beside the library path and
 *     renames it over the link, refuses under the 10 GB floor, and never
 *     touches a real file that is already there.
 *   • Resumable: bytes land in a part file in userData (never in the music
 *     folder, where the NAS sync would pick a half file up) with homemini's
 *     ETag beside it; the next try asks for the rest (Range + If-Range).
 *   • Verified before it lands: the size homemini promised, and the song's
 *     identity — the full sha1 when the offload log recorded one for that path,
 *     else the library's 256 KB fingerprint (the same pre-filter offload uses).
 *     A mismatch is thrown away, never written.
 *   • Low priority: nothing starts while music is playing, and a download in
 *     flight stops (keeping its bytes) the moment music starts, so it never
 *     competes with a song streaming from homemini.
 *   • A disk floor: before each song, the write must leave the 10 GB floor
 *     free (counted twice: the part file and the restore's temp). Short of it,
 *     the pass stops and says how much room the rest needs.
 *   • homemini not answering: the pass is skipped.
 *
 * Electron-free; every effect is injected (__tests__/ipod-prefetch.test.ts).
 */
import { createWriteStream } from 'node:fs'
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { digestFile, sha1WindowMatches } from './offload-audio.ts'
import { diskWriteWouldBreachFloor, formatFreeSpaceRefuse, MATERIALIZE_FREE_FLOOR_BYTES } from './ipod-sync-materialize.ts'

export type LocalKind = 'local' | 'streamed' | 'missing'

export interface PrefetchTrack {
  id?: unknown
  path?: unknown
  fileSize?: unknown
  audioFingerprint?: unknown
}

export interface PrefetchItem {
  id: number
  colon: string
  /** library.json's size: an estimate for the disk floor (it can drift). */
  bytes: number
  fingerprint?: string
  /** sha1 of the whole file, when the offload log recorded one for this path. */
  fullSha1?: string
}

export interface PrefetchPlan {
  /** Kept songs that are in this library. */
  total: number
  /** Of those, a real file on this Mac. */
  local: number
  /** Not on this Mac, in fetch order. */
  items: PrefetchItem[]
  neededBytes: number
}

export async function planPrefetch(
  ids: readonly number[],
  tracks: ReadonlyArray<PrefetchTrack>,
  kindOf: (colon: string) => Promise<LocalKind>,
  fullSha1ByPath: ReadonlyMap<string, string> = new Map(),
): Promise<PrefetchPlan> {
  const byId = new Map<number, PrefetchTrack>()
  for (const t of tracks) {
    const id = Number(t?.id)
    if (Number.isInteger(id)) byId.set(id, t)
  }
  const out: PrefetchPlan = { total: 0, local: 0, items: [], neededBytes: 0 }
  const seen = new Set<number>()
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const t = byId.get(id)
    const colon = t ? String(t.path || '').trim() : ''
    if (!t || !colon) continue
    out.total++
    if ((await kindOf(colon)) === 'local') { out.local++; continue }
    const bytes = Math.max(0, Number(t.fileSize) || 0)
    const fp = typeof t.audioFingerprint === 'string' && t.audioFingerprint.startsWith('sha1:') ? t.audioFingerprint : undefined
    out.items.push({ id, colon, bytes, ...(fp ? { fingerprint: fp } : {}), ...(fullSha1ByPath.get(colon) ? { fullSha1: fullSha1ByPath.get(colon) } : {}) })
    out.neededBytes += bytes
  }
  return out
}

export type FetchOneResult =
  | { ok: true; bytes: number }
  | { ok: false; error: string; stopped?: boolean; transport?: boolean }

export interface PrefetchPassDeps {
  items: readonly PrefetchItem[]
  reachable: () => Promise<boolean>
  isPlaying: () => boolean
  freeBytes: () => Promise<number>
  floorBytes?: number
  fetchOne: (item: PrefetchItem, shouldStop: () => boolean) => Promise<FetchOneResult>
  /** This many transport failures in a row and homemini is treated as gone. */
  maxTransportFailures?: number
}

export interface PrefetchPassResult {
  fetched: number
  fetchedBytes: number
  failed: Array<{ id: number; error: string }>
  /** Still not on this Mac when the pass ended. */
  left: number
  leftBytes: number
  stoppedBecause: string | null
}

const GB = 1024 ** 3
const gb = (n: number): string => (n / GB).toFixed(1)

/** One pass over the songs not on this Mac. Never throws. */
export async function runPrefetchPass(deps: PrefetchPassDeps): Promise<PrefetchPassResult> {
  const floor = deps.floorBytes ?? MATERIALIZE_FREE_FLOOR_BYTES
  const maxTransport = deps.maxTransportFailures ?? 3
  const r: PrefetchPassResult = { fetched: 0, fetchedBytes: 0, failed: [], left: 0, leftBytes: 0, stoppedBecause: null }
  const remaining = (from: number): void => {
    for (let k = from; k < deps.items.length; k++) { r.left++; r.leftBytes += deps.items[k].bytes }
  }
  if (deps.items.length === 0) return r
  if (!(await deps.reachable().catch(() => false))) {
    r.stoppedBecause = 'homemini isn’t answering'
    remaining(0)
    return r
  }
  let transportInARow = 0
  for (let i = 0; i < deps.items.length; i++) {
    const item = deps.items[i]
    if (deps.isPlaying()) {
      r.stoppedBecause = 'music is playing'
      remaining(i)
      return r
    }
    let free: number
    try { free = await deps.freeBytes() } catch { free = Number.NaN }
    if (diskWriteWouldBreachFloor(free, item.bytes * 2, floor)) {
      r.stoppedBecause = `not enough room on this Mac: ${formatFreeSpaceRefuse(free, floor)}`
      remaining(i)
      return r
    }
    let got: FetchOneResult
    try {
      got = await deps.fetchOne(item, deps.isPlaying)
    } catch (err) {
      got = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (got.ok) {
      r.fetched++
      r.fetchedBytes += got.bytes
      transportInARow = 0
      continue
    }
    if (got.stopped) {
      r.stoppedBecause = 'music started playing'
      remaining(i)
      return r
    }
    r.failed.push({ id: item.id, error: got.error })
    r.left++
    r.leftBytes += item.bytes
    if (got.transport) {
      transportInARow++
      if (transportInARow >= maxTransport) {
        r.stoppedBecause = 'homemini stopped answering'
        remaining(i + 1)
        return r
      }
    } else {
      transportInARow = 0
    }
  }
  return r
}

/** The one line a pass logs. */
export function prefetchLogLine(plan: Pick<PrefetchPlan, 'total' | 'local'>, pass: PrefetchPassResult): string {
  const parts = [`[ipod-local] ${plan.total} iPod song(s): ${plan.local + pass.fetched} on this Mac`]
  if (pass.fetched) parts.push(`fetched ${pass.fetched} (${(pass.fetchedBytes / 1e6).toFixed(0)} MB)`)
  if (pass.left) parts.push(`${pass.left} still to fetch (${gb(pass.leftBytes)} GB)`)
  if (pass.failed.length) parts.push(`${pass.failed.length} failed (first: id ${pass.failed[0].id}: ${pass.failed[0].error})`)
  if (pass.stoppedBecause) parts.push(`stopped: ${pass.stoppedBecause}`)
  return parts.join(' · ')
}

// ── The resumable download ─────────────────────────────────────────────────

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

interface PartMeta { etag: string | null; total: number | null }

function metaPathOf(partPath: string): string { return `${partPath}.json` }

export async function discardPart(partPath: string): Promise<void> {
  await rm(partPath, { force: true })
  await rm(metaPathOf(partPath), { force: true })
}

async function readMeta(partPath: string): Promise<{ meta: PartMeta; have: number } | null> {
  try {
    const meta = JSON.parse(await readFile(metaPathOf(partPath), 'utf-8')) as PartMeta
    const have = (await stat(partPath)).size
    return { meta: { etag: typeof meta.etag === 'string' ? meta.etag : null, total: Number(meta.total) > 0 ? Number(meta.total) : null }, have }
  } catch {
    return null
  }
}

/**
 * Download `url` into `partPath`, picking up where an earlier try stopped. Only
 * a strong ETag resumes (If-Range): anything else starts over, so a file
 * re-cut on homemini can never be spliced onto old bytes. The part is kept on
 * a stop or a dropped connection; it is removed when the answer is wrong.
 */
export async function fetchResumable(opts: {
  url: string
  partPath: string
  fetchImpl: FetchLike
  shouldStop: () => boolean
  /** A connection that sends nothing for this long is dropped (kept for resume). */
  idleMs?: number
  withInit?: (init: RequestInit) => RequestInit
}): Promise<{ ok: true; bytes: number } | { ok: false; error: string; stopped?: boolean; transport?: boolean }> {
  const idleMs = opts.idleMs ?? 60_000
  const wrap = opts.withInit ?? ((i: RequestInit) => i)
  await mkdir(dirname(opts.partPath), { recursive: true })
  const found = await readMeta(opts.partPath)
  // A strong ETag only ("W/..." can't promise the same bytes).
  const prior = found && found.have > 0 && found.meta.etag?.startsWith('"') && found.meta.total ? found : null
  if (prior && prior.have === prior.meta.total) return { ok: true, bytes: prior.have }
  if (!prior) await discardPart(opts.partPath)
  const ac = new AbortController()
  let idle: ReturnType<typeof setTimeout> | null = null
  const poke = (): void => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => ac.abort(), idleMs)
    idle.unref?.()
  }
  const headers: Record<string, string> = {}
  if (prior) {
    headers.Range = `bytes=${prior.have}-`
    headers['If-Range'] = prior.meta.etag!
  }
  poke()
  let res: Response
  try {
    res = await opts.fetchImpl(opts.url, wrap({ headers, signal: ac.signal }))
  } catch (err) {
    if (idle) clearTimeout(idle)
    return { ok: false, error: `homemini: ${err instanceof Error ? err.message : String(err)}`, transport: true }
  }
  let append = false
  let total: number | null = null
  if (res.status === 206 && prior) {
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') || '')
    if (!m || Number(m[1]) !== prior.have || Number(m[3]) !== prior.meta.total) {
      ac.abort()
      if (idle) clearTimeout(idle)
      await discardPart(opts.partPath)
      return { ok: false, error: 'homemini answered a different range; starting over next time' }
    }
    append = true
    total = prior.meta.total
  } else if (res.status === 200) {
    const n = Number(res.headers.get('content-length'))
    total = Number.isFinite(n) && n > 0 ? n : null
  } else {
    ac.abort()
    if (idle) clearTimeout(idle)
    if (res.status === 416) await discardPart(opts.partPath)
    return { ok: false, error: `homemini ${res.status}`, transport: res.status >= 500 }
  }
  if (!res.body) {
    if (idle) clearTimeout(idle)
    return { ok: false, error: 'homemini sent no body', transport: true }
  }
  if (!append) {
    const etag = res.headers.get('etag')
    await writeFile(metaPathOf(opts.partPath), JSON.stringify({ etag, total } satisfies PartMeta))
  }
  const out = createWriteStream(opts.partPath, { flags: append ? 'a' : 'w' })
  const closeOut = (): Promise<void> => new Promise((resolve) => out.end(() => resolve()))
  const reader = res.body.getReader()
  try {
    for (;;) {
      if (opts.shouldStop()) {
        ac.abort()
        await reader.cancel().catch(() => undefined)
        await closeOut()
        return { ok: false, error: 'stopped', stopped: true }
      }
      const step = await reader.read()
      if (step.done) break
      poke()
      if (!step.value || step.value.byteLength === 0) continue
      if (!out.write(step.value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()))
    }
  } catch (err) {
    await closeOut()
    return { ok: false, error: `homemini: ${err instanceof Error ? err.message : String(err)}`, transport: true }
  } finally {
    if (idle) clearTimeout(idle)
  }
  await closeOut()
  const size = (await stat(opts.partPath)).size
  if (total !== null && size !== total) {
    if (size > total) {
      await discardPart(opts.partPath)
      return { ok: false, error: `homemini sent ${size} bytes for a ${total}-byte file` }
    }
    return { ok: false, error: `homemini stopped at ${size} of ${total} bytes`, transport: true }
  }
  return { ok: true, bytes: size }
}

/** null = the downloaded file is the song; else why it isn't. */
export async function verifyFetched(partPath: string, item: PrefetchItem): Promise<string | null> {
  const size = (await stat(partPath).catch(() => null))?.size ?? 0
  if (size <= 0) return 'nothing was downloaded'
  if (item.fullSha1) {
    const d = await digestFile(partPath)
    return d.sha1 === item.fullSha1.toLowerCase() ? null : 'its sha1 doesn’t match the file this Mac offloaded'
  }
  if (item.fingerprint) {
    const fh = await open(partPath, 'r')
    try {
      const buf = Buffer.alloc(Math.min(size, 256 * 1024))
      await fh.read(buf, 0, buf.length, 0)
      return sha1WindowMatches(item.fingerprint, buf) ? null : 'its fingerprint doesn’t match the library’s'
    } finally {
      await fh.close()
    }
  }
  return null   // no identity on record: homemini's own size (checked above) is all there is
}
