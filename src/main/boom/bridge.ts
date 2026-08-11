/**
 * Boom bridge — dual-write + SSE apply for Electron main.
 *
 * Feature flag: library.boomUrl in app-settings.json (or BOOM_URL env).
 * When unset, every export is a no-op so existing rsync sync is unchanged.
 */

import { writeFile, rename, stat } from 'node:fs/promises'
import { BoomClient, isBoomEnabled, normalizeBoomUrl } from './client.ts'
import {
  applyBoomEvent,
  applySnapshot,
  type BoomCacheState,
  type BoomEvent,
  type BoomTrack,
} from './apply-remote.ts'

export type BoomBridgeHooks = {
  /** Absolute path to local library.json cache. */
  libraryPath: () => string
  /** Stamp self-write mtime so the library watcher ignores our apply. */
  stampSelfWrite: (mtimeMs: number) => void
  /** Ask renderer to reload after remote apply. */
  notifyExternalChange: () => void
  /** Read boom URL from settings / env. */
  resolveBoomUrl: () => Promise<string | null>
  log?: (msg: string) => void
}

let client: BoomClient | null = null
let abort: AbortController | null = null
let loopRunning = false
let hooks: BoomBridgeHooks | null = null
let cache: BoomCacheState = { tracks: [], playlists: [], latestEventId: 0 }
let applyChain: Promise<void> = Promise.resolve()

const log = (msg: string) => (hooks?.log ?? console.log)(`[boom] ${msg}`)

export function getBoomClient(): BoomClient | null {
  return client
}

export async function startBoomBridge(h: BoomBridgeHooks): Promise<void> {
  hooks = h
  const url = await h.resolveBoomUrl()
  if (!isBoomEnabled(url)) {
    log('disabled (no library.boomUrl / BOOM_URL)')
    return
  }
  client = new BoomClient({ baseUrl: normalizeBoomUrl(url!) })
  try {
    const health = await client.health()
    if (!health.ok) {
      log('server unhealthy — will keep retrying SSE loop')
    } else {
      log(`connected latestEventId=${health.latestEventId ?? '?'}`)
    }
  } catch (err) {
    log(`health check failed: ${err instanceof Error ? err.message : err}`)
  }
  void runSubscribeLoop()
}

export function stopBoomBridge(): void {
  abort?.abort()
  abort = null
  loopRunning = false
  client = null
}

async function runSubscribeLoop(): Promise<void> {
  if (loopRunning || !client || !hooks) return
  loopRunning = true
  let backoff = 1000
  while (loopRunning && client) {
    abort = new AbortController()
    try {
      // Cold snapshot if we have no cursor yet.
      if (cache.latestEventId === 0) {
        const snap = await client.fetchLibrary()
        if ((snap.tracks?.length || 0) === 0) {
          // Server empty — one-shot publish local library.json (migration).
          await seedServerFromLocal()
        } else {
          cache = applySnapshot(snap)
          await persistCacheAndNotify(cache)
          log(`snapshot applied tracks=${cache.tracks.length} cursor=${cache.latestEventId}`)
        }
      }
      await client.subscribeEvents(
        cache.latestEventId,
        (ev) => {
          applyChain = applyChain.then(() => handleRemoteEvent(ev)).catch((err) => {
            log(`apply error: ${err instanceof Error ? err.message : err}`)
          })
        },
        abort.signal,
      )
      backoff = 1000
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if ((err as { code?: string })?.code === 'snapshot-recommended') {
        cache.latestEventId = 0
        log('server recommended snapshot — refetching')
        continue
      }
      if (abort.signal.aborted) break
      log(`SSE disconnected (${msg}); retry in ${backoff}ms`)
      await sleep(backoff)
      backoff = Math.min(backoff * 2, 30_000)
    }
  }
  loopRunning = false
}

async function seedServerFromLocal(): Promise<void> {
  if (!client || !hooks) return
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = JSON.parse(await readFile(hooks.libraryPath(), 'utf-8')) as {
      tracks?: BoomTrack[]
      playlists?: Array<{ id: string; [key: string]: unknown }>
    }
    const tracks = Array.isArray(raw.tracks) ? raw.tracks : []
    const playlists = Array.isArray(raw.playlists) ? raw.playlists : []
    if (tracks.length === 0) {
      log('local library empty — waiting for first import')
      return
    }
    log(`seeding server from local library (${tracks.length} tracks)`)
    await client.importLibrary({ tracks, playlists })
    const snap = await client.fetchLibrary()
    cache = applySnapshot(snap)
    // Don't rewrite local — we were the source. Just adopt the cursor.
    log(`seed complete cursor=${cache.latestEventId}`)
  } catch (err) {
    log(`seed failed: ${err instanceof Error ? err.message : err}`)
  }
}

async function handleRemoteEvent(ev: BoomEvent): Promise<void> {
  if (isEchoOfSelfPublish(ev)) {
    // Advance cursor without rewriting the editor's own library.json.
    cache = { ...cache, latestEventId: Math.max(cache.latestEventId, ev.id || 0) }
    return
  }
  if (ev.type === 'snapshot') {
    if (!client) return
    const snap = await client.fetchLibrary()
    cache = applySnapshot(snap)
    await persistCacheAndNotify(cache)
    return
  }
  const next = applyBoomEvent(cache, ev)
  // Skip disk write if nothing material changed beyond cursor.
  const sameTracks = next.tracks === cache.tracks
  const samePlaylists = next.playlists === cache.playlists
  cache = next
  if (sameTracks && samePlaylists) return
  await persistCacheAndNotify(cache)
}

async function persistCacheAndNotify(state: BoomCacheState): Promise<void> {
  if (!hooks) return
  const path = hooks.libraryPath()
  const library = {
    tracks: state.tracks.map(({ _etag, ...rest }) => rest),
    playlists: state.playlists.map(({ _etag, ...rest }) => rest),
  }
  const tmp = `${path}.boom.${process.pid}.${Date.now()}.tmp`
  hooks.stampSelfWrite(Date.now())
  await writeFile(tmp, JSON.stringify(library, null, 2), 'utf-8')
  await rename(tmp, path)
  try {
    const s = await stat(path)
    hooks.stampSelfWrite(Math.round(s.mtimeMs))
  } catch { /* non-fatal */ }
  hooks.notifyExternalChange()
}

/** Dual-write a field-level metadata edit. */
export async function boomPublishTrackPatch(
  trackId: number,
  fields: Record<string, unknown>,
  etag?: number,
): Promise<void> {
  if (!client) return
  noteSelfPublish(trackId)
  try {
    const res = await client.patchTrack(trackId, fields, { etag })
    if (!res.ok && res.status === 409 && res.track) {
      log(`patch conflict track=${trackId} — applying server truth`)
      cache = applyBoomEvent(cache, {
        id: cache.latestEventId,
        type: 'track-updated',
        payload: { id: trackId, fields: res.track, etag: res.etag },
      })
      await persistCacheAndNotify(cache)
      return
    }
    if (res.ok && res.etag !== undefined) {
      const idx = cache.tracks.findIndex((t) => Number(t.id) === trackId)
      if (idx >= 0) cache.tracks[idx] = { ...cache.tracks[idx], ...fields, _etag: res.etag }
    }
  } catch (err) {
    log(`patch track ${trackId} failed: ${err instanceof Error ? err.message : err}`)
  }
}

/** Dual-write a full track upsert (imports / save-library publish). */
export async function boomPublishTrack(track: BoomTrack): Promise<void> {
  if (!client) return
  noteSelfPublish(Number(track.id))
  try {
    const res = await client.upsertTrack(track)
    // Keep local etag cursor awareness for conflict avoidance.
    const idx = cache.tracks.findIndex((t) => Number(t.id) === Number(track.id))
    const withEtag = { ...track, _etag: res.etag }
    if (idx === -1) cache.tracks.push(withEtag)
    else cache.tracks[idx] = { ...cache.tracks[idx], ...withEtag }
  } catch (err) {
    log(`publish track ${track.id} failed: ${err instanceof Error ? err.message : err}`)
  }
}

const selfPublishUntil = new Map<number, number>()

function noteSelfPublish(trackId: number): void {
  if (!Number.isFinite(trackId)) return
  selfPublishUntil.set(trackId, Date.now() + 3000)
}

function isEchoOfSelfPublish(ev: BoomEvent): boolean {
  if (ev.type !== 'track-updated' && ev.type !== 'track-deleted') return false
  const id = Number(ev.payload?.id ?? ev.entity_id)
  const until = selfPublishUntil.get(id)
  if (until === undefined) return false
  if (Date.now() > until) {
    selfPublishUntil.delete(id)
    return false
  }
  return true
}

export async function boomPublishPlaylist(playlist: {
  id: string
  name?: string
  trackIds?: number[]
  [key: string]: unknown
}): Promise<void> {
  if (!client) return
  try {
    await client.upsertPlaylist(playlist)
  } catch (err) {
    log(`publish playlist ${playlist.id} failed: ${err instanceof Error ? err.message : err}`)
  }
}

/** Publish many tracks after a local save (best-effort, capped). */
export async function boomPublishLibraryDiff(
  tracks: BoomTrack[],
  playlists: Array<{ id: string; [key: string]: unknown }>,
): Promise<void> {
  if (!client) return
  // Cap burst size so a full-library save doesn't stampede the API.
  const MAX = 50
  for (const t of tracks.slice(0, MAX)) {
    await boomPublishTrack(t)
  }
  for (const p of playlists.slice(0, MAX)) {
    if (p?.id) await boomPublishPlaylist(p as { id: string })
  }
}

export async function resolveBoomUrlFromSettings(
  readSettings: () => Promise<Record<string, unknown> | null>,
): Promise<string | null> {
  if (process.env.BOOM_URL && isBoomEnabled(process.env.BOOM_URL)) {
    return normalizeBoomUrl(process.env.BOOM_URL)
  }
  try {
    const s = await readSettings()
    const lib = s?.library as { boomUrl?: string } | undefined
    if (lib?.boomUrl && isBoomEnabled(lib.boomUrl)) return normalizeBoomUrl(lib.boomUrl)
  } catch { /* ignore */ }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Test seam */
export function _resetBoomBridgeForTests(): void {
  stopBoomBridge()
  cache = { tracks: [], playlists: [], latestEventId: 0 }
  applyChain = Promise.resolve()
  hooks = null
}
