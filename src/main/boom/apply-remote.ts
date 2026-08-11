/**
 * Boom Phase 2 — pure event-application helpers for the desktop cache.
 *
 * Server (homemini) is SoT. Local library.json is a rebuildable cache.
 * These functions merge SSE / snapshot payloads into in-memory track +
 * playlist arrays without touching the filesystem.
 *
 * ⚠️ TWIN: server/boom/boom/db.py field-level LWW + soft-delete semantics.
 */

export interface BoomTrack {
  id: number
  [key: string]: unknown
  _etag?: number
}

export interface BoomPlaylist {
  id: string
  name?: string
  trackIds?: number[]
  [key: string]: unknown
  _etag?: number
}

export interface BoomLibrarySnapshot {
  schema: number
  latestEventId: number
  tracks: BoomTrack[]
  playlists: BoomPlaylist[]
  etags?: Record<string, number>
}

export interface BoomEvent {
  id: number
  schema?: number
  type: string
  entity_id?: string
  payload?: {
    id?: number | string
    fields?: Record<string, unknown>
    etag?: number
    ts?: number
    playlist?: BoomPlaylist
    track?: BoomTrack
    [key: string]: unknown
  }
  ts?: number
}

export interface BoomCacheState {
  tracks: BoomTrack[]
  playlists: BoomPlaylist[]
  latestEventId: number
}

/** Replace local cache from a cold-launch / snapshot-recommended fetch. */
export function applySnapshot(snap: BoomLibrarySnapshot): BoomCacheState {
  return {
    tracks: (snap.tracks || []).map((t) => ({ ...t })),
    playlists: (snap.playlists || []).map((p) => ({ ...p })),
    latestEventId: snap.latestEventId || 0,
  }
}

/**
 * Apply one Boom SSE event to a cache. Returns a new state object.
 * Unknown event types are ignored (forward-compatible).
 */
export function applyBoomEvent(state: BoomCacheState, event: BoomEvent): BoomCacheState {
  const latestEventId = Math.max(state.latestEventId, event.id || 0)
  const type = event.type
  const payload = event.payload || {}

  if (type === 'snapshot') {
    // Caller should cold-fetch; keep cursor advanced so we don't loop.
    return { ...state, latestEventId }
  }

  if (type === 'track-updated') {
    const id = Number(payload.id ?? event.entity_id)
    if (!Number.isFinite(id)) return { ...state, latestEventId }
    const fields = (payload.fields || {}) as Record<string, unknown>
    const etag = typeof payload.etag === 'number' ? payload.etag : undefined
    const tracks = state.tracks.slice()
    const idx = tracks.findIndex((t) => Number(t.id) === id)
    if (idx === -1) {
      // Full body in fields (upsert) or sparse — accept either.
      const body = { id, ...fields } as BoomTrack
      if (etag !== undefined) body._etag = etag
      tracks.push(body)
    } else {
      const prev = tracks[idx]
      // Stale event: ignore if we already have a newer etag.
      if (
        etag !== undefined &&
        typeof prev._etag === 'number' &&
        prev._etag > etag
      ) {
        return { ...state, latestEventId }
      }
      const next: BoomTrack = { ...prev, ...fields, id }
      if (etag !== undefined) next._etag = etag
      tracks[idx] = next
    }
    return { tracks, playlists: state.playlists, latestEventId }
  }

  if (type === 'track-deleted') {
    const id = Number(payload.id ?? event.entity_id)
    if (!Number.isFinite(id)) return { ...state, latestEventId }
    return {
      tracks: state.tracks.filter((t) => Number(t.id) !== id),
      playlists: state.playlists,
      latestEventId,
    }
  }

  if (type === 'playlist-updated') {
    const id = String(payload.id ?? event.entity_id ?? '')
    if (!id) return { ...state, latestEventId }
    const body = (payload.playlist || { id, ...payload }) as BoomPlaylist
    const etag = typeof payload.etag === 'number' ? payload.etag : undefined
    if (etag !== undefined) body._etag = etag
    body.id = id
    const playlists = state.playlists.slice()
    const idx = playlists.findIndex((p) => String(p.id) === id)
    if (idx === -1) playlists.push(body)
    else playlists[idx] = { ...playlists[idx], ...body, id }
    return { tracks: state.tracks, playlists, latestEventId }
  }

  if (type === 'playlist-deleted') {
    const id = String(payload.id ?? event.entity_id ?? '')
    if (!id) return { ...state, latestEventId }
    return {
      tracks: state.tracks,
      playlists: state.playlists.filter((p) => String(p.id) !== id),
      latestEventId,
    }
  }

  return { ...state, latestEventId }
}

/** Apply a burst of events in order (reconnect catch-up). */
export function applyBoomEvents(state: BoomCacheState, events: BoomEvent[]): BoomCacheState {
  let next = state
  for (const ev of events) next = applyBoomEvent(next, ev)
  return next
}

/**
 * Diff a local metadata edit into a Boom PATCH body.
 * Only sends changed keys — field-level LWW on the server.
 */
export function buildTrackPatch(
  before: BoomTrack | null | undefined,
  after: BoomTrack,
  keys?: string[],
): { fields: Record<string, unknown>; etag?: number } {
  const fields: Record<string, unknown> = {}
  const consider = keys || Object.keys(after).filter((k) => k !== '_etag' && k !== 'id')
  for (const k of consider) {
    const next = after[k]
    const prev = before ? before[k] : undefined
    if (JSON.stringify(prev) !== JSON.stringify(next)) fields[k] = next
  }
  const etag = typeof after._etag === 'number' ? after._etag : (before && typeof before._etag === 'number' ? before._etag : undefined)
  return { fields, etag }
}
