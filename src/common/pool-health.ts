/**
 * iPod Pool health — which pooled ids will actually reach the iPod, and
 * why the rest won't. Pure, so node --test loads it.
 *
 * 2026-09-19. Jake put 1,000 songs in the pool; the sidebar said 1,000,
 * the sync sheet said 992. Seven ids had left the library (songs removed
 * and re-added under new ids — the mobile downloads he re-added 9/9) and
 * one was a concert cue, which never syncs. Three surfaces, three counts,
 * and nothing named the missing songs or offered the new copies. Every
 * surface now counts through THIS function, and the pool page lists what
 * can't sync by name with the fix beside it.
 *
 * ⚠️ TWIN: src/main/workout-sync-ipc.ts `syncable` + the concert-owned
 * drop are the sync-side rules. This must reach the same count they do.
 */
import { foldAccents } from './fold-text.ts'

export interface PoolLibraryTrack {
  id: number
  title?: string
  artist?: string
  audioMissing?: boolean
  path?: string
}

export interface PoolName { t: string; a: string }

export interface DeadPoolEntry {
  id: number
  /** "Artist — Title" from the pool's own record of what was dropped;
   *  "Song #<id>" when the pool predates names. */
  label: string
  /** A library track with the same artist + title, not already pooled:
   *  the re-added copy. */
  replacement?: number
}

export interface PoolHealth {
  /** Ids the sync will actually board, in pool order. */
  syncable: number[]
  /** Pooled ids that are no longer in the library. */
  dead: DeadPoolEntry[]
  /** Pooled ids that belong to a Full Live Concert — never syncable. */
  concert: number[]
  /** In the library but unsyncable for another reason (blank title/artist,
   *  audio missing, no path) — the sync would drop these too. */
  unsyncable: number[]
}

/** The sync-side "syncable" rule, verbatim. */
export function isSyncableTrack(t: PoolLibraryTrack): boolean {
  return String(t.title || '').trim() !== '' && String(t.artist || '').trim() !== ''
    && t.audioMissing !== true && (t.path === undefined || String(t.path).trim() !== '')
}

/** Artist + title folded to a comparison key: accents dropped, case
 *  dropped, punctuation and spacing collapsed. Enough to find the same
 *  song re-added under a new id; not a fingerprint, never used to delete. */
export function songKey(artist: string | undefined, title: string | undefined): string {
  const f = (s: string | undefined): string => foldAccents(s || '').replace(/[^a-z0-9]+/g, ' ').trim()
  return `${f(artist)}|||${f(title)}`
}

export function poolHealth(
  ids: number[],
  names: Record<string, PoolName> | undefined,
  byId: Map<number, PoolLibraryTrack>,
  concertOwned: Set<number>,
): PoolHealth {
  const pooled = new Set(ids)
  const syncable: number[] = []
  const dead: DeadPoolEntry[] = []
  const concert: number[] = []
  const unsyncable: number[] = []
  let keyIndex: Map<string, number[]> | null = null
  const lookup = (key: string): number | undefined => {
    if (!keyIndex) {
      keyIndex = new Map()
      for (const t of byId.values()) {
        if (!isSyncableTrack(t) || concertOwned.has(t.id)) continue
        const k = songKey(t.artist, t.title)
        const list = keyIndex.get(k)
        if (list) list.push(t.id); else keyIndex.set(k, [t.id])
      }
    }
    return (keyIndex.get(key) || []).find((id) => !pooled.has(id))
  }
  for (const id of ids) {
    const t = byId.get(id)
    if (!t) {
      const n = names?.[String(id)]
      const label = n && (n.a || n.t) ? `${n.a || '?'} — ${n.t || '?'}` : `Song #${id}`
      const replacement = n && n.a && n.t ? lookup(songKey(n.a, n.t)) : undefined
      dead.push(replacement !== undefined ? { id, label, replacement } : { id, label })
      continue
    }
    if (concertOwned.has(id)) { concert.push(id); continue }
    if (!isSyncableTrack(t)) { unsyncable.push(id); continue }
    syncable.push(id)
  }
  return { syncable, dead, concert, unsyncable }
}

/** Swap one pooled id for another, in place, keeping order. No-op when
 *  the old id is absent or the new one is already pooled. */
export function swapInPool(ids: number[], oldId: number, newId: number): number[] {
  if (ids.includes(newId)) return ids
  const i = ids.indexOf(oldId)
  if (i < 0) return ids
  const out = [...ids]
  out[i] = newId
  return out
}
