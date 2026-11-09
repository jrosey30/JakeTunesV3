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
 *   • A song homemini's copy can't prove is asked for once a day, not every
 *     pass (2026-11-09). The library's fingerprint goes stale when a file's
 *     tags are rewritten; about 490 iPod songs were like that, and each pass
 *     downloaded all of them, threw them away, and did it again 30 minutes
 *     later: 299 GB in 17 hours, away from home. Now the first 256 KB is
 *     checked before the rest is fetched, and a refusal is remembered on disk
 *     (`refusedPath`) until the library's record of the song changes or a day
 *     passes. A sync still gets those songs the way it always did (staged).
 *   • What the check is made against (2026-11-09, the same day). All 480 songs
 *     refused that day were homemini holding the very file this Mac evicted:
 *     the tags were rewritten after import, the library's fingerprint was not,
 *     and the file then left this Mac. So a fetched file is also the song when
 *     its md5 and size are the ones this Mac wrote in evictions.log when it
 *     evicted that path. Once it lands, the fingerprint is measured from the
 *     file and handed to the library the way a tag write hands it
 *     (`owedFingerprints`), so the song is never refused again.
 *   • homemini is asked what it holds first (audio-identity.ts): size, sha1 and
 *     ETag, nothing downloaded. A refusal remembers that answer and is not
 *     tried again until it changes (`decidePrefetch`, `splitRefused`). With no
 *     such route on homemini (an older backend) the day's hold above applies.
 *   • Away from home, a file that could only be checked after downloading it
 *     whole waits until this Mac is home. Jake's "Wait" on the Device page is a
 *     request, and fetches anyway.
 *
 * Electron-free; every effect is injected (__tests__/ipod-prefetch.test.ts).
 */
import { createWriteStream } from 'node:fs'
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { sha1WindowMatches } from './offload-audio.ts'
import type { IdentityEntry } from './audio-identity.ts'
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
  /** md5 and size of the file this Mac evicted from this path (evictions.log, the last line for it). */
  evicted?: EvictedRecord
}

export interface EvictedRecord { md5: string; bytes: number }

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
  evictedByPath: ReadonlyMap<string, EvictedRecord> = new Map(),
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
    out.items.push({ id, colon, bytes, ...(fp ? { fingerprint: fp } : {}), ...(fullSha1ByPath.get(colon) ? { fullSha1: fullSha1ByPath.get(colon) } : {}), ...(evictedByPath.get(colon) ? { evicted: evictedByPath.get(colon) } : {}) })
    out.neededBytes += bytes
  }
  return out
}

export type FetchOneResult =
  | { ok: true; bytes: number }
  | { ok: false; error: string; stopped?: boolean; transport?: boolean; /** homemini's copy isn't provably this song */ identity?: boolean }

// ── Songs homemini's copy can't prove ──────────────────────────────────────

export const REFUSED_FILE = 'ipod-prefetch-refused.json'
export const REFUSED_HOLD_MS = 24 * 60 * 60 * 1000
/**
 * id → what the library said about the song when it was refused, and when.
 * `remote`: what homemini said it holds then (audio-identity), when it was asked.
 */
export type RefusedMemory = Record<string, { key: string; at: number; remote?: string }>

/** homemini's answers this pass, by id. A missing id was not answered for. */
export type RemoteAnswers = ReadonlyMap<string, IdentityEntry>

/**
 * Which copy homemini held when a song was refused: its ETag (size and modified
 * time) and size. Known before homemini has hashed the file, and it moves when
 * the file is replaced. undefined = homemini didn't say.
 */
export function remoteCopyKey(entry: IdentityEntry | undefined): string | undefined {
  return entry && entry.etag ? `${entry.etag}|${entry.size ?? ''}` : undefined
}

/**
 * What the check is made against on this Mac's side: a change here means a new
 * try is worth it. The eviction record is part of it, so every refusal made
 * before that record counted is tried again once.
 */
export function refusalKey(item: PrefetchItem): string {
  return `${item.fingerprint ?? ''}|${item.fullSha1 ?? ''}|${item.bytes}|${item.evicted ? `${item.evicted.md5}:${item.evicted.bytes}` : ''}`
}

/**
 * `fetch`: worth asking homemini for. `held`: refused on this same record, and
 * either homemini still gives the answer it gave then, or (it wasn't asked,
 * then or now) less than a day has passed.
 */
export function splitRefused(items: readonly PrefetchItem[], memory: RefusedMemory, now: number, holdMs = REFUSED_HOLD_MS, remote: RemoteAnswers | null = null): { fetch: PrefetchItem[]; held: PrefetchItem[] } {
  const out = { fetch: [] as PrefetchItem[], held: [] as PrefetchItem[] }
  for (const item of items) {
    const m = memory[String(item.id)]
    let holds = false
    if (m && m.key === refusalKey(item)) {
      const copy = remoteCopyKey(remote?.get(String(item.id)))
      if (m.remote !== undefined && copy !== undefined) holds = copy === m.remote
      else holds = now - m.at >= 0 && now - m.at < holdMs
    }
    ;(holds ? out.held : out.fetch).push(item)
  }
  return out
}

/** The memory after a pass: refusals added, songs that landed or left the queue dropped. */
export function nextRefused(memory: RefusedMemory, queued: readonly PrefetchItem[], refusedNow: readonly PrefetchItem[], landed: ReadonlySet<number>, now: number, remote: RemoteAnswers | null = null): RefusedMemory {
  const out: RefusedMemory = {}
  const inQueue = new Map(queued.map((i) => [String(i.id), i]))
  for (const [id, m] of Object.entries(memory)) {
    const item = inQueue.get(id)
    if (item && !landed.has(item.id) && m.key === refusalKey(item)) out[id] = m
  }
  for (const item of refusedNow) {
    const copy = remoteCopyKey(remote?.get(String(item.id)))
    out[String(item.id)] = { key: refusalKey(item), at: now, ...(copy !== undefined ? { remote: copy } : {}) }
  }
  return out
}

// ── What to do about one song, before anything is downloaded ───────────────

/**
 * fetch      homemini's copy is this song as far as can be told without it, or nothing can be checked
 * probe      the first 256 KB decides (`probeFingerprint`, then `afterProbe`)
 * refuse     homemini's copy is not the file on record: nothing is downloaded
 * wait-home  only downloading it whole could tell, and this Mac is away
 * absent     homemini has no file for it yet
 * later      homemini hasn't hashed its copy yet, and this song needs the hash
 */
export type PrefetchVerdict = 'fetch' | 'probe' | 'refuse' | 'wait-home' | 'absent' | 'later'

export interface PrefetchWhere {
  away: boolean
  /** Jake asked for this pass (the Device page's Wait). */
  userAsked: boolean
}

/**
 * `remote`: homemini's answer for the song; null = it has no file; undefined =
 * it can't be asked (an older backend), so the old checks carry it.
 */
export function decidePrefetch(item: PrefetchItem, remote: IdentityEntry | undefined, where: PrefetchWhere): PrefetchVerdict {
  if (remote === null) return 'absent'
  const checkedAfter: PrefetchVerdict = where.away && !where.userAsked ? 'wait-home' : 'fetch'
  if (remote) {
    // Not hashed yet: the size is still known, and an evicted file needs no more than that here.
    const sha1 = 'sha1' in remote ? remote.sha1 : undefined
    if (item.fullSha1 && sha1 === item.fullSha1.toLowerCase()) return 'fetch'
    if (item.evicted && remote.size === item.evicted.bytes) return checkedAfter   // the md5 is taken from the file
    if (item.fullSha1) return sha1 ? 'refuse' : 'later'
    if (item.fingerprint) return 'probe'
    if (item.evicted) return remote.size !== undefined ? 'refuse' : 'later'
    return 'fetch'
  }
  if (item.fullSha1 || item.evicted) return checkedAfter
  return item.fingerprint ? 'probe' : 'fetch'
}

/** After `probe`: a match is fetched, a mismatch refused, and no answer is a whole-file check. */
export function afterProbe(probe: 'match' | 'mismatch' | 'unknown', where: PrefetchWhere): PrefetchVerdict {
  if (probe === 'match') return 'fetch'
  if (probe === 'mismatch') return 'refuse'
  return where.away && !where.userAsked ? 'wait-home' : 'fetch'
}

// ── The library's fingerprint, after a song lands ──────────────────────────

export const OWED_FINGERPRINTS_FILE = 'ipod-prefetch-fingerprints-owed.json'
export interface MeasuredLanding { id: number; fileSize: number; audioFingerprint?: string }
/** id → what was measured from the landed file, until the library's record shows it. */
export type OwedFingerprints = Record<string, MeasuredLanding>

/**
 * The library is written by the renderer's save, which may not be there when a
 * song lands. So a measurement is owed until the library shows it: `resend`
 * goes to the renderer again, `still` is what is owed after this look.
 */
export function owedFingerprints(owed: OwedFingerprints, tracks: ReadonlyArray<PrefetchTrack>): { still: OwedFingerprints; resend: MeasuredLanding[] } {
  const byId = new Map<number, PrefetchTrack>()
  for (const t of tracks) byId.set(Number(t?.id), t)
  const out = { still: {} as OwedFingerprints, resend: [] as MeasuredLanding[] }
  for (const [id, m] of Object.entries(owed)) {
    const t = byId.get(Number(id))
    if (!t) continue   // the song left the library
    const sizeShown = Number(t.fileSize) === m.fileSize
    const fpShown = !m.audioFingerprint || t.audioFingerprint === m.audioFingerprint
    if (sizeShown && fpShown) continue
    out.still[id] = m
    out.resend.push(m)
  }
  return out
}

export function parseOwedFingerprints(text: string | null): OwedFingerprints {
  const out: OwedFingerprints = {}
  try {
    const o = JSON.parse(text ?? '') as Record<string, Partial<MeasuredLanding> | null>
    for (const [id, m] of Object.entries(o ?? {})) {
      if (!m || !Number.isInteger(Number(id)) || !Number.isFinite(m.fileSize) || Number(m.fileSize) <= 0) continue
      out[id] = { id: Number(id), fileSize: Number(m.fileSize), ...(typeof m.audioFingerprint === 'string' ? { audioFingerprint: m.audioFingerprint } : {}) }
    }
  } catch { /* none */ }
  return out
}

export function parseRefused(text: string | null): RefusedMemory {
  const out: RefusedMemory = {}
  try {
    const o = JSON.parse(text ?? '') as Record<string, { key?: unknown; at?: unknown; remote?: unknown }>
    for (const [id, m] of Object.entries(o ?? {})) {
      if (m && typeof m.key === 'string' && typeof m.at === 'number' && Number.isFinite(m.at)) out[id] = { key: m.key, at: m.at, ...(typeof m.remote === 'string' ? { remote: m.remote } : {}) }
    }
  } catch { /* none */ }
  return out
}

/**
 * The first 256 KB against the library's fingerprint, before the whole file is
 * fetched. 'unknown' (homemini didn't answer a range, or the song has a full
 * sha1 on record, or no fingerprint) leaves the decision to verifyFetched.
 */
export async function probeFingerprint(item: PrefetchItem, url: string, fetchImpl: FetchLike, withInit: (init: RequestInit) => RequestInit = (i) => i): Promise<'match' | 'mismatch' | 'unknown'> {
  if (!item.fingerprint || item.fullSha1) return 'unknown'
  try {
    const res = await fetchImpl(url, withInit({ headers: { Range: `bytes=0-${FINGERPRINT_PROBE_BYTES - 1}` }, signal: AbortSignal.timeout(30_000) }))
    if (res.status !== 206) { await res.body?.cancel().catch(() => undefined); return 'unknown' }
    const buf = Buffer.from(await res.arrayBuffer())
    const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') || '')?.[1])
    // A short answer that isn't the whole file proves nothing.
    if (buf.length < FINGERPRINT_PROBE_BYTES && !(Number.isFinite(total) && buf.length === total)) return 'unknown'
    return sha1WindowMatches(item.fingerprint, buf) ? 'match' : 'mismatch'
  } catch {
    return 'unknown'
  }
}
const FINGERPRINT_PROBE_BYTES = 256 * 1024

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
export function prefetchLogLine(plan: Pick<PrefetchPlan, 'total' | 'local'>, pass: PrefetchPassResult, held = 0, waitingForHome = 0): string {
  const parts = [`[ipod-local] ${plan.total} iPod song(s): ${plan.local + pass.fetched} on this Mac`]
  if (held) parts.push(`${held} not asked for again until something changes (homemini’s copy doesn’t match this Mac’s record of the song)`)
  if (waitingForHome) parts.push(`${waitingForHome} waiting until this Mac is home (each has to be fetched whole to be checked)`)
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

async function digestsOf(abs: string): Promise<{ sha1: string; md5: string; bytes: number }> {
  const sha1 = createHash('sha1')
  const md5 = createHash('md5')
  let bytes = 0
  for await (const chunk of createReadStream(abs)) {
    sha1.update(chunk as Buffer)
    md5.update(chunk as Buffer)
    bytes += (chunk as Buffer).byteLength
  }
  return { sha1: sha1.digest('hex'), md5: md5.digest('hex'), bytes }
}

/**
 * null = the downloaded file is the song; else why it isn't.
 *
 * It is the song when the whole file is one this Mac held at that path: the
 * sha1 it logged when it offloaded it, or the md5 AND size it logged when it
 * evicted it. With neither on record, the library's 256 KB fingerprint decides,
 * as before. A whole-file record that doesn't match is never rescued by the
 * fingerprint.
 */
export async function verifyFetched(partPath: string, item: PrefetchItem): Promise<string | null> {
  const size = (await stat(partPath).catch(() => null))?.size ?? 0
  if (size <= 0) return 'nothing was downloaded'
  if (item.fullSha1 || item.evicted) {
    const d = await digestsOf(partPath)
    if (item.fullSha1 && d.sha1 === item.fullSha1.toLowerCase()) return null
    if (item.evicted && /^[0-9a-f]{32}$/.test(item.evicted.md5) && d.bytes === item.evicted.bytes && d.md5 === item.evicted.md5) return null
    if (item.fullSha1) return 'its sha1 doesn’t match the file this Mac offloaded'
  }
  if (item.fingerprint) {
    const fh = await open(partPath, 'r')
    try {
      const buf = Buffer.alloc(Math.min(size, 256 * 1024))
      await fh.read(buf, 0, buf.length, 0)
      if (sha1WindowMatches(item.fingerprint, buf)) return null
    } finally {
      await fh.close()
    }
    return item.evicted ? 'it is neither the file this Mac evicted nor the one the library’s fingerprint names' : 'its fingerprint doesn’t match the library’s'
  }
  if (item.evicted) return 'its md5 doesn’t match the file this Mac evicted'
  return null   // no identity on record: homemini's own size (checked above) is all there is
}
