/**
 * The main-process side of "Jake's edits stay" (common/jake-edits-stay.ts):
 * his records of hand, read for an automatic writer.
 *
 *   - his journal (user-edits.json in userData), read strictly: a missing
 *     file is "no edits yet", but a file that can't be read or parsed holds
 *     every automatic write back (never guess that a field isn't his);
 *   - the phone's Get Info edits, the copy the desktop already reads
 *     (mobile-metadata-overrides.json, fingerprint-matched per song).
 *
 * Read once per sweep: a lookup is reused for TTL_MS, so a pass over hundreds
 * of songs reads the files once.
 *
 * Users: Cynthia's sweep (createHeldForJake → cynthia-sweep.ts heldForJake)
 * and the genre filer (genre-filer-persist.ts).
 */
import type { UserEditsDoc } from '../common/user-edits.ts'
import { readUserEditsJournalStrict } from './user-edits-sync.ts'
import { mayWriteField, phoneEdit, sameLength, type JournalEdit } from '../common/jake-edits-stay.ts'

export const TTL_MS = 30_000

type PhoneDoc = Record<string, { fp?: string; fields?: Record<string, string> } | undefined>

/** His records for one song + field (journal first, then the phone's). */
export type JakeEditLookup = (id: number, field: string, fp: string | undefined) => JournalEdit[]

/** The journal, strictly: missing → null; unreadable or not a journal → throws (user-edits-sync.ts). */
export const readJournalStrict = readUserEditsJournalStrict

export function lookupFrom(journal: UserEditsDoc | null, phone: PhoneDoc | null): JakeEditLookup {
  return (id, field, fp) => {
    const out: JournalEdit[] = []
    const j = journal?.edits[String(id)]?.[field]
    if (j) out.push({ v: j.v, at: j.at, dur: j.dur })
    const p = phoneEdit(phone, id, field, fp)
    if (p) out.push(p)
    return out
  }
}

/** One lookup per sweep: built on first ask, reused for TTL_MS. A journal that can't be read is never cached: it throws every time. */
export function createJakeEdits(o: { readJournal: () => Promise<UserEditsDoc | null>; readPhone: () => Promise<PhoneDoc | null>; now?: () => number; ttlMs?: number }) {
  const now = o.now ?? Date.now
  let cached: { at: number; look: JakeEditLookup } | null = null
  return {
    lookup: async (): Promise<JakeEditLookup> => {
      if (cached && now() - cached.at < (o.ttlMs ?? TTL_MS)) return cached.look
      const journal = await o.readJournal()   // throws on a corrupt journal: the caller holds everything
      const phone = await o.readPhone().catch(() => null)
      cached = { at: now(), look: lookupFrom(journal, phone) }
      return cached.look
    },
  }
}

/** For Cynthia's sweep: true when an automatic write of `value` would change something Jake set. */
export function createHeldForJake(edits: { lookup: () => Promise<JakeEditLookup> }, warn: (m: string) => void = (m) => console.warn(m)) {
  return async (trackId: number, field: string, value: string, durationMs?: number, fp?: string): Promise<boolean> => {
    let look: JakeEditLookup
    try { look = await edits.lookup() } catch (err) {
      warn(`[jake-edits] his edits can't be read; automatic fixes wait: ${err instanceof Error ? err.message : String(err)}`)
      return true
    }
    return !mayWriteField({ writer: { by: 'auto' }, edit: look(trackId, field, fp), value, durationMs })
  }
}

/**
 * The titles and artists Jake set for one id (journal + phone), for the override
 * merge's evidence (override-merge.ts isAnotherSong). His records unreadable →
 * no evidence: a changed fingerprint then starts the entry fresh, as it always did.
 */
export function createJakeNames(edits: { lookup: () => Promise<JakeEditLookup> }) {
  /** `fingerprint`: the song the id names now; his records (journal or phone) for a song of another length don't count. */
  return async (trackId: number | string, fingerprint?: string): Promise<{ title: string[]; artist: string[] }> => {
    let look: JakeEditLookup
    try { look = await edits.lookup() } catch { return { title: [], artist: [] } }
    const id = Number(trackId)
    const dur = fingerprint ? Number(fingerprint.slice(fingerprint.lastIndexOf('|') + 1)) || undefined : undefined
    // By id + length, never by the phone's fingerprint: the phone's entry carries
    // the song as it was BEFORE his edit (homemini util/mobileMetadata.ts), so a
    // title he fixed there never matches the new fingerprint (review of #505).
    const names = (field: string): string[] => look(id, field, undefined).filter((e) => sameLength(e.dur, dur)).map((e) => e.v)
    return { title: names('title'), artist: names('artist') }
  }
}
