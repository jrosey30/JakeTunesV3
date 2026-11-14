/**
 * The records of what an iPod's playlists are (2026-11-13), kept in that iPod's
 * own state folder (the root state dir for the Original, ipod-pools/<id>/ for
 * any other), beside its pool, manifest and seal:
 *
 *   ipod-playlists-planned.json    what a sync is ABOUT to write, left when the
 *                                  set is put together, before the card is touched
 *   ipod-playlists-last-sync.json  what the last sync that FINISHED wrote: the
 *                                  planned file, moved here only after that sync
 *                                  verified and sealed (promotePlannedPlaylists)
 *
 * Each says every playlist with its songs, and which library playlists were
 * handed in and left off. The last-sync file is what a later sync reuses when
 * homemini can't be asked (unknown is not empty), so it must only ever describe
 * what is really on the iPod: a refused, failed or cancelled sync leaves it alone.
 *
 * There is no switch any more (2026-11-14). PR 412 kept the library's playlists
 * on an iPod until Jake said yes for that iPod (ipod-playlists-rule.json, written
 * by hand). He said yes for every iPod, so the rule in
 * common/ipod-device-playlists.ts holds for all of them and that file is never
 * read: one left on a disk changes nothing.
 */
import { readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { DevicePlaylist } from '../common/ipod-device-playlists.ts'

export const LAST_SYNC_PLAYLISTS_FILE = 'ipod-playlists-last-sync.json'
export const PLANNED_PLAYLISTS_FILE = 'ipod-playlists-planned.json'

export interface LastSyncPlaylists {
  version: 1
  at: string
  ipod: string
  playlists: DevicePlaylist[]
  /** Library playlists handed in and not written. */
  removed: string[]
  /** Plain lines about anything that couldn't be asked and what was used instead. */
  notes: string[]
}

export async function readLastSyncPlaylists(stateDir: string): Promise<LastSyncPlaylists | null> {
  try {
    const doc = JSON.parse(await readFile(join(stateDir, LAST_SYNC_PLAYLISTS_FILE), 'utf-8')) as LastSyncPlaylists | null
    return doc && doc.version === 1 && Array.isArray(doc.playlists) ? doc : null
  } catch {
    return null
  }
}

/** What a sync is about to write. Never read back as "what is on the iPod". */
export async function writePlannedPlaylists(stateDir: string, doc: LastSyncPlaylists): Promise<void> {
  const path = join(stateDir, PLANNED_PLAYLISTS_FILE)
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, JSON.stringify(doc, null, 1), 'utf-8')
  await rename(tmp, path)
}

/**
 * The sync that planned these playlists finished (verified, sealed): its plan is
 * now what the iPod holds. Returns false when there was no plan to promote.
 */
export async function promotePlannedPlaylists(stateDir: string): Promise<boolean> {
  try {
    await rename(join(stateDir, PLANNED_PLAYLISTS_FILE), join(stateDir, LAST_SYNC_PLAYLISTS_FILE))
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[ipod-playlists] could not record what this sync wrote: ${(err as Error).message}`)
    return false
  }
}

/** The line a sync logs before it touches the card: what is written, and which library playlists are left off. */
export function describePlaylistPlan(ipod: string, r: Pick<LastSyncPlaylists, 'playlists' | 'removed' | 'notes'>): string {
  const lines = [
    `${ipod} gets ${r.playlists.length} playlist(s): ${r.playlists.map((p) => `${p.name} (${p.trackIds.length})`).join(', ') || 'none'}.`,
    `Library playlists left off (only this iPod's own are written): ${r.removed.length ? r.removed.join(', ') : 'none'}.`,
    ...r.notes,
  ]
  return lines.join(' ')
}
