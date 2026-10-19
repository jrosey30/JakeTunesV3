// Replica concert mirror (2026-10-19). Jake: "the workmini should mimic the
// live concert thing exactly. how they are on the macbook".
//
// A replica (workmini) adopts its library from homemini (hub-catalog.ts). The
// Live Concerts section also needs three laptop-owned things, and none of them
// had a working path to a replica:
//   • live-sets.json — the concert grouping, cues, facts, notes, promoted ids.
//     Only the laptop's deploy push copied it, and that has failed nightly
//     since August.
//   • the poster — custom artwork keyed `band|||show` in the artwork index.
//     The deploy copies jpg + meta.json but not index.json, and meta.json only
//     ADDS missing keys, so a poster the laptop later replaced stayed stale
//     (workmini's Postal Service poster was an older image).
//   • the crowd clip — userData/concert-crowd/<mergedTrackId>.m4a. Never
//     reached a replica at all.
// homemini already holds the laptop's canonical copy of each (live-sets.json
// in the NAS state dir, its artwork mirror, concert-crowd/ beside it), so the
// replica PULLS over the hub's HTTP — never the NAS, whose mount is disabled
// on workmini on purpose. The laptop stays the only writer.
//
// Electron-free: every path, cache and fetch is injected so node --test loads it.
// ⚠️ TWIN: ~/JakeTunesMobile backend/src/util/concertMirror.ts + routes/liveSets.ts
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { declaredConcerts, type ConcertSetLike, type ConcertTrackLike } from '../common/concert-meta.ts'
import { withCompanionInit } from './hub-companion.ts'

/** A live-sets.json entry as far as this module reads it (main's LiveSetEntry satisfies it). */
export type ReplicaLiveSet = ConcertSetLike

export interface ReplicaTrackRow {
  id: number | string
  artist?: string
  album?: string
  year?: number | string
}

export interface ReplicaConcertDeps {
  /** Hub origin on a replica; null on the canonical laptop (then all inert). */
  hubBase: () => Promise<string | null>
  /** The live-sets JsonFileCache (the replica's single writer of that file). */
  liveSets: {
    get: () => Promise<Record<string, ReplicaLiveSet>>
    set: (next: Record<string, ReplicaLiveSet>) => void
  }
  /** This replica's library rows (to read each concert's band/show). */
  tracks: () => Promise<readonly unknown[]>
  artwork: {
    dir: string
    loadIndex: () => Promise<Record<string, string>>
    saveIndex: (index: Record<string, string>) => Promise<void>
  }
  /** userData/concert-crowd */
  crowdDir: string
  /** Tell the renderer: reload live sets, and/or adopt these artwork keys. */
  notify: (update: { liveSets: boolean; artwork: Array<{ key: string; hash: string }> }) => void
  fetchImpl?: typeof fetch
  log?: (msg: string) => void
  intervalMs?: number
  timeoutMs?: number
}

const BARE_HASH = /^[0-9a-f]{32}$/
const MAX_POSTER_BYTES = 25 * 1024 * 1024
const MAX_CROWD_BYTES = 8 * 1024 * 1024
const CROWD_MISS_TTL_MS = 10 * 60_000

/**
 * Parse the hub's raw live-sets.json body. Every entry must look like a
 * declared set (numeric mergedTrackId, cues array); anything else rejects the
 * WHOLE body — a half-understood file is not adopted.
 */
export function parseLiveSetsBody(body: string): Record<string, ReplicaLiveSet> | null {
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  for (const v of Object.values(parsed as Record<string, unknown>)) {
    const e = v as ReplicaLiveSet | null
    if (!e || typeof e !== 'object' || typeof e.mergedTrackId !== 'number' || !Array.isArray(e.cues)) return null
  }
  return parsed as Record<string, ReplicaLiveSet>
}

/**
 * Should the replica replace its live sets with the hub's? Only when they
 * differ, and never when the hub's copy is EMPTY while this one is not (the
 * same "an empty snapshot can never blank the library" rule the catalog merge
 * keeps — an empty file on the hub is far likelier a glitch than Jake
 * undeclaring every concert at once).
 */
export function liveSetsAdoptDecision(
  local: Record<string, ReplicaLiveSet>,
  remote: Record<string, ReplicaLiveSet>,
): 'adopt' | 'same' | 'refuse-empty' {
  if (JSON.stringify(local) === JSON.stringify(remote)) return 'same'
  if (Object.keys(remote).length === 0 && Object.keys(local).length > 0) return 'refuse-empty'
  return 'adopt'
}

/**
 * The artwork keys a concert is drawn with, exactly as the renderer looks
 * them up: the concert page / Live Concerts wall use `band|||show`
 * (common/concert-meta.ts declaredConcerts → lookupArtwork), and the album
 * grid uses the merged track's own `artist|||album` ("… (Live Set)").
 */
export function concertArtworkKeys(
  sets: Record<string, ReplicaLiveSet>,
  rows: readonly ReplicaTrackRow[],
): string[] {
  const byId = new Map<number, ConcertTrackLike>(rows.map((t) => [Number(t.id), { id: Number(t.id), artist: t.artist, album: t.album, year: t.year }]))
  const key = (a: string | null | undefined, b: string | null | undefined) => `${(a || '').toLowerCase().trim()}|||${(b || '').toLowerCase().trim()}`
  const out = new Set<string>()
  for (const c of declaredConcerts(sets, (id) => byId.get(Number(id)))) {
    if (c.band && c.show) out.add(key(c.band, c.show))
    const merged = byId.get(Number(c.entry.mergedTrackId))
    if (merged?.artist && merged?.album) out.add(key(merged.artist, merged.album))
  }
  return [...out]
}

function isTrackRow(v: unknown): v is ReplicaTrackRow {
  if (!v || typeof v !== 'object') return false
  const id = (v as { id?: unknown }).id
  return typeof id === 'number' || (typeof id === 'string' && id !== '')
}

export interface ReplicaConcertHandle {
  stop: () => void
  tick: () => Promise<void>
  /** Crowd clip for a show: the local copy, else the hub's (cached locally). */
  crowdClip: (mergedTrackId: number) => Promise<Buffer | null>
}

export function startReplicaConcertSync(deps: ReplicaConcertDeps): ReplicaConcertHandle {
  const log = deps.log ?? ((m: string) => console.log(m))
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? 30_000
  let liveEtag: string | null = null
  let inFlight = false
  let stopped = false
  const crowdMiss = new Map<number, number>()

  async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      return await fetchImpl(url, withCompanionInit({ signal: ctrl.signal, headers }))
    } finally { clearTimeout(timer) }
  }

  async function writeAtomic(path: string, data: Buffer | string): Promise<void> {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, data)
    await rename(tmp, path)
  }

  async function exists(path: string): Promise<boolean> {
    try { return (await stat(path)).size > 0 } catch { return false }
  }

  /** Returns true when the replica's live sets changed. */
  async function pullLiveSets(origin: string): Promise<boolean> {
    const res = await get(`${origin}/api/live-sets/sidecar`, liveEtag ? { 'If-None-Match': liveEtag } : {})
    if (res.status === 304) return false
    if (res.status === 404) return false            // a hub without the route: leave ours alone
    if (!res.ok) throw new Error(`live-sets sidecar HTTP ${res.status}`)
    const payload = (await res.json()) as { body?: unknown }
    const remote = typeof payload.body === 'string' ? parseLiveSetsBody(payload.body) : null
    if (!remote) throw new Error('live-sets sidecar body did not parse as live sets')
    const decision = liveSetsAdoptDecision(await deps.liveSets.get(), remote)
    liveEtag = res.headers.get('etag')
    if (decision === 'refuse-empty') {
      log('[replica-concerts] hub live-sets.json is EMPTY while ours is not — kept ours')
      return false
    }
    if (decision === 'same') return false
    deps.liveSets.set(remote)
    log(`[replica-concerts] adopted live-sets.json from the hub (${Object.keys(remote).length} sets)`)
    return true
  }

  /** Bring each concert's poster key in line with the laptop's. */
  async function pullPosters(origin: string): Promise<Array<{ key: string; hash: string }>> {
    const keys = concertArtworkKeys(await deps.liveSets.get(), (await deps.tracks()).filter(isTrackRow))
    if (!keys.length) return []
    const qs = keys.map((k) => `key=${encodeURIComponent(k)}`).join('&')
    const res = await get(`${origin}/api/live-sets/artwork?${qs}`, { accept: 'application/json' })
    if (res.status === 404) return []                // older hub
    if (!res.ok) throw new Error(`live-sets artwork HTTP ${res.status}`)
    const items = ((await res.json()) as { items?: Record<string, unknown> }).items ?? {}
    const index = await deps.artwork.loadIndex()
    const changed: Array<{ key: string; hash: string }> = []
    for (const key of keys) {
      const hash = items[key]
      // null = the laptop has no art for this key: never delete ours.
      if (typeof hash !== 'string' || !hash || index[key] === hash) continue
      const bare = hash.replace(/_\d+$/, '')
      if (!BARE_HASH.test(bare)) continue
      const jpg = join(deps.artwork.dir, `${bare}.jpg`)
      if (!(await exists(jpg))) {
        const img = await get(`${origin}/artwork/${bare}`, { accept: 'image/*' })
        const type = img.headers.get('content-type') || ''
        if (!img.ok || !type.startsWith('image/')) {
          log(`[replica-concerts] poster ${bare} not on the hub (HTTP ${img.status}) — skipped ${key}`)
          continue
        }
        const bytes = Buffer.from(await img.arrayBuffer())
        if (bytes.length === 0 || bytes.length > MAX_POSTER_BYTES) continue
        await mkdir(deps.artwork.dir, { recursive: true })
        await writeAtomic(jpg, bytes)
      }
      changed.push({ key, hash })
    }
    if (changed.length) {
      // Fresh load right before the save: the index writer is serialized, and
      // this keeps the window for a concurrent edit as small as every other
      // load→save caller's.
      const latest = await deps.artwork.loadIndex()
      const next = { ...latest }
      for (const { key, hash } of changed) next[key] = hash
      await deps.artwork.saveIndex(next)
      log(`[replica-concerts] ${changed.length} concert poster key(s) now match the laptop`)
    }
    return changed
  }

  async function tick(): Promise<void> {
    if (stopped || inFlight) return
    inFlight = true
    try {
      const base = await deps.hubBase()
      if (!base) return
      const origin = base.replace(/\/$/, '')
      let liveChanged = false
      try { liveChanged = await pullLiveSets(origin) } catch (err) {
        log(`[replica-concerts] live-sets pull failed (will retry): ${(err as Error)?.message ?? err}`)
      }
      let artwork: Array<{ key: string; hash: string }> = []
      try { artwork = await pullPosters(origin) } catch (err) {
        log(`[replica-concerts] poster pull failed (will retry): ${(err as Error)?.message ?? err}`)
      }
      if (liveChanged || artwork.length) deps.notify({ liveSets: liveChanged, artwork })
    } finally {
      inFlight = false
    }
  }

  async function crowdClip(mergedTrackId: number): Promise<Buffer | null> {
    if (!Number.isInteger(mergedTrackId) || mergedTrackId < 0) return null
    const local = join(deps.crowdDir, `${mergedTrackId}.m4a`)
    try { return await readFile(local) } catch { /* not cached locally yet */ }
    const base = await deps.hubBase()
    if (!base) return null
    const missAt = crowdMiss.get(mergedTrackId)
    if (missAt !== undefined && Date.now() - missAt < CROWD_MISS_TTL_MS) return null
    try {
      const res = await get(`${base.replace(/\/$/, '')}/api/live-sets/${mergedTrackId}/crowd`, { accept: 'audio/mp4' })
      if (res.status === 404) { crowdMiss.set(mergedTrackId, Date.now()); return null }
      if (!res.ok) return null
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length === 0 || bytes.length > MAX_CROWD_BYTES) return null
      await mkdir(deps.crowdDir, { recursive: true })
      await writeAtomic(local, bytes)
      crowdMiss.delete(mergedTrackId)
      log(`[replica-concerts] crowd clip ${mergedTrackId} fetched from the hub (${bytes.length} bytes)`)
      return bytes
    } catch (err) {
      log(`[replica-concerts] crowd clip ${mergedTrackId} fetch failed: ${(err as Error)?.message ?? err}`)
      return null
    }
  }

  const timer = setInterval(() => { void tick() }, deps.intervalMs ?? 120_000)
  timer.unref?.()
  return {
    stop: () => { stopped = true; clearInterval(timer) },
    tick,
    crowdClip,
  }
}
