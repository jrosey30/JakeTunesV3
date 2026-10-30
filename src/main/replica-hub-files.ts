/**
 * Replica hub files (2026-10-20) — two things the MacBook knows that a replica
 * (workmini) never had, pulled from homemini on a timer instead of waiting for
 * the daily deploy to copy them:
 *
 *   • release-kinds.json — what each album IS (album / EP / single / live /
 *     compilation). A replica never resolves these itself (release-kinds.ts),
 *     and the deploy is what used to copy the MacBook's file over; without it
 *     workmini's artist pages filed 164 of 2,598 albums under the wrong
 *     section. GET /api/release-kinds serves homemini's copy (the file the
 *     MacBook mirrors to the NAS, the same one the phone's rows are stamped
 *     from).
 *   • playlist covers — the pictures Jake picks for a playlist or a tape on
 *     the MacBook (userData/playlist-covers/<id>.jpg). The MacBook → homemini
 *     sync already carries them and the phone shows them; workmini had no
 *     folder at all. GET /api/playlist-covers lists homemini's copies, and
 *     each changed one is fetched from /api/playlist-cover/<id>.
 *   • lyrics.json (2026-10-29) — the MacBook's grounded lyrics (its nightly
 *     enrichment is the single writer). workmini's copy froze on 10-26, 43
 *     songs behind, because only the deploy ever copied it.
 *     GET /api/lyrics-file serves homemini's copy (the NAS file the phone's
 *     /api/lyrics/:id reads); landing it drops Get Info's in-memory cache.
 *
 * Rules, every leg:
 *   • the hub's copy wins — a hub entry, cover or lyric replaces this machine's;
 *   • missing is not empty — a hub reply that lacks an album or a cover
 *     never removes one this machine has, and an empty or unreadable reply
 *     changes nothing;
 *   • inert on the canonical MacBook (hubBase() is null there), and every
 *     poll after the first is a conditional request (304 = no bytes).
 *
 * Nothing here is on the playback path, and nothing reads the NAS.
 *
 * ⚠️ TWIN: ~/JakeTunesMobile backend/src/routes/replicaFiles.ts (the
 * routes) + backend/src/util/replicaFiles.ts (their pure halves).
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeReleaseKinds, readReleaseKinds } from './release-kinds.ts'
import { writeJsonAtomic } from './atomic-write.ts'
import { withCompanionInit } from './hub-companion.ts'
import type { ReleaseKindsFile } from '../common/release-kind.ts'

/** How often a replica re-asks. Conditional, so an unchanged hub costs a 304. */
export const REPLICA_HUB_FILES_INTERVAL_MS = 2 * 60_000
const REQUEST_TIMEOUT_MS = 30_000
/** lyrics.json is ~30 MB over the tailnet: a longer cap than the small files. */
const LYRICS_TIMEOUT_MS = 120_000

type Log = (msg: string) => void

/** One HTTP problem per change of problem, not one per 2-minute tick. */
function problemLogger(log: Log, tag: string): (problem: string) => void {
  let last = ''
  return (problem) => {
    if (problem && problem !== last) log(`[${tag}] homemini copy unavailable: ${problem}`)
    last = problem
  }
}

// ── release kinds ──────────────────────────────────────────────────────────

/**
 * Pure: the file a replica keeps after the hub answered. Hub entries win
 * album by album; an album only this machine has is kept. Null = nothing to
 * write (the hub copy is empty, or adds nothing this machine lacks).
 */
export function adoptHubReleaseKinds(local: ReleaseKindsFile, hub: ReleaseKindsFile): ReleaseKindsFile | null {
  const hubAlbums = Object.keys(hub.albums)
  if (hubAlbums.length === 0) return null
  let changed = hub.updatedAt !== local.updatedAt
  const albums = { ...local.albums }
  for (const k of hubAlbums) {
    const h = hub.albums[k]
    const cur = albums[k]
    if (!cur || cur.kind !== h.kind || cur.source !== h.source || cur.mbid !== h.mbid || cur.checkedAt !== h.checkedAt) changed = true
    albums[k] = h
  }
  if (!changed) return null
  return { version: 1, updatedAt: hub.updatedAt || local.updatedAt, albums }
}

export interface ReleaseKindsPullDeps {
  /** Absolute path of this machine's release-kinds.json. */
  file: string
  /** Hub origin on a replica; null on the canonical MacBook. */
  hubBase: () => Promise<string | null>
  fetchImpl?: typeof fetch
  log?: Log
}

export interface ReleaseKindsPuller {
  /** One pull. Resolves true when the file was rewritten. Never throws. */
  pull: () => Promise<boolean>
}

export function createReleaseKindsPuller(deps: ReleaseKindsPullDeps): ReleaseKindsPuller {
  const log = deps.log ?? ((m: string) => console.log(m))
  const problem = problemLogger(log, 'release-kinds')
  let etag = ''
  let busy = false
  async function pull(): Promise<boolean> {
    if (busy) return false
    busy = true
    try {
      const base = await deps.hubBase()
      if (!base) return false
      const headers: Record<string, string> = { accept: 'application/json' }
      if (etag) headers['If-None-Match'] = etag
      let res: Response
      let raw: string
      try {
        res = await (deps.fetchImpl ?? fetch)(`${base.replace(/\/$/, '')}/api/release-kinds`, withCompanionInit({ headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }))
        if (res.status === 304) { problem(''); return false }
        if (!res.ok) { problem(`HTTP ${res.status}`); return false }   // 404 = no copy yet, or a hub older than the route
        raw = await res.text()
      } catch (err) {
        problem(err instanceof Error ? err.message : String(err))
        return false
      }
      problem('')
      let hub: ReleaseKindsFile
      try {
        hub = normalizeReleaseKinds(JSON.parse(raw))
      } catch {
        log('[release-kinds] homemini copy did not parse — keeping this machine\'s')
        return false
      }
      const next = adoptHubReleaseKinds(await readReleaseKinds(deps.file), hub)
      // Remember the validator only once the body has been dealt with, so a
      // failed write is retried with a full download, not answered 304.
      if (!next) { etag = res.headers.get('etag') ?? ''; return false }
      await writeJsonAtomic(deps.file, next)
      etag = res.headers.get('etag') ?? ''
      log(`[release-kinds] adopted homemini's copy: ${Object.keys(next.albums).length} albums (updated ${next.updatedAt || 'n/a'})`)
      return true
    } catch (err) {
      log(`[release-kinds] pull failed (will retry): ${err instanceof Error ? err.message : String(err)}`)
      return false
    } finally {
      busy = false
    }
  }
  return { pull }
}

// ── lyrics ─────────────────────────────────────────────────────────────────

/** lyrics.json: String(track.id) → a record (ipc/lyrics-ipc.ts LyricsRecord). The
 *  merge never looks inside a record, so it stays shape-agnostic. */
export type LyricsFile = Record<string, Record<string, unknown>>

/** Pure: the hub's body, validated — a plain object; rows that are not
 *  records are dropped. Null = not a lyrics file at all. */
export function parseHubLyrics(raw: unknown): LyricsFile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: LyricsFile = {}
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[id] = v as Record<string, unknown>
  }
  return out
}

/**
 * Pure: the file a replica keeps after the hub answered. Hub entries win
 * track by track; a track only this machine has is kept. Null = nothing to
 * write (the hub copy is empty, or matches what this machine has).
 * ⚠️ TWIN: Mobile util/replicaFiles.ts isLyricsBody (refuses an empty body).
 */
export function adoptHubLyrics(local: LyricsFile, hub: LyricsFile): { file: LyricsFile; added: number; changed: number } | null {
  const ids = Object.keys(hub)
  if (ids.length === 0) return null
  const file: LyricsFile = { ...local }
  let added = 0
  let changed = 0
  for (const id of ids) {
    const cur = file[id]
    if (!cur) added++
    else if (JSON.stringify(cur) !== JSON.stringify(hub[id])) changed++
    file[id] = hub[id]
  }
  return added || changed ? { file, added, changed } : null
}

/** This machine's lyrics.json; a missing or unreadable one is empty (the
 *  hub's copy is the MacBook's, so adopting it over a torn file is right). */
async function readLyricsFile(file: string, log: Log): Promise<LyricsFile> {
  try {
    return parseHubLyrics(JSON.parse(await readFile(file, 'utf-8'))) ?? {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') log(`[lyrics] this machine's copy is unreadable — adopting homemini's: ${err instanceof Error ? err.message : String(err)}`)
    return {}
  }
}

export interface LyricsPullDeps {
  /** Absolute path of this machine's lyrics.json (STATE_DIR). */
  file: string
  /** Hub origin on a replica; null on the canonical MacBook. */
  hubBase: () => Promise<string | null>
  /** The file was rewritten: drop any in-memory copy (Get Info's cache). */
  onAdopted?: () => void
  fetchImpl?: typeof fetch
  log?: Log
}

export function createLyricsPuller(deps: LyricsPullDeps): { pull: () => Promise<boolean> } {
  const log = deps.log ?? ((m: string) => console.log(m))
  const problem = problemLogger(log, 'lyrics')
  let etag = ''
  let busy = false
  async function pull(): Promise<boolean> {
    if (busy) return false
    busy = true
    try {
      const base = await deps.hubBase()
      if (!base) return false
      const headers: Record<string, string> = { accept: 'application/json' }
      if (etag) headers['If-None-Match'] = etag
      let res: Response
      let raw: string
      try {
        // ~30 MB, but only when the MacBook rewrote it; every other poll is a 304.
        res = await (deps.fetchImpl ?? fetch)(`${base.replace(/\/$/, '')}/api/lyrics-file`, withCompanionInit({ headers, signal: AbortSignal.timeout(LYRICS_TIMEOUT_MS) }))
        if (res.status === 304) { problem(''); return false }
        if (!res.ok) { problem(`HTTP ${res.status}`); return false }   // 404 = no copy yet, or a hub older than the route
        raw = await res.text()
      } catch (err) {
        problem(err instanceof Error ? err.message : String(err))
        return false
      }
      problem('')
      let hub: LyricsFile | null
      try { hub = parseHubLyrics(JSON.parse(raw)) } catch { hub = null }
      if (!hub) { log('[lyrics] homemini copy did not parse — keeping this machine\'s'); return false }
      const next = adoptHubLyrics(await readLyricsFile(deps.file, log), hub)
      // Remember the validator only once the body has been dealt with, so a
      // failed write is retried with a full download, not answered 304.
      if (!next) { etag = res.headers.get('etag') ?? ''; return false }
      await writeJsonAtomic(deps.file, next.file, false)   // compact, like scripts/lyrics-fetch.mjs
      etag = res.headers.get('etag') ?? ''
      deps.onAdopted?.()
      log(`[lyrics] adopted homemini's copy: ${Object.keys(next.file).length} tracks (+${next.added} new, ${next.changed} changed)`)
      return true
    } catch (err) {
      log(`[lyrics] pull failed (will retry): ${err instanceof Error ? err.message : String(err)}`)
      return false
    } finally {
      busy = false
    }
  }
  return { pull }
}

// ── playlist covers ────────────────────────────────────────────────────────

export interface HubCoverItem { id: string; bytes: number; mtimeMs: number }

/** What this machine last fetched for an id: the hub file's size + mtime. */
export type CoverMirrorRecord = Record<string, { bytes: number; mtimeMs: number }>

/** The record file, beside the covers folder in userData. */
export const COVER_MIRROR_RECORD = 'playlist-covers-mirror.json'

/** Same rule as playlist-covers.ts safeId: the id becomes a file name. */
export function isSafeCoverId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(id) && !id.includes('..')
}

/** Pure: the hub's listing, validated. Anything malformed is dropped. */
export function parseHubCoverList(raw: unknown): HubCoverItem[] | null {
  if (!raw || typeof raw !== 'object') return null
  const items = (raw as { items?: unknown }).items
  if (!Array.isArray(items)) return null
  const out: HubCoverItem[] = []
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const { id, bytes, mtimeMs } = it as { id?: unknown; bytes?: unknown; mtimeMs?: unknown }
    if (!isSafeCoverId(id)) continue
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) continue
    if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) continue
    out.push({ id, bytes, mtimeMs })
  }
  return out
}

/**
 * Pure: which covers to fetch. A cover is fetched when this machine has no
 * file for it, or when the hub's copy changed since the last fetch (a new
 * pick on the MacBook). A cover picked on this machine is not refetched
 * while the hub's copy stays the one already fetched, and nothing is ever
 * deleted here.
 */
export function coversToFetch(hub: readonly HubCoverItem[], record: CoverMirrorRecord, haveFile: ReadonlySet<string>): HubCoverItem[] {
  return hub.filter((h) => {
    const r = record[h.id]
    if (!haveFile.has(h.id)) return true
    return !r || r.bytes !== h.bytes || r.mtimeMs !== h.mtimeMs
  })
}

export interface CoverMirrorDeps {
  /** userData/playlist-covers — the folder playlist-covers.ts serves from. */
  dir: string
  /** Where the fetch record lives (userData/playlist-covers-mirror.json). */
  recordFile: string
  hubBase: () => Promise<string | null>
  /** A cover landed: the renderer re-reads its cover map. */
  notify?: (ids: string[]) => void
  fetchImpl?: typeof fetch
  log?: Log
  /** Covers fetched per tick (default 4) — a few hundred KB each. */
  perTick?: number
}

export interface CoverMirror {
  /** One pass. Resolves the ids that landed. Never throws. */
  tick: () => Promise<string[]>
}

async function readRecord(file: string): Promise<CoverMirrorRecord> {
  try {
    const o = JSON.parse(await readFile(file, 'utf-8')) as unknown
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {}
    const out: CoverMirrorRecord = {}
    for (const [id, v] of Object.entries(o as Record<string, unknown>)) {
      const r = v as { bytes?: unknown; mtimeMs?: unknown }
      if (isSafeCoverId(id) && typeof r?.bytes === 'number' && typeof r?.mtimeMs === 'number') out[id] = { bytes: r.bytes, mtimeMs: r.mtimeMs }
    }
    return out
  } catch {
    return {}   // first run, or a torn record: the worst case is one refetch per cover
  }
}

export function createCoverMirror(deps: CoverMirrorDeps): CoverMirror {
  const log = deps.log ?? ((m: string) => console.log(m))
  const problem = problemLogger(log, 'playlist-covers')
  const fetchImpl = deps.fetchImpl ?? fetch
  const perTick = Math.max(1, deps.perTick ?? 4)
  let listEtag = ''
  let backlog = false
  let busy = false

  async function haveFiles(ids: readonly string[]): Promise<Set<string>> {
    const have = new Set<string>()
    for (const id of ids) {
      const st = await stat(join(deps.dir, `${id}.jpg`)).catch((err: NodeJS.ErrnoException) => {
        if (err?.code !== 'ENOENT') log(`[playlist-covers] stat ${id}.jpg failed: ${err?.message ?? err}`)
        return null
      })
      if (st && st.isFile() && st.size > 0) have.add(id)
    }
    return have
  }

  async function tick(): Promise<string[]> {
    if (busy) return []
    busy = true
    try {
      const base = await deps.hubBase()
      if (!base) return []
      const origin = base.replace(/\/$/, '')
      const headers: Record<string, string> = { accept: 'application/json' }
      // A listing we could not finish fetching last time is asked for whole.
      if (listEtag && !backlog) headers['If-None-Match'] = listEtag
      let items: HubCoverItem[] | null
      let etag: string
      try {
        const res = await fetchImpl(`${origin}/api/playlist-covers`, withCompanionInit({ headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }))
        if (res.status === 304) { problem(''); return [] }
        if (!res.ok) { problem(`HTTP ${res.status}`); return [] }   // 404 = a hub older than the route
        items = parseHubCoverList(await res.json())
        etag = res.headers.get('etag') ?? ''
      } catch (err) {
        problem(err instanceof Error ? err.message : String(err))
        return []
      }
      problem('')
      if (!items) { log('[playlist-covers] homemini listing was malformed — nothing changed'); return [] }
      const record = await readRecord(deps.recordFile)
      const todo = coversToFetch(items, record, await haveFiles(items.map((i) => i.id)))
      const landed: string[] = []
      for (const item of todo.slice(0, perTick)) {
        try {
          const res = await fetchImpl(`${origin}/api/playlist-cover/${encodeURIComponent(item.id)}`, withCompanionInit({ signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }))
          if (!res.ok) { log(`[playlist-covers] ${item.id}: HTTP ${res.status} — retried next pass`); continue }
          const bytes = Buffer.from(await res.arrayBuffer())
          if (bytes.length === 0) { log(`[playlist-covers] ${item.id}: empty reply — retried next pass`); continue }
          await mkdir(deps.dir, { recursive: true })
          const dest = join(deps.dir, `${item.id}.jpg`)
          const tmp = `${dest}.${process.pid}.tmp`
          await writeFile(tmp, bytes)
          await rename(tmp, dest)
          record[item.id] = { bytes: item.bytes, mtimeMs: item.mtimeMs }
          landed.push(item.id)
        } catch (err) {
          log(`[playlist-covers] ${item.id}: ${err instanceof Error ? err.message : String(err)} — retried next pass`)
        }
      }
      if (landed.length) {
        await writeJsonAtomic(deps.recordFile, record)
        log(`[playlist-covers] mirrored ${landed.length} cover(s) from homemini: ${landed.join(', ')}`)
        deps.notify?.(landed)
      }
      // Done with this listing only when every cover it named is here.
      backlog = todo.length > landed.length
      listEtag = backlog ? '' : etag
      return landed
    } catch (err) {
      log(`[playlist-covers] pass failed (will retry): ${err instanceof Error ? err.message : String(err)}`)
      return []
    } finally {
      busy = false
    }
  }
  return { tick }
}

/** Run `tick` shortly after boot, then on the interval. Returns a stop. */
export function startReplicaTimer(tick: () => Promise<unknown>, firstDelayMs: number, intervalMs = REPLICA_HUB_FILES_INTERVAL_MS): () => void {
  let interval: ReturnType<typeof setInterval> | null = null
  const first = setTimeout(() => {
    void tick()
    interval = setInterval(() => { void tick() }, intervalMs)
    interval.unref?.()
  }, firstDelayMs)
  first.unref?.()
  return () => { clearTimeout(first); if (interval) clearInterval(interval) }
}
