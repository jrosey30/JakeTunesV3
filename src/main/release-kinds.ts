/**
 * Release kinds resolver (Jake, 2026-10-18: group an artist's discography
 * into albums, EPs, singles, live and compilations — desktop and phone).
 *
 * Each album in the library (rows grouped by albumArtist || artist, album) is
 * asked about ONCE on MusicBrainz's release-group search. The answer goes
 * through the shared rulebook (src/common/release-kind.ts) and is stored in
 * release-kinds.json next to metadata-overrides.json (STATE_DIR, the local
 * userData). The LOCAL→NAS mirror (STATE_FILE_NAMES in index.ts) carries it to
 * /Volumes/JakeShared/JakeTunesState, which is the phone backend's STATE_DIR
 * on homemini.
 *
 * A MusicBrainz hit is ACCEPTED only when its title folds equal to the album's
 * lookup title AND one of its credited names folds equal to the album artist.
 * Several accepted hits that disagree on the kind = ambiguous = MusicBrainz is
 * not used. A miss (or an ambiguous answer) stores the title/shape result with
 * checkedAt, and is asked again after 30 days. Network failures store nothing
 * and are retried on the next run.
 *
 * Background and low priority: one request at a time through the app's shared
 * MusicBrainz throttle (≤ 1 per 1.1 s), 10 s timeout, first pass a few minutes
 * after boot, then a cheap re-scan every few minutes for newly imported
 * albums. Progress goes to the log only. Replicas (workmini) never resolve —
 * they adopt the catalog, and this file, from the canonical machine (pulled
 * from homemini by src/main/replica-hub-files.ts since 2026-10-20).
 *
 * Every write re-reads the file on disk and merges onto it (never onto a
 * snapshot from the start of the pass), then lands atomically (temp + fsync +
 * rename, writeJsonAtomic).
 */
import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import {
  classifyRelease, kindFromMusicBrainz, releaseTitleForLookup, RELEASE_KIND_ORDER, RELEASE_KINDS_FILE,
  type MbReleaseType, type ReleaseKind, type ReleaseKindsFile, type ReleaseKindSource,
} from '../common/release-kind.ts'
import { collectAlbumFacts, type AlbumFacts, type AlbumRow } from '../common/release-sections.ts'
import { nameKey } from '../common/fold-text.ts'
import { writeJsonAtomic } from './atomic-write.ts'

export type ReleaseKindEntry = ReleaseKindsFile['albums'][string]

/** release-kinds.json in the state dir — beside metadata-overrides.json. */
export const releaseKindsPath = (stateDir: string): string => join(stateDir, RELEASE_KINDS_FILE)

/** A miss is asked again after this long. */
export const RELEASE_RECHECK_MS = 30 * 24 * 3600 * 1000

const SOURCES: readonly ReleaseKindSource[] = ['manual', 'musicbrainz', 'title', 'shape', 'default']

export function emptyReleaseKinds(): ReleaseKindsFile {
  return { version: 1, updatedAt: '', albums: {} }
}

/** Keep only well-formed entries; anything else in the file is ignored, not trusted. */
export function normalizeReleaseKinds(raw: unknown): ReleaseKindsFile {
  const out = emptyReleaseKinds()
  if (!raw || typeof raw !== 'object') return out
  const r = raw as { updatedAt?: unknown; albums?: unknown }
  if (typeof r.updatedAt === 'string') out.updatedAt = r.updatedAt
  if (!r.albums || typeof r.albums !== 'object') return out
  for (const [k, v] of Object.entries(r.albums as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const e = v as { kind?: unknown; source?: unknown; mbid?: unknown; checkedAt?: unknown }
    if (!(RELEASE_KIND_ORDER as readonly unknown[]).includes(e.kind)) continue
    if (!(SOURCES as readonly unknown[]).includes(e.source)) continue
    const entry: ReleaseKindEntry = { kind: e.kind as ReleaseKind, source: e.source as ReleaseKindSource }
    if (typeof e.mbid === 'string' && e.mbid) entry.mbid = e.mbid
    if (typeof e.checkedAt === 'string' && e.checkedAt) entry.checkedAt = e.checkedAt
    out.albums[k] = entry
  }
  return out
}

/** Read-only load (IPC). Missing or unreadable → empty; never touches the file. */
export async function readReleaseKinds(file: string): Promise<ReleaseKindsFile> {
  try {
    return normalizeReleaseKinds(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return emptyReleaseKinds()
  }
}

/**
 * The writer's load. A file that exists but does not parse is moved aside
 * (kept, never deleted) so the next write cannot merge onto nothing and wipe
 * it, and the job is not wedged on it forever.
 */
async function loadForWrite(file: string, log: (m: string) => void): Promise<ReleaseKindsFile> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return emptyReleaseKinds()
    throw err   // unreadable for another reason: do not write over it
  }
  try {
    return normalizeReleaseKinds(JSON.parse(text))
  } catch {
    const aside = `${file}.corrupt-${Date.now()}`
    await rename(file, aside)
    log(`[release-kinds] ${file} did not parse — kept as ${aside}, starting a fresh file`)
    return emptyReleaseKinds()
  }
}

/**
 * Merge updates onto the file as it is NOW. A manual entry is never
 * overwritten except by another manual one; a MusicBrainz answer is never
 * replaced by a title/shape guess.
 */
export function mergeReleaseKinds(fresh: ReleaseKindsFile, updates: Readonly<Record<string, ReleaseKindEntry>>, nowIso: string): ReleaseKindsFile {
  const albums = { ...fresh.albums }
  for (const [k, e] of Object.entries(updates)) {
    const cur = albums[k]
    if (cur?.source === 'manual' && e.source !== 'manual') continue
    if (cur?.source === 'musicbrainz' && e.source !== 'musicbrainz' && e.source !== 'manual') continue
    albums[k] = e
  }
  return { version: 1, updatedAt: nowIso, albums }
}

let writeChain: Promise<unknown> = Promise.resolve()

/** Re-read the file, merge, write atomically. Serialized within the process. */
export function writeReleaseKinds(
  file: string,
  updates: Readonly<Record<string, ReleaseKindEntry>>,
  opts: { nowIso: string; log?: (m: string) => void },
): Promise<ReleaseKindsFile> {
  const log = opts.log ?? ((m: string) => console.log(m))
  const run = writeChain.then(async () => {
    const fresh = await loadForWrite(file, log)
    const merged = mergeReleaseKinds(fresh, updates, opts.nowIso)
    await writeJsonAtomic(file, merged)
    return merged
  })
  // The caller gets the rejection; the chain only has to survive it.
  writeChain = run.catch(() => undefined)
  return run
}

/** Ask MusicBrainz about this album? Never for manual or MusicBrainz answers; misses after 30 days. */
export function needsLookup(entry: ReleaseKindEntry | undefined, now: number): boolean {
  if (!entry) return true
  if (entry.source === 'manual' || entry.source === 'musicbrainz') return false
  const t = entry.checkedAt ? Date.parse(entry.checkedAt) : NaN
  if (!Number.isFinite(t)) return true
  return now - t > RELEASE_RECHECK_MS
}

// ── MusicBrainz ────────────────────────────────────────────────────────────

export interface MbArtistCredit { name?: string; joinphrase?: string; artist?: { id?: string; name?: string } }
export interface MbReleaseGroup {
  id?: string
  title?: string
  score?: number
  'primary-type'?: string | null
  'secondary-types'?: string[] | null
  'artist-credit'?: MbArtistCredit[]
}

/** Lucene phrase: only the quote and the backslash need escaping inside "…". */
function phrase(s: string): string {
  return s.replace(/[\\"]/g, (c) => `\\${c}`)
}

export function releaseGroupSearchUrl(album: string, artist: string): string {
  const q = `releasegroup:"${phrase(releaseTitleForLookup(album))}" AND artist:"${phrase(artist)}"`
  return `https://musicbrainz.org/ws/2/release-group?query=${encodeURIComponent(q)}&fmt=json&limit=10`
}

/** Every name a release group is credited under: each credit's name, the
 *  credited artist's own name, and the whole joined credit ("JAY-Z & Kanye West"). */
export function creditNames(rg: MbReleaseGroup): string[] {
  const credits = rg['artist-credit'] ?? []
  const names: string[] = []
  let joined = ''
  for (const c of credits) {
    if (c.name) names.push(c.name)
    if (c.artist?.name) names.push(c.artist.name)
    joined += (c.name ?? c.artist?.name ?? '') + (c.joinphrase ?? '')
  }
  if (credits.length > 1 && joined.trim()) names.push(joined)
  return names
}

export function mbTypeOf(rg: MbReleaseGroup): MbReleaseType {
  return { primaryType: rg['primary-type'] ?? null, secondaryTypes: rg['secondary-types'] ?? [] }
}

/** The hits that are THIS album by THIS artist (exact folded title + credited name). */
export function acceptedReleaseGroups(groups: readonly MbReleaseGroup[], album: string, artist: string): MbReleaseGroup[] {
  const wantTitle = nameKey(releaseTitleForLookup(album))
  const wantArtist = nameKey(artist)
  if (!wantTitle || !wantArtist) return []
  return groups.filter((rg) => nameKey(rg.title) === wantTitle && creditNames(rg).some((n) => nameKey(n) === wantArtist))
}

export type MbVerdict =
  | { verdict: 'hit'; mb: MbReleaseType; mbid?: string }
  | { verdict: 'miss' }
  | { verdict: 'ambiguous'; kinds: Array<ReleaseKind | null> }

export function judgeReleaseGroups(groups: readonly MbReleaseGroup[], album: string, artist: string): MbVerdict {
  const hits = acceptedReleaseGroups(groups, album, artist)
  if (hits.length === 0) return { verdict: 'miss' }
  const kinds = [...new Set(hits.map((h) => kindFromMusicBrainz(mbTypeOf(h))))]
  if (kinds.length > 1) return { verdict: 'ambiguous', kinds }
  return { verdict: 'hit', mb: mbTypeOf(hits[0]), mbid: hits[0].id }
}

/** One release-group search. null = the request failed (retry next run). */
export async function lookupReleaseGroup(
  album: string,
  artist: string,
  opts: { userAgent: string; fetchFn?: typeof fetch; timeoutMs?: number },
): Promise<MbVerdict | null> {
  try {
    const res = await (opts.fetchFn ?? fetch)(releaseGroupSearchUrl(album, artist), {
      headers: { 'User-Agent': opts.userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { 'release-groups'?: MbReleaseGroup[] }
    return judgeReleaseGroups(Array.isArray(body?.['release-groups']) ? body['release-groups'] : [], album, artist)
  } catch {
    return null
  }
}

/** What gets stored for an album after MusicBrainz answered (hit, miss or ambiguous). */
export function entryFor(facts: AlbumFacts, v: MbVerdict, nowIso: string): ReleaseKindEntry {
  const r = classifyRelease({ ...facts, mb: v.verdict === 'hit' ? v.mb : null })
  const e: ReleaseKindEntry = { kind: r.kind, source: r.source, checkedAt: nowIso }
  if (r.source === 'musicbrainz' && v.verdict === 'hit' && v.mbid) e.mbid = v.mbid
  return e
}

// ── Library rows ───────────────────────────────────────────────────────────

const OVERRIDE_FIELDS = ['album', 'artist', 'albumArtist', 'trackCount', 'duration'] as const

/**
 * Library rows as the app shows them: metadata-overrides.json applied, with
 * the renderer's fingerprint rule (an override only applies to the track it
 * was saved against).
 * ⚠️ TWIN: src/renderer/App.tsx (metadata overrides apply — the fp check).
 */
export function effectiveAlbumRows(tracks: readonly unknown[], overrides: Readonly<Record<string, unknown>>): AlbumRow[] {
  const out: AlbumRow[] = []
  for (const raw of tracks) {
    if (!raw || typeof raw !== 'object') continue
    const t = raw as Record<string, unknown>
    const row: AlbumRow = {
      album: t.album as string, artist: t.artist as string, albumArtist: t.albumArtist as string,
      trackCount: t.trackCount as number, duration: t.duration as number,
    }
    const entry = overrides[String(t.id)] as { fp?: string; fields?: Record<string, unknown> } | undefined
    if (entry && typeof entry === 'object' && entry.fields && typeof entry.fields === 'object') {
      const fp = `${String(t.title ?? '').toLowerCase().trim()}|${String(t.artist ?? '').toLowerCase().trim()}|${t.duration || 0}`
      if (entry.fp === fp) {
        for (const f of OVERRIDE_FIELDS) {
          if (f in entry.fields) (row as Record<string, unknown>)[f] = entry.fields[f]
        }
      }
    }
    out.push(row)
  }
  return out
}

// ── The pass ───────────────────────────────────────────────────────────────

export interface ReleaseKindsPassDeps {
  /** Absolute path of release-kinds.json. */
  file: string
  /** Library rows with overrides applied (effectiveAlbumRows). */
  rows: () => Promise<readonly AlbumRow[]>
  /** The app's shared MusicBrainz throttle (index.ts mbThrottle, 1.1 s). */
  throttle: () => Promise<void>
  userAgent: string
  fetchFn?: typeof fetch
  now?: () => number
  log?: (m: string) => void
  /** Write after this many answers (default 25). */
  flushEvery?: number
  /** Give up on this pass after this many failed requests in a row (default 5). */
  maxConsecutiveFailures?: number
  /** Shared across passes so an outage is logged once, not once per run. */
  outage?: { open: boolean }
}

export interface ReleaseKindsPassResult {
  albums: number
  asked: number
  hits: number
  misses: number
  ambiguous: number
  failures: number
  refreshed: number
  remaining: number
}

export async function runReleaseKindsPass(deps: ReleaseKindsPassDeps): Promise<ReleaseKindsPassResult> {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((m: string) => console.log(m))
  const flushEvery = Math.max(1, deps.flushEvery ?? 25)
  const maxFails = Math.max(1, deps.maxConsecutiveFailures ?? 5)
  const facts = collectAlbumFacts(await deps.rows(), nameKey)
  let current = await readReleaseKinds(deps.file)
  const res: ReleaseKindsPassResult = { albums: facts.size, asked: 0, hits: 0, misses: 0, ambiguous: 0, failures: 0, refreshed: 0, remaining: 0 }

  // A stored title/shape answer that is not due yet still follows the
  // library: finishing an EP's tracklist or retitling it re-classifies it
  // at no network cost (checkedAt kept, so the 30-day clock is unchanged).
  const refresh: Record<string, ReleaseKindEntry> = {}
  for (const [key, f] of facts) {
    const e = current.albums[key]
    if (!e || e.source === 'manual' || e.source === 'musicbrainz' || needsLookup(e, now())) continue
    const r = classifyRelease({ ...f, mb: null })
    if (r.kind !== e.kind || r.source !== e.source) refresh[key] = { ...e, kind: r.kind, source: r.source }
  }
  if (Object.keys(refresh).length) {
    current = await writeReleaseKinds(deps.file, refresh, { nowIso: new Date(now()).toISOString(), log })
    res.refreshed = Object.keys(refresh).length
  }

  const todo = [...facts.values()].filter((f) => needsLookup(current.albums[f.key], now()))
  if (todo.length === 0) return res
  const outage = deps.outage ?? { open: false }
  if (!outage.open) log(`[release-kinds] ${todo.length} of ${facts.size} albums to look up on MusicBrainz`)

  let pending: Record<string, ReleaseKindEntry> = {}
  let pendingCount = 0
  let consecutiveFails = 0
  const flush = async (): Promise<void> => {
    if (pendingCount === 0) return
    const batch = pending
    pending = {}
    pendingCount = 0
    current = await writeReleaseKinds(deps.file, batch, { nowIso: new Date(now()).toISOString(), log })
  }

  let i = 0
  for (; i < todo.length; i++) {
    const f = todo[i]
    // Another writer (or a sync landing a fresher file) may have answered it since the pass began.
    if (!needsLookup(current.albums[f.key], now())) continue
    await deps.throttle()
    const v = await lookupReleaseGroup(f.album, f.artist, { userAgent: deps.userAgent, fetchFn: deps.fetchFn })
    if (!v) {
      res.failures++
      consecutiveFails++
      if (!outage.open) { outage.open = true; log('[release-kinds] MusicBrainz unreachable or refusing — unanswered albums are retried on later runs (logged once)') }
      if (consecutiveFails >= maxFails) { i++; break }   // likely offline: stop asking until the next run
      continue
    }
    consecutiveFails = 0
    if (outage.open) { outage.open = false; log('[release-kinds] MusicBrainz answering again') }
    res.asked++
    if (v.verdict === 'hit') res.hits++
    else if (v.verdict === 'ambiguous') res.ambiguous++
    else res.misses++
    pending[f.key] = entryFor(f, v, new Date(now()).toISOString())
    pendingCount++
    if (pendingCount >= flushEvery) await flush()
    if (res.asked % 100 === 0) log(`[release-kinds] ${res.asked}/${todo.length} asked (${res.hits} found, ${res.misses} not found, ${res.ambiguous} ambiguous)`)
  }
  await flush()
  res.remaining = todo.slice(i).filter((f) => needsLookup(current.albums[f.key], now())).length + res.failures
  if (res.asked > 0) log(`[release-kinds] pass done: ${res.asked} asked (${res.hits} found, ${res.misses} not found, ${res.ambiguous} ambiguous), ${res.failures} failed, ${res.remaining} left for later${res.refreshed ? `, ${res.refreshed} re-classified` : ''}`)
  return res
}

// ── The background job ─────────────────────────────────────────────────────

export interface ReleaseKindsJobDeps extends ReleaseKindsPassDeps {
  /** True on a replica (streamSource homemini / streamRoot) — it never resolves. */
  isReplica: () => Promise<boolean>
  /** First pass this long after boot (default 6 min). */
  firstDelayMs?: number
  /** Then re-scan this often for new albums (default 10 min; a pass with nothing to ask costs one library walk). */
  intervalMs?: number
}

export function startReleaseKindsJob(deps: ReleaseKindsJobDeps): { stop: () => void; runNow: () => Promise<void> } {
  const log = deps.log ?? ((m: string) => console.log(m))
  const outage = deps.outage ?? { open: false }
  let busy = false
  let replicaLogged = false
  const tick = async (): Promise<void> => {
    if (busy) return
    busy = true
    try {
      if (await deps.isReplica()) {
        // The replica's copy is homemini's, pulled by src/main/replica-hub-files.ts.
        if (!replicaLogged) { replicaLogged = true; log('[release-kinds] replica: not resolving (homemini\'s copy of the canonical file is pulled instead)') }
        return
      }
      await runReleaseKindsPass({ ...deps, outage })
    } catch (err) {
      log(`[release-kinds] pass failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      busy = false
    }
  }
  let interval: ReturnType<typeof setInterval> | null = null
  const first = setTimeout(() => {
    void tick()
    interval = setInterval(() => { void tick() }, deps.intervalMs ?? 10 * 60_000)
    interval.unref?.()
  }, deps.firstDelayMs ?? 6 * 60_000)
  first.unref?.()
  return {
    stop: () => { clearTimeout(first); if (interval) clearInterval(interval) },
    runNow: tick,
  }
}
