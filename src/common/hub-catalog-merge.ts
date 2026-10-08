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
//   - a song the hub knows is upserted: catalog fields come from the hub
//     (it is the laptop's publish + phone edits, i.e. the newest view),
//     playCount is the MAX of local and hub (plays are never lost here)
//   - a song only this machine knows is KEPT — a full snapshot is not a
//     list of deletions
//   - a song is removed ONLY when a delta names it in removedIds (the hub
//     positively saw it leave between two versions)
//   - an empty full snapshot is ignored (a torn or empty hub reply must
//     never blank a library)

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
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Local rows only need an id (+ optional playCount); `Track` qualifies without an index signature. */
export interface LocalTrackLike { id: number; playCount?: number }

export function mergeHubCatalog<T extends LocalTrackLike>(
  local: T[],
  payload: HubCatalogPayload,
): HubMergeResult<T> {
  const upserts = Array.isArray(payload.upserts) ? payload.upserts : []
  if (payload.full && upserts.length === 0) {
    return { tracks: local, changed: false, added: 0, updated: 0, removed: 0, ignoredReason: 'empty-full-snapshot' }
  }
  const removed = payload.full
    ? new Set<string>()
    : new Set((payload.removedIds ?? []).map((id) => String(id)))

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
  return { tracks: changed ? out : local, changed, added, updated, removed: removedCount }
}
