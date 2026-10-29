/**
 * No robot writes hub-owned fields on a replica (2026-10-29, the sibling of
 * genre-replica.ts — Jake: "must work across the board").
 *
 * A replica (workmini) takes every field the hub catalog carries — genre,
 * albumArtist, album, title, year, track/disc numbers and counts, subgenre,
 * origin, ... (HUB_CARRIED_FIELDS) — from the hub. A background robot that
 * writes one of those into the replica's own overrides file is a second,
 * competing writer: the write never reaches the MacBook or the phone (it is
 * not journaled), the overlay drops it at the next launch, and until then
 * the replica's window disagrees with every other device. Measured 10/29:
 * workmini's Cynthia sweep had auto-applied 284 albumArtist, 227 discCount,
 * 145 trackCount, 25 album, 6 genre and 1 title on its own.
 *
 * The rule: on a replica — or when this Mac cannot tell what it is — a robot
 * may auto-write only fields the hub does NOT carry. Anything else becomes a
 * finding for Jake: when he applies it, it goes through Get Info's own path
 * (save-metadata-override → journal → the hub absorbs and republishes it),
 * so it reaches every device. On the hub nothing changes.
 *
 * Electron-free (tests: __tests__/genre-replica.test.ts).
 */
import { HUB_CARRIED_FIELDS } from './user-edits-sync.ts'
import { filerRole } from './genre-replica.ts'

/** Pure: may a robot auto-write `field` on a Mac in this role? */
export function robotMayWrite(role: 'hub' | 'replica', field: string): boolean {
  return role === 'hub' || !HUB_CARRIED_FIELDS.has(field)
}

/** The hook a background sweep asks before an auto-apply. An unreadable role
 *  reads as replica (filerRole): no hub-owned write when unsure. */
export function autoWriteGate(isReplica?: () => Promise<boolean>): (field: string) => Promise<boolean> {
  return async (field) => robotMayWrite(await filerRole(isReplica), field)
}
