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
 * 2026-10-22 — the PHONE writes hub copies too: a rename or reorder made on
 * the phone is a newer wholesale copy (every other field carried over), and
 * deleting a phone playlist that is on the hub writes a hub tombstone. Both
 * reach this Mac through the converge below, unchanged. homemini builds a
 * phone edit only on a hub copy at least as new as its library.json, so a
 * save from here that reached library.json but not the hub is never stamped
 * over (the phone is told to try again). A save that reached neither — this
 * Mac offline — loses to a later phone edit of the same playlist, exactly as
 * it would to a later edit on the other Mac (newest wins wholesale).
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/playlistEditRules.ts planPhoneEdit.
 *
 * 2026-10-22 (audit A02) — a hub reply is an answer to the state we SENT,
 * not to the state we have by the time it lands. The phone's writes make
 * "the reply differs" common, and the hub persists before it answers, so
 * Jake can delete, rename or pin during the wait. A reply is therefore
 * adopted only if no local writer moved since the snapshot (hub-local-state.ts
 * generations, checked under the same locks the writers take); otherwise it is
 * dropped and the converge runs again at once with the newer local state, and
 * the hub's own rules (above) settle the rest. Nothing local is ever replaced
 * by an older answer, and a tombstone is never replaced by one that has not
 * heard of it.
 *
 * Electron-free: deps injected, node --test loads it.
 */
import { loadTombstones, saveTombstones, recordPlaylistSave, sameTombstoneSet, type PlaylistTombstone } from './playlist-tombstones.ts'
import { loadPins, savePins, type PlaylistPins } from './playlist-pins.ts'
import { withCompanionInit } from './hub-companion.ts'
import {
  bumpLocalGen, snapshotLocalGens, movedGens, withLocalLock, lockKeys, PLAYLIST_HUB_COLLECTIONS,
} from './hub-local-state.ts'

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

const memberTimes = (raw: unknown): Record<string, number> => {
  const out: Record<string, number> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
  }
  return out
}
const memberSet = (p: HubPlaylistLike): Set<string> =>
  new Set(Array.isArray(p.trackIds) ? p.trackIds.map(String) : [])

/**
 * Stamp modifiedAt across a save: content changed (or brand new) → now;
 * unchanged → carry the PREVIOUS stamp (the renderer round-trips objects
 * without ever knowing about stamps).
 *
 * 2026-10-20 — also `memberChangedAt` (trackId → epoch ms): WHEN each
 * track's membership in this playlist last changed on a desktop. Tracks
 * that joined or left since the previous save get now; everything else
 * carries over (newest of the previous and the incoming value). The phone's
 * playlist edits compare against it per track — newest edit wins
 * (phone-playlist-edits.ts here; playlistEditRules.ts on homemini). A brand
 * new playlist starts with none: nothing older can conflict with it.
 */
export function stampModifiedPlaylists(
  prev: HubPlaylistLike[],
  next: HubPlaylistLike[],
  now: () => string = () => new Date().toISOString(),
): HubPlaylistLike[] {
  const prevById = new Map(prev.map((p) => [String(p.id), p]))
  return next.map((p) => {
    const old = prevById.get(String(p.id))
    const stamps = memberTimes(old?.memberChangedAt)
    for (const [k, v] of Object.entries(memberTimes(p.memberChangedAt))) stamps[k] = Math.max(stamps[k] ?? 0, v)
    if (old && contentSig(old) === contentSig(p)) {
      const carried = { ...p, modifiedAt: String(old.modifiedAt ?? p.modifiedAt ?? '') }
      return Object.keys(stamps).length > 0 ? { ...carried, memberChangedAt: stamps } : carried
    }
    const stampedAt = now()
    if (old) {
      const nowMs = Date.parse(stampedAt) || Date.now()
      const before = memberSet(old)
      const after = memberSet(p)
      for (const id of after) if (!before.has(id)) stamps[id] = nowMs
      for (const id of before) if (!after.has(id)) stamps[id] = nowMs
    }
    const stamped = { ...p, modifiedAt: stampedAt }
    return Object.keys(stamps).length > 0 ? { ...stamped, memberChangedAt: stamps } : stamped
  })
}

export interface ConvergeResult {
  ok: boolean
  changed: boolean
  error?: string
  /** Every attempt was overtaken by a newer local change and no reply was
   *  adopted (local state is untouched). The scheduler runs again shortly. */
  deferred?: boolean
}

/** Attempts per converge: the first plus immediate re-converges after a
 *  local change overtook the reply. Bounded so a stream of edits cannot spin. */
const MAX_ATTEMPTS = 4

type Attempt = ConvergeResult & { stale?: boolean }

export async function convergePlaylistHub(deps: HubSyncDeps): Promise<ConvergeResult> {
  const log = deps.log ?? ((m: string) => console.log(m))
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const r = await convergeOnce(deps)
    if (!r.stale) return r
    log(`[playlist-hub] a local change landed while the hub was answering (attempt ${attempt}/${MAX_ATTEMPTS}) — dropped that reply, converging again`)
  }
  return { ok: true, changed: false, deferred: true }
}

async function convergeOnce(deps: HubSyncDeps): Promise<Attempt> {
  const fetchFn = deps.fetchFn ?? fetch
  const log = deps.log ?? ((m: string) => console.log(m))
  try {
    // Generations FIRST, then the reads: a writer that lands after this line
    // moves a generation, whether or not our reads saw its write.
    const since = snapshotLocalGens()
    const [playlists, tombstones, pins] = await Promise.all([
      deps.getPlaylists(),
      loadTombstones(deps.tombstonesFile),
      loadPins(deps.pinsFile),
    ])
    const res = await fetchFn(`${deps.hubUrl}/api/desktop-playlists/converge`, withCompanionInit({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playlists, tombstones, pins, device: deps.device }),
      signal: AbortSignal.timeout(15_000),
    }))
    if (!res.ok) return { ok: false, changed: false, error: `hub ${res.status}` }
    const merged = await res.json() as { ok?: boolean; playlists?: HubPlaylistLike[]; tombstones?: PlaylistTombstone[]; pins?: PlaylistPins | null }
    if (!merged?.ok || !Array.isArray(merged.playlists)) return { ok: false, changed: false, error: 'bad hub reply' }
    const hubPlaylists = merged.playlists

    const changed = setSig(hubPlaylists) !== setSig(playlists)

    // The tombstone and pin locks are the ones local writers take, so from the
    // check below to the last write nothing local can interleave: a writer
    // that starts now queues behind us and then builds on what we wrote.
    const outcome = await withLocalLock(lockKeys.tombstones(deps.tombstonesFile), () =>
      withLocalLock(lockKeys.pins(deps.pinsFile), async (): Promise<'stale' | 'adopted'> => {
        if (movedGens(since, PLAYLIST_HUB_COLLECTIONS).length > 0) return 'stale'
        if (changed) {
          // Adopt the hub's truth BEFORE notifying the renderer, so the save
          // the renderer echoes back diffs against the already-adopted state
          // (no phantom tombstones, no re-stamping).
          deps.setPlaylists(hubPlaylists)
          bumpLocalGen('playlists')
          log(`[playlist-hub] adopted hub state: ${hubPlaylists.length} playlists (was ${playlists.length})`)
        }
        if (Array.isArray(merged.tombstones)) {
          const current = await loadTombstones(deps.tombstonesFile)
          await saveTombstones(merged.tombstones, deps.tombstonesFile)
          if (!sameTombstoneSet(current, merged.tombstones)) bumpLocalGen('playlistTombstones')
        }
        if (merged.pins && Array.isArray(merged.pins.pinnedPlaylists)) {
          // Against the pins file AS IT IS NOW, not the pre-request snapshot.
          const current = await loadPins(deps.pinsFile)
          if (!current || String(merged.pins.updatedAt) > String(current.updatedAt)) {
            await savePins(merged.pins, deps.pinsFile)
            bumpLocalGen('pins')
          }
        }
        return 'adopted'
      }))
    if (outcome === 'stale') return { ok: true, changed: false, stale: true }

    if (changed) deps.onApplied?.(hubPlaylists)
    return { ok: true, changed }
  } catch (err) {
    // homemini down / off-network — routine, quiet; next tick retries.
    return { ok: false, changed: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The save-playlists path (library-ipc.ts) — stamp, store, bump, record.
 * A LOCAL writer: it moves the playlists generation in the same tick it
 * replaces the cache, and recordPlaylistSave moves the tombstone generation
 * (hub-local-state.ts). Returns the ledger promise so callers that must wait
 * for the tombstone can; the IPC handler lets it run (a ledger failure never
 * fails a save).
 */
export async function commitLocalPlaylistSave(args: {
  playlists: unknown[]
  getPlaylists: () => Promise<unknown[]>
  setPlaylists: (playlists: unknown[]) => void
  tombstonesFile: string
  now?: () => string
}): Promise<{ ledger: Promise<unknown> }> {
  // Deletion ledger (2026-08-28): the diff between consecutive saves IS the
  // delete event — a dropped ID becomes a tombstone so no sync path can
  // resurrect it ("existence is not memory").
  const prev = (await args.getPlaylists()) as Array<{ id?: unknown; name?: unknown }>
  // Hub stamps (final-form sync): content changed → modifiedAt = now,
  // untouched → carry the previous stamp. The renderer never sees stamps;
  // this diff is where they're minted.
  const stamped = stampModifiedPlaylists(prev as never, args.playlists as never, args.now)
  args.setPlaylists(stamped)
  bumpLocalGen('playlists')
  const ledger = recordPlaylistSave(prev, args.playlists as Array<{ id?: unknown }>, args.tombstonesFile, args.now)
    .catch((err) => console.warn('[playlist-tombstones] record failed:', err))
  return { ledger }
}

// ── Debounced scheduling (bound once by index.ts at boot) ───────────
let bound: HubSyncDeps | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let running = false
/** A converge was asked for while one was in flight, or every attempt of the
 *  last one was overtaken by a local change: run once more when it ends. */
let rerun = false
let rerunDelayMs = 1_000

export function initPlaylistHubSync(deps: HubSyncDeps, opts?: { rerunDelayMs?: number }): void {
  bound = deps
  rerunDelayMs = opts?.rerunDelayMs ?? 1_000
}

/** Debounced converge — safe to call on every save. No-op until init. */
export function schedulePlaylistHubConverge(delayMs = 5_000): void {
  if (!bound) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void runScheduledConverge()
  }, delayMs)
}

async function runScheduledConverge(): Promise<void> {
  const deps = bound
  if (!deps) return
  // Never drop a request that arrives mid-converge (it used to be dropped,
  // leaving the edit that asked for it unsynced until the next save or the
  // 10-minute tick): note it and run again the moment this one ends.
  if (running) { rerun = true; return }
  running = true
  try {
    const r = await convergePlaylistHub(deps)
    if (r.deferred) rerun = true
  } finally {
    running = false
  }
  if (rerun) {
    rerun = false
    schedulePlaylistHubConverge(rerunDelayMs)
  }
}
