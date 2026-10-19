// Synced picks — renderer store (2026-10-18). TOP 10 ISLAND ALBUMS + 5
// FAVORITE ARTISTS, shared with the phone through homemini.
//
// Same module-store idiom as liveSets.ts: module state + a
// useSyncExternalStore subscribe/snapshot pair. Main owns the cache, the
// outbox and the network (src/main/synced-picks-client.ts); this store holds
// what to draw, applies local edits INSTANTLY (then main PUTs), and keeps the
// shelf live: a refresh on window focus and every 30 s while the window is
// visible — only while a shelf is on screen.

import { useEffect, useSyncExternalStore } from 'react'
import {
  ISLAND_SLOT_COUNT, FAVORITE_ARTIST_SLOT_COUNT,
  type AnyPicksState, type FavoriteSlot, type IslandSlot, type PicksKind, type PicksReply, type PicksState,
} from '../common/synced-picks'

const KINDS: PicksKind[] = ['island-albums', 'favorite-artists']
const LIVE_REFRESH_MS = 30_000

interface Snapshot {
  island: PicksState<IslandSlot>
  favorites: PicksState<FavoriteSlot>
}

const blank = <V,>(kind: PicksKind, count: number): PicksState<V> => ({
  kind, values: Array.from({ length: count }, () => null as V), updatedAt: null, updatedBy: null,
  pending: false, reachable: null, syncedAt: null,
})

let snap: Snapshot = {
  island: blank<IslandSlot>('island-albums', ISLAND_SLOT_COUNT),
  favorites: blank<FavoriteSlot>('favorite-artists', FAVORITE_ARTIST_SLOT_COUNT),
}
const listeners = new Set<() => void>()

export function subscribeSyncedPicks(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function getSyncedPicksSnapshot(): Snapshot {
  return snap
}

function emit(): void {
  for (const l of listeners) l()
}

function countFor(kind: PicksKind): number {
  return kind === 'island-albums' ? ISLAND_SLOT_COUNT : FAVORITE_ARTIST_SLOT_COUNT
}

// Local edits win the screen until main answers: a push or a refresh that
// was already on the wire when Jake clicked must not flick the shelf back.
const savesInFlight: Record<PicksKind, number> = { 'island-albums': 0, 'favorite-artists': 0 }
const editSeq: Record<PicksKind, number> = { 'island-albums': 0, 'favorite-artists': 0 }

function put(state: AnyPicksState): void {
  if (!state || !Array.isArray(state.values) || state.values.length !== countFor(state.kind)) return
  snap = state.kind === 'island-albums'
    ? { ...snap, island: state as PicksState<IslandSlot> }
    : { ...snap, favorites: state as PicksState<FavoriteSlot> }
  emit()
}

function applyRemote(state: AnyPicksState | undefined): void {
  if (!state || savesInFlight[state.kind] > 0) return
  put(state)
}

let loadStarted = false
/** Idempotent: hook the push channel once, draw the cache straight away. */
export function ensureSyncedPicksLoaded(): void {
  if (loadStarted) return
  loadStarted = true
  const api = window.electronAPI
  api.onSyncedPicksUpdated?.((state) => applyRemote(state))
  for (const kind of KINDS) {
    void api.syncedPicksGet?.(kind).then((r) => { if (r?.ok) applyRemote(r.state) }).catch((err: unknown) => {
      console.warn(`[synced-picks] cache read failed (${kind}):`, err instanceof Error ? err.message : err)
    })
  }
}

const refreshing: Record<PicksKind, boolean> = { 'island-albums': false, 'favorite-artists': false }
export async function refreshSyncedPicks(kind: PicksKind): Promise<void> {
  if (refreshing[kind]) return
  refreshing[kind] = true
  try {
    const r = await window.electronAPI.syncedPicksRefresh?.(kind)
    if (r?.ok) applyRemote(r.state)
  } catch (err) {
    console.warn(`[synced-picks] refresh failed (${kind}):`, err instanceof Error ? err.message : err)
  } finally {
    refreshing[kind] = false
  }
}

/** Draw the edit now, then hand it to main (which queues + PUTs). Resolves
 *  with the error text when main refuses it (invalid document). */
async function save<V>(kind: PicksKind, values: V[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const seq = ++editSeq[kind]
  const cur = kind === 'island-albums' ? snap.island : snap.favorites
  put({ ...cur, values, pending: true, updatedBy: 'desktop', updatedAt: new Date().toISOString(), rejected: undefined } as AnyPicksState)
  savesInFlight[kind]++
  let reply: PicksReply | undefined
  try {
    reply = await window.electronAPI.syncedPicksSave?.(kind, values)
  } catch (err) {
    reply = { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    savesInFlight[kind]--
  }
  // A newer edit is already on its way — its answer is the one to draw.
  if (seq === editSeq[kind] && reply?.state) put(reply.state)
  if (!reply) return { ok: false, error: 'not available in this build' }
  return reply.ok ? { ok: true } : { ok: false, error: reply.error }
}

export const saveIslandSlots = (values: IslandSlot[]) => save('island-albums', values)
export const saveFavoriteArtists = (values: FavoriteSlot[]) => save('favorite-artists', values)

// ── Live while on screen ─────────────────────────────────────────────────
const liveCount: Record<PicksKind, number> = { 'island-albums': 0, 'favorite-artists': 0 }
let liveTimer: number | null = null

function tick(): void {
  for (const k of KINDS) if (liveCount[k] > 0) void refreshSyncedPicks(k)
}
function onVisibility(): void {
  if (document.visibilityState === 'visible') tick()
}

function startLive(kind: PicksKind): () => void {
  liveCount[kind]++
  void refreshSyncedPicks(kind)                      // arriving on the page = a fresh look
  if (liveTimer === null) {
    liveTimer = window.setInterval(() => { if (document.visibilityState === 'visible') tick() }, LIVE_REFRESH_MS)
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', onVisibility)
  }
  return () => {
    liveCount[kind]--
    if (KINDS.every((k) => liveCount[k] === 0) && liveTimer !== null) {
      window.clearInterval(liveTimer)
      liveTimer = null
      window.removeEventListener('focus', tick)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }
}

/** Keep a kind live (focus + 30 s while visible) without re-rendering the
 *  caller — for a view whose menus read getSyncedPicksSnapshot() on demand. */
export function useSyncedPicksLive(kind: PicksKind): void {
  useEffect(() => { ensureSyncedPicksLoaded(); return startLive(kind) }, [kind])
}

/** Editable only once homemini's document has been seen (a good reply now or
 *  a cache from an earlier one), or on top of an edit already queued. Before
 *  that, ten empty slots mean "don't know" — a pick from there would replace
 *  every pick the phone has. Main refuses the same save (synced-picks-client). */
export function picksEditable(s: AnyPicksState): boolean {
  return s.syncedAt !== null || s.pending
}

/** Island Albums state, kept live while the calling component is mounted. */
export function useIslandAlbums(): PicksState<IslandSlot> {
  const s = useSyncExternalStore(subscribeSyncedPicks, getSyncedPicksSnapshot)
  useEffect(() => { ensureSyncedPicksLoaded(); return startLive('island-albums') }, [])
  return s.island
}

/** Favorite Artists state, kept live while the calling component is mounted. */
export function useFavoriteArtists(): PicksState<FavoriteSlot> {
  const s = useSyncExternalStore(subscribeSyncedPicks, getSyncedPicksSnapshot)
  useEffect(() => { ensureSyncedPicksLoaded(); return startLive('favorite-artists') }, [])
  return s.favorites
}

/** One line under a shelf's title — only when there is something to say. */
export function picksStatusLine(s: AnyPicksState): { text: string; tone: 'dim' | 'warn' } | null {
  if (s.rejected) return { text: `homemini refused the last change — ${s.rejected}`, tone: 'warn' }
  if (s.pending && s.reachable === false) return { text: 'Saved on this Mac — sends to your phone when homemini is reachable', tone: 'dim' }
  if (s.reachable === false && s.syncedAt) {
    const when = new Date(s.syncedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    return { text: `homemini is offline — showing the copy from ${when}`, tone: 'dim' }
  }
  if (s.reachable === false) return { text: 'Waiting for homemini — editing unlocks after the first sync', tone: 'dim' }
  return null
}
