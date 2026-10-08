import { isCatastrophicShrink } from './library-shrink.ts'

// Hub catalog merge (2026-10-08) — the pure half of "replicas adopt the
// library from homemini like the phone does".
//
// Why: the laptop used to deliver its library to workmini by swapping the
// FILE under workmini's running app whenever the sizes differed. The app
// noticed a foreign write on its next save and reloaded from disk, so
// whatever the laptop's copy lacked at that second vanished mid-play (10-08:
// three Geese songs downloaded on the phone, absorbed on workmini, swapped
// away at 10:32, back at 10:39). The hub never had that gap — /api/tracks
// carried the songs the whole time. So the replica now reads the hub.
//
// Rules (Jake: "latest updates should always win", "this cannot happen"):
//   - a song the hub lists is upserted: catalog fields come from the hub
//     (it is the laptop's publish + phone edits, i.e. the newest view),
//     playCount is the MAX of local and hub (plays are never lost here)
//   - a DELTA removes a song only when removedIds names it. More than
//     MAX_REMOVALS_PER_DELTA names is a torn publish, not a cleanup:
//     nothing is removed.
//   - a FULL snapshot (first adoption, or the hub declined the delta —
//     a backend restart does this) IS the catalog. The replica's library
//     matches it, removals included. Keeping every local-only id here was
//     the resurrection bug: a song Jake deleted is absent from `items`,
//     the replica kept it, and the next save wrote it back. The 10-08
//     Geese songs were ON the hub the whole time; a hub snapshot still
//     contains them.
//   - the exception is a song this replica imported itself, which the hub
//     has never listed. The first snapshot (no adopted version yet) is
//     still authoritative, so the backlog of laptop deletions lands.
//     After that, an id the hub has never presented is kept when it was
//     added locally after the last adopted version — and that protection
//     is persisted (`protectedIds`), because the ack moves adoptedAt
//     forward and a later snapshot would otherwise drop the song.
//     An id the hub HAS listed, then omits, is a real deletion and goes.
//     Once the hub lists a protected id, it is a hub song and can be
//     deleted later. Replica catalog edits to a song the hub already
//     lists still take the hub's fields; this does not publish them back.
//   - an empty full snapshot is ignored (a torn reply must never blank
//     a library). A full snapshot that would trip the shrink floor
//     (src/common/library-shrink.ts, the same line save-library refuses)
//     is ignored too — adoption does not get a force hatch. Replica-local
//     rows are not counted in that ratio, so they cannot pad a torn
//     snapshot over the floor.

export interface HubTrackLike {
  id: number
  playCount?: number
  [key: string]: unknown
}

export interface HubCatalogPayload {
  /** true = a complete snapshot (first adoption / hub declined the delta). */
  full: boolean
  version: string
  upserts: HubTrackLike[]
  removedIds: Array<string | number>
  /** Ids any previously adopted hub catalog has listed. Empty = first adoption. */
  seenIds?: string[]
  /** Ids kept on an earlier adoption because the hub had never listed them. */
  protectedIds?: string[]
  /** ISO time of the last adopted version. Absent = no adoption yet. */
  adoptedAt?: string | null
}

/** What the replica already knows about the hub, passed into the merge. */
export interface HubMergeContext {
  seenIds?: ReadonlyArray<string | number>
  protectedIds?: ReadonlyArray<string | number>
  adoptedAt?: string | null
}

/** Catalog fields the hub owns. Anything else on a local row is left alone. */
export const HUB_CATALOG_FIELDS = [
  'title', 'artist', 'album', 'albumArtist', 'genre', 'year', 'duration',
  'dateAdded', 'trackNumber', 'trackCount', 'discNumber', 'discCount',
  'fileSize', 'rating', 'path', 'artworkHash', 'audioFingerprint',
] as const

export interface HubMergeResult<T> {
  tracks: T[]
  changed: boolean
  added: number
  updated: number
  removed: number
  ignoredReason?: string
  /**
   * Ids to persist after this adoption acks. Survives the ack moving
   * adoptedAt forward. Does not include any id the hub listed this round.
   */
  protectedIds: string[]
}

export const MAX_REMOVALS_PER_DELTA = 25

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Local rows only need an id (+ optional playCount); `Track` qualifies without an index signature. */
export interface LocalTrackLike { id: number; playCount?: number; dateAdded?: string }

const cmpId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function asIdSet(ids: ReadonlyArray<string | number> | undefined): Set<string> {
  const s = new Set<string>()
  if (!ids) return s
  for (const id of ids) s.add(String(id))
  return s
}

function addedAtMs(track: { dateAdded?: unknown }): number | null {
  const v = track.dateAdded
  if (typeof v !== 'string' || v.length === 0) return null
  const n = Date.parse(v)
  return Number.isFinite(n) ? n : null
}

function adoptedMs(adoptedAt: string | null | undefined): number | null {
  if (typeof adoptedAt !== 'string' || adoptedAt.length === 0) return null
  const n = Date.parse(adoptedAt)
  return Number.isFinite(n) ? n : null
}

/**
 * A local id the hub has never listed, imported on this replica after the
 * last adopted version (or already recorded as such). Seen ids are hub
 * songs: absence from a full snapshot is a laptop deletion, not a local import.
 */
function holdReplicaLocal(
  track: LocalTrackLike,
  seen: Set<string>,
  held: Set<string>,
  adoptedAtMs: number | null,
): boolean {
  const key = String(track.id)
  if (seen.has(key)) return false
  if (held.has(key)) return true
  if (adoptedAtMs == null) return false
  const added = addedAtMs(track)
  return added != null && added > adoptedAtMs
}

export interface HubAdoptionState {
  version: string
  adoptedAt: string
  seenIds: string[]
  protectedIds: string[]
}

/**
 * Persist what this ack taught us. Hub ids join `seenIds` (so a later
 * omission can delete them). Protected ids are the replica-local set from
 * the merge; any id the hub just listed is dropped from it. Omitting
 * `protectedIds` keeps the previous set (an ack that did not recompute it).
 */
export function adoptHubCatalogState(
  prev: { seenIds?: readonly string[]; protectedIds?: readonly string[] },
  ack: { version: string; hubIds: readonly string[]; protectedIds?: readonly string[]; now: string },
): HubAdoptionState {
  const seen = new Set<string>()
  for (const id of prev.seenIds ?? []) seen.add(String(id))
  for (const id of ack.hubIds) seen.add(String(id))
  const raw = ack.protectedIds ?? prev.protectedIds ?? []
  const protectedIds = new Set<string>()
  for (const id of raw) {
    const key = String(id)
    if (!seen.has(key)) protectedIds.add(key)
  }
  return {
    version: ack.version,
    adoptedAt: ack.now,
    seenIds: [...seen].sort(cmpId),
    protectedIds: [...protectedIds].sort(cmpId),
  }
}

export function mergeHubCatalog<T extends LocalTrackLike>(
  local: T[],
  payload: HubCatalogPayload,
  ctx: HubMergeContext = {},
): HubMergeResult<T> {
  const seen = asIdSet(ctx.seenIds ?? payload.seenIds)
  const held = asIdSet(ctx.protectedIds ?? payload.protectedIds)
  const adoptedAtMs = adoptedMs(ctx.adoptedAt ?? payload.adoptedAt)
  const priorProtected = [...held].sort(cmpId)
  const upserts = (Array.isArray(payload.upserts) ? payload.upserts : []).filter(
    (u): u is HubTrackLike => u != null && typeof u.id === 'number',
  )
  if (payload.full && upserts.length === 0) {
    return { tracks: local, changed: false, added: 0, updated: 0, removed: 0, ignoredReason: 'empty-full-snapshot', protectedIds: priorProtected }
  }
  // Mass-removal guard: a delta naming more than MAX_REMOVALS_PER_DELTA songs
  // is not a person deleting songs, it is a torn/reverted publish (the 10/5
  // Sep-4-revert class). Keep everything and say so; a real cleanup of that
  // size is a desktop job, not a replica merge. Full snapshots are not this
  // path — their membership IS the catalog, guarded by the shrink floor.
  const removedIdsRaw = Array.isArray(payload.removedIds) ? payload.removedIds : []
  const tooMany = !payload.full && removedIdsRaw.length > MAX_REMOVALS_PER_DELTA
  const removed = new Set<string>()
  const hubListed = new Set(upserts.map((u) => String(u.id)))
  if (payload.full) {
    const localIds = new Set(local.map((t) => String(t.id)))
    let addedPreview = 0
    for (const id of hubListed) if (!localIds.has(id)) addedPreview++
    // No memory of the hub yet: the whole local library is the catalog
    // being replaced (same floor as before this protection existed).
    // Once we know which ids the hub has listed, only those count —
    // replica-local holds must not pad a torn snapshot over the floor.
    let prevCatalog: number
    let nextCatalog: number
    if (seen.size === 0) {
      let droppedPreview = 0
      for (const t of local) {
        const key = String(t.id)
        if (hubListed.has(key)) continue
        if (holdReplicaLocal(t, seen, held, adoptedAtMs)) continue
        droppedPreview++
      }
      prevCatalog = local.length
      nextCatalog = local.length - droppedPreview + addedPreview
    } else {
      let surviving = 0
      prevCatalog = 0
      for (const t of local) {
        const key = String(t.id)
        if (!seen.has(key)) continue
        prevCatalog++
        if (hubListed.has(key)) surviving++
      }
      nextCatalog = surviving + addedPreview
    }
    if (isCatastrophicShrink(prevCatalog, nextCatalog)) {
      return {
        tracks: local, changed: false, added: 0, updated: 0, removed: 0,
        ignoredReason: `full-snapshot-shrink-guard:${prevCatalog}->${nextCatalog}`,
        protectedIds: priorProtected,
      }
    }
    for (const t of local) {
      const key = String(t.id)
      if (hubListed.has(key)) continue
      if (holdReplicaLocal(t, seen, held, adoptedAtMs)) continue
      removed.add(key)
    }
  } else if (!tooMany) {
    for (const id of removedIdsRaw) removed.add(String(id))
  }

  const byId = new Map<string, T>()
  for (const t of local) byId.set(String(t.id), t)

  let added = 0
  let updated = 0
  const replaced = new Map<string, T>()
  const appended: T[] = []
  for (const u of upserts) {
    if (u == null || typeof u.id !== 'number') continue
    const key = String(u.id)
    const cur = byId.get(key)
    if (!cur) {
      appended.push({ ...(u as unknown as T) })
      byId.set(key, appended[appended.length - 1])
      added++
      continue
    }
    let changed = false
    const curRec = cur as unknown as Record<string, unknown>
    const next: Record<string, unknown> = { ...curRec }
    for (const f of HUB_CATALOG_FIELDS) {
      if (!(f in u)) continue
      const v = (u as Record<string, unknown>)[f]
      if (v === undefined || v === curRec[f]) continue
      next[f] = v
      changed = true
    }
    const pc = Math.max(num(cur.playCount), num(u.playCount))
    if (pc !== num(cur.playCount)) { next.playCount = pc; changed = true }
    if (changed) { replaced.set(key, next as unknown as T); updated++ }
  }

  let removedCount = 0
  const out: T[] = []
  for (const t of local) {
    const key = String(t.id)
    if (removed.has(key)) { removedCount++; continue }
    out.push(replaced.get(key) ?? t)
  }
  out.push(...appended)
  const changed = added > 0 || updated > 0 || removedCount > 0
  const kept = changed ? out : local
  const protectedIds = nextProtectedIds(kept, hubListed, removed, seen, held, adoptedAtMs, payload.full)
  return {
    tracks: kept, changed, added, updated, removed: removedCount,
    ignoredReason: tooMany ? `mass-removal-guard:${removedIdsRaw.length}` : undefined,
    protectedIds,
  }
}

function nextProtectedIds<T extends LocalTrackLike>(
  kept: T[],
  hubListed: Set<string>,
  removedApplied: Set<string>,
  seen: Set<string>,
  held: Set<string>,
  adoptedAtMs: number | null,
  full: boolean,
): string[] {
  const next = new Set<string>()
  if (full) {
    for (const t of kept) {
      const key = String(t.id)
      if (hubListed.has(key) || seen.has(key)) continue
      next.add(key)
    }
    return [...next].sort(cmpId)
  }
  const named = new Set(hubListed)
  for (const id of removedApplied) named.add(id)
  for (const id of held) {
    if (!named.has(id) && !seen.has(id)) next.add(id)
  }
  for (const t of kept) {
    const key = String(t.id)
    if (named.has(key) || seen.has(key)) continue
    if (holdReplicaLocal(t, seen, held, adoptedAtMs)) next.add(key)
  }
  return [...next].sort(cmpId)
}
