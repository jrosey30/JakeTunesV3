/**
 * The per-iPod switch for "only this iPod's own playlists" (2026-11-13).
 *
 * Jake's rule ("the only playlists each ipod gets are the default and its
 * specific ipod assigned playlists") takes the library's general playlists
 * OFF an iPod: 38 on the Original and 21 on punkPod the day it was written.
 * That is a visible change to iPods he already uses, so it happens one iPod at
 * a time, only after he has seen that iPod's list and said yes.
 *
 * The switch is a file in that iPod's own state folder (the root state dir for
 * the Original, ipod-pools/<id>/ for any other), beside its pool, manifest and
 * seal:
 *
 *   ipod-playlists-rule.json   { "onlyOwnPlaylists": true, "approvedAt": "<date>", "note": "Jake, in chat" }
 *
 * OFF is everything else: no file, a file that can't be read, any other value.
 * NOTHING IN THE APP WRITES THIS FILE (a test reads the source to keep it that
 * way). It is written by hand, or by Claude, on Jake's word, for one iPod.
 *
 * Two records live in the same folder:
 *
 *   ipod-playlists-planned.json    what a sync is ABOUT to write, left when the
 *                                  set is put together, before the card is touched
 *   ipod-playlists-last-sync.json  what the last sync that FINISHED wrote: the
 *                                  planned file, moved here only after that sync
 *                                  verified and sealed (promotePlannedPlaylists)
 *
 * Each says every playlist with its songs, which are new, and which library
 * playlists were left off (switch on) or would be (switch off). The planned
 * file is how Jake sees the list before saying yes. The last-sync file is what
 * a later sync reuses when homemini can't be asked (unknown is not empty), so
 * it must only ever describe what is really on the iPod: a refused, failed or
 * cancelled sync leaves it alone.
 */
import { readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { DevicePlaylist } from '../common/ipod-device-playlists.ts'

export const PLAYLIST_RULE_FILE = 'ipod-playlists-rule.json'
export const LAST_SYNC_PLAYLISTS_FILE = 'ipod-playlists-last-sync.json'
export const PLANNED_PLAYLISTS_FILE = 'ipod-playlists-planned.json'

/** Is "only its own playlists" switched on for the iPod whose state lives here? Any doubt = off. */
export async function onlyOwnPlaylists(stateDir: string): Promise<boolean> {
  try {
    const doc = JSON.parse(await readFile(join(stateDir, PLAYLIST_RULE_FILE), 'utf-8')) as { onlyOwnPlaylists?: unknown } | null
    return !!doc && doc.onlyOwnPlaylists === true
  } catch {
    return false
  }
}

export interface LastSyncPlaylists {
  version: 1
  at: string
  ipod: string
  /** The switch as this sync found it. */
  onlyOwnPlaylists: boolean
  playlists: DevicePlaylist[]
  added: string[]
  removed: string[]
  wouldRemove: string[]
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

/** The line a sync logs before it touches the card: what is written, what is new, what is (or would be) left off. */
export function describePlaylistPlan(ipod: string, r: Pick<LastSyncPlaylists, 'onlyOwnPlaylists' | 'playlists' | 'added' | 'removed' | 'wouldRemove' | 'notes'>): string {
  const list = (names: string[]): string => (names.length ? names.join(', ') : 'none')
  const lines = [
    `${ipod} gets ${r.playlists.length} playlist(s): ${r.playlists.map((p) => `${p.name} (${p.trackIds.length})`).join(', ') || 'none'}.`,
    `New on this iPod's rule: ${list(r.added)}.`,
    r.onlyOwnPlaylists
      ? `Only-its-own-playlists is ON for this iPod. Left off: ${list(r.removed)}.`
      : `Only-its-own-playlists is OFF for this iPod, so the library's playlists are still written. Switching it on would leave off: ${list(r.wouldRemove)}.`,
    ...r.notes,
  ]
  return lines.join(' ')
}
