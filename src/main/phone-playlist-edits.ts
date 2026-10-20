/**
 * Phone playlist edits → the desktop's playlists (2026-10-20).
 *
 * Jake, after the cross-device sync audit: "fix ALL of them". This is the
 * playlist item: XTC "Complicated Game" was removed from JUSTIFICATION V on
 * the phone on 9/12 and was still there on both Macs a month later, and a
 * song the phone had added came back on every launch after the Mac
 * deleted it.
 *
 * What was wrong:
 *   - V3 never read playlist-removals.json, so a phone removal never
 *     reached a Mac.
 *   - The renderer re-applied every phone ADD at every launch (App.tsx's
 *     startup merge), so a song deleted on the Mac came straight back.
 *   - Phone adds and new phone playlists were read only at launch.
 *   - V3 never read mobile-playlist-deletions.json either, so a playlist
 *     deleted on the phone stayed on the Macs.
 *
 * THE RULE: per playlist, per track, the NEWEST edit wins.
 *   - The phone's edits carry a time (epoch ms) per playlist + track. A v1
 *     entry (written before the format had times) counts as time 0: older
 *     than anything with a real time.
 *   - The desktop records, on each playlist, WHEN each track's membership
 *     last changed on a desktop (`memberChangedAt`, minted in
 *     playlist-hub-sync.ts stampModifiedPlaylists). No entry means no desktop
 *     has touched that track in that playlist since this shipped.
 *   - A phone edit applies only if the desktop has never touched that
 *     track there, or touched it EARLIER than the phone did. Applying it
 *     is itself a desktop change (stamped at apply time), so each phone
 *     edit lands once and is never re-applied over a later Mac edit.
 *   - Everything is matched by id (playlist id, track id). Never by name.
 *
 * Phone playlist deletions (mobile-playlist-deletions.json) drop the
 * playlist by id unless the desktop's copy was changed AFTER the phone
 * deleted it (the hub's "a newer live copy beats an older tombstone" rule).
 * Entries written before deletions carried a time always apply: they are
 * phone-made `mobile:` ids, which nothing re-creates.
 *
 * ⚠️ TWIN: JakeTunesMobile `backend/src/util/playlistEditRules.ts` reads
 * and writes the same two file formats (parseEditFile / editFileForWrite,
 * parseDeletionLedger) and resolves what the PHONE shows with the same
 * newest-wins rule. Change the format in one, change it in both.
 *
 * Pure and import-free so node --test loads it directly.
 */

/** One phone edit file: which tracks, per playlist, and when. */
export interface PlaylistEditSet {
  /** playlistId → trackIds, in the order the phone made the edits. */
  lists: Record<string, string[]>
  /** playlistId → trackId → epoch ms of the edit. Missing = v1 entry (time 0). */
  at: Record<string, Record<string, number>>
}

export type EditKind = 'additions' | 'removals'

/** The phone's playlist-delete ledger. `deletedAt` is missing for v1 entries. */
export interface PhoneDeletionLedger {
  deletedIds: string[]
  deletedAt: Record<string, number>
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x)

function cleanIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const x of raw) {
    const id = typeof x === 'number' && Number.isFinite(x) ? String(x) : typeof x === 'string' ? x.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function cleanTimes(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!isObj(raw)) return out
  for (const [k, v] of Object.entries(raw)) {
    if (k && typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v
  }
  return out
}

/**
 * Parse playlist-additions.json / playlist-removals.json in any shape that
 * has ever been written. Never throws.
 *
 *   v1: { "<playlistId>": ["<trackId>", ...] }
 *   v2: { "v": 2, "<kind>": { "<playlistId>": ["<trackId>", ...] },
 *         "at": { "<playlistId>": { "<trackId>": <epoch ms> } } }
 *
 * A file holding both (an older backend wrote v1 keys into a v2 file) reads
 * as the union; v2 times win.
 */
export function parseEditFile(raw: unknown, kind: EditKind): PlaylistEditSet {
  const lists: Record<string, string[]> = {}
  const at: Record<string, Record<string, number>> = {}
  if (!isObj(raw)) return { lists, at }
  const put = (pid: string, ids: string[]) => {
    if (!pid || ids.length === 0) return
    const cur = lists[pid] ?? []
    for (const id of ids) if (!cur.includes(id)) cur.push(id)
    lists[pid] = cur
  }
  // v1 keys: any top-level array value is a playlist's list.
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) put(k, cleanIdList(v))
  }
  // v2 body.
  const body = raw[kind]
  if (isObj(body)) {
    for (const [pid, v] of Object.entries(body)) put(pid, cleanIdList(v))
  }
  const times = raw['at']
  if (isObj(times)) {
    for (const [pid, m] of Object.entries(times)) {
      if (!lists[pid]) continue
      const clean = cleanTimes(m)
      const kept: Record<string, number> = {}
      for (const id of lists[pid]) if (clean[id] !== undefined) kept[id] = clean[id]
      if (Object.keys(kept).length > 0) at[pid] = kept
    }
  }
  return { lists, at }
}

/** The on-disk v2 shape. */
export function editFileForWrite(set: PlaylistEditSet, kind: EditKind): Record<string, unknown> {
  const lists: Record<string, string[]> = {}
  const at: Record<string, Record<string, number>> = {}
  for (const [pid, ids] of Object.entries(set.lists)) {
    if (ids.length === 0) continue
    lists[pid] = [...ids]
    const times = set.at[pid]
    if (times) {
      const kept: Record<string, number> = {}
      for (const id of ids) if (times[id] !== undefined) kept[id] = times[id]
      if (Object.keys(kept).length > 0) at[pid] = kept
    }
  }
  return { v: 2, [kind]: lists, at }
}

/** When the phone made this edit: undefined = no such edit, 0 = v1 (time unknown). */
export function editTime(set: PlaylistEditSet, playlistId: string, trackId: string): number | undefined {
  const list = set.lists[playlistId]
  if (!list || !list.includes(trackId)) return undefined
  return set.at[playlistId]?.[trackId] ?? 0
}

/** Parse mobile-playlist-deletions.json ({deletedIds, deletedAt?}). Never throws. */
export function parseDeletionLedger(raw: unknown): PhoneDeletionLedger {
  if (!isObj(raw)) return { deletedIds: [], deletedAt: {} }
  const deletedIds = cleanIdList(raw['deletedIds'])
  const times = cleanTimes(raw['deletedAt'])
  const deletedAt: Record<string, number> = {}
  for (const id of deletedIds) if (times[id] !== undefined) deletedAt[id] = times[id]
  return { deletedIds, deletedAt }
}

// ── Applying the phone's edits to the desktop's playlists ───────────────

export interface DesktopPlaylistLike {
  id?: unknown
  name?: unknown
  trackIds?: unknown
  modifiedAt?: unknown
  memberChangedAt?: unknown
  source?: unknown
  [k: string]: unknown
}

export interface PhoneMobilePlaylist {
  id?: unknown
  name?: unknown
  trackIds?: unknown
}

export interface PhonePlaylistInputs {
  additions: PlaylistEditSet
  removals: PlaylistEditSet
  /** mobile-playlists.json — playlists made on the phone. */
  mobilePlaylists: PhoneMobilePlaylist[]
  phoneDeletions: PhoneDeletionLedger
  /** Playlist ids a desktop deleted (playlist-tombstones.json). */
  desktopTombstoneIds: Set<string>
}

export interface PhoneApplyReport {
  added: Array<{ playlistId: string; trackId: string }>
  removed: Array<{ playlistId: string; trackId: string }>
  adopted: string[]
  deleted: string[]
}

/** When a desktop last changed this track's membership here (undefined = never). */
export function desktopMemberTime(p: DesktopPlaylistLike, trackId: string): number | undefined {
  const m = p.memberChangedAt
  if (!isObj(m)) return undefined
  const v = m[trackId]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** A phone edit made at `phoneAt` beats the desktop iff the desktop never touched it, or touched it earlier. */
export function phoneEditWins(phoneAt: number, desktopAt: number | undefined): boolean {
  return desktopAt === undefined || phoneAt > desktopAt
}

const msOf = (iso: unknown): number => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : 0
}

function numericIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  return raw.map(Number).filter((n) => Number.isFinite(n))
}

/**
 * Fold the phone's playlist edits into the desktop's playlist list. Returns
 * NEW objects only for playlists that changed; the caller stamps
 * modifiedAt / memberChangedAt (stampModifiedPlaylists) and persists.
 *
 * Order: phone deletions first (judged against the desktop copy as it was
 * BEFORE this pass, so this pass's own edits can't save a deleted
 * playlist), then new phone playlists, then per-track edits.
 */
export function applyPhonePlaylistEdits<T extends DesktopPlaylistLike>(
  playlists: T[],
  inputs: PhonePlaylistInputs,
): { playlists: T[]; changed: boolean; report: PhoneApplyReport } {
  const report: PhoneApplyReport = { added: [], removed: [], adopted: [], deleted: [] }
  const phoneDeleted = new Set(inputs.phoneDeletions.deletedIds)

  // 1. Playlists deleted on the phone.
  const kept: T[] = []
  for (const p of playlists) {
    const id = String(p.id ?? '')
    if (id && phoneDeleted.has(id)) {
      const deletedAt = inputs.phoneDeletions.deletedAt[id]
      const desktopNewer = deletedAt !== undefined && msOf(p.modifiedAt) > deletedAt
      if (!desktopNewer) {
        report.deleted.push(id)
        continue
      }
    }
    kept.push(p)
  }

  // 2. Playlists made on the phone that this desktop doesn't have yet.
  const have = new Set(kept.map((p) => String(p.id ?? '')))
  const out: T[] = [...kept]
  for (const mp of inputs.mobilePlaylists) {
    const id = typeof mp?.id === 'string' ? mp.id : ''
    if (!id || have.has(id) || inputs.desktopTombstoneIds.has(id) || phoneDeleted.has(id)) continue
    have.add(id)
    out.push({
      id,
      name: typeof mp.name === 'string' && mp.name.trim() ? mp.name : 'Untitled playlist',
      trackIds: numericIds(mp.trackIds),
      source: 'mobile',
    } as unknown as T)
    report.adopted.push(id)
  }

  // 3. Per-track adds and removes — newest wins, per track.
  for (let i = 0; i < out.length; i++) {
    const p = out[i]
    const pid = String(p.id ?? '')
    const adds = inputs.additions.lists[pid] ?? []
    const removes = inputs.removals.lists[pid] ?? []
    if (adds.length === 0 && removes.length === 0) continue
    let ids = numericIds(p.trackIds)
    const members = new Set(ids.map(String))
    let touched = false
    for (const tid of adds) {
      const addAt = editTime(inputs.additions, pid, tid) ?? 0
      const removeAt = editTime(inputs.removals, pid, tid)
      if (removeAt !== undefined && removeAt > addAt) continue   // the phone's latest word is "remove"
      if (members.has(tid) || !phoneEditWins(addAt, desktopMemberTime(p, tid))) continue
      const n = Number(tid)
      if (!Number.isFinite(n)) continue
      ids = [...ids, n]
      members.add(tid)
      report.added.push({ playlistId: pid, trackId: tid })
      touched = true
    }
    for (const tid of removes) {
      const removeAt = editTime(inputs.removals, pid, tid) ?? 0
      const addAt = editTime(inputs.additions, pid, tid)
      if (addAt !== undefined && addAt >= removeAt) continue     // the phone's latest word is "add"
      if (!members.has(tid) || !phoneEditWins(removeAt, desktopMemberTime(p, tid))) continue
      ids = ids.filter((n) => String(n) !== tid)
      members.delete(tid)
      report.removed.push({ playlistId: pid, trackId: tid })
      touched = true
    }
    if (touched) out[i] = { ...p, trackIds: ids }
  }

  const changed = report.added.length + report.removed.length + report.adopted.length + report.deleted.length > 0
  return { playlists: changed ? out : playlists, changed, report }
}
