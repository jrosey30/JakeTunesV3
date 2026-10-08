/**
 * Desktop client for the playlist HUB on homemini (2026-08-28 — playlist
 * sync, final form. Jake: "this feature needs to work like spotify").
 *
 * Each machine periodically POSTs its FULL local playlist state
 * (playlists + tombstones + pins) to /api/desktop-playlists/converge and
 * adopts the merged truth the hub answers with. The merge doctrine lives
 * server-side (desktopPlaylistHubRules.ts in JakeTunesMobile): absence is
 * not deletion, newest-wholesale per playlist, tombstones beat stale
 * copies and yield to newer re-creations, pins last-writer-wins.
 *
 * The desktop's job here: STAMP modifiedAt when a playlist's content
 * actually changes (the renderer knows nothing of stamps — the diff
 * against the previous save decides), converge quietly in the background,
 * and hand the renderer the hub's answer only when it differs. homemini
 * unreachable = silent skip; local remains truth-in-waiting.
 *
 * Electron-free: deps injected, node --test loads it.
 */
import { loadTombstones, saveTombstones, type PlaylistTombstone } from './playlist-tombstones.ts'
import { loadPins, savePins, type PlaylistPins } from './playlist-pins.ts'

export interface HubPlaylistLike {
  id?: unknown
  name?: unknown
  trackIds?: unknown
  commentary?: unknown
  modifiedAt?: unknown
  [k: string]: unknown
}

export interface HubSyncDeps {
  hubUrl: string
  device: string
  getPlaylists: () => Promise<HubPlaylistLike[]>
  setPlaylists: (p: HubPlaylistLike[]) => void
  tombstonesFile: string
  pinsFile: string
  fetchFn?: typeof fetch
  /** Called with the hub's playlists when they DIFFER from what we sent. */
  onApplied?: (playlists: HubPlaylistLike[]) => void
  log?: (msg: string) => void
}

/** Content signature — name + order-sensitive trackIds + commentary. */
const contentSig = (p: HubPlaylistLike): string =>
  JSON.stringify([String(p.name ?? ''), Array.isArray(p.trackIds) ? p.trackIds : [], String(p.commentary ?? '')])

const setSig = (ps: HubPlaylistLike[]): string =>
  JSON.stringify([...ps].map((p) => [String(p.id), contentSig(p), String(p.modifiedAt ?? '')]).sort())

/**
 * Stamp modifiedAt across a save: content changed (or brand new) → now;
 * unchanged → carry the PREVIOUS stamp (the renderer round-trips objects
 * without ever knowing about stamps).
 */
export function stampModifiedPlaylists(
  prev: HubPlaylistLike[],
  next: HubPlaylistLike[],
  now: () => string = () => new Date().toISOString(),
): HubPlaylistLike[] {
  const prevById = new Map(prev.map((p) => [String(p.id), p]))
  return next.map((p) => {
    const old = prevById.get(String(p.id))
    if (old && contentSig(old) === contentSig(p)) {
      return { ...p, modifiedAt: String(old.modifiedAt ?? p.modifiedAt ?? '') }
    }
    return { ...p, modifiedAt: now() }
  })
}

export interface ConvergeResult {
  ok: boolean
  changed: boolean
  error?: string
}

export async function convergePlaylistHub(deps: HubSyncDeps): Promise<ConvergeResult> {
  const fetchFn = deps.fetchFn ?? fetch
  const log = deps.log ?? ((m: string) => console.log(m))
  try {
    const [playlists, tombstones, pins] = await Promise.all([
      deps.getPlaylists(),
      loadTombstones(deps.tombstonesFile),
      loadPins(deps.pinsFile),
    ])
    const res = await fetchFn(`${deps.hubUrl}/api/desktop-playlists/converge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playlists, tombstones, pins, device: deps.device }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return { ok: false, changed: false, error: `hub ${res.status}` }
    const merged = await res.json() as { ok?: boolean; playlists?: HubPlaylistLike[]; tombstones?: PlaylistTombstone[]; pins?: PlaylistPins | null }
    if (!merged?.ok || !Array.isArray(merged.playlists)) return { ok: false, changed: false, error: 'bad hub reply' }

    const changed = setSig(merged.playlists) !== setSig(playlists)
    if (changed) {
      // Adopt the hub's truth BEFORE notifying the renderer, so the save
      // the renderer echoes back diffs against the already-adopted state
      // (no phantom tombstones, no re-stamping).
      deps.setPlaylists(merged.playlists)
      log(`[playlist-hub] adopted hub state: ${merged.playlists.length} playlists (was ${playlists.length})`)
    }
    if (Array.isArray(merged.tombstones)) await saveTombstones(merged.tombstones, deps.tombstonesFile)
    if (merged.pins && Array.isArray(merged.pins.pinnedPlaylists)) {
      const localPins = pins
      if (!localPins || String(merged.pins.updatedAt) > String(localPins.updatedAt)) {
        await savePins(merged.pins, deps.pinsFile)
      }
    }
    if (changed) deps.onApplied?.(merged.playlists)
    return { ok: true, changed }
  } catch (err) {
    // homemini down / off-network — routine, quiet; next tick retries.
    return { ok: false, changed: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Debounced scheduling (bound once by index.ts at boot) ───────────
let bound: HubSyncDeps | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let running = false

export function initPlaylistHubSync(deps: HubSyncDeps): void {
  bound = deps
}

/** Debounced converge — safe to call on every save. No-op until init. */
export function schedulePlaylistHubConverge(delayMs = 5_000): void {
  if (!bound) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    if (running || !bound) return
    running = true
    void convergePlaylistHub(bound).finally(() => { running = false })
  }, delayMs)
}
