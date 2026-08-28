/**
 * Playlist tombstones (2026-08-28).
 *
 * Jake: "THERE are playlists i deleted on macbook that are still on my
 * workmini... updating everything means updating everything possible" and
 * "all syncs of all types need to be ironclad!!!"
 *
 * The workmini playlist harvest is add-only and gates on "does this ID
 * exist here" — which is a RESURRECTION MACHINE for anything deleted
 * locally that still exists remotely ("existence is not memory"). The fix
 * is a durable record of the deletion itself: when a save drops a playlist
 * ID, that ID is tombstoned, and every sync path refuses to bring a
 * tombstoned ID back. A playlist deliberately re-created or restored
 * clears its own tombstone — a live copy in a SAVE is the owner's word.
 *
 * Deletions are derived in the MAIN process by diffing consecutive saves,
 * so the renderer (LibraryContext is Do-Not-Touch) never changes.
 */
import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { join, dirname } from 'path'

export interface PlaylistTombstone {
  id: string
  name: string
  deletedAt: string
}

/** Callers pass their state dir — this module stays electron-free so the
 *  suite can load it under node --test. */
export const tombstonesPath = (stateDir: string): string => join(stateDir, 'playlist-tombstones.json')

/**
 * Guard rails for deriving deletions from a whole-array save. A renderer
 * bug that saves an EMPTY (or near-empty) array must not tombstone the
 * whole collection — Jake deletes playlists one at a time through a
 * confirm dialog, so a mass drop is a malfunction, not an instruction.
 */
export function derivePlaylistDeletions(
  prev: Array<{ id?: unknown; name?: unknown }>,
  next: Array<{ id?: unknown }>,
): { deletions: Array<{ id: string; name: string }>; guarded: string | null } {
  const nextIds = new Set(next.map((p) => String(p.id)))
  const dropped = prev
    .filter((p) => p.id != null && !nextIds.has(String(p.id)))
    .map((p) => ({ id: String(p.id), name: String(p.name ?? '') }))
  if (!dropped.length) return { deletions: [], guarded: null }
  if (next.length === 0 && prev.length > 1) {
    return { deletions: [], guarded: `empty save would tombstone all ${prev.length} playlists` }
  }
  if (dropped.length > 3 && dropped.length * 2 > prev.length) {
    return { deletions: [], guarded: `${dropped.length}/${prev.length} dropped in one save — not tombstoning a mass drop` }
  }
  return { deletions: dropped, guarded: null }
}

/** Tombstones minus any ID that is live again — the live copy wins. */
export function clearResurrected(
  tombstones: PlaylistTombstone[],
  live: Array<{ id?: unknown }>,
): PlaylistTombstone[] {
  const liveIds = new Set(live.map((p) => String(p.id)))
  return tombstones.filter((t) => !liveIds.has(t.id))
}

/** Drop every tombstoned ID from a playlist collection (identity-gated). */
export function applyTombstones<T extends { id?: unknown }>(
  playlists: T[],
  tombstones: PlaylistTombstone[],
): T[] {
  const dead = new Set(tombstones.map((t) => t.id))
  return playlists.filter((p) => !dead.has(String(p.id)))
}

/** Union two tombstone sets by ID (earliest deletedAt wins for stability). */
export function unionTombstones(
  a: PlaylistTombstone[],
  b: PlaylistTombstone[],
): PlaylistTombstone[] {
  const byId = new Map<string, PlaylistTombstone>()
  for (const t of [...a, ...b]) {
    const cur = byId.get(t.id)
    if (!cur || t.deletedAt < cur.deletedAt) byId.set(t.id, t)
  }
  return [...byId.values()]
}

export async function loadTombstones(file: string): Promise<PlaylistTombstone[]> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function saveTombstones(list: PlaylistTombstone[], file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(list, null, 2))
  await rename(tmp, file)
}

/**
 * The save-path hook: derive deletions from prev vs next, record them,
 * clear tombstones for anything resurrected. Fire-and-forget from the
 * IPC handler — a tombstone failure must never fail the save itself.
 */
export async function recordPlaylistSave(
  prev: Array<{ id?: unknown; name?: unknown }>,
  next: Array<{ id?: unknown }>,
  file: string,
  now: () => string = () => new Date().toISOString(),
): Promise<{ added: number; cleared: number; guarded: string | null }> {
  const { deletions, guarded } = derivePlaylistDeletions(prev, next)
  if (guarded) console.warn(`[playlist-tombstones] GUARDED: ${guarded}`)
  const existing = await loadTombstones(file)
  const afterClear = clearResurrected(existing, next)
  const cleared = existing.length - afterClear.length
  const known = new Set(afterClear.map((t) => t.id))
  const fresh = deletions
    .filter((d) => !known.has(d.id))
    .map((d) => ({ ...d, deletedAt: now() }))
  if (fresh.length || cleared) {
    await saveTombstones([...afterClear, ...fresh], file)
    if (fresh.length) console.log(`[playlist-tombstones] recorded ${fresh.length} deletion(s): ${fresh.map((f) => f.name || f.id).join(', ')}`)
  }
  return { added: fresh.length, cleared, guarded }
}
